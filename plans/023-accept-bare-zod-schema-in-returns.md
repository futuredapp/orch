# Plan 023: Accept a bare Zod schema in `returns:`

> **Executor instructions**: Follow step by step; run every verification command.
> Stop and report on any STOP condition. Update the plan 023 row in
> `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 0265592..HEAD -- src/core/step.ts src/core/schema.ts`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `0265592`, 2026-07-02

## Why this matters

Typed structured output — the library's headline feature — requires authors to wrap
every schema in `schema(...)`: `returns: schema(z.object({...}))`. This extra concept
and repeated call buys nothing at the call site (the wrapper only memoizes JSON
Schema and runs an empty-schema guard, both of which orch can do internally). Every
typed example repeats it (`examples/math-duel`, `examples/compound`,
`examples/file-prompts-demo`). Letting `returns:` accept a bare `z.object(...)`
removes the boilerplate while keeping `schema()` available for authors who want to
precompute/share a wrapper.

## Current state

- `src/core/step.ts:36-37` — `returns` accepts only the wrapper:
  ```ts
  /** Zod schema for structured CLI output. Enables `--json-schema` and Zod validation. */
  readonly returns?: SchemaWrapper<T>
  ```
- `src/core/schema.ts:9-29` — the wrapper and its constructor:
  ```ts
  export interface SchemaWrapper<T = unknown> {
    readonly zodSchema: ZodType<T, ZodTypeDef, unknown>
    readonly jsonSchema: string
  }
  export function schema<T>(zodSchema: ZodType<T, ZodTypeDef, unknown>): SchemaWrapper<T> {
    const jsonSchemaObj = zodToJsonSchema(zodSchema, { $refStrategy: 'none' })
    const { $schema: _, ...rest } = jsonSchemaObj as Record<string, unknown>
    assertNonEmptyJsonSchema(rest)
    const jsonSchema = JSON.stringify(rest)
    return Object.freeze({ zodSchema, jsonSchema })
  }
  ```
- `step.define` stores the config (see `defineStep` at `src/core/step.ts:271-308`).
  The config is consumed by the executor via `config.returns.zodSchema` /
  `config.returns.jsonSchema` (e.g. `onCacheHit` at `step.ts:411-418`, and the
  autonomous argv builder reads `ctx.schema.jsonSchema`). So the stored `returns`
  must remain a `SchemaWrapper` after normalization — only the ACCEPTED input widens.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `bun run typecheck` | exit 0 |
| Schema + step tests | `bun test tests/unit/core/schema.test.ts tests/unit/core/schema-validation.test.ts tests/unit/core/step.test.ts` | all pass |
| Full gate | `bun run check` | exit 0 |

## Scope

**In scope:**
- `src/core/step.ts` — widen the ACCEPTED `returns` input to
  `SchemaWrapper<T> | ZodType<T>`; normalize a bare Zod schema via `schema()` at
  `step.define` time so the STORED config keeps a `SchemaWrapper`.
- `tests/unit/core/schema*.test.ts` / `step.test.ts` — add coverage.

**Out of scope (do NOT touch):**
- `schema()` itself — keep it public and unchanged.
- The executor's consumption of `config.returns` (it should keep seeing a
  `SchemaWrapper` — normalization guarantees that).
- `src/index.ts` — `schema` and `z` stay exported.

## Steps

### Step 1: Widen the accepted input type

The tricky part is TypeScript: `AgentStepConfig<T>.returns` (`step.ts:37`) is the
STORED shape and must stay `SchemaWrapper<T>`. Widen only the `define` INPUT types
(`AutonomousStepInput<T>` at `step.ts:202-206`, which is
`Omit<AgentStepConfig<T>, 'kind' | 'promptFile'> & {...}`). Since `returns` on the
stored config is `SchemaWrapper<T>`, override it in the input type to accept either:

```ts
type AutonomousStepInput<T> = Omit<AgentStepConfig<T>, 'kind' | 'promptFile' | 'returns'> & {
  readonly promptFile?: string
  readonly vars?: never
  readonly returns?: SchemaWrapper<T> | ZodType<T, ZodTypeDef, unknown>
}
```

