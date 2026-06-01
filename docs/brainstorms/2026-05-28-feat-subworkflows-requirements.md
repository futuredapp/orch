---
date: 2026-05-28
topic: feat-subworkflows
---

# Subworkflows — inline-equivalent composition of workflow artifacts

## Summary

Add a `runWorkflow(executor, args)` primitive that lets one `orch` workflow invoke another `orch` workflow inline from within its body. The invoked artifact is the same `WorkflowExecutor` returned by `workflow(name, fn)` — the same file is usable either as a top-level CLI entry point (`orch run simple-feature`) or as a step inside a larger composition. Execution semantics are inline-equivalent: one `runId`, one state store, one log directory, one `captureLock`, one resume contract. Two departures from literal inline equivalence: (1) `subworkflow:enter` / `subworkflow:exit` lifecycle events for a visual divider — a deliberate taste call to make sub boundaries observable, and (2) a fresh cwd ALS frame on entry — required by the Reuse force so that a reusable sub using `createWorktree({ enter: true })` does not silently mutate its caller's cwd.

---

## Problem Frame

Today a workflow body is one async function. If the author wants to dispatch one of two distinct multi-step pipelines based on a runtime decision (e.g. a `decide` step that returns `'simple'` or `'complex'`), the only option is to inline both pipelines in a single workflow file and gate them with an `if`. This works, but three forces push against it once the workflow grows:

1. **Reuse.** The same sub-pipeline (a four-step "ship a small feature" sequence) is needed from more than one parent workflow. Today it has to be copy-pasted or extracted into an ad-hoc `async (run, args) => Promise<void>` helper that loses its identity as a workflow — it can't be invoked via the CLI, doesn't appear in `orch.config.ts`, and has no `name` for telemetry.
2. **File size and readability.** A workflow with a decision + two ~6-step branches inlined is a single ~150-line function. The branches read as one big switch rather than two named units.
3. **CLI composability.** Authors want the artifact "ship a small feature" to be runnable both standalone (`orch run simple-feature`) and as a sub-step inside a larger orchestration. Today the author has to choose between "registered workflow" (runnable, not composable) and "helper function" (composable, not runnable).

The shared cost is that the author currently has to decide at write time whether a chunk of pipeline is "a workflow" or "a subroutine". That decision is not load-bearing — it changes only based on whether the chunk happens to be invoked from a parent or not, which is exactly the kind of constraint the orchestrator should remove.

---

## Requirements

**Invocation API**

- R1. A new function `runWorkflow(executor, args)` is exported from `src/core/`. Its first parameter is a `WorkflowExecutor` (the value returned by `workflow(name, fn)`). Its second parameter is the typed `Args` object the sub declares.
- R2. `runWorkflow` is callable from anywhere inside a workflow body where `run` itself is callable. Calling it outside an active workflow execution throws a clear, named error (analogous to the existing `setWorkflowCwd` outside-scope guard).
- R3. `runWorkflow` returns `Promise<void>` in v1. A subworkflow does not produce a value back to its caller; state crossing the boundary travels through the shared state store (cached step values) or the filesystem.

**Typed Args**

- R4. The `workflow` factory becomes generic: `workflow<Args extends WorkflowArgs = WorkflowArgs>(name, fn: (run: RunFn, args: Args) => Promise<void>)`. The default type parameter keeps every existing workflow source-compatible.
- R5. The author declares the `Args` shape on the workflow they author. Callers of `runWorkflow(sub, args)` get a compile-time type error when they pass an args object that does not match the sub's declared shape.
- R6. The sub's `Args` must remain assignable to a CLI invocation. In practice this means `Args extends WorkflowArgs`, so `prompt?: string` is always present. A workflow whose sub `Args` requires a non-prompt field is still importable as a sub, but CLI top-level invocation of it is not guaranteed to succeed (documented limitation — see Outstanding Questions).

**Execution semantics**

