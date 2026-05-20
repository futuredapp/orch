---
date: 2026-05-20
plan_id: 2026-05-20-001
topic: feat-two-pane-behavioral-test-dsl
type: feat
status: active
origin: docs/brainstorms/2026-05-20-feat-two-pane-behavioral-test-dsl-brainstorm.md
depth: deep
---

# Plan: Two-Pane Behavioral Test DSL + Tier 5 Lifecycle Campaign

## Summary

Build a **two-pane behavioral test DSL** (the tooling) and ship the first set of lifecycle cells written against it (the first consumer). Document the new layer as **Tier 5** in `docs/testing-strategy.md`. Tier 5 is the INFRASTRUCTURE (subprocess-based testing that boots a real `bun src/cli/main.ts run ...` orch process against a real tmux server); the DSL is its PUBLIC SURFACE (flat matchers and actions, no fluent chains); the lifecycle cells under `tests/integration/lifecycle/` are CONSUMER #1. Tier 5 is additive — Tier 1 stays the in-process default; Tier 5 catches the bug class Tier 1 cannot reach (CLI signal handlers, attached-TTY input, external `tmux kill-pane`/`kill-session`/`kill-server`, stdin-EOF).

Deliverables: (1) a public DSL at `tests/helpers/behavioral-dsl/` backed by a private harness at `tests/helpers/behavioral-dsl/internal/`; (2) a new `ScriptedFakeRunner` under `src/runners/scripted-fake/` that drives per-step behavior from a JSON-file path passed via `ORCH_LIFECYCLE_SCRIPT`; (3) a small `rawStreams: true` extension to `ProcessService.spawn` that tees the child's stdout into both line-framed and raw-byte views and exposes a stdin writable; (4) the headline acceptance test from origin §2.1 — `q` pressed in the left pane during a running Codex step — encoded via a programmatic `expectInvariantViolation` so the cell PASSES while the bug exists and FORCES DELETION once orch is fixed. The captured snapshot IS the bug ticket that feeds the next planning round.

The sub-agent orchestrated campaign sweep that origin §11 step 9 envisioned (orchestrator + parallel sub-agents producing additional cells across the full §7 matrix) is reframed as a **follow-up activity using the tooling delivered here**, not an active implementation unit. This plan delivers the tooling, the human-authored headline cells (U7–U10), and the U11 findings roll-up; the campaign sweep is a separate dispatch run.

(see origin: `docs/brainstorms/2026-05-20-feat-two-pane-behavioral-test-dsl-brainstorm.md`)

---

## Problem Frame

The user has hit a recurring bug class in `--mode=two-pane`: pressing `q` (or Ctrl-C, or closing the terminal) sometimes leaves orch wedged with `[Pane is dead]` showing in the left pane, the right-pane child still alive, the tmux session still up, and no working keyboard exit. Only SIGHUP from closing the host terminal recovers.

The reports are anecdotal because the existing Tier 1 harness (`tests/helpers/real-tmux/`) mounts `TmuxHost` **in-process**. The CLI entry point at `src/cli/main.ts` and the signal handlers at `src/cli/commands/execute-with-attach.ts:64-78` are never reached. None of these inputs can be exercised at Tier 1 today:

