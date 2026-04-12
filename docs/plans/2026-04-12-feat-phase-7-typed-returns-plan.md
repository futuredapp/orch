---
title: Phase 7 — Typed returns (schema) via Claude --json-schema
type: feat
status: completed
date: 2026-04-12
deepened: 2026-04-12
---

# Phase 7 — Typed Returns

## Enhancement Summary

**Deepened on:** 2026-04-12
**Research agents used:** zod-to-json-schema docs, Claude CLI structured output, TypeScript generics best practices, repo pattern analysis, TypeScript reviewer, architecture strategist, performance oracle, code simplicity reviewer, pattern recognition specialist, security sentinel, spec-flow analyzer

### Key Improvements Discovered

1. **Remove `_tag` brand + `isSchemaWrapper()`** — never used in production code; check `returns !== undefined` instead (saves ~25 LOC)
2. **Handle `undefined` structured_output explicitly** — when CLI succeeds but returns no `structured_output`, throw a distinct actionable error before Zod parse
3. **Use `$refStrategy: "none"` in zodToJsonSchema config** — CLI needs flat inline JSON, not `$ref` pointers; also strip `$schema` key
4. **Verify `--bare` + `--json-schema` interaction** — add explicit test confirming both flags coexist without `structured_output` being suppressed
5. **Wire or remove `RunnerResult.structuredOutput` dead field** — currently hardcoded `undefined` in `execute.ts:65`, confuses where structured output lives
6. **Handle `error_max_structured_output_retries` subtype** — confirm parse path catches it and produces a clear user-facing error
7. **Use `Expect<Equal<>>` type-level assertions in tests** — same pattern as TypeScript compiler's test suite, zero runtime cost
8. **Document post-transform value in `ValidatorCtx.value`** — validators receive Zod-parsed (possibly transformed) data, not raw CLI output

### New Considerations Discovered

- Cache-hit re-validation: 4/10 agents independently flagged the schema-change-without-step-rename hole as worth closing (negligible cost)
- `z.describe()` annotations inflate JSON Schema size and can unexpectedly push toward argv limits
- Non-serializable `z.transform()` outputs (Date, Map, Set) break `JSON.stringify` in state persistence
- `workflow.ts` is at 281 lines; Phase 7 adds ~15 more — watch for Phase 8 headroom

## Overview

Typed handoffs between steps — the killer feature from the original brainstorm. Steps declare `returns: schema(zodSchema)` and `await run(STEP)` returns `z.infer<typeof schema>` with zero caller-side annotations. The TS plumbing is a one-time cost in the core; every subsequent phase benefits from type-safe inter-step data flow.

Source brainstorm: [`docs/brainstorms/2026-04-11-phase-7-typed-returns-brainstorm.md`](../brainstorms/2026-04-11-phase-7-typed-returns-brainstorm.md) — all key decisions resolved.

## Problem Statement / Motivation

Phases 1–6 built a complete workflow pipeline with real CLI execution, memoization, validators, and resume — but every `run()` call returns `unknown`. Users must `as`-cast or Zod-parse at every step boundary. This defeats the whole point of a typed orchestrator. Phase 7 closes the gap: declare a Zod schema once on the step definition, and the type flows end-to-end through the workflow function with zero ceremony.

## Proposed Solution

### DX target (confirmed from brainstorm)

```ts
const RESEARCH = step.define('research', {
  agent: claude(),
  returns: schema(z.object({
    summary: z.string(),
    risks: z.array(z.string()),
  })),
})

// autocomplete works, no annotation needed
const { summary, risks } = await run(RESEARCH)
```

### Architecture (what changes)

1. **New `src/core/schema.ts`** — `schema(zodSchema)` wraps a Zod schema into a `SchemaWrapper<T>` that carries the Zod schema (for validation) and a memoized JSON Schema string (for CLI flags). Uses `zod-to-json-schema` for conversion.
2. **Generics on `Step<T>` + `StepConfig<T>`** — `step.define` infers `T` from the `SchemaWrapper<T>` in `returns:`. When absent, `T` defaults to `unknown` (fully backward-compatible).
3. **Generic `RunFn`** — `<T>(step: Step<T>, overrides?) => Promise<T>` so the return type flows through the workflow closure.
4. **`RunnerContext.schema`** — new optional field carrying the JSON Schema string. Threaded into `buildCommand` for the CLI flag.
5. **`ClaudeRunner` structured output** — `buildCommand` appends `--json-schema '<inline>'` when `ctx.schema` present; `extractStructuredOutput` prefers `structured_output` over `result` when present. `supports.structuredOutput` flips to `true`.
6. **Executor wiring** — capability check at step start → schema threading into `RunnerContext` → raw value extraction → Zod validation → `SchemaValidationError` on mismatch.
7. **No schema version bump** — `StepEntry.value` stays `unknown`. No migration.

### Deviation from brainstorm

The brainstorm says `extractStructuredOutput` gains a second `ctx` arg for schema-aware extraction. **This plan deviates:** the runner checks envelope contents directly (`structured_output` present → return it, otherwise → return `result`). This avoids a `Runner` interface signature change, keeps runners decoupled from Zod, and centralizes validation in the executor.

## Technical Approach

### Data flow

