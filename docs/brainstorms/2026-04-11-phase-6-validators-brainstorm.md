---
date: 2026-04-11
status: active
topic: Phase 6 — Validators
---

# Phase 6 — Validators brainstorm

## What We're Building

Post-exit assertions for steps. After a step's runner exits successfully, the executor runs the step's configured validators against the real filesystem and git state. If any validator fails, the workflow crashes with an aggregated error listing every failure — same crash/resume model as `StepError` from Phase 4.

**Scope:** built-in validators (`fileProduced`, `gitDiffCreated`, `gitCommitCreated`), user-defined validators (`check(fn)` anonymous, `defineValidator(name, fn)` named), and the `validate:` key wiring into `step.define()` / `workflow.run()`. A minimal `GitService` port ships with this phase (Phase 10 will grow it).

**Out of scope:** the Claude Code `Stop` hook integration that will eventually re-use these validators — Phase 6 leaves the seams in place, no hook code ships.

## Why This Approach

Validators are the second most-called-out feature in `docs/getting-started.md` after the workflow DSL itself, and they gate the "real feedback early" value the project promises: a step isn't done until the environment says it's done. Landing them now — before Phase 7's typed `returns` — means every subsequent phase can assert facts about the work, not just trust the runner's exit code.

## Key Decisions

1. **Minimal `GitService` ships in Phase 6.** New port at `src/services/git/git-service.ts` with just the methods these validators need (`headSha()`, `diffSinceSha(sha)`, `isClean()`). Real adapter wraps git via `ProcessService`. Fake adapter is scriptable. Phase 10 grows this port to add `stageAll`, `commit`, etc., and builds the `commit()` primitive on top of the already-shipped surface — no refactor needed.
   **Why:** unblocks `gitDiffCreated`/`gitCommitCreated` in Phase 6 without either throwaway code or a several-phase delay. Project rule #1 (subprocess isolation via `ProcessService`) still holds.

2. **Failures throw an aggregated `ValidationError`, collecting all failures in an array.** When `validate:` is an array, the executor runs *every* validator (no fail-fast), collects each failing result, and throws one error listing all of them. `ValidationError.failures: ReadonlyArray<{ name, reason, hint? }>`. Single validators behave the same via a one-element array under the hood.
   **Why:** better DX for multi-failure cases — you see all missing pieces in one shot, not one per re-run. Matches the future Stop-hook use case where the hook wants to feed *all* unfinished items back to the live session at once.

3. **Minimal validator `ctx`: `{ stepName, cwd, value }`.** Where `value` is whatever `extractStructuredOutput` returned from the runner (raw JSON for now; Phase 7 will type it via `returns:` + Zod). Built-in validators don't read `ctx` for their services — they receive services via DI (see Decision 4). User-defined `check()`/`defineValidator()` get the same minimal ctx. `exec`, `transcriptPath`, `artifacts` are deferred to the phases that actually produce them.
   **Why:** smallest forwards-compatible surface. Grows additively — no breaking changes when Phase 7/10/13 add fields.

4. **Built-in validators are factories that close over services injected at the workflow level.** `WorkflowDeps` gains `fsService: FsService` and `gitService: GitService`. A `Validator` is `(services: ValidatorServices, ctx: ValidatorCtx) => Promise<ValidatorResult>`. `fileProduced('*.md')` returns a `Validator` that reads `services.fs`. The executor passes services in when invoking; user code never sees them.
   **Why:** transparent DI, no service locator leaking into user code, and validators stay pure functions of (services, ctx) — which is exactly what the Stop-hook use case needs (re-invocable from a different process).

5. **`gitDiffCreated` baseline SHA is captured before the runner spawns AND persisted to `StepEntry`.** The executor calls `gitService.headSha()` immediately before invoking `runRunner`, and writes the result into `StepEntry.preRunSnapshot: { headSha: string }` on save. Validators read the baseline from the entry, not from in-memory per-step state.
   **Why:** correctness (baseline reflects the state *this step* saw, not a stale module-load value) AND future Stop-hook compatibility (a hook subprocess can re-run `gitDiffCreated` against the persisted baseline without the workflow being in memory).

6. **`check(fn)` is anonymous, `defineValidator(name, fn)` is named and registered.**
   - `check(fn)`: one-shot anonymous. Auto-named `check@<stepName>#<index>` in logs and state.
   - `defineValidator('tests-passed', fn)`: returns a factory that produces a named `Validator` and registers the name in a module-level registry (`Map<string, Validator>`).
   Both implement the same internal `Validator` interface. The registry exists so a future `orch validate` subcommand (Stop hook backend) can look up validators by stable name from outside the workflow closure.
   **Why:** names exist in `state.json`, tmux status (Phase 13), and future hook feedback messages. Stable names matter for named; inline checks are explicitly throwaway so the auto-name is fine.

7. **`StepEntry` schema bumps to version 2 with new fields; no migration code.** New fields: `preRunSnapshot?: { headSha?: string }` and `validations: ReadonlyArray<{ name, ok, reason?, hint? }>`. `schemaVersion` bumps 1 → 2. Since this is pre-production, the loader rejects v1 entries with a clear error rather than attempting migration. Existing Phase 3 unit tests that hand-build v1 fixtures get updated in the same PR.
   **Why:** explicitly called out by the user — not shipping yet, so backwards compatibility isn't worth the complexity budget.

8. **`ValidatorResult` return shape leaves room for hints without committing to the retry loop.** Internal type: `{ ok: true } | { ok: false, reason: string, hint?: string }`. User-facing `check(fn)` still accepts the ergonomic `true | string | { ok, reason, hint? }` and normalizes internally. The `hint` field is written to `StepEntry.validations[].hint` and ignored by Phase 6's executor — Phase 14 (Stop hook) will consume it as feedback text for the live Claude session.
   **Why:** the Stop-hook use case needs a place to put "here's what you still need to do" guidance distinct from "here's why it failed." Adding the field now costs one key in a type; omitting it now means a breaking change later.

