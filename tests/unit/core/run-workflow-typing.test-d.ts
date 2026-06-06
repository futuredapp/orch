// Compile-time tests for U5 — `runWorkflow` preserves a subworkflow's typed
// Args contract at the parent call site.

import type { runWorkflow as runWorkflowValue } from '../../../src/core/run-workflow.ts'
import type { WorkflowArgs, WorkflowExecutor } from '../../../src/core/workflow.ts'

interface ShipArgs extends WorkflowArgs {
  readonly prompt: string
  readonly slug: string
}

declare const SHIP: WorkflowExecutor<ShipArgs>
declare const runWorkflowForTypes: typeof runWorkflowValue

export function typeAssertions(): void {
  void runWorkflowForTypes(SHIP, { prompt: 'go', slug: 'feature-x' })

  // @ts-expect-error — `slug` is required by ShipArgs.
  void runWorkflowForTypes(SHIP, { prompt: 'go' })

  // @ts-expect-error — `prompt` is required by ShipArgs.
  void runWorkflowForTypes(SHIP, { slug: 'feature-x' })

  // @ts-expect-error — unknown fields are rejected for the sub's Args type.
  void runWorkflowForTypes(SHIP, { prompt: 'go', slug: 'feature-x', extra: true })
}

export type { ShipArgs }