```
step.define('x', { agent: claude(), returns: schema(zod) })
    │
    ▼  schema(zod) → SchemaWrapper<T>
       ├── .zodSchema: ZodType<T>     (for executor Zod-parse)
       └── .jsonSchema: string        (memoized JSON Schema for CLI)
    │
    ▼  Step<T> carries StepConfig<T> with returns: SchemaWrapper<T>
    │
    ▼  run<T>(step: Step<T>): Promise<T>
    │
executor (workflow.ts):
    │
    ├── capability check: step has returns? → runner.supports.structuredOutput?
    │     └── false → throw Error("Runner 'x' does not support structured output")
    │
    ├── build RunnerContext:
    │     ctx.schema = { jsonSchema: step.config.returns.jsonSchema }
    │
    ├── runRunner(runner, ctx, deps)
    │     └── runner.buildCommand(ctx):
    │           └── claude: appends --json-schema '<ctx.schema.jsonSchema>'
    │
    ├── runner.extractStructuredOutput(finalEvent):
    │     └── claude: structured_output present? → return it : return result
    │
    ├── Zod-parse raw value against step.config.returns.zodSchema:
    │     └── failure → throw SchemaValidationError(stepName, zodError)
    │
    └── return typed value (persisted as unknown in StepEntry.value)
```

### SchemaWrapper<T>

```ts
// src/core/schema.ts
import type { ZodType } from 'zod'
import zodToJsonSchema from 'zod-to-json-schema'

export interface SchemaWrapper<T = unknown> {
  readonly zodSchema: ZodType<T>
  readonly jsonSchema: string
}

export function schema<T>(zodSchema: ZodType<T>): SchemaWrapper<T> {
  const jsonSchemaObj = zodToJsonSchema(zodSchema, { $refStrategy: 'none' })
  const { $schema: _, ...rest } = jsonSchemaObj as Record<string, unknown>
  const jsonSchema = JSON.stringify(rest)
  return Object.freeze({ zodSchema, jsonSchema })
}
```

> **Simplification (from review):** The original plan included a `_tag: 'SchemaWrapper'` brand field and an `isSchemaWrapper()` type guard. Multiple review agents confirmed these are never used in production code — every usage site checks `s.config.returns !== undefined` instead, which is type-safe because `returns` is `SchemaWrapper<T> | undefined` on `StepConfig`. Removed to save ~25 LOC of code and tests.

JSON Schema conversion happens once at wrap time (frozen object, stable reference). No per-invocation cost.

### Research Insights — `zod-to-json-schema`

**Configuration:** Use `$refStrategy: "none"` and strip `$schema` key for CLI consumption:

```ts
export function schema<T>(zodSchema: ZodType<T>): SchemaWrapper<T> {
  const jsonSchemaObj = zodToJsonSchema(zodSchema, { $refStrategy: 'none' })
  // Strip $schema — CLI tools don't need the meta-schema URI
  const { $schema: _, ...rest } = jsonSchemaObj as Record<string, unknown>
  const jsonSchema = JSON.stringify(rest)
  return Object.freeze({ zodSchema, jsonSchema })
}
```

**Key behaviors to document:**
- `z.transform()` — input schema used, transform function stripped. CLI sees input shape, Zod parse applies transform post-facto. **Works correctly.**
- `z.refine()` / `z.superRefine()` — refinement stripped entirely. CLI may return invalid data; Zod catches it. **Acceptable.**
- `z.preprocess()` — inner schema (after preprocessing) used. Preprocess function discarded.
- `z.pipe()` — input (left) side used by default. Output side ignored.
- `z.describe('...')` — maps to `"description"` in JSON Schema. **Caution:** large descriptions inflate argv size.
- `z.default()` — emits `"default"` key correctly.
- `z.lazy()` — requires the `name` option to avoid infinite recursion (not relevant for typical step schemas).
- `z.discriminatedUnion()` / `z.union()` — both emit `{ anyOf: [...] }`.
- `z.intersection()` — emits `{ allOf: [...] }`.

**Memoization:** The plan's `Object.freeze` prevents mutation but does not memoize. If the same Zod schema is wrapped multiple times (unlikely but possible), consider a `WeakMap<ZodTypeAny, string>` cache. For Phase 7, single-call-per-schema is sufficient.

### SchemaValidationError

```ts
// src/core/schema.ts (continued)
import type { ZodError } from 'zod'

export class SchemaValidationError extends Error {
  constructor(
    readonly stepName: StepName,
    readonly zodError: ZodError,
  ) {
    super(
      `Step "${stepName}" returned invalid structured output:\n` +
        zodError.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`).join('\n'),
    )
    this.name = 'SchemaValidationError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}
```

Same pattern as `ValidationError` (Phase 6). Sets step status to `crashed`; resume re-runs the step from scratch.

> **Note:** `StepError` does NOT use `Object.setPrototypeOf`, but `ValidationError` does. Follow the newer Phase 6 convention — include it. This ensures `instanceof` works reliably across transpilation targets.

### Generic Step<T> plumbing

```ts
// src/core/step.ts
export interface StepConfig<T = unknown> {
  readonly agent: Runner
  readonly prompt?: string
  readonly validate?: Validator | ReadonlyArray<Validator>
  readonly returns?: SchemaWrapper<T>
}

export interface Step<T = unknown> {
  readonly name: StepName
  readonly config: StepConfig<T>
}

export const step = {
  define<T = unknown>(name: string, config: StepConfig<T>): Step<T> {
    return Object.freeze({ name: stepName(name), config })
  },
} as const
```

TypeScript infers `T` from `SchemaWrapper<T>` when `returns:` is present. When absent, `T` defaults to `unknown`. No overloads needed.

> **Validators stay `Validator<unknown>`** on `StepConfig<T>` — not `Validator<T>`. Phase 7 scopes typed returns to the `run()` call site. Typing validators would require users to annotate `check<T>(...)` explicitly; YAGNI until demand arises. `ValidatorCtx<V>` generic from Phase 6 keeps the door open.

### Research Insights — TypeScript Generics

**Compile-time assertion utilities** (use in test files, zero runtime cost):

```ts
// tests/helpers/type-assertions.ts
export type Expect<T extends true> = T
export type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends
  (<T>() => T extends Y ? 1 : 2) ? true : false
