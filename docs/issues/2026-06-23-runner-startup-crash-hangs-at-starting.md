---
date: 2026-06-23
status: fixed
area: src/runners, src/core/recovery, src/hosts/two-pane
type: bug
recommendation: strong
dependency-category: in-process
---

# A runner that dies at startup hangs the step at "starting…" with no error surfaced

> **Resolution (TDD, MVP scope — steps 1-3).** Both bugs are fixed at the shared
> seam:
> - **Bug A (reporting).** `runRunner` now retains a bounded stderr tail
>   (`RunnerResult.stderr`, capped at 8 KB, most-recent-wins) and folds it into
>   the synthesized no-terminal-event error message, so the real reason reaches
>   the `StepError` (`terminalErrorMessage`).
> - **Bug B (classification).** A new fail-fast `launch` `ErrorCategory` plus a
>   shared `isLaunchFailureSignal` predicate (no stdout info events + non-zero
>   exit + non-empty stderr) is consulted at the `unknown` fallthrough of both
>   `classifyCodexError` and `classifyClaudeError`. A startup crash now fails
>   fast instead of entering the 5-minute silent backoff. `stderr` is threaded
>   through `ClassifyErrorSignal` → `AttemptRunResult`/`toSignal` → `runOneAttempt`.
>
> **Deferred** (not in this change): step 4 (the optional `retrying (attempt N)
> in <delay>…` recovery banner) and the two-pane `screen`/`full-host` test that
> asserts the pane shows the failure text rather than a frozen `starting…`. The
> classification fix means the step now fails immediately with the stderr in the
> `StepError` message; rendering that message in the pane is existing behavior.

## TL;DR

When an agent CLI exits non-zero **before emitting any stdout JSON** (e.g. a bad
config file, missing binary, auth failure on first byte), orch:

1. **throws the captured stderr away** and synthesizes a generic, content-free
   terminal error, then
2. **misclassifies** the failure as `unknown`/`transient`, so the recovery loop
   enters a **5-minute silent backoff** (`DEFAULT_WAIT_MS`) before a retry that
   is guaranteed to fail the same way, and
3. shows **nothing** in the right pane the whole time — it stays on the
   `[<step>] starting…` placeholder.

From the user's seat this is indistinguishable from a permanent hang. There are
two distinct defects (a **reporting** gap and a **classification** gap) that
share one seam: stderr is never threaded from the subprocess into the
error/classify path.

## How it was found (reproduction + evidence)

Real run: `bunx orch run autobuild …` in a downstream KMP repo. The `review-plan`
step uses the **codex** runner; the repo had an invalid
`.codex/rules/default.rules` (`decision="deny"` — codex only accepts
`allow` / `prompt` / `forbidden`). Codex aborted at startup.

From `.orch/state/<runId>/logs/` of the stuck run:

- `logs/agents/review-plan/raw_stderr.log`:
  ```
  Error loading rules:
  …/.codex/rules/default.rules:5: error: invalid decision: deny (problem is on or around line 5)
  ```
- `logs/agents/review-plan/formatted_output.txt`: just `[review-plan] starting…`
- `logs/spawns.ndjson` (review-plan): `exitCode: 1, durationMs: 201` — the
  process exited in 201 ms.
- `logs/lifecycle.ndjson`: a `step:start` for `review-plan`, then **no
  `step:complete`** — only a manual `quit` intent **5 min 6 s later**
  (`step:start` ts `…930464` → `quit` ts `…1236691` ≈ 306 s), then teardown.

306 s ≈ the 201 ms failed attempt + the 5-minute `DEFAULT_WAIT_MS` backoff. The
user quit during the silent backoff, right before the doomed retry. Confirmed
deterministic — it reproduced on every run with the bad config.

To reproduce synthetically: make any runner exit non-zero immediately with output
on **stderr only** (e.g. point codex at a malformed `.codex/rules` file, or stub
a fake runner whose process writes to stderr and exits 1 before any stdout line),
run it as an autonomous step, and watch the pane sit at `starting…`.

