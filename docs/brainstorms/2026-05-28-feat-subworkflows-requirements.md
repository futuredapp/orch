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
- R6. The sub's `Args` must remain assignable to a CLI invocation. In practice this means `Args extends WorkflowArgs`, so `prompt: string` is always required as a field. A workflow whose sub `Args` requires a non-prompt field is still importable as a sub, but CLI top-level invocation of it produces a partial-args invocation with undefined behavior (documented limitation — see Scope Boundaries and Outstanding Questions; not enforced at runtime in v1).

**Execution semantics**

- R7. Subworkflow execution is inline with respect to run state. Steps run inside the sub appear in the same `RunState.steps` map as parent steps, under the same `runId`, written by the same `stateStore.saveStep` calls.
- R8. The sub shares the parent's `captureLock`, `transcriptSidecar`, `logger`, `host`, `promptService`, `resumeRegistry`, and `interactivity` axis — there is exactly one of each per run, regardless of nesting depth.
- R9. Step caching applies per individual step inside the sub, exactly as if the sub's body were inlined. `runWorkflow` itself is not a cache key and does not participate in caching as a unit.
- R10. Errors thrown inside the sub propagate up through `runWorkflow` without re-wrapping. The parent's existing failure classification (`StepError` / `ValidationError` / `SchemaValidationError` / `ParallelError` → `failed`, anything else → `crashed`) continues to fire at the workflow body's `try/catch`, unchanged. The `subworkflow:exit` event (R14) is dispatched synchronously before the error propagates through `runWorkflow`. If `host.onLifecycleEvent` throws while handling `subworkflow:exit`, the host error is suppressed (logged via `logger?.append` when present) and the original sub error propagates unchanged, preserving the parent's failure classification. If `host.onLifecycleEvent` throws while handling `subworkflow:enter`, the host error propagates and the sub does not run — enter-throw is treated as a host integration bug that should surface loudly. The asymmetry is deliberate: by the time `subworkflow:exit` fires the sub has finished and the outcome must reach the caller; at `subworkflow:enter` no work has begun and propagating preserves the run's failure semantics.

**cwd / worktree scoping**

- R11. cwd mutations inside `runWorkflow` (via `setWorkflowCwd` / `createWorktree({ enter: true })`) do not affect the calling workflow's cwd after `runWorkflow` returns (success or error). Implementers are free to satisfy this contract via ALS-frame push, save/restore, or any other mechanism that preserves the invariant. (Planning note: today's `executionContext` ALS in `src/core/execution-context.ts` is the natural seam — see Dependencies / Assumptions.) cwd mutations from detached async work inside the sub (un-awaited promises, `setImmediate` callbacks) that execute after `runWorkflow` returns affect the sub's dead ALS frame and are silently lost. Authors must await all cwd-mutating work inside the sub body. This matches the existing `setWorkflowCwd` ALS contract and is consistent across all workflow scopes.
- R12. Mutations to `workflowCwd` inside the sub (via `setWorkflowCwd` / `createWorktree({ enter: true })`) are confined to the sub's frame. On `runWorkflow` returning (success OR error), the parent's `workflowCwd` is what it was at entry.
- R13. The existing `setWorkflowCwd` guard (refusing cwd mutation inside a heterogeneous parallel branch) continues to fire correctly inside subworkflows — the sub's frame inherits `parallelDepth` and `homogeneousBranch` markers from the surrounding scope.

**Lifecycle and telemetry**

- R14. Two new lifecycle event variants fan out through `host.onLifecycleEvent`:
  - `{ type: 'subworkflow:enter', name: string, depth: number }` — fired before any of the sub's steps run.
  - `{ type: 'subworkflow:exit', name: string, depth: number, durationMs: number, outcome: 'completed' | 'failed' }` — fired after the sub returns or throws.
- R15. `depth` starts at 1 for a top-level `runWorkflow` call and increments for nested `runWorkflow` calls. Hosts may use `depth` to render indentation or skip rendering at depth > N if they choose. Depth is carried in the `executionContext` ALS frame, not in a run-wide counter. Two sibling `runWorkflow` calls inside a `parallel()` block both report the same depth as their enclosing scope + 1 — hosts rendering indentation MUST treat depth as scope-relative, not invocation-sequential.
- R16. The closed `StepLifecycleEvent` union means every typed host consumer (plain-host `textLifecycle` / `jsonLifecycle`, two-pane lifecycle-choreographer) must gain a switch arm; untyped ndjson consumers like live-overlay's `applyLifecycleEvent` already default-return on unknown `event.type` values and need no change. In sequential composition the plain host SHOULD render a visible divider (e.g. `── ▶ subworkflow: simple-feature ──` and `── ◀ subworkflow: simple-feature (1.2s) ──`). In concurrent composition (sub invoked inside a parallel branch) the divider is suppressed in the plain host because interleaved enter/exit dividers across sibling subs are unparseable; `lifecycle.ndjson` still records both events with `depth` and `name` for post-hoc analysis. The two-pane host's rendering contract is defined separately under "Two-pane left-pane rendering" below (R22–R26).
- R17. Subworkflow boundary events are written to `lifecycle.ndjson` by the session logger when present, so `orch logs` and post-hoc analysis can see the boundaries even when no host rendered them.

