// Compile-time tests for U5 — the `PromptFileRegistry` augmentation pattern.
//
// Simulates the augmentation that `orch types` (U7/U8) generates next to each
// `.md` / `.txt` prompt file. The `declare module 'orch'` block below stands
// in for the auto-generated sidecar; `step.define({ promptFile: '@/…' })`
// then resolves `TVars` via `PromptFileRegistry[TPath]`.

import type { Step } from '../../../../src/core/step.ts'
import { step } from '../../../../src/core/step.ts'
import type { RunFn } from '../../../../src/core/workflow.ts'
import type { Runner } from '../../../../src/runners/index.ts'
import type { Equal, Expect } from '../../../helpers/type-assertions.ts'

declare module 'orch' {
  interface PromptFileRegistry {
    '@/.orch/prompts/test-fixture.md': {
      topic: string
      depth?: number
    }
    '@/.orch/prompts/another.md': {
      slug: string
    }
  }
}

declare const fakeRunner: Runner
declare const run: RunFn

// ---------------------------------------------------------------------------
// (1) `step.define({ promptFile: '@/.orch/prompts/test-fixture.md' })`
//     resolves TVars via the augmented registry entry.
// ---------------------------------------------------------------------------

const FIXTURE = step.define('fixture', {
  agent: fakeRunner,
  promptFile: '@/.orch/prompts/test-fixture.md',
})

// The TVars side of the inferred Step type must match the registry entry.
type _FixtureTVars = Expect<Equal<typeof FIXTURE, Step<unknown, { topic: string; depth?: number }>>>

// Valid call — `topic` supplied.
declare const _r: Promise<unknown>
const _OK_TopicOnly: typeof _r = run(FIXTURE, { vars: { topic: 'auth' } })
const _OK_TopicAndDepth: typeof _r = run(FIXTURE, { vars: { topic: 'auth', depth: 3 } })

// @ts-expect-error — missing required `topic`
const _BAD_Empty: typeof _r = run(FIXTURE, {})

// @ts-expect-error — wrong type on `depth`
const _BAD_WrongType: typeof _r = run(FIXTURE, { vars: { topic: 'x', depth: 'wrong' } })

// ---------------------------------------------------------------------------
// (2) Multi-file augmentation merge — `@/.orch/prompts/another.md` registered
//     via the same `declare module 'orch'` block resolves separately.
// ---------------------------------------------------------------------------

const ANOTHER = step.define('another', {
  agent: fakeRunner,
  promptFile: '@/.orch/prompts/another.md',
})

type _AnotherTVars = Expect<Equal<typeof ANOTHER, Step<unknown, { slug: string }>>>

const _OK_AnotherSlug: typeof _r = run(ANOTHER, { vars: { slug: 'x' } })

// ---------------------------------------------------------------------------
// (3) Unregistered path — falls back to a widened `PromptVars` contract so a
//     mid-codegen edit doesn't red-light every consuming workflow before
//     `orch types` catches up.
// ---------------------------------------------------------------------------

const UNREG = step.define('unreg', {
  agent: fakeRunner,
  promptFile: '@/.orch/prompts/never-generated.md',
})

// vars: { anyKey: 'whatever' } typechecks against the widened PromptVars
// fallback. Runtime substitute() still enforces correctness once the prompt
// is read off disk.
const _OK_UnregAnyKey: typeof _r = run(UNREG, { vars: { anyKey: 'whatever' } })
const _OK_UnregBoolKey: typeof _r = run(UNREG, { vars: { flag: true } })

// Suppress unused-binding warnings.
export type { _AnotherTVars, _BAD_Empty, _BAD_WrongType, _FixtureTVars }
export { _OK_AnotherSlug, _OK_TopicAndDepth, _OK_TopicOnly, _OK_UnregAnyKey, _OK_UnregBoolKey }