## Root-cause walkthrough (with file:line)

1. **stderr is drained but discarded.**
   `src/runners/execute.ts:93` drains `handle.stderr` purely to avoid pipe
   deadlock (and to feed the `--debug` `onRawLine` hook). The drained text is
   **not retained**. When the stdout loop ends with no terminal event,
   `src/runners/execute.ts:129-135` synthesizes:
   ```ts
   finalEvent = { kind: 'terminal', type: 'error',
                  message: `runner "${runner.name}" produced no terminal event` }
   ```
   `RunnerResult` (`src/runners/execute.ts:30-34`) has **no `stderr` field**, so
   the real reason (`Error loading rules: …`) is lost here.

2. **The classify signal can't see stderr.**
   `ClassifyErrorSignal` (`src/runners/types.ts:281-285`) carries only
   `finalEvent`, `exitCode`, `infoEvents` — all stdout-derived. It is built by
   `toSignal` (`src/core/recovery/loop.ts:213-219`) from the `AttemptOutcome`,
   which in turn comes from `runOneAttempt`
   (`src/core/workflow.ts:1465-1522`) — none of which carry stderr.

3. **Codex classifier defaults to transient.**
   `classifyCodexError` (`src/runners/codex/classify-error.ts`) `collectErrorText`
   (lines 33-53) only reads the terminal message + info events (stdout). With the
   synthesized "produced no terminal event" message there are no keywords and no
   HTTP status, so it falls through to
   `src/runners/codex/classify-error.ts:105`:
   ```ts
   return { category: 'unknown', transient: true }
   ```
   (The Claude runner has the analogous `src/runners/claude/classify-error.ts`;
   verify it has the same blind spot and fix symmetrically.)

4. **Transient ⇒ 5-minute silent backoff.**
   `runAgentWithRecovery` (`src/core/workflow.ts:1537-1569`) sees a terminal error
   with non-zero exit, resolves the `backoffResume` strategy, and enters
   `runRecoveryLoop`. There the verdict for a transient error is `retry`, and the
   loop runs `await clock.sleep(verdict.delayMs)` at
   `src/core/recovery/loop.ts:166`. `delayMs` defaults to `DEFAULT_WAIT_MS = 5 * 60 * 1000`
   (`src/core/recovery/strategy.ts:26`). Retrying a deterministic config error
   just burns the recovery envelope (ceiling / `DEFAULT_WALL_CLOCK_CAP_MS`).

5. **The pane never updates during backoff.**
   The right pane tails the step's `formatted_output`. At `step:start` the
   choreographer writes the `[<step>] starting…` marker
   (`src/hosts/two-pane/lifecycle-choreographer.ts:126`,
   `src/hosts/two-pane/prompt-preamble.ts:101`). Because the runner emitted no
   events and the backoff is silent, nothing else is ever written — so the pane is
   frozen on `starting…`.

## The two bugs

### Bug A — failure is never surfaced (reporting)

Even setting recovery aside, a runner that dies at startup should immediately show
**why**. The stderr tail (`Error loading rules: …default.rules:5 invalid decision:
"deny"`) is captured to `raw_stderr.log` but never reaches the synthesized error
message, the `StepError` (`terminalErrorMessage`, `src/core/workflow.ts:1666-1670`,
which only returns the message or `runner exited N`), or the pane.

### Bug B — a startup crash is misclassified as transient (correctness)

A process that exits non-zero in ~200 ms having emitted **zero stdout events** is
structurally a launch/config failure, not a retryable API hiccup. Treating it as
`transient` triggers a pointless multi-minute retry cycle. It should fail fast.

## Suggested fix (one shared seam)

Thread the captured stderr (a bounded tail — last N KB/lines) from the subprocess
through to the error message and the classify signal:

1. **Retain stderr in `runRunner`.** Capture the drained stderr lines into a
   bounded buffer (cap it — a runaway stderr must not blow memory) and add
   `readonly stderr: string` to `RunnerResult` (`src/runners/execute.ts:30`). On
   the no-terminal-event path (`:129`), fold the stderr tail into the synthesized
   error `message` so it's legible everywhere downstream.