- R7. Subworkflow execution is inline with respect to run state. Steps run inside the sub appear in the same `RunState.steps` map as parent steps, under the same `runId`, written by the same `stateStore.saveStep` calls.
- R8. The sub shares the parent's `captureLock`, `transcriptSidecar`, `logger`, `host`, `promptService`, `resumeRegistry`, and `interactivity` axis — there is exactly one of each per run, regardless of nesting depth.
- R9. Step caching applies per individual step inside the sub, exactly as if the sub's body were inlined. `runWorkflow` itself is not a cache key and does not participate in caching as a unit.
- R10. Errors thrown inside the sub propagate up through `runWorkflow` without re-wrapping. The parent's existing failure classification (`StepError` / `ValidationError` / `SchemaValidationError` / `ParallelError` → `failed`, anything else → `crashed`) continues to fire at the workflow body's `try/catch`, unchanged. The `subworkflow:exit` event (R14) is dispatched synchronously before the error propagates through `runWorkflow`. If `host.onLifecycleEvent` throws while handling the exit event, the host error is suppressed (logged via `logger?.append` when present) and the original sub error propagates unchanged, preserving the parent's failure classification.

**cwd / worktree scoping**

- R11. cwd mutations inside `runWorkflow` (via `setWorkflowCwd` / `createWorktree({ enter: true })`) do not affect the calling workflow's cwd after `runWorkflow` returns (success or error). Implementers are free to satisfy this contract via ALS-frame push, save/restore, or any other mechanism that preserves the invariant. (Planning note: today's `executionContext` ALS in `src/core/execution-context.ts` is the natural seam — see Dependencies / Assumptions.)
- R12. Mutations to `workflowCwd` inside the sub (via `setWorkflowCwd` / `createWorktree({ enter: true })`) are confined to the sub's frame. On `runWorkflow` returning (success OR error), the parent's `workflowCwd` is what it was at entry.
- R13. The existing `setWorkflowCwd` guard (refusing cwd mutation inside a heterogeneous parallel branch) continues to fire correctly inside subworkflows — the sub's frame inherits `parallelDepth` and `homogeneousBranch` markers from the surrounding scope.

**Lifecycle and telemetry**

- R14. Two new lifecycle event variants fan out through `host.onLifecycleEvent`:
  - `{ type: 'subworkflow:enter', name: string, depth: number }` — fired before any of the sub's steps run.
  - `{ type: 'subworkflow:exit', name: string, depth: number, durationMs: number, outcome: 'completed' | 'failed' }` — fired after the sub returns or throws.
- R15. `depth` starts at 1 for a top-level `runWorkflow` call and increments for nested `runWorkflow` calls. Hosts may use `depth` to render indentation or skip rendering at depth > N if they choose.
- R16. Hosts that do not recognize the new event variants ignore them safely. The plain host SHOULD render a visible divider (e.g. `── ▶ subworkflow: simple-feature ──` and `── ◀ subworkflow: simple-feature (1.2s) ──`). Two-pane host treatment is deferred — the divider in run state and in `lifecycle.ndjson` is the v1 contract.
- R17. Subworkflow boundary events are written to `lifecycle.ndjson` by the session logger when present, so `orch logs` and post-hoc analysis can see the boundaries even when no host rendered them.

**Author ergonomics**

- R18. A workflow that is being invoked as a sub does not need to know it is a sub. The `WorkflowFn` signature is unchanged from the author's point of view: `async (run, args) => { … }`.
- R19. The `WorkflowExecutor` returned by `workflow(...)` is the same object whether invoked top-level (via `execute(deps)`) or as a sub (via `runWorkflow(executor, args)`). No second factory, no `subworkflow(...)` variant.

**Safety guards**

- R20. `runWorkflow` detects step-name collision against the current `RunState.steps` before any of the sub's steps run, and throws a named error (e.g., `StepNameCollisionError`) naming the colliding step and the prior `saveStep` location. Prevents the silent-overwrite hazard reachable when the same sub is invoked more than once per run while the deferred `{ stepPrefix }` overload is unavailable.
- R21. `orch run <name>` fails at startup with a named error (e.g., `MissingRequiredArgsError`) listing the missing fields when invoked on a workflow whose declared `Args` requires fields beyond `prompt`. Turns the R6 dual-role limitation into a loud, recoverable failure rather than a silent partial-args invocation.
- R22. `runWorkflow` throws a named error (e.g., `SubworkflowDepthError`) when invocation depth from R15 would exceed a configurable bound (default 16). Prevents unbounded recursion from becoming reachable if a future `{ stepPrefix }` overload removes the natural step-name-collision floor that today's Scope Boundaries entry depends on.

---

## Acceptance Examples

- AE1. **Covers R1, R7, R10.** Given a parent workflow that calls `runWorkflow(simple, { prompt })`, when the sub's third step throws a `StepError`, the parent's terminal status is `failed` (not `crashed`), and the `RunState.steps` map contains entries for the parent steps that ran and the sub steps that ran up to and including the failing step.