## Deliverables

### Files

- `src/validators/validator.ts` — `Validator` interface, `ValidatorResult`, `ValidatorCtx`, `ValidatorServices`, `ValidationError` class.
- `src/validators/file-produced.ts` — `fileProduced(glob: string)` factory, uses `FsService.glob`.
- `src/validators/git-diff-created.ts` — `gitDiffCreated()` factory, reads `ctx.preRunSnapshot.headSha`, uses `GitService.diffSinceSha`.
- `src/validators/git-commit-created.ts` — `gitCommitCreated()` factory, compares current `headSha()` against `ctx.preRunSnapshot.headSha`.
- `src/validators/check.ts` — `check(fn)` anonymous factory with auto-name.
- `src/validators/define-validator.ts` — `defineValidator(name, fn)` named factory + module-level registry + `getValidator(name)` lookup.
- `src/validators/index.ts` — public barrel.
- `src/services/git/git-service.ts` — port with `headSha()`, `diffSinceSha(sha)`, `isClean()`.
- `src/services/git/real-git-service.ts` — adapter shelling out via `ProcessService`.
- `src/services/git/fake-git-service.ts` — scriptable fake.
- `src/services/git/index.ts` — barrel.
- `src/services/index.ts` — re-export git service types.
- `src/core/step.ts` — extend `StepConfig` with `validate?: Validator | ReadonlyArray<Validator>`.
- `src/core/workflow.ts` — capture `preRunSnapshot` before `runRunner`, run validators after success, aggregate failures into `ValidationError`, persist `validations` to `StepEntry`.
- `src/state/state-store.ts` — bump `schemaVersion` to 2, extend `StepEntry` type.

### Test fixtures / helpers

- `tests/helpers/temp-git-repo.ts` — creates a real temp git repo for integration tests (init, seed commit, cleanup).

## Tests (three layers per validator)

### Unit — validator logic against fakes

- `fileProduced`: matches on glob hit, fails with readable reason on empty match, handles empty glob pattern as programmer error, deals with missing cwd.
- `gitDiffCreated`: passes when `diffSinceSha(baseline)` returns non-empty, fails when empty, fails clearly when baseline is missing from ctx.
- `gitCommitCreated`: passes when current HEAD differs from baseline, fails when equal.
- `check(fn)`: return-shape normalization — `true` → ok, `false` → generic fail, `string` → fail with reason, `{ ok, reason, hint }` → fail with both, thrown exception → fail with error message; auto-name format `check@<step>#<index>`.
- `defineValidator(name, fn)`: registers into the registry, `getValidator(name)` retrieves it, duplicate-name registration throws a loud error.
- `ValidationError`: renders all failures in message, carries the structured `failures` array.

### Unit — executor wiring

- `workflow.run()` captures `preRunSnapshot.headSha` from `GitService` *before* `runRunner` is called (asserted via invocation order on the fake).
- Successful runner + passing validators: `StepEntry.validations` contains a result per validator, all `ok: true`.
- Successful runner + one failing validator: throws `ValidationError` with one failure, no `StepEntry` persisted (same pattern as `StepError`).
- Successful runner + multiple failing validators: throws `ValidationError` with *all* failures (proves no fail-fast).
- Validators do NOT run when the runner itself errored — `StepError` short-circuits first.
- Resume path: cached step entry returns its `value` without re-running validators (validators run once, at success time).
- `validate:` accepts both `Validator` and `Validator[]` forms — asserted produces the same executor behavior.

### Integration — real I/O

- `fileProduced` against a real temp dir (`BunFsService`): matches `**/*.md`, fails cleanly on an empty dir, handles nested matches.
- `gitDiffCreated` + `gitCommitCreated` against a real temp git repo (`tests/helpers/temp-git-repo.ts` + `RealGitService`): baseline snapshot, modify files, diff appears; commit, assert `gitCommitCreated` passes against the same baseline.
- Full pipeline: `FakeRunner` scripted to "succeed without touching files" → `workflow.run()` with `validate: fileProduced('out/*.txt')` against a real temp dir → `ValidationError` with the expected failure reason.
- Full pipeline: `FakeRunner` scripted to actually touch a file in the temp dir (via a side-effect in its script) → validators pass → `StepEntry.validations` persisted to disk, readable back via `FileStateStore`.

## Open Questions

None — the design is ready for planning.

## Resolved Questions

1. **GitService dependency ordering.** → Minimal GitService ships in Phase 6.
2. **Validator failure semantics.** → Aggregated `ValidationError`, all validators run, collect then throw.
3. **Validator `ctx` shape.** → Minimal `{ stepName, cwd, value }`; grows additively.
4. **Validator service DI.** → Factories close over services injected at workflow level.
5. **`gitDiffCreated` baseline timing.** → Snapshot HEAD before runner spawns, persist to `StepEntry.preRunSnapshot`.
6. **Persist validator outcomes to state.** → Yes, in `StepEntry.validations`; schema bumps to v2.
7. **Stop-hook readiness.** → Prepare both seams now (pure validators + persisted baselines + named registry). Ship no hook code.
8. **`check()` vs `defineValidator()`.** → Anonymous vs named+registered, same internal interface.
9. **Test layering.** → Three layers per validator (unit-fakes, unit-wiring, integration-real).
10. **Schema migration strategy.** → No migration code. Pre-production; bump `schemaVersion` to 2, reject v1 at load.

## Next Steps

→ `/workflows:plan` for the detailed implementation plan.
