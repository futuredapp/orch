## Add completeness proof reproducibility notice

Created `tests/_migration/README.md` documenting that the dual-tree completeness proof cannot be reproduced from HEAD: the `.skip` archive was intentionally deleted at `c99a364` as the designed conclusion of the strangler-fig migration, and `0742468` is the last commit where `bun run reconcile` produces the full dual-tree proof. `baseline.json` remains the frozen record (425 files, 2517 cases) that `reconcile` continues to validate against. The README also documents all other artifacts in the directory for future contributors.

## Release preflight and real-agent skip predicate fix

Added `scripts/preflight-release.sh` (asserts `RUN_REAL_TMUX_E2E=1`, `which claude`, `which tmux`) and wired it as `preflight:release` into `check:release` as the first step, so the release gate can never silently skip real-agent tests on a misconfigured machine. Also updated `test:two-pane:full:real` to always export `RUN_REAL_TMUX_E2E=1` (env var is no longer a skip cause when running that script directly), and narrowed the real-agent driver's `skip` predicate from `!(canRunRealTmuxE2E('claude') || canRunRealTmuxE2E('codex'))` to `!canRunRealTmuxE2E('claude')` since all current real-agent scenarios use `claudeAgent`. All 260 fast tests pass after the changes.

## Add missing `await` to `expect(...).rejects.toThrow()` assertions

Added `await` to 11 bare `expect(...).rejects.toThrow()` calls in `tests/unit/runners/codex/build-command.test.ts`, 2 in `tests/unit/state/state-store.test.ts`, and 1 in `tests/unit/services/fs/fake-fs-service.test.ts`. Without `await`, these assertions resolved before the test completed, silently passing even when the code under test stopped throwing — making the Codex flag-denylist security tests vacuous. All 68 tests in the three files pass after the fix.

## Split `test:int` to cap real-tmux concurrency

The `test:int` script was already split in `package.json` (as part of prior work): `test:int` now only covers pure in-process integration suites (`tests/integration/cli`, `codegen`, `core`, etc.), while `test:int:real-tmux` runs `tests/integration/real-tmux` with `--max-concurrency=2`. The `test:project` script calls both in sequence. This directly addresses the documented root cause of real-tmux flakiness (unbounded daemon accumulation). No changes were needed — the split was already present in the working tree.

## Update docs to remove tests-new/ and migration routing

Replaced all `tests-new/` references with `tests/` across CLAUDE.md, docs/testing-strategy.md, .claude/skills/runner-author/SKILL.md, tests/dsl/scenario.ts, tests/dsl/README.md, and tests/_migration/snapshot.ts. Also removed the "During-migration routing" bullet from CLAUDE.md, the stale migration-era sentence from the running/gating section of testing-strategy.md, the entire "Migration status" section at the bottom of testing-strategy.md, and the migration-routing qualifier from the runner-author SKILL.md. The codebase now presents a single unified `tests/` tree with no references to the deleted `tests-new/` path; all 260 fast tests pass.

## Delete dead `_pending-relocation.test.ts` sentinel

Deleted `tests/e2e/_pending-relocation.test.ts`, a `expect(true).toBe(true)` placeholder that kept the `test:new-e2e` gate bucket green during the migration window while the e2e directory was empty. The file's own header stated it should be deleted once real e2e tests moved in; that condition is now met. No behavioral change — the test was vacuous.

## Wrap driver build() methods with try/catch on fixture dispose

Wrapped the `build()` body of all four real-tmux drivers (`full-host-fake-agent-driver.ts`, `full-host-real-agent-driver.ts`, `full-host-recorded-agent-driver.ts`, `screen-driver.ts`) in `try { ... } catch (err) { await fixture.dispose(); throw err }`. If `mountTmuxHost` or `createScreenApp` throws after the fixture is already booted, the tmux server is now cleaned up rather than leaked. The `lifecycle-driver.ts` `build()` creates no real-tmux fixture (it defers that to `launch()`), so no change was needed there. All 260 fast tests and typecheck pass.

## Fix migration oracle paths and wire into check

Updated `reconcile.ts`, `overlap-report.ts`, and `import-parity.ts` to use `tests/` instead of deleted `tests-new/` paths; also updated the `@orch/test/` alias in `import-parity.ts` to `tests/_support/`, removed the now-meaningless cross-tree check (both trees are `tests/`), added a zero-pairs failure guard, made `checkMap` skip missing old files gracefully, and fixed `snapshot.ts` helper classification from `tests/helpers/` to `tests/_support/`. Regenerated `relocation-map.json` (all 268 `"new"` entries now point to `tests/`). Added `overlap-report`, `import-parity`, `reconcile` scripts to `package.json` and created `check:migration` (runs both blocking oracles + 38 oracle unit tests); `check:migration` is now called by `bun run check`. `reconcile` is available as a standalone script but is intentionally off the gate since the migration-proof can no longer reproduce from HEAD (old `.skip`-ed files were deleted at `c99a364`). `bun run check:migration` exits 0 cleanly.

## Narrow LifecycleApp pane types to LifecyclePaneView (Phase 3.3)

Added a `LifecyclePaneView` interface to `tests/dsl/app-surfaces.ts` with only `assertFocused(): Promise<void>`, and changed `LifecycleApp.leftPane`/`rightPane` from the full `LeftPane`/`RightPane` classes to this restricted interface — enforcing at compile time that lifecycle scenarios can only call `assertFocused` on panes (all other methods throw `notImplemented()` at runtime). Exported `LifecyclePaneView` from `tests/dsl/index.ts` and added a negative type test in `scenario.test-d.ts` (`@ts-expect-error` on `assertShowsContent`) that proves the bite: removing the annotation causes tsc to emit `error TS2339`. The existing 260 fast tests and `tsc --noEmit` all pass.