- AE2. **Covers R11, R12.** Given a parent in `.orch/wt/parent-wt`, when the sub runs `await createWorktree({ name: 'sub-wt', enter: true })` and then a step, then steps inside the sub observe `currentCwd() === .orch/wt/sub-wt`, and after `runWorkflow` returns, the parent observes `currentCwd() === .orch/wt/parent-wt`.

- AE3. **Covers R14, R16.** Given any host, when `runWorkflow(simple, args)` is called, the host's `onLifecycleEvent` receives `{ type: 'subworkflow:enter', name: 'simple-feature', depth: 1 }` before any `step:start` of the sub's steps, and receives `{ type: 'subworkflow:exit', name: 'simple-feature', depth: 1, durationMs, outcome: 'completed' }` after all sub steps complete.

- AE4. **Covers R7, R9.** Given a run where the parent's `decide` step is cached as `'simple'` and the sub `simple-feature` previously completed steps `plan` and `implement`, when the workflow is resumed, the `decide` step replays from cache, `runWorkflow(simple, args)` is invoked, and `plan` and `implement` replay from cache without reinvoking the runner — identical to the behavior of inlining the sub's body.

- AE5. **Covers R5.** Given `simple-feature` declares `Args = { prompt: string; slug: string }`, when a parent calls `runWorkflow(simple, { prompt })` without `slug`, TypeScript reports a compile-time error at the call site.

- AE6. **Covers R8, R13.** Given a parent that wraps `runWorkflow(simple, args)` inside a homogeneous `parallel(items, async (item) => …)`, when two branches each invoke the sub concurrently, both branches share the parent's `captureLock` (so two Codex captures still serialize), and `setWorkflowCwd` inside each branch's sub succeeds without throwing the parallel-depth guard.

---

## Code examples

The examples below cover the key composition patterns: a parent dispatching to one of two subs (the canonical shape that motivated this brainstorm), a sub that declares typed `Args` and is usable both top-level and as a sub, a sub using a worktree without leaking cwd to its parent, and a sub invoked inside a homogeneous `parallel(...)` call.

**Parent dispatching to one of two subs**

```ts
// examples/feature/index.ts
import { z } from 'zod'
import { schema, step, workflow, runWorkflow } from '../../src/core/index.ts'
import { claude } from '../../src/runners/index.ts'
import simpleFeature from '../simple-feature/index.ts'
import complexFeature from '../complex-feature/index.ts'

const DECISION_SCHEMA = z.object({
  kind: z.enum(['simple', 'complex']),
})

export default workflow('feature', async (run, args) => {
  if (args.prompt === undefined) {
    throw new Error('feature requires a prompt')
  }

  const decideStep = step.define('decide-complexity', {
    agent: claude({ bare: false }),
    prompt:
      'Read the user request and classify it as `simple` (one file, ≤ 30 LoC) ' +
      `or \`complex\` (multi-file, architectural).\n\nRequest:\n${args.prompt}`,
    returns: schema(DECISION_SCHEMA),
  })
  const { kind } = await run(decideStep)

  if (kind === 'simple') {
    await runWorkflow(simpleFeature, { prompt: args.prompt })
  } else {
    await runWorkflow(complexFeature, { prompt: args.prompt })
  }
})
```

**A subworkflow declaring typed Args, usable both top-level and as a sub**

```ts
// examples/simple-feature/index.ts
import { step, workflow } from '../../src/core/index.ts'
import { claude } from '../../src/runners/index.ts'

interface SimpleArgs {
  prompt: string
}

export default workflow<SimpleArgs>('simple-feature', async (run, args) => {
  const planStep = step.define('plan', {
    agent: claude({ bare: false }),
    prompt: `Sketch a one-paragraph plan for: ${args.prompt}`,
  })
  await run(planStep)

  const implementStep = step.define('implement', {
    agent: claude({ bare: false }),
    prompt: `Implement the plan from the previous step.`,
  })
  await run(implementStep)
})
```

Because `SimpleArgs extends WorkflowArgs` (it has `prompt: string`), the same file is invokable as `orch run simple-feature "make a button"` and as `runWorkflow(simpleFeature, { prompt: '…' })` from another workflow.

**Sub uses a worktree without leaking to parent**

```ts
// examples/parent/index.ts
import { createWorktree, currentCwd, runWorkflow, workflow } from '../../src/core/index.ts'
import branch from '../branch-isolated/index.ts'