```

Usage in tests (same pattern as TypeScript compiler's own test suite and type-fest):

```ts
const TYPED = step.define('typed', {
  agent: fakeRunner,
  returns: schema(z.object({ a: z.string() })),
})
type _1 = Expect<Equal<typeof TYPED, Step<{ a: string }>>>

const PLAIN = step.define('plain', { agent: fakeRunner })
type _2 = Expect<Equal<typeof PLAIN, Step<unknown>>>
```

This is superior to the `satisfies`-based approach in the original plan — it fails at compile time with a clear error if types diverge, no `@ts-expect-error` needed.

**Object.freeze pitfall:** `Object.freeze` returns `Readonly<T>`, which can interfere with generic inference if downstream code expects mutable signatures. The plan freezes the Step returned by `step.define`, and `StepConfig<T>` already uses `readonly` on all fields. Ensure `RunFn` and `runStepOnce` accept `Readonly<Step<T>>` or equivalently `Step<T>` (which is already all-`readonly`). No issue expected given current interfaces.

**Safe cast pattern:** When schema is present, Zod `safeParse` returns the correctly typed value — no cast needed for that path. The `as Promise<T>` cast in `RunFn` only applies when `T = unknown` (no schema), where `unknown as unknown` is a no-op. This is the standard pattern used in tRPC and similar libraries.

### RunnerContext schema field

```ts
// src/runners/types.ts (addition)
export interface RunnerContext {
  readonly cwd: Path
  readonly env: Readonly<Record<string, string>>
  readonly prompt: string
  readonly extraArgs: readonly string[]
  readonly schema?: { readonly jsonSchema: string }  // NEW — Phase 7
}
```

Runners that support structured output read `ctx.schema.jsonSchema` in `buildCommand`. Runners that don't can ignore it (the executor capability-checks before spawn).

### ClaudeRunner changes

**`buildCommand`** — appends `--json-schema` when schema present:

```ts
buildCommand(ctx: RunnerContext): RunnerCommand {
  // ... existing flag construction ...
  const argv = [
    'claude',
    ...(bare ? ['--bare'] : []),
    '-p', ctx.prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
    ...(model ? ['--model', model] : []),
    ...(maxTurns !== undefined ? ['--max-turns', String(maxTurns)] : []),
    ...(ctx.schema ? ['--json-schema', ctx.schema.jsonSchema] : []),  // NEW
    ...(flags ?? []),
    ...ctx.extraArgs,
  ]
  return { argv, env: buildClaudeEnv(ctx.env, process.env) }
}
```

**`extractStructuredOutput`** — prefers `structured_output` when present:

```ts
extractStructuredOutput(finalEvent: TerminalEvent): unknown {
  if (finalEvent.type === 'error') return undefined
  const parsed = ClaudeResultSuccess.safeParse(finalEvent.data)
  if (!parsed.success) return undefined
  if (parsed.data.structured_output !== undefined) return parsed.data.structured_output
  return parsed.data.result
}
```

No `Runner` interface signature change. The `structured_output` field already exists in `ClaudeResultSuccess` (`z.unknown().optional()`). When `--json-schema` is used, Claude CLI populates it with parsed JSON. When not used, it's `undefined`.

**`supports.structuredOutput`** — flips from `false` to `true`.

### Research Insights — Claude CLI Structured Output

**`error_max_structured_output_retries` handling:** When Claude exhausts retries producing valid JSON, the final envelope has `subtype: 'error_max_structured_output_retries'` and `is_error: true`. The existing `ClaudeResultError` Zod schema catches this via `subtype: z.string()`. This routes through the `result.finalEvent.type === 'error'` check in the executor, throwing a `StepError` before reaching Zod validation. **No additional handling needed** — but add a test fixture (`structured-output-retries-exhausted.jsonl`) and a test confirming the error path.

**`--bare` + `--json-schema` interaction:** The existing `ClaudeRunner` defaults `bare: true`. The plan shows both flags coexisting in argv. **Add an explicit integration test** confirming `structured_output` appears in the result envelope when both `--bare` and `--json-schema` are set. If `--bare` suppresses `structured_output`, the runner must auto-disable `--bare` when `ctx.schema` is present.

**`null` vs `undefined` structured_output:** If Claude returns `structured_output: null` (a valid JSON value, `!== undefined`), the guard passes it to Zod parse. For a `z.object(...)` schema, Zod produces a clear error: "Expected object, received null". The test "returns null structured_output as-is" should confirm this behavior and verify the error message is actionable.

### Executor wiring (workflow.ts)

Key changes in `runStepOnce`:

```ts
async function runStepOnce(
  deps: WorkflowDeps,
  s: Step,
  overrides: RunOverrides | undefined,
): Promise<unknown> {
  // ... cache-hit early return (unchanged) ...

  // Capability check (NEW)
  if (s.config.returns !== undefined && !s.config.agent.supports.structuredOutput) {
    throw new Error(
      `Runner "${s.config.agent.name}" does not support structured output; ` +
        `remove "returns:" from step "${key}" or use a runner that supports it`,
    )
  }

  // ... validator normalization + headSha capture (unchanged) ...

  const result = await runRunner(
    s.config.agent,
    {
      cwd: deps.cwd,
      env: {},
      prompt: assemblePrompt(s.config.prompt, overrides),
      extraArgs: [],
      // Thread schema into RunnerContext (NEW)
      ...(s.config.returns !== undefined
        ? { schema: { jsonSchema: s.config.returns.jsonSchema } }
        : {}),
    },
    { processService: deps.processService, clock: deps.clock },
  )

  // ... error check (unchanged) ...

  let value = s.config.agent.extractStructuredOutput(result.finalEvent)

  // Structured output validation (NEW — Phase 7)
  if (s.config.returns !== undefined) {
    // Guard: runner returned no structured_output despite --json-schema being set.
    // This catches CLI version mismatches, --bare suppression, or envelope anomalies
    // with a clear error rather than a cryptic "Expected object, received undefined".
    if (value === undefined) {
      throw new Error(
        `Step "${key}": runner "${s.config.agent.name}" returned no structured_output ` +
          'despite --json-schema being set. Check CLI version and flag compatibility.',
      )
    }

    const parseResult = s.config.returns.zodSchema.safeParse(value)
    if (!parseResult.success) {
      throw new SchemaValidationError(key, parseResult.error)
    }
    value = parseResult.data
  }

  // ... validators, persist, return (unchanged) ...
  // NOTE: ctx.value in ValidatorCtx receives the Zod-parsed (possibly transformed)
  // value, not the raw CLI output. Document this for validator authors.
}
```

### Generic RunFn

```ts
// src/core/workflow.ts
export type RunFn = <T>(step: Step<T>, overrides?: RunOverrides) => Promise<T>
```

The closure in `workflow()` casts the internal `runStepOnce` (which returns `Promise<unknown>`) to the generic signature. This is safe because:
- When `T` is `unknown` (no schema): `unknown` is already correct
- When `T` is specific (schema present): the executor Zod-parsed the value before returning

```ts
const run: RunFn = <T>(s: Step<T>, overrides?: RunOverrides): Promise<T> =>
  runStepOnce(deps, s, overrides) as Promise<T>
