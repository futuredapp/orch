---
title: TUI `ask()` step — interactive user input as a first-class workflow step
type: feat
date: 2026-05-01
status: phases 18a + 18b + 18c landed 2026-05-01 — plain + noninteractive + two-pane Ink renderer end-to-end; examples/feature-loop ships the loop-with-feedback demo
brainstorm: docs/brainstorms/2026-04-30-tui-ask-step-brainstorm.md
review_integrated: 2026-05-01 (DHH / Kieran / code-simplicity reviewers)
---

# TUI `ask()` step — interactive user input as a first-class workflow step

## Overview

Add a built-in step factory `ask({ name, question, fields, buttons, defaultWhenNoninteractive? })` that pauses a workflow and renders a centered prompt with text inputs and labeled buttons. The factory returns a typed `Step<AskResult<F, B>>` that — like every other step — composes with `run()`, memoization (`as:`), and resume.

The result type is a discriminated union:

```ts
type AskResult<F, B> =
  | { readonly cancelled: true; readonly fields: Partial<F> }
  | { readonly cancelled: false; readonly button: B } & F
```

Host integration mirrors today's interactive Claude steps:

- `two-pane` mode: takes over the right pane (currently `respawn-pane -k cat`); the Ink renderer mounts in that pane's PTY, exits cleanly on submit/cancel, and the pane is respawned back to `cat` for the next streaming step.
- `plain` mode: `ReadlinePromptService` writes labeled prompt lines to stdout, reads stdin one line at a time, prints a `[orch] step:done ask-2 → { ... }` summary on completion.
- `single-pane` mode: deferred (the run-mode discriminant already reserves the slot).

This unlocks the **loop-with-feedback** pattern that motivated the brainstorm: after every iteration of `brainstorm → plan → work → review`, ask the human *"continue / retry / abort, with optional notes"* and feed the answer into the next iteration's prompt.

## Problem Statement / Motivation

The compound workflow today (`examples/compound/index.ts`, `examples/riddle-solver/index.ts`) cannot pause for human input without an interactive Claude step — which means a full `claude` subprocess just to ask a yes/no question. There is no way to:

1. Collect a typed answer from the human and feed it back into a later step's prompt.
2. Run the same workflow autonomously (CI, scheduled runs, agent-on-agent) by pre-declaring defaults.
3. Test workflow code that includes a prompt — interactive Claude steps require a real CLI and TTY.

The brainstorm identifies `ask()` as the missing primitive. Ink + `ink-text-input` + `useFocus`/`useFocusManager` give us the v1 in ~30 lines of React; the rest is wiring.

## Proposed Solution

A new step `kind: 'ask'`, sitting alongside `'agent' | 'commit' | 'worktree'` in the discriminated `StepConfig` union (`src/core/step.ts:103`). The factory `ask({...})` produces a frozen `Step<AskResult>` whose name is derived from the `name` field with the `ask:` prefix (parallel to `commit:` and `worktree:`).

The executor branch in `runStepOnce` (`src/core/workflow.ts:971-1001`) gets a new `case 'ask':` that delegates to `runAskStep`, which:

1. Resolves whether we're in `interactive` or `noninteractive` run mode.
2. In `interactive`: calls `deps.promptService.ask(promptSpec)` — the real adapter renders Ink (in two-pane) or readline (in plain) and returns `AskResult`.
3. In `noninteractive`: returns `defaultWhenNoninteractive` if declared, otherwise throws `AskNoDefaultError`.
4. Persists the result (atomic write via the existing `StateStore.saveStep`) so resume hits the cache.

A new `PromptService` port (`src/services/prompt/`) follows the existing service shape: `InkPromptService`, `ReadlinePromptService`, `FakePromptService`. The host wires the appropriate real impl into `WorkflowDeps`; `ask()` itself stays host-agnostic.

## Non-goals (v1)

- **No multi-line text, select, slider, or required-validation primitives.** Text + buttons + Esc/Ctrl-C cancel is the entire input vocabulary.
- **No per-step `forceReask` override.** Cache hit always returns cached value (deferred per brainstorm § Open Questions 4).
- **No idle timeout.** Ask blocks forever in interactive; noninteractive throws or uses the default. Workflow authors who want a timeout can wrap with `Promise.race`.
- **No `validate:` slot on ask config.** Mirrors the precedent that interactive steps cannot have `returns:` (`src/core/step.ts:152`). The factory's input type omits the slot; TS error at compile time.
- **No new view kind.** Ask renders inline in whichever pane the host hands it, same as today's interactive Claude steps. The view registry is untouched.
- **No new run mode.** The brainstorm proposes a new `--interactive`/`--noninteractive` axis, not a new `RunMode`. They compose orthogonally.

## Technical approach

### Architecture diagram

```
┌─────────────────── workflow.ts ────────────────────┐
│  runStepOnce(s)                                    │
│    switch (config.kind) {                          │
│      case 'agent':    runAgentStep / runInteractive│
│      case 'commit':   runCommitStep                │
│      case 'worktree': runWorktreeStep              │
│      case 'ask':      runAskStep   ◀── new branch  │
│    }                                               │
└─────────────────────────┬──────────────────────────┘
                          │ deps.promptService.ask(spec, ctx)
                          ▼
┌────────────────── PromptService port ──────────────┐
│   ask(spec: AskSpec, ctx: AskCtx): Promise<AskResult>│
└─────┬────────────┬─────────────────┬───────────────┘
      │            │                 │
      ▼            ▼                 ▼
 InkPromptSvc  ReadlinePromptSvc  FakePromptSvc
 (two-pane,    (plain mode +      (unit tests —
  uses pane    fallback)           scripted by name)
  PTY)
```

Key seam: **the executor never imports Ink, React, or tty internals.** It calls `promptService.ask(...)`. The Ink dep is contained inside `src/services/prompt/ink-prompt-service.ts`.

### File-by-file additions

#### New runtime deps (`package.json`)

```json
"dependencies": {
  "ink": "^7.0.1",
  "ink-text-input": "^6.0.0",
  "react": "^19.2.0",
  "zod": "^3.23.8",
  "zod-to-json-schema": "^3.25.2"
},
"devDependencies": {
  "@types/react": "^19.2.0",
  "ink-testing-library": "^4.0.0",
  ...
}
```

Notes from research (Context7 + npm registry, 2026-04-30):
- `ink-select-input` is **not added** — the brainstorm's button row needs Tab/Shift-Tab + Enter horizontally, which `ink-select-input` does not support (it's vertical-only and steals arrow keys). We use `useFocus` + `useFocusManager` from Ink directly.
- Realistic on-disk footprint with transitive deps (yoga-layout, chalk, react-reconciler) is ~4–6 MB, not the 1.2 MB the brainstorm estimated. `react-reconciler` alone is 1.7 MB. Worth confirming acceptable in PR review.
- `tsconfig.json` needs `"jsx": "react-jsx"` and `"jsxImportSource": "react"`. Bun reads tsconfig and performs the JSX transform itself — no Babel/esbuild loader needed.

#### `src/core/ask.ts` (new — modeled on `src/core/commit.ts`)

```ts
// src/core/ask.ts

import type { Step } from './step.ts'
import { stepName } from './types.ts'

const ASK_PREFIX = 'ask:'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AskField {
  readonly placeholder?: string
}

export interface AskFields {
  readonly [name: string]: AskField
}

export type FieldValues<F extends AskFields> = {
  readonly [K in keyof F]: string
}

export type AskResult<F extends AskFields, B extends string> =
  | { readonly cancelled: true; readonly fields: Partial<FieldValues<F>> }
  | ({ readonly cancelled: false; readonly button: B } & FieldValues<F>)

export interface AskInput<F extends AskFields, B extends string> {
  readonly name: string
  readonly question: string
  readonly fields?: F
  readonly buttons: ReadonlyArray<B>
  readonly defaultWhenNoninteractive?:
    | { readonly cancelled: true }
    | ({ readonly cancelled?: false; readonly button: B } & Partial<FieldValues<F>>)
}

export interface AskStepConfig {
  readonly kind: 'ask'
  readonly question: string
  readonly fields: AskFields
  readonly buttons: ReadonlyArray<string>
  readonly defaultWhenNoninteractive?: unknown
}

// ---------------------------------------------------------------------------
// ask() factory — const-generic over fields and buttons
// ---------------------------------------------------------------------------
//
// (No `text()` constructor in v1. There is one field shape, used directly:
//  `fields: { notes: { placeholder: 'optional' } }`. When a second field
//  kind lands, introduce a discriminator `kind: 'text' | 'select' | …` and
//  per-kind constructors then. Until then, every `kind: 'text'` we'd write
//  today is a tax for code that doesn't exist.)

export function ask<F extends AskFields, const B extends string>(
  input: AskInput<F, B>,
): Step<AskResult<F, B>> {
  validateName(input.name)
  validateQuestion(input.question)
  validateButtons(input.buttons)
  validateFieldNames(input.fields ?? {})

  const slug = slugify(input.name)
  if (slug.length === 0) {
    throw new Error(
      `ask() name "${input.name}" produces an empty slug — use alphanumeric characters`,
    )
  }

  const name = stepName(`${ASK_PREFIX}${slug}`)

  const config: AskStepConfig = {
    kind: 'ask' as const,
    question: input.question,
    // Shallow freeze: the `fields` map is sealed, but each individual `AskField`
    // is the caller's literal — currently safe (only `placeholder?: string` is
    // mutable, which is harmless). When a second field kind lands and field
    // values gain nested objects (e.g. `select.options`), each per-kind
    // constructor MUST freeze its own internals; do NOT rely on this freeze.
    fields: Object.freeze({ ...(input.fields ?? {}) }),
    buttons: Object.freeze([...input.buttons]),
    ...(input.defaultWhenNoninteractive !== undefined
      ? { defaultWhenNoninteractive: input.defaultWhenNoninteractive }
      : {}),
  }

  return Object.freeze({ name, config }) as Step<AskResult<F, B>>
}
```

