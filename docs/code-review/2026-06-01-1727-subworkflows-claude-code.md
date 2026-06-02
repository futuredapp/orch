# Code Review — feat/subworkflows

- **Date:** 2026-06-01 17:27 (review run id `20260601-172742-cfca46a4`)
- **Branch:** `feat/subworkflows`
- **Diff base:** `638a4bf971bdf2648dd1faca24adabc1a068e0fc` (`0847b17^`)
- **HEAD at review:** `df306c4`
- **Scope:** 11 commits requested by the author (`1c59ad4`, `93050bf`, `005f2c5`, `8d32dc6`, `5314953`, `88889f0`, `e9f2b42`, `0a6a3e3`, `2ca360f`, `6e89ab5`, `0847b17`) — 55 files, ~4,750 LOC added.
- **Plan:** [`docs/plans/2026-05-28-003-feat-subworkflows-plan.md`](../plans/2026-05-28-003-feat-subworkflows-plan.md) (`plan_source: explicit` — auto-discovered from branch + plan filename match).
- **Mode:** report-only (output written to `docs/code-review/`); no auto-fix applied.

## Intent

Introduce `runWorkflow(executor, args)` so one workflow file can invoke another inline. One `runId`, one `RunState`, one log directory, one `captureLock`, one resume contract. Two deliberate departures from literal inline equivalence ship with v1: (1) `subworkflow:enter` / `subworkflow:exit` lifecycle events; (2) a fresh ALS frame on entry carrying copy-by-value `workflowCwd`, incremented `subworkflowDepth`, extended `subworkflowPath`. V1 also ships a depth bound (R21, default 8), a sub-aware step cache key (R9 / KTD §3), a `StepNameCollisionError` (R20), and the two-pane indented-gutter rendering (R22–R26).

## Reviewer team

| Reviewer | Why selected |
|---|---|
| `ce-correctness-reviewer` | always-on |
| `ce-testing-reviewer` | always-on |
| `ce-maintainability-reviewer` | always-on |
| `ce-project-standards-reviewer` | always-on |
| `ce-agent-native-reviewer` | always-on |
| `ce-learnings-researcher` | always-on |
| `ce-api-contract-reviewer` | new public exports (`runWorkflow`, error classes), generic `workflow<Args>`, new `StepLifecycleEvent` variants, lifecycle.ndjson wire shape |
| `ce-reliability-reviewer` | ALS frame push/pop, error propagation, host-error asymmetry, depth bound, status-loop event handling, resume reconstruction |
| `ce-adversarial-reviewer` | ~4,750 LOC diff, deep core-runtime feature touching state, ALS, parallel composition |
| `ce-kieran-typescript-reviewer` | heavy TypeScript work: generic `workflow<Args>`, module-private body handle, discriminated union extension, expect-type tests |

Personas skipped: `ce-security-reviewer` (no auth/user-input/permission boundaries touched), `ce-performance-reviewer` (no DB/cache hot paths), `ce-data-migrations-reviewer` (no DB migrations), `ce-previous-comments-reviewer` (no GitHub PR), `ce-julik-frontend-races-reviewer` (no Stimulus/Turbo; Ink UI covered by maintainability and adversarial), `ce-schema-drift-detector` / `ce-deployment-verification-agent` (not applicable).

---

## Findings

### P0 — Critical

| # | File:line | Issue | Reviewer(s) | Conf | Route |
|---|---|---|---|---|---|
| 1 | `src/core/run-workflow.ts:115` | Host throwing on `subworkflow:enter` is not wrapped; the symmetrical `host-error` record promised by the union (`source: 'subworkflow:enter'`, see `workflow.ts:212`) is never produced. Lifecycle.ndjson is left with an open-ended `enter` (no matching `exit`, no `host-error`). The two-pane projector then shows the sub as perpetually running; the plain host has emitted nothing; an autonomous agent tailing the log has no signal that the sub aborted before it ran. The exit-emit path (lines 140-158) handles the symmetrical case correctly — the fix is to apply the same try/catch shape to the enter-emit. | correctness, agent-native | 100 | `safe_auto → review-fixer` (requires verification: add a unit test in `run-workflow.test.ts` that throws from `emitLifecycle` on enter and asserts `lifecycle.ndjson` contains a `host-error` record + a synthetic exit) |