```

This is the ONE `as` cast in the entire feature. It's safe because `runStepOnce` guarantees the Zod parse succeeded before returning.

### FakeRunner — fixture loading

FakeRunner needs minimal changes:
- Its `extractStructuredOutput` already returns `(finalEvent as { data?: unknown }).data`, which is whatever was scripted — no change needed
- File-based fixture loading is a test-level concern, not a FakeRunner responsibility

**Test helper** (`tests/helpers/load-fixture.ts`):

```ts
import type { Path } from '../../src/services/types.ts'

export async function loadJsonFixture(filePath: Path): Promise<unknown> {
  const file = Bun.file(filePath)
  const text = await file.text()
  return JSON.parse(text) as unknown
}
```

Test code uses:
```ts
const fixture = await loadJsonFixture(path('tests/fixtures/schemas/research.json'))
fake.script({ structuredOutput: fixture })
```

> **Brainstorm deviation:** The brainstorm says FakeRunner gains `returns: 'fixture.json'` support with FsService injection. This plan uses a test helper instead — zero churn on FakeRunner, zero new constructor dependencies, same end result. FakeRunner's `script()` stays sync. If the helper proves insufficient, FakeRunner can gain `async scriptFromFile()` in a later phase.

## SpecFlow-surfaced edge cases and resolutions

### 1. Schema validation failure error class

**Resolved:** New `SchemaValidationError` (not `StepError`). No exit code — it's a data-shape mismatch, not a process failure. Step status → `crashed` via the existing catch block in `workflow()`. Resume re-runs the step.

### 2. Memoization key vs. schema change

**Acknowledged gap — intentional.** Step name is the sole memoization key. Changing the Zod schema without changing the step name returns the old cached value. TypeScript says `T` but runtime may diverge. Resolution: user changes step name or clears state. **No runtime guard in Phase 7** — the risk is pre-production, developer-only, and the fix is trivial.

### 3. Cache-hit bypass of Zod validation

On cache hit, `runStepOnce` returns `cached.value` (typed as `unknown`) without re-validating against the schema. This is correct: the value was validated when originally persisted, and re-validating on every resume would be wasteful. The type cast in `RunFn` applies at compile time only.

### 4. `z.transform()` and `z.refine()` behavior

`zod-to-json-schema` strips transforms and refinements (they have no JSON Schema equivalent). This means:
- `z.string().transform(Number)` → Claude sees `{"type":"string"}`, returns a string, Zod parse transforms it to number. **Works correctly.**
- `z.string().refine(s => s.length > 5)` → Claude doesn't see the refinement, may return a short string, Zod parse catches it → `SchemaValidationError`. **Acceptable behavior** — user gets a clear Zod-path error.

> **Tip (from research):** Prefer Zod's built-in validators (`.min()`, `.max()`, `.regex()`) over `.refine()` when possible — `zod-to-json-schema` maps these to JSON Schema constraints (`minLength`, `pattern`), making them visible to Claude.

### 5. FakeRunner file path disambiguation

**Resolved by separate field:** `structuredOutputPath?: Path` on `FakeScript` if we ever add it. For Phase 7, the test helper approach avoids the ambiguity entirely.

### 6. Non-serializable `z.transform()` outputs

If `z.transform()` produces a non-JSON-serializable value (e.g., `Date`, `Map`, `Set`, `BigInt`), `JSON.stringify` in `stateStore.saveStep` will silently drop or mangle it. **Constraint for Phase 7:** document that `returns:` schemas must produce JSON-serializable values. This is inherent to the persistence design (`StepEntry.value` is serialized to `state.json`).

### 7. `ValidatorCtx.value` receives post-transform data

After Zod parse, `value = parseResult.data` — which may be transformed. Validators in the `check()` callback receive this transformed value, not the raw CLI output. A validator written to expect a raw string will break if the schema transforms it to a number. **Document this** in the `check()` API docs and add a test confirming the behavior.

### 8. `RunnerResult.structuredOutput` dead field

`execute.ts:65` hardcodes `structuredOutput: undefined` on every `RunnerResult`. The executor in `workflow.ts` bypasses this field entirely, calling `extractStructuredOutput(result.finalEvent)` directly. **Resolution for Phase 7:** remove the dead `structuredOutput` field from `RunnerResult` to eliminate confusion about where structured output lives. The executor owns extraction and validation.

## Implementation Steps

### Step 1: Add `zod-to-json-schema` dependency + `src/core/schema.ts`

**Deliverables:**
- `bun add zod-to-json-schema`
- `src/core/schema.ts` — `SchemaWrapper<T>`, `schema()`, `SchemaValidationError`
- `tests/unit/core/schema.test.ts`
- `tests/helpers/type-assertions.ts` — `Expect<T>`, `Equal<X, Y>` compile-time utilities

**Tests (write first):**
- `schema(z.object({ a: z.string() }))` produces a `SchemaWrapper` with valid JSON Schema string
- `schema() returns a frozen wrapper with stable jsonSchema string` (not "memoizes" — freeze prevents mutation, it does not memoize)
- `SchemaWrapper` is frozen (Object.isFrozen)
- `SchemaValidationError` message includes step name and Zod path details
- `SchemaValidationError` instanceof works (cross-transpile safety via Object.setPrototypeOf)
- JSON Schema output matches expected shape for: `z.object`, `z.array`, `z.string`, `z.number`, `z.boolean`, `z.enum`, `z.optional`, `z.nullable`
- JSON Schema does not include `$schema` key (stripped for CLI consumption)
- JSON Schema uses inline definitions (no `$ref` pointers — `$refStrategy: 'none'`)

**Barrel update:** `src/core/index.ts` exports `schema`, `SchemaWrapper`, `SchemaValidationError`.

> **Simplification:** `isSchemaWrapper()` and `_tag` brand removed from original plan. The executor checks `s.config.returns !== undefined` directly — type-safe because `returns` is `SchemaWrapper<T> | undefined` on `StepConfig`.

### Step 2: Generic `Step<T>` + `StepConfig<T>` plumbing

**Deliverables:**
- `src/core/step.ts` — `StepConfig<T = unknown>`, `Step<T = unknown>`, `step.define<T>`
- `src/core/index.ts` — update type exports

**Tests (compile-time assertions in `tests/unit/core/schema.test.ts`):**
- `step.define('x', { agent, returns: schema(z.object({ a: z.string() })) })` infers `Step<{ a: string }>`
- `step.define('x', { agent })` infers `Step<unknown>`
- `step.define('x', { agent, returns: schema(z.string()) })` infers `Step<string>` (non-object)

**Verification approach:** Use `Expect<Equal<>>` type-level assertions (from `tests/helpers/type-assertions.ts`):

```ts
import type { Expect, Equal } from '../../helpers/type-assertions.ts'