**Validation rules (modeled on `commit.ts:39-50`, `worktree.ts:124-140`):**

- `name`: not empty, not whitespace-only, no null bytes, no newlines, no leading dash. The slug after sanitisation must be non-empty.
- `question`: not empty, not whitespace-only, no null bytes. Newlines allowed (multi-line questions render fine in Ink).
- `buttons`: array length ≥ 1 (a prompt with no buttons is unsubmittable). Each button: non-empty string, no null bytes, no newlines. Duplicates rejected.
- `fields` keys: must match `/^[a-zA-Z][a-zA-Z0-9_]*$/` (valid JS identifier-ish — they end up as object property names in the result type). Reject leading underscore (Ruby/Python "private" convention has no meaning for a UI field). Reject `$` (almost always library/transpiler-generated; surprising as a UI label).
- `fields` keys also rejected against `FORBIDDEN_FIELD_KEYS = new Set(['__proto__', 'constructor', 'prototype'])`. Belt-and-suspenders against prototype-pollution: the Ink renderer does `Object.fromEntries(spec.fields.map(f => [f.name, '']))`, which is a known sink without a guard.

**Const-generic notes:**

- `<const B extends string>` (TS 5.0+, satisfied by Bun's built-in TS) collapses `buttons: ['continue', 'retry'] as const` (or even without `as const` thanks to `const`-modifier) to `'continue' | 'retry'`. Without `const`, the inference would widen to `string`.
- `F extends AskFields` keeps the field-name keys precise. `FieldValues<F>` then maps each key to its TS type (currently always `string` for `'text'`; the conditional shape leaves room for `'select'` → union literal in v2).
- The result type's discriminated `cancelled` flag means TS narrows naturally on `if (result.cancelled) ...` vs the `else` branch — the `button` and field properties are gone from `cancelled: true`, and `fields: Partial<FieldValues<F>>` carries whatever was typed before Esc.

#### `src/core/step.ts` — wire the new kind

Three small edits:

```ts
// line ~103 — extend the discriminated union:
export type StepConfig<T = unknown> =
  | AgentStepConfig<T>
  | CommitStepConfig
  | WorktreeStepConfig
  | AskStepConfig

// line ~110 — add 'ask:' to RESERVED_PREFIXES:
const RESERVED_PREFIXES: readonly string[] = ['commit:', 'worktree:', 'ask:']

// line ~144 — error message branch:
const factory =
  prefix === 'commit:' ? 'commit()'
  : prefix === 'worktree:' ? 'createWorktree()'
  : 'ask()'
```

And one switch arm in `onCacheHit` (`src/core/step.ts:195`):

```ts
case 'ask':
  // No-op on cache replay. Cached value is `AskResult`; no schema to
  // re-validate. Definition-vs-cache drift (button removed, field renamed)
  // is detected separately by `isAskCacheValid` BEFORE `runStepOnce` reaches
  // the cache-hit branch — mismatch downgrades the hit to a miss without
  // throwing. NO sentinel exception, NO control-flow-via-error pattern.
  // See § Cache-validity & resume contract.
  return
```

#### `src/core/workflow.ts` — new executor branch

In `runStepOnce` (line 971-1001):

```ts
case 'ask':
  result = await runAskStep(deps, config, key, overrides, stepSpan)
  break
```

`runAskStep` lives in `src/core/ask-executor.ts` (new file — keeps `workflow.ts` under its 300-line budget; pattern follows `worktree.ts`):

```ts
// src/core/ask-executor.ts

export async function runAskStep(
  deps: WorkflowDeps,
  config: AskStepConfig,
  key: StepName,
  overrides: RunOverrides | undefined,
  stepSpan: StepSpan | undefined,
): Promise<{ value: unknown; entry: StepEntry }> {
  // Guard 1: reject inside parallel() — same precedent as InteractiveParallelError
  if (currentParallelDepth() > 0) throw new AskParallelError(key)

  // Guard 2: reject prompt/extraContext/extraPrompt overrides (parallel to
  // runCommitStep guards at workflow.ts:895-903)
  rejectAgentOverrides(overrides, key)

  const startedAt = deps.clock.now()

  emitStepLifecycle(deps.host, stepSpan, {
    type: 'step:start',
    stepName: key,
    mode: 'interactive', // ask is interactive in spirit; reuses the lifecycle event
  })

  // ── Cache-validity preflight ──
  // If a cached entry exists but its shape doesn't match the current config
  // (button removed, field renamed), `runStepOnce` already short-circuited
  // via onCacheHit. Mismatch detection lives there — see § Resume contract.

  let value: AskResult<AskFields, string>
  try {
    if (deps.interactivity === 'noninteractive') {
      value = resolveDefault(config, key)  // throws AskNoDefaultError if absent
    } else {
      value = await deps.promptService.ask(
        toPromptSpec(config),
        { stepName: key, host: deps.host },
      )
    }
  } catch (err) {
    const durationMs = deps.clock.now() - startedAt
    emitStepFailure(deps.host, stepSpan, key, err, /*inParallel=*/ false, durationMs)
    throw err
  }

  const durationMs = deps.clock.now() - startedAt
  emitStepSuccess(deps.host, stepSpan, key, /*inParallel=*/ false, durationMs)

  const entry: StepEntry = {
    name: key,
    value,
    startedAt,
    endedAt: deps.clock.now(),
    artifacts: [],
    validations: [],
    mode: 'interactive',
    transcriptEventCount: 0,
    transcriptTruncated: false,
  }
  return { value, entry }
}
```

#### `src/core/errors.ts` — two new error classes

```ts
export class AskParallelError extends Error {
  constructor(readonly stepName: StepName) {
    super(
      `Ask step "${stepName}" cannot run inside parallel() — ` +
        'UI/stdin is single-tenant. Hoist the ask above the parallel block ' +
        '(collect input once, then fan out), or move it below (fan-in, then ask).',
    )
    this.name = 'AskParallelError'
  }
}

// Synthesizes a tailored remediation from the actual config — buttons and
// field keys come from the step the developer just wrote, not a generic
// "{ button: '...' }" template they have to guess from.
export class AskNoDefaultError extends Error {
  constructor(
    readonly stepName: StepName,
    readonly config: AskStepConfig,
  ) {
    const buttons = config.buttons.map((b) => `'${b}'`).join(' | ')
    const fieldKeys = Object.keys(config.fields)
    const firstButton = config.buttons[0]
    const buttonHint = firstButton !== undefined ? `'${firstButton}'` : "'…'"
    const fieldsHint =
      fieldKeys.length === 0 ? '' : `, ${fieldKeys.map((k) => `${k}: ''`).join(', ')}`
    super(
      `Ask step "${stepName}" has no \`defaultWhenNoninteractive\` and the run is in noninteractive mode.\n` +
        `Add a default to the ask() config, e.g.:\n` +
        `  defaultWhenNoninteractive: { button: ${buttonHint}${fieldsHint} }\n` +
        `(buttons available: ${buttons}` +
        (fieldKeys.length > 0 ? `; field keys: ${fieldKeys.map((k) => `'${k}'`).join(', ')}` : '') +
        `)`,
    )
    this.name = 'AskNoDefaultError'
  }
}
```

**Deleted from this section vs. the original draft:**

- `AskCancelError` — was an empty class with a "reserved for v2" comment. Pure YAGNI; if cancel-as-error becomes useful, add it then with the actual use case in front of us.
- `AskCacheStaleError` — was a sentinel thrown by `onCacheHit` and caught two lines later by `runStepOnce`. Replaced by a boolean predicate `isAskCacheValid` (private to `src/core/ask-executor.ts`). Throwing-and-catching in the same call stack to communicate "not really an error" is exactly the cleverness this codebase doesn't need.

#### `src/services/prompt/` (new module — full layout)

```
src/services/prompt/
├── prompt-service.ts        ← port
├── ink-prompt-service.ts    ← real (Ink renderer)
├── ink-app.tsx              ← React component used by Ink
├── readline-prompt-service.ts ← real (plain mode)
├── fake-prompt-service.ts   ← test double (FIFO scripted)
└── index.ts                 ← public barrel
```

**Port (`prompt-service.ts`):**

```ts
export interface PromptField {
  readonly name: string
  readonly placeholder?: string
}

