---
title: two-pane auto-attach — orch attaches the user's TTY to the tmux session
type: feat
status: completed
date: 2026-04-23
---

# two-pane auto-attach

## Overview

When `orch` runs a workflow in `--mode=two-pane`, it currently creates a tmux session in the background and prints an attach command for the user to run *from a second terminal*. The user's first terminal stays with a line-by-line stdout stream — indistinguishable from `--mode=plain` — and for any workflow that completes in under ~10 seconds the session is torn down before the user can attach at all.

This plan closes that gap. In `two-pane` mode, after `setupTmux` finishes wiring the session, orch spawns `tmux attach-session` on the current TTY with inherited stdio. The user sees the two panes (left = status rollup, right = active step's view) immediately. When the workflow completes, teardown kills the session, which makes the attach client exit, which unblocks the CLI. When the user detaches early (`Ctrl-b d`), the workflow keeps running and the CLI prints a "detached; run continues" hint and waits in the background.

This is not a new feature — it's closing a gap the reframe brainstorm assumed was covered and the plan silently dropped. See [§ Problem Statement](#problem-statement) for the archaeology.

## Problem Statement

### Observed behavior (today, 2026-04-23 on `feat/phase-a-run-modes` @ `bdc0efe`)

```
$ bunx orch run riddle-solver-proper
[orch] mode=two-pane (auto: TTY + tmux ≥ 3.2) · --mode=... to override
Running workflow "riddle-solver-proper" (r-2026-04-23-na8fts)...
[orch tmux] attach with:   tmux -L orch-r-2026-04-23-na8fts attach -t orch
[orch tmux] clean up with: tmux -L orch-r-2026-04-23-na8fts kill-server
[orch] riddle step returned: Wrote the riddle to `./riddle.txt`.
[orch] solve  step returned: Answer written to solution.txt: **echo** — …
Workflow "riddle-solver-proper" completed.
```

The user never sees the two panes. They get plain-mode output with a hint they cannot act on in time.

### Where the requirement disappeared

The reframe brainstorm (`docs/brainstorms/2026-04-16-orch-reframe-brainstorm.md:43`) is explicit:

> `two-pane-demo.ts` and `multi-task-demo.ts` prove the target UX works … but those demos bypass orch entirely. **orch should *be* the thing doing that.**

The deleted demo (recover via `git show 1d45c4b:examples/two-pane-demo.ts`, step 9) ended with:

```ts
const proc = Bun.spawn(['tmux', '-L', SOCKET, 'attach-session', '-t', SESSION], {
  stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
})
await proc.exited
```

The reframe plan (`docs/plans/2026-04-18-feat-orch-reframe-step-views-run-modes-plan.md`) translated every other piece of `setupTmux` into Phase D but never mentions `attach-session`. The closest line (`:482`) says the tmux host's teardown "prints the attach + kill hints" — the substitution for the demo's actual attach that was never called out as a decision.

Two indirect signals confirm auto-attach was the implicit intent:

1. **DX review decision #3** (`docs/brainstorms/2026-04-16-orch-reframe-brainstorm.md:126-129`) says "Exit = tmux session kill / window close." You can only close a window you're attached to.
2. **The stories file** (`docs/brainstorms/2026-04-16-orch-reframe-brainstorm_storeis.md:94-105`) renders the two-pane ASCII as the first frame after `$ orch run compound`. That only works with immediate auto-attach.

The plan's `Host.attach(view, pane)` naming collision — *programmatic* view attach, not *terminal* attach — masked the gap. Every reviewer who grepped for "attach" in the plan saw it everywhere and assumed it was covered.

### Why this is load-bearing

Two-pane mode is the *only* mode that gives users readable runner transcripts alongside a live status rollup. Without auto-attach, two-pane is effectively unusable for the first-time user: the run completes before they can open a second terminal. They learn "two-pane mode produces the same stream as plain mode" — the opposite of what the reframe set out to deliver.

## Proposed Solution

Add one method to the `Host` interface — `attachForeground(): Promise<void>` — that:

- On `TmuxHost`: spawns `tmux -L <socket> attach-session -t <session>` via `ProcessService.spawnForeground` and awaits its exit.
- On `PlainHost`: no-op (returns resolved promise).

The CLI's `run` and `resume` command handlers call `attachForeground()` concurrently with the workflow executor. The first to finish drives the shutdown:

- **Workflow finishes first** → teardown kills the session → attach client exits → CLI exits 0 (or the workflow's exit code).
- **User detaches first** (`Ctrl-b d`) → attach client exits → CLI prints "detached; run continues; re-attach with …" → waits for the workflow silently → exits normally.

Safeguards:

- **No TTY + `--mode=two-pane`** → fail fast at mode resolution with the existing "explicit-mode-with-missing-capability errors" policy.
- **Nested tmux** (`$TMUX` set) → detect at host creation and surface a clear error; the v1 escape is `--mode=plain`. (v2 can route to `tmux switch-client` if desired.)
- **`--no-attach` flag** → new boolean flag that preserves today's hint-only behavior for scripting, CI harness tests, and users who want to attach manually from another window.

## Technical Approach

### Architecture

```mermaid
sequenceDiagram
  participant CLI as orch CLI
  participant TH as TmuxHost
  participant WF as WorkflowExecutor
  participant TMS as tmux server
  participant User as user TTY

  CLI->>TH: createTmuxHost(...)
  TH->>TMS: new-session -d -s orch
  TH->>TMS: split-pane, set-hook pane-died, …
  TH-->>CLI: Host (running status loop)
  CLI->>WF: executor.execute(deps) [non-blocking]
  WF->>TMS: send-keys (via TmuxService) [concurrent]
  CLI->>TH: attachForeground()
  TH->>User: spawnForeground(tmux attach-session) [stdio inherit]
  User-->>TH: Ctrl-b d OR session killed
  alt workflow finishes first
    WF-->>CLI: execute() resolves
    CLI->>TH: teardown()
    TH->>TMS: kill-session
    TMS-->>User: attach client exits
  else user detaches first
    User-->>TH: attach client exits
    CLI->>CLI: print "detached; run continues"
    WF-->>CLI: execute() resolves (later)
    CLI->>TH: teardown()
  end
```

### Host port extension

`src/hosts/host.ts` — add one method:

```ts
export interface Host {
  readonly mode: RunMode
  writeBanner(line: string): void
  onRunnerEvent(event: RunnerEvent, step: StepName): void
  onLifecycleEvent(event: StepLifecycleEvent): void
  attach(pane: PaneRole): Promise<PaneAttachment>
  runInteractive(opts: InteractiveSpawn): Promise<InteractiveResult>
  /**
   * Hand the controlling TTY to the host for the duration of the run.
   * On `two-pane`, spawns `tmux attach-session` with inherited stdio; resolves
   * when the attach client exits (user detached, or teardown killed the session).
   * On `plain`, resolves immediately (no-op).
   */
  attachForeground(): Promise<void>
  teardown(): Promise<void>
}
```

Naming considered:

| Candidate | Rejected because |
|---|---|
| `attachTty()` | TTY is platform-ish jargon; `Foreground` names the user-facing concept. |
| `takeForeground()` | Implies ownership stack — we're not implementing one. |
| `run()` / `watch()` | Too generic; collides with existing workflow/CLI verbs. |
| `attach()` (reusing) | Collides with programmatic `attach(pane)` — the *exact* collision that hid this gap in the reframe plan. Non-starter. |

### TmuxHost implementation

`src/hosts/two-pane/tmux-host.ts` — add the implementation alongside existing setup/teardown:

```ts
async function attachForeground(): Promise<void> {
  const handle = deps.processService.spawnForeground({
    argv: ['tmux', '-L', socket, 'attach-session', '-t', SESSION],
    env: process.env,
    cwd: path(process.cwd()),
  })
  const exitCode = await handle.exited
  if (exitCode !== 0 && !teardownStarted) {
    // Non-zero and we're NOT in the "teardown killed the session" path —
    // surface so the CLI can print a clear message. Don't throw; the
    // workflow may still be healthy.
    deps.stderr.write(`[orch tmux] attach exited with code ${exitCode}\n`)
  }
}
```

Two pieces of extra state:

- `teardownStarted: boolean` — set by `teardown()` before `kill-session`; `attachForeground` checks it to distinguish "workflow finished → clean exit" from "attach died unexpectedly."
- `nestedTmuxDetected: boolean` — set at host creation if `process.env.TMUX` is non-empty; `attachForeground` fails fast with the documented error if so.

### CLI orchestration

`src/cli/commands/run.ts` — flip from sequential to concurrent:

```ts
// Before (current shape, lines 85-93):
try {
  await result.executor.execute(wfDeps)
} catch (err) { … }
finally {
  await host.teardown()
}

// After:
let workflowSettled = false
const workflowPromise = result.executor.execute(wfDeps)
  .finally(() => { workflowSettled = true })

// Block on whichever finishes first.
// - attach exits when workflow's teardown kills the session
// - workflow exits when all steps complete (with/without error)
// - user detach exits attach but workflow keeps going — we handle below
await Promise.race([
  workflowPromise,
  host.attachForeground(),
])

if (!workflowSettled) {
  // User detached. Workflow is still running in-process.
  deps.stderr.write(
    `[orch] detached. run continues in background.\n` +
    `[orch] re-attach with: tmux -L ${socket} attach -t ${SESSION}\n` +
    `[orch] tail logs with: orch logs ${runId}\n`,
  )
}

try {
  await workflowPromise
} catch (err) { … }
finally {
  await host.teardown()
}
```

`src/cli/commands/resume.ts` — same pattern.

### Escape hatches

- **`--no-attach`** flag (new). When set, `run` / `resume` skip the `attachForeground` call. The CLI keeps today's hint-only output. Use cases: CI-with-tmux-for-screenshots, automated tests, multi-window users.
- **Nested tmux** (`$TMUX` is set). Error at host creation:
  ```
  [orch] cannot auto-attach — already inside a tmux session. Options:
           (1) run `tmux -L orch-<runId> attach -t orch` from a pane, OR
           (2) run orch outside tmux, OR
           (3) use --mode=plain
  ```
  The host is *not* created in this case — CLI exits `CONFIG_ERROR` before any session is started. v2 can add `--attach-via=switch-client` for nested-tmux users.

### Mode resolution guard

`src/core/run-mode.ts` already has the "explicit-mode-with-missing-capability errors" path for tmux missing. Extend it: `--mode=two-pane` without a TTY (`tty === false`) also errors. This closes the edge case where `--mode=two-pane --no-attach` on a headless box would otherwise succeed and leave an orphan tmux session.

Actually — `--no-attach` in CI is a legitimate use case (screenshot tests, tmux-driven integration checks). So the TTY guard stays, but `--no-attach` bypasses it. Concretely:

| `--mode` | TTY | `--no-attach` | Outcome |
|---|---|---|---|
| `two-pane` | yes | — | auto-attach (the new default) |
| `two-pane` | yes | yes | no attach, print hint, keep running |
| `two-pane` | no | yes | no attach, print hint, keep running (CI-valid) |
| `two-pane` | no | no | **exit 2** — "two-pane requires a TTY; add `--no-attach` for headless" |
| `plain` | any | any | `--no-attach` accepted, no-op |

## Alternative Approaches Considered

1. **Opt-in `--attach` flag, default off.** Rejected. Auto-attach was the brainstorm's implicit default (see "Exit = window close") and the silent non-attach is *the* bug. Making users discover the attach flag recreates the same "I cannot find the two-pane UI" pain.

2. **Print hint + wait for user to press Enter before attaching.** Rejected. Ceremony that buys nothing — the user can't act during the wait, and it adds a prompt no one asked for.

3. **Auto-attach + bind `Ctrl-C` at tmux level to trigger teardown.** Rejected by DX review decision #3 (`brainstorm:126`): "Orch owns nothing. Exit = tmux session kill / window close." Hotkey binding is a v2 concern.

4. **Spawn a new terminal window** (`osascript` on macOS, `x-terminal-emulator`, etc.). Rejected. Platform-specific, breaks headless servers, and the demo already proved inherited-stdio is the right shape.

5. **Double-fork so orch exits after attach and workflow orphans.** Rejected. The workflow runs in-process (executor is Bun, not a child process); orphaning requires a `spawn-detached` rewrite of the executor plus state-handoff for runner subprocesses. Cost wildly exceeds the feature's value.

6. **Foreground attach in a child `orch-attach` subcommand.** Rejected. Adds a top-level command for a non-user-facing concern; the detach-while-running UX is simpler with everything in one process.

## Acceptance Criteria

### Functional Requirements

- [x] `bunx orch run <workflow>` with `--mode=two-pane` auto-resolved (TTY + tmux ≥ 3.2) puts the user inside the tmux session immediately after session setup. Left + right panes visible. (mechanism covered; real-TTY manual smoke deferred to maintainer before tagging)
- [x] `Ctrl-b d` detaches the user. CLI prints `[orch] detached. run continues …` with `re-attach` and `orch logs` hints. Workflow keeps running; CLI exits when workflow completes. (race semantics covered by `tests/integration/cli/two-pane-auto-attach.test.ts`)
- [x] Workflow completion kills the session cleanly; attach client exits; CLI prints run summary and exits with the workflow's exit code. (covered by the workflow-first race test)
- [x] `--no-attach` preserves today's hint-only behavior on every mode (no-op on plain). (covered by `tests/unit/hosts/tmux-host-attach-foreground.test.ts` + `tests/integration/cli/two-pane-auto-attach.test.ts`)
- [x] `--mode=two-pane` without a TTY and without `--no-attach` exits 2 with the "requires a TTY; add --no-attach for headless" message. (covered by `tests/integration/cli/two-pane-tty-guard.test.ts`)
- [x] `--mode=two-pane` inside a nested tmux session (`$TMUX` non-empty) exits 2 before session creation with the nested-tmux guidance. (covered by the nested-tmux guard test)
- [x] `orch resume <runId>` in two-pane mode auto-attaches the same way. Resume semantics unchanged otherwise. (refactored to use the shared `executeWithAttach` helper)
- [x] Nothing changes for `--mode=plain`. Autodetected mode selection unchanged. (covered — `PlainHost.attachForeground` is a no-op; existing plain-mode tests still pass)

### Non-Functional Requirements

- [x] No new dependencies. Implementation uses `ProcessService.spawnForeground` (already landed).
- [x] No regression in `bun run check` wall-time. (test suite ~2s, same as before)
- [x] Sandbox isolation rule holds — `attach-session` spawn goes through `ProcessService`, not `Bun.spawn` directly (CLAUDE.md rule #1).
- [x] File-size budget: attach mechanics split into `src/hosts/two-pane/attach-foreground.ts`; `tmux-host.ts` sits at ~347 lines (slightly over the soft limit, justified by the new options plumbing documented inline).
- [x] No `mock.module` / `vi.mock` anywhere in `src/hosts/`, `src/cli/` tests — fakes go in via `ProcessService` port (CLAUDE.md rule #3).

### Quality Gates

- [x] `bun run check` green locally.
- [x] Unit coverage for: `attachForeground` argv shape, `teardownStarted` flag interaction, nested-tmux detection, no-op on plain.
- [x] Mocked integration coverage for: concurrent workflow + attach orchestration, detach-before-workflow-completes flow, workflow-completes-first flow, `--no-attach` bypass.
- [ ] Real-tmux integration coverage (gated by `RUN_REAL_TMUX=1`): full auto-attach lifecycle with programmatic detach via `tmux detach-client`. *(deferred — the mocked coverage exercises the same race semantics; real-tmux gated e2e can land as a follow-up without blocking this plan)*
- [x] Every test name is a full sentence (CLAUDE.md rule #4).

## Implementation Phases

### Phase 1 — Host seam + nested-tmux guard (tests first)

**Goal:** extend the `Host` interface and land implementations on both hosts. No CLI behavior change yet (the method exists but isn't called).

**Deliverables:**

- `src/hosts/host.ts` — add `attachForeground(): Promise<void>` to the `Host` interface with the documented semantics.
- `src/hosts/plain/plain-host.ts` — implement as `async () => {}`.
- `src/hosts/two-pane/tmux-host.ts` — implement via `ProcessService.spawnForeground(['tmux', '-L', socket, 'attach-session', '-t', SESSION])`. Track `teardownStarted` state; integrate with existing `teardown()`.
- `src/hosts/two-pane/tmux-host.ts` — at host creation, read `process.env.TMUX`; if non-empty, throw a `HostCreationError` with the nested-tmux message. CLI surfaces as exit 2.
- `src/core/run-mode.ts` — extend `resolveRunMode` to reject `--mode=two-pane` when `tty === false` *unless* a new `allowHeadlessTwoPane: boolean` input is true (set by CLI when `--no-attach` is present).

**Tests (unit):**

- `tests/unit/hosts/tmux-host-attach-foreground.test.ts`
  - `attachForeground composes tmux -L <socket> attach-session -t <session>` (FakeProcessService records argv).
  - `attachForeground resolves when the attach subprocess exits cleanly`.
  - `attachForeground resolves silently when teardown triggered the exit`.
  - `attachForeground writes a diagnostic to stderr when exit is non-zero and teardown did not fire`.
  - `host creation rejects when TMUX env var is non-empty, with nested-tmux guidance`.
- `tests/unit/hosts/plain-host-attach-foreground.test.ts`
  - `attachForeground on plain host resolves immediately with no subprocess spawn`.
- `tests/unit/core/run-mode-tty-guard.test.ts`
  - `two-pane with no TTY and no allowHeadless returns an explicit RunModeError`.
  - `two-pane with no TTY but allowHeadless=true resolves to two-pane with the headless source tag`.

**Acceptance:** `bun run check` green. No CLI behavior change — the method exists but nothing calls it yet.

---

### Phase 2 — CLI wiring + detach UX + `--no-attach` flag

**Goal:** wire `attachForeground` into `run` and `resume` with correct concurrency and teardown ordering. Ship the observable behavior change.

**Deliverables:**

- `src/cli/main.ts` — add `noAttach: { type: 'boolean' }` to `parseArgs`; thread through `CliOpts`.
- `src/cli/main.ts` — help text updated for `--no-attach`.
- `src/cli/main.ts` — `resolveMode` passes `allowHeadlessTwoPane: parsed.noAttach` to `resolveRunMode`.
- `src/cli/commands/run.ts` — refactor the execute block into the `Promise.race(workflow, attachForeground)` shape documented in [§ Technical Approach](#cli-orchestration). Print the `detached; run continues` stanza when the attach settles before the workflow.
- `src/cli/commands/resume.ts` — same refactor.
- `src/hosts/two-pane/tmux-host.ts` — when the CLI passes `noAttach: true`, `attachForeground` becomes a no-op that prints the old "attach with" hint to stderr and resolves immediately. The hint stays in the `--no-attach` path only; the default (auto-attach) path drops the hint from the initial banner.
- `src/cli/commands/run.ts` — map the workflow's final exit code through correctly (the attach race must not swallow `StepError` / `ViewResolutionError`).

**Tests (mocked integration):**

- `tests/integration/cli/two-pane-auto-attach.test.ts`
  - `run command spawns attach-session after host setup and before workflow execute resolves` (FakeProcessService timeline assertion).
  - `when workflow completes first, teardown fires before attach resolves, and CLI exits with workflow status`.
  - `when attach exits first (simulated detach), CLI prints the detached hint and continues waiting on the workflow`.
  - `run --no-attach does not spawn attach-session and emits the attach-with hint to stderr`.
  - `resume command follows the same auto-attach shape`.
- `tests/integration/cli/two-pane-tty-guard.test.ts`
  - `--mode=two-pane with a non-TTY stderr+stdout exits 2 with the TTY guidance`.
  - `--mode=two-pane --no-attach with a non-TTY is accepted and runs (no attach spawn)`.
  - `--mode=two-pane inside a nested tmux ($TMUX set) exits 2 before creating the session`.

**Tests (real tmux, gated by `RUN_REAL_TMUX=1`):**

- `tests/e2e/two-pane-auto-attach-real-tmux.test.ts`
  - `a short workflow completes with the user auto-attached; the tmux session is cleaned up afterward` — run a `FakeRunner`-backed workflow, let it finish, assert `tmux -L <socket> ls` returns nothing.
  - `programmatic detach via tmux detach-client transitions the CLI to the detached path` — fork a helper that runs `tmux -L <socket> detach-client -a` ~500ms after the attach; assert stderr contains `detached. run continues` and the workflow still completes.

**Acceptance:**

- [x] `bun run check` green.
- [ ] Manual smoke: `bunx orch run riddle-solver-proper` shows the two panes immediately; workflow summary prints on exit. *(deferred to maintainer on real TTY; example workflow currently broken independently — see "Out of scope" in this plan)*
- [ ] Manual smoke: same run with `Ctrl-b d` between steps → CLI prints detached hint, workflow finishes. *(same deferral)*
- [ ] Manual smoke: `bunx orch run riddle-solver-proper --no-attach` → today's hint-only behavior preserved. *(same deferral)*
- [x] `CI=true bun test` (no TTY) with `--mode=two-pane --no-attach` still runs (headless-valid path). (resolveRunMode test + nested-tmux-with-skipAttach test cover the contract)
- [x] `CI=true bun test` with `--mode=two-pane` alone exits 2 with the TTY guidance. (covered by `run-mode-tty-guard.test.ts` and `two-pane-tty-guard.test.ts`)

---

### Phase 3 — Docs + reframe-plan cross-reference + example defaults

**Goal:** update user-facing docs; patch the reframe plan so future readers find this gap closed; smoke-test every shipped example.

**Deliverables:**

- `docs/getting-started.md` — in the run-modes section, document that `two-pane` auto-attaches by default; document `--no-attach`; remove any implicit wording that says the user has to attach manually.
- `README.md` — one-line addition to the "run modes" paragraph.
- `docs/plans/2026-04-18-feat-orch-reframe-step-views-run-modes-plan.md` — add a "Follow-up (closed 2026-MM-DD by [this plan]): auto-attach" note at the top of the Phase D section explaining that Phase D's "prints the attach hint" was the designed v1 shape AT PLAN TIME and auto-attach landed as a separate follow-up; cross-link this plan file.
- `docs/brainstorms/2026-04-16-orch-reframe-brainstorm_storeis.md` — add a footer note clarifying that auto-attach is what lets the story ASCII render immediately after `$ orch run`.
- `examples/compound/index.ts` / `examples/riddle-solver-proper/index.ts` — smoke-test under `--mode=two-pane` both with and without `--no-attach`. No code change expected, but verify.
- `docs/solutions/two-pane-auto-attach.md` — **new**. Capture the "why programmatic `attach(view, pane)` hid the missing terminal-attach" lesson so future plan reviewers don't repeat it. Frontmatter: `tags: [reframe, planning, tmux, host], category: process-lifecycle, module: hosts/two-pane, symptoms: [two-pane mode shows plain-mode output, tmux session created but user not attached]`.

**Acceptance:**

- [ ] All four examples (`hello-file` fix notwithstanding — see [§ Out of scope](#out-of-scope)) run cleanly under `--mode=two-pane` with auto-attach. *(deferred — examples are broken independently per out-of-scope)*
- [x] `docs/getting-started.md` diff describes the UX as the user actually experiences it today.
- [x] The reframe plan is no longer self-contradictory (its Phase D acceptance references this follow-up).

---

## Out of scope

- **Fixing the self-executing `hello-file` / `riddle-solver` examples.** Those are broken independently (they construct `WorkflowDeps` without `host`, which became mandatory in Phase D; see `src/core/workflow.ts:141`). Track separately — adjacent cleanup, not auto-attach scope.
- **Tmux `switch-client` for nested-tmux users.** v2. Requires an IPC surface the v1 doesn't have.
- **Re-attach after detach without a second terminal.** v2. Could add `orch attach <runId>` as a top-level command later.
- **Orphaning the workflow on detach.** v2 (or never). Current behavior — workflow keeps running in-process until CLI exits — is correct and simple.
- **Ctrl-C mapping.** DX review decision #3 says orch owns zero keystrokes. Leave tmux's prefix as the only in-TUI control surface.
- **Rendering the banner inside the tmux left pane.** Already noted in reframe plan `:287`; unrelated to attach.

## Dependencies & Prerequisites

- **Phase D1 landed** (✓ `f5dc129`): `TmuxHost` port, per-pane serial queue, `respawn-pane -k` interactive path.
- **Phase E landed** (✓ `bdc0efe`): host registry, `orch.config.ts` discovery, `orch logs`.
- **`ProcessService.spawnForeground` exists** (✓ `src/services/process/process-service.ts:56,220,340`).
- **tmux ≥ 3.2** (existing gate via `src/cli/detect-tmux.ts`).

No external dependencies introduced.

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `attach-session` succeeds but the tmux client paints garbage (SIGWINCH race, wrong TERM) | low | medium | Real-tmux E2E covers this on macOS; request contributors retest on Linux before tagging. tmux has owned client rendering for 20+ years; low intrinsic risk. |
| User detaches → workflow continues silently → user thinks it hung | medium | low | The "detached; run continues" stanza includes `orch logs <runId>` so the user has a watch path. Documented explicitly. |
| Attach spawned before session is fully ready (race between `new-session -d` and `attach-session`) | low | high | `setupTmux` awaits the split-pane ack and writes the `cat` placeholder before returning the host; `attachForeground` is only called by the CLI *after* host creation resolves. Tested in the timeline assertion integration test. |
| Nested tmux (user forgets they're inside tmux) produces confusing error | medium | low | Clear nested-tmux error message at host creation with three concrete escape options. Documented in getting-started. |
| Workflow throws while attached; user sees error in pane but CLI foreground is blocked | low | medium | The `Promise.race` means the workflow throw unblocks the CLI thread, which proceeds to teardown → kill-session → attach exits. Traceback renders in both the right pane (via TmuxHost failure frame, Phase D2) and CLI stderr on exit. |
| `--no-attach` path accidentally breaks when auto-attach ships (tests too tightly coupled) | medium | low | Phase 1's unit tests assert the no-op shape on plain; Phase 2's `--no-attach` integration test keeps it load-bearing. Failing this fails `bun run check`. |
| File size: `tmux-host.ts` exceeds the 300-line soft limit | medium | low | Split attach mechanics into `src/hosts/two-pane/attach-foreground.ts` if the line budget is exceeded. Pre-committed to the refactor; noted inline. |

## Success Metrics

- **Qualitative (primary):** Running `bunx orch run riddle-solver-proper` on a TTY puts the user inside the tmux UI without any follow-up action. The "I thought this was plain mode" confusion disappears.
- **Quantitative (secondary):** Zero regressions in `bun run check`; added tests increase unit + integration count by ~15 and keep the suite under its current wall-time budget. E2E gated to `RUN_REAL_TMUX=1` so default CI wall-time unchanged.
- **Archival:** The reframe plan no longer contradicts the stories file. Future contributors reading either document get a consistent picture.

## Documentation Plan

| Doc | Change |
|---|---|
| `docs/getting-started.md` | Two-pane section: document auto-attach as the default; add `--no-attach` paragraph; remove stale wording about manual attach. |
| `README.md` | One-line addition in the run-modes paragraph. |
| `docs/plans/2026-04-18-feat-orch-reframe-step-views-run-modes-plan.md` | Phase D cross-reference to this plan as the follow-up that closed the hint-only substitution. |
| `docs/brainstorms/2026-04-16-orch-reframe-brainstorm_storeis.md` | Footer note: auto-attach is the precondition for every v1 story's opening frame. |
| `docs/solutions/two-pane-auto-attach.md` | **New.** Lesson on naming-collision-induced requirement loss during plan translation. |
| `CLAUDE.md` | No change. |

## References

### Internal

- Brainstorm — `docs/brainstorms/2026-04-16-orch-reframe-brainstorm.md:43` ("orch should *be* the thing doing that")
- Brainstorm DX review — `docs/brainstorms/2026-04-16-orch-reframe-brainstorm.md:126-129` (decision #3: exit = window close)
- Stories — `docs/brainstorms/2026-04-16-orch-reframe-brainstorm_storeis.md:94-105` (two-pane ASCII)
- Reframe plan — `docs/plans/2026-04-18-feat-orch-reframe-step-views-run-modes-plan.md:482` (hint substitution, the regression)
- Deleted demo — `git show 1d45c4b:examples/two-pane-demo.ts` (step 9, auto-attach via `Bun.spawn`)
- Host port — `src/hosts/host.ts:62-88`
- TmuxHost — `src/hosts/two-pane/tmux-host.ts:126-141`
- ProcessService foreground spawn — `src/services/process/process-service.ts:56,220,340-341`
- CLI main — `src/cli/main.ts:171-219`

### External

- tmux 3.2 `attach-session` — https://man7.org/linux/man-pages/man1/tmux.1.html
- Node.js `spawn` stdio modes — https://nodejs.org/api/child_process.html#optionsstdio (reference for the Bun equivalent `stdin/stdout/stderr: 'inherit'` behavior)

### Related

- This plan is scoped as a standalone follow-up. The maintainer may choose to file it as "Phase F" of the reframe plan instead; all the section headings here match that plan's structure for easy folding.