const TYPED = step.define('typed', {
  agent: fakeRunner,
  returns: schema(z.object({ a: z.string() })),
})
type _1 = Expect<Equal<typeof TYPED, Step<{ a: string }>>>

const PLAIN = step.define('plain', { agent: fakeRunner })
type _2 = Expect<Equal<typeof PLAIN, Step<unknown>>>

const SCALAR = step.define('scalar', {
  agent: fakeRunner,
  returns: schema(z.string()),
})
type _3 = Expect<Equal<typeof SCALAR, Step<string>>>
```

> This pattern (from the TypeScript compiler's own test suite) is superior to `satisfies` — it fails at compile time with a clear error if types diverge, covers exact equality not just assignability.

### Step 3: `RunnerContext.schema` + ClaudeRunner structured output

**Deliverables:**
- `src/runners/types.ts` — `RunnerContext.schema?: { readonly jsonSchema: string }`
- `src/runners/claude/claude-runner.ts` — `buildCommand` with `--json-schema`, `extractStructuredOutput` prefers `structured_output`, `supports.structuredOutput: true`
- `src/runners/execute.ts` — **remove dead `structuredOutput` field** from `RunnerResult` (currently hardcoded `undefined` at line 65, never read by executor)
- `tests/fixtures/claude/structured-output-success.jsonl` — NDJSON with `structured_output` field
- `tests/fixtures/claude/structured-output-invalid.jsonl` — `structured_output` with wrong shape (for executor tests)
- `tests/fixtures/claude/structured-output-retries-exhausted.jsonl` — `error_max_structured_output_retries` error envelope

**Tests (add to existing test files):**

In `tests/unit/runners/claude/build-command.test.ts`:
- `buildCommand with schema appends --json-schema flag with serialized JSON Schema`
- `buildCommand without schema does not append --json-schema flag`
- `--json-schema appears before user flags and extraArgs`
- `buildCommand with schema and bare mode includes both --bare and --json-schema`

In `tests/unit/runners/claude/parse-events.test.ts`:
- `extractStructuredOutput returns structured_output when present`
- `extractStructuredOutput returns result when structured_output is undefined`
- `extractStructuredOutput returns structured_output even if result is also present`
- `extractStructuredOutput returns null structured_output as-is (not falling through to result)`
- `parseResultEnvelope routes error_max_structured_output_retries to error terminal event`

### Step 4: Executor capability check + schema threading + Zod validation

**Deliverables:**
- `src/core/workflow.ts` — capability check, schema in RunnerContext, Zod parse after extraction

**Tests (in `tests/unit/core/schema-validation.test.ts`):**
- `step with returns on a runner that does not support structured output throws at step start`
- `error message includes runner name and step name`
- `step with returns on a capable runner does not throw`
- `valid structured output is Zod-parsed and returned`
- `invalid structured output throws SchemaValidationError with Zod path`
- `SchemaValidationError includes the step name`
- `step without returns does not Zod-validate (returns raw value)`
- `undefined structured_output with schema present throws clear error before Zod parse`
- `null structured_output with schema present reaches Zod parse and produces actionable error`
- `z.transform schema applies transform after CLI extraction (post-transform value persisted)`
- `validators receive post-transform value in ctx.value`

### Step 5: Generic `RunFn` + workflow integration

**Deliverables:**
- `src/core/workflow.ts` — `RunFn` type becomes generic, `run` closure typed
- `src/core/index.ts` — update `RunFn` export

**Tests (type-level + runtime in `tests/unit/core/schema-validation.test.ts`):**
- `run(step with schema) returns typed value (compile-time assertion)`
- `run(step without schema) returns unknown (compile-time assertion)`
- `run(step with schema) value matches Zod-inferred type at runtime`
- End-to-end: define step with schema → script FakeRunner with matching value → run → destructure typed result

### Step 6: Test fixtures + helper

**Deliverables:**
- `tests/helpers/load-fixture.ts` — `loadJsonFixture(path): Promise<unknown>`
- `tests/fixtures/schemas/research-output.json` — realistic 3-field JSON for integration tests
- Update any existing fixture references if needed

### Step 7: Integration tests (mocked)

**Deliverables:**
- `tests/integration/runners/claude/claude-structured-mocked.test.ts`

**Tests:**
- Full round-trip: `step.define` with `returns: schema(z.object(...))` → `ClaudeRunner → runRunner → FakeProcessService` with `structured-output-success.jsonl` → executor Zod-parses → typed value returned
- Schema validation failure: `structured-output-invalid.jsonl` → `SchemaValidationError` thrown with Zod path
- Capability check failure: step with `returns:` against a runner with `structuredOutput: false` → immediate throw before spawn
- Memoization: second `run()` on same step returns cached value without re-running
- Schema step with validators: structured output available as `ctx.value` in `check()` callback

### Step 8: Integration tests (real, gated) + barrel exports + roadmap

**Deliverables:**
- `tests/integration/runners/claude/claude-structured-real.test.ts` — gated by `RUN_REAL_CLAUDE=1`
- Update `src/core/index.ts` and `src/runners/index.ts` barrel exports
- Update `docs/plans/implementation-phases.md` — mark Phase 7

**Real CLI test (gated):**
- `RUN_REAL_CLAUDE=1`: prompt Claude to return JSON matching a 3-field Zod schema (`{ title: string, items: string[], count: number }`), verify `structured_output` is Zod-parsed and type-safe

## Files

### New files

| File | Purpose | Est. lines |
|---|---|---|
| `src/core/schema.ts` | SchemaWrapper, schema(), SchemaValidationError | ~55 |
| `tests/helpers/type-assertions.ts` | `Expect<T>`, `Equal<X, Y>` compile-time type utilities | ~10 |
| `tests/unit/core/schema.test.ts` | Unit tests for schema module + type-level assertions + executor wiring | ~200 |
| `tests/fixtures/claude/structured-output-success.jsonl` | NDJSON with `structured_output` populated | ~5 |
| `tests/fixtures/claude/structured-output-invalid.jsonl` | NDJSON with wrong-shape `structured_output` | ~5 |
| `tests/fixtures/claude/structured-output-retries-exhausted.jsonl` | NDJSON with `error_max_structured_output_retries` | ~5 |
| `tests/integration/runners/claude/claude-structured-mocked.test.ts` | Mocked integration: full schema round-trip | ~100 |
| `tests/integration/runners/claude/claude-structured-real.test.ts` | Real CLI: structured output, gated | ~50 |

> **Simplifications from review:** Removed `isSchemaWrapper()` (~15 LOC saved). Merged `schema-validation.test.ts` into `schema.test.ts` (one fewer file, shared setup). Removed `tests/helpers/load-fixture.ts` (inline `JSON.parse(await Bun.file(path).text())` — a 1-liner doesn't warrant a helper per project philosophy). Removed `tests/fixtures/schemas/research-output.json` (inline the 3-field object literal in tests).

### Modified files

| File | Change |
|---|---|
| `package.json` | Add `zod-to-json-schema` to dependencies |
| `src/core/step.ts` | Generic `StepConfig<T>`, `Step<T>`, `step.define<T>`, `returns:` field |
| `src/core/workflow.ts` | Capability check, schema threading, undefined guard, Zod validation, generic `RunFn`, `as Promise<T>` cast |
| `src/core/index.ts` | Export `schema`, `SchemaWrapper`, `SchemaValidationError` |
| `src/runners/types.ts` | `RunnerContext.schema` optional field |
| `src/runners/execute.ts` | Remove dead `structuredOutput` field from `RunnerResult` |
| `src/runners/claude/claude-runner.ts` | `buildCommand` +`--json-schema`, `extractStructuredOutput` prefers `structured_output`, `supports.structuredOutput: true` |
| `src/runners/index.ts` | Re-export `RunnerContext` type (already exported — verify schema field visible) |
| `tests/unit/runners/claude/build-command.test.ts` | Add schema-related buildCommand tests + `--bare` interaction |
| `tests/unit/runners/claude/parse-events.test.ts` | Add `structured_output` extraction tests + `error_max_structured_output_retries` |
| `docs/plans/implementation-phases.md` | Mark Phase 7 ✓, add landed date + plan link |

## Acceptance Criteria

### Unit tests — schema module

- [x] `schema()` produces valid JSON Schema for object, array, string, number, boolean, enum, optional, nullable
- [x] `schema()` returns a frozen wrapper with stable jsonSchema string
- [x] JSON Schema output has no `$schema` key (stripped for CLI consumption)
- [x] JSON Schema uses inline definitions (no `$ref` pointers)
- [x] `SchemaValidationError` message includes step name + Zod path details
- [x] `SchemaValidationError` instanceof works cross-transpile (Object.setPrototypeOf)

### Unit tests — generic Step

- [x] `step.define` with `returns: schema(z.object(...))` infers `Step<T>` (compile-time)
- [x] `step.define` without `returns:` infers `Step<unknown>` (compile-time)
- [x] `step.define` with `returns: schema(z.string())` infers `Step<string>` (compile-time)

### Unit tests — ClaudeRunner

- [x] `buildCommand` with `ctx.schema` appends `--json-schema` with serialized JSON
- [x] `buildCommand` without `ctx.schema` omits `--json-schema`
- [x] `--json-schema` appears before user `flags` and `extraArgs`
- [x] `buildCommand` with schema and `bare: true` includes both flags
- [x] `extractStructuredOutput` returns `structured_output` when present
- [x] `extractStructuredOutput` falls back to `result` when `structured_output` undefined
- [x] `extractStructuredOutput` returns null `structured_output` as-is
- [x] `parseResultEnvelope` routes `error_max_structured_output_retries` to error event
- [x] `claude()` factory: `supports.structuredOutput` is `true`

### Unit tests — executor schema wiring

- [x] Step with `returns:` on non-capable runner → throws before spawn
- [x] Error message includes runner name and step name
- [x] Step with `returns:` on capable runner → no throw
- [x] Valid structured output → Zod-parsed, correct type returned
- [x] Invalid structured output → `SchemaValidationError` with Zod path
- [x] Step without `returns:` → raw value returned (no Zod validation)
- [x] Undefined structured_output with schema → clear error before Zod parse
- [x] Null structured_output with schema → reaches Zod parse, actionable error
- [x] z.transform schema → post-transform value persisted and returned
- [x] Validators receive post-transform value in ctx.value
- [x] `RunFn` generic: `run(schemaStep)` returns typed promise (compile-time, `Expect<Equal<>>`)
- [x] `RunFn` generic: `run(plainStep)` returns `Promise<unknown>` (compile-time, `Expect<Equal<>>`)
- [x] End-to-end: `step.define` + schema + FakeRunner → typed destructured result

### Integration tests (mocked)

- [x] Full round-trip: schema step → ClaudeRunner → FakeProcessService → Zod-validated typed value
- [x] Schema validation failure → `SchemaValidationError` with Zod path details
- [x] Capability check failure → immediate throw before spawn (tested in unit; mocked integration uses FakeRunner which supports it)
- [x] Memoization: second `run()` returns cached value (FakeRunner invocation count = 1)
- [x] Schema step + validators: structured output available as `ctx.value` in `check()`
- [x] `error_max_structured_output_retries` → `StepError` with informative message
- [x] `--bare` + `--json-schema` coexistence: `structured_output` present in result envelope

### Integration tests (real, gated `RUN_REAL_CLAUDE=1`)

- [x] Real Claude with `--json-schema` for a 3-field schema → Zod-parsed, type-safe value
- [ ] At least one intermediate event (system init or assistant) before result (covered by existing real test)
- [ ] `--bare` mode does not suppress `structured_output` in result envelope (requires real CLI verification)

### Quality gates

- [x] `bun run check` green
- [x] Files ≤ 300 lines, functions ≤ 60 lines (`workflow.ts` at 244 after extraction)
- [x] No `any`, `!`, or unsafe `as` casts on `unknown` (one documented safe `as Promise<T>` in RunFn)
- [x] No `child_process`/`Bun.spawn` outside `src/services/process/`
- [x] `zod-to-json-schema` is the only new runtime dep
- [x] Dead `RunnerResult.structuredOutput` field removed from `execute.ts`

## Decisions Log

| ID | Decision | Rationale |
|---|---|---|
| D1 | No `Runner.extractStructuredOutput` signature change | Runner checks envelope contents directly (`structured_output` present → use it). Avoids interface break, keeps runners decoupled from Zod. Deviation from brainstorm — simpler, same result. |
| D2 | `SchemaValidationError` is a new class (not `StepError`) | No exit code — it's a data-shape mismatch, not a process failure. Step → `crashed`, resume re-runs. |
| D3 | No Zod re-validation on cache hit | Value was validated when originally persisted. Re-validating on resume is wasteful. Schema drift = change step name or clear state. |
| D4 | `RunFn` uses `as Promise<T>` cast | One safe cast. `runStepOnce` guarantees Zod parse succeeded. Alternative (overloads) would add complexity for no safety gain. |
| D5 | Validators stay `Validator<unknown>` (not `Validator<T>`) | Typing validators requires users to annotate `check<T>(...)`. YAGNI. `ValidatorCtx<V>` generic from Phase 6 keeps door open. |
| D6 | Test helper for fixture loading (not FakeRunner API) | Zero churn on FakeRunner constructor/API. Same test ergonomics. FakeRunner can gain `scriptFromFile()` later if needed. |
| D7 | `--json-schema` before user `flags` and `extraArgs` | Mirrors `--model` and `--max-turns` placement. User flags can still override if needed. |
| D8 | `supports.structuredOutput: true` on `claude()` | The runner CAN do it. Whether a step USES it is a step-config concern checked by the executor. |
| D9 | `z.transform()` / `z.refine()` silently lossy in JSON Schema | `zod-to-json-schema` strips these. Claude won't see the constraint. Zod parse catches violations post-facto. Acceptable: user gets clear error. Documenting, not blocking. Prefer `.min()/.max()/.regex()` over `.refine()` — they map to JSON Schema constraints. |
| D10 | No argv size guard in Phase 7 | Every schema we're imagining is small (<1KB serialized). Revisit with `--json-schema @file` fallback only if a real workflow hits OS argv limits. Note: `z.describe()` annotations flow into JSON Schema and can inflate size unexpectedly. |
| D11 | Remove `_tag` brand and `isSchemaWrapper()` | Never used in production code. All usage sites check `s.config.returns !== undefined` directly. Saves ~25 LOC. (Deepening discovery — simplicity + pattern agents.) |
| D12 | Remove dead `RunnerResult.structuredOutput` from `execute.ts` | Hardcoded `undefined`, never read. Executor calls `extractStructuredOutput(result.finalEvent)` directly. Dead field confuses where structured output lives. (Deepening discovery — spec-flow agent.) |
| D13 | Guard `undefined` structured_output before Zod parse | When CLI succeeds but returns no `structured_output`, throw a distinct error rather than letting Zod produce cryptic "Expected object, received undefined". (Deepening discovery — spec-flow + TypeScript agents.) |
| D14 | Use `$refStrategy: 'none'` and strip `$schema` in zodToJsonSchema | CLI needs flat inline JSON. `$ref` pointers add complexity with no benefit. `$schema` URI is unnecessary overhead. (Deepening discovery — zod-to-json-schema research.) |
| D15 | Use `Expect<Equal<>>` for compile-time type assertions in tests | Same pattern as TypeScript compiler's own test suite. Superior to `satisfies` — catches exact type equality, not just assignability. Zero runtime cost. (Deepening discovery — TS generics research.) |
| D16 | `returns:` schemas must produce JSON-serializable values | `z.transform()` producing `Date`/`Map`/`Set` breaks `JSON.stringify` in state persistence. Inherent constraint of the persistence design, not a bug. Document explicitly. (Deepening discovery — spec-flow agent.) |

## Review Insights

### Architecture (approved — 7/7 decisions sound)

All seven original architecture decisions passed independent review. Key confirmations:
- **Schema on `RunnerContext`** is the correct seam — alternative (runner reads from Step) would break the adapter boundary, coupling `src/runners/` to `src/core/`.
- **Validation in executor, not runner** is a strict improvement over the brainstorm — keeps runners Zod-free and protocol-agnostic, future runners (Codex, Aider) only extract raw JSON from their envelope.
- **Runtime capability check** is proportionate to the risk — a compile-time `Runner<SupportsSchema>` generic would propagate through `WorkflowDeps`, `RunFn`, and every test file for a bug that fires once per misconfiguration.

**Watch item:** `workflow.ts` is at 281 lines. Phase 7 adds ~15. Consider extracting `runValidators` + helpers (~50 lines) into `src/core/validation-runner.ts` before or during Phase 8 to maintain headroom.

### Performance (no issues found)

All overhead is negligible relative to the dominant cost: spawning a CLI subprocess (seconds to minutes).
- `zodToJsonSchema` for 10-field schema: sub-millisecond. Runs once at definition time.
- `JSON.stringify` of JSON Schema: sub-microsecond. Once per schema.
- `safeParse` on structured output: 0.01-0.1ms per step. Ratio to subprocess: ~1:100,000.
- `Object.freeze`: negligible in modern engines, once at definition time.
- No Zod re-validation on cache hit: correct — value was validated when first produced.

**Minor note:** `extractStructuredOutput` calls `ClaudeResultSuccess.safeParse` on already-parsed data (double-parse). Not a performance concern but a code smell — the terminal event's `data` already holds validated output. Clean up opportunistically.

### Security (1 actionable, 2 informational)

**Actionable (Medium):** Cache-hit bypass of Zod re-validation. On resume, tampered `state.json` can inject any JSON value cast to `T` via `RunFn`. Fix cost is negligible (one `safeParse` call on cache hit when `returns:` present). **Recommendation: consider adding in Phase 7 or deferring to Phase 11 (resume) with a doc comment.**

**Informational (Low):** `__proto__` keys survive `JSON.parse` + Zod `.passthrough()`. Bun's `JSON.parse` creates a plain property, not prototype chain mutation. No action needed.

**Informational (Low):** `zod-to-json-schema` has zero runtime dependencies beyond Zod peer dep. Minimal supply chain surface.

### Open Question from Multiple Reviewers — Cache-Hit Re-Validation

4 out of 10 agents independently flagged the same concern: when a developer changes the Zod schema without changing the step name, the cached value passes `as Promise<T>` unchecked. Destructuring `const { newField } = await run(STEP)` silently gets `undefined`.

**Options:**
1. **Do nothing (current plan)** — developer changes step name or clears state. Risk is pre-production only.
2. **Hash guard** — persist `jsonSchema` hash alongside `StepEntry.value`. On cache hit, compare. Log warning or invalidate on mismatch. ~10 LOC.
3. **Re-validate on cache hit** — `safeParse` cached value when `returns:` present. ~5 LOC, negligible cost.

**Recommendation:** Option 3 is simplest. Add it to Step 4 as an optional enhancement. If it ships, remove the memoization-gap caveat from edge case #2.

## References

### Internal
- Brainstorm: [`docs/brainstorms/2026-04-11-phase-7-typed-returns-brainstorm.md`](../brainstorms/2026-04-11-phase-7-typed-returns-brainstorm.md)
- Runner interface: `src/runners/types.ts`
- ClaudeRunner: `src/runners/claude/claude-runner.ts`
- FakeRunner: `src/runners/fake/fake-runner.ts`
- Executor: `src/runners/execute.ts`
- Step DSL: `src/core/step.ts`
- Workflow: `src/core/workflow.ts`
- State store: `src/state/state-store.ts` — `StepEntry.value: unknown` (no change)
- Validators: `src/validators/validator.ts` — `ValidatorCtx<V = unknown>` (prepared in Phase 6)

### External
- `zod-to-json-schema`: https://github.com/StefanTerdell/zod-to-json-schema
- Claude CLI `--json-schema`: https://code.claude.com/docs/en/cli-reference
- Claude CLI structured output: `structured_output` field in result envelope, `error_max_structured_output_retries` subtype on failure