export interface PromptSpec {
  readonly question: string
  readonly fields: ReadonlyArray<PromptField>
  readonly buttons: ReadonlyArray<string>
}

export interface PromptCtx {
  readonly stepName: StepName
  readonly host: Host
}

export type PromptResult =
  | { readonly cancelled: true; readonly fields: Readonly<Record<string, string>> }
  | { readonly cancelled: false; readonly button: string; readonly fields: Readonly<Record<string, string>> }

export interface PromptService {
  ask(spec: PromptSpec, ctx: PromptCtx): Promise<PromptResult>
}
```

> **Note:** the port speaks `Record<string, string>` for fields. The const-generic `AskResult` lives in `src/core/ask.ts`; `runAskStep` casts the port's `PromptResult` into the typed shape after merging in the field record. Keeping the port untyped over fields means `PromptService` doesn't carry generics across the seam — same pattern as `Runner.extractStructuredOutput()` returning `unknown` and the executor casting after Zod-parse.

**Real Ink adapter (`ink-prompt-service.ts`):**

The lifecycle pattern, distilled from research:

```ts
export class InkPromptService implements PromptService {
  async ask(spec: PromptSpec, ctx: PromptCtx): Promise<PromptResult> {
    const { promise, resolve } = Promise.withResolvers<PromptResult>()

    // Two-pane: ctx.host has already respawned the right pane to a shell
    // before runAskStep was called (see § Two-pane handoff). Ink renders
    // into THAT pane's PTY, not the orch CLI's controlling TTY.
    //
    // Plain: would never reach here — runAskStep routes plain through
    // ReadlinePromptService instead. Belt-and-suspenders: throw if mode
    // is plain to surface a wiring bug at the seam.
    if (ctx.host.mode === 'plain') {
      throw new Error('InkPromptService misrouted under --mode=plain')
    }

    const instance = render(
      React.createElement(AskApp, { spec, onResolve: resolve }),
      {
        exitOnCtrlC: false,    // we resolve { cancelled: true } instead
        patchConsole: false,   // never steal console.log from the host
      },
    )

    try {
      return await promise
    } finally {
      instance.unmount()
      await instance.waitUntilExit()  // flush stdout before pane returns to cat
    }
  }
}
```

Key research-confirmed details:

- `exitOnCtrlC: false` — without this, Ctrl-C kills the host process; with it, our `useInput(({ ctrl, escape }) => ...)` handler fires and calls `onResolve({ cancelled: true, fields: snapshotFields() })`.
- `patchConsole: false` — prevents Ink from hijacking `console.*` for the host process (would interleave with orch's `[orch]` lines).
- `instance.unmount()` THEN `await instance.waitUntilExit()` — guarantees stdout flushes (cursor restore, raw-mode off) before the pane is respawned to `cat`.
- We do NOT pass `alternateScreen: true` — the pane is a normal scrollback PTY, not the host's main terminal; alt-screen would be wrong here.

**Ink component (`ink-app.tsx`):**

```tsx
import { Box, Text, useFocus, useFocusManager, useInput } from 'ink'
import TextInput from 'ink-text-input'
import React, { useCallback, useState } from 'react'

interface AskAppProps {
  readonly spec: PromptSpec
  readonly onResolve: (r: PromptResult) => void
}

export function AskApp({ spec, onResolve }: AskAppProps): React.ReactElement {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(spec.fields.map((f) => [f.name, ''])),
  )

  const submit = useCallback(
    (button: string) => onResolve({ cancelled: false, button, fields: values }),
    [onResolve, values],
  )

  const cancel = useCallback(
    () => onResolve({ cancelled: true, fields: values }),
    [onResolve, values],
  )

  // Esc / Ctrl-C: always-on cancel
  useInput((_, key) => {
    if (key.escape || (key.ctrl && _.toLowerCase() === 'c')) cancel()
  })

  // Tab/Shift-Tab traversal across fields + buttons
  const { focusNext, focusPrevious } = useFocusManager()
  useInput((_, key) => {
    if (key.tab && key.shift) focusPrevious()
    else if (key.tab) focusNext()
  })

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
      <Text>{spec.question}</Text>
      <Box flexDirection="column" marginTop={1}>
        {spec.fields.map((f) => (
          <FieldRow key={f.name} field={f} value={values[f.name] ?? ''} onChange={(v) =>
            setValues((prev) => ({ ...prev, [f.name]: v }))
          } />
        ))}
      </Box>
      <Box marginTop={1} gap={2}>
        {spec.buttons.map((b) => (
          <Button key={b} id={`btn-${b}`} label={b} onPress={() => submit(b)} />
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>tab/⇧tab move · enter pick · esc cancel</Text>
      </Box>
    </Box>
  )
}

function FieldRow({ field, value, onChange }: {
  field: PromptField
  value: string
  onChange: (v: string) => void
}): React.ReactElement {
  const { isFocused } = useFocus({ id: `field-${field.name}` })
  return (
    <Box flexDirection="column">
      <Text>{field.name}:</Text>
      <Box borderStyle="single">
        <TextInput value={value} onChange={onChange} focus={isFocused} placeholder={field.placeholder} />
      </Box>
    </Box>
  )
}

function Button({ id, label, onPress }: {
  id: string
  label: string
  onPress: () => void
}): React.ReactElement {
  const { isFocused } = useFocus({ id })
  useInput((_, key) => {
    if (isFocused && key.return) onPress()
  }, { isActive: isFocused })
  return <Text inverse={isFocused}> {label} </Text>
}
```

**Why `useFocus` + `useFocusManager` (not `ink-select-input`):** the brainstorm's button row is horizontal (`tab/⇧tab move · enter pick`). `ink-select-input` is vertical-only and steals arrow keys. Ink's first-class focus manager handles both fields and buttons under one Tab traversal — exactly the brainstorm's UX. (Research note: confirmed against ink readme via Context7.)

**Plain adapter (`readline-prompt-service.ts`):**

```ts
import { createInterface } from 'node:readline'

export class ReadlinePromptService implements PromptService {
  async ask(spec: PromptSpec, ctx: PromptCtx): Promise<PromptResult> {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      process.stdout.write(`[${ctx.stepName}] ${spec.question}\n`)
      const fields: Record<string, string> = {}
      for (const f of spec.fields) {
        const placeholder = f.placeholder ? ` (${f.placeholder})` : ''
        fields[f.name] = await ask(rl, `[${ctx.stepName}] ${f.name}${placeholder}: `)
      }
      const labels = spec.buttons.map((b, i) => `(${i + 1}) ${b}`).join('  ')
      const MAX_RETRIES = 5
      // Out-of-range → re-prompt (NOT silent cancel). 70 years of CLI
      // convention: invalid choice loops with a clear error. Bounded by
      // MAX_RETRIES to guard against EOF loops if stdin closes.
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const choice = await ask(rl, `[${ctx.stepName}] choose: ${labels}  [1]: `)
        if (choice.trim() === '') {
          const first = spec.buttons[0]
          if (first === undefined) return { cancelled: true, fields }  // unreachable
          return { cancelled: false, button: first, fields }
        }
        const idx = Number.parseInt(choice, 10) - 1
        const button = spec.buttons[idx]
        if (button !== undefined) return { cancelled: false, button, fields }
        process.stdout.write(
          `[${ctx.stepName}] invalid choice "${choice}"; pick 1-${spec.buttons.length}\n`,
        )
      }
      return { cancelled: true, fields }
    } finally {
      rl.close()
    }
  }
}

function ask(rl: import('node:readline').Interface, q: string): Promise<string> {
  return new Promise((resolve) => rl.question(q, resolve))
}
```

Cancel in plain: type Ctrl-D (EOF) — `rl.question` rejects, the executor's catch path fires, and the workflow can react. (Not pretty, but plain is the fallback path; humans running interactively will be in two-pane.)

**Fake adapter (`fake-prompt-service.ts`):**

Pattern follows `FakeProcessService` (`src/services/process/fake-process-service.ts`) — name-keyed scripted responses:

```ts
export class FakePromptService implements PromptService {
  private readonly scripts = new Map<string, PromptResult>()
  private readonly calls: Array<{ stepName: StepName; spec: PromptSpec }> = []

  when(stepName: string): { respondWith(r: PromptResult): FakePromptService } {
    return {
      respondWith: (r) => {
        this.scripts.set(stepName, r)
        return this
      },
    }
  }