### P1 — High

| # | File:line | Issue | Reviewer(s) | Conf | Route |
|---|---|---|---|---|---|
| 2 | `src/core/parallel.ts:177-195` | `branchStore` propagates `subworkflowDepth`, `subworkflowPath`, `homogeneousBranch`, and `maxSubworkflowDepth`, but **not** `subCallId`. Any step that runs inside a `parallel()` branch nested inside a sub is persisted with `subCallId: undefined`. R20 case-b (same-sub-invoked-twice) compares `priorSubCall !== subCallId`; when both are `undefined` the guard silently no-ops. Resume round-trip also loses the field for those steps. | correctness | 75 | `safe_auto → review-fixer` (forward `parent.subCallId` and `parent.insideParallel` into `branchStore`; add a test that asserts `StepEntry.subCallId` for a step executed under `parallel()` inside `runWorkflow`) |
| 3 | `src/core/parallel.ts:119` (heterogeneous form) | `parallel([runWorkflow(A,{}), runWorkflow(B,{})])` — JS eagerly evaluates the array, so each `runWorkflow` call enters its sub frame in the **parent's** ALS frame where `currentParallelDepth() === 0`. Consequences chain across four surfaces: (a) `insideParallel` is never set, so plain-host suppression at `plain-host.ts:238` fails and the divider is emitted as if sequential; (b) two-pane suppression (`project-steps-view.ts:120-132`) sees `insideParallel === undefined` on the overlay and renders boundary rows as sequential; (c) `subworkflow:enter` records wire-precede `step:parallel-start` in `lifecycle.ndjson`; (d) `StepEntry.insideParallel` is never persisted, so resume can't recover the parallel composition. Documented limitation for the heterogeneous form already exists for branch-update events (`workflow.ts:144-148`) but was never reconciled with `runWorkflow`. | adversarial | 100 | `manual → human` (recommended fix: hard-error when any heterogeneous-form element is a `runWorkflow` promise, *or* explicitly document that `runWorkflow` requires the homogeneous `parallel(items, fn)` form, *or* accept the divergence and document each affected surface) |
| 4 | `src/core/workflow.ts:1569, 1578` | `fn as unknown as WorkflowFn` double-cast in `execute()` and `resume()` turns off the type checker for the top-level CLI path. A `workflow<{ prompt: string; slug: string }>` invoked via `orch run` receives `deps.args ?? {}` where the body reads `args.slug` as `undefined` while TypeScript believes it is `string`. The dual-role limit is real (the CLI cannot type args at startup), but the current cast hides the unsoundness instead of documenting it at a single call boundary. | kieran-typescript (P1) + project-standards (P2) + maintainability (P3) | 100 (3-way agreement) | `manual → review-fixer` — make `executeWorkflowFn` generic and narrow the unsoundness to `?? ({} as Args)` at the call boundary; both lines use the same shape |
| 5 | `docs/public/reference/api.md:17` | The primary `## workflow` section still shows `function workflow(name: string, fn: (run: RunFn, args: WorkflowArgs) => Promise<void>): WorkflowExecutor` — the pre-generic form. The generic form is documented only in a separate `## workflow (generic Args)` section. Readers reading the top-level signature won't discover the `Args` parameter. CLAUDE.md rule: "After any change to the public barrels … reconcile `docs/public/reference/api.md` … so the signatures still match." | project-standards (P1) + api-contract (P2) | 100 (cross-reviewer) | `safe_auto → review-fixer` — replace the primary signature block with the generic form, note the default `Args = WorkflowArgs`, fold or cross-reference the secondary section |
| 6 | `.claude/skills/orch-workflow-author/SKILL.md:264`, `.claude/skills/orch-workflow-author/references/api.md:252` | The agent-facing skill omits `runWorkflow`, `workflow<Args>`, `WorkflowExecutor<Args>`, `StepNameCollisionError`, and `SubworkflowDepthError`. An agent asked to "extract a multi-step chain into its own file and call it from the parent" will produce the old inline pattern because the skill context has no knowledge that `runWorkflow` exists. The skill files are part of this diff (the skill was revisited) but the additions were not made. | agent-native (P1) + api-contract (P3) | 100 (cross-reviewer) | `safe_auto → review-fixer` — extend the SKILL.md "Public API at a glance" table and add a `runWorkflow` block + the two new errors to `references/api.md` mirroring `docs/public/guides/subworkflows.md` |
| 7 | `src/observability/status-loop.ts:137-153` + `src/hosts/two-pane/lifecycle-choreographer.ts` | `applyEvent` filters the three new event types via `if`-guards before its switch, but the switch has no `default: never` exhaustiveness arm. `lifecycle-choreographer.ts` was not modified in this diff at all — it uses a chain of `if` blocks and silently falls through for the new variants. The plain-host `textLifecycle` / `jsonLifecycle` (workflow.ts) do exhaustive switches correctly; these two consumers don't. Future `StepLifecycleEvent` additions will silently fall through. | api-contract (P1) + kieran-typescript (P2) | 100 (cross-reviewer) | `gated_auto → review-fixer` — add `default: { const _exhaustive: never = event; throw new Error(...) }` to both consumers; today's narrowed types already make this compile cleanly |
| 8 | `src/hosts/two-pane/steps-view/steps-view.tsx:61` | `stepNameBudget` and `boundaryNameBudget` are byte-for-byte identical; the comment on the latter acknowledges they're mathematically the same. Dead duplicate. | maintainability | 100 | `safe_auto → review-fixer` — delete `boundaryNameBudget`, update callers to `stepNameBudget` |
| 9 | `src/hosts/two-pane/steps-view/{project-steps-view,steps-view-hooks,steps-view,right-pane-controller}.{ts,tsx}` | Four files each independently re-declare `SelectableStepRow = Exclude<StepRow, { kind: 'subworkflow-enter' | 'subworkflow-exit' }>` and a matching type-guard under four different names (`isStepRow`, `isSelectable`, `isSelectableRow`, `isSelectableStepRow`). All four bodies are identical. | maintainability | 100 | `safe_auto → review-fixer` — define once in `step-types.ts`, re-export via the barrel, replace the four local copies |
| 10 | `src/hosts/plain/plain-host.ts:238` | Subworkflow dividers render as `── ▶ subworkflow: <name> ──` with no depth integer. The JSON branch emits `depth`, but the text branch (the format CI / log-tail consumers actually read) cannot be parsed back into nesting structure: a flat pair of sibling sub calls is indistinguishable from a nested pair. The two-pane host conveys depth through gutter indentation; the plain equivalent is the depth integer. | agent-native | 75 | `safe_auto → review-fixer` — render `── ▶ subworkflow[${event.depth}]: ${event.name} ──`; no semantic change to JSON or lifecycle.ndjson |
| 11 | `src/core/errors.ts:80-140` (`StepNameCollisionError`) | The error names only the colliding `stepName` (e.g. `plan`), not the sub executor name. When a workflow author inadvertently invokes the same sub from two sibling parallel branches, the user-visible diagnostic on the plain-host stdout says "Step 'plan' collides" instead of "same sub 'simple-feature' invoked twice." | agent-native | 75 | `manual → review-fixer` — include the sub name (e.g. `priorSubPath` tail) in the message, or detect "same executor twice from parallel" inside `runWorkflow` before any steps run, where the executor name is in scope |
| 12 | `tests/unit/core/run-workflow.test.ts` (AE2) | Copy-by-value `workflowCwd` isolation (`run-workflow.ts:82-101`) is verified at the `execution-context.ts` unit level but never through the actual `runWorkflow → setWorkflowCwd → parent observes old cwd` chain. A change that referenced the live store instead of copying would silently break the ALS contract without any failing test. | testing | 75 | `manual → review-fixer` — add a behavioral test exercising the chain |
| 13 | `tests/unit/core/run-workflow.test.ts` (AE4) | Resume-replay of sub-path-keyed steps is the primary cache-correctness contract of the feature. `deriveStepKey` and `runStepOnce` unit tests verify key derivation, but no test calls `executor.resume()` against a pre-populated state file containing `simple-feature>plan` entries and asserts the runner is not re-invoked. | testing | 75 | `manual → review-fixer` — add resume test with a `RunState` fixture |
| 14 | `tests/unit/core/run-workflow.test.ts` (AE6 / AE7 partial) | `depth: 1` and `insideParallel: true` on enter are tested, but the "each branch's sub can call `setWorkflowCwd()` without tripping the parallel-depth guard" contract (homogeneous propagation) is not exercised end-to-end. Similarly AE7 is covered at the raw ALS-frame level but not through actual `parallel() + runWorkflow(sub) + setWorkflowCwd`. | testing | 75 | `manual → review-fixer` — add e2e behavioral tests |

