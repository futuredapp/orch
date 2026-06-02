---
date: 2026-06-01
type: code-review-resolution-plan
status: proposed
source_reviews:
  - docs/code-review/2026-06-01-1727-subworkflows-claude-code.md
  - docs/code-review/2026-06-01-1729-subworkflow-implementation-codex.md
---

# Subworkflow Review Resolution Plan

## Summary

The two reviews agree that the `runWorkflow` implementation is close to the
planned shape, but the remaining risk is concentrated in three areas:

1. Runtime correctness around lifecycle logging, `subCallId`, and resume
   collision detection.
2. The unresolved semantics of `runWorkflow` inside the heterogeneous
   `parallel([promise, promise])` form.
3. Two-pane projection identity: live-only rows and repeated leaf subworkflow
   names are keyed too loosely.

This plan intentionally does not route every comment to immediate code. Some
comments are mechanical and should be fixed; a few are policy decisions that
should be isolated before implementation; several low-impact comments should be
handled only when the touching phase is already in the same area.

## Triage Rules Used

- **Fix immediately** when the issue can corrupt run state, hide a crash, or
  make resume return the wrong value.
- **Isolate as a decision** when fixing the review comment would change public
  authoring semantics rather than repair an implementation gap.
- **Batch with nearby work** for docs, missing tests, barrel exports, and
  maintainability comments that do not change runtime behavior.
- **Defer** advisory findings when the affected path depends on an already
  unsupported or unresolved scenario.

Review ids below use:

- **CC#** = finding number in
  `2026-06-01-1727-subworkflows-claude-code.md`.
- **CX#** = finding order in
  `2026-06-01-1729-subworkflow-implementation-codex.md`.

## Phase 1 - Runtime Correctness Blockers

**Goal:** Make subworkflow execution and resume safe enough that later UI/docs
work is not building on incorrect state.

**Why first:** These findings affect `RunState`, `lifecycle.ndjson`, and cached
step return values. They can produce silent wrong behavior or an unbounded UI
state, so they are higher leverage than docs or cleanup.

**Selected findings:**

| Finding | Decision | Notes |
|---|---|---|
| CC#1 host throw on `subworkflow:enter` leaves no `host-error` / exit | Fix | Critical observability gap. Mirror the existing exit-side `host-error` shape and add a regression that verifies `lifecycle.ndjson`, not only host calls. |
| CC#2 `parallel()` branch store drops `subCallId` | Fix | Small implementation change with high correctness value. Also propagate any missing branch-frame fields found by the test. |
| CC#4 generic workflow cast unsoundness | Fix | Narrow the unavoidable CLI args unsoundness to one call boundary instead of double-casting the workflow body. This is local and improves future type work. |
| CX#2 repeated subworkflow calls after resume return cached value | Fix | Same domain as CC#2 and CC#25. Resume should not weaken the documented duplicate-sub guard. |
| CC#26 unit suite does not exercise `loggerRef` lifecycle writes | Fix with tests | Needed to make CC#1 test meaningful. Wire a fake logger into `makeDeps()` or add a focused logger-backed fixture. |
| CC#30 depth error classification only checks message | Fix with test | Cheap guard that `SubworkflowDepthError` remains `crashed`, matching the plan. |

**Implementation guidance:**

- Prefer tests first for each bug because the code already has nearby unit
  suites: `tests/unit/core/run-workflow.test.ts`,
  `tests/unit/core/parallel-inherits-subworkflow-fields.test.ts`, and
  `tests/unit/core/run-step-once-collision.test.ts`.
- For the resume collision fix, avoid a broad state-store redesign. A good
  solution should make cached same-path entries participate in the duplicate
  sub-call check without treating ordinary resume cache hits as collisions.
- Treat CC#25's same-sub parallel race as a related risk, but do not solve it
  with a large locking abstraction in this phase. If a small synchronous
  key-registration guard falls out naturally, take it; otherwise document the
  remaining race in the phase handoff.

**Verification:**

- `bun test tests/unit/core/run-workflow.test.ts`
- `bun test tests/unit/core/parallel-inherits-subworkflow-fields.test.ts`
- `bun test tests/unit/core/run-step-once-collision.test.ts`
- `bun run typecheck`

**Exit criteria:**

- Host failure on subworkflow enter is represented in lifecycle logs.
- `subCallId` survives homogeneous parallel branch frames.
- Resume cannot silently replay the first invocation for a second subworkflow
  invocation that should collide.
- The workflow generic cast is localized and documented at the CLI args
  boundary.

## Phase 2 - Parallel Composition Policy

**Goal:** Decide and encode the v1 contract for `runWorkflow` inside
heterogeneous `parallel([...])`.