2. **Add `stderr` to `ClassifyErrorSignal`** (`src/runners/types.ts:281`) and
   plumb it through `AttemptOutcome`/`AttemptRunResult` + `toSignal`
   (`src/core/recovery/loop.ts:55-72, 213-219`) and `runOneAttempt`
   (`src/core/workflow.ts:1516-1521`).
3. **Classify startup crashes as non-transient.** In
   `classifyCodexError` (and the Claude equivalent): when the attempt produced no
   stdout terminal/info events **and** exited non-zero quickly, or stderr matches
   launch-failure phrasings (e.g. `error loading rules`, `command not found`,
   `no such file`), return `{ category: '<launch/config>', transient: false }`.
   A non-transient verdict makes `runRecoveryLoop` return `kind: 'fail'`
   immediately (`src/core/recovery/loop.ts:141-151`) → the step fails at once with
   the stderr in the message, no backoff. Decide whether to fold the stderr text
   into `collectErrorText` for keyword matching, or gate purely on the
   no-output + fast-exit shape (the latter is more robust to wording).
4. **(Optional, nice-to-have) Make recovery visible.** When the loop does retry,
   render a pane line / banner (`retrying (attempt N) in <delay>…`) so a legitimate
   transient backoff isn't itself an invisible freeze. See the choreographer's
   banner path (`src/hosts/two-pane/lifecycle-choreographer.ts`).

Minimal viable fix = steps 1-3 (kills both bugs). Step 4 hardens the broader UX.

## Tests to add (per CLAUDE.md testing rules)

- **Unit (`src/runners`)** — `runRunner` with a `FakeProcessService` whose process
  writes lines to stderr and exits non-zero with **no** stdout: assert the returned
  `RunnerResult.stderr` is populated and the synthesized `finalEvent.message`
  contains the stderr tail. (Edge seam = ProcessService; no `mock.module`.)
- **Unit (`src/runners/codex` + `src/runners/claude`)** — `classifyError` on a
  no-stdout, fast non-zero exit (and on an `error loading rules` stderr) returns
  `transient: false`.
- **Unit (`src/core/recovery`)** — `runRecoveryLoop` with a non-transient initial
  classification returns `{ ok: false, failure: { kind: 'fail' } }` **without**
  calling `clock.sleep` (assert no backoff on a fast-fail).
- **Two-pane (`screen` or `full-host`)** — drive a step whose runner exits
  non-zero at startup; assert the right pane shows the failure text, **not** a
  permanent `starting…`. Use the `scriptedFake`/fake-agent harness (see
  `docs/testing-strategy.md`); a scripted fake that exits 1 with stderr before any
  stdout is the natural fixture. Triage rule applies: the test must fail if the
  pane stays empty/`starting…`.

Gate everything behind `bun run check` (CLAUDE.md rule #10).

## Non-negotiable rules in play

- Mock only at the edge: fake the **ProcessService** port to inject the
  exit-with-stderr behavior; do not `mock.module` internal runner/core files
  (banned for `src/core`, `src/runners`, …).
- Subprocess access stays inside `src/services/process/`.
- `ClassifyErrorSignal` lives in `src/runners/types.ts` (core-visible types) — keep
  the new `stderr` field there so `src/core` doesn't import a runner.

## Related

- `docs/logging.md` — `.orch/state/<runId>/logs/` layout used to diagnose this
  (`spawns.ndjson`, `lifecycle.ndjson`, `agents/<step>/raw_stderr.log`).
- `docs/issues/2026-05-26-arch-capturelock-misplaced-in-codex-runner.md` — same
  area (codex runner / core recovery seam).
- Downstream trigger (not an orch bug, but the surfacing case): codex
  `.codex/rules/*.rules` only accepts `decision` values `allow` / `prompt` /
  `forbidden`; `deny` aborts codex at startup.