  async ask(spec: PromptSpec, ctx: PromptCtx): Promise<PromptResult> {
    this.calls.push({ stepName: ctx.stepName, spec })
    const scripted = this.scripts.get(ctx.stepName)
    if (scripted === undefined) {
      throw new Error(
        `FakePromptService: unscripted ask for step "${ctx.stepName}". ` +
          `Configure via .when("${ctx.stepName}").respondWith({...}).`,
      )
    }
    return scripted
  }

  recorded(): ReadonlyArray<{ stepName: StepName; spec: PromptSpec }> {
    return this.calls
  }
}
```

#### `WorkflowDeps` extension (`src/core/workflow.ts:130-165`)

Two new fields:

```ts
export interface WorkflowDeps {
  // ... existing ...

  /** Renders interactive prompts; supplied by the host wiring at the
   *  composition root. Absent → ask() steps throw at the call site. */
  readonly promptService: PromptService

  /** Run-level interactivity axis (orthogonal to RunMode).
   *  Renamed from `runtimeMode` after review — `runtimeMode` collides with
   *  the existing `RunMode` type from `src/core/run-mode.ts`.
   *
   *  - 'interactive' (default): ask renders normally.
   *  - 'noninteractive': ask resolves from defaultWhenNoninteractive,
   *    or throws AskNoDefaultError if none declared.
   *
   *  Sourced from CLI flag (`--interactive` / `--noninteractive`) or
   *  `ORCH_NONINTERACTIVE=1` env var per invocation. NOT persisted to
   *  RunState. Resume reads whatever the resumer passes — see
   *  § Cache-validity & resume contract for the resume-into-noninteractive
   *  crash case. */
  readonly interactivity: 'interactive' | 'noninteractive'
}
```

`promptService` is required (not optional). Wiring at the composition root (`src/cli/deps.ts`) routes by host mode:

```ts
function makePromptService(host: Host): PromptService {
  if (host.mode === 'plain') return new ReadlinePromptService()
  return new InkPromptService()
}
```

#### CLI flag (`src/cli/main.ts:108-174`)

`parseArgv` gains the run-level axis:

```ts
options: {
  // ...existing
  interactive: { type: 'boolean' },          // default true
  noninteractive: { type: 'boolean' },       // default false
}

// After parsing:
if (values.interactive === true && values.noninteractive === true) {
  throw new ArgvError('Cannot specify both --interactive and --noninteractive')
}
const interactivity: 'interactive' | 'noninteractive' =
  values.noninteractive === true || process.env.ORCH_NONINTERACTIVE === '1'
    ? 'noninteractive'
    : 'interactive'
