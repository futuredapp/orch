## Code Review Results

**Scope:** `eddfc0f05d1a8b5ced5027b36763f13487b7a9bc..HEAD` on `develop` (44 files changed)
**Intent:** Show each non-interactive agent step's assembled prompt at the top of the right pane, safely escaped, live and on replay, with long prompts opened at the prompt top.
**Mode:** interactive review, report-only; no source changes applied.

**Reviewers:** correctness, testing, reliability, security, api-contract, project-standards
- correctness -- verified lifecycle/replay behavior against `brainstorm.md` and `acceptance-tests.md`
- testing -- checked whether AT-1 through AT-9 are actually covered by the changed tests
- reliability -- checked error paths, logger-disabled replay fallback, and tmux source behavior
- security -- reviewed control-sequence escaping and terminal/OSC handling
- api-contract -- checked `StepLifecycleEvent`, `PaneSpec`, and tmux service contract changes
- project-standards -- checked repo rules in `CLAUDE.md`

### P1 -- High

| # | File | Issue | Reviewer | Confidence |
|---|------|-------|----------|------------|
| 1 | `src/hosts/two-pane/pane-map/right-pane-controller.ts:1264` | Logger-disabled replay can still truncate prompts | correctness, testing | 100 |

- **#1** -- The R8 acceptance path reconstructs the prompt preamble into a warm-cache replay file when the frozen tee is absent, but both fallback returns use a plain `file-tail` spec. That means the hidden pane runs the default bounded `tail -n 5000 -F` path instead of `tail -n +1 -F`. A logger-disabled replay with a prompt/transcript longer than the backfill window can therefore drop the `prompt:` label and prompt head, contradicting R2's no-truncation requirement and R8/AT-7's always-on replay parity. Suggested fix: return a from-start replay spec whenever the fallback writes a prompt-bearing autonomous replay file, e.g. `{ kind: 'file-tail', path: filePath, fromStart: true }` at both fallback returns (`step.transcriptPath === undefined` and rendered-transcript branches). Add a regression that writes a persisted prompt plus enough transcript text to exceed `TAIL_BACKFILL_LINES` and asserts the spawned tail command uses `+1` or that the replayed file's head is visible.

### P2 -- Moderate

| # | File | Issue | Reviewer | Confidence |
|---|------|-------|----------|------------|
| 2 | `src/hosts/two-pane/pane-map/right-pane-controller.ts:1082` | Cold replay opens at transcript tail | correctness, testing | 75 |
| 3 | `src/core/workflow.ts:1157` | Prompt assembly errors skip step lifecycle | correctness, reliability | 75 |

- **#2** -- R9 says a non-interactive step opens scrolled to the top of the prompt. The implementation pins only auto-followed live sources inside `registerSource` (`key.type === 'live' && spec.fromStart === true`), but `dispatchEnter` registers and shows replay sources without any equivalent pin. On a cold replay or reload of a completed long-prompt autonomous step, `tail -n +1 -F` sends the full file into the pane but tmux's live screen lands at the bottom, so the watcher sees the transcript tail rather than the `prompt:` label. That undercuts the replay half of the product goal: a reviewer of a completed run still has to scroll back to know what was asked. Suggested fix: after `showReplaySourceWithStaleRefresh` for an autonomous replay whose resolved spec is prompt-bearing/from-start, call the same copy-mode top pin on the replay pane, or factor the pin decision into `showSource` so both live auto-open and replay open can opt in. Add an AT-7/R9 regression for reloading or selecting a completed long-prompt autonomous step and asserting the copy-mode-aware viewport starts at the prompt head.
- **#3** -- `runAgentStep` now calls `assemblePrompt` before entering `withStepLifecycle`, and `runInteractiveStep` does the same at line 773. `assemblePrompt` can throw for invalid prompt vars or missing required placeholders via `substitute()`. Before this change, those errors occurred inside the lifecycle body, so the host/span saw `step:start` followed by `step:failed`; now the exception happens before `withStepLifecycle`, so no step lifecycle event, failure pane, or step-scoped trace is emitted. That is an error-handling regression outside the display-only contract. Suggested fix: precompute the prompt in a way that still routes failures through the lifecycle envelope. For example, catch prompt assembly errors, call `withStepLifecycle` without a prompt, and have the body rethrow the captured error; for successful assembly, pass the already-computed prompt into `produceAgentStep` / `produceInteractiveStep` so the displayed prompt and runner prompt are exactly the same string and are not assembled twice. Add a focused workflow test with a missing `{{placeholder}}` value asserting `step:start` and `step:failed` are both emitted and the structured lifecycle record still omits the prompt.

### Actionable Findings

| # | File | Issue | Route | Notes |
|---|------|-------|-------|-------|
| 1 | `src/hosts/two-pane/pane-map/right-pane-controller.ts:1264` | Logger-disabled replay can truncate prompt head | `gated_auto -> downstream-resolver` | Concrete fix: set `fromStart: true` on prompt-bearing fallback replay specs and add over-backfill coverage |
| 2 | `src/hosts/two-pane/pane-map/right-pane-controller.ts:1082` | Replay does not pin long prompts to top | `manual -> downstream-resolver` | Reuse the R9 copy-mode pin for autonomous replay opens; needs a replay-specific viewport test |
| 3 | `src/core/workflow.ts:1157` | Prompt assembly failure bypasses lifecycle | `gated_auto -> downstream-resolver` | Preserve lifecycle bracketing for prompt-substitution failures and avoid double assembly |

### Coverage

- Requirements checked: R1-R9 and AT-1-AT-9 from `docs/sessions/show-initial-prompt/brainstorm.md` and `docs/sessions/show-initial-prompt/acceptance-tests.md`.
- Focused verification run: `bun test tests/unit/hosts/two-pane/prompt-preamble.test.ts tests/unit/hosts/two-pane/prompt-store.test.ts tests/unit/hosts/two-pane/lifecycle-choreographer.test.ts tests/model/controller/right-pane-replay-prompt-fallback.test.ts tests/model/controller/right-pane-controller-sources.test.ts tests/unit/core/step-lifecycle.test.ts` -- 57 pass.
- End-to-end verification attempted: `bun run test:two-pane:full:fake` failed before exercising feature code because tmux could not create per-test sockets in the sandbox temp socket directory (`Operation not permitted`). This is an environment limitation in the current sandbox; every failing case failed at `tmux new-session` startup.
- Residual risk: I did not run the full `bun run check` gate because the real-tmux suite was blocked by the sandbox socket-permission failure above.
- No blocker was found under the blocker protocol. No blocker file was created.

---

> **Verdict:** Ready with fixes
>
> **Reasoning:** The main live-path behavior is well covered and the focused tests are green, but the replay fallback and cold replay view still miss parts of the human-reviewed acceptance contract, and prompt-assembly failures now bypass lifecycle reporting.
>
> **Fix order:** #1 fallback `fromStart` replay spec -> #2 replay top-pin behavior -> #3 lifecycle bracketing for prompt assembly failures.