Import `ZodType, ZodTypeDef` from `zod` in `step.ts` (or re-export the needed type
from `schema.ts`). The `define` overloads (`step.ts:242-269`) reference
`AutonomousStepInput<TResult>`, so they inherit the widened input automatically —
verify they still infer `T`.

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Normalize a bare schema at define time

In `defineStep` (`step.ts:271-308`), before freezing the config, if `returns` is a
bare Zod schema (duck-type: it has a `safeParse` function but NOT a `jsonSchema`
string), wrap it via `schema()`:

```ts
function normalizeReturns(returns: unknown): SchemaWrapper<unknown> | undefined {
  if (returns === undefined) return undefined
  // Already a wrapper.
  if (typeof (returns as { jsonSchema?: unknown }).jsonSchema === 'string') {
    return returns as SchemaWrapper<unknown>
  }
  // Bare Zod schema — wrap it (this also runs assertNonEmptyJsonSchema).
  if (typeof (returns as { safeParse?: unknown }).safeParse === 'function') {
    return schema(returns as ZodType<unknown, ZodTypeDef, unknown>)
  }
  return returns as SchemaWrapper<unknown>
}
```

Call it where the resolved config is assembled (after `resolvePromptFile`, before
`Object.freeze`), replacing `returns` in the stored config with the normalized
wrapper. Import `schema` and `SchemaWrapper` from `./schema.ts`.

The interactive overload forbids `returns` already (`step.ts:283-288`) — leave that
guard as-is; it fires before normalization.

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Tests

Add to `tests/unit/core/step.test.ts` (mirror its `returns`/`schema` cases):
- `step.define('x', { agent, prompt, returns: z.object({ n: z.number() }) })` stores
  a config whose `returns` is a `SchemaWrapper` (has a string `jsonSchema`).
- `step.define('x', { agent, prompt, returns: schema(z.object({ n: z.number() })) })`
  still works (regression) and produces an equivalent wrapper.
- A bare schema that produces an empty JSON Schema still throws the existing
  `assertNonEmptyJsonSchema` error (the Zod-v4 guard message) — same as
  `schema()` today. Reuse the existing empty-schema test from
  `tests/unit/core/schema.test.ts` as the pattern.

**Verify**: `bun test tests/unit/core/schema.test.ts tests/unit/core/schema-validation.test.ts tests/unit/core/step.test.ts`
→ all pass; then `bun run check` → exit 0.

## Test plan

- Bare `z.object(...)` in `returns` normalizes to a `SchemaWrapper`.
- `schema(...)` still accepted (regression).
- Empty-schema guard still fires for a bare schema.
- Pattern to copy: existing `returns`/`schema` tests in `step.test.ts` /
  `schema.test.ts`.
- Verification: the three test files above → all pass.

## Done criteria

ALL must hold:

- [ ] `returns: z.object({...})` (bare) compiles and is stored as a `SchemaWrapper`.
- [ ] `returns: schema(z.object({...}))` still works.
- [ ] The empty-JSON-Schema guard still throws for a bare schema.
- [ ] `bun run typecheck` exits 0; the three test files pass.
- [ ] `bun run check` exits 0.
- [ ] Only in-scope files modified.
- [ ] `plans/README.md` row 023 updated.

## STOP conditions

Stop and report if:

- Widening the input type breaks `T` inference on `run(STEP)` result typing (a
  `returns`-typed step must still infer its result type) — if the inferred result
  type degrades to `unknown`, STOP; the type surgery needs the maintainer.
- The duck-type check (`safeParse` vs `jsonSchema`) misclassifies a real wrapper or
  schema — add a more precise discriminator and report.

## Maintenance notes

- After this, update the docs and examples to prefer the bare form (`returns:
  z.object(...)`), and reconcile `docs/public/reference/api.md` (the `step.define`
  signature) — but do the example migration as a separate follow-up to keep this PR
  focused.
- Reviewer: the load-bearing invariant is that the STORED config `returns` is always
  a `SchemaWrapper` (the executor depends on `.jsonSchema`/`.zodSchema`).