- `SIGINT` / `SIGTERM` / `SIGHUP` delivered to the orch process
- Ctrl-C typed inside the attached tmux client (routed by tmux to the active pane's child)
- External `tmux kill-pane` / `kill-session` / `kill-server`
- Terminal hangup (closing the controlling-TTY window)

The working hypothesis from origin §1 — to be **falsified by the campaign, not assumed** — is that pane-process death and in-pane keypresses are not escalated into a host-level teardown signal. The three reported symptoms are likely one bug class: `await trackedWorkflow` never resolves, `q` resolves `quitDeferred` but the workflow promise stays pending, and `pane-died` doesn't escalate to `host.teardown()`.

Tier 5 exists to **mechanically reproduce these inputs**. The campaign's job is to confirm or falsify the hypothesis with a captured `LifecycleSnapshot` for each matrix cell.

(see origin: §1 "Problem")

---

## Requirements

Carried from origin §2 (success criteria S1–S4) and §2.1 (concrete reproduction). S-IDs preserved verbatim; R-IDs added for plan-level traceability.

| ID | Owner Unit(s) | Notes |
| --- | --- | --- |
| S1 — Test author writes a behavioral two-pane test in the DSL without touching `Bun.spawn`, `RealTmuxService`, or `ProcessService` directly | U1, U2, U3, U4, U5, U6, U8 | DSL barrel is the only thing tests import |
| S2 — First lifecycle sweep produces ≥1 cell that fails with a captured snapshot demonstrating an invariant violation | U9 | The §2.1 fake-variant snapshot is the explicit S2 evidence |
| S3 — When a cell cannot be expressed in the DSL, the gap is filed as a finding (FAIL-DSL), not silently skipped | U11 | Triage taxonomy enforced by the orchestrator agent |
| S4 — DSL covers ≥3 of the symptom classes the user reported (Ctrl-C-in-attached, signal-to-orch, external pane kill) | U10, U11 | All three are first-batch cells |
| R1 — The §2.1 acceptance test (`q` during running Codex step) exists, runs, and reproduces the screenshot as a deterministic captured snapshot of the invariant violation | U9 | Uses `expectInvariantViolation` so the cell PASSES while the bug exists. The snapshot IS the bug ticket; committing the cell to git is the durable evidence |
| R2 — Tier 5 is documented in `docs/testing-strategy.md` alongside Tiers 1–4, including a 5-line skeleton, the gating predicate, and when to choose Tier 5 over Tier 1 | U1 | Same shape as the existing Tier 1 / Tier 4 sections |
| R3 — `ScriptedFakeRunner` reads its per-step script from `process.env.ORCH_LIFECYCLE_SCRIPT` (a JSON file path) and implements the `Runner` interface | U3 | Lives at `src/runners/scripted-fake/` |
| R4 — `launchOrchWorkflow` parses `runId` from orch's stderr line `Running workflow "<name>" (<runId>)...` and derives `socket = 'orch-' + runId` for the external tmux probe | U4 | No new CLI flag required |
| R5 — `LifecycleSnapshot` captures process state, tmux state, state-store status, per-step file intactness, balanced alt-screen / mouse-tracking escape counts, and orphan-children sweep | U6 | The contract input |
| R6 — `runInvariantContract(snapshot, scenario)` returns a list of violations; outcome matchers (`cleanly()`, `balancedEscapes()`, `doesNotExist()`) are projections of this contract | U6 | One source of truth |
| R7 — Each lifecycle cell lives in its own file at `tests/integration/lifecycle/<input>-during-<state>.real.test.ts`; the cell-per-file layout is intentional so the campaign report is a directory listing | U7, U9, U10, U11 | One cell = one file, predicted outcome inline as a comment |
| R8 — `bringToState` helper drives the workflow to a named state (`pre-run`, `mid-step`, `between-steps`, `completed`, `failed`, `awaiting-ask`) before the user-action gesture fires | U4, U8 | Required by every cell that isn't `pre-run` |
| R9 — Tier 5 cells gate on the same `RUN_REAL_TMUX_E2E` env + binary-on-PATH predicate as Tier 4 for the real-CLI variants; fake variants gate only on `tmux` on PATH | U4, U9 | Mirrors `canRunRealTmux()` / `canRunRealTmuxE2E('codex')` from `tests/helpers/real-tmux/` |
| R10 — The invariant contract at §6.5 of origin is the authoritative spec; per-cell `assertAllInvariants(scenarioTag)` runs the full applicable contract and reports the violation list with the snapshot inline | U6 | Editing the contract is the response to a FAIL-EXPECTATION triage |

The **product-shape decision from origin §13** is carried verbatim: the `q` row of the §6.5 invariant contract requires full teardown (orch exits, running agents are killed, tmux session gone, state-status = `cancelled`) — **not** today's "run continues" semantics at `src/hosts/two-pane/steps-view/steps-view.tsx:325`. This is a contract decision only; the actual code change to `q` semantics, and the footer-copy and detach-hint cleanup at `src/cli/commands/execute-with-attach.ts:106`, are out of scope here (next planning round, after the §2.1 snapshot is in hand).

---

## High-Level Technical Design

*This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Two-layer architecture (DSL public, harness private)

```
                                              tests/integration/lifecycle/<cell>.real.test.ts
                                              imports ONLY from:
                                                ▼
              ┌──────────────────────────────────────────────────────┐
              │  Layer A — DSL (public surface)                      │
              │  tests/helpers/behavioral-dsl/index.ts (barrel)      │
              │                                                      │
              │   launchOrchWorkflow / holdUntilReleased             │
              │   userAction(typeInAttachTty | pressKeyInPane | ...) │
              │   assertLeftPane / assertRightPane                   │
              │   assertWorkflowState / assertOrchExits              │
              │   assertTmuxSession / assertTerminalState            │
              │   containsText / isFocused / withinMs / cleanly ...  │
              └─────────────────────────┬────────────────────────────┘
                                        │ (private)
                                        ▼
              ┌──────────────────────────────────────────────────────┐
              │  Layer B — Harness (engine, NOT imported by tests)   │
              │  tests/helpers/behavioral-dsl/internal/              │
              │                                                      │
              │   lifecycle-handle.ts   OrchHandle + scenario boot   │
              │   subprocess.ts         orch via BunProcessService   │
              │   external-tmux-probe.ts   2nd RealTmuxService +     │
              │                            ProcessService for the    │
              │                            harness-only tmux verbs   │
              │   mouse-events.ts       SGR-encoded mouse bytes      │
              │   snapshot.ts           LifecycleSnapshot capture    │
              │   invariants.ts         runInvariantContract(...)    │
              │   workflow-fixtures.ts  pointers to tests/fixtures/  │
              └─────────────────────────┬────────────────────────────┘
                                        │
                                        ▼
              ┌──────────────────────────────────────────────────────┐
              │  src/runners/scripted-fake/ScriptedFakeRunner        │
              │    + tests/fixtures/lifecycle/*.ts workflows         │
              │    + src/services/process/ extended SpawnHandle      │
              └──────────────────────────────────────────────────────┘
```

The DSL is responsible for **readability**; the harness is responsible for **mechanism**. Keep the seam clean — if a DSL verb needs new mechanism, the harness extension is filed as harness work, not folded into a test. If a sub-agent cannot express a cell in the DSL, that is a `FAIL-DSL` triage row (origin §9) and feeds the DSL surface forward, not the test inline.

### DSL grammar sketch (target shape for tests)

```ts
// tests/integration/lifecycle/q-during-fake-mid-step.real.test.ts
describe.skipIf(!canRunRealTmux())('lifecycle — q during fake mid-step', () => {
  it('cancels the workflow and tears down everything', async () => {
    const orch = await launchOrchWorkflow('two-step-linear', {
      script: { plan: holdUntilReleased() },
      bringToState: { kind: 'mid-step', name: 'plan' },
      mode: 'two-pane',
    })

    await assertLeftPane(isFocused(), containsText('▶ live'))
    await assertWorkflowState(isRunningStep('plan'))

    await userAction(clickOnPane('left'))
    await userAction(pressKeyInPane('left', 'q'))

    await assertOrchExits(withinMs(5_000), cleanly())
    await assertTmuxSession(doesNotExist())
    await assertWorkflowState(hasStatus('cancelled'))
    await assertTerminalState(balancedEscapes(), noOrphanChildren())
  }, 30_000)
})
```

Predicate composition is flat (`...matchers`); each matcher is a tiny pure function over a `LifecycleSnapshot` or pane/state slice. Adding a matcher is a one-file change in `pane-matchers.ts`, `workflow-matchers.ts`, or `outcome-matchers.ts`.

### Subprocess + state isolation (per-test)

```
                              ┌───────────────────────────────────────────────┐
                              │  bun src/cli/main.ts run <fixture>            │
                              │  --mode=two-pane                              │
                              │                                               │
                              │  env:                                         │
                              │    ORCH_LIFECYCLE_SCRIPT=<tmpdir>/script.json │
                              │    ORCH_STATE_BASE=<tmpdir>/state             │
                              │    (passthrough merge per env-passthrough)    │
                              │                                               │
                              │  stdio: ['pipe', 'pipe-raw', 'pipe-raw']      │
                              └────────────┬──────────────────────────────────┘
                                           │
                  ┌────────────────────────┼────────────────────────────────┐
                  │                        │                                │
                  ▼                        ▼                                ▼
       stderr line-framed         stdin (writable —          stdout cumulative bytes
       parsed for runId           attach-TTY channel)        (for alt-screen / mouse-
       → socket = orch-$runId                                tracking escape counts)
                  │
                  ▼
       External RealTmuxService + ExternalTmuxProbe (harness-only verbs)
       on the parsed socket:
         hasSession() / hasServer() / killSession() / killServer() /
         killPane(l|r) / sendKeys(...) / sendMouseEvent(pane, x, y, button)
```

Stdio is sketched as `pipe-raw` because the current `SpawnHandle` only exposes line-framed `stdout`/`stderr` (verified at `src/services/process/process-service.ts:27-32`) — the harness needs raw stdin write + cumulative raw stdout bytes. U2 extends the seam (see Key Technical Decisions). Bun.spawn cannot be imported directly outside `src/services/process/` per CLAUDE.md rule #1.

---

## Output Structure

The plan introduces three new directory roots plus extends two existing ports. Per-unit `**Files:**` sections remain authoritative.

```
src/runners/
  scripted-fake/                                 [NEW]
    index.ts
    scripted-fake-runner.ts
    script-loader.ts                             # reads ORCH_LIFECYCLE_SCRIPT JSON
    types.ts                                     # StepScript discriminated union

src/services/process/
  process-service.ts                             [MODIFY — rawStreams opt + stdin/stdoutBytes]
  bun-process-service.ts                         [MODIFY — honor rawStreams]
  fake-process-service.ts                        [MODIFY — honor rawStreams in tests]

tests/helpers/behavioral-dsl/                    [NEW — DSL public surface]
  index.ts                                       # barrel: only thing tests import
  launch.ts                                      # launchOrchWorkflow + holdUntilReleased
  user-actions.ts                                # userAction + action constructors
  pane-matchers.ts                               # containsText, isFocused, isInState, ...
  workflow-matchers.ts                           # isRunningStep, hasStatus, hasExitCode, ...
  outcome-matchers.ts                            # withinMs, cleanly, doesNotExist, ...
  assertions.ts                                  # assertLeftPane, assertRightPane, ...
  internal/                                      # harness engine — tests MUST NOT import
    lifecycle-handle.ts                          # OrchHandle + startLifecycleScenario
    subprocess.ts                                # orch spawn via BunProcessService
    external-tmux-probe.ts                       # 2nd RealTmuxService + harness verbs
    mouse-events.ts                              # SGR-encoded tmux mouse byte builder
    snapshot.ts                                  # LifecycleSnapshot capture
    invariants.ts                                # runInvariantContract(scenario, snapshot)
    workflow-fixtures.ts                         # paths to tests/fixtures/lifecycle/*

tests/fixtures/lifecycle/                        [NEW — fixture workflows]
  two-step-linear.ts
  three-step-with-ask.ts                         # for awaiting-ask state cells
  step-failing-mid.ts                            # for failed state cells
  codex-riddle-mid-step.ts                       # real-codex variant for §2.1

tests/integration/lifecycle/                     [NEW — one cell = one file]
  sigint-to-orch-during-mid-step.real.test.ts    # U7 — first end-to-end (PASS predicted)
  q-during-fake-mid-step.real.test.ts            # U9 — §2.1 fake variant (FAIL-BUG predicted)
  q-during-codex-mid-step.real.test.ts           # U9 — §2.1 codex variant (FAIL-BUG predicted)
  ctrl-c-twice-in-attached-during-mid-step.real.test.ts   # U10
  sigterm-to-orch-during-mid-step.real.test.ts            # U10
  sighup-to-orch-during-mid-step.real.test.ts             # U10
  close-stdin-during-mid-step.real.test.ts                # U10 (renamed from close-terminal — see U10 scope note)
  double-sigint-to-orch-during-mid-step.real.test.ts      # U10
  click-to-focus-across-divider-smoke.real.test.ts        # U8 (smoke)
  # ~10 human-authored cells total in this plan (U7, U8, U9 × 2, U10 × 7).
  # The full §7 matrix (84 cells) and an orchestrator-driven sub-agent campaign
  # producing additional cells are explicit follow-up work — see Scope Boundaries.

docs/testing-strategy.md                         [MODIFY — add Tier 5 section]
docs/findings/                                   [NEW]
  2026-05-20-lifecycle-campaign-findings.md      # U11 — campaign roll-up
```

The directory tree is a scope declaration. The implementer may adjust the internal layout if implementation reveals a better split (e.g., merging two thin matcher files); the per-unit `**Files:**` sections remain authoritative.

---

## Key Technical Decisions

- **`ProcessService.spawn` extended with a `rawStreams: true` option that tees the child's stdout into BOTH a line-framed iterable AND a cumulative byte buffer, plus exposes `writeStdin(data)` on the returned handle.** CLAUDE.md rule #1 mandates that all subprocess calls go through `ProcessService`. The current `SpawnHandle` only exposes line-framed `stdout`/`stderr` (`src/services/process/process-service.ts:27-32`) — sufficient for runners, insufficient for the harness which must (a) write raw bytes into orch's stdin (the attach-TTY channel for `typeInAttachTty('\x03')`), and (b) tally `\x1b[?1049[hl]` / `\x1b[?100[03][hl]` byte sequences in cumulative stdout for `balancedEscapes()`. **Implementation constraint discovered during planning:** Bun's `proc.stdout` is a single `ReadableStream<Uint8Array>` whose reader can only be acquired once — today's `frameLines(...)` (`src/services/process/line-framer.ts:46-58`) already calls `getReader()` and drains it. The `rawStreams: true` path therefore CANNOT just "also accumulate bytes from the same stream"; it must tee the stream into two branches before either consumer attaches (`stream.tee()` returns two independent `ReadableStream`s, or a single async pump pushes each chunk to both a line-framer-compatible sink and a `Buffer`). U2's approach documents the tee explicitly. The extension is additive: existing callers (every runner) ignore the new opt-in field. Both `BunProcessService` and `FakeProcessService` honor `rawStreams` — `FakeProcessService` gains a new `respondWith({ stdoutBytes: Buffer, ... })` shape because its existing `respondWith({ stdout: string[] })` is line-based and can't carry raw escape sequences. Origin §10 Q1 (verify-before-design) is folded into U2.

- **Tier 5 is additive, not a replacement.** Tier 1 keeps the in-process default for everything it can cover under the §0 triage rule ("Would this test still pass if the visible pane were empty / wrong / unformatted? If yes, demote or delete"). Tier 5 is reserved for the bug class Tier 1 cannot reach: anything that requires a real CLI signal handler, a real attached-TTY, or a real external tmux verb (`kill-pane`, `kill-session`, `kill-server`). The doc update in U1 names the boundary explicitly so future-author drift is visible at review time.

- **`ScriptedFakeRunner` is a sibling of `FakeRunner`, not a refactor of it.** `FakeRunner` (`src/runners/fake/fake-runner.ts`) drives its script from an in-process method chain — useful in Tier 1 where the test author controls the same process. Tier 5 spans two processes (test runner + orch subprocess), so the script must cross the process boundary; the cleanest channel is an env-var-pointed JSON file (`ORCH_LIFECYCLE_SCRIPT`). Sharing one runner with two driving modes would entangle the in-process and cross-process surfaces; separating them keeps each thin. The `StepScript` discriminated union (`instant-ok` / `instant-fail` / `wait-for-file` / `emit-then-hang`) is the explicit cross-process contract.

- **`wait-for-file` step gating, not IPC.** The DSL's `release(stepName)` creates a gate file at a path the script names; `ScriptedFakeRunner` polls for the file's existence and proceeds when it appears. Unidirectional file-based control eliminates IPC complexity (no sockets, no shared memory, no port allocation, no per-platform pipe quirks). Polling interval and timeout are explicit parameters on the script entry, not hidden defaults.

- **External tmux verbs added to the harness, not to `RealTmuxService`'s production surface.** `RealTmuxService` already exposes `killPane`, `killSession`, `listPanes`, `sendKeys` (verified at `src/services/tmux/real-tmux-service.ts:185, 294, 341` and `src/services/tmux/tmux-service.ts:382-432`). The harness needs four additions: `hasSession()`, `hasServer()`, `killServer()`, `sendMouseEvent(pane, x, y, button)`. `hasSession()` and `hasServer()` are read probes broadly useful for any code path that needs to know whether tmux is reachable; they go on the `TmuxService` port as additive methods (U5). `killServer()` and `sendMouseEvent()` are destructive / test-only verbs that don't belong in the production interface — they live in `tests/helpers/behavioral-dsl/internal/external-tmux-probe.ts` and shell tmux via `ProcessService` directly (rule #1 honored — the harness file is in `tests/`, not `src/`, but uses `ProcessService` exactly like a runner would).

- **Mouse-event injection via tmux's `send-keys -M` with an SGR-encoded sequence.** Origin §6.3 documents the mechanism. `sendMouseEvent(pane, x, y, button)` looks up pane center coordinates via `display-message -p '#{pane_width},#{pane_height}'`, encodes the SGR byte sequence (`ESC [ < button ; col ; row M`), and dispatches via `send-keys -M`. Tmux ≥3.0 is required (the appliance-mode click-to-focus binding already depends on this); the harness asserts `meetsMinimumTmuxVersion('3.0')` at fixture boot via the existing `src/cli/detect-tmux.ts` probe.

- **`LifecycleSnapshot` is a single immutable struct, captured atomically per assertion.** Origin §6.4 names the fields. All matchers are pure projections of the snapshot — no matcher reaches back through the harness for side-effecting state. The snapshot includes `pane_dead=1` status per pane (parsed from `tmux list-panes -F '#{pane_dead},#{pane_id}'`), so the user's reported "[Pane is dead]" symptom is directly observable (origin §10 Q4 resolution: `isPaneDead()` is a candidate matcher for U10 cells, dispatched on first need rather than pre-built).

- **`runInvariantContract(snapshot, scenario)` is the single source of truth; per-cell `assertAllInvariants(scenarioTag)` runs the full applicable contract.** Outcome matchers like `cleanly()`, `balancedEscapes()`, and `doesNotExist()` are projections of the contract, not parallel sources. When the contract is wrong for a cell, the cell triages as `FAIL-EXPECTATION` and the contract gets edited — not the per-test assertion. This is the foundation of the exploratory triage taxonomy (origin §9).

- **The §2.1 acceptance test ships in both fake and real-CLI variants.** Origin §2.1 makes both variants explicit: a `ScriptedFakeRunner`-driven cell (`q-during-fake-mid-step.real.test.ts`) for deterministic CI, and a Codex-driven cell (`q-during-codex-mid-step.real.test.ts`) env-gated like Tier 4 for the original reproduction surface. Both are predicted FAIL-BUG. The fake variant carries S2 in default CI; the codex variant carries the "this matches the user's actual screenshot" evidence for the next planning round.

- **The campaign is exploratory (orchestrator + parallel sub-agents per cell), not prescriptive.** Origin §8 documents methodology C. The triage column on `docs/findings/2026-05-20-lifecycle-campaign-findings.md` IS the decision input for the downstream bug-fix planning round — we don't pre-commit to which cells "should" pass. When a cell's contract row is wrong, the sub-agent files a contract-revision note (FAIL-EXPECTATION); when a cell can't be expressed in the DSL, the sub-agent files a DSL gap (FAIL-DSL); when the input can't be simulated, the cell is skipped with a `FAIL-HARNESS` pointer. The orchestrator catches uncategorized failures as its own error.

- **`q` row of the invariant contract reflects the product-shape decision from origin §13: full teardown, not "run continues."** The contract at §6.5 says `q` during a running step requires orch exit, running-agent kill, tmux teardown, and `state-status = cancelled`. This contradicts the current spec at `src/hosts/two-pane/steps-view/steps-view.tsx:325` (`"q quit (run continues)"`) and the detach hint at `src/cli/commands/execute-with-attach.ts:106`. **The actual code change to `q` semantics and the footer-copy / detach-hint cleanup are explicitly out of scope here** — they are downstream work that consumes the §2.1 snapshot. The contract carries the new spec because the §2.1 test must encode the user's expected behavior, not the broken current behavior.

- **U9 uses `expectInvariantViolation`, not `assertAllInvariants` — the cell PASSES while the bug exists, and FAILS only when the bug is fixed.** This is the programmatic defense for Risk R-D (a future contributor "fixing" the broken test against broken behavior). `expectInvariantViolation('pane-q-during-run', withinMs(5_000))` polls the snapshot and PASSES the moment the violation list is non-empty; FAILS only when the violation list becomes empty (i.e., orch was fixed). The cell's failure message explicitly says "violation list became empty — delete the cell." This means a contributor shipping the fix to `steps-view.tsx:325` must delete the §2.1 cell (a reviewable change) — they cannot make it pass by inverting an assertion or marking `it.skip`. The captured snapshot is committed under `tests/integration/lifecycle/__snapshots__/` so the bug ticket persists even after the cell is removed.

- **Plain mode is excluded; launcher hard-defaults to two-pane.** Origin §3 lists plain-mode lifecycle as a non-goal — the user's reported bugs are all two-pane. The launcher's `mode` parameter accepts `'two-pane'` only for v1 (Q5 from origin §10 resolved). A future plain-mode suite is separate scope.

---

## System-Wide Impact

- **`ProcessService` port (additive).** Optional `rawStreams?: boolean` on `SpawnOptions`. When set, the returned `SpawnHandle` exposes additional `writeStdin(data: string | Uint8Array): void` and `stdoutBytes(): Buffer` members. Existing callers ignore the new fields; existing `SpawnHandle` consumers continue to use the line-framed iterables. Both `BunProcessService` and `FakeProcessService` implement the new opt-in.

- **`TmuxService` port (additive).** Two new **production** methods: `hasSession(opts: { socket, session }): Promise<boolean>` and `hasServer(opts: { socket }): Promise<boolean>` — added to the public interface at `src/services/tmux/tmux-service.ts:382` and implemented on `RealTmuxService` (probe via `tmux has-session -t <session>` exit code) and `FakeTmuxService` (in-memory session table lookup). Today's only consumer is the harness, but the methods are intentionally on the production port because "is tmux reachable?" is a generic question any future production code path could ask. Destructive `killServer()` and test-only `sendMouseEvent()` do NOT enter the production interface — they live in `tests/helpers/behavioral-dsl/internal/external-tmux-probe.ts`.

- **New `ScriptedFakeRunner` under `src/runners/scripted-fake/`.** Implements `Runner` and `defineRunner(...)` so its shape is validated by the same Zod schema as other adapters (`src/runners/types.ts:189-243`). The runner is registered as `name: 'scripted-fake'`; it is **only** instantiated by fixture workflows under `tests/fixtures/lifecycle/`. Production workflows never reference it. Its `buildCommand(ctx)` returns a no-op argv that exits cleanly (the real behavior is driven by the script loader at construction time, not at spawn time).

- **New `tests/helpers/behavioral-dsl/` directory.** Public DSL barrel + private harness. The barrel is the only file tests at `tests/integration/lifecycle/` may import. The internal/ files are off-limits to test authors by convention; an eslint rule (or doc-only ban) enforces this — see Open Questions.

- **`docs/testing-strategy.md` gains a Tier 5 section.** Same shape as the existing Tier 1 / Tier 4 sections: bug class, file path convention, gating predicate, 5-line skeleton, "when to write at which tier" boundary entry. The "four tiers" table becomes five rows.

- **Per-test state isolation.** Every Tier 5 cell allocates an isolated state base under `mkdtemp(tmpdir()/orch-tier5-)` and passes the path via `ORCH_STATE_BASE` to the orch subprocess. Existing test code already honors `ORCH_STATE_BASE` (verified by codebase grep — used by the `real-tmux` fixture); no changes needed in `src/state/state-store.ts`. The base is removed in `afterEach`.

- **No change to**: `src/core/workflow.ts`, `src/hosts/two-pane/tmux-host.ts`, `src/cli/commands/execute-with-attach.ts`, the right-pane controller, the steps view, the existing `tests/helpers/real-tmux/` harness, or any production runner. Tier 5 observes the system from outside; nothing inside the system changes for Tier 5 to work. The exception is U1's docs-only and scaffold edits, and U2's additive port extension.

---

## Work Blocks

The 11 implementation units below land in **4 work blocks (W1–W4)**. Each block is one shippable PR — internally sequenced by U-ID dependencies, externally bounded by a clear ship criterion. **U-IDs remain the unit of work and the stable identifier** (per the U-ID stability rule: never renumbered, reordering preserves IDs, splits keep the original ID on the original concept); **W-IDs are the unit of delivery and code review.** A block can be split into smaller PRs if a single block becomes unwieldy, but the default is one PR per W.

### W1 — Foundations (U1 + U2)

**Stack:** Tier 5 scaffold + `docs/testing-strategy.md` Tier 5 row + `ProcessService.spawn` `rawStreams` extension.

**Story:** Pure plumbing. No user-visible change yet. After W1 lands, the directory layout, the typed stubs, and the production-port extension all exist; no tier-5 cells exist.

**Ship criterion:**
- `bun run check` green (lint + typecheck + unit + mocked-integration).
- `tests/unit/services/process/raw-streams.test.ts` covers the line-framed / raw-byte independence, FakeProcessService recording, and back-compat probes.
- `docs/testing-strategy.md` renders the five-tier table without breakage and includes the Tier 5 5-line skeleton.

### W2 — Cross-process control loop (U3 + U4)

**Stack:** `ScriptedFakeRunner` under `src/runners/scripted-fake/` + first fixture workflow `tests/fixtures/lifecycle/two-step-linear.ts` + the subprocess launcher `launchOrchWorkflow` with runId parse + `bringToState` polling + state-base isolation.

**Story:** First end-to-end story. After W2 lands, a test can boot `bun src/cli/main.ts run two-step-linear` as a subprocess, observe its `state.json` appear, drive it to a named state, and tear it down cleanly. No assertion surface yet — the harness exists, the DSL barrel still throws on most matchers.

**Ship criterion:**
- `bun run check` green.
- `tests/integration/behavioral-dsl/launch-smoke.real.test.ts` passes when `tmux` is on PATH; skips otherwise.
- ScriptedFakeRunner's unit + smoke tests cover every `StepScript` variant (`instant-ok` / `instant-fail` / `wait-for-file` / `emit-then-hang`).

### W3 — Harness mechanism + DSL surface (U5 + U6 + U7 + U8)

**Stack:** `TmuxService.hasSession`/`hasServer` production extension + `ExternalTmuxProbe` (harness-only) + `LifecycleSnapshot` + `runInvariantContract` + all matchers (pane / workflow / outcome) + assertions + mouse-event builder + `expectInvariantViolation` helper + first two smoke cells: SIGINT-to-orch (U7, predicted PASS) and click-to-focus-across-divider (U8 smoke, predicted PASS).

**Story:** The DSL is usable. After W3 lands, a test author can write a tier-5 cell using only `import { ... } from 'tests/helpers/behavioral-dsl'` and assert against any combination of pane / workflow / outcome matchers. Two PASS smoke cells prove the DSL works end-to-end before any FAIL-BUG cell ships.

**Ship criterion:**
- `bun run check` green.
- `tests/integration/lifecycle/sigint-to-orch-during-mid-step.real.test.ts` PASSES (the SIGINT handler should work; if this cell FAILS, that's a bigger finding and the W4 cells start sooner).
- `tests/integration/lifecycle/click-to-focus-across-divider-smoke.real.test.ts` PASSES.
- The DSL barrel (`tests/helpers/behavioral-dsl/index.ts`) is the only file either smoke cell imports.

### W4 — Headline cells + findings (U9 + U10 + U11)

**Stack:** §2.1 acceptance cells (`q-during-fake-mid-step` + `q-during-codex-mid-step`) using `expectInvariantViolation` + Ctrl-C / SIGTERM / SIGHUP / `closeStdin` / double-SIGINT cells + the new `codex-riddle-mid-step` fixture + the findings doc `docs/findings/2026-05-20-lifecycle-campaign-findings.md` + committed snapshot artifacts under `tests/integration/lifecycle/__snapshots__/`.

**Story:** The deliverable evidence. After W4 lands, the §2.1 reproduction is encoded as a passing-while-broken test (forces deletion when the bug is fixed), the user's three reported symptom classes are covered (S4), and the findings doc rolls up the actual outcomes (PASS vs FAIL-BUG vs FAIL-EXPECTATION) of every cell authored in W3 + W4.

**Ship criterion:**
- `bun run check` green.
- `q-during-fake-mid-step.real.test.ts` PASSES via `expectInvariantViolation` in default CI (where `tmux` is on PATH).
- `q-during-codex-mid-step.real.test.ts` PASSES via `expectInvariantViolation` under `RUN_REAL_TMUX_E2E=1` with `codex` on PATH.
- `docs/findings/2026-05-20-lifecycle-campaign-findings.md` exists with executive summary + per-triage-class sections.
- ≥1 FAIL-BUG snapshot is committed under `tests/integration/lifecycle/__snapshots__/` (S2 evidence).
- The PR description includes the captured fake-variant snapshot inline.

### Block dependency graph

```
W1 (U1, U2) ──┐
              ├──> W2 (U3, U4) ──> W3 (U5, U6, U7, U8) ──> W4 (U9, U10, U11)
              │
              └──> (U3 in W2 depends on U1 only, not U2)
```

W2 cannot start until W1 lands (U4 depends on U2's `rawStreams`). W3 cannot start until W2 lands (U6's snapshot consumes `OrchHandle` from U4). W4 cannot start until W3 lands (all cells consume the matcher surface). Within a block, the U-IDs are dependency-ordered so they can be committed serially inside the same PR.

---

## Implementation Units

### U1. Tier 5 scaffold + `docs/testing-strategy.md` documentation (W1)

**Goal:** Establish the Tier 5 directory layout and document the new tier alongside Tiers 1–4. No behavioral code yet — this unit is the structural commit that subsequent units extend.

**Requirements:** R2. Enables S1, S2, S3, S4, R1, R3–R10.

**Dependencies:** none.

**Files:**
- `tests/helpers/behavioral-dsl/index.ts` (new — empty barrel with named re-exports planned but not yet implemented)
- `tests/helpers/behavioral-dsl/launch.ts` (new — stub exports)
- `tests/helpers/behavioral-dsl/user-actions.ts` (new — stub exports)
- `tests/helpers/behavioral-dsl/pane-matchers.ts` (new — stub exports)
- `tests/helpers/behavioral-dsl/workflow-matchers.ts` (new — stub exports)
- `tests/helpers/behavioral-dsl/outcome-matchers.ts` (new — stub exports)
- `tests/helpers/behavioral-dsl/assertions.ts` (new — stub exports)
- `tests/helpers/behavioral-dsl/internal/lifecycle-handle.ts` (new — stub `OrchHandle` type)
- `tests/helpers/behavioral-dsl/internal/subprocess.ts` (new — stub)
- `tests/helpers/behavioral-dsl/internal/external-tmux-probe.ts` (new — stub)
- `tests/helpers/behavioral-dsl/internal/mouse-events.ts` (new — stub)
- `tests/helpers/behavioral-dsl/internal/snapshot.ts` (new — stub `LifecycleSnapshot` interface)
- `tests/helpers/behavioral-dsl/internal/invariants.ts` (new — stub `runInvariantContract` signature)
- `tests/helpers/behavioral-dsl/internal/workflow-fixtures.ts` (new — stub)
- `tests/helpers/behavioral-dsl/README.md` (new — DSL surface reference, mirrors `tests/helpers/real-tmux/README.md` style)
- `docs/testing-strategy.md` (modify — extend the "four tiers" table to five rows; add a Tier 5 section with bug class, file path convention, gating predicate, 5-line skeleton, and "when to write at which tier" entry)

**Approach:**
- Stubs export typed identifiers (`export const launchOrchWorkflow = (..): Promise<OrchHandle> => { throw new Error('not yet implemented') }`) so downstream units can wire imports incrementally without rewriting tests.
- `LifecycleSnapshot` interface is fully declared in U1 (no implementation yet) so subsequent units can reference its shape without forward-declaration churn.
- `docs/testing-strategy.md` Tier 5 row: bug class = "CLI signal handlers, attached-TTY input, external tmux verbs, terminal hangup"; lives at `tests/integration/lifecycle/*.real.test.ts`; boots tmux = yes; boots real CLI = "fake variant: no; codex/claude variant: yes (env-gated)".
- The 5-line skeleton in the Tier 5 section uses `holdUntilReleased()` + `assertOrchExits(withinMs(...), cleanly())` to communicate the DSL shape.

**Patterns to follow:**
- `tests/helpers/real-tmux/README.md` structure for the new `behavioral-dsl/README.md`.
- `docs/testing-strategy.md`'s existing Tier 1 / Tier 4 sections for layout symmetry.

**Test scenarios:** Test expectation: none — this unit is scaffold + docs only. `bun run check` passing (lint + typecheck on the stub barrel) is sufficient.

**Verification:**
- `bun run check` green.
- `tests/helpers/behavioral-dsl/index.ts` exports compile.
- `docs/testing-strategy.md` renders the five-tier table without table-syntax breakage.

---

### U2. Extend `ProcessService.spawn` with `rawStreams` opt (stdin writable + cumulative stdout bytes) (W1)

**Goal:** Add the spawn-time opt-in that lets the Tier 5 harness write to a subprocess's stdin and tally raw stdout bytes — without violating CLAUDE.md rule #1 by reaching for `Bun.spawn` outside `src/services/process/`.

**Requirements:** R5 (snapshot's `stdoutAltScreen` / `stdoutMouseTracking` byte counts), enables R4 and S4 (`typeInAttachTty('\x03')`).

**Dependencies:** U1 (interface stubs reference the extended `SpawnHandle`).

**Files:**
- `src/services/process/process-service.ts` (modify — add optional `rawStreams?: boolean` to `SpawnOptions`; add optional `writeStdin?: (data: string | Uint8Array) => void` and `stdoutBytes?: () => Buffer` to `SpawnHandle`)
- `src/services/process/bun-process-service.ts` (modify — when `rawStreams === true`, configure `Bun.spawn` with piped stdin + raw stdout capture; expose the writable + cumulative buffer on the returned handle)
- `src/services/process/fake-process-service.ts` (modify — honor `rawStreams`; expose a queueable writable that records bytes; expose `stdoutBytes` from a script-driven byte source)
- `tests/unit/services/process/raw-streams.test.ts` (new)

**Approach:**
- `rawStreams` is opt-in and additive. When omitted or `false`, behavior is exactly today's (line-framed only). When `true`, both the line-framed `stdout` iterable AND the new `writeStdin` / `stdoutBytes` members are present.
- **Stream tee is the load-bearing implementation detail.** A `ReadableStream<Uint8Array>` has exactly one reader. When `rawStreams: true`, `BunProcessService` must fork `proc.stdout` before attaching `frameLines(...)`. Two acceptable implementations: (a) call `proc.stdout.tee()` once at spawn time, feed branch A to `frameLines` and accumulate branch B into a `Buffer` via a background pump; (b) implement a single async loop that reads chunks once and pushes each chunk to BOTH a `Buffer` accumulator AND a `frameLines`-compatible sink. Either way, the line-framed iterable continues to yield as before. U2's tests assert this independence (see test scenarios).
- `writeStdin` is synchronous fire-and-forget (matches Bun's `subprocess.stdin?.write(...)` semantics); errors after write surface via the next `wait()` resolution. `writeStdin` requires the underlying spawn to use `stdin: 'pipe'`, which `rawStreams: true` implies.
- `stdoutBytes()` returns a cumulative `Buffer` of every byte received since spawn — monotonically growing, never reset.
- `FakeProcessService` gains a parallel `respondWith({ stdoutBytes: Buffer, stdinObservations?: Buffer })` shape. The existing line-based `respondWith({ stdout: string[] })` continues to work for non-raw spawns; tests that need raw-byte fakes use the new shape. `stdinObservations` records bytes written to `writeStdin` so unit tests can assert what the harness wrote.
- The harness is the only documented consumer for v1; the extension is generic enough that future interactive-CLI consumers can lean on it without further changes.

**Patterns to follow:**
- The additive-opt pattern from `SpawnOptions.tag` (`src/services/process/process-service.ts:14`) — optional, ignored by callers that don't care.
- `FakeProcessService`'s existing `when(...).respondWith(...)` chain for the fake's byte-queue surface.

**Test scenarios:**
- When `rawStreams === false` (or omitted), `spawn(...).writeStdin` and `stdoutBytes` are both `undefined` — back-compat probe.
- When `rawStreams === true`, `spawn(...).writeStdin('hello\n')` reaches the child's stdin and the child sees `'hello\n'` on read (use `bun -e 'console.log(await Bun.stdin.text())'` as a tiny harness child).
- When `rawStreams === true`, `spawn(...).stdoutBytes()` returns a cumulative buffer containing every byte the child wrote — including raw escape sequences like `\x1b[?1049h` that line-framing would split or drop.
- **Independence assertion: when `rawStreams === true`, the line-framed `stdout` iterable yields exactly the lines the child wrote AND `stdoutBytes()` accumulates the same byte total — both views read from the same tee'd source without one consuming the other.** This is the load-bearing test that proves the stream-tee implementation is correct.
- `stdoutBytes()` called twice at different moments returns monotonically growing buffers (no reset).
- `FakeProcessService` with `rawStreams: true` records bytes written to `writeStdin` in `stdinObservations` so a unit test can assert "harness wrote what it claimed to write."
- `FakeProcessService.respondWith({ stdoutBytes: Buffer })` produces a fake whose `stdoutBytes()` returns the configured buffer and whose line-framed `stdout` yields the buffer's logical lines.
- The existing line-framed `stdout`/`stderr` iterables still emit as before when `rawStreams: true` (the extension does not break the line-framed view).
- Spawning with `rawStreams: false` after a `rawStreams: true` spawn does NOT leave state on the service (each spawn is independent).

**Verification:** `bun run check` passes. `bun test tests/unit/services/process/raw-streams.test.ts` green.

---

### U3. `ScriptedFakeRunner` + first fixture workflow (`two-step-linear`) (W2)

**Goal:** Introduce a cross-process runner whose per-step behavior is driven by a JSON file path passed via `process.env.ORCH_LIFECYCLE_SCRIPT`. Ship the first fixture workflow that wires it into a two-step linear shape so subsequent units have a target to drive.

**Requirements:** R3, R8. Enables S1, S2, R1, R7.

**Dependencies:** U1 only (the scaffold). U3 deliberately does NOT depend on U2 — the runner is launched in-process by the workflow engine, not by the harness, so it doesn't need rawStreams.

**Files:**
- `src/runners/scripted-fake/index.ts` (new)
- `src/runners/scripted-fake/scripted-fake-runner.ts` (new)
- `src/runners/scripted-fake/script-loader.ts` (new — reads + validates JSON)
- `src/runners/scripted-fake/types.ts` (new — `StepScript` discriminated union)
- `tests/fixtures/lifecycle/two-step-linear.ts` (new — two-step workflow wiring `ScriptedFakeRunner` into each step slot)
- `tests/unit/runners/scripted-fake/scripted-fake-runner.test.ts` (new)
- `tests/unit/runners/scripted-fake/script-loader.test.ts` (new)

**Approach:**
- `StepScript` union per origin §6.2:
  - `{ kind: 'instant-ok'; events?: RunnerEvent[]; structuredOutput?: unknown }`
  - `{ kind: 'instant-fail'; message: string }`
  - `{ kind: 'wait-for-file'; gatePath: string; events?: RunnerEvent[] }`
  - `{ kind: 'emit-then-hang'; events: RunnerEvent[] }`
- The runner's `buildCommand(ctx)` returns an argv that re-invokes `bun src/runners/scripted-fake/__entry.ts` (a tiny entry script) which loads the script JSON, finds the entry for `ctx.env.ORCH_LIFECYCLE_STEP_NAME` (set by the runner's `buildCommand` from the step's metadata via `ctx`), and emits the scripted events on stdout one line per line.
- The script entry for `wait-for-file` polls `gatePath` at a configurable interval (default 50ms) until the file exists, then emits any scripted events and exits 0.
- `emit-then-hang` emits the scripted events then waits indefinitely (until killed by signal or pane death) — the harness asserts on what happens during the hang.
- `defineRunner(...)` is used so the new runner is validated by the same Zod schema as other adapters.
- `two-step-linear.ts` exposes a registered workflow named `tier5-two-step-linear` (CLI lookup name) with steps `'plan'` and `'execute'`, both wired to `ScriptedFakeRunner`. The fixture file is auto-loaded by `orch.config.ts` in the test working directory (or via `--config` if the launcher prefers explicit loading — see U4).

**Patterns to follow:**
- `src/runners/fake/fake-runner.ts` structure (constructor, `name`, `supports`, `defaultView`, the four methods + optional resume/capture).
- `src/runners/codex/codex-runner.ts` for argv composition that re-invokes a script.
- `defineRunner` validation at `src/runners/types.ts:236-243`.

**Test scenarios:**
- `script-loader` reads a valid JSON file path from `process.env.ORCH_LIFECYCLE_SCRIPT` and returns a typed `Record<StepName, StepScript>` map.
- `script-loader` throws a clear error when `ORCH_LIFECYCLE_SCRIPT` is unset (programming error — the runner only exists for Tier 5).
- `script-loader` throws when the file is missing, malformed JSON, or fails the `StepScript` Zod schema (unknown `kind`, missing required field for `wait-for-file`, etc.).
- `instant-ok` step emits the scripted events on stdout in order, then a `turn-complete` terminal event, then exits 0.
- `instant-ok` with `structuredOutput` attaches the structured payload to the `turn-complete` event's `data` field.
- `instant-fail` emits a `terminal/error` event and exits with a non-zero code.
- `wait-for-file` blocks until the gate file is touched, then proceeds — verify with a sub-50ms touch and assert proceed-within-bounds.
- `wait-for-file` aborts cleanly on `SIGTERM` while polling — verify exit code matches signal semantics.
- `emit-then-hang` emits scripted events then stays alive past `waitForText(...)` window — verify the hang is observable.
- `ScriptedFakeRunner.toTranscriptLines(...)` round-trips events as expected (mirror `FakeRunner`'s formatting).
- `two-step-linear` fixture, booted by a tiny smoke harness (no Tier 5 subprocess), runs both steps to completion when scripted as `instant-ok` × 2.

**Verification:** `bun run check` passes. All `tests/unit/runners/scripted-fake/**` and the smoke test on `two-step-linear` pass.

---

### U4. Subprocess launcher (`launchOrchWorkflow`) + runId parse + state-base isolation (W2)

**Goal:** Build the harness primitive that spawns `bun src/cli/main.ts run <fixture> --mode=two-pane` with the script env wired, parses `runId` from stderr, derives the tmux socket, and returns a typed `OrchHandle` to subsequent assertions. This is the first DSL primitive that actually crosses the process boundary.

**Requirements:** R4, R8, R9. Enables S1, S2, R1, R7, R10.

**Dependencies:** U2 (needs `rawStreams: true` to write to orch's stdin), U3 (the fixture workflow it boots).

**Files:**
- `tests/helpers/behavioral-dsl/launch.ts` (modify — replace stub with real `launchOrchWorkflow`)
- `tests/helpers/behavioral-dsl/user-actions.ts` (modify — add `holdUntilReleased`, `release`, `wait` action constructors; full `userAction` set lands in U7/U8)
- `tests/helpers/behavioral-dsl/internal/lifecycle-handle.ts` (modify — flesh out `OrchHandle` with `runId`, `socket`, `stateBase`, subprocess handle, env, predicted-state-dir path)
- `tests/helpers/behavioral-dsl/internal/subprocess.ts` (modify — spawn orch via `BunProcessService` with `rawStreams: true`; parse stderr for the `Running workflow "<name>" (<runId>)...` line at `src/cli/commands/run.ts:104`)
- `tests/helpers/behavioral-dsl/internal/workflow-fixtures.ts` (modify — register `'two-step-linear'`, return the fixture's `orch.config.ts` path and the workflow name to invoke)
- `tests/integration/behavioral-dsl/launch-smoke.real.test.ts` (new — "launch, observe state.json appears, teardown")

**Approach:**
- `launchOrchWorkflow(fixtureName, opts)`:
  1. Allocate `stateBase = await mkdtemp(tmpdir() + '/orch-tier5-')` and a `scriptPath = <stateBase>/script.json` to which the launcher writes `opts.script` serialized.
  2. Build `argv = ['bun', 'src/cli/main.ts', 'run', workflowName, '--mode=two-pane']` plus any `bringToState`-derived CLI tail (e.g., no extra args for `pre-run` or `mid-step`).
  3. Build `env = mergeEnv(process.env, { ORCH_LIFECYCLE_SCRIPT: scriptPath, ORCH_STATE_BASE: stateBase }, opts.env ?? {})` per `src/runners/_shared/merge-env.ts` env-passthrough policy.
  4. `processService.spawn({ argv, cwd: <fixture-dir>, env, rawStreams: true })`.
  5. Race the stderr line-framed iterable against a `withTimeoutMs` deadline (default 10s) AND against the subprocess's `wait()` promise. The stderr stream emits banner lines (`[orch] mode=...` at `src/cli/main.ts:436`, possibly `[orch] live progress: ...` at `:438`) BEFORE `Running workflow "<name>" (<runId>)...` from `src/cli/commands/run.ts:104` — the parser must skip lines until it matches the regex `Running workflow "([^"]+)" \((r-[^)]+)\)`. On regex match: capture `runId` and derive `socket = 'orch-' + runId`. On `wait()` resolving first: the subprocess exited before reaching the runId line (config error, argv error, unknown command, workflow load failure) — surface the captured stderr tail + exit code in the thrown error.
  6. `bringToState` runs after the runId parse: poll `state.json` (path: `<stateBase>/state/<runId>/state.json`) until the requested state is reached.
     - `'pre-run'`: return immediately after runId parse (state.json may not exist yet).
     - `'mid-step'`: poll until `state.json` shows the named step's status is `running`.
     - `'between-steps'`: poll until the prior step shows `completed` and the next step is not yet started.
     - `'completed'` / `'failed'`: poll until run status is `completed` / `failed`.
     - `'awaiting-ask'`: poll until the ask-step state indicates the prompt is mounted.
  7. Return `OrchHandle { runId, socket, stateBase, subprocess, env, stateDir }`.
- `holdUntilReleased()` returns a `StepScript` of shape `{ kind: 'wait-for-file', gatePath: <stateBase>/<stepName>.gate }`. The DSL's `release(stepName)` action creates that gate file.
- Teardown is registered in `afterEach` per cell: kill the orch subprocess if still alive (graceful then forced after 1s), tear down the tmux socket if still alive, remove the state base.
- Readiness gate timeouts are bounded by an explicit `OrchHandle`-level timeout (default 10s spawn-to-runId, default 15s spawn-to-bringToState). All polls use bounded `waitFor` loops; no `sleep(N)` (origin §10 R3).

**Patterns to follow:**
- `mergeEnv` env-passthrough composition from `src/runners/_shared/merge-env.ts` and the env-passthrough plan at `docs/plans/2026-04-27-feat-env-passthrough-plan.md`.
- The runId stderr line `'Running workflow "<name>" (<runId>)...'` at `src/cli/commands/run.ts:104` is the parse anchor.
- The `tests/helpers/real-tmux/fixture.ts` socket-allocation pattern (`orch-${runId}`) for socket derivation.
- `afterEach` disposal of fixtures/harnesses from `tests/helpers/real-tmux/README.md`.

**Test scenarios:**
- Launching `'two-step-linear'` with `script: { plan: instantOk, execute: instantOk }` and `bringToState: 'completed'`: the handle resolves after both steps complete; orch exits 0; the snapshot at exit shows `stateStatus === 'completed'`.
- Launching with `bringToState: 'pre-run'` returns an `OrchHandle` whose `state.json` may not yet exist — assertions in this state are explicitly the harness's "we haven't reached a step yet" surface.
- Launching with `bringToState: { kind: 'mid-step', name: 'plan' }` and `script: { plan: holdUntilReleased() }`: the handle resolves with state.json showing `plan` status = `running` and the subprocess still alive.
- Releasing the gate file via `release('plan')` (the action under user-actions.ts, not a userAction yet at this unit — direct fs call OK for the smoke test) proceeds the held step.
- A bogus fixture name throws a clear error at launch time (no orch process leak).
- A fixture whose orch process exits before the runId line is parsed throws with a captured stderr tail.
- The runId parse times out (e.g., orch hangs at boot) within the spawn-to-runId deadline; the launcher kills the subprocess and throws.
- The state-base directory is cleaned up after `OrchHandle.teardown()` (verify via `existsSync` in afterEach hook of the smoke test).
- `mergeEnv` is honored: setting `opts.env = { FORCE_COLOR: '0' }` reaches the orch subprocess's process.env.
- Two parallel `launchOrchWorkflow` calls in the same test do not collide on socket name (different runIds → different sockets → both succeed).

**Verification:** `bun run check` passes. Smoke test `tests/integration/behavioral-dsl/launch-smoke.real.test.ts` passes when `tmux` is on PATH; skips otherwise.

---

### U5. External tmux probe — `TmuxService` extension + harness-only verbs (W3)

**Goal:** Reach the running orch process's tmux server from outside to (a) probe session/server liveness and (b) inject destructive verbs (`killServer`) and mouse events that the production interface doesn't expose. Keep the production surface clean while still routing every subprocess call through `ProcessService`.

**Requirements:** R5, R6, R7, R10. Enables S4 (`externalKillPane` / `externalKillSession` / `externalKillServer`), R1, R8.

**Dependencies:** U4 (the probe attaches to the socket the launcher parsed).

**Files:**
- `src/services/tmux/tmux-service.ts` (modify — add `hasSession(opts: { socket; session }): Promise<boolean>` and `hasServer(opts: { socket }): Promise<boolean>` to the interface)
- `src/services/tmux/real-tmux-service.ts` (modify — implement `hasSession` via `tmux has-session -t <session>` exit-code probe; implement `hasServer` via `tmux list-sessions` exit-code probe)
- `src/services/tmux/fake-tmux-service.ts` (modify — in-memory implementation matching the existing session table)
- `tests/helpers/behavioral-dsl/internal/external-tmux-probe.ts` (modify — replace stub with real `ExternalTmuxProbe` class; composes a second `RealTmuxService` instance pointing at the parsed socket, plus harness-only `killServer()` and `sendMouseEvent(pane, x, y, button)` which shell tmux via the injected `ProcessService`)
- `tests/helpers/behavioral-dsl/internal/mouse-events.ts` (modify — replace stub with SGR-encoded mouse byte builder: `buildSgrMouse({ pressed, button, col, row }): string`)
- `tests/unit/services/tmux/has-session-server.test.ts` (new)
- `tests/unit/services/tmux/external-mouse-events.test.ts` (new — covers `buildSgrMouse` formatting; the probe's end-to-end behavior is exercised in U8/U9 cells)

**Approach:**
- `RealTmuxService.hasSession({ socket, session })`: spawn `tmux -L <socket> has-session -t <session>` and return `exitCode === 0`. Tolerate exit codes 1 (no such session) and "no server" stderr — both map to `false`. Re-throw on unexpected errors.
- `RealTmuxService.hasServer({ socket })`: spawn `tmux -L <socket> list-sessions`; `false` on exit code 1 or "no server" stderr, `true` on exit 0, throw on unexpected.
- `ExternalTmuxProbe.killServer()`: spawn `tmux -L <socket> kill-server` via `ProcessService` directly (no `RealTmuxService` method exists; we don't want one in production). Tolerate "no server" as a no-op (idempotent — matches the existing `killSession` adapter contract at `src/services/tmux/real-tmux-service.ts:294`).
- `ExternalTmuxProbe.sendMouseEvent(pane, x, y, button)`:
  1. Resolve pane coordinates by reading pane geometry via `displayMessage({ socket, target: paneId, format: '#{pane_left},#{pane_top},#{pane_width},#{pane_height}' })` — `-t <paneId>` is mandatory, otherwise `display-message` returns coords of the active pane (which changes during the test).
  2. Compute `col = paneLeft + Math.floor(paneWidth / 2)`, `row = paneTop + Math.floor(paneHeight / 2)` (center) when `x`/`y` omitted; otherwise honor the provided coordinates.
  3. Build SGR press + release sequences via `buildSgrMouse`.
  4. Dispatch via `tmux -L <socket> send-keys -t <pane> -M <sgr-bytes>` for press, then again for release.
- **Mouse-event boundary**: `send-keys -M` is a SERVER-SIDE mouse injection. tmux interprets the event for tmux-level bindings (e.g., the appliance-mode click-to-focus binding at `src/services/tmux/session-init.ts`); whether the event also reaches the pane's child process depends on the child's mouse-tracking state. For v1, the harness uses mouse events ONLY to trigger tmux-level focus switching. Cells that need a click to reach the Ink steps view directly are out of scope (none in U7–U10 require this). Document this boundary in `mouse-events.ts` JSDoc.
- The probe's constructor takes the `OrchHandle` (for `socket`) and a `ProcessService` reference; tests construct via `new ExternalTmuxProbe(handle, new BunProcessService())`.

**Patterns to follow:**
- `src/services/tmux/real-tmux-service.ts:294-320` (`killSession`) for "tolerate not-found as no-op" idempotency.
- `meetsMinimumTmuxVersion` from `src/cli/detect-tmux.ts` for the v3.0 gate (called at launcher boot, not at probe construction).
- Existing `FakeTmuxService` in-memory table layout for the new probes.

**Test scenarios:**
- `hasSession` returns `true` when the named session exists on the socket.
- `hasSession` returns `false` (not throws) when the session doesn't exist on a live server.
- `hasSession` returns `false` when the tmux server is down.
- `hasSession` throws on an unexpected tmux failure (stderr unrelated to either of the above) — assert on the error class.
- `hasServer` returns `true` when the server is up.
- `hasServer` returns `false` when the server is down ("no server" / exit code 1).
- `FakeTmuxService.hasSession` / `hasServer` match the in-memory session table.
- `ExternalTmuxProbe.killServer()` against a live socket destroys the server; subsequent `hasServer()` returns `false`.
- `ExternalTmuxProbe.killServer()` against an already-dead server is a no-op.
- `buildSgrMouse({ pressed: true, button: 'left', col: 12, row: 5 })` returns the exact SGR press sequence `\x1b[<0;12;5M`.
- `buildSgrMouse({ pressed: false, button: 'left', col: 12, row: 5 })` returns the exact SGR release sequence `\x1b[<0;12;5m`.

**Verification:** `bun run check` passes. New unit tests pass. The probe's end-to-end behavior is exercised via U8's click-to-focus smoke and U9's headline cell.

---

### U6. Snapshot capture + outcome matchers + invariant contract (W3)

**Goal:** Build `snapshot()` capturing the full `LifecycleSnapshot` shape, the outcome matchers that project the snapshot (`cleanly()`, `doesNotExist()`, `withinMs()`, `balancedEscapes()`, `noOrphanChildren()`, `hasIntactPerStepFiles()`), and `runInvariantContract(snapshot, scenarioTag)` returning the violation list. This is the contract layer — all assertion semantics live here.

**Requirements:** R5, R6, R10. Enables S2, S3, S4, R1.

**Dependencies:** U2 (`stdoutBytes()` for escape-counting), U4 (handle for state-dir + subprocess access), U5 (probe for tmux state).

**Files:**
- `tests/helpers/behavioral-dsl/internal/snapshot.ts` (modify — replace stub with full `snapshot(handle, probe): Promise<LifecycleSnapshot>` implementation)
- `tests/helpers/behavioral-dsl/internal/invariants.ts` (modify — replace stub with `runInvariantContract(snapshot, scenarioTag): InvariantResult[]` and the per-scenario contract table mirroring origin §6.5)
- `tests/helpers/behavioral-dsl/outcome-matchers.ts` (modify — implement `withinMs`, `cleanly`, `doesNotExist`, `balancedEscapes`, `noOrphanChildren`, `hasIntactPerStepFiles` as projections of the snapshot)
- `tests/helpers/behavioral-dsl/assertions.ts` (modify — implement `assertOrchExits`, `assertTmuxSession`, `assertTerminalState`, `assertWorkflowState`, `assertAllInvariants(scenarioTag)`, AND `expectInvariantViolation(scenarioTag, ...outcomes)` — passes when the violation list is non-empty, fails when empty; used by U9's "first-run failure is success" cells per Risk R-D's programmatic defense)
- `tests/unit/helpers/behavioral-dsl/snapshot.test.ts` (new — uses `FakeProcessService` + `FakeTmuxService` to drive the snapshot inputs)
- `tests/unit/helpers/behavioral-dsl/invariants.test.ts` (new — table-driven contract assertions)

**Approach:**
- `LifecycleSnapshot` (per origin §6.4):
  - `orchAlive: boolean`, `orchExit: { code; signal } | null` from the subprocess handle's `wait()` race against a 0-timeout poll.
  - `tmuxSessionExists`, `tmuxServerExists` from probe.
  - `panesAlive: PaneId[]` from `tmux list-panes -F '#{pane_id}'`; `isPaneDead(pane)` cross-check via `tmux list-panes -F '#{pane_dead},#{pane_id}'`.
  - `leftPaneText`, `rightPaneText` from `tmux capture-pane -p -t <pane>` (existing `RealTmuxService.capturePane` at `src/services/tmux/real-tmux-service.ts:321`).
  - `leftPaneFocused` from `display-message -p -t <session> '#{?@active-pane,1,0}'` or equivalent.
  - `stateStatus`, `stepStatuses` from reading `<stateBase>/state/<runId>/state.json` via `FsService`.
  - `perStepFilesIntact`: per step, read `formatted_output*` and assert each ends with `\n`.
  - `stdoutAltScreen`, `stdoutMouseTracking`: regex-count `\x1b[?1049[hl]` and `\x1b[?100[03][hl]` in `handle.subprocess.stdoutBytes()`.
  - `orphanChildren`: recursive `pgrep -P <orchPid>` sweep via `ProcessService` — see Risks (R1 in origin).
- Matchers are pure: each returns `(snapshot: LifecycleSnapshot) => MatchResult`. Assertions evaluate a configured list against a captured snapshot and throw with the full violation list on any failure (no early-bail — surface all violations at once so the snapshot is the bug ticket).
- `withinMs(ms)` is a meta-matcher: it bounds the polling window the assertion waits over before capturing the final snapshot. Implementation: `await waitFor(predicate, { timeoutMs })` with the snapshot captured at every poll iteration; the assertion succeeds the first time all matchers pass, fails by emitting the LAST snapshot when the timeout expires.
- **Snapshot consistency requirement.** `snapshot()` makes multiple subprocess calls (tmux list-panes, capture-pane, display-message, pgrep, fs read of state.json). To bound internal inconsistency: capture `orchAlive` / `orchExit` LAST (after every tmux + filesystem probe completes). Stamp each snapshot with `capturedAtMs: number` from `Clock.nowMs()` and `orchAliveDurationMs: number` (how long orch had been alive at capture time). Reviewers can sanity-check whether the snapshot reflects a coherent moment. Failing assertions print the timestamp and duration alongside the field dump.
- `runInvariantContract` is a table-driven dispatcher:
  - `scenarioTag` examples: `'signal-sigint'`, `'signal-sigterm'`, `'signal-sighup'`, `'close-terminal'`, `'attach-tty-ctrl-c'`, `'pane-q-during-run'`, `'pane-q-at-completion'`, `'external-kill-pane'`, `'external-kill-session'`, `'external-kill-server'`.
  - Each entry maps to a list of `OutcomeMatcher` to evaluate against the snapshot.
  - `pane-q-during-run` carries the new full-teardown spec from §6.5 (the product-shape decision from origin §13).

**Patterns to follow:**
- The pure-projector pattern from existing matchers in `tests/helpers/real-tmux/pane-handle.ts`.
- `RealTmuxService.capturePane` ANSI-stripped vs raw byte access at `tests/helpers/real-tmux/pane-handle.ts` (`right.capture()` vs `right.captureRaw()`).
- `waitFor` polling shape from `tests/helpers/real-tmux/` (no `sleep(N)`).

**Test scenarios:**
- `snapshot(...)` returns a fully populated snapshot when fed `FakeProcessService` + `FakeTmuxService` simulating a live orch + tmux state (no real subprocess needed for the unit test).
- `snapshot.orchAlive === false` when the subprocess handle's `wait()` has resolved.
- `snapshot.tmuxSessionExists === false` when the probe's `hasSession()` returns `false`.
- `snapshot.stdoutAltScreen.enters` counts every `\x1b[?1049h` in the cumulative stdout bytes; `.exits` counts every `\x1b[?1049l`. Verify with a hand-built byte buffer.
- `snapshot.stdoutMouseTracking.ons / offs` count `\x1b[?1000h`/`\x1b[?1003h` and `\x1b[?1000l`/`\x1b[?1003l` correctly.
- `snapshot.perStepFilesIntact === false` when a per-step file is truncated (missing trailing `\n`).
- `snapshot.orphanChildren` is empty when no children remain; non-empty when the test fixture leaves a grandchild process alive (verify with a fixture that spawns a long-lived `sleep`).
- `cleanly()` matches when `orchExit.code === 0` OR when `orchExit.signal` is a documented signal from the §6.5 contract row.
- `cleanly()` does NOT match when `orchExit.code` is an undocumented non-zero (assert message names the actual code).
- `doesNotExist()` against the tmux fields matches only when both `tmuxSessionExists === false` AND `tmuxServerExists === false`.
- `withinMs(5000)` succeeds when the predicate passes at 2000ms (snapshot captured at that moment); fails when the predicate never passes (snapshot captured at the 5000ms boundary).
- `balancedEscapes()` matches when `enters === exits` AND `ons === offs`; fails with both counts in the error message otherwise.
- `noOrphanChildren()` matches when the snapshot's `orphanChildren` is empty.
- `runInvariantContract({ orchAlive: true, ... }, 'signal-sigint')` returns a violation list naming each unsatisfied matcher in the SIGINT row.
- `runInvariantContract({...everything-clean...}, 'signal-sigint')` returns `[]`.
- `runInvariantContract` for `'pane-q-during-run'` evaluates the full-teardown spec (orch exit, tmux gone, status=cancelled, balanced escapes, no orphans), not the legacy "run continues" spec.
- An unknown scenario tag throws (programming-error path).
- `expectInvariantViolation('pane-q-during-run', withinMs(5_000))` PASSES when fed a snapshot showing the contract is violated; FAILS when fed a snapshot satisfying the contract (i.e., the bug was fixed). The failure message explicitly says "violation list became empty — delete the cell."
- `LifecycleSnapshot` includes `capturedAtMs` and `orchAliveDurationMs` fields stamped by `Clock.nowMs()` at capture time so reviewers can sanity-check temporal coherence.

**Verification:** `bun run check` passes. `tests/unit/helpers/behavioral-dsl/snapshot.test.ts` and `invariants.test.ts` pass.

---

### U7. First end-to-end cell — `sigint-to-orch-during-mid-step.real.test.ts` (W3)

**Goal:** Prove the DSL is usable end-to-end with one cell that should PASS today. The expectation is "the SIGINT handler at `src/cli/commands/execute-with-attach.ts:64-74` works as designed: SIGINT triggers `host.teardown()` then exits with `EXIT.SIGINT === 130`." If this cell FAILS, the bug is bigger than we thought and the campaign starts immediately. If it PASSES, the DSL surface is validated by a real round-trip.

**Requirements:** S1, S2 (indirectly — gates whether the headline cell is meaningful), S4. Enables R1, R7.

**Dependencies:** U4 (launcher), U5 (probe), U6 (snapshot + outcome matchers).

**Files:**
- `tests/helpers/behavioral-dsl/user-actions.ts` (modify — add `signalOrch('SIGINT' | 'SIGTERM' | 'SIGHUP')` action)
- `tests/integration/lifecycle/sigint-to-orch-during-mid-step.real.test.ts` (new — predicted PASS)

**Approach:**
- The cell uses `'two-step-linear'` with `script: { plan: holdUntilReleased() }` and `bringToState: { kind: 'mid-step', name: 'plan' }`.
- After confirming `assertWorkflowState(isRunningStep('plan'))`, the cell dispatches `userAction(signalOrch('SIGINT'))`.
- `signalOrch(sig)` is implemented as `handle.subprocess.kill(sig)` (existing `ProcessHandle.kill` at `src/services/process/process-service.ts:24`).
- Assertions: `assertOrchExits(withinMs(5_000), cleanly())`, `assertTmuxSession(doesNotExist())`, `assertWorkflowState(hasStatus('cancelled'))`, `assertTerminalState(balancedEscapes(), noOrphanChildren())`.
- Predicted outcome comment in the test file: `// PREDICTED: PASS — SIGINT handler at execute-with-attach.ts:64-74 is wired.`
- Cell uses `skipIf(!canRunRealTmux())` — no real CLI needed.

**Patterns to follow:**
- `tests/integration/hosts/two-pane/tier-1/*.real.integration.test.ts` for the `describe.skipIf` shape.
- The DSL grammar from origin §2 (matchers passed as positional args to assertions).

**Test scenarios:**
- The cell itself IS the test scenario. There is no nested unit-level scenario list.
- The cell must complete within the 30s suite timeout under normal CI load.

**Execution note:** Implementer should run the cell against a clean checkout of `main` first and capture the actual outcome. If FAIL-BUG, note it in the U7 PR and proceed to U8 / U9 — the campaign's hypothesis is partly confirmed but the §2.1 cell remains the headline.

**Verification:** Cell exits with status 0 (test pass). Snapshot captured at exit shows all matchers green. `bun run check` covers the file under typecheck + lint.

---

### U8. Pane-state matchers + Ink-derived assertions + `clickOnPane(...)` + smoke cell (W3)

**Goal:** Add the pane-content surface (`containsText`, `doesNotContain`, `isFocused`, `isInState`, `hasFooterText`, `hasNoLiveOutput`) and the click-to-focus mouse-event action. Add one smoke cell verifying click-to-focus across the divider. This unit unblocks the §2.1 acceptance test by providing every matcher U9 needs.

**Requirements:** S1, S4. Enables R1.

**Dependencies:** U5 (the mouse-event builder), U6 (snapshot for `leftPaneText` / `leftPaneFocused`).

**Files:**
- `tests/helpers/behavioral-dsl/pane-matchers.ts` (modify — implement `containsText`, `doesNotContain`, `isFocused`, `isInState`, `hasFooterText`, `hasNoLiveOutput`, `isPaneDead`)
- `tests/helpers/behavioral-dsl/workflow-matchers.ts` (modify — implement `isRunningStep`, `hasStatus`, `hasExitCode`, `hasExitedBySignal`)
- `tests/helpers/behavioral-dsl/assertions.ts` (modify — add `assertLeftPane`, `assertRightPane`, `assertWorkflowState`)
- `tests/helpers/behavioral-dsl/user-actions.ts` (modify — add `clickOnPane('left' | 'right')`, `pressKeyInPane(pane, key)`, `typeInAttachTty(bytes)`, `wait(ms)`, `release(stepName)`)
- `tests/integration/lifecycle/click-to-focus-across-divider-smoke.real.test.ts` (new — predicted PASS; the smoke cell)
- `tests/unit/helpers/behavioral-dsl/pane-matchers.test.ts` (new — pure projector tests)

**Approach:**
- `containsText(needle)`: projector matching `snapshot.leftPaneText.includes(needle)` (or regex test). The needle is normalized via the existing `stripAnsi` from `src/observability/index.ts` if the snapshot's `leftPaneText` is the ANSI-stripped form (which it is, mirroring `right.capture()`).
- `isFocused()`: projector matching `snapshot.leftPaneFocused === true` (or `rightPaneFocused === true` when applied to the right pane).
- `isInState('live' | 'viewing' | 'end-of-run' | 'error-banner')` derives from `leftPaneText` content patterns:
  - `'live'`: matches the live banner text from `steps-view.tsx` (e.g., `▶ live`)
  - `'viewing'`: matches the viewing-history footer pattern
  - `'end-of-run'`: matches the end-of-run summary header
  - `'error-banner'`: matches the failure-banner pattern from `error-banner.tsx`
  The exact pattern strings are pulled by reading the rendered text — if `steps-view.tsx` copy changes, the matchers update in lockstep (one source of truth: the implementation, not the test).
- `clickOnPane(pane)`: `probe.sendMouseEvent(pane, undefined, undefined, 'left')` (center coordinates, left button, press + release).
- `pressKeyInPane(pane, key)`: `probe.sendKeys({ socket, target: paneIdFor(pane), keys: [key] })` — server-side, not via the attach-TTY. **Boundary:** server-side `send-keys` may bypass tmux *client-side* key bindings (the appliance-mode bindings in `src/services/tmux/session-init.ts` are server-side, so they fire as expected, but any client-only binding would not). For the §2.1 reproduction this is fine — the `q` handler lives in the Ink steps-view child process, which sees the key regardless of client/server origin. If a future cell needs to exercise client-side bindings specifically, it must use `typeInAttachTty` instead.
- `typeInAttachTty(bytes)`: `handle.subprocess.writeStdin(bytes)` — routes through the attach client, which tmux delivers to the active pane's child.
- `wait(ms)`: explicit, bounded; every delay is visible in the test (per origin §5 — no implicit sleeps).
- `release(stepName)`: `await fs.write(<stateBase>/<stepName>.gate, '')`.
- Smoke cell: launch `'two-step-linear'` with `script: { plan: emit-then-hang }`, `bringToState: { kind: 'mid-step', name: 'plan' }`, click on the right pane, assert `assertRightPane(isFocused())`, click on the left pane, assert `assertLeftPane(isFocused())`. Predicted PASS (click-to-focus is wired by appliance-mode at `src/services/tmux/session-init.ts`).

**Patterns to follow:**
- `tests/helpers/real-tmux/pane-handle.ts` for the ANSI-stripped vs raw text projection style.
- `src/hosts/two-pane/steps-view/steps-view.tsx` for the canonical "live banner" / footer text strings — matchers reference these via imported constants if the file exports them, else by literal copy with a comment pointing back at the source line.

**Test scenarios:**
- `containsText('hello')` projector matches a snapshot whose `leftPaneText === 'hello world'`; doesn't match `'world'`.
- `containsText(/h\w+o/)` projector matches the same.
- `doesNotContain` is the inverse and surfaces the actual offending text in its error message.
- `isFocused()` matches when `leftPaneFocused === true`; doesn't match otherwise.
- `isInState('live')` matches a snapshot whose `leftPaneText` contains the live-banner substring.
- `isRunningStep('plan')` matches when `stepStatuses.plan === 'running'`; doesn't match `'completed'`.
- `hasStatus('cancelled')` matches `stateStatus === 'cancelled'`.
- The smoke cell `click-to-focus-across-divider-smoke.real.test.ts`:
  - Launch with `plan` step held mid-run.
  - Click on right pane → assert `assertRightPane(isFocused())`.
  - Click on left pane → assert `assertLeftPane(isFocused())`.
  - Predicted PASS — proves both the mouse-event builder and the focus matcher work in real round-trip.

**Verification:** `bun run check` passes. Pane matchers unit tests pass. Smoke cell passes when `tmux ≥3.0` is on PATH.

---

### U9. Headline §2.1 acceptance test — fake variant + Codex variant (W4)

**Goal:** Write the two cells that ARE the S2 evidence: `q-during-fake-mid-step.real.test.ts` (deterministic) and `q-during-codex-mid-step.real.test.ts` (env-gated like Tier 4). Both are predicted FAIL-BUG. The captured snapshots are the explicit, durable artifact this plan delivers — they ARE the bug ticket consumed by the next planning round.

**Requirements:** R1, S2 (the load-bearing success criterion). Enables S4.

**Dependencies:** U3 (`two-step-linear` fixture for fake variant; new `codex-riddle-mid-step` fixture for codex variant), U4 (launcher), U5 (mouse-events for `clickOnPane`), U6 (invariant contract), U8 (pane + workflow matchers + `pressKeyInPane`).

**Files:**
- `tests/fixtures/lifecycle/codex-riddle-mid-step.ts` (new — wires the real `CodexRunner` for the held step, mirroring `examples/codex-riddle-solver/index.ts` shape)
- `tests/integration/lifecycle/q-during-fake-mid-step.real.test.ts` (new — predicted FAIL-BUG)
- `tests/integration/lifecycle/q-during-codex-mid-step.real.test.ts` (new — predicted FAIL-BUG, env-gated)

**Approach:**
- **Fake variant.** Uses `'two-step-linear'` with `script: { plan: holdUntilReleased(), execute: instantOk }`, `bringToState: { kind: 'mid-step', name: 'plan' }`. After confirming the pane state and workflow state, the cell:
  1. `userAction(clickOnPane('left'))`
  2. `assertLeftPane(isFocused())`
  3. `userAction(pressKeyInPane('left', 'q'))`
  4. Use `await expectInvariantViolation('pane-q-during-run', withinMs(5_000))` — this assertion PASSES when the captured snapshot violates the §6.5 contract row for `pane-q-during-run` (orchAlive, tmuxSessionExists, stateStatus='running'), and FAILS if the violation list ever becomes empty (i.e., the bug got fixed, in which case U9 must be deleted, not edited). This is the programmatic R-D defense.
  - Skip predicate: `!canRunRealTmux()`. Default CI runs it.
  - Predicted-outcome comment inline: `// PREDICTED ON FIRST RUN: PASS (because expectInvariantViolation passes WHEN orch is broken). Failing this assertion means orch was fixed — delete this cell.`
- **Codex variant.** Uses the new `codex-riddle-mid-step` fixture that exposes a single interactive Codex step solving a riddle. `bringToState: { kind: 'mid-step', name: 'solve-riddle' }`. The fixture wires the real `CodexRunner` (no `ScriptedFakeRunner`). The cell:
  1. Sanity probe: `assertRightPane(containsText(/codex|gpt-5\.5|MCP servers/i))` — proves real Codex is loading.
  2. `userAction(clickOnPane('left'))` → `assertLeftPane(isFocused())` → `userAction(pressKeyInPane('left', 'q'))`.
  3. Same programmatic `expectInvariantViolation('pane-q-during-run', withinMs(5_000))` assertion as the fake variant.
  - Skip predicate: `!canRunRealTmuxE2E('codex')` — requires `tmux` on PATH, `codex` on PATH, AND `RUN_REAL_TMUX_E2E=1`.
  - Predicted-outcome comment inline: `// PREDICTED ON FIRST RUN: PASS (expectInvariantViolation passes WHEN orch is broken). Matches origin §2.1 user screenshot. Failing this assertion means orch was fixed — delete this cell.`
- **The snapshot at failure is the deliverable.** When `withinMs(5000)` expires, the assertion captures and emits the final `LifecycleSnapshot`. That snapshot — printed in the test output and persisted to a per-cell artifact file at `tests/integration/lifecycle/__snapshots__/<cell>.last.json` (written by the assertion on failure) — is what the next planning round consumes.

**Patterns to follow:**
- `examples/codex-riddle-solver/index.ts` for the Codex fixture shape.
- Tier 4's `skipIf(!canRunRealTmuxE2E('codex'))` predicate from `tests/helpers/real-tmux/index.ts`.

**Test scenarios:**
- Each cell IS the test scenario. There is no nested unit-level scenario list. The cells are unique in this plan in that **first-run failure is the success criterion** — see Verification.

**Verification:**
- `q-during-fake-mid-step.real.test.ts` **passes via `expectInvariantViolation`** — the captured `LifecycleSnapshot` shows the contract violation (`orchAlive: true`, `tmuxSessionExists: true`, `stateStatus: 'running'` per origin §2.1 expected-result) and the violation list is non-empty.
- `q-during-codex-mid-step.real.test.ts` (under `RUN_REAL_TMUX_E2E=1` with `codex` on PATH) passes the same way.
- The snapshot artifacts are committed under `tests/integration/lifecycle/__snapshots__/` and are referenced by the U11 findings roll-up.
- This unit is "complete" when both files exist, run end-to-end, and pass via the inverted assertion. The PR description must include the captured fake-variant snapshot inline so reviewers can see the evidence without running the test.
- **Failure of either cell** (i.e., violation list becomes empty) means orch was fixed and the cells should be deleted by the contributor who shipped the fix — NOT edited to invert the assertion or marked `it.skip`. The cell's inline comment names this convention.

---

### U10. Ctrl-C and signal cells (W4)

**Goal:** Cover the remaining symptom classes the user reported (origin §2 S4): Ctrl-C-in-attached-TTY (single + double + triple, the "no matter how many" anchor), SIGTERM, SIGHUP, and stdin-EOF. All target the mid-step workflow state initially. Predicted outcomes are mixed — that mix IS the campaign learning.

**Requirements:** S4. Enables R1.

**Dependencies:** U7's `signalOrch` action, U8's `typeInAttachTty` action and pane matchers, U6's invariant contract.

**Critical scope correction discovered during planning review:** Origin §5 includes a `closeTerminal()` DSL action billed as "equivalent to controlling-tty hangup." Verification: `Bun.spawn` with `stdin: 'pipe'` does NOT give the child a controlling TTY — closing the piped stdin delivers stdin-EOF, not SIGHUP. The orch signal handler at `src/cli/commands/execute-with-attach.ts:78` only fires on real SIGHUP, which a piped-stdin child will never receive. Adding pty support to `ProcessService` would balloon U2's scope. **Decision: `closeTerminal()` is renamed to `closeStdin()` and tested as a stdin-EOF input with its own contract row; the original "terminal hangup" scenario is covered by `signalOrch('SIGHUP')` directly, which IS what a real terminal close delivers.** The §6.5 contract row mapping `closeTerminal() → same as SIGHUP` is replaced by two rows: `closeStdin()` (a new, weaker invariant — orch may continue running or may not, contract documents observed behavior) and `signalOrch('SIGHUP')` (the existing strong row). The U6 invariant table edit is folded into the U10 PR.

**Files:**
- `tests/helpers/behavioral-dsl/user-actions.ts` (modify — add `closeStdin()` action, implemented as `handle.subprocess.stdin?.end()`; document the stdin-EOF semantics in the JSDoc)
- `tests/helpers/behavioral-dsl/internal/invariants.ts` (modify — split the `closeTerminal()` contract row into `closeStdin` + `signal-sighup`; the latter already exists)
- `tests/integration/lifecycle/ctrl-c-once-in-attached-during-mid-step.real.test.ts` (new — predicted FAIL-BUG)
- `tests/integration/lifecycle/ctrl-c-twice-in-attached-during-mid-step.real.test.ts` (new — predicted FAIL-BUG, the user's reported reproduction)
- `tests/integration/lifecycle/ctrl-c-thrice-in-attached-during-mid-step.real.test.ts` (new — predicted FAIL-BUG, defensive anchor)
- `tests/integration/lifecycle/sigterm-to-orch-during-mid-step.real.test.ts` (new — predicted PASS or FAIL-BUG)
- `tests/integration/lifecycle/sighup-to-orch-during-mid-step.real.test.ts` (new — predicted PASS or FAIL-BUG; this is the test that covers the "closed the terminal" user-reported recovery path)
- `tests/integration/lifecycle/close-stdin-during-mid-step.real.test.ts` (new — predicted unknown; documents what stdin-EOF actually does)
- `tests/integration/lifecycle/double-sigint-to-orch-during-mid-step.real.test.ts` (new — the double-Ctrl-C-while-handling path, predicted FAIL-BUG)

**Approach:**
- Each cell follows the U9 shape but swaps the user-action gesture.
- Predicted-outcome inline comments on every cell. The orchestrator agent in U11 consumes those predictions as the campaign baseline.
- Cells that turn out to be `PASS` get archived into the campaign findings as confirmed-OK contract rows; FAIL-BUG cells become input to the downstream bug-fix planning round.
- All cells use `skipIf(!canRunRealTmux())` — `ScriptedFakeRunner` driving, no real CLI needed for these classes.

**Patterns to follow:**
- U9's cell structure.
- Origin §6.5 contract rows for the per-cell expected snapshot pattern.

**Test scenarios:**
- Each cell IS the test scenario. The unit's test surface IS the directory listing in `tests/integration/lifecycle/` — the campaign report's triage column.

**Verification:** Every cell runs to completion (no harness crash). The PR captures the outcome of each cell (PASS / FAIL-BUG) in the description, mapped to the §6.5 contract row.

---

### U11. Findings roll-up doc for the U7–U10 cells (W4)

**Goal:** Produce `docs/findings/2026-05-20-lifecycle-campaign-findings.md` rolling up the actual outcomes (PASS / FAIL-BUG / etc.) of the human-authored cells from U7, U9, and U10, plus the U8 click-to-focus smoke result. This unit is the writeup, not a sub-agent dispatch — that dispatch is a separate follow-up activity using the tooling delivered here. Origin §11 step 9 ("The exploratory campaign runs") is reframed as the follow-up because a campaign sub-agent dispatch is an activity, not a PR-shaped implementation unit.

**Requirements:** S2 (formalizes the evidence captured by U9), S4 (rolls up cross-symptom coverage). Enables R1 closure as documented evidence.

**Dependencies:** U7–U10 (the cells whose outcomes are summarized).

**Files:**
- `docs/findings/2026-05-20-lifecycle-campaign-findings.md` (new)
- `tests/integration/lifecycle/__snapshots__/` (new directory holding the committed snapshot artifacts for FAIL-BUG cells)

**Approach:**
- Run every cell from U7, U8 (smoke), U9, U10. Capture the actual outcome (PASS / FAIL-BUG / FAIL-EXPECTATION / FAIL-HARNESS / FAIL-DSL).
- Commit the FAIL-BUG snapshot artifacts under `tests/integration/lifecycle/__snapshots__/` (gitignored for ephemeral PASS cells; committed for the §2.1 cells and any other FAIL-BUG).
- Author the findings doc with:
  - **Executive summary** — one paragraph naming the headline FAIL-BUG findings (§2.1 fake + codex variants at minimum) and the bug class hypothesis from origin §1 with its falsification status.
  - **Per-triage-class sections** — `## PASS`, `## FAIL-BUG`, `## FAIL-EXPECTATION`, `## FAIL-HARNESS`, `## FAIL-DSL`. Each section lists every applicable cell with a one-line outcome + a link to the cell file and (for FAIL-BUG) the committed snapshot.
  - **Contract revisions** — if any cell triaged as FAIL-EXPECTATION, propose the §6.5 contract edit (folded back into U6's `invariants.ts` as a follow-up).
  - **DSL gaps** — if any sub-agent in a future campaign run finds a cell that can't be expressed in the DSL, the gap is filed here as future work.
  - **Next planning round inputs** — the explicit handoff: "the next planning round consumes this doc + the committed snapshots."

**Patterns to follow:**
- `docs/handovers/` style for layout and tone.
- The triage taxonomy from origin §9 — preserved verbatim.

**Test scenarios:** Test expectation: none — this unit's deliverable is the findings doc + the committed snapshot artifacts, not assertions about content. The doc itself is the evidence.

**Verification:**
- `docs/findings/2026-05-20-lifecycle-campaign-findings.md` exists and is reviewed.
- ≥1 FAIL-BUG snapshot is committed under `tests/integration/lifecycle/__snapshots__/` (S2 evidence; guaranteed by U9).
- The doc names all three symptom classes the user reported (Ctrl-C-in-attached, signal-to-orch, `q`-during-run) with at least one cell each (S4).
- Sub-agent orchestrated campaign for additional cells (the original origin §11 step 9 reading) is explicitly noted as **a follow-up activity**, not part of this plan.

---

## Risk Analysis & Mitigation

**R-A. Subprocess test runtime cost.** Each cell boots an orch process + tmux server (~3–5s per cell per origin §10 R2). The first-batch ~20 cells = 1–2 minutes wall-clock; full 84-cell matrix = 5–10 minutes. **Mitigation:** Cells in `tests/integration/lifecycle/` are NOT in the default `bun run check` path — they live under `tests/integration/` and are run by `bun test tests/integration/lifecycle/` (separate command). Add a CI job that runs them on PRs touching `src/cli/main.ts`, `src/hosts/two-pane/**`, or `tests/helpers/behavioral-dsl/**`, but keep them off the pre-commit / pre-push gate.

**R-B. Flake from polling-based readiness gates.** Per origin §10 R3, every `waitFor` must have an explicit timeout and never use `sleep(N)`. **Mitigation:** U4's launcher exposes `bringToState` timeouts as explicit handle-level options (default 15s, override per cell). U6's matchers use the existing `waitFor` shape from `tests/helpers/real-tmux/`. Code review checks every poll for an explicit timeout.

**R-C. Orphan-process detection on macOS.** `pgrep -P <pid>` only finds direct children per origin §10 R1. **Mitigation:** U6's `orphanChildren` sweep is recursive: it BFS-walks the process tree from `orchPid`, calling `pgrep -P` repeatedly until the frontier is empty. Document the macOS-vs-Linux difference inline in `snapshot.ts`. Add a unit test that simulates a grandchild via a fixture process spawning a long-lived `sleep` and verifies the grandchild is found.

**R-D. The §2.1 acceptance test's "first-run failure is success" semantics are easy to misread.** A future contributor seeing a failing test may "fix" it by making it pass against the broken behavior — defeating the purpose. **Mitigation:** Four lines of defense: (1) explicit predicted-outcome inline comment in U9's test files; (2) the test's failure-output snapshot path printed to stderr; (3) a CONTRIBUTING note in `tests/helpers/behavioral-dsl/README.md` warning that tier-5 cells under `__snapshots__/` are bug evidence, not regression baselines; **(4) a programmatic guard `expectInvariantViolation(scenario)` that PASSES when the snapshot's violation list is non-empty and FAILS when it becomes empty.** The §2.1 cells use `expectInvariantViolation` instead of `assertAllInvariants` so "fixing the bug" forces the contributor to DELETE the assertion (a reviewable change) rather than INVERT it (which can slip through). U9 adds `expectInvariantViolation` to `assertions.ts` and uses it for both fake and codex variants; U10 cells with predicted-FAIL-BUG outcomes optionally adopt it too.

**R-E. DSL surface drift — sub-agents (campaign U11) extending the DSL inline.** Per origin §10 R4, the campaign may surface DSL gaps faster than orch bugs. If sub-agents add matchers inline in test files, the seam between DSL and tests collapses. **Mitigation:** The triage taxonomy explicitly carves out `FAIL-DSL`: a missing matcher = file a finding, skip the cell. The orchestrator catches uncategorized failures as its own error. The sub-agent prompt template names this rule.

**R-F. Tmux mouse-event injection works differently on tmux 3.0 vs 3.4+.** SGR encoding details may differ across patch versions. **Mitigation:** U5's `buildSgrMouse` and the launcher's `meetsMinimumTmuxVersion('3.0')` probe are the boundary. If the smoke cell in U8 (`click-to-focus-across-divider-smoke.real.test.ts`) fails on a CI tmux version, that is the early-warning signal — the cell sits at the minimum tier of harness functionality.

**R-G. `ScriptedFakeRunner` not registered in the host registry.** Production builds don't need it, but the test orch subprocess must be able to look it up by name. **Mitigation:** The fixture workflows under `tests/fixtures/lifecycle/` use their own `orch.config.ts` (or equivalent fixture config) that registers `ScriptedFakeRunner`. The launcher's `cwd` is the fixture directory, so `loadConfig(...)` picks up the fixture-local config. Document the fixture-config convention in U3's PR.

**R-H. Two-phase state visibility on filesystem-backed `state.json`.** Polling for `state.json` to reach a target status may see a half-written file (writer mid-rewrite). **Mitigation:** Use `FsService.readFile` + Zod parse with retry on parse failure (treat parse failure as "not yet ready, continue polling"). The pattern matches U6's Codex capture's "partial reads are not ready yet" decision from the history-step-resume plan (`docs/plans/2026-05-13-001-feat-history-step-resume-plan.md`).

---

## Alternative Approaches Considered

- **Reuse the existing Tier 1 harness with a child-process shim instead of new infrastructure.** Rejected: Tier 1's `mountTmuxHost(...)` composes `createTmuxHost(...)` against in-process services. Reaching the CLI entry point requires actually running `bun src/cli/main.ts`, which is a different process — there is no extension to Tier 1 that gets there. The two harnesses are sibling layers, not parent-child.

- **Drive orch via an expect-style pseudo-terminal library (e.g., `node-pty`) instead of `BunProcessService.spawn` + raw streams.** Rejected: CLAUDE.md rule #1 prohibits `node-pty` outside `src/services/process/`. A pty WOULD enable true controlling-TTY semantics (real SIGHUP from terminal close), but planning-time review confirmed that orch's signal handlers do NOT treat piped-stdin-EOF as SIGHUP-equivalent — the harness loses that one input vector. The plan accepts the loss: `closeStdin()` becomes its own (weaker) DSL action, and the "user closed the terminal" reproduction is covered by `signalOrch('SIGHUP')` which delivers exactly what a real terminal close delivers. Adding pty support to `ProcessService` is deferred.

- **Test-only subprocess wrapper inside `tests/helpers/behavioral-dsl/internal/` that calls `Bun.spawn` directly for raw stdio, using `BunProcessService` only for argv/env composition.** Considered: keeps three production files (`process-service.ts`, `bun-process-service.ts`, `fake-process-service.ts`) unmodified. Rejected for this plan because CLAUDE.md rule #1 reads "all subprocess calls go through ProcessService" without a test-vs-production carve-out, and the plan keeps the rule maximally honored. Future revisit point: if the rawStreams extension ever becomes onerous (e.g., a third consumer needs different stdio shape), the test-only wrapper alternative is reopened.

- **One file with the entire 84-cell matrix as `test.each(...)`.** Rejected: origin §7 explicitly chooses one-cell-per-file because "the agent's triage report is literally the directory listing with pass/fail beside each filename." A `test.each` table collapses the triage signal — you'd see a wall of pass/fail flags inside one file rather than a glanceable directory. The per-file cost is filename redundancy; the per-file benefit is artifact discoverability for both humans and the campaign orchestrator.

- **Centralized contract assertions only (no per-matcher composition).** Rejected: the per-matcher style from origin §2 (`assertLeftPane(isFocused(), containsText('▶ live'))`) reads like a user story; a single `assertAllInvariants(scenarioTag)` per cell would read like a Boolean. Both surfaces ship — composable matchers are the default; `assertAllInvariants` is the escape hatch for bulk contract assertions (origin §5).

- **Block cancellation at the tmux layer instead of asserting clean teardown.** Rejected as the implementation direction for v1 — but kept as a viable downstream MITIGATION (origin §3 non-goal: "Choosing whether to 'block cancellation at the tmux layer' or 'make every teardown clean.' That decision is downstream of evidence the campaign produces"). The §6.5 contract assumes clean-teardown semantics; if the campaign's evidence later argues for blocking instead, the contract gets edited, not the plan.

- **Build the DSL on top of a fluent-chain API (`orch.left.assert(containsText('x')).isFocused()`).** Rejected: origin §13 records the agreement that the DSL style is "flat matchers/actions (e.g. `assertRightPane(containsText('x'), isFocused())`)." Fluent chains constrain composition order, hide which matcher caused a failure, and require library-style design effort. Flat predicates are smaller, easier to add, and read like a sentence at the call site.

---

## Dependencies / Prerequisites

- **Tmux ≥3.0 on PATH.** Required for mouse-event injection via `send-keys -M` (origin §10 Q3). Asserted at launcher boot via `meetsMinimumTmuxVersion('3.0')` from `src/cli/detect-tmux.ts`. CI environments without tmux ≥3.0 skip all Tier 5 cells.
- **`codex` CLI on PATH + `RUN_REAL_TMUX_E2E=1`** for the §2.1 codex variant. Default-CI run skips it (per existing Tier 4 gating convention).
- **Bun ≥1.0** for `Bun.spawn` with piped stdin (the rawStreams extension).
- **`pgrep` on PATH** for orphan-children sweep on macOS / Linux. Document the BSD-vs-GNU flag differences in U6's `snapshot.ts` if any surface.
- No new package dependencies. No new MCP servers. No external services.

---

## Operational Notes

- **CI integration:** Tier 5 cells are NOT part of `bun run check` (the pre-commit gate). They run via `bun test tests/integration/lifecycle/`. Add a dedicated CI job triggered on PRs touching the listed paths (Risk R-A); keep the job time-budgeted at ≤10 minutes for the first-batch sweep.
- **Snapshot artifact retention:** `tests/integration/lifecycle/__snapshots__/*.last.json` files written by failing assertions are committed to git for the §2.1 cells (the headline evidence) and gitignored for ephemeral cells. The convention is: snapshots referenced by `docs/findings/` are committed; everything else is ephemeral.
- **Local dev:** Running `bun test tests/integration/lifecycle/` interleaves real tmux servers — make sure no other `tmux -L orch-*` socket is in use. The launcher uses runId-derived sockets so collisions across cells are impossible, but a stuck local tmux server from a prior crashed run can interfere; the launcher logs the socket on spawn so cleanup is obvious.

---

## Open Questions / Deferred Items

- **Q1 [planning-resolved].** `BunProcessService.spawn` accepts piped stdio + signal delivery (verified: Bun's `subprocess` exposes `.stdin` writable + `.kill(signal)`). The harness extension at U2 is the required wrapping.
- **Q2 [implementation-time].** The exact poll interval / timeout for the `bringToState` readiness gate. Plan defaults: 50ms poll interval, 15s timeout, both overridable per cell. Final tuning happens in U4 after empirical observation.
- **Q3 [planning-resolved].** Tmux ≥3.0 is the minimum (`send-keys -M` supports SGR-encoded sequences). U5's `meetsMinimumTmuxVersion('3.0')` is the runtime check.
- **Q4 [planning-resolved].** `tmux list-panes -F '#{pane_dead}'` exposes pane-dead state. `isPaneDead()` is the matcher; included in U8 (carried forward from R5's snapshot field).
- **Q5 [planning-resolved].** Launcher hard-defaults to `mode: 'two-pane'`. The DSL type signature only accepts that value for v1.
- **Implementation-time TBD:** Exact behavior of `closeTerminal()` on macOS vs Linux when orch's stdin is closed without a pty (does Bun deliver SIGHUP, or just stdin-EOF?). U10's `close-terminal-during-mid-step.real.test.ts` is the empirical surface — the cell will reveal which signal actually fires, and the §6.5 contract row may need a per-platform note.
- **Implementation-time TBD:** Whether `ScriptedFakeRunner` needs to ship a separate fixture `orch.config.ts` or can register via the existing `tests/fixtures/` config-loading path. Resolved in U3's PR after probing the config-loader behavior.
- **Deferred to follow-up PRs (NOT in this plan):**
  - Fixing the bugs the campaign finds. Separate planning round, after triage. Origin §3 non-goal.
  - `q` semantics change in `src/hosts/two-pane/steps-view/steps-view.tsx:325` and the detach hint at `src/cli/commands/execute-with-attach.ts:106`. The contract carries the new spec; the code change is downstream. Origin §13 explicit out-of-scope.
  - Footer copy and CLI detach messaging cleanup tied to the `q` semantics change.
  - Plain-mode lifecycle suite (`--mode=plain`).
  - Real-CLI Claude variants (`q-during-claude-mid-step.real.test.ts` etc.) — the codex variant is the headline; Claude variants are Tier-4-equivalent follow-ups.

---

## Scope Boundaries

### In scope

- The Tier 5 infrastructure (DSL, harness, `ScriptedFakeRunner`, `ProcessService` rawStreams extension, `TmuxService` probe extensions).
- The U9 §2.1 acceptance test in both fake and codex variants — uses `expectInvariantViolation` so the cells PASS while the bug exists; **the captured snapshot is the durable bug evidence**. A contributor shipping the orch-side fix must DELETE these cells (not edit them to pass), keeping the snapshot artifact under `__snapshots__/` as the historical bug ticket.
- The U10 signal / Ctrl-C / stdin-EOF cells.
- The U11 findings roll-up doc + committed FAIL-BUG snapshot artifacts.
- The `docs/testing-strategy.md` Tier 5 documentation row + section.
- **The product-shape decision that `q` during a running step should cancel everything (orch exits, agents killed, tmux torn down, status=cancelled)** — encoded in the §6.5 invariant contract and enforced by U9's assertions. The DECISION is in scope; the IMPLEMENTATION (the code change that would make the system pass U9) is not.

### Deferred to Follow-Up Work

- **The code change that makes U9 pass.** The §6.5 `q`-row implementation in `src/hosts/two-pane/steps-view/steps-view.tsx:325` and the footer-copy / detach-hint cleanup at `src/cli/commands/execute-with-attach.ts:106`. Downstream of the §2.1 snapshot — the next planning round consumes that snapshot as its input.
- **The sub-agent orchestrated campaign sweep** that origin §11 step 9 envisioned. This plan delivers the tooling and the human-authored headline cells; a dedicated campaign run (orchestrator + parallel sub-agents producing additional cells across the full §7 matrix) is a follow-up activity using the tooling delivered here.
- A dedicated CI job that runs `tests/integration/lifecycle/` on PRs touching the relevant paths (mentioned in Operational Notes; implementation = a separate CI-config PR).
- An ESLint rule that forbids `tests/integration/lifecycle/*` files from importing `tests/helpers/behavioral-dsl/internal/*` (mentioned in System-Wide Impact; doc-only ban is sufficient for v1).
- Real-CLI Claude variants of the headline cell.
- Pty-backed `closeTerminal()` that would deliver real SIGHUP. The current plan uses `signalOrch('SIGHUP')` for that input (which IS what a real terminal close delivers) and demotes the prior `closeTerminal()` to a renamed, weaker `closeStdin()`. Adding pty support to `ProcessService` is a separate decision with broader implications.

### Outside this product's identity

- Plain-mode lifecycle (`--mode=plain`). Origin §3 explicit non-goal. Two-pane is the user-reported bug surface; plain mode is a separate suite owned by future work.
- Bug fixes for any FAIL-BUG findings. Origin §3 explicit non-goal — the campaign produces evidence; fixes belong to the next planning round.
- Replacing or merging Tiers 1 / 2 / 3 / 4 with Tier 5. Origin §3 explicit non-goal — Tier 5 is additive.
- Pre-deciding whether other inputs (beyond `q`) should be rejected vs. handled cleanly. Origin §13 explicit out-of-scope — every other matrix cell remains open until the campaign's evidence lands.

---

## References

Origin document: `docs/brainstorms/2026-05-20-feat-two-pane-behavioral-test-dsl-brainstorm.md`.

Code touchpoints (from origin §12 + verification reads):

- `src/cli/main.ts` — entry point; `EXIT` codes at `:42-50`.
- `src/cli/commands/run.ts:104` — runId-emitting stderr log line we parse in U4.
- `src/cli/commands/execute-with-attach.ts:64-78` — the SIGINT/SIGTERM/SIGHUP handlers we exercise in U7 / U10.
- `src/cli/commands/execute-with-attach.ts:106` — detach hint (out-of-scope edit).
- `src/hosts/two-pane/tmux-host.ts:83` — `pane-died` hook (the §1 hypothesis surface).
- `src/hosts/two-pane/tmux-host.ts:345-451` — quit-intent wiring (`q` intent + `quitDeferred`).
- `src/hosts/two-pane/tmux-host.ts:480-530` — `awaitForegroundShutdown` race.
- `src/hosts/two-pane/tmux-host.ts:900-970` — teardown sequence.
- `src/hosts/two-pane/steps-view/steps-view.tsx:325` — current `"q quit (run continues)"` footer copy (out-of-scope edit).
- `src/services/process/process-service.ts:3-41` — the `SpawnOptions` / `SpawnHandle` shape U2 extends.
- `src/services/process/bun-process-service.ts` — `BunProcessService` implementation U2 extends.
- `src/services/tmux/tmux-service.ts:382-432` — `TmuxService` interface U5 extends.
- `src/services/tmux/real-tmux-service.ts:185, 294, 321, 341` — existing `sendKeys`, `killSession`, `capturePane`, `listPanes`.
- `src/services/tmux/session-init.ts` — appliance-mode lockdown (background context for U8's click-to-focus expectation).
- `src/runners/types.ts:189-243` — `defineRunner` Zod schema U3 validates against.
- `src/runners/fake/fake-runner.ts` — sibling reference for `ScriptedFakeRunner` (U3).
- `src/runners/_shared/merge-env.ts` — env-passthrough composition U4 uses.
- `tests/helpers/real-tmux/` — Tier 1 / 4 harness — reuse the `RealTmuxService` construction patterns; do NOT reuse the in-process host mounting.
- `docs/testing-strategy.md` — U1 extends.
- `docs/plans/2026-04-27-feat-env-passthrough-plan.md` — env-passthrough policy U4 honors.
- `docs/plans/2026-05-13-001-feat-history-step-resume-plan.md` — partial-read polling pattern U6's `bringToState` reuses.
- `examples/codex-riddle-solver/index.ts` — Codex fixture shape U9's variant mirrors.