```

`interactivity` flows through `CliOpts` (`src/cli/main.ts:55-71`) into every command handler, then into `WorkflowDeps`.

**No state schema bump.** `interactivity` is NOT persisted to `RunState`. The original draft proposed v5 → v6 with a persisted `runtimeMode` field; review rejected it as a schema commitment for a one-bit per-invocation knob. State stays at `schemaVersion: 5`.

**Resume contract:**

- `orch resume <id>` (no flag) → `interactive`. Asks re-render normally; cached answers replay from the persisted `StepEntry` regardless of the original run's mode.
- `orch resume <id> --noninteractive` → `noninteractive`. Cached asks still replay (the answer is already saved). Asks not yet executed need `defaultWhenNoninteractive`; otherwise `AskNoDefaultError` fires at the first non-defaulted ask the resumer reaches.
- A workflow started interactively where the human cancels and the run dies: resuming under `--noninteractive` will crash the *first* non-defaulted ask the executor reaches. The `AskNoDefaultError` body names the step, lists buttons, and synthesizes the suggested `defaultWhenNoninteractive` from the actual config — so the developer can paste-edit and resume.

If durable per-run policy ever genuinely matters, persist it inside the existing `RunState.args` (free-form bag) without bumping `schemaVersion`. The current proposal does not need this.

#### Two-pane handoff (`src/hosts/two-pane/*`)

Today's interactive Claude path uses `host.runInteractive(...)` (`src/hosts/host.ts:92`) which respawns the right pane via `respawn-pane -k <claude-argv>`. For ask:

1. `runAskStep` does NOT call `host.runInteractive` — it calls `promptService.ask`.
2. The host needs a new method: `host.attach('right')` (already exists, line 82) returns a `PaneAttachment`. Two-pane respawns the pane to a shell that keeps `process.stdin/stdout` connected to the orch process — Ink renders into the pane's PTY.

**Wait — here's the subtle bit.** Ink's `render(...)` writes to `process.stdout` of the calling process. For two-pane, the orch CLI process is NOT in the pane; the pane is a tmux-managed PTY. We have two implementation choices:

**Option A — spawn a child Ink process per ask, via tmux respawn-pane.**
- Pattern matches today's interactive Claude exactly.
- The child process mounts Ink, writes the result to a temp file (`.orch/state/<runId>/asks/<stepName>.json`), exits.
- Parent reads the file, deletes it, returns the result.
- **Pro**: fits the existing host port unchanged (`runInteractive`).
- **Con**: serialization overhead; extra Bun process per ask; can't share React module state.

**Option B — pipe orch's stdin/stdout into the right pane, mount Ink in the orch process.**
- Use `host.attach('right')` to grab the pane.
- Use tmux `pipe-pane -O` and `respawn-pane` so the pane's PTY becomes the orch process's stdin/stdout for the duration of the ask.
- **Pro**: single process; instant; React state lives where the executor lives.
- **Con**: requires `Host` interface to grow `host.borrowPane(): { stdin, stdout, release() }`. The plain host returns `process.std{in,out}`; the two-pane host returns the pane's PTY fds.

**Recommendation (deferred for design review): Option A** for v1. It's the path of least resistance: matches the existing `runInteractive` shape, no new Host API surface, and the few-ms spawn cost is invisible to a human pressing Tab/Enter. The "proper" stdout/PTY redirection in Option B is genuinely complex and risks regressing the interactive Claude path. We can revisit in v2 if Option A's overhead matters.

Concretely for Option A:

- `InkPromptService.ask(spec, ctx)` builds an argv: `bun run <repo>/src/services/prompt/ink-runner.ts --spec <base64-json>`.
- Calls `ctx.host.runInteractive({ argv, env, cwd, stepName: ctx.stepName })`.
- Receives `{ exitCode, durationMs }`.
- Reads the result from `.orch/state/<runId>/asks/<stepName>.json` (atomic write from the child).
- Cleans up the file. Returns the parsed `PromptResult`.

The class name `InkPromptService` describes the *port-side abstraction* (renders an Ink prompt); internally it is a spawn-Ink-child orchestrator. The slight name-vs-implementation lag in v1 is acceptable — if the spawn approach changes (Option B in v2), the public class name stays correct.

**Spawn cost back-of-envelope.** Bun cold-start is ~30-80 ms; human reaction time to a prompt is ≥250 ms. Spawn overhead is ≤30 % of one keystroke — invisible to the user. Documented inline so the next person doesn't relitigate it.

**Distribution caveat (v1: checkout-only).** `bun run <repo-path>/.../ink-runner.ts` works in a checkout but breaks for any installed/published context (`npm install -g`, etc.). v1 ships as checkout-only; before we promote orch to a published binary, `ink-runner.ts` gets a proper `bin` entry in `package.json`. Tracked as a TODO comment in `ink-prompt-service.ts` next to the argv construction. Phase 18b's DoD includes the TODO.

#### Public barrel (`src/core/index.ts`)

```ts
export type { AskField, AskFields, AskInput, AskResult, AskStepConfig, FieldValues } from './ask.ts'
export { ask } from './ask.ts'
export { AskParallelError, AskNoDefaultError } from './errors.ts'
```

**Dropped from the original draft:**
- `text` / `TextField` — see § factory section. v1 fields are bare `{ placeholder?: string }`.
- `AskCancelError` — was an empty placeholder.
- `AskCacheStaleError` — replaced by a private `isAskCacheValid` predicate inside `ask-executor.ts`.

Note: errors are exported as values (not just types) — `AskParallelError` and `AskNoDefaultError` are Error subclasses callers may `instanceof`-check. The original draft's `export type { ... }` was wrong.

### Cache-validity & resume contract

Brainstorm § Resume contract: "If the cached answer no longer matches the current step definition (button removed, field renamed), discard cache and re-prompt; log a one-liner so the resume isn't silent."

**Boolean predicate, not a thrown sentinel.** `runStepOnce`'s cache-hit branch (`src/core/workflow.ts:953-966`) gains an early check for `kind: 'ask'` BEFORE invoking `onCacheHit`:

```ts
// in runStepOnce, before the existing onCacheHit dispatch:
if (s.config.kind === 'ask' && !isAskCacheValid(s.config, cached.value)) {
  deps.host.log?.(
    `[orch] cache-stale ${key} — re-prompting (definition changed since persist)`,
  )
  // Fall through to the normal execution path; the existing atomic-write on
  // success replaces the stale entry. NO sentinel exception.
} else {
  // existing onCacheHit / cache-replay path
  ...
}
```

`isAskCacheValid(config, cachedValue)` lives in `src/core/ask-executor.ts` and is NOT exported (private to the module):

- `cachedValue.cancelled === true` → always valid (cancel doesn't depend on the buttons/fields shape).
- Otherwise: `cachedValue.button` ∈ current `config.buttons` AND every key in `Object.keys(config.fields)` is present as a property on `cachedValue` (renames or additions invalidate). Extra keys on `cachedValue` from a removed field are ignored (forward-compat tolerance).

The implementation is ~15 lines. No `AskCacheStaleError` class, no public export, no throw-and-catch-in-the-same-call-stack pattern.

### Cancel semantics on resume

**A cancelled ask IS cached.** The persisted `StepEntry` carries `value: { cancelled: true, fields: { ... } }`; resume replays it as if the human cancelled again. The workflow author's `if (result.cancelled) { ... }` branch decides what cancel means for that workflow (break the loop, halt, prompt elsewhere).

Rationale: caching cancel keeps replay deterministic and matches every other step kind ("a value is a value"). Workflow authors who want "Esc = retry, abort = explicit choice" should encode abort as a labeled button (`buttons: ['continue', 'retry', 'abort']`); `Esc` / `Ctrl-C` remains the orthogonal control-flow escape hatch.

Escape hatch for a glitched cancel that the developer wants to redo: edit `.orch/state/<runId>/state.json` and remove the offending step entry, then resume. Documented in `docs/getting-started.md` under "Recovering from an accidental cancel."

(This is a deliberate v1 decision after review surfaced the question. If a future workflow needs cancel-not-cached semantics by default, add an `AskInput.recancelOnResume?: boolean` opt-in. Until then, cache-cancel is the default and the only mode.)

### Lifecycle & observability

- `step:start` mode: `'interactive'`. `StepEntry.mode` stays in the existing `'interactive' | 'autonomous'` union (`src/state/state-store.ts:25`). Reuses today's lifecycle event shape — no new event types, no schema-union expansion.
- `step:complete` carries `durationMs`. Wall-clock from start to result write — including idle time. (Brainstorm § Wall-clock elapsed: same rule as interactive Claude.)
- **Aggregate run timing excludes asks.** Any "total run wall-clock" or "average step duration" panel/log MUST exclude `kind: 'ask'` entries (or label idle time separately) — a human who walks away for 6 hours produces a `durationMs` of ~21,600,000 and would corrupt capacity-planning math. Acceptance criterion below.
- Status pane glyph: reuse `↯` (suspended/awaiting human). Already rendered for today's interactive escalation rows; the ask step inherits it for free via `step:start mode === 'interactive'`. Status renderer (`src/observability/status-pane.ts`) adds an "awaiting input" sub-line when the lifecycle is `step:start mode: 'interactive'` AND `step:complete` hasn't fired (already supported — see brainstorm UI mockup).
- Per-step session log: `agents/<step>/session.json` (the existing per-step folder) gets a new `kind: 'ask'` discriminant — aligned with `StepConfig.kind`, NOT a third value of `mode`. The two are kept distinct: `mode` is "how does the runner stream output" (`'interactive' | 'autonomous'`), `kind` is "what kind of step is this" (`'agent' | 'commit' | 'worktree' | 'ask'`). The original draft conflated them under `mode: 'ask'`; review caught the inconsistency. Embed the `PromptSpec` and resolved `AskResult`:
  ```json
  { "stepName": "ask-2", "kind": "ask", "mode": "interactive",
    "spec": {...}, "result": {...},
    "durationMs": 12345, "cancelled": false, "button": "retry" }
  ```

### Cost / tokens

`StepEntry.value` is the `AskResult`. The status renderer shows `—` for cost and tokens (per brainstorm § Wall-clock elapsed) — no new fields, the "ask" rows are simply absent from the runner-cost rollup.

### Examples wiring (deferred to follow-up PR)

`examples/feature-loop/` demonstrates the brainstorm's loop-with-feedback pattern. **Not blocking for the v1 merge.** Lands as a follow-up PR after the feature is on `main`, so the example is written against the shipped public API (and against the real `InkPromptService` from phase 18b) rather than a moving target.

Planned contents (for the follow-up):

- `steps.ts`: `BRAINSTORM`, `PLAN`, `WORK`, `REVIEW`, `ASK_CONTINUE`.
- `index.ts`: the `for (let i = 0; i < 5; i++) { ... }` workflow body.
- `README.md`: how to run interactively (`orch run feature-loop`) vs. autonomously (`orch run feature-loop --noninteractive`).

## Acceptance criteria

### Functional

- [x] `ask({ name, question, buttons, fields?, defaultWhenNoninteractive? })` returns `Step<AskResult>` with const-generic button union and field-name-keyed object type. The TS test `tests/unit/core/ask-types.test-d.ts` asserts `Expect<Equal<...>>` for both branches of the discriminated union AND for const-generic narrowing without `as const` (the load-bearing assertion — if it fails the API is meaningfully worse than advertised).
- [x] `ask:` is in `RESERVED_PREFIXES`; `step.define('ask:foo', ...)` throws with a message pointing to the `ask()` factory.
- [x] `ask()` validates each rejection independently (each is its own test, see § Test plan): empty `name`, whitespace-only `name`, name with null byte, name with newline; empty `question`, question with null byte; empty `buttons` array; duplicate `buttons`; field key not matching `/^[a-zA-Z][a-zA-Z0-9_]*$/`; field key in `FORBIDDEN_FIELD_KEYS` (`__proto__`, `constructor`, `prototype`). Each rejection has a specific error message naming the offending input.
- [x] `await run(ASK)` inside `parallel(...)` throws `AskParallelError` with a hoist-above-or-fan-in message — NOT a "switch to --noninteractive" remediation (which would be a behavior change, not a fix).
- [x] `await run(ASK)` under `--noninteractive`:
   - With `defaultWhenNoninteractive: { button: 'continue' }` and a config field `notes` that has no default → resolves to `{ cancelled: false, button: 'continue', notes: '' }`. Missing field values are zero-filled with `''`. Pinned in test + JSDoc on `AskInput.defaultWhenNoninteractive`.
   - Without a default → throws `AskNoDefaultError` at the call site, naming the step AND synthesizing the suggested `defaultWhenNoninteractive` value from the actual config (button list + field keys).
- [x] `await run(ASK)` under `--interactive` (default) calls `promptService.ask(spec, ctx)`. The cached value is persisted atomically; resume returns the cached value without re-prompting.
- [x] **Cancelled ask IS cached.** Resuming a run after the user pressed Esc replays the cancel without re-prompting; `FakePromptService.recorded()` shows zero calls on resume. (See § Cancel semantics on resume.)
- [x] Cache-stale detection (buttons): changing the buttons list between runs and resuming logs `cache-stale ask-<step>` and re-prompts. Implemented as a boolean predicate (`isAskCacheValid`) — NOT a thrown sentinel. Test asserts behavior (FakePromptService called with new spec) and persisted-entry replacement; the log string is a bonus, not the contract.
- [x] Cache-stale detection (field keys): renaming/removing a field key between runs invalidates the cache and re-prompts. Separate test.
- [x] Cache-stale tolerance: a `cancelled: true` cached value stays valid across button/field changes (cancel doesn't depend on shape).
- [x] **Resume from interactive into `--noninteractive`** without defaults → `AskNoDefaultError` at the first non-defaulted ask. Error names the offending step and synthesizes the default; resuming again with the synthesized default succeeds.
- [x] `validate:` slot is rejected at the type level in `ask()` (the input type omits it; TS error if specified). NOTE: type-level only — the `interactive`-mode `returns:` precedent at `step.ts:152` has both type-level AND runtime guards; for `validate:` on `ask()` we omit the runtime guard because the input type cannot be coerced through ordinary call-sites. Documented inline so the next maintainer doesn't read this as inconsistency.
- [x] Cancel returns `{ cancelled: true, fields: <whatever-was-typed> }`; TS narrows so `result.button` is unreachable in the `cancelled === true` branch.
- [ ] Aggregate run timing (any "total wall-clock" or "average step duration" panel) excludes `kind: 'ask'` entries OR labels idle time as such. Asserted by a test exercising `printRunSummary` (or equivalent) on a run containing an ask with a sleep before answering. (Deferred — no aggregate panel exists yet that needs the gate; revisit when one lands.)

### Non-functional

- [x] No new `child_process`, `node-pty`, or `Bun.spawn` import outside `src/services/process/` (CLAUDE.md rule 1). Ink's stdin/stdout consumption goes through the `PromptService` adapter, which calls `host.runInteractive` (existing seam).
- [x] No `mock.module`, `vi.mock`, or `jest.mock` in tests for `src/core/`, `src/state/`, `src/runners/` (CLAUDE.md rule 3). All ask tests mock `PromptService` (the port) only.
- [x] Files ≤ 300 lines, functions ≤ 60 lines (CLAUDE.md rule 5). `src/core/ask.ts` ≤ 180 lines (down from 200 after dropping `text()`/`FieldKind`); `src/core/ask-executor.ts` ≤ 150 lines; `src/services/prompt/ink-app.tsx` ≤ 200 lines.
- [x] `bun run check` is green on the branch. The `ink-prompt-service.ts` import does NOT pull React/Ink into test execution paths (lazy `import()` if test runner complains; Ink's React 19 peer dep otherwise gets eager-loaded). (18b concern; 18a ships no Ink.)

### Quality gates

- [x] All three layers covered (CLAUDE.md gate). See § Test plan. (Layer 3 real-Ink test is 18b.)
- [x] Implementation phases roadmap (`docs/plans/implementation-phases.md`) gets a new "Phase 18 — TUI ask step" block with status `◐ in progress` until phase 18a + 18b land.
- [x] Examples (`examples/feature-loop/`) — landed in phase 18c with `index.ts` + `README.md`, registered in `examples/orch.config.ts`. Demonstrates loop-with-feedback (brainstorm → plan → work → review → ask) with `as:`-scoped iteration keys, `extraPrompt` retry, and `defaultWhenNoninteractive` for autonomous runs.

## Test plan

**Layer 1 — unit (`tests/unit/core/`):**

- `ask.test.ts` (each test name is a full sentence per CLAUDE.md rule 4 — splits the original draft's compound rejection tests):
  - `ask() returns a frozen Step with kind 'ask'`
  - `ask() prefixes the step name slug with "ask:"`
  - `ask() rejects an empty name`
  - `ask() rejects a whitespace-only name`
  - `ask() rejects a name containing a null byte`
  - `ask() rejects a name containing a newline`
  - `ask() rejects an empty question`
  - `ask() rejects a question containing a null byte`
  - `ask() rejects an empty buttons array`
  - `ask() rejects duplicate button labels`
  - `ask() rejects a field key starting with a digit`
  - `ask() rejects a field key containing a hyphen`
  - `ask() rejects a field key starting with an underscore`
  - `ask() rejects a field key containing a dollar sign`
  - `ask() rejects a field key matching __proto__, constructor, or prototype`
- `ask-types.test-d.ts` (compile-time, kept tight — three load-bearing assertions):
  - The `cancelled: true` and `cancelled: false` branches narrow correctly on the discriminant.
  - `ask({ buttons: ['a', 'b'] })` (no `as const`) narrows `result.button` to `'a' | 'b'`. If this regresses, the const-generic isn't doing what the plan claims.
  - `validate:` is rejected at the type level (the input type omits it).
- `step.test.ts` (extension):
  - `step.define('ask:foo', ...)` throws with a message pointing to the `ask()` factory.
- `errors.test.ts` (extension):
  - `AskParallelError` carries the step name and a hoist-above-or-fan-in remediation.
  - `AskNoDefaultError` synthesizes the suggested `defaultWhenNoninteractive` from the actual config (asserted with a config that has 2 buttons + 1 field; assert the message contains both buttons and the field key).

**Layer 1 — service-port unit (`tests/unit/services/prompt/`):**

- `fake-prompt-service.test.ts`:
  - `.when().respondWith()` scripts a result; `ask()` returns it
  - Unscripted ask throws with a "configure via .when()..." message
  - `.recorded()` returns the calls in order
- `ink-app.test.tsx` (using `ink-testing-library`):
  - Renders question and fields
  - Tab moves focus from field 0 → field 1 → button 0 → button 1
  - Typing into a focused TextInput updates the field value
  - Pressing Enter on a focused button calls `onResolve` with `{ cancelled: false, button, fields }`
  - Pressing Esc calls `onResolve` with `{ cancelled: true, fields: <current> }`
  - Ctrl-C calls `onResolve` with `{ cancelled: true, ... }`
- `readline-prompt-service.test.ts`:
  - Scripts stdin via a PassThrough stream; asserts on stdout output and resolved result.
  - **Out-of-range button choice re-prompts** with an "invalid choice; pick 1-N" line, then accepts the second valid input. NOT silent cancel. (Original draft tested the silent-cancel behavior — review caught the design bug; behavior and test are both flipped.)
  - Out-of-range loop bottoms out at 5 retries → cancel (guards against EOF loops if stdin closes).
  - Empty input on the choice prompt → button[0].

**Layer 2 — integration mocked (`tests/integration/core/`):**

- `ask-mocked.test.ts`:
  - End-to-end workflow with `FakePromptService.when('ask-1').respondWith({ cancelled: false, button: 'continue', fields: { notes: '' } })` resolves the typed value and writes `state.json` with `mode: 'interactive'` and the typed value.
  - Resume after kill mid-workflow replays the cached ask without calling `FakePromptService` (asserts `.recorded()` is empty on resume).
  - **Cancelled ask is cached on resume.** First run cancels via Esc; resume; assert `FakePromptService` is NOT called and the workflow re-receives `{ cancelled: true, ... }`.
  - **Cache-stale by buttons:** persist with `button: 'X'`; modify config to remove `'X'`; resume; assert `FakePromptService` IS called with the new spec AND the persisted entry is replaced. Behavior assertion, NOT a log-string assertion (the log line is a bonus).
  - **Cache-stale by field key:** persist with field `notes`; rename to `comment`; resume; assert re-prompt as above.
  - **Cancelled cache stays valid across button changes:** persist a `cancelled: true`; modify the buttons; resume; assert NO re-prompt (cancel doesn't depend on shape).
  - Noninteractive with default: `interactivity: 'noninteractive'` + `defaultWhenNoninteractive: { button: 'skip' }` → resolves to default, FakePromptService NOT called. Missing field values are zero-filled with `''`.
  - Noninteractive without default → `AskNoDefaultError` at the call site; assert the error message contains the actual button list and field keys (synthesized remediation).
  - **Resume from interactive into `--noninteractive`:** start a run interactively, kill before the ask, resume with `--noninteractive` and no default → `AskNoDefaultError` naming the step. Resume *with* a synthesized default → succeeds.
  - Inside `parallel()` → `AskParallelError` with a hoist-above-or-fan-in message; assert the message does NOT recommend `--noninteractive` as a fix.
  - **Aggregate-timing excludes asks:** run a workflow with one ask that sleeps 200 ms before answering; assert the run summary's "step durations" rollup excludes the ask OR labels it as idle.

**Layer 3 — integration real (`tests/integration/services/prompt/`):**

- `ink-prompt-service-real.test.ts` (auto-skip when `ink` cannot resolve, or env `RUN_INK_REAL=0`):
  - Spawn the Ink runner child as a real subprocess via `Bun.spawn` (in this test only — the test scope owns the spawn since it's testing the spawn boundary).
  - Pipe scripted stdin (`'\t'`, `'\r'`, `''`).
  - Read the result file; assert structure.

**Layer 3 — workflow real (gated):**

- `feature-loop-real.test.ts` (`RUN_REAL_CLAUDE=1` + `tmux -V`):
  - Run `examples/feature-loop` in two-pane mode for 1 iteration; cancel the ask; assert workflow exits cleanly.

## Dependencies & risks

### Dependencies

- **Phase 17 (`createWorktree()` step primitive)** is in flight (`?? src/core/worktree.ts`). The `RESERVED_PREFIXES` list, the `StepConfig` union, and the `runStepOnce` switch evolve in lockstep — this plan assumes Phase 17 lands first and adds `'ask'` as the *third* primitive, not the second. If Phase 17 hasn't landed, the diff format here still applies; just rebase.
- **No dependency on Reframe Phase D** (tmux host port). Two-pane already exists at `src/hosts/two-pane/`; this plan uses today's `host.runInteractive` seam, which Phase D consolidates but doesn't break.

### Risks

1. **Bundling: Ink + react-reconciler footprint is bigger than the brainstorm estimated** (~4-6 MB on disk, vs. the brainstorm's 1.2 MB). Mitigation: confirm with PR reviewer; the trade-off is acceptable for the UX win, but worth flagging. If footprint becomes a real concern, lazy-import Ink at first ask call (R&R: micro-second penalty on first prompt only).
2. **JSX in Bun.** Bun reads `tsconfig.json` and supports `"jsx": "react-jsx"` natively, but introducing JSX into `src/services/prompt/` changes the codebase profile. Biome handles it (Biome ≥ 2.4.10 supports JSX). Risk: if a future contributor turns off JSX in tsconfig, Ink files break. Mitigation: add a comment in `tsconfig.json` near the JSX setting; lint rule to forbid `.tsx` outside `src/services/prompt/`.
3. **Detach/reattach under tmux.** Per Ink research: no SIGCONT handler, but on SIGWINCH (which tmux fires on reattach) Ink re-renders. Risk surface: zero in v1 — pending asks survive any number of detach/reattach cycles per tmux's pane-buffer guarantee. Confirmed via Context7 / Ink readme.
4. **stdout/stderr separation under spawn-Ink-child path (Option A).** The child process owns the pane's PTY exclusively for the duration of the ask. The parent orch process writes nothing to that pane while the child runs. No interleaving risk. Result file (`.orch/state/<runId>/asks/<step>.json`) is the only IPC channel.
5. **React 19 peer dep.** Ink 7 requires `react ≥ 19.2.0`. `ink-text-input` 6.0.0 was published before React 19 and pins `react ≥ 18`; npm/Bun resolve this as one React 19 install with no warning. Verified via npm registry. Risk: if `ink-text-input` releases a v7 with breaking React API usage, we'd pin to v6 explicitly. Already pinned (`^6.0.0`).

## Implementation phases (PR-sized slices)

The original 4-phase slicing was rejected during review: phase 18a-as-written shipped `runStepOnce`'s `case 'ask': throw new Error('not yet wired')` to `main` — a runtime crash for anyone touching the new public API between 18a and 18b. Slicing PRs by *file boundary* produces non-shippable intermediate states. The right slice is by *capability boundary* — every PR leaves `main` with a feature that works end-to-end in at least one mode.

### Phase 18a — Factory + executor + Fake + Readline + CLI flag (one PR)

**Capability:** `ask` works end-to-end in plain mode AND in noninteractive mode. Two-pane gets a "wait for 18b" stub. No Ink, no React, no JSX, no new runtime deps in this PR.

**Scope:**

- `src/core/ask.ts` — factory, types, validation, `FORBIDDEN_FIELD_KEYS` guard.
- `src/core/step.ts` — extend `StepConfig` union, `RESERVED_PREFIXES`, `onCacheHit` (no-op for `'ask'`).
- `src/core/errors.ts` — `AskParallelError`, `AskNoDefaultError`. NOT `AskCancelError` (deleted), NOT `AskCacheStaleError` (replaced by private predicate).
- `src/core/ask-executor.ts` — `runAskStep`, private `isAskCacheValid` predicate.
- `src/core/workflow.ts` — `runStepOnce`'s `case 'ask':` wired to `runAskStep`; cache-validity preflight in the cache-hit branch.
- `src/services/prompt/{prompt-service,fake-prompt-service,readline-prompt-service,index}.ts`.
- `WorkflowDeps.promptService` + `WorkflowDeps.interactivity` (NOT persisted, no schema bump).
- `src/cli/main.ts` — `--interactive` / `--noninteractive` flag; `ORCH_NONINTERACTIVE=1` env var support.
- `src/cli/deps.ts` — wire `ReadlinePromptService` for plain mode; throw `Error('two-pane ask: implemented in phase 18b')` for two-pane.
- `tests/helpers/test-deps.ts` — `defaultTestDeps()` injecting `FakePromptService` + `interactivity: 'interactive'`.

**Tests:**

- `tests/unit/core/ask.test.ts` (every rejection split into its own sentence-named test — see § Test plan).
- `tests/unit/core/ask-types.test-d.ts` (3 type-level assertions, including const-generic-without-`as const`).
- `tests/unit/core/errors.test.ts` (assert `AskNoDefaultError` synthesizes from config).
- `tests/unit/services/prompt/fake-prompt-service.test.ts`.
- `tests/unit/services/prompt/readline-prompt-service.test.ts` (re-prompt-on-out-of-range, NOT silent cancel).
- `tests/integration/core/ask-mocked.test.ts` — full mocked workflow: resume, cache-stale (buttons + field keys), cancelled-cached, cancel-cache-immune-to-shape-changes, noninteractive (with + without default), parallel rejection, resume-into-noninteractive.
- `tests/integration/cli/interactivity-flag.test.ts` — flag parsing, env var fallback, mutex of `--interactive` + `--noninteractive`.

**Definition of done:**
- `bun run check` green.
- `orch run` (default plain or `--mode=plain`) prompts via readline and persists the answer; resume replays without re-prompting (including cancel).
- `orch run --noninteractive` resolves declared defaults or throws `AskNoDefaultError` whose message synthesizes a paste-ready `defaultWhenNoninteractive`.
- Cache-stale (button removed, field renamed) re-prompts; logs the one-liner.
- Ask inside `parallel()` throws `AskParallelError` with a hoist-above-or-fan-in message.

### Phase 18b — `InkPromptService` (two-pane) + Ink runner child ✓

**Capability:** two-pane gets the rich Ink renderer.

**Scope:**

- [x] `package.json` — add `ink`, `ink-text-input`, `react` runtime deps; `@types/react`, `ink-testing-library` dev deps.
- [x] `tsconfig.json` — `"jsx": "react-jsx"`, `"jsxImportSource": "react"`.
- [x] `src/services/prompt/{ink-prompt-service,ink-app,ink-runner}.{ts,tsx}` — Option A (spawn-Ink-child via `host.runInteractive` + temp-file IPC; result lives under `os.tmpdir()/orch-ask-<random>/result.json` rather than `.orch/state/<runId>/asks/<step>.json` — temp-dir keeps the IPC byte cost off the run state directory and avoids needing the runId at the prompt-service seam).
- [x] `src/cli/deps.ts` — replace the 18a stub with the real `InkPromptService` for two-pane; single-pane keeps a deferred stub.
- [x] TODO comment near the `bun run <repo-path>/.../ink-runner.ts` argv construction noting v1 is checkout-only and a `bin` entry is needed before published distribution.

**Tests:**

- [x] `tests/unit/services/prompt/ink-app.test.tsx` (using `ink-testing-library`): renders question + fields + buttons, Tab cycles focus across fields and buttons in order, Shift-Tab cycles backward, Enter on a focused button resolves with `cancelled: false`, Esc resolves with `cancelled: true`, Ctrl-C resolves with `cancelled: true`, double-Enter still resolves only once.
  - **Gotcha discovered during 18b**: Ink's `<App>` already auto-handles Tab / Shift-Tab via its own `useFocusManager` listener (see `node_modules/ink/build/components/App.js`); a manual handler in `AskApp` causes a double-advance. Plan's draft included one — removed.
  - **Test cadence**: focus state propagates through React's reconciler + `useEffect` re-subscription; 5 ms inter-keystroke ticks race the focus update. 30 ms is the empirical floor — pinned in the test helper with the rationale.
- [x] `tests/integration/services/prompt/ink-prompt-service.test.ts` (Layer 2, always-on): exercises the IPC contract end-to-end against a fake Host whose `runInteractive` writes the result file synthetically. Covers spec encoding, cleanup on success + error, plain-mode misroute, cancelled-result passthrough.
- [x] `tests/integration/services/prompt/ink-prompt-service-real.test.ts` (Layer 3, gated on `RUN_INK_REAL=1`): spawns the runner child via `Bun.spawn` to verify the arg-parse boundary (no `--spec` exits non-zero, no args exits non-zero). The full Ink-render smoke (`renders, accepts Enter, writes result`) is further gated on `RUN_INK_TTY=1` because piped stdio disables raw mode and Ink never accepts a keystroke without a PTY harness; manual verification command is documented inline.

**Definition of done:**
- [x] `orch run --mode=two-pane` prompts via the Ink renderer in the right pane (verified by mocked-host integration test + ink-app input handling tests; manual two-pane TTY verification deferred to first real use).
- [x] `bun run check` green with the new deps installed.
- [x] TODO comment for the `bin` entry is in `ink-prompt-service.ts`.

### Phase 18c — `examples/feature-loop/` ✓

**Capability:** the loop-with-feedback pattern is shipped as a runnable example, demonstrating `ask()` end-to-end against the v1 public API plus the real Ink renderer.

**Scope:**

- [x] `examples/feature-loop/index.ts` — `default workflow('feature-loop', ...)` with the 5-iteration loop body. Four autonomous Claude steps (`BRAINSTORM`, `PLAN`, `WORK`, `REVIEW`) plus `ASK_CONTINUE` declared with `defaultWhenNoninteractive: { button: 'continue' }`. Iteration keys via `as: \`<step>-${i}\`` so each loop turn gets its own cache slot. `retry` re-runs `WORK` with `answer.notes` threaded through `extraPrompt`.
- [x] `examples/feature-loop/README.md` — usage doc for plain mode (`bunx orch run feature-loop "..."`), two-pane Ink mode (`--mode=two-pane`), autonomous mode (`--noninteractive`), resume semantics, and where the feature spec files land.
- [x] `examples/orch.config.ts` — `'feature-loop': 'feature-loop/index.ts'` added to the workflows map.

**Definition of done:**
- [x] `bun run check` green (lint + typecheck + 1102 unit/integration tests pass).
- [x] Example uses the shipped public surface (`ask`, `step.define`, `workflow`, `claude` runner, `RunOverrides.{as, extraPrompt}`) — no test-only or internal imports.

## References & research

### Internal references

- Brainstorm: [`docs/brainstorms/2026-04-30-tui-ask-step-brainstorm.md`](../brainstorms/2026-04-30-tui-ask-step-brainstorm.md)
- Closest precedent — `commit()` factory: `src/core/commit.ts:38-65`
- Closest precedent — `createWorktree()` factory: `src/core/worktree.ts:85-122`
- Discriminated union & RESERVED_PREFIXES: `src/core/step.ts:103-110`
- Reserved-prefix factory routing: `src/core/step.ts:144-150`
- `validate:` forbidden on interactive: `src/core/step.ts:152-157`
- `runStepOnce` dispatch: `src/core/workflow.ts:944-1006`
- `runInteractiveStep` (the closest behavioural cousin): `src/core/workflow.ts:313-455`
- `InteractiveParallelError`: `src/core/errors.ts:32-40`
- Host port: `src/hosts/host.ts:62-107`
- RunMode: `src/core/run-mode.ts:19-20`
- StateStore schema (current v5): `src/state/state-store.ts:7-57`
- Service adapter pattern (process): `src/services/process/fake-process-service.ts`
- `WorkflowDeps`: `src/core/workflow.ts:130-165`
- CLI argv parsing: `src/cli/main.ts:108-174`
- Public barrel: `src/core/index.ts`

### External references (versioned 2026-04-30)

- Ink v7 (`/vadimdemedes/ink`, v7.0.1, 2026-04-17 release): `render(options)` API, `useApp()`, `useInput`, `useFocus`, `useFocusManager`, raw mode lifecycle. Source: Context7 232 snippets.
- `ink-testing-library` v4.0.0: `render()` returns `{ stdin, stdout, frames, lastFrame }`; special keys encoded as raw byte strings (`'\r'` Enter, `''` Esc, `''` Ctrl-C, `''` Backspace, `'[A/B/C/D'` arrows). Source: ink-testing-library source.
- `ink-text-input` v6.0.0: controlled `value`/`onChange`/`onSubmit`, `placeholder`, `focus` prop. Peer `react ≥ 18`, works with React 19. Source: npm registry.
- React 19 peer dep — bun + ESM resolution verified via `npm view`. No Bun-specific gotchas in v7; `react-reconciler` works on Bun.
- Bun JSX support: `"jsx": "react-jsx"`, `"jsxImportSource": "react"` in tsconfig. Bun handles the JSX transform internally.
- `Promise.withResolvers` (TC39 Stage 4, MDN, supported in Bun ≥ 1.2): canonical pattern for the imperative-prompt bridge.

### Related work

- Implementation phases roadmap: [`docs/plans/implementation-phases.md`](implementation-phases.md) — Phase 17 (`createWorktree()` step primitive) is the immediate predecessor; this plan files as Phase 18.
- Reframe plan: [`docs/plans/2026-04-18-feat-orch-reframe-step-views-run-modes-plan.md`](2026-04-18-feat-orch-reframe-step-views-run-modes-plan.md) — Phase D (tmux host port) does not block this work.
- Two-pane auto-attach plan: [`docs/plans/2026-04-23-feat-two-pane-auto-attach-plan.md`](2026-04-23-feat-two-pane-auto-attach-plan.md) — tmux host shape is stable.

## Open questions resolved (vs. brainstorm § Open Questions + post-review additions)

1. **Where does `ask()` live?** → `src/core/ask.ts` (factory + types + validation); `src/core/ask-executor.ts` (runtime). Two files keeps both under the 300-line budget. A subfolder `src/core/prompts/` is YAGNI today; revisit if/when a second prompt primitive (`select()`) lands. v1 has NO `text()` constructor and NO `FieldKind` discriminator — fields are `Record<string, { placeholder?: string }>` directly. The `kind` discriminator + per-kind constructor land when there's a second kind.
2. **Ink dependency footprint.** → Confirmed: ~4-6 MB on disk (the brainstorm's 1.2 MB undershoots). Acceptable given the UX value. Bun cold-start (~30-80 ms per ask child spawn) is ≤30 % of one human keystroke — invisible. Accepted as **runtime** deps; ships in phase 18b only.
3. **Right-pane takeover hook.** → Reuse the existing `host.runInteractive(...)` seam via the spawn-Ink-child pattern (Option A). No shared abstraction needed; host port stays the same. v1 ships as checkout-only; the `bin` entry for the Ink runner child gets added before any published distribution (TODO comment in `ink-prompt-service.ts`, tracked in phase 18b's DoD).
4. **`forceReask: true`.** → Deferred per brainstorm. Easy to add later: extra `AskInput` field threaded into `AskStepConfig` and checked in `runStepOnce`'s cache branch before `onCacheHit`.
5. **Built-in idle timeout.** → Deferred per brainstorm. Workflow authors use `Promise.race`. A future `--max-idle` run-level guardrail (not ask-specific) subsumes this.

### Resolved during plan review (2026-05-01)

6. **Persist `interactivity` across resumes?** → No. One-bit per-invocation knob doesn't merit a schema commitment. Sourced from CLI flag or `ORCH_NONINTERACTIVE=1` env var per invocation. State schema stays at v5. (Renamed from the original draft's `runtimeMode`, which collided with the existing `RunMode` type.)
7. **Cancelled ask cached on resume?** → Yes — replay-deterministic, matches every other step kind. Workflow authors who want abort-as-data should encode it as a labeled button (`buttons: ['continue', 'abort']`); `Esc` / `Ctrl-C` remains the orthogonal control-flow escape hatch. (See § Cancel semantics on resume.) Pinned in tests and JSDoc on `AskResult`.
8. **Cache-stale signal: thrown sentinel or boolean?** → Boolean predicate (`isAskCacheValid`), private to `ask-executor.ts`. The original draft's "throw `AskCacheStaleError` then catch it two lines later in `runStepOnce`" was rejected — control-flow-via-exception inside the same call stack is cleverness this codebase doesn't need.
9. **`AskCancelError` reserved-but-empty class?** → Deleted. YAGNI — re-add when there's a use case.
10. **Out-of-range button choice in plain mode?** → Re-prompt up to 5 times with "invalid choice; pick 1-N", then cancel (EOF-loop guard). The original draft's silent-cancel-on-typo was rejected as user-hostile; the test that encoded it is flipped.
11. **`mode: 'ask'` vs `kind: 'ask'`?** → `kind: 'ask'` aligned with `StepConfig.kind`. `StepEntry.mode` stays `'interactive' | 'autonomous'`. The original draft introduced `mode: 'ask'` on the per-step session log alongside `mode: 'interactive' | 'autonomous'` elsewhere — review caught the cross-file discriminant inconsistency.
12. **`AskNoDefaultError` message: generic template or synthesized?** → Synthesized from the actual config (button list + field keys). The error has the config in scope; use it. Difference between actionable and "go read the docs."
13. **Aggregate run timing pollution by ask idle time?** → Aggregate panels MUST exclude `kind: 'ask'` or label idle time. A 6-hour walk-away would otherwise corrupt capacity-planning math. Acceptance criterion + test.

## Backwards compatibility

- **No state schema bump.** `RunState` stays at `schemaVersion: 5`. `interactivity` is sourced per-invocation from CLI flag / env var; not persisted. Existing v5 runs resume without migration. (The original draft proposed v5 → v6 with persisted `runtimeMode`; review rejected it.)
- **No public API breakage.** `step.define`, `commit`, `createWorktree`, `parallel`, `workflow` all unchanged. The new `ask` export is additive. (No `text` export in v1 — see § Open Questions Resolved item 1.)
- **`WorkflowDeps.promptService` and `WorkflowDeps.interactivity` are required.** Tests that construct `WorkflowDeps` manually (e.g., `tests/integration/core/`) need to pass a `PromptService` instance and an interactivity value. Phase 18a adds `tests/helpers/test-deps.ts` with `defaultTestDeps()` injecting `FakePromptService` + `interactivity: 'interactive'` so individual test files don't need to know about either.

## Documentation plan

- `docs/getting-started.md` — add a new "Asking the human" section with the `ASK_CONTINUE` example. Includes a "Recovering from an accidental cancel" subsection: how to remove the offending step entry from `.orch/state/<runId>/state.json` and resume to re-prompt (since cancel is cached by default).
- `docs/getting-started.md` — also add a "Running noninteractively" subsection covering `--noninteractive` + `defaultWhenNoninteractive`, including the resume-from-interactive-into-noninteractive crash-and-paste-the-synthesized-default workflow.
- `docs/plans/implementation-phases.md` — append "Phase 18 — TUI ask step" with status `◐ in progress` until phases 18a + 18b land.
- `docs/solutions/` — after landing, write `docs/solutions/ask-step-implementation.md` with the spawn-Ink-child decision rationale (so the next person who wonders "why not embed Ink directly?" has the answer) AND the cache-validity-as-predicate rationale (why `isAskCacheValid` is not `AskCacheStaleError`).
