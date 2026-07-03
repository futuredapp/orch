# round5 — consolidated acceptance review of all 20 Round-2 plans

Final read-only acceptance review over `feat/claude-orchestration` (28 commits ahead of `develop`, plans 007–026 all committed).
No source/test/doc/plan files touched; only this diary written. Ran no git-mutating commands.
Built on prior diaries: [[review-round3-builds]], [[review-round4-builds]], [[docs-sweep-023-024]], [[round5-readme-status-rows]], [[round5-full-gate]].

## Overall verdict

**NEEDS-FIX** — one blocking item, mechanical:

1. **`src/core/step.ts:16` biome lint regression (gate RED).**
   Line 16 is `import { SchemaValidationError, schema, type SchemaWrapper } from './schema.ts'`; biome `assist/source/organizeImports` requires `SchemaValidationError, type SchemaWrapper, schema`.
   Confirmed still present: `bunx biome check src/core/step.ts` → 1 error (FIXABLE, safe fix).
   Introduced by build-023 (added the `SchemaWrapper` type import; that worker ran typecheck only, never `bun run lint`).
   Already diagnosed in [[round5-full-gate]] but no fix has landed — the working tree still carries it, so `bun run check` (lint is stage 1, fails fast) cannot go green and the PR to `develop` must not open until it is fixed.
   Fix: `bun run lint:fix` (or hand-edit line 16 to the member order above), then re-run the full `bun run check` from the top — everything below lint (typecheck/unit/mocked-int/two-pane-lifecycle/check:migration) was never reached this round and must be exercised once, watching for the known real-tmux ~5s flake.

Everything else is acceptance-clean. Once the one-line lint fix lands and a full green gate is recorded, this flips to **SHIP**.

## Per-plan spot-check table (the nine lightly-cross-checked plans)

| Plan | Acceptance intent | Verdict | Evidence |
|------|-------------------|---------|----------|
| 008 | `orch status` prints failure section from lifecycle.ndjson; zero-step failed/crashed runs reach it; workflow.ts/state-store.ts untouched | **OK** | `printFailureSection`/`extractReason` in `src/cli/commands/status.ts`; footprint status.ts-only. Fully validated in [[review-round4-builds]]. |
| 011 | initRun/setArgs/setStatus all route through the write-queue | **OK** | `#enqueueWrite` wraps `initRun` (`src/state/state-store.ts:483`), `setArgs` (`:505`), `setStatus` (`:522`); saveStep also via `:441`. Scoped test green. |
| 012 | tests pin each mapResumeError exit-code branch | **OK** | `tests/unit/cli/map-resume-error.test.ts` pins CANNOT_RESUME (`:43,:48`), CONFIG_ERROR (`:53,:58`), STEP_FAILURE (`:63,:68`); pure classifier, no mocks. Green. |
| 015 | one shared flag-denylist guard used by both runners; behavior unchanged | **OK** | `makeFlagGuard` in `src/runners/flag-guard.ts` used by `claude-runner.ts:120` and `codex-runner.ts:90`, each passing its own denylist content; identical exact/`=`-prefix matching. Green. |
| 016 | tests assert Codex auth AND billing failures classify correctly | **OK** | `tests/unit/runners/codex/recovery.test.ts` adds 2 auth + 2 billing + a word-boundary negative; asserts against live `classify-error.ts` regexes. Validated in [[review-round3-builds]]. |
| 018 | `orch logs <prefix>` resolves a unique run; ambiguous/absent errors clearly | **OK** | `resolveRunId` in `src/cli/commands/logs.ts` uses `registry.findByPrefix`, mirrors status.ts 0/>1 messaging + CONFIG_ERROR; re-parses via `parseRunId` (no `as` cast). Validated in [[review-round3-builds]]. |
| 020 | duplicate step name in one scope throws a clear authoring error | **OK** | `assertNoExecutionCollision` gated on `kind === 'agent'` (`src/core/workflow.ts:1935`). The `kind: 'agent'` narrowing is **sound, not a gap** — single agent producer, reserved-prefix rejection, replay path never reaches it (fully re-derived in [[review-round3-builds]]). Command/ask arg-aliasing is pre-existing, out of plan-020 scope. Stop re-litigating. |
| 023 | `returns:` accepts a bare Zod schema as well as the wrapped `schema()` form | **OK** | `normalizeReturns` (`src/core/step.ts:~327`) wraps a bare Zod via `schema(...)`, passes a wrapper through; `AutonomousStepInput.returns: SchemaWrapper<T> \| ZodType<T>` (`:212`); compile-time `Expect<Equal<…, Step<…>>>` holds. Validated in [[review-round3-builds]]. *(This plan is also the source of the lint regression above.)* |
| 024 | `orch init` scaffolds a typed two-step handoff that typechecks (bare returns + permissions:'bypass') | **OK** | `STEPS_TEMPLATE`/`HELLO_WORKFLOW_TEMPLATE` in `src/cli/commands/init-templates.ts`: bare `returns: z.object(...)`, `permissions: 'bypass'` on both steps, typed `summary.topic`/`.factCount` flows into step 2. Validated in [[review-round4-builds]]; `bun run typecheck` → exit 0 this round. |