**Author ergonomics**

- R18. A workflow that is being invoked as a sub does not need to know it is a sub. The `WorkflowFn` signature is unchanged from the author's point of view: `async (run, args) => { … }`.
- R19. The `WorkflowExecutor` returned by `workflow(...)` is the same object whether invoked top-level (via `execute(deps)`) or as a sub (via `runWorkflow(executor, args)`). No second factory, no `subworkflow(...)` variant.

**Safety guards**

- R20. Step-name collisions are detected at `saveStep` time inside the sub and throw a named `StepNameCollisionError` naming the colliding step and the prior `saveStep` location. The sub's preceding steps (if any) have already executed; the colliding step itself does NOT save its result. Authors should treat collision as an authoring-time bug, not a runtime branch. (Earlier framing of "detect before any of the sub's steps run" was undecidable — step names are produced inside the body via `step.define()`, so the only feasible enforcement point is `saveStep`.) Prevents the silent-overwrite hazard reachable when the same sub is invoked more than once per run while the deferred `{ stepPrefix }` overload is unavailable.
- R21. `runWorkflow` throws a named error (e.g., `SubworkflowDepthError`) when invocation depth from R15 would exceed a configurable bound. Default: `8` — rationale: no in-tree composition currently exceeds depth 3; 8 leaves ~2.5x headroom while keeping accidental recursion bounded. Override via `runWorkflow.config.maxDepth`. Prevents unbounded recursion from becoming reachable if a future `{ stepPrefix }` overload removes the natural step-name-collision floor that today's Scope Boundaries entry depends on. (Note: R21 in earlier drafts described a CLI startup `MissingRequiredArgsError` guard; that requirement was removed during 2026-05-29 review to align with the Scope Boundaries entry "document as a known limitation; do not solve here" — the slot now holds the depth-bound safety guard formerly numbered R22.)

---

## Two-pane left-pane rendering

The two-pane host's left pane is a flat, height-constrained list of step rows today (see `src/hosts/two-pane/steps-view/steps-view.tsx` and `project-steps-view.ts`). Subworkflows need a visual treatment that:

- makes the sub boundary observable (taste call already paid for by R14);
- keeps existing per-step selection (`↑/↓` preview cursor, `▌` committed cursor, `⏎` to view transcript) coherent;
- scales to nested depth without exploding horizontal name budget (current `STEP_NAME_MAX = 30`);
- degrades sanely under the existing `computeVisibleCount` vertical budget.

The chosen treatment is an **indented gutter** — one row to enter the sub, indented child rows with a `│ ` gutter per depth level, one row to exit the sub carrying the total duration and outcome.

### Visualization

**Single sub, sequential composition:**

```
orch · feature · 2026-05-29-a7c3
────────────────────────────────────
  decide-complexity      ✓   1.2s
  ▼ simple-feature             …
  │  plan                 ✓   3.4s
  │  implement            ●   4.5s
  ✓ simple-feature             7.9s
  finalize                ◌
────────────────────────────────────
▶ live · ⏎ view step · q quit · ? help
```

**Nested subs (depth = 2):**

```
  ▼ feature                    …
  │  decide                ✓   1.2s
  │  ▼ simple-feature           …
  │  │  plan               ✓   3.4s
  │  │  implement          ●   4.5s
```