export default workflow('parent', async (run, args) => {
  await createWorktree({ name: 'parent-wt', enter: true })
  // currentCwd() === .orch/wt/parent-wt

  await runWorkflow(branch, { prompt: args.prompt ?? '' })
  // branch internally did createWorktree({ name: 'branch-wt', enter: true }),
  // but the parent's cwd is restored on return.

  // currentCwd() === .orch/wt/parent-wt   (R12)
})
```

**Subworkflow inside a homogeneous parallel call**

```ts
import { parallel, runWorkflow, workflow } from '../../src/core/index.ts'
import shipOne from '../ship-one/index.ts'

export default workflow('ship-many', async (run, args) => {
  const tickets = ['T-1', 'T-2', 'T-3']
  await parallel(tickets, async (ticket) => {
    await runWorkflow(shipOne, { prompt: `Ship ticket ${ticket}` })
  })
})
```

> v1 caveat: the steps inside `shipOne` use a fixed set of step names across all three invocations. Because step-name auto-namespacing is deferred (see Scope Boundaries), the second invocation will trip the R20 collision guard with a named error. Multi-invocation reuse patterns need the deferred `{ stepPrefix }` overload — see the deferred-questions block at the end of this document.

---

## Success Criteria

- A workflow author can extract any contiguous range of steps from a workflow body into a new `workflow(...)` file and call it via `runWorkflow(extracted, args)` with no change to `RunState.steps` (when each sub is invoked at most once per run; multi-invocation reuse needs the deferred `{ stepPrefix }` overload), no change to log layout, no change to resume behavior, and no change to host rendering other than the deliberate enter/exit divider. Ranges that mutate cwd via `setWorkflowCwd` are sub-internal per R12 — the extraction is not visible to parent steps that read cwd after the sub returns.
- The same workflow file is runnable both via `orch run <name>` (for `Args = { prompt?: string }`) and via `runWorkflow(import(...), args)` from another workflow (for any `Args extends WorkflowArgs`). Workflows whose `Args` requires non-prompt fields are sub-only until a future CLI arg-passing mechanism exists; R21 makes that failure mode fail fast at startup.
- `ce-plan` receives this document and does not have to invent: invocation API surface, args typing rules, state-store layout, cwd scoping rules, lifecycle event shape, or error propagation semantics. Implementation decisions (where `runWorkflow` lives, how it reaches the parent's `run` closure, how the body is exposed on `WorkflowExecutor`) are explicitly deferred.
- After v1 ships, the public guide presents three concrete extraction triggers — (a) the same sequence runs from more than one parent, (b) the workflow body exceeds a guide-chosen length threshold, or (c) the author wants the sequence runnable via `orch run <name>` standalone — and instructs authors to extract when any trigger fires. The answer to "should I extract this?" is an honest checklist, not a single rule.

---

## Scope Boundaries

- **Auto-namespacing of step names across sub invocations.** Calling the same sub twice in one run collides at `saveStep`. Recognized; deferred. If real workflows hit this, a future `runWorkflow(sub, args, { stepPrefix: 'first-' })` overload is a clean extension.
- **Composite caching of an entire subworkflow.** "Skip the whole sub if its args match a prior run" is a different feature (memoization over an opaque unit of work) and explicitly out of scope.
- **Isolated sub-runs with their own `runId`.** "Fire a sub-run with its own resume contract" is a different shape. If the user ever wants it, `orch run <sub>` already exists for the top-level case, and a future "spawn a child run from a parent" feature would be its own brainstorm.
- **CLI top-level invocation of workflows whose `Args` requires non-prompt fields.** The same file is technically CLI-invokable, but if `Args` requires more than `{ prompt }` the CLI will not be able to populate it until a future arg-passing mechanism exists. Document as a known limitation; do not solve here.
- **Recursive subworkflows (A → B → A).** Naturally prevented by step-name collision; not a feature being added, just a non-goal. No depth limit needed in v1.
- **Returning structured values from a sub to its caller.** v1 sub returns `Promise<void>`. Crossing the boundary with a typed value would require either a new return-channel mechanism or coupling sub identity to a step (the rejected "workflow as a step kind" path). Deferred.
- **Renaming subworkflow boundary events for hosts that want custom dividers.** Hosts ignore unrecognized events safely; if a host wants a custom rendering it reads `name` and `depth` from the standard event.

---

## Key Decisions

- **Inline-equivalent execution model over isolated sub-runs.** Same `runId`, same state store, same logs, same `captureLock`. Rationale: matches the author's mental model (`runWorkflow` is "like inlining, but with a divider"), keeps resume trivial (state keyed by step name), keeps log layout uniform. The alternative (isolated sub-runs) was rejected because it would require synchronizing two state stores at runtime and complicate resume. Acknowledged one-way door: once authors depend on the shared state map and `captureLock` across the `runWorkflow` boundary, an isolated-sub variant cannot be added as a flag on this primitive — it would have to ship as a second primitive (e.g., `spawnChildRun`) with deliberately different observable semantics.
- **Sugar API with telemetry boundary, not "workflow as a step kind".** `runWorkflow` is a control-flow primitive distinct from `run`. Rationale: a workflow is not a `Step` (it has no `value`, no validators, no schema, no cache key); shoehorning it into `Step` would force every step-pipeline branch to handle a "composite" case. The cost is one extra exported name, which is worth it for the simpler types and the simpler `runStepOnce` dispatch.
- **Generic `Args` on `workflow<Args>` with default `WorkflowArgs`.** Rationale: lets subworkflows declare structured inputs while keeping every existing workflow source-compatible. The constraint `Args extends WorkflowArgs` is what keeps the artifact CLI-invokable.
- **Fresh cwd ALS frame on entry, not literal inline equivalence.** Rationale: a reusable subworkflow that uses worktrees must not silently change its caller's cwd. The encapsulation is worth the small divergence from "inline-equivalent in every observable way".
- **No new `runId` per sub, no new state-store namespace.** Step names remain the global key. Rationale: keeps resume, caching, log paths, and the `resumeRegistry` model unchanged.
- **Step-name uniqueness remains the author's responsibility.** Rationale: today's contract; introducing auto-prefixing now would change the meaning of resume for any existing workflow that refactors into subs. If this becomes painful in practice, opt-in prefixing is a clean future addition.

---

## Dependencies / Assumptions

- The `executionContext` ALS mechanism (`src/core/execution-context.ts`) is the only seam needed for cwd scoping; no new ALS field is strictly required (the existing `workflowCwd` mutation already mutates the active store, so pushing a fresh store is sufficient to confine mutations).
- `WorkflowExecutor` will need to expose its body to `runWorkflow` somehow — either by adding the `WorkflowFn` as a (possibly internal) property of the returned object, or by adding an `invoke(run, args)` method that invokes the body inside the parent's existing `captureLock`, root ALS frame, and lifecycle scope — without re-running `initRun`, without writing `setStatus('completed' | 'failed' | 'crashed')`, and without emitting a `run-ended` lifecycle record (those remain run-level concerns of the top-level executor that must not double-fire from a sub). This is an implementation decision for ce-plan.
- `parallel()` already exposes `emitLifecycle` and a `parallelBlockIdRef` via ALS. `runWorkflow` will need to inherit both into its fresh frame so nested `parallel()` calls inside the sub still fire `step:parallel-start` / `step:parallel-complete`. Verified against `src/core/execution-context.ts:31-40` and `src/core/workflow.ts:1257-1266`.
- The plain host currently renders `lifecycle` events line-by-line. Adding two new variants will require a small switch arm in the plain host's lifecycle printer; verified that the existing pattern (one printer per event type) accommodates this trivially.

---

## Outstanding Questions

### Resolve Before Planning

- *(none — all product-shape decisions resolved during brainstorm.)*

### Deferred to Planning

- [Affects R1, R19][Technical] How does `runWorkflow` reach the parent's `run` closure? Three candidates surfaced during brainstorm: (a) push `run` into the `executionContext` ALS store so `runWorkflow` reads it from there; (b) make `runWorkflow` a method on `run` itself (`run.workflow(sub, args)`); (c) accept `run` as an explicit first parameter (`runWorkflow(run, sub, args)`). (a) is cleanest at the call site; (b) is most discoverable; (c) is most explicit. Decide during planning.
- [Affects R19][Technical] How does `WorkflowExecutor` expose its body to `runWorkflow`? Add a `body: WorkflowFn` field (simple, slight encapsulation break), an `invoke(run, args): Promise<void>` method (more controlled), or a module-private handle (most encapsulated, more code). Decide during planning.
- [Affects R16][Needs research] Two-pane host divider rendering for `subworkflow:enter` / `subworkflow:exit` — what does it look like in the steps view? v1 contract is "event exists in lifecycle.ndjson"; two-pane treatment is its own design pass.
- [Affects R14, R15][Technical] Should `depth` be carried in `step:start` / `step:complete` too, so a host that misses the enter/exit events can still group steps by sub? Or is it sufficient to track depth via the enter/exit events alone? Decide during planning; affects host implementation more than the executor.
- [Affects R8][Technical] `transcriptSidecar` and `logger` write paths are derived from step name, not from subworkflow identity. If a future feature wants per-sub log subdirectories (e.g. `logs/agents/simple-feature/plan/`), that's a layout change that needs its own brainstorm. v1 keeps the flat `logs/agents/<step>/` layout.

### From 2026-05-28 review

Surfaced by the ce-doc-review pass on 2026-05-28 (coherence + feasibility + product-lens + scope-guardian + adversarial). These are scope and framing questions deferred for the author's decision before planning kicks off. The in-place edits already applied in this same pass address the mechanical findings; the entries below are the judgment calls that wanted author sign-off.

- **[Scope, affects R20 and Scope Boundaries — agreement-promoted: scope-guardian + adversarial]** Should the `runWorkflow(sub, args, { stepPrefix })` overload ship in v1? The Problem Frame's Reuse force materially relies on calling the same sub more than once in a run; v1 today raises a clear error via R20, but authors hitting it have no v1 mitigation other than wrapping the sub manually. If reuse-with-repetition is a v1 story, `stepPrefix` belongs in v1.
- **[Framing, affects Problem Frame — product-lens]** The three motivating forces are presented as current pain, but no existing in-tree workflow is cited as the case that hurt. Consider re-framing as "enabling a future composition pattern" or cite the specific extracted/copy-pasted workflow this came from, so the bar for the new exported primitive is calibrated against an actual cost.
- **[Alternatives, affects Key Decisions — product-lens]** A cheaper alternative — a plain `async (run, args) => Promise<void>` helper plus a thin one-line `workflow('name', (run, args) => helper(run, args))` CLI-register shim — addresses reuse, file size, and CLI composability without `runWorkflow`, generic `workflow<Args>`, or new lifecycle events. Key Decisions evaluates and rejects "workflow as a step kind" and "isolated sub-runs" but does not engage with this third option. Worth recording why it was rejected (or whether it changes the v1 shape).
- **[Naming, affects Summary and public guide — product-lens]** "subworkflow" carries an encapsulation contract in most orchestration systems (Airflow SubDAG, Temporal child workflow, GH Actions reusable, n8n) that this design deliberately collapses. Consider `runInline(executor, args)` / "inline composition" / "included workflow" so the public-facing name matches the contract — authors form expectations from the name on first contact.
- **[Scope, affects R11–R13 — scope-guardian]** Should the fresh cwd ALS frame be opt-in (`runWorkflow(sub, args, { isolateCwd: true })`) rather than the default? No existing in-tree workflow uses `createWorktree({ enter: true })` inside a sub-shaped helper. Literal inline equivalence may be the simpler default until the leak hazard is observed in practice. (Note: the R11 rewrite already softened the implementation commitment, so flipping the default later remains cheap.)
- **[Scope, affects R14–R17 — scope-guardian]** Could the subworkflow boundary events ship as a single untyped record write to `lifecycle.ndjson` (satisfying R17 directly) rather than as new variants of the typed `StepLifecycleEvent` union? Adding union variants forces a switch arm in every host and in `applyEvent`; an untyped record write costs zero changes elsewhere and still gives `orch logs` the boundary divider for v1.
- **[Resume hazard, affects R9 and AE4 — adversarial]** When a parent's body changes between runs in a way that re-routes a cached decision to a different sub (e.g., `decide` stays cached as `'simple'` but the author edited `runWorkflow(simple, …)` to `runWorkflow(complex, …)`), and `complex` happens to declare steps with the same names as `simple`, resume will replay cached step values from `simple` inside `complex`'s body. Match today's step-cache contract (silent) or include sub-name in the cache key for steps invoked inside a sub?
- **[API ergonomics, affects R4 — product-lens]** The generic `workflow<Args extends WorkflowArgs = WorkflowArgs>` keeps existing workflows source-compatible but adds a permanent IntelliSense tax to every workflow author who hovers over `workflow(...)`. Consider whether a separate `typedWorkflow<Args>(...)` factory would serve the typed-args case without polluting the common-case signature.