### P2 — Moderate

| # | File:line | Issue | Reviewer(s) | Conf | Route |
|---|---|---|---|---|---|
| 15 | `src/core/workflow.ts:1` | File grew 1,435 → 1,581 lines. CLAUDE.md rule 5 requires a top-of-file comment when the 300-line warning is exceeded. `run-workflow.ts:31` correctly explains why it was extracted, but `workflow.ts` itself has no such comment. | project-standards | 75 | `safe_auto → review-fixer` |
| 16 | `src/core/index.ts:31` | New public functions `currentSubworkflowDepth`, `currentSubworkflowPath`, `isInsideParallel` are exported from `execution-context.ts` but absent from the barrel. CLAUDE.md rule 7. | project-standards | 75 | `safe_auto → review-fixer` |
| 17 | `src/hosts/two-pane/steps-view/index.ts:36` | `applySubworkflowEvent` is exported via the barrel but its parameter type `SubworkflowEvent` is not, so external callers cannot type the argument without a barrel-violating import. | maintainability | 75 | `safe_auto → review-fixer` |
| 18 | `src/hosts/two-pane/steps-view/project-steps-view.ts:1` (193 → 375), `steps-view.tsx:1` (563 → 687) | Both files now exceed CLAUDE.md's 300-line warning with no rule-5 explanation comment. | maintainability | 75 | `safe_auto → review-fixer` — at minimum add the rule-5 comment; consider extracting the boundary-row projection helpers from `project-steps-view.ts` |
| 19 | `src/core/workflow.ts:418`, `tests/unit/core/derive-step-key.test.ts:8` | `deriveStepKey` was made `export` and is imported directly from `src/core/workflow.ts` by the test, bypassing the barrel (CLAUDE.md rule 7). Either keep it unexported and test indirectly via `runStepOnce`, or document with `/** @internal */`. | project-standards + api-contract + maintainability (3-way) | 100 (cross-reviewer) | `manual → review-fixer` |
| 20 | `src/cli/commands/load-workflow.ts:20` (`isExecutorShape`) | The runtime guard checks only `'execute' in v && 'resume' in v`. A hand-crafted object would pass and crash later when `runWorkflow` reads `executor[bodyHandle]` (undefined → "not a function"). The CLI's `execute(deps)` path is fine, but `runWorkflow` itself is public — a consumer calling it with a hand-built object hits this. | api-contract | 75 | `manual → review-fixer` — import `bodyHandle` and add `bodyHandle in v` to the predicate, or document why the symbol check is omitted |
| 21 | `src/core/workflow.ts:1547` | New `WORKFLOW_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/` rejects names containing `:` or `>` at the `workflow()` call site (a throw at module load time). External consumers who registered such names previously will now fail to load. Allowed pattern is not documented in `docs/public/reference/api.md`. | api-contract | 50 (suppressed by gate; called out here for visibility because it affects every workflow author) | `manual → human` |
| 22 | `src/core/types.ts:41` | `STEP_NAME_PATTERN` widened (`>` added) and `MAX_STEP_NAME_LENGTH` raised from 128 → 512. `StepName` is a branded type in the public barrel; external code assuming the prior 128-cap or character set will see silent behavioral changes. The change is necessary for internally-generated sub-path keys (`simple-feature>plan`) but the public-facing brand has been widened without a docs note. | api-contract | 75 | `manual → downstream-resolver` — add a note in api.md explaining that internally-generated sub-path keys extend the character set and 512-char cap |
| 23 | `src/hosts/plain/plain-host.ts:272` (`jsonLifecycle`) | `subworkflow.enter` / `subworkflow.exit` JSON records drop the `insideParallel` flag entirely. An agent watching the NDJSON stream cannot distinguish three sequential invocations from three parallel-suppressed ones; the `step:parallel-start` block has a `blockId` but the subworkflow events don't carry it either. Combined with finding #3, JSON consumers have no reliable signal for inside-parallel composition. | adversarial | 100 | `manual → downstream-resolver` — extend `jsonLifecycle` to carry `insideParallel` (and optionally the enclosing block id) |
| 24 | `src/core/workflow.ts:1301-1310` | Cache-hit short-circuit returns the wrong value when `overrides.as` is used to share a key across sub-paths. `deriveStepKey` (line 426) deliberately bypasses sub-folding when `as:` is set. On a cold cache from disk, `keysWrittenThisExecution.has(key)` is `false`, so the collision guard at line 1301 is skipped, the cached entry's `subPath: []` mismatches the current `subPath: ['feature']`, but line 1310 short-circuits and returns the root's cached value to the sub's call site. Documented as "authoring opt-out" at line 425, but the doc undersells the risk. | adversarial | 50 (suppressed by confidence gate; flagged here for visibility) | `manual → downstream-resolver` — add a public-guide warning that `as:` overrides bypass sub isolation |
| 25 | `src/core/workflow.ts:1301` (parallel same-sub race) | The collision guard requires both `keysWrittenThisExecution.has(key)` (in-memory) **and** `cached !== undefined` (disk) simultaneously. In concurrent homogeneous-parallel branches, T-2's `loadRun()` can complete before T-1's `saveStep` + `keysWrittenThisExecution.add(key)`. Both branches then write the same key with last-writer-wins semantics rather than throwing. The plan calls same-sub-in-parallel a v1 usage error, but the actual failure mode is silent state corruption rather than a guaranteed crash. | reliability | 75 | `manual → human` — either tighten to a synchronous registration (mint the key before the await chain) or document the silent-overwrite risk in the public guide |
| 26 | `tests/unit/core/run-workflow.test.ts` (R17) | Every `makeDeps()` omits `logger`, so `loggerRef` is `undefined` in the sub-frame and every `void parent.loggerRef?.append(…)` call is a no-op. The lifecycle.ndjson write path — including the R10 `host-error` synthesis — is entirely dead in the unit suite. | testing | 75 | `manual → review-fixer` — wire a fake `logger` into `makeDeps()` and assert the appended records |
| 27 | `tests/unit/core/workflow-typing.test-d.ts` (AE5) | The plan's AE5 requires a compile-time error when `runWorkflow(s, { prompt: 'x' })` omits a required `Args` field. The behavioral test in `run-workflow.test.ts:190` verifies runtime arg passing only; no `@ts-expect-error` covers the missing-arg case. The comment in `workflow-typing.test-d.ts` saying "runWorkflow typing is covered in U5's tests" is unfulfilled. | testing + kieran-typescript | 100 (cross-reviewer) | `manual → review-fixer` — add `tests/unit/core/run-workflow-typing.test-d.ts` |
| 28 | `tests/unit/hosts/two-pane/steps-view/subworkflow-parallel-suppression.test.ts` (AE9 / AE13) | Plan AE9 and AE13 both call for a `lifecycle.ndjson` assertion in addition to the projector snapshot. The test header explicitly says "no `lifecycle.ndjson` re-read." | testing | 75 | `manual → review-fixer` |
| 29 | `src/hosts/two-pane/steps-view/live-overlay.ts:100` (`applySubworkflowEvent`) | No dedicated unit test. `applyLifecycleEvent` has its own test file; the new sibling does not. The enter/exit branching, `insideParallel` propagation on exit, and invalid-event guard are covered only transitively through `projectStepsView`. | testing | 75 | `manual → review-fixer` |
| 30 | `tests/unit/core/run-workflow.test.ts:157` | The `SubworkflowDepthError` test verifies the message but not that the run's `terminalStatus === 'crashed'` (rather than `'failed'`), which is the intentional classification per the comment at `run-workflow.ts:60-61`. | testing | 75 | `safe_auto → review-fixer` |
| 31 | `src/hosts/two-pane/pane-map/right-pane-controller.ts:887` | `lookupStep` applies `isSelectableStepRow` twice on the same value; the second guard is unreachable because `.find()` already filtered. | maintainability | 75 | `safe_auto → review-fixer` |