**Failure outcome (sub's middle step throws):**

```
  ▼ simple-feature              …
  │  plan                  ✓   3.4s
  │  implement             ✗   4.5s
  ✗ simple-feature              7.9s        (red)
```

**Sub inside a parallel branch (rendering suppressed, R23):**

```
  ▸ parallel: ship-many (3)
  ├─ plan                  ✓   3.4s
  ├─ plan                  ✓   3.6s
  ├─ plan                  ✓   3.5s
```

Children of the parallel-branch sub render flat at the parent's level — no `▼`/`✓` rows, no `│` gutter. `lifecycle.ndjson` still carries both `subworkflow:enter` and `subworkflow:exit` for post-hoc analysis.

**Depth-overflow collapse (depth ≥ 4 on width < 60 cols, R26):**

```
  │4  plan                 ✓   3.4s
  │4  implement            ●   4.5s
```

The four stacked `│ ` columns collapse to a single `│N` token with the depth digit, reclaiming horizontal space for the name column.

### Requirements

- R22. On `subworkflow:enter` in sequential composition, the steps view renders a non-step **enter row** `▼ <name>  …` at the gutter level of the enclosing scope. Every subsequent step row whose lifecycle is nested under this enter (until the matching `subworkflow:exit`) renders with a `│ ` prefix per nesting level. On the matching `subworkflow:exit`, an **exit row** renders carrying the outcome glyph (`✓` completed, `✗` failed) and `durationMs` formatted via the existing `formatElapsed` helper.
- R23. When the enclosing scope of a `subworkflow:enter` is a `parallel(...)` branch, the enter row, the gutter prefix, and the exit row are all suppressed. The sub's children render flat at the parent scope's gutter level. The choreographer detects "inside parallel" via the same ALS `parallelBlockIdRef` signal that today's parallel rollup already consumes. Suppression is uniform across the whole sub subtree — a sub-of-a-sub-inside-parallel is also flat.
- R24. The enter row and exit row are **non-selectable**: `useStepsSelection`'s `↑/↓` preview cursor and the auto-tracked committed cursor both skip these rows. `⏎` on a boundary row is a no-op (no intent emitted, no right-pane change). The skip rule applies even when the boundary row is the only thing between two selectable rows.
- R25. Nested subs stack gutter columns additively. A depth-`d` sub's children render with `d` repetitions of `│ ` as their prefix. Boundary rows for the depth-`d` sub render aligned with the gutter at depth `d-1` (one less `│ ` than their own children), making the nesting visually unambiguous.
- R26. When effective depth ≥ 4 AND the pane's column count is < 60, the projector collapses the stacked-bars prefix to a single `│N ` token where `N` is the depth digit. Boundary rows for a depth-`d` sub render with the compact form at depth `d-1` (i.e., `│{d-1} ▼ <name>` and `│{d-1} ✓ <name>`), matching their children's compact form at depth `d` — this is the rule AE12 already encodes (`│3 ▼ leaf` for a depth-4 sub) and R26 codifies here so the boundary-row treatment is not silently dropped by an implementer who reads R26 in isolation. The threshold is intentionally conservative (depth 4 is well past today's deepest in-tree composition of 3); it exists so a future deep composition does not silently squeeze the name column below the readability floor. Authority for "hosts may skip rendering at depth > N" is granted by R15.

These five requirements are pane-only — they change nothing in `RunState.steps`, in `lifecycle.ndjson`, or in any other host. A consumer that ignores the new boundary events still gets a correctly-ordered flat step list.

---

## Acceptance Examples

- AE1. **Covers R1, R7, R10.** Given a parent workflow that calls `runWorkflow(simple, { prompt })`, when the sub's third step throws a `StepError`, the parent's terminal status is `failed` (not `crashed`), and the `RunState.steps` map contains entries for the parent steps that ran and the sub steps that ran up to and including the failing step.

- AE2. **Covers R11, R12.** Given a parent in `.orch/wt/parent-wt`, when the sub runs `await createWorktree({ name: 'sub-wt', enter: true })` and then a step, then steps inside the sub observe `currentCwd() === .orch/wt/sub-wt`, and after `runWorkflow` returns, the parent observes `currentCwd() === .orch/wt/parent-wt`.

- AE3. **Covers R14, R16.** Given any host, when `runWorkflow(simple, args)` is called and completes successfully, the host's `onLifecycleEvent` receives `{ type: 'subworkflow:enter', name: 'simple-feature', depth: 1 }` before any `step:start` of the sub's steps, and receives `{ type: 'subworkflow:exit', name: 'simple-feature', depth: 1, durationMs, outcome: 'completed' }` after all sub steps complete. When the sub throws, the host receives `{ type: 'subworkflow:exit', name: 'simple-feature', depth: 1, durationMs, outcome: 'failed' }` instead, before the error propagates through `runWorkflow`.

- AE4. **Covers R7, R9.** Given a run where the parent's `decide` step is cached as `'simple'` and the sub `simple-feature` previously completed steps `plan` and `implement`, when the workflow is resumed, the `decide` step replays from cache, `runWorkflow(simple, args)` is invoked, and `plan` and `implement` replay from cache without reinvoking the runner — identical to the behavior of inlining the sub's body.

- AE5. **Covers R5.** Given `simple-feature` declares `Args = { prompt: string; slug: string }`, when a parent calls `runWorkflow(simple, { prompt })` without `slug`, TypeScript reports a compile-time error at the call site.

- AE6. **Covers R8, R13.** Given a parent that wraps `runWorkflow(simple, args)` inside a homogeneous `parallel(items, async (item) => …)`, when two branches each invoke the sub concurrently, both branches share the parent's `captureLock` (so two Codex captures still serialize), and `setWorkflowCwd` inside each branch's sub succeeds without throwing the parallel-depth guard.

- AE7. **Covers R13 (heterogeneous case).** Given a parent that calls `parallel()` in heterogeneous mode (mixed step shapes across branches), when a branch invokes `runWorkflow(sub, args)` and the sub calls `setWorkflowCwd()`, the call throws the parallel-depth guard error — identical to the behavior of calling `setWorkflowCwd()` directly inside the heterogeneous branch body.

- AE8. **Covers R22 (enter/exit/gutter rendering, sequential composition).**

  ```
  GIVEN a parent workflow with steps [parent-A, parent-B]
    AND parent-A is completed
    AND runWorkflow(simple, args) is invoked between parent-A and parent-B
    AND simple declares child steps [plan, implement]
  WHEN the run reaches steady state (all of simple's steps completed, parent-B not yet started)
  THEN the steps view renders these rows IN ORDER:
       row 1:  "  parent-A          ✓   <elapsed>"
       row 2:  "  ▼ simple-feature        …"          // enter row, running glyph until exit fires
       row 3:  "  │  plan             ✓   <elapsed>"   // child with one gutter column
       row 4:  "  │  implement        ✓   <elapsed>"
       row 5:  "  ✓ simple-feature        7.9s"        // exit row, duration = formatElapsed(exitEvent.durationMs)
       row 6:  "  parent-B           ◌"               // pending
   AND RunState.steps contains exactly { parent-A, plan, implement }
       (boundary rows live only in the projected StepsViewState, never in persisted state)
   AND on "f" (follow-live) the committed cursor lands on `implement`, NOT on the ✓ exit row
  ```

- AE9. **Covers R23 (parallel suppression).**

  ```
  GIVEN a parent workflow that calls parallel(['T-1','T-2','T-3'], async (t) => runWorkflow(shipOne, { prompt: t }))
    AND shipOne declares one child step "plan"
  WHEN all three parallel branches complete
  THEN the steps view contains:
       row 1:  "  ▸ parallel: ship-many (3)"
       row 2:  "  ├─ plan              ✓   <elapsed>"
       row 3:  "  ├─ plan              ✓   <elapsed>"
       row 4:  "  ├─ plan              ✓   <elapsed>"
   AND NO row contains the "▼" enter glyph
   AND NO row contains the "✓ ship-one" exit glyph
   AND NO row begins with a "│ " gutter prefix
   AND lifecycle.ndjson contains EXACTLY:
       3 records matching { type: 'subworkflow:enter', name: 'ship-one' }
       3 records matching { type: 'subworkflow:exit',  name: 'ship-one', outcome: 'completed' }
  ```

- AE10. **Covers R24 (cursor skips boundary rows; ⏎ no-op on boundaries).**

  ```
  GIVEN a steady-state pane with rows:
       [parent-A, ▼ sub, │ child-1, │ child-2, ✓ sub, parent-B]
    AND the preview cursor (›) is positioned on "child-2"

  WHEN the user presses "↓"
  THEN the preview cursor moves to "parent-B"     // skips the ✓ sub boundary row
   AND no intent is emitted

  WHEN the user presses "↑" from "parent-B"
  THEN the preview cursor moves to "child-2"      // skips the ✓ sub boundary row

  WHEN the user presses "⏎" while the preview cursor would be on "▼ sub"
       (test fixture forces cursor to the boundary row to verify the guard)
  THEN no { type: 'enter' } intent is emitted
   AND the right-pane controller's selected step does not change
   AND optionally an info banner reads "boundary row — no transcript"
  ```

- AE11. **Covers R25 (nested gutter stacking and boundary-row alignment).**

  ```
  GIVEN a parent that invokes runWorkflow(outer, args)
    AND outer invokes runWorkflow(inner, args)
    AND inner declares child steps [plan, implement]

  WHEN both subs are mid-flight (inner's "implement" is running)
  THEN the steps view renders these rows IN ORDER:
       "  ▼ outer                       …"           // depth-1 enter, no gutter
       "  │  ▼ inner                    …"           // depth-2 enter, one gutter column
       "  │  │  plan              ✓   <elapsed>"     // depth-2 child, two gutter columns
       "  │  │  implement         ●   <elapsed>"     // running glyph

  WHEN both subs have completed
  THEN the steps view additionally contains, IN ORDER:
       "  │  ✓ inner                    <innerDur>"  // exit aligned at depth-1 gutter
       "  ✓ outer                       <outerDur>"  // exit at root (no gutter)

  RULE: an exit row for a depth-d sub renders with (d-1) gutter columns,
        matching the enter row's gutter depth, NOT its children's depth.
  ```

- AE12. **Covers R26 (depth-overflow collapse on narrow panes).**

  ```
  GIVEN a chain of subs: outer → mid1 → mid2 → leaf (effective depth = 4)
    AND leaf declares a child step "plan"

  WHEN the pane width is 50 columns
   AND leaf's "plan" step is rendered
  THEN the row begins with the literal compact token "│4 ":
       "│4 plan                  ✓   <elapsed>"
   AND leaf's boundary rows use the depth-3 compact form:
       "│3 ▼ leaf                       …"
       "│3 ✓ leaf                       <dur>"

  WHEN the pane width is 80 columns (same depth)
  THEN the row uses the full stacked-bar form:
       "│  │  │  │  plan         ✓   <elapsed>"

  WHEN the pane width is 50 columns AND effective depth is 3
  THEN the row uses the full stacked-bar form
       (collapse only triggers when BOTH conditions hold: depth ≥ 4 AND width < 60)
  ```

**Notes on how these tests get wired:**

- AE8, AE9, AE11, AE12 are pane-snapshot assertions — fit the existing behavioral-DSL `snapshot.test.ts` + `pane-matchers.test.ts` shapes under `tests/unit/helpers/behavioral-dsl/` and `tests/unit/hosts/two-pane/`.
- AE10 drives the `<StepsView>` Ink instance with key events (existing pattern in `tests/unit/hosts/two-pane/steps-view/`) and asserts the emitted intent stream + the resulting `committedName`.
- The lifecycle.ndjson assertion in AE9 reuses the existing `lifecycle.ndjson` reader fixtures.
- None of these tests need a real subprocess; they exercise the projector + Ink renderer over a synthesized `RunState` + `lifecycle.ndjson` pair.

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
- The same workflow file is runnable both via `orch run <name>` (for `Args = { prompt: string }`) and via `runWorkflow(import(...), args)` from another workflow (for any `Args extends WorkflowArgs`). Workflows whose `Args` requires non-prompt fields are sub-only until a future CLI arg-passing mechanism exists; the CLI does not enforce this at startup in v1 — the limitation is documented under Scope Boundaries and Outstanding Questions.
- `ce-plan` receives this document and does not have to invent: invocation API surface, args typing rules, state-store layout, cwd scoping rules, lifecycle event shape, or error propagation semantics. Implementation decisions (where `runWorkflow` lives, how it reaches the parent's `run` closure, how the body is exposed on `WorkflowExecutor`) are explicitly deferred.
- After v1 ships, the public guide presents three concrete extraction triggers — (a) the same sequence runs from more than one parent, (b) the workflow body exceeds a guide-chosen length threshold, or (c) the author wants the sequence runnable via `orch run <name>` standalone — and instructs authors to extract when any trigger fires. The answer to "should I extract this?" is an honest checklist, not a single rule.

---

## Scope Boundaries

- **Auto-namespacing of step names across sub invocations.** Calling the same sub twice in one run collides at `saveStep`. Recognized; deferred. If real workflows hit this, a future `runWorkflow(sub, args, { stepPrefix: 'first-' })` overload is a clean extension.
- **Composite caching of an entire subworkflow.** "Skip the whole sub if its args match a prior run" is a different feature (memoization over an opaque unit of work) and explicitly out of scope.
- **Isolated sub-runs with their own `runId`.** "Fire a sub-run with its own resume contract" is a different shape. If the user ever wants it, `orch run <sub>` already exists for the top-level case, and a future "spawn a child run from a parent" feature would be its own brainstorm.
- **CLI top-level invocation of workflows whose `Args` requires non-prompt fields.** The same file is technically CLI-invokable, but if `Args` requires more than `{ prompt }` the CLI will not be able to populate it until a future arg-passing mechanism exists. Document as a known limitation; do not solve here.
- **Recursive subworkflows (A → B → A).** Recursion with step-name overlap is caught by R20 (`StepNameCollisionError` at re-entered `saveStep`); recursion between workflows with entirely *disjoint* step names is not prevented by R20 in v1. Not a feature being added; whether that residual cycle path warrants an explicit depth bound is the unresolved R21 vs Scope Boundaries question in Outstanding Questions (see 2026-05-29 review).
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
- `parallel()` already exposes `emitLifecycle` and a `parallelBlockIdRef` via ALS. `runWorkflow` will need to inherit both into its fresh frame so nested `parallel()` calls inside the sub still fire `step:parallel-start` / `step:parallel-complete`. Verified against `src/core/execution-context.ts:31-40` and `src/core/workflow.ts:1361-1368`.
- The plain host currently renders `lifecycle` events line-by-line. Adding two new variants will require a small switch arm in the plain host's lifecycle printer; verified that the existing pattern (one printer per event type) accommodates this trivially.

---

## Outstanding Questions

### Resolve Before Planning

- **[Dual-role file, affects Summary, SC bullet 2, R6 — product-lens, 2026-05-29 review]** Does the headline dual-role promise (same file runnable both via `orch run <name>` and as a sub via `runWorkflow(...)`) apply to subs that declare non-trivial typed `Args` (e.g., `SimpleArgs = { prompt: string; slug: string }`), or only to subs whose `Args` is exactly `{ prompt: string }`? Subs with extra required fields are sub-only in v1 until a CLI arg-passing mechanism exists; the Summary and public guide should describe the feature in line with the answer rather than oversell the dual-role case.

### Deferred to Planning

- [Affects R1, R19][Technical] How does `runWorkflow` reach the parent's `run` closure? Three candidates surfaced during brainstorm: (a) push `run` into the `executionContext` ALS store so `runWorkflow` reads it from there; (b) make `runWorkflow` a method on `run` itself (`run.workflow(sub, args)`); (c) accept `run` as an explicit first parameter (`runWorkflow(run, sub, args)`). (a) is cleanest at the call site; (b) is most discoverable; (c) is most explicit. Decide during planning.
- [Affects R19][Technical] How does `WorkflowExecutor` expose its body to `runWorkflow`? Add a `body: WorkflowFn` field (simple, slight encapsulation break), an `invoke(run, args): Promise<void>` method (more controlled), or a module-private handle (most encapsulated, more code). Decide during planning.
- [Affects R22–R26][Technical] Sub-membership projection: how does `projectStepsView` know which `RunState.steps` entries belong to which active sub? Two candidates: (a) extend `StepEntry` with an optional `subPath: string[]` field that the executor populates from the active sub-stack at `saveStep` time (schema change, projector trivially groups); (b) reconstruct membership at projection time by interleaving `subworkflow:enter`/`subworkflow:exit` records from `lifecycle.ndjson` against step-start ordering (no schema change, couples projector to a second source). Decide during planning. Resume behavior must also work — option (a) survives a restart trivially because state.json carries it; option (b) needs the lifecycle file to be readable on resume.
- [Affects R22, R24][Needs research, resolved framing] Two-pane host treatment of `subworkflow:enter` / `subworkflow:exit` is now specified under "Two-pane left-pane rendering" (R22–R26) as the indented-gutter design. The original "design pass" question is closed; what remains for planning is the projection-source decision above and the behavioral acceptance examples AE8–AE12.
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

### From 2026-05-29 review

Surfaced by the ce-doc-review pass on 2026-05-29 (coherence + feasibility + product-lens + scope-guardian + adversarial). The in-place edits already applied in this pass address the mechanical and one-clear-fix findings; the entries below are the judgment calls and contradictions whose resolution direction the author should decide before planning.

- **[Scope, affects new R21 and Scope Boundaries — agreement-promoted: coherence + scope-guardian + adversarial]** Three personas independently flagged that the depth-bound safety guard (the former R22, now renumbered R21 after the original R21 was removed in this pass) directly contradicts the Scope Boundaries entry "Recursive subworkflows … no depth limit needed in v1." Two opposing resolutions:
  - **(a) Cut the depth bound entirely from v1** — R20's step-name collision is the only floor needed today; add the depth guard back when `{ stepPrefix }` removes the natural collision barrier.
  - **(b) Keep the depth bound and reword Scope Boundaries** — change the recursion entry to "Recursive subworkflows are prevented today by step-name collision (R20); R21 adds a depth guard to keep the recursion floor intact once `stepPrefix` removes that natural barrier."
  Either is internally consistent; today the document is not. Pick one before planning.
- **[Scope, affects AE6 — adversarial]** AE6 as written is unsatisfiable under the current R20 contract: two parallel branches both invoking the same sub `simple` trip `StepNameCollisionError` on the second branch before captureLock sharing or the parallel-depth guard can be observed. Three resolutions surfaced:
  - Rewrite AE6 to invoke two *different* subs concurrently (one branch calls `shipA`, the other `shipB`).
  - Restate AE6 as a single-element parallel block so the second-branch case never arises.
  - Mark AE6 as deferred until `{ stepPrefix }` ships and replace with a different R8+R13 acceptance example.
- **[Scope, affects Success Criteria bullet 1 + Problem Frame Reuse force — product-lens]** Success Criterion 1 promises "no change to RunState.steps" but parenthetically restricts this to "when each sub is invoked at most once per run." The Problem Frame's top-listed force is Reuse — "the same sub-pipeline is needed from more than one parent workflow" — and the parallel(items, sub) code example demonstrates exactly the multi-invocation case that v1's R20 collision guard blocks. Two resolutions:
  - **(a) Elevate the deferred `{ stepPrefix }` overload into v1 scope** so Reuse is actually served.
  - **(b) Demote Reuse out of the Problem Frame's three forces** and re-frame SC1 around single-invocation extraction (file size + CLI composability), naming multi-invocation reuse as deferred until the prefix overload exists.
  Shipping a doc whose headline motivation and headline success criterion disagree about whether v1 solves it leaves ce-plan with conflicting north stars.
- **[Scope, affects Success Criteria bullet 4 — scope-guardian]** The 4th success criterion commits to a post-ship public-guide deliverable (three-trigger extraction checklist) that no requirement covers. Two resolutions:
  - Add a documentation requirement (e.g., R22: the public guide for subworkflows includes a "when to extract" decision checklist naming the three triggers) so ce-plan can scope it as an implementation unit.
  - Move the 4th bullet to a "After v1 / follow-on work" section so it is not a v1 sign-off gate.
- **[Scope, affects Scope Boundaries recursion bullet + R20 — scope-guardian]** The Scope Boundaries claim "Recursive subworkflows are naturally prevented by step-name collision" overstates R20's coverage: A→B→A with disjoint step names is not prevented. Two resolutions:
  - Correct the claim to "recursion with step-name overlap is caught by R20; recursion between workflows with entirely disjoint step names is not prevented in v1" and re-evaluate whether the depth guard (now R21) is needed for that case.
  - Strengthen R20 to track executor identity in the active call stack and throw on re-entry, which would genuinely prevent all recursive cycles.
  - **Resolved in 2026-05-31 review:** the Scope Boundaries claim has been reworded inline to acknowledge the disjoint-name gap and point at the R21 vs Scope Boundaries unresolved entry above. Whether R21 stays in v1 or is cut remains open under the first 2026-05-29 bullet.

### From 2026-05-31 review

Surfaced by the ce-doc-review pass on 2026-05-31 (coherence + feasibility + product-lens + design-lens + scope-guardian + adversarial). The 2026-05-28 and 2026-05-29 entries above remain the load-bearing unresolved questions; this round produced two in-place edits (Scope Boundaries recursion claim reworded; R26 extended to specify boundary-row treatment per AE12) and the novel entries below. Cross-persona-agreement and previously-flagged-but-unresolved items were re-surfaced as evidence those decisions are still pending — not duplicated here. The 11 restatements appear in the Coverage table of the review report and remain pending under the 2026-05-28 / 2026-05-29 subsections.

- **[Scope, affects R22–R26 — scope-guardian]** R22–R26 (five requirements + four mockups + five acceptance examples + an unresolved projection-source decision) is a large surface increment for a v1 composition primitive whose Summary motivation is observability via a "deliberate taste call" divider. Consider deferring the indented-gutter design and shipping v1 with a flat steps view + the plain-host divider already covered by R16; let the gutter return when real composition usage motivates it. Pane-only requirements (R22–R26 self-describe as such) do not block the core primitive.
- **[Technical, affects R8/R13/R15 — adversarial]** R15 specifies depth is carried in the `executionContext` ALS frame and increments per `runWorkflow` call; R8 names a fixed singleton-per-run service list (captureLock, host, etc.); R13 says `parallelDepth` / `homogeneousBranch` markers are inherited. The semantics for which ALS fields copy-by-value versus reference-share across a `runWorkflow` frame push are unspecified. Under two homogeneous-parallel sibling branches each invoking the same sub, an implementer who reads the depth field as a *mutation* of the inherited store (rather than a push-new-store with a fresh value) gets a depth race — depth telemetry desynchronizes against actual nesting. AE3's `depth: 1` assertion does not exercise the parallel-sibling case. ce-plan should pin down: depth lives in a pushed-new ALS store with its own value; markers are read-only inherited; services are reference-shared.
- **[Resume hazard, affects R9 — adversarial; extends the 2026-05-28 'Resume hazard' entry]** Beyond the decide→sub-reroute case already flagged, editing a sub's *body* between runs is silently miscached: the step name is unchanged, `runWorkflow` is not in the cache key, so the prior body's cached value replays inside the new body — including a value whose `returns` schema may no longer match. Same direction as the existing entry (include sub identity in the cache key for steps invoked inside a sub) but covers a strictly broader hazard surface.
- **[Technical, affects R10 — adversarial]** R10's host-error asymmetry (enter-throw propagates loud, exit-throw suppressed to `logger?.append`) means a host integration bug that throws on every lifecycle event is *loud* when it happens at enter and *silent* when it happens at exit. Consider writing the suppressed exit-handler error to `lifecycle.ndjson` as a structured warning record so `orch logs` exposes it; otherwise the only post-hoc trace is buried in agent log output.
- **[Technical, affects R11 — adversarial]** R11's "detached async work … silently lost" contract describes cwd-pointer behavior only. Side effects of detached worktree-creating calls (the worktree exists on disk; only the cwd write into the dead ALS frame is discarded) are not described. The Reuse force targets exactly the population of code most likely to extract inline ranges with embedded fire-and-forget worktree calls into a sub. Either tighten the contract ("`createWorktree` calls inside a sub MUST be awaited; un-awaited calls leak a worktree directory"), or add a detection mechanism.
- **[Technical, affects R23 — adversarial]** R23's "inside parallel" detection via `parallelBlockIdRef` reads truthy for *any* descendant of a parallel branch, not only for the immediate child. A sub invoked inside a parallel branch that itself runs a sequential `runWorkflow(inner, …)` will see `parallelBlockIdRef` truthy and render `inner` flat — even though `inner` is structurally sequential within its branch. The "uniform across the whole sub subtree" prose either accepts that reading (which the acceptance examples don't pin down) or needs an immediate-enclosing-scope check distinct from the ALS marker.
- **[Design, affects R22 + AE8 — design-lens]** The enter row's glyph state between "last child step completes" and "subworkflow:exit fires" is undefined. AE8 says `…` "until exit fires" — but the window where all child rows show `✓` and the enter row still shows `…` is observable. Specify whether the enter row holds `…` until exit, switches to `✓`/`✗` on last-child-completion, or hides entirely.
- **[Design, affects R24 + AE8 — design-lens]** Follow-live (`f`) committed-cursor behavior is specified for the exit-row-skip case only. The cursor's behavior during a live sub — before the first child `step:start` fires, while child steps are running, and at sub completion — is unspecified. Add a rule: while follow-live is active, the committed cursor always points to the most recently active *selectable* row (child step rows only), skipping boundary rows regardless of how the live event stream advances.
- **[Design, affects R22 + AE4 — design-lens]** AE4 covers cache-replay resume but the rendering rule for the enter row during the instantaneous replay window — where child steps replay synchronously before any pane frame renders — is unspecified. Specify whether the enter row briefly shows `…` during the replay window, is skipped entirely, or jumps directly to the exit row when the replay completes within one frame.
- **[Design, affects R22 failure mockup — design-lens]** The failure-outcome mockup annotates `✗ simple-feature  7.9s  (red)`. Whether `(red)` is *additive* to the `✗` glyph or the *primary* differentiator (with `✗` as fallback) is unclear. Affects no-color / color-blind terminal behavior and whether a `NO_COLOR`-style env-var fallback is required.
- **[Design, affects R22–R26 — design-lens]** Boundary rows' interaction with the `computeVisibleCount` vertical budget is unspecified. The preamble names "degrades sanely under the existing computeVisibleCount vertical budget" as a goal; R22–R26 do not say whether boundary rows count toward the budget, are evictable, or are sticky-while-sub-active. An implementer who treats them as ordinary rows will produce different scrolling behavior than one who treats them as zero-budget decorators.
- **[Design, affects R23 — design-lens]** The sub-of-sub-inside-parallel case has no acceptance example and no mockup. The prose says "Suppression is uniform across the whole sub subtree — a sub-of-a-sub-inside-parallel is also flat" but the mockup only shows depth-1 parallel children. Add an acceptance example showing the depth-2 child rendering inside a parallel branch (flat, no gutter, no compact token) so the suppression rule is verifiable.
- **[Design, affects R22 — design-lens]** Interaction between the enter row's `▼ <name>` rendering, the gutter prefix at depth ≥ 2, and `STEP_NAME_MAX = 30` is unspecified. At depth 3 the prefix consumes 6 characters before the name begins — naïvely applying `STEP_NAME_MAX` overflows the name column on a typical 80-col terminal. Specify whether the truncation budget is gutter-aware or column-aware.
