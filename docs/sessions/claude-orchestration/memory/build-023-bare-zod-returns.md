# Build 023 - accept a bare Zod schema in `returns:`

## What I did

Widened the `step.define` autonomous INPUT type so `returns:` accepts either a wrapper (`schema(z.object({...}))`) or a bare Zod schema (`returns: z.object({...})`), while the STORED config `returns` stays a `SchemaWrapper` (the executor depends on `.jsonSchema`/`.zodSchema`).

Changes, all in `src/core/step.ts`:

- Imported `type { ZodType, ZodTypeDef } from 'zod'` and added `schema` to the existing `./schema.ts` import.
- `AutonomousStepInput<T>` now omits `'returns'` from the base `AgentStepConfig<T>` and re-declares `readonly returns?: SchemaWrapper<T> | ZodType<T, ZodTypeDef, unknown>`.
- Added a `normalizeReturns(returns: unknown): SchemaWrapper<unknown> | undefined` helper: undefined -> undefined; string `jsonSchema` -> already a wrapper, return as-is; `safeParse` function -> bare Zod schema, wrap via `schema(...)` (which also runs `assertNonEmptyJsonSchema`); else return as-is.
- Called it in `defineStep` after `resolvePromptFile`, before `Object.freeze`, overriding `returns` in the stored config with the normalized wrapper only when defined.

Left `schema()`, the executor's consumption of `config.returns`, `src/index.ts`, and the interactive `returns`-forbidden guard untouched (the guard fires before normalization).

## Key decisions

- Duck-type discriminator per the plan: wrapper = string `jsonSchema`; bare schema = `safeParse` function. In `defineStep` I check `returns !== undefined` before spreading so an absent `returns` stays absent on the stored config (matches prior shape; `onCacheHit` still keys off `config.returns === undefined`).
- Did NOT re-export the Zod types from `schema.ts`; imported them directly from `zod` in `step.ts` (simpler, and `schema.ts` already imports them the same way).

## Drift check

`git diff --stat 0265592..HEAD -- src/core/step.ts src/core/schema.ts` -> clean (no output). Plan's "Current state" excerpts matched live code; no adjustment needed.

## `T` inference

Held. Added a compile-time assertion in `step.test.ts`: `Expect<Equal<typeof BARE, Step<{ n: number }>>>` where `BARE = step.define('bare', { agent, returns: z.object({ n: z.number() }) })`. It passes typecheck, so a bare schema still infers `Step<T>` and does not degrade to `unknown`. No STOP condition hit; duck-type did not misclassify.

## Tests added (`tests/unit/core/step.test.ts`)

- stores a `SchemaWrapper` when `returns` is a bare Zod schema (string `jsonSchema`, `zodSchema.safeParse` works).
- infers `Step<T>` from a bare Zod schema (compile-time assertion).
- wrapped form still produces an equivalent wrapper (regression: bare vs `schema(...)` yield identical `jsonSchema`).
- a bare schema producing an empty JSON Schema still throws `assertNonEmptyJsonSchema` (reused the fake-v4 pattern from `schema.test.ts`, plus a `safeParse` stub so it routes through the bare-schema branch).

## Verified

- `bun run typecheck` -> exit 0.
- `bun test tests/unit/core/schema.test.ts tests/unit/core/schema-validation.test.ts tests/unit/core/step.test.ts` -> 75 pass, 0 fail.

Path-scoped only. Did NOT run `bun run check` / bare `bun test`, did NOT touch `plans/README.md`, ran no git commands.

## Deferred / follow-ups

- Docs + example migration left for a later task per the prompt override: reconcile `docs/public/reference/api.md` (`step.define` signature) and migrate `examples/math-duel`, `examples/compound`, `examples/file-prompts-demo` to prefer the bare `returns: z.object(...)` form. The plan's "Maintenance notes" already flags this as a separate PR.
- `plans/README.md` row 023 not updated (workflow owns commits; prompt forbids editing that file).

## Gotcha

The empty-schema test needs a `safeParse` stub on the fake schema so `normalizeReturns` classifies it as a bare schema (routes to `schema()`); the fake in `schema.test.ts` has only `_def` and is passed straight to `schema()`, so it does not need one.
