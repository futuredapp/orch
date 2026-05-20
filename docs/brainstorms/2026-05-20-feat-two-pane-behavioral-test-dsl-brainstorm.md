# Two-pane behavioral test DSL + exploratory lifecycle campaign

Date: 2026-05-20
Status: brainstorm — input for downstream `/ce-plan`
Author: brainstorm session (user + agent)

---

## 1. Problem

The user has hit a recurring class of bugs while running orch in `--mode=two-pane`. The reports are anecdotal and not fully reproducible:

- Pressing Ctrl-C "maybe twice" causes a pane to show "[Pane is dead]".
- Sometimes the main pane is killed and the user cannot exit the application.
- Pressing `q` while a workflow is running sometimes leaves the user stuck in the TUI with no working escape.

The only confirmed recovery so far: **closing the terminal window** (which sends SIGHUP). Neither Ctrl-C nor `q` got the user out.

### Why no existing test catches this

`tests/helpers/real-tmux/` mounts `TmuxHost` **in-process**. The CLI entry point (`src/cli/main.ts`) and its signal handlers (`src/cli/commands/execute-with-attach.ts:64–78`) are never reached. None of:

- SIGINT / SIGTERM / SIGHUP delivered to the orch process
- Ctrl-C typed inside the attached tmux client (routed by tmux to the active pane's child)
- External `tmux kill-pane` / `kill-session` / `kill-server`
- Terminal hangup

…can be exercised at Tier 1 today. The test layer is wrong for the bug class.

### Working hypothesis (to be falsified by the campaign, not assumed)

The user's Ctrl-C went to the **pane's foreground process** (the Ink steps view or the right-pane child), not to the orch process. That pane child died → tmux showed "[Pane is dead]" → orch never noticed because `pane-died` isn't escalated into `host.teardown()`. The CLI sat wedged on `await trackedWorkflow`. `q` resolved `quitDeferred` but the workflow promise didn't complete, so the CLI never exited. Closing the terminal sent SIGHUP to orch directly, which did route through teardown.

If true, the three symptoms are one bug class: **pane-process death and/or in-pane keypresses are not escalated into a host-level teardown signal.**

The campaign's job is to falsify or confirm this, mechanically.

---

## 2. Goal

Build **behavioral testing tooling for the two-pane host** that lets a test author write tests that read like a user story:

```ts
const orch = await launchOrchWorkflow('two-step-linear', { script: { plan: holdUntilReleased() } })

await assertLeftPane(isFocused(), containsText('▶ live'))
await assertWorkflowState(isRunningStep('plan'))

await userAction(typeInAttachTty('\x03'))     // first Ctrl-C
await userAction(typeInAttachTty('\x03'))     // second Ctrl-C

await assertOrchExits(withinMs(5_000), cleanly())
await assertTmuxSession(doesNotExist())
await assertTerminalState(noResidualAltScreen(), noResidualMouseTracking())
```

The deliverable is **the tooling**. The lifecycle bug campaign is **Consumer #1** — the first body of tests written against the DSL, whose purpose is to find at least one failing test as proof that the methodology works.

### Success criteria

S1. A test author can write a behavioral two-pane test in the DSL without touching `Bun.spawn`, `RealTmuxService`, or `ProcessService` directly.

S2. The first lifecycle campaign sweep produces **≥1 cell that fails with a captured snapshot demonstrating an invariant violation** — enough evidence to file a bug ticket without further reproduction work.

S3. When a cell cannot be expressed in the DSL, the DSL gap is filed as a finding (testing-strategy improvement), not silently skipped.

S4. The DSL covers ≥3 of the symptom classes the user reported (Ctrl-C-in-attached, signal-to-orch, external pane kill).

### 2.1 End-criterion acceptance test (concrete reproduction)

The campaign is considered successful **once this exact behavioral test exists, runs, and fails today with a captured snapshot proving the invariant violation**. This is the headline cell — every other cell is supporting evidence.

**Reproduction recipe (what the user observed):**

1. Launch `examples/codex-riddle-solver/index.ts` in `--mode=two-pane`.
2. Wait until the right pane shows codex actively running (MCP servers loading / prompt visible).
3. Focus the left pane.
4. Press `q`.
5. Observed: left pane shows `[Pane is dead (status 0)]`; right pane shows codex *still running*; tmux session still alive; orch process wedged on `await trackedWorkflow`.
6. User expectation: orch process exits, codex subprocess is killed, tmux session torn down, state-store status = `cancelled`.

**Expressed in the DSL (this test must exist as `tests/integration/lifecycle/q-during-codex-mid-step.real.test.ts`):**

```ts
describe.skipIf(!canRunRealTmuxE2E('codex'))('lifecycle — q during running codex step', () => {
  it('cancels the workflow and tears down everything', async () => {
    const orch = await launchOrchWorkflow('codex-riddle-mid-step', {
      script: { 'solve-riddle': holdUntilReleased() },   // codex is held mid-step
      bringToState: { kind: 'mid-step', name: 'solve-riddle' },
      mode: 'two-pane',
    })

    // Sanity: codex is actually running in the right pane before we press q.
    await assertRightPane(containsText(/codex|gpt-5\.5|MCP servers/i))
    await assertWorkflowState(isRunningStep('solve-riddle'))

    // The exact gesture from the screenshot.
    await userAction(clickOnPane('left'))
    await assertLeftPane(isFocused())
    await userAction(pressKeyInPane('left', 'q'))

    // The invariant the user reported being violated.
    await assertOrchExits(withinMs(5_000), cleanly())
    await assertTmuxSession(doesNotExist())
    await assertWorkflowState(hasStatus('cancelled'))
    await assertTerminalState(balancedEscapes(), noOrphanChildren())
  }, 30_000)
})
```

**Expected result on first run: FAIL-BUG.** The captured snapshot will show `orchAlive: true`, `tmuxSessionExists: true`, `stateStatus: 'running'` after the 5-second timeout — matching the screenshot the user provided. That snapshot IS the bug ticket.

**Implications for the rest of the doc:**
- The `q` row in the invariant contract (§6.5) is updated to require full teardown, not the current "run continues" spec.
- The fixture `codex-riddle-mid-step` is added to `tests/fixtures/lifecycle/` and wires the *real* codex runner for the held step (Tier-5-with-real-CLI, mirroring the Tier 4 promotion pattern). For the same scenario with `ScriptedFakeRunner` (no real-CLI dependency), a parallel cell `q-during-fake-mid-step.real.test.ts` covers the host/CLI seam in deterministic CI.
- The implementation order in §11 step 6 is **this** test, not the Ctrl-C-twice test. The Ctrl-C test remains as a follow-up cell.

---

## 3. Non-goals

- Fixing the bugs the campaign finds (separate planning round, after triage).
- Plain-mode lifecycle (`--mode=plain`). Own suite later; user's reported bugs are all two-pane.
- Real-CLI lifecycle (substituting `ClaudeRunner`/`CodexRunner` for `ScriptedFakeRunner`). Tier 4-equivalent follow-up; do not block this campaign.
- Choosing whether to "block cancellation at the tmux layer" or "make every teardown clean." That decision is downstream of evidence the campaign produces.
- Replacing or merging with Tier 1 / Tier 2 / Tier 4. This is **Tier 5** — additive.

---

## 4. Two-layer architecture

### Layer A — DSL (public surface)

What test authors import. Flat exports: every matcher and action is a tiny pure function. No fluent chains.

```
tests/helpers/behavioral-dsl/
  index.ts                              # barrel — only thing tests import
  launch.ts                             # launchOrchWorkflow + holdUntilReleased
  user-actions.ts                       # userAction + the action constructors
  pane-matchers.ts                      # containsText, isFocused, isInState, hasNoLiveOutput, ...
  workflow-matchers.ts                  # isRunningStep, hasStatus, hasExitCode, ...
  outcome-matchers.ts                   # withinMs, cleanly, doesNotExist, balancedEscapes, ...
  assertions.ts                         # assertLeftPane, assertRightPane, assertWorkflowState, ...
```

Test files live at `tests/integration/lifecycle/<scenario>.real.test.ts` and import only from `tests/helpers/behavioral-dsl/index.ts`.

### Layer B — Harness (private engine)

What the DSL is implemented on top of. Tests do NOT import from here directly.

```
tests/helpers/behavioral-dsl/internal/
  lifecycle-handle.ts                   # the OrchHandle type + startLifecycleScenario
  subprocess.ts                         # spawn orch via BunProcessService, parse runId from stderr
  scripted-fake-runner.ts               # the file-driven runner (lives under src/runners/scripted-fake/)
  external-tmux-probe.ts                # RealTmuxService against the parsed socket, kill-*, send-keys
  mouse-events.ts                       # tmux mouse byte sequences for clickOnPane(...)
  snapshot.ts                           # LifecycleSnapshot capture (process, tmux, state, escapes, orphans)
  invariants.ts                         # the contract used by assertOrch* / assertTmux* / assertTerminalState
  workflow-fixtures.ts                  # paths to tests/fixtures/lifecycle/*.ts workflows
```

The DSL is responsible for **readability**. The harness is responsible for **mechanism**. Keep the seam clean — if a DSL verb needs new mechanism, the harness extension is filed as harness work, not folded into a test.

---

## 5. DSL surface (what the test author touches)

### Actions

```ts
// User inputs the matrix exercises
userAction(typeInAttachTty(bytes: string))            // raw bytes to orch stdin → tmux client → active pane
userAction(pressKeyInPane('left' | 'right', key))     // server-side `tmux send-keys` to a named pane
userAction(clickOnPane('left' | 'right'))             // injects a tmux mouse event at pane center
userAction(signalOrch('SIGINT' | 'SIGTERM' | 'SIGHUP'))
userAction(closeTerminal())                           // closes orch's stdin → equivalent to controlling-tty hangup
userAction(externalKillPane('left' | 'right'))        // operator runs `tmux kill-pane` from outside
userAction(externalKillSession())
userAction(externalKillServer())
userAction(wait(ms))                                  // explicit, not implicit — every delay is visible in the test
userAction(release(stepName))                         // releases a holdUntilReleased() step gate

// Workflow-state setup helpers (use during script:)
holdUntilReleased()                                   // step blocks until userAction(release(...))
completesOk()
failsWith(message)
emits(events)                                         // FakeRunner-style event script
```

### Matchers (composable, passed into assert functions)

```ts
// Pane matchers
containsText(needle: string | RegExp)
doesNotContain(needle: string | RegExp)
isFocused()
isInState('live' | 'viewing' | 'end-of-run' | 'error-banner')
hasFooterText(needle: string | RegExp)
hasNoLiveOutput()                                     // pane source is detached / dead

// Workflow matchers
isRunningStep(stepName: string)
hasStatus('running' | 'completed' | 'failed' | 'cancelled')
hasExitCode(code: number)
hasExitedBySignal(sig: NodeJS.Signals)

// Outcome matchers
withinMs(ms: number)
cleanly()                                             // exit code 0 OR documented signal exit
doesNotExist()                                        // tmux session / server probe
balancedEscapes()                                     // alt-screen and mouse-tracking ons == offs in captured stdout
noOrphanChildren()                                    // pgrep -P sweep is empty
hasIntactPerStepFiles()                               // formatted_output files end at \n
```

### Assertions

```ts
assertLeftPane(...matchers: PaneMatcher[]): Promise<void>
assertRightPane(...matchers: PaneMatcher[]): Promise<void>
assertWorkflowState(...matchers: WorkflowMatcher[]): Promise<void>
assertOrchExits(...matchers: OutcomeMatcher[]): Promise<void>
assertTmuxSession(...matchers: OutcomeMatcher[]): Promise<void>
assertTerminalState(...matchers: OutcomeMatcher[]): Promise<void>

// One escape hatch for invariant-contract bulk assertions
assertAllInvariants(scenario: ScenarioTag): Promise<void>   // runs every applicable invariant; failure lists violations + snapshot
```

Each matcher is a tiny pure function returning a predicate over a snapshot/state. Adding a new matcher is a one-file change.

### Launcher

```ts
launchOrchWorkflow(
  fixtureName: 'two-step-linear' | 'three-step-with-ask' | 'step-failing-mid',
  opts: {
    script: Record<string, StepScript>,
    bringToState?: 'pre-run' | { kind: 'mid-step', name: string } | 'between-steps' | 'completed' | 'failed' | 'awaiting-ask',
    mode?: 'two-pane',                                // default; plain mode is a separate suite
    env?: Record<string, string>,
  },
): Promise<OrchHandle>
```

`OrchHandle` is an opaque token passed to actions and assertions. It carries `runId`, `socket`, subprocess handle, state-dir, etc. — but tests never read those fields directly.

---

## 6. Harness surface (engine)

### 6.1 Subprocess control

Spawn orch via `BunProcessService.spawn(...)` (the legal seam per CLAUDE.md rule #1). Arguments:

```
bun src/cli/main.ts run <fixtureWorkflow> --mode=two-pane
```

Stdio: `['pipe', 'pipe', 'pipe']` so the harness can write to stdin (the attach-tty channel) and capture stdout escape sequences for parity checks.

Environment additions:

- `ORCH_LIFECYCLE_SCRIPT=<path>` — JSON file consumed by `ScriptedFakeRunner`.
- `ORCH_STATE_BASE=<path>` — isolated per-test state directory.
- Any test-only flags the harness needs.

Orch's stderr is parsed for the line `Running workflow "<name>" (<runId>)...` (already emitted by `src/cli/commands/run.ts:104`). From that line the harness derives `socket = 'orch-' + runId` and can now talk to the tmux server externally via a second `RealTmuxService` instance.

No changes to orch's CLI flags are required for v1. If we later want explicit `--run-id`, that's a separate trivial PR.

### 6.2 ScriptedFakeRunner

A new runner at `src/runners/scripted-fake/`. Implements the `Runner` interface like `FakeRunner` does, but reads its per-step behavior from `process.env.ORCH_LIFECYCLE_SCRIPT` at construction. Each step entry:

```ts
type StepScript =
  | { kind: 'instant-ok'; events?: RunnerEvent[]; structuredOutput?: unknown }
  | { kind: 'instant-fail'; message: string }
  | { kind: 'wait-for-file'; gatePath: string; events?: RunnerEvent[] }
  | { kind: 'emit-then-hang'; events: RunnerEvent[] }    // for mid-step interrupt tests
```

`wait-for-file` polls until the gate file exists. The DSL's `release(step)` creates the file. Unidirectional control → no IPC complexity, no sockets, no shared memory.

The fixture workflows under `tests/fixtures/lifecycle/<name>.ts` wire `ScriptedFakeRunner` into each step slot.

### 6.3 External tmux probe

A second `RealTmuxService` instance pointed at the parsed socket. Exposes:

- `hasSession()`, `hasServer()`, `listPanes()`
- `killPane('left' | 'right')`, `killSession()`, `killServer()`
- `sendKeys(pane, keys)`, `sendMouseEvent(pane, x, y, button)`

The mouse-event helper is the load-bearing piece for `clickOnPane(...)`. Tmux accepts mouse events via `send-keys -M` with an SGR-encoded sequence. The harness needs a small builder that converts `(pane, button)` into the right bytes; pane center coordinates come from `display-message -p '#{pane_width},#{pane_height}'`.

### 6.4 Snapshot

`snapshot()` returns a `LifecycleSnapshot`:

```ts
interface LifecycleSnapshot {
  readonly orchAlive: boolean
  readonly orchExit: { code: number | null; signal: NodeJS.Signals | null } | null
  readonly tmuxSessionExists: boolean
  readonly tmuxServerExists: boolean
  readonly panesAlive: readonly PaneId[]
  readonly leftPaneText: string
  readonly rightPaneText: string
  readonly leftPaneFocused: boolean
  readonly stateStatus: 'running' | 'completed' | 'failed' | 'cancelled' | null
  readonly stepStatuses: Record<string, StepStatus>
  readonly perStepFilesIntact: boolean
  readonly stdoutAltScreen: { enters: number; exits: number }
  readonly stdoutMouseTracking: { ons: number; offs: number }
  readonly orphanChildren: readonly { pid: number; cmd: string }[]
}
```

Captured by:
- process state via Bun's child handle
- `tmux has-session` / `list-panes` / `capture-pane`
- reading `.orch/state/<runId>/state.json` and per-step files
- regex-counting `\x1b[?1049[hl]` and `\x1b[?100[03][hl]` in captured stdout
- `pgrep -P <orchPid>` sweep, recursive

### 6.5 Invariants

A single function `runInvariantContract(snapshot, scenario): InvariantResult[]`. Outcome matchers like `cleanly()` and `balancedEscapes()` are projections of this contract. `assertAllInvariants(scenarioTag)` runs the full contract for that scenario and reports the list of violations.

The contract by scenario class:

| Trigger | After timeout T, must hold |
|---|---|
| signalOrch(SIGINT) | orch exited with code 130; no tmux session/server; state-status=cancelled; balanced escapes; no orphans; per-step files intact |
| signalOrch(SIGTERM) | orch exited with code 143; rest same as SIGINT |
| signalOrch(SIGHUP) | same as SIGTERM |
| closeTerminal() | same as SIGHUP |
| typeInAttachTty('\x03') × N | orch exited cleanly OR pane death is reflected in left/right pane state (no half-dead UI); orch exits within T regardless |
| pressKeyInPane(left, 'q') during run | **PRODUCT-SHAPE DECISION (see §2.1 and §13):** orch exits cleanly within T; **running agents (codex/claude) are killed**; tmux session gone; state-status = `cancelled`; balanced escapes; no orphans. This **replaces** the current `q quit (run continues)` spec at `src/hosts/two-pane/steps-view/steps-view.tsx:325` and the detach behavior at `src/cli/commands/execute-with-attach.ts:106`. |
| pressKeyInPane(left, 'q') at completion (S4) | orch exits with code 0; tmux gone; no orphans. (Dismissing the end-of-run summary is fine — no workflow to cancel.) |
| externalKillPane(...) | orch detects via `pane-died` AND tears down OR documents-as-acceptable; in either case no zombie state |
| externalKillSession() / externalKillServer() | orch exits with a documented "host died" code; no orphans |

When the contract is wrong for a scenario (we discover an invariant doesn't apply), the contract gets edited — not the per-test assertion. One source of truth.

---

## 7. The lifecycle scenario matrix (Consumer #1)

Matrix dimensions:

**Inputs (rows):**
- I1: signalOrch(SIGINT)
- I2: signalOrch(SIGTERM)
- I3: signalOrch(SIGHUP)
- I4: closeTerminal()
- I5: typeInAttachTty('\x03') × 1
- I6: typeInAttachTty('\x03') × 2
- I7: typeInAttachTty('\x03') × 3 (defensive — anchors "no matter how many")
- I8: pressKeyInPane('left', 'q')
- I9: pressKeyInPane('left', 'C-c')
- I10: externalKillPane('left')
- I11: externalKillPane('right')
- I12: externalKillSession()
- I13: externalKillServer()
- I14: signalOrch(SIGINT) then signalOrch(SIGINT) (the double-Ctrl-C-while-handling path)

**Workflow states (columns):**
- S1: pre-run (host mounted, no step started)
- S2: mid-step (step is running via holdUntilReleased)
- S3: between-steps (one step done, next not yet started)
- S4: completed (end-of-run summary showing)
- S5: failed (failure banner showing)
- S6: awaiting-ask (interactive prompt mounted)

= 14 × 6 = **84 cells**, but the first sweep should be the smaller high-priority set that exercises every input at least twice and every state at least twice. Recommended first batch: ~20 cells covering all symptom classes the user reported.

Each cell is one file at `tests/integration/lifecycle/<input>-during-<state>.real.test.ts`. The cell-per-file layout is intentional — the agent's triage report is literally the directory listing with pass/fail beside each filename.

---

## 8. Exploratory campaign methodology

The campaign is **methodology C** from the brainstorm (orchestrator + parallel sub-agents).

### Loop

1. **Orchestrator agent** reads this brainstorm, the invariant contract, and the matrix.
2. For each high-priority cell, **orchestrator spawns a sub-agent in parallel** with a prompt containing:
   - Cell coordinates (input I × state S)
   - Path to write the test (e.g. `tests/integration/lifecycle/ctrl-c-twice-during-mid-step.real.test.ts`)
   - DSL surface reference (link to `tests/helpers/behavioral-dsl/index.ts`)
   - Invariant contract subset that applies
3. **Each sub-agent**:
   - Writes the test in the DSL.
   - Runs it via `bun test <path>`.
   - Captures outcome + snapshot.
   - Classifies the outcome (taxonomy in §9).
   - Returns a structured row.
4. **Orchestrator collates** rows into `docs/findings/2026-05-20-lifecycle-campaign-findings.md`.

### Why exploratory beats prescriptive

The user explicitly said: "find a test suite that is probably failing, and only then we will decide what we want to do." The triage column on the report **is** the decision input. We don't pre-commit to "this should pass" — we run the contract and let the contract decide.

When the contract is wrong for a cell, the sub-agent files a contract-revision note instead of forcing the test to pass. That is the **wrong-expectation** triage class below.

---

## 9. Triage taxonomy

Every cell outcome classifies into exactly one:

- **PASS** — invariant contract held. No further action.
- **FAIL-BUG** — invariant violated. The snapshot is the evidence. Promote to a bug ticket (separate planning round).
- **FAIL-EXPECTATION** — the invariant doesn't apply to this cell. Edit the contract; cell becomes PASS after re-run.
- **FAIL-HARNESS** — input can't be cleanly simulated, OR snapshot misses required state. File a harness improvement task; the cell is **skipped** in the current sweep with a clear pointer.
- **FAIL-DSL** — the test author (the sub-agent) couldn't express the scenario in the DSL. File a DSL-gap finding (S3 success criterion). The cell is **skipped**.

Sub-agents must categorize. Uncategorized failures are an orchestrator-level error.

---

## 10. Open questions & risks

- **Q1: Does `BunProcessService.spawn` accept piped stdio + signal delivery?** Almost certainly yes (it's the same `Bun.spawn` underneath), but verify before designing around it.
- **Q2: How long after spawning until orch is "really ready" to receive a signal?** The harness needs a deterministic readiness gate (e.g. wait until state.json appears and shows `status: running`). Polling interval and timeout need tuning.
- **Q3: Mouse-event injection via `send-keys -M`** — supported on all tmux versions we care about (≥3.0)? Document the minimum. Already implicitly required by appliance-mode's click-to-focus binding.
- **Q4: Can the harness detect "pane is dead" state cleanly?** `tmux list-panes` shows `pane_dead=1` for dead panes. The harness should expose this in the snapshot — it's a likely matcher (`isPaneDead()`) for cells that probe the user's reported "[Pane is dead]" symptom.
- **Q5: Plain mode is excluded** — confirm the campaign matrix doesn't accidentally pull plain-mode workflows. The launcher should hard-default to two-pane.
- **R1: Orphan-process sweep on macOS** — `pgrep -P` only finds direct children. Recursive process-tree walks need a helper. Risk: false "no orphans" passes if a grandchild leaked.
- **R2: Subprocess test runtime cost.** Each cell boots an orch process + tmux server. Estimate ~3–5s per cell. The full 84-cell matrix could be 5–10 minutes wall-clock — fine, but flag if we ever consider running it in pre-commit.
- **R3: Flake risk from polling-based readiness gates.** Use `waitFor` with explicit timeouts everywhere; never `sleep(N)`. Per repo conventions.
- **R4: The campaign may surface DSL gaps faster than orch bugs in the first day.** That is the desired outcome of S3 — but the orchestrator must not lose the original cell while the DSL is being extended. Track DSL-gaps as parallel work, not blocking.

---

## 11. Implementation order (the downstream agent's path)

Linear sequence. Each step is a separate PR.

1. **Build Tier 5 skeleton.** Add `tests/helpers/behavioral-dsl/` and `tests/helpers/behavioral-dsl/internal/` with stub exports. Document the tier in `docs/testing-strategy.md` as Tier 5. No tests yet.
2. **`ScriptedFakeRunner` + first fixture workflow.** Add the runner under `src/runners/scripted-fake/`. Add `tests/fixtures/lifecycle/two-step-linear.ts`. Smoke-test by booting it from a tiny unit test.
3. **Subprocess harness.** Implement `launchOrchWorkflow` (just the launcher + runId parse + state-base isolation). One smoke test: "launch, observe state.json appears, teardown."
4. **External tmux probe + snapshot.** Implement `snapshot()` and the `assertTmuxSession`/`assertOrchExits` outcome matchers (subset: `cleanly()`, `doesNotExist()`, `withinMs()`).
5. **First end-to-end cell.** Write `tests/integration/lifecycle/sigint-to-orch-during-mid-step.real.test.ts` using nothing but the DSL. This proves the DSL is usable. Expected: PASS (the SIGINT handler exists and should work).
6. **Pane-state matchers + Ink projection + mouse events.** Add `containsText`, `isFocused`, `isInState`, `clickOnPane(...)`. Required by the §2.1 acceptance test. Smoke-cover with one cell verifying click-to-focus across the divider.
7. **The headline acceptance test (§2.1).** Write `tests/integration/lifecycle/q-during-fake-mid-step.real.test.ts` (deterministic `ScriptedFakeRunner` version) AND `tests/integration/lifecycle/q-during-codex-mid-step.real.test.ts` (real-codex version, env-gated like Tier 4). Both predicted FAIL-BUG. The captured snapshots are the S2 success-criterion evidence and the input to the next planning round.
8. **Ctrl-C and signal cells.** Write `ctrl-c-twice-in-attached-during-mid-step.real.test.ts` and the SIGTERM/SIGHUP cells. Predicted mixed (some FAIL-BUG, some PASS — that's the campaign learning).
9. **The exploratory campaign runs.** Orchestrator agent reads §7 matrix, dispatches sub-agents for remaining cells, produces `docs/findings/2026-05-20-lifecycle-campaign-findings.md`.

Stop after step 9. Bug fixes are out of scope for this brainstorm — but step 7's snapshots are the explicit, durable artifact that the next planning round consumes.

---

## 12. References (code touchpoints)

- `src/cli/main.ts` — entry point; `EXIT` codes.
- `src/cli/commands/run.ts:101` — runId generation; stderr log line we parse.
- `src/cli/commands/execute-with-attach.ts:64–78` — the SIGINT/SIGTERM/SIGHUP handlers we need to exercise.
- `src/hosts/two-pane/tmux-host.ts:83` — `pane-died` hook; `:345–451` quit-intent wiring.
- `src/hosts/two-pane/tmux-host.ts:480–530` — `awaitForegroundShutdown` race.
- `src/hosts/two-pane/tmux-host.ts:900–970` — teardown sequence.
- `src/services/tmux/session-init.ts` — appliance-mode lockdown (what tmux already blocks).
- `src/runners/fake/fake-runner.ts` — sibling for the new `ScriptedFakeRunner`.
- `tests/helpers/real-tmux/` — existing Tier 1 harness (DO reuse `RealTmuxService` construction patterns; do NOT reuse the in-process host mounting).
- `docs/testing-strategy.md` — add Tier 5 here.

---

## 13. Synthesis snapshot (what we agreed during the brainstorm)

**Stated:**
- The brainstorm produces tooling, not a bug fix.
- Tests must read like a user story with named actions and composable matchers.
- DSL style: flat matchers/actions (e.g. `assertRightPane(containsText('x'), isFocused())`).
- The lifecycle bug campaign is Consumer #1; finding ≥1 failing test is proof the tooling works.
- The downstream agent runs the campaign exploratorily (sub-agents per cell).
- **End criterion of this plan: the §2.1 acceptance test exists, runs, and reproduces the screenshot scenario as a deterministic FAIL-BUG with a captured snapshot.** The user provided the reproduction directly (codex-riddle-solver workflow, wait for right pane to show codex, focus left pane, press `q` → left pane dead, right pane still running).

**Inferred (open to revision):**
- The right framing is "make every teardown clean" expressed as an invariant contract, not "block inputs at the tmux layer." The latter is a possible mitigation downstream of evidence.
- A new Tier 5 (subprocess-based) is required; Tier 1 cannot express signal-delivery bugs.
- Two-layer architecture (DSL public, harness private) keeps test readability separate from mechanism complexity.
- Tier 5 supports a **real-CLI variant** (env-gated like Tier 4) for cells that must exercise the actual runner — the codex variant of the §2.1 test is one. The fake variant runs in default CI; the real-CLI variant gates on `RUN_REAL_TMUX_E2E=1` plus the named CLI binary on PATH.

**Product-shape decision recorded during this brainstorm (from the screenshot evidence):**
- `q` semantics change from **"detach, workflow continues in background"** to **"cancel everything — orch exits, running agents are killed, tmux session is torn down, state-store status = cancelled."** This contradicts the current spec at `src/hosts/two-pane/steps-view/steps-view.tsx:325` (`"q quit (run continues)"`) and the detach hint at `src/cli/commands/execute-with-attach.ts:106`. The invariant contract in §6.5 already reflects the new spec; user-facing footer copy and CLI detach messaging are downstream cleanup for the next planning round, NOT scope here.

**Out of scope (explicit):**
- Fixing bugs the campaign finds (including the §2.1 reproduction itself — only the failing test is in scope).
- Plain mode lifecycle.
- Editing the user-facing footer copy or detach hint text (downstream cleanup).
- Pre-deciding which *other* inputs should be rejected vs. handled cleanly — `q` is the one input whose semantics this brainstorm pins, because the user provided concrete evidence for it. Every other matrix cell remains open until evidence lands.
