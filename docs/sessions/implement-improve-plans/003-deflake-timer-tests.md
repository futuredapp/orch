# Plan 003 — Replace fixed-sleep-then-assert test patterns with polling

**Step ID**: 003-deflake-timer-tests
**Status**: DONE (with one environmental note on the real-tmux gate — see below)

## What was done

Two in-scope files changed; nothing else touched (production generator
`src/cli/commands/tail-lines.ts` and the real-tmux harness left untouched, per
scope).

### File 1 — `tests/unit/cli/tail-lines.test.ts` (Step 1)

Replaced the timer-gated abort pattern with poll-until-observed:

- `collect` → `collectInto(signal, file, out)`: pushes into a caller-supplied
  array so progress is observable mid-flight.
- Added a file-local `waitUntil(cond, timeoutMs = 5000)` poll helper (10 ms
  interval, throws on deadline). Deliberately NOT promoted to `tests/_support/`
  (only one consumer — per the plan's maintenance note).
- Test 1 ("yields one line for each newline-terminated chunk…"): appends
  `one\ntwo\n`, `await waitUntil(() => out.length >= 2)`, appends `three\n`,
  `await waitUntil(() => out.length >= 3)`, then aborts and asserts
  `['one','two','three']`.
- Test 2 ("holds a partial line across ticks…"): appends `half-`, keeps a
  single 250 ms **best-effort pacing** sleep (now carrying a comment that the
  test passes either way and `waitUntil` — not the sleep — is the correctness
  sync), appends `and-half\n`, `await waitUntil(() => out.includes('half-and-half'))`,
  aborts, asserts `['half-and-half']`.
- Test 3 ("flushes a non-empty pending partial when abort fires before the
  trailing newline"): now seeds the file with `sentinel\nfinal fragment` so the
  read loop has an observable signal; `await waitUntil(() => out.includes('sentinel'))`
  proves the loop consumed the file through the fragment, then aborts and
  asserts `['sentinel','final fragment']`. The test name still accurately
  describes the abort-flush of a pending partial.

All three keep full-sentence names and AAA with blank-line separators.

### File 2 — `tests/integration/real-tmux/steps-view-header-no-duplicate.test.ts` (Step 2)

- Replaced the `await sleep(400)` mount wait with a first-frame poll:
  `await harness.left.waitFor((pane) => pane.includes('orch · tic-tac-toe · '), { timeoutMs: REAL_TMUX_ASSERT_TIMEOUT_MS })`.
- Added a clarifying comment above the `sleep(120)` inside `drag()` noting it
  is SIGWINCH pacing (not assertion sync) and is intentionally a plain sleep —
  left as-is per scope.

## Drift check

`git diff --stat 832a56d..HEAD -- tests/unit/cli/tail-lines.test.ts tests/integration/real-tmux/steps-view-header-no-duplicate.test.ts src/cli/commands/tail-lines.ts`
→ **empty output** (no in-scope file changed since the plan was written). The
`Current state` excerpts all matched live code: `collect` closure at
tail-lines:22-28; the 250 ms-sleep-then-abort pattern; the `sleep(400)` mount
wait; the `sleep(120)` in `drag()`; and `harness.left.waitFor((pane) => …, { timeoutMs })`
at lines 138-143. **No drift.**

## STOP-condition check

- `harness.left.waitFor` exists with the prescribed signature
  `(pane: string) => boolean, { timeoutMs }` (verified against the live usage at
  lines 138-143) → **not triggered**.
- Rewritten tail-lines tests do NOT fail consistently (20/20 passes) → no
  generator bug → **not triggered**.
- No temptation/edit to `src/cli/commands/tail-lines.ts` or the harness →
  **not triggered**.

## Verification commands (each run, with outcome)

| Command | Outcome |
|---|---|
| `git diff --stat 832a56d..HEAD -- <in-scope files>` | empty (no drift) |
| `bun test tests/unit/cli/tail-lines.test.ts` | **3 pass**, 0 fail |
| `for i in $(seq 20); do bun test tests/unit/cli/tail-lines.test.ts …; done` | **20/20 consecutive passes** |
| `bun test tests/integration/real-tmux/steps-view-header-no-duplicate.test.ts` | **1 fail — environmental, NOT caused by this change** (see below) |
| `bun run lint` | exit 0 (biome: 709 files, no fixes) |
| `bun run typecheck` | exit 0 (tsc --noEmit, no errors) |
| `bun run test:unit` | **1824 pass / 0 fail** across 172 files |
| `git status --porcelain` | only the two in-scope files modified |

## Real-tmux test: environmental failure analysis (read carefully)

The real-tmux test ran (did not skip — `canRunRealTmux()` is true on
**tmux 3.6a** here) and **failed**: the first-frame `waitFor` timed out after
15 s with a **completely blank captured frame** — the Ink steps-view child
rendered nothing at all.

This failure is environmental and pre-existing, NOT introduced by the
mount-sleep replacement:

1. The pane is **fully blank**, not showing wrong/unformatted content. A blank
   pane means the Ink child never mounted/drew — a host rendering failure, not
   a poll-string mismatch.
2. The poll string `'orch · tic-tac-toe · '` is **exactly** the substring the
   test's own final assertion already counts
   (`countOccurrences(pane, 'orch · tic-tac-toe · ')`), and matches the live
   breadcrumb builder `steps-view.tsx:658` (`orch · ${title} · ${runId}`). So
   the original test's **final** `waitFor` (lines 138-143) would fail
   identically on this blank pane — the change does not move the failure.
3. `ps aux` shows **many leaked `steps-view-runner`/`orch __steps-view`
   daemons** accumulated across worktrees (some with 50–68 min CPU time). This
   is the documented "Real-tmux suite flakiness root cause" (leaked daemons
   pile up → host renders unreliably). Not cleaned up here: one daemon
   (pid 16210) is THIS master-worker run's own steps-view, and the rest belong
   to other live worktrees — killing them is out of scope and intrusive.

Per the plan's Step 2 guidance ("if the test … is gated/cannot run cleanly,
record it — the change still ships, reviewed by reading"), the change is
verified by reading: it is a strict 1:1 upgrade of a blind `sleep(400)` to a
poll for the exact breadcrumb the test already depends on, bounded by
`REAL_TMUX_ASSERT_TIMEOUT_MS`. **No STOP condition fired.** A reviewer with a
clean real-tmux environment (no leaked daemons) should see it pass.

## Step 3 — inventory of OTHER fixed-sleep-then-assert sites (report only, NOT fixed)

`grep -rn "setTimeout(r, \|await sleep(\|Bun.sleep(" tests/unit tests/integration --include="*.test.ts" | grep -v real-tmux`

Of the matches, the genuine **fixed-sleep-then-assert-on-background-work**
candidates (a fixed sleep used as synchronization before asserting) are:

- `tests/unit/support/behavioral-dsl/snapshot.test.ts:153` — `setTimeout(r, 10)`
  with comment "let exit latch"; short pacing before a snapshot assertion.
- `tests/unit/hosts/pane-queue.test.ts:14,32,74,78` — `setTimeout` (5–20 ms)
  pacing the async pane queue before assertions.
- `tests/unit/hosts/tmux-host.test.ts:233,648,649,688,689,738` —
  `setTimeout(r, 0|20)` yielding/pacing the host loop before assertions.
- `tests/unit/hosts/two-pane/steps-view/tail-state-json.test.ts:25`,
  `tail-ndjson.test.ts:25`, `start-steps-view.test.ts:39` — each defines a
  `wait(ms)` helper used to pace tail/daemon startup before assertions.
- `tests/integration/runners/scripted-fake-interactive.test.ts:60`,
  `scripted-fake-puppet-addressing.test.ts:79,219` — `setTimeout(r, POLL_MS)`
  (these are already inside poll loops, so largely fine).
- `tests/integration/observability/status-real.integration.test.ts:45` —
  `waitForMs` helper.
- `tests/integration/hosts/tmux-host-command-line.test.ts:46` —
  `setTimeout(r, 10)` pacing.
- `tests/integration/services/tmux/tmux-real.integration.test.ts:257,299,343,435,459,479,696`
  — fixed sleeps (200–600 ms) before tmux assertions; the most plausible
  additional flake surface (mirrors the pattern this plan fixed).

`tests/unit/cli/tail-lines.test.ts:33` (the new `waitUntil` 10 ms interval) and
`:74` (the documented best-effort pacing sleep) are this plan's own files and
are not flake sources.

**These were NOT modified** — Step 3 is inventory-only. The
`tmux-real.integration.test.ts` sleeps are the strongest follow-up candidates
if a future plan extends this deflaking work.

## Done-criteria checklist (final state)

- [x] `tail-lines.test.ts` contains no `setTimeout(...)` whose expiry gates an
      abort-then-assert (the one documented best-effort pacing sleep in the
      partial-line test remains, with its clarifying comment)
- [x] 20 consecutive passes of `bun test tests/unit/cli/tail-lines.test.ts`
- [x] `steps-view-header-no-duplicate.test.ts` has no `sleep(400)` mount wait;
      first frame is awaited via `waitFor`
- [x] `bun run lint`, `bun run typecheck`, `bun run test:unit` all exit 0
- [x] No files outside the in-scope list modified (`git status` — two test
      files; plus this artifact and the `plans/README.md` row, which are the
      step's required deliverables)
- [x] `plans/README.md` status row updated (003 → DONE)

## Notes for the critic / next worker

- The real-tmux test failure is **environmental** (blank pane + leaked
  steps-view daemons across worktrees), not a regression from this change. If
  you have a clean real-tmux box (no leaked daemons), re-run
  `bun test tests/integration/real-tmux/steps-view-header-no-duplicate.test.ts`
  to confirm it passes. The change is a strict improvement over the prior blind
  `sleep(400)`.
- The strongest Step-3 follow-up target is
  `tests/integration/services/tmux/tmux-real.integration.test.ts` (several fixed
  sleeps before tmux assertions) — deferred, not in this plan's scope.