**Why separate:** CC#3 is important, but it is not a simple bug fix. JavaScript
eagerly evaluates `parallel([runWorkflow(a, {}), runWorkflow(b, {})])`, so
`runWorkflow` has already entered before `parallel()` can mark a branch. A real
fix may require an API shape change, a lazy wrapper, or an explicit unsupported
case. That is a product/API decision, not a drive-by patch.

**Selected findings:**

| Finding | Decision | Notes |
|---|---|---|
| CC#3 heterogeneous parallel mis-reports subworkflow composition | Decision required | Choose one: documented unsupported v1 behavior, hard-error via a new lazy API, or accept divergence. Do not sneak in partial behavior. |
| CC#23 plain JSON omits `insideParallel` | Fix after decision | If heterogeneous remains unsupported, still add `insideParallel` for the supported homogeneous path because JSON consumers need parity with text/two-pane. |
| CC#25 same-sub parallel race window | Decide scope | If v1 says same-sub-in-parallel is an authoring error, the implementation should fail consistently or docs must state the remaining race. |
| CC#33 overlay keyed by name in heterogeneous footgun | Defer unless decision supports it | This is mostly a symptom of CC#3 and Phase 3 identity work. |

**Recommended path:**

For v1, keep the public contract conservative:

- State that `runWorkflow` is supported in sequential code and in the
  homogeneous `parallel(items, fn)` form.
- State that heterogeneous `parallel([runWorkflow(...), ...])` is unsupported
  because the promises are created before `parallel()` owns the branch frame.
- Add tests/docs around the supported homogeneous case rather than trying to
  infer the author's intent after eager evaluation.

If the project wants ergonomic heterogeneous composition, create a follow-up
design for a lazy form rather than changing this branch opportunistically.

**Verification:**

- Public guide/reference text covers the supported and unsupported forms.
- Existing homogeneous parallel subworkflow tests still pass.
- JSON plain-host records include `insideParallel` when the event carries it.

**Exit criteria:**

- A future agent can tell from docs and tests which parallel form is supported.
- No implementation claims to support heterogeneous subworkflow parallelism
  unless it actually owns the branch frame before `runWorkflow` enters.

## Phase 3 - Two-Pane Subworkflow Projection Identity

**Goal:** Make the two-pane steps projection correct for live subworkflow rows,
nested reusable subworkflow names, and lifecycle event exhaustiveness.

**Why third:** This depends on Phase 1's state correctness and may touch the
shape of subworkflow lifecycle overlay data. It should be handled as one
coherent projector change, not as isolated line edits.

**Selected findings:**

| Finding | Decision | Notes |
|---|---|---|
| CX#1 live-only rows lose sub path | Fix | Running child steps should render under their subworkflow before persistence. |
| CX#3 boundary bookkeeping keyed only by leaf sub name | Fix | Valid nested compositions like `api>ship` and `web>ship` must not bleed together. |
| CC#7 missing exhaustiveness in lifecycle consumers | Fix | Add exhaustive handling to `status-loop` and `LifecycleChoreographer` so new lifecycle variants cannot silently fall through. |
| CC#17 `SubworkflowEvent` not exported with `applySubworkflowEvent` | Fix if still needed | Barrel types should match the exported helper surface. |
| CC#29 no dedicated `applySubworkflowEvent` unit test | Fix | This is the right test seam for the overlay identity change. |
| CC#8, CC#9, CC#31 duplicate row helpers / guards | Batch here | These are low-risk cleanups in the same files. Do them only after behavior tests are green. |
| CC#18 file size comments / possible helper extraction | Batch here | Add rule-5 comments at minimum; extract only if it makes the identity fix clearer. |

**Implementation guidance:**

- Treat subworkflow identity as a full path, not a leaf name. The projector
  should be able to distinguish two `ship` subs under different parents.
- If lifecycle events need a `subPath` field to make live-only rows correct,
  add it deliberately and update the event type/docs/tests together. Do not
  invent a fragile string split in the projector.
- Keep `projectStepsView` pure. Put stack reconstruction or overlay folding in
  `live-overlay.ts` tests where bad lifecycle lines can be exercised directly.

**Verification:**

- `bun test tests/unit/hosts/two-pane/steps-view`
- Add tests for:
  - in-flight step inside `simple-feature` renders with sub depth before
    `StepEntry` persistence;
  - sibling nested paths with the same leaf name render separate boundaries;
  - `applySubworkflowEvent` preserves `insideParallel` and rejects invalid
    events safely.

**Exit criteria:**

- Boundary suppression/rendering is keyed by subworkflow identity, not by leaf
  name alone.