### P3 — Low (kept; remainder suppressed by the confidence gate, see Coverage)

| # | File:line | Issue | Reviewer(s) | Conf | Route |
|---|---|---|---|---|---|
| 32 | `src/core/workflow.ts:348` (`bodyHandle`) | The "module-private" body handle is reachable via (a) `Reflect.ownKeys(executor)` — symbols are not hidden from this — and (b) deep import `import { bodyHandle } from 'orch/src/core/workflow.ts'`. The barrel hides it from typical consumers, but it's a convention rather than a language-level guarantee. KTD #2 acknowledges this as a soft constraint. | adversarial + kieran-typescript | 100 (cross-reviewer) | `advisory → human` — note in the file header; consider an ESLint rule banning deep imports of `src/core/workflow.ts` outside `src/core/run-workflow.ts` |
| 33 | `src/hosts/two-pane/steps-view/live-overlay.ts:100` (overlay key) | `subOverlay` is keyed by sub `name`. In the heterogeneous-parallel footgun (finding #3) two parallel `runWorkflow(ship, {})` calls produce two `subworkflow:enter` events for `name='ship'`; the second overwrites the first's overlay record including `startedAt`. The visible bug only manifests in that path (in the homogeneous form boundary rows are suppressed), but consider keying on `subCallId` once finding #3 is resolved. | adversarial | 75 | `advisory → human` |
| 34 | `src/hosts/two-pane/steps-view/steps-view.tsx:260` | If a root step and a sub share the same `name` (workflow names use the same alphabet as step names), `state.steps.find(s => s.name === selectedName)` matches both rows. Whichever sorts first wins; if the boundary row sorts first, pressing Enter on the highlighted root step becomes a no-op (the boundary row is then filtered by `isSelectableRow`). | adversarial | 50 (suppressed) | flagged for transparency |
| 35 | `src/hosts/two-pane/steps-view/project-steps-view.ts:160` | Intermediate sub-close in `buildRows` can transiently render `✗` for a sub whose exit event hasn't yet folded into `subOverlay`, where the trailing-close path correctly gates on `subOverlay.get(name)?.status !== 'running'`. | correctness | 50 (suppressed) | flagged |
| 36 | `src/core/run-workflow.ts:89` (resume subCallId drift) | On resume, the body re-runs and mints a fresh `subCallId` for the new sub frame. Cached step entries retain the prior `subCallId`; only fresh-execution entries inside that sub get the new id. No v1 consumer correlates by `subCallId`, but a future log analyzer would see one logical invocation as two. | adversarial + correctness | 75 (cross-reviewer) | `advisory → human` — document the resume limitation |
| 37 | `src/core/execution-context.ts:48` (vocabulary aliasing) | ALS field is `subworkflowPath`; persisted on `StepEntry` as `subPath`; read in `collectRecords` as `rec.subPath`. The two-name split is the exact homonym hazard documented in `docs/solutions/two-pane-auto-attach.md`. | learnings | 75 | `safe_auto → review-fixer` — add a one-liner on the ALS field pointing at the persisted spelling |

---

## Requirements completeness (vs `docs/plans/2026-05-28-003-feat-subworkflows-plan.md`)

Plan source: **explicit** (plan filename matched `docs/plans/2026-05-28-003-feat-subworkflows-plan.md`; status frontmatter reads `completed`).

**Requirements (R1–R26, see Requirements Traceability table):**

| ID | Status | Notes |
|---|---|---|
| R1 — `runWorkflow` exported | ✅ met | `src/core/run-workflow.ts`, re-exported via `src/core/index.ts` |
| R2 — outside-scope guard | ✅ met | mirrors `setWorkflowCwd` ALS-absence pattern |
| R3 — `Promise<void>` return | ✅ met | |
| R4 — generic `workflow<Args>` | ✅ met (but see #4 — double cast in execute/resume) |
| R5 — compile-time arg typing | ⚠️ partially met | runtime is verified; AE5 compile-time test missing (#27) |
| R6 — `Args extends WorkflowArgs` | ✅ met | |
| R7 — shared `RunState.steps` | ✅ met | |
| R8 — shared singletons | ✅ met | |
| R9 — sub-aware cache key | ⚠️ partially met | `as:` override bypasses sub isolation (#24) and is undersold in docs |
| R10 — error propagation + host-error asymmetry | ⚠️ **enter-side gap** | exit path implements `host-error` synthesis correctly; the enter path does not (#1, P0) |
| R11 / R12 — cwd frame isolation | ✅ met (but cwd-leak behavioral test missing — #12) |
| R13 — parallel-guard inheritance | ⚠️ partially met | homogeneous form correct; heterogeneous form silently drops `insideParallel` (#3) |
| R14 / R15 — lifecycle events + depth | ✅ wire format; ⚠️ plain text omits depth (#10), JSON omits insideParallel (#23) |
| R16 — plain-host divider; suppress in parallel | ⚠️ partially met | heterogeneous form does not suppress (#3) |
| R17 — lifecycle.ndjson records | ✅ implemented; ⚠️ unit-tested only via mock-less paths (#26) |
| R18 — sub doesn't know it's a sub | ✅ met |
| R19 — same `WorkflowExecutor` shape | ✅ met; ⚠️ `bodyHandle` is convention-private, not language-private (#32) |
| R20 — `StepNameCollisionError` pre-`saveStep` | ⚠️ partially met | parallel branches lose `subCallId` (#2); concurrent-parallel race window (#25) |
| R21 — `SubworkflowDepthError` | ✅ met |
| R22–R26 — two-pane gutter | ✅ met |

**Acceptance criteria (AE1–AE13):** see findings #12, #13, #14, #27, #28. AE3, AE8, AE10, AE11, AE12 are fully covered. AE1, AE2, AE4, AE5, AE6, AE7, AE9, AE13 are partial (assertions present but missing the explicit observable each AE was written to nail down).

---

## Learnings & past solutions

From `docs/solutions/` and `docs/findings/`:

- **`docs/solutions/two-pane-auto-attach.md`** — homonym hazard. The `subworkflowPath` (ALS) vs `subPath` (`StepEntry`) split is exactly the two-names-for-one-thing pattern that burned the previous feature. Not a bug today; covered by #37.
- **`docs/findings/2026-05-25-issue-2-selection-out-of-sync-with-right-pane.md`** — the subworkflow work *ships* this fix as part of U8 (`committedFromView` in `steps-view-hooks.ts:118`). Good.
- **`docs/findings/2026-05-25-issue-1-left-pane-blanks-on-nav.md`** — boundary rows are real terminal lines and contribute to the `viewportRows` overflow regime that triggers Ink's `clearTerminal`. Subworkflows widen the set of workflows that hit Issue 1's flicker (especially nested subs). Issue 1 remains unfixed; subworkflows do not regress it qualitatively but quantitatively expose more runs.
- **`docs/findings/2026-05-25-issue-3-swap-pane-cant-find-pane.md`** — unchanged by this work. `right-pane-controller.ts:887` `lookupStep` does project without `subOverlay`, but this is not a live bug today (boundary rows are reconstructed from `StepEntry.subPath`); call out for future maintainers.
- **`docs/findings/2026-05-20-behavioral-batch-findings.md` F-4** — the Issue 2 fix shipped here also resolves F-4's "startup highlight invisible" precondition. New behavioral tests asserting startup highlight no longer need the arrow-key preamble.

---

## Agent-native gaps

The plain-host text format is the surface autonomous agents and CI consumers read most often. Two specific gaps:

- **Depth invisible in text dividers** (#10) — nested vs sibling subs are indistinguishable.
- **`insideParallel` invisible in JSON** (#23) — JSON consumers cannot distinguish sequential from parallel-suppressed subs.

Combined with finding #3 (heterogeneous parallel breaks the `insideParallel` plumbing across four surfaces), the parallel-composition story is the weakest agent-native surface in this landing.

The skill (#6) is the biggest agent-native gap by impact — agents using `orch-workflow-author` won't reach for `runWorkflow` because the skill doesn't know it exists.

---

## Coverage

- **Reviewers run:** 10 of 10 returned results (correctness, testing, maintainability, project-standards, agent-native, learnings, api-contract, reliability, adversarial, kieran-typescript). No timeouts or failed dispatches.
- **Confidence-gate suppressions:** ~6 findings suppressed at anchor 50 (P2/P3); none at anchor 25 except adversarial's "subworkflowOverlay disk-order race" (anchor 25, P3). Findings #21, #24, #34, #35 are surfaced for transparency despite the suppression because they touch behavior an author/agent could trip into.
- **Mode-aware demotion:** 0 findings demoted (most P2/P3 advisory items had cross-reviewer support or weren't testing/maintainability-only).
- **Untracked files:** none excluded — `git ls-files --others --exclude-standard` was clean at the start.
- **Per-agent JSON artifacts:** `/tmp/compound-engineering/ce-code-review/20260601-172742-cfca46a4/` (`correctness.json`, `testing.json`, `maintainability.json`, `project-standards.json`, `api-contract.json`, `reliability.json`, `adversarial.json`, `kieran-typescript.json`). Agent-native and learnings returned unstructured prose (per spec).

### Residual risks called out across reviewers

- Same sub invoked from sibling parallel branches: race window between disk read and in-memory set means last-writer-wins rather than a guaranteed `StepNameCollisionError` (#25).
- `bodyHandle` is convention-private — `Reflect.ownKeys` and deep imports reach it (#32).
- Heterogeneous `parallel([runWorkflow(...), runWorkflow(...)])` silently mis-reports parallel composition across four surfaces (#3); plan-level decision needed (hard-error vs document).
- The "inline-equivalence" contract at `run-workflow.ts:24-28` is true at runtime/state/captureLock but creates deliberate divergences at the rendering and observability layers — public guide should state this explicitly.
- The deferred `{ stepPrefix }` overload — v1 ships the rendering infrastructure for parallel composition but the canonical use case (same sub, different args) is blocked by R20. The `ship-many` example dodges this with two different subs; users will discover the limit only when they try the obvious pattern.
- Schema bomb: pre-sub state files load cleanly (new fields are `.optional()`) but `schemaVersion` is unchanged — no way to distinguish "old run, no sub fields" from "new run, sub fields all-absent."

### Testing gaps not yet ticketed elsewhere

- No SIGKILL-mid-`runWorkflow` integration test (plan's Risk Analysis flagged this).
- No disk-order test for `lifecycle.ndjson` under concurrent enter/exit with fire-and-forget appends.
- No regression test that the resume path does **not** throw `StepNameCollisionError` on the second invocation of the same sub (the intentional resume-path exception).

---

## Verdict

**Not ready to merge** — one P0 (#1, host-throw on `subworkflow:enter` leaks lifecycle.ndjson + breaks UI) and three substantive P1s touching the parallel/sub composition story (#2 lost `subCallId`, #3 heterogeneous-parallel mis-reports, #4 generic-cast unsoundness).

Suggested order:

1. Fix #1 (apply the same try/catch shape used at `run-workflow.ts:140-158` to the enter-emit at line 115). Add the regression test.
2. Decide #3 — the cleanest fix is a hard-error in `runWorkflow` when `currentParallelDepth() === 0` but the caller is reachable from `parallelHeterogeneous`. Failing that, document loudly. This drives several P2s (#23, and the cross-reviewer agreement on #33).
3. Fix #2 (`subCallId` + `insideParallel` propagation in `branchStore`). Add the persistence-round-trip test.
4. Fix #4 (`fn as unknown as WorkflowFn` cast — make `executeWorkflowFn` generic).
5. Reconcile #5 (api.md generic signature) and #6 (skill).
6. The remaining P1s (`#7-#14`) are mechanical or scoped test additions.
7. The maintainability P1/P2 cluster (#8, #9, #15-#18, #31) can be batched as a follow-up cleanup if needed; they don't block correctness.

The implementation is broadly aligned with the plan and acceptance criteria — most issues are gaps at the seams between the new feature and adjacent systems (parallel composition, type erasure at the CLI boundary, skill/docs reconciliation). Once #1–#4 land, the rest is straightforward.
