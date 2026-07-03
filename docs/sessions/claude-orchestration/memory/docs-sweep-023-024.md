# Docs sweep 023/024 - bare-Zod `returns:` in user docs

## What I did

Updated `docs/public/` to show the bare `returns: z.object(...)` form (what the `orch init` scaffold now emits, per [[build-024-init-scaffold]]) as canonical, while keeping the wrapped `schema(...)` form documented as an equivalent, accepted alternative (per [[build-023-bare-zod-returns]]).

Pages changed:

- `docs/public/reference/api.md`
  - `step.define` example: switched `returns: schema(z.object(...))` to bare `returns: z.object(...)` and dropped the now-unused `schema` import (kept `fileProduced`). Added a two-line note that `returns:` accepts either form and a bare schema is normalized through `schema()` at define time.
  - `AgentStepConfig` table `returns` row: type `SchemaWrapper<T>` -> `SchemaWrapper<T> \| ZodType<T>`, notes now mention both the bare and wrapped forms.
  - `schema` section: added a note that `returns:` also accepts a bare Zod schema directly, and `schema()` is only needed to reuse a wrapper or validate eagerly.
- `docs/public/guide/4-writing-a-workflow.md` - both `returns: schema(...)` examples (the intro one and the complete-workflow one) to bare form; dropped `schema` from both `import` lines; reworded the intro sentence away from "`returns: schema(...)`".
- `docs/public/guides/typed-returns.md` - "What you'll learn" and intro reworded to bare form; primary + richer-shape examples to bare; dropped `schema` from the primary import. Added a new "Reusing a wrapped schema" section (with `schema()` + named-wrapper example) for the wrapped alternative, and a forward link to it from the intro.
- `docs/public/index.md` - landing example `returns:` to bare form; dropped `schema` from its import (confirmed `schema` unused elsewhere on the page).

## Key decisions

- **Left `docs/public/guides/subworkflows.md` unchanged.** Its `returns: DECISION` block is explicitly labeled `// examples/feature/index.ts` and mirrors that real example file, which still uses a named `schema(z.object(...))` wrapper. This task is scoped to `docs/public/` only and cannot touch `examples/`, so editing the doc alone would make it drift from the file it quotes. The named-wrapper form is still fully valid, so the page stays correct as-is. (The examples migration to the bare form is the deferred follow-up both build-023 and build-024 flagged - out of scope here.)
- Kept the wrapped form documented, not deleted - both forms are valid API. Bare is presented as primary/canonical because that is what the scaffold emits.

## api.md signature reconciled against `src/`

Confirmed against `src/core/step.ts`:
- `AutonomousStepInput<T>` field (line 212): `readonly returns?: SchemaWrapper<T> | ZodType<T, ZodTypeDef, unknown>`.
- `normalizeReturns` (lines 327-338): undefined -> undefined; object with string `jsonSchema` -> already a wrapper, returned as-is; object with a `safeParse` function -> bare Zod schema, wrapped via `schema(...)`; else returned as-is. The STORED `config.returns` is always a `SchemaWrapper` (executor reads `.jsonSchema`/`.zodSchema`).

Table cell uses `SchemaWrapper<T> | ZodType<T>` (readable short form of the input union); the prose spells out both concrete forms.

## Verified

- `bun run docs:build` -> exit 0 (dead-link gate; also validates the new `#reusing-a-wrapped-schema` anchor). Ran twice to confirm the exit code.

Path-scoped to `docs/public/` + this diary only. Did NOT touch `src/`, `tests/`, `examples/`, `plans/`. Never ran bare `bun test` / `bun run check`. Ran no git commands.

## Deferred / gotcha

- `examples/` migration to the bare form (math-duel, compound, file-prompts-demo, feature) is still open - flagged by build-023 and build-024. Until it lands, `subworkflows.md` intentionally keeps the wrapped form to stay in lockstep with `examples/feature/index.ts`. A later worker migrating the examples should re-check whether `subworkflows.md` should then flip to bare too.