## Add clarifying comment to assertNoCaretEcho in model-driver.ts (Phase 3.2)

Added a three-line comment above the `assertNoCaretEcho` method in `tests/dsl/drivers/model-driver.ts` explaining that it catches Ink rendering escape leakage (Ink accidentally encoding escape sequences as literal text), not pty/tmux escape doubling — the latter requires a real TTY and must run on a screen or full-host driver per spec §5.7. The distinction was previously invisible to readers, who might incorrectly assume the model-driver assertion is equivalent to the real-tmux version.

## U1: Fan-out composite host

Created `src/hosts/composite/composite-host.ts` (and barrel `src/hosts/composite/index.ts`) with `createCompositeHost(primary, secondary)` that fans `writeBanner`, `onRunnerEvent`, `onLifecycleEvent`, and `onCommandLine` to both hosts while delegating all interface methods (`attach`, `runInteractive`, `attachForeground`, `awaitForegroundShutdown`, `probeReachability`, `teardown`) exclusively to the primary; `mode` mirrors `primary.mode`. Secondary errors in fanned methods are silently swallowed via `try/catch`. Seven unit tests in `tests/unit/hosts/composite/composite-host.test.ts` cover all fan/delegate/isolation/mode scenarios and `bun run check` is green.

## U2: Core seam additions

Added three targeted seam additions: (1) `readonly runnerName?: string` to the `step:start` variant of `StepLifecycleEvent` in `src/core/workflow.ts` and threaded it through `StepLifecycleContext` in `src/core/step-lifecycle.ts`, with autonomous and interactive agent steps populating it from `config.agent.name` and ask/command steps omitting it; (2) `readonly cmux?: { readonly enabled?: boolean }` to `OrchestratorConfig` and the corresponding Zod schema in `src/config/index.ts`; (3) `readonly beforeTeardown?: (exitCode: number) => Promise<void>` to `ExecuteWithAttachOpts` in `src/cli/commands/execute-with-attach.ts`, called (with `.catch(() => {})` error-swallowing) at all five teardown sites — success, `resolveCaughtError`, quit branch, unreachable-attach branch, and signal handlers (fire-and-forget). One existing test in `tests/unit/core/interactive-mode.test.ts` was updated to include the new `runnerName` field; all `bun run check` gates are green.

## U3: CmuxHost implementation

`src/hosts/cmux/cmux-host.ts` and `src/hosts/cmux/index.ts` were already present in the working tree with a complete implementation: a three-gate factory (`CMUX_SURFACE_ID` absent → no-op, `cmux.enabled === false` → no-op, `cmux ping` non-zero → no-op, otherwise live host), pill lifecycle via an internal `enqueue` chain firing four `cmux set-status` calls per `step:start`, interactive-mode `cmux notify` for the "needs you" signal, error swallowing via `try/catch` in `fireSpawnCmux`, and `notifyRunEnd` that fires a completion/failure notification then clears all four pills. Created `tests/unit/hosts/cmux/cmux-host.test.ts` with 13 unit tests covering probe/availability, pill lifecycle, notifications, error swallowing, and `notifyRunEnd` behavior against `FakeProcessService`; `bun run check` is green with no warnings.

## U4: Composition root wiring

Wired `CmuxHost` into `runCmd` (`src/cli/commands/run.ts`) and `resumeCmd` (`src/cli/commands/resume.ts`): after the primary host is created via `hostFactory`, both commands now create a `cmuxHost` via `createCmuxHost` (passing `instrumentedProcess`, `deps.clock`, the workflow name, `result.config.cmux`, `process.env`, and `deps.cwd`), compose it with the primary host via `createCompositeHost`, and thread the composite through both `wfDeps.host` and `executeWithAttach`'s `host` parameter so lifecycle events reach `CmuxHost`. The `beforeTeardown` callback is wired as `(exitCode) => cmuxHost.notifyRunEnd(exitCode)` so run-end notifications and pill-clearing fire correctly. The `CmuxHostOptions.env` type was broadened from `Record<string, string>` to `Record<string, string | undefined>` to accept `process.env` without a cast. `createCmuxHost`, `createCompositeHost`, `CmuxHost`, and `CmuxHostOptions` are re-exported from `src/hosts/index.ts`. TypeScript strict-mode clean; all 260 fast tests and 226 host unit tests pass.

## U6: Phase 1 acceptance tests (AT-1 to AT-12)

Created `tests/integration/hosts/cmux/cmux-host.test.ts` with all twelve Phase 1 acceptance tests, plus a co-located `cmux-test-support.ts` holding the shared harness and exact-argv cmux scripting helpers (the test file was split out to stay under the 600-line gate). Each test drives the real composition path — `createCmuxHost` + `createCompositeHost` + the real `workflow().execute()` executor + `FakeRunner` + `FakeProcessService` — with AT-4/5/6/7/12 additionally driving `executeWithAttach` so the `beforeTeardown → notifyRunEnd` run-end hook fires; observations read the `FakeProcessService` cmux call history. The `FakeProcessService` call-history prerequisite (`calls`, `cmuxCalls()`, `assertAllConsumed()`) was already present in the working tree from prior work, so no edge changes were needed. Key learning: CmuxHost fires its per-step pill set-status spawns via a serialized async chain, so tests must `await cmuxHost.flush()` (bare-run path) or rely on `notifyRunEnd` awaiting the chain (attach path) before asserting. All 12 AT tests pass; `lint`, `typecheck`, `check:int-dirs`, and `check:migration` are green, and the AT status table in the acceptance-tests doc now marks AT-1 through AT-12 as ✅ implemented.