All nine acceptance lines are met by committed code. No acceptance-level CONCERN.

## Closeout-coherence checklist

| Signal | Result |
|--------|--------|
| `plans/README.md`: every Round-2 row 007–026 reads DONE, no TODO cell | **PASS** — `grep -in TODO plans/README.md` → zero hits; rows 008/011/012/015/016/018/020/023/024 all `DONE (2026-07-04)`, rest `DONE (2026-07-02)`, 021/026 keep their parenthetical notes. |
| No raw `--permission-mode` flags remain in `examples/` | **PASS** — `grep -rn permission-mode examples/` → zero hits. |
| Bare-Zod `returns:` form documented in public docs | **PASS** — `docs/public/reference/api.md:97,102,406` document the bare form as canonical + note both forms accepted (per [[docs-sweep-023-024]]). |
| `docs/public/guides/subworkflows.md` keeps wrapped form to match `examples/feature/index.ts` (accepted, documented choice) | **PASS (accepted)** — subworkflows.md:107/112 uses `schema(z.object(...))`, lockstep with `examples/feature/index.ts:18/27`. Not a defect; the examples→bare migration is the known deferred follow-up. |
| `bun run typecheck` (extra signal) | **PASS** — `tsc --noEmit` → exit 0. |
| `bun run check` gate green | **FAIL** — biome lint regression at `src/core/step.ts:16` (the blocking NEEDS-FIX item above). |

## What I verified (commands, all read-only, this branch)

- `bunx biome check src/core/step.ts` → **1 error** (organizeImports at line 16, FIXABLE). Gate blocker, still live.
- `bun test tests/unit/state/state-store.test.ts tests/unit/cli/map-resume-error.test.ts tests/unit/runners/flag-guard.test.ts` → **37 pass / 0 fail** (011/012/015).
- `bun run typecheck` → **exit 0**.
- `grep` confirmations: README rows (all DONE, no TODO), no `--permission-mode` in examples/, `#enqueueWrite` on all three state writers, `makeFlagGuard` used by both runners, api.md/subworkflows.md/examples returns-form coherence.
- Did NOT run `bun run check`, bare `bun test`, or any git command. Wrote only this diary.

## Left for later / risk

- **The lint fix is the only thing between here and SHIP.** It is one line and mechanical, but the whole gate below lint (typecheck already independently green here, but unit/mocked-int/two-pane-lifecycle/check:migration) has never run to completion in a single consolidated pass — the fix task must run a full green `bun run check` before the PR to `develop`, not just the lint fix.
- Deferred (not a blocker, tracked): migrate `examples/*` (`math-duel`, `compound`, `file-prompts-demo`, `feature`) to the bare `returns: z.object(...)` form; when that lands, re-check whether `subworkflows.md` should flip to bare too.
- Process note for the master: build-023 recorded typecheck-only verification and slipped a biome-assist regression past its scoped checks. Any source-touching worker that skips `bun run lint` risks the same; the consolidated gate is the only place it surfaces.