- Live rows and persisted rows agree on subworkflow grouping.
- Lifecycle consumers fail loudly at compile time or runtime when a new
  lifecycle variant is not handled.

## Phase 4 - Public Contract, Agent Context, And Coverage Sweep

**Goal:** Reconcile the public/agent-facing surfaces and close high-value test
gaps after the runtime and projector behavior is stable.

**Why last:** These changes are important but should document the behavior that
actually survives Phases 1-3.

**Selected findings:**

| Finding | Decision | Notes |
|---|---|---|
| CC#5 stale primary `workflow` signature in API docs | Fix | Public reference should show `workflow<Args = WorkflowArgs>` as the primary form. |
| CC#6 `orch-workflow-author` skill omits subworkflow API | Fix | High agent-native impact; agents will otherwise keep authoring the old inline pattern. |
| CC#10 plain text divider omits depth | Fix | Cheap agent-native improvement for log tailing. |
| CC#16 missing execution-context barrel exports | Fix | Re-export only if these functions are intended public API; otherwise remove from public docs/tests. |
| CC#19 `deriveStepKey` exported for tests | Decide small scope | Prefer testing through behavior. If kept exported, mark `@internal` and avoid public barrel exposure. |
| CC#20 `isExecutorShape` too weak for public `runWorkflow` shape | Fix | Include the body symbol in the internal guard or produce a clearer public error. |
| CC#21 workflow name pattern undocumented | Fix docs | Do not relax validation in this phase unless a real consumer break is identified. |
| CC#22 step name/key widening undocumented | Fix docs | Explain the distinction between author step names and internally generated sub-path keys. |
| CC#24 `as:` override bypasses sub isolation | Fix docs warning | This is an intentional escape hatch with sharp edges; document it plainly. |
| CC#27 missing runWorkflow type negative test | Fix | Add `@ts-expect-error` coverage for missing required `Args`. |
| CC#28 lifecycle.ndjson assertion missing from suppression tests | Fix | Add the lifecycle assertion required by the original acceptance criteria. |
| CC#12, CC#13, CC#14 behavioral acceptance gaps | Fix selectively | Add end-to-end behavioral tests for cwd isolation, resume cache replay, and homogeneous parallel cwd guard if not already covered by Phases 1-3. |
| CC#15, CC#37 file comment / vocabulary note | Batch | Low risk and useful for future maintainers. |

**Implementation guidance:**

- Update public docs and `.claude/skills/orch-workflow-author` in the same
  phase so human and agent authoring guidance stay aligned.
- Keep examples runnable. Do not add a docs-only API shape that lacks a test or
  example.
- For docs gates, run `bun run docs:build` if public docs changed.

**Verification:**

- `bun test tests/unit/core/workflow-typing.test-d.ts` and any new
  `run-workflow-typing.test-d.ts`
- `bun test tests/unit/hosts/plain/plain-host-subworkflow-divider.test.ts`
- `bun test tests/unit/hosts/two-pane/steps-view/subworkflow-parallel-suppression.test.ts`
- `bun run docs:build`
- `bun run check` before merge

**Exit criteria:**

- Public API docs, agent skill docs, examples, and type tests agree on the
  subworkflow API.
- Log formats carry enough depth/parallel information for CI and autonomous
  consumers.
- Acceptance criteria gaps from the original subworkflow plan are either
  covered or explicitly deferred with rationale.

## Explicit Deferrals

These should not be picked up by follow-up agents unless a phase above already
touches the same behavior:

| Finding | Deferral reason |
|---|---|
| CC#32 `bodyHandle` is convention-private | Advisory. A doc/header note is enough unless deep imports become a real project problem. |
| CC#34 root step and sub share same name selection ambiguity | Low-confidence UI edge. Revisit after Phase 3 changes row identity. |
| CC#35 transient intermediate close can render failure glyph | Low-confidence live-render edge. Revisit if Phase 3 tests reproduce it. |
| CC#36 resume subCallId drift | No current consumer correlates logical invocations by stable `subCallId`; document only if Phase 1 changes the model. |
| Schema-version residual risk | Not a review finding with an actionable bug today. Consider only if state migrations become necessary for Phase 3 event/path changes. |

## Suggested Agent Assignment

- **Agent A:** Phase 1 only. Runtime correctness and cache/resume tests.
- **Agent B:** Phase 2 only. Produce the parallel policy patch/doc; do not
  touch projector internals.
- **Agent C:** Phase 3 only. Two-pane projection identity and overlay tests.
- **Agent D:** Phase 4 only. Docs, skill context, public reference, and coverage
  sweep after earlier phases land.

Agents should work in order. Phase 2 can begin after Phase 1 tests are green,
but Phase 4 should wait for Phases 2 and 3 so it documents the final contract.
