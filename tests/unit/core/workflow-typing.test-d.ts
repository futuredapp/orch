// MIGRATED → tests-new/unit/core/workflow-typing.test-d.ts (parent U13) — relocated verbatim (import paths only); kept skipped on disk (D2).
// Compile-time tests for U2 — generic `workflow<Args>` factory, default
// `Args = WorkflowArgs`, and the module-private body handle. These tests do
// NOT execute any runtime code; failures land at `tsc --noEmit` time.
//
// `runWorkflow` typing is covered in run-workflow-typing.test-d.ts; this file
// scopes to the factory and the executor shape.

import type {
  bodyHandle,
  WorkflowArgs,
  WorkflowExecutor,
  WorkflowFn,
} from '../../../src/core/workflow.ts'
import { workflow } from '../../../src/core/workflow.ts'
import type { Equal, Expect } from '../../helpers/type-assertions.ts'

// ---------------------------------------------------------------------------
// (1) Legacy `workflow('name', async (run, args) => ...)` — no generic, args
//     is typed as WorkflowArgs (source-compatible with every existing call
//     site under examples/ and tests/).
// ---------------------------------------------------------------------------

const LEGACY = workflow('legacy', async (_run, args) => {
  // args is WorkflowArgs (only `prompt?: string` reserved today).
  type _ArgsIsWorkflowArgs = Expect<Equal<typeof args, WorkflowArgs>>
  void args
})

type _LegacyExecutor = Expect<Equal<typeof LEGACY, WorkflowExecutor<WorkflowArgs>>>

// ---------------------------------------------------------------------------
// (2) Generic `workflow<Args>` — the body sees the typed shape, and the
//     resulting executor carries that Args through `WorkflowExecutor<Args>`.
// ---------------------------------------------------------------------------

interface ShipArgs extends WorkflowArgs {
  readonly prompt: string
  readonly slug: string
}

const SHIP = workflow<ShipArgs>('ship', async (_run, args) => {
  // args is ShipArgs — both `prompt` and `slug` are required.
  type _ArgsIsShipArgs = Expect<Equal<typeof args, ShipArgs>>
  void args
})

type _ShipExecutor = Expect<Equal<typeof SHIP, WorkflowExecutor<ShipArgs>>>

// ---------------------------------------------------------------------------
// (3) Generic Args must extend WorkflowArgs — non-extending shapes are
//     rejected at compile time. This guards against authors typing
//     `workflow<{ slug: string }>` and losing the prompt-presence contract.
// ---------------------------------------------------------------------------

// @ts-expect-error — `{ x: number }` does not satisfy `extends WorkflowArgs`
// (WorkflowArgs allows `prompt?: string`; an arbitrary shape that does not
// permit `prompt` as a string is incompatible).
const _BAD_NonExtending = workflow<{ x: number }>('bad', async (_run, _args) => {})

// ---------------------------------------------------------------------------
// (4) `WorkflowFn<Args>` default — referring to `WorkflowFn` without the
//     generic still works (no callers need to be updated).
// ---------------------------------------------------------------------------

declare const _legacyFn: WorkflowFn
type _LegacyFnArgs = Expect<Equal<Parameters<typeof _legacyFn>[1], WorkflowArgs>>

declare const _typedFn: WorkflowFn<ShipArgs>
type _TypedFnArgs = Expect<Equal<Parameters<typeof _typedFn>[1], ShipArgs>>

// ---------------------------------------------------------------------------
// (5) The body handle is a `unique symbol`. `keyof WorkflowExecutor` includes
//     the symbol — that is fine and expected — but when narrowed to string
//     keys (the surface consumers iterate via `Object.keys` / `for...in`),
//     only the public methods remain. The runtime non-enumerability is
//     covered in `workflow-name-validation.test.ts`.
// ---------------------------------------------------------------------------

type _PublicStringKeys = Expect<
  Equal<Extract<keyof WorkflowExecutor, string>, 'name' | 'execute' | 'resume'>
>

// ---------------------------------------------------------------------------
// (6) But the body IS readable via the symbol (this is the seam runWorkflow
//     will use). The type of `executor[bodyHandle]` carries the typed Args.
// ---------------------------------------------------------------------------

type _ShipBody = Expect<Equal<(typeof SHIP)[typeof bodyHandle], WorkflowFn<ShipArgs>>>
type _LegacyBody = Expect<Equal<(typeof LEGACY)[typeof bodyHandle], WorkflowFn<WorkflowArgs>>>

export type {
  _LegacyBody,
  _LegacyExecutor,
  _LegacyFnArgs,
  _PublicStringKeys,
  _ShipBody,
  _ShipExecutor,
  _TypedFnArgs,
}
// Suppress unused-binding warnings — these declarations ARE the tests.
export { _BAD_NonExtending, LEGACY, SHIP }
