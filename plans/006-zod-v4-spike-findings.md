# Plan 006 — Findings: can orch move to Zod v4 (and drop `zod-to-json-schema`)?

> Spike executed 2026-06-11 against audit commit `832a56d` (branch
> `feat/improve-codebase`). All experimental edits (zod bump, `schema.ts` swap,
> scratch script) were reverted after these findings were recorded; the only
> lasting change is this file and the `plans/README.md` row.

## 1. Verdict

**GO-WITH-CONDITIONS.**

The migration is small (2 source files carry the real breakage), the
`zod-to-json-schema` dependency can be **dropped entirely** in favour of Zod
v4's native `z.toJSONSchema(schema, { io: 'input' })`, and the runtime output
is a valid Anthropic `input_schema`. The conditions are not blockers — they are
required follow-ups the migration plan must include:

1. Call `z.toJSONSchema(zodSchema, { io: 'input' })` — the `io: 'input'` option
   is **mandatory**, not optional: without it, native conversion *throws* on
   any schema that uses `.transform()`/pipe (orch supports these — two existing
   tests exercise them).
2. Fix `src/state/state-store.ts` for the v4 `ZodError.issues[].path` shape
   change (`PropertyKey[]`, now includes `symbol`).
3. **Rewrite the empty-schema guard, not just its message.** The field hazard
   *inverts* under v4 and the current guard does not catch the inverted case —
   see §5. This is the most important non-obvious finding.
4. Update two schema unit tests whose assertions encode the v3 output shape.

## 2. Dependency-matrix facts (Step 1)

| Fact | Value (exact) |
|------|---------------|
| Installed zod today | `zod@3.25.76` |
| Installed converter today | `zod-to-json-schema@3.25.2` |
| `zod-to-json-schema@3.25.2` declared `peerDependencies.zod` | `^3.25.28 \|\| ^4` |
| Latest **stable** zod | `4.4.3` (`bun pm view zod version`) |
| `bun add zod@^4` resolved to | `zod@4.4.3` |
| Resolver outcome | **Clean** — no peer conflict; `zod-to-json-schema@3.25.2` retained (its `^4` peer range is satisfied) |

Surprise worth flagging: `zod-to-json-schema@3.25.2`'s `peerDependencies`
*claims* `^4` support, but at runtime it **does not actually convert a v4
schema** (see §4). The peer range is aspirational, not functional, at this
version. (Note the installed `3.25.2` is also below its own declared `^3.25.28`
peer floor — npm/bun do not hard-enforce that, so it installs anyway.)

## 3. Breakage inventory (Step 2)

`bun add zod@^4` then `bun run typecheck`: **31 errors total** (baseline on v3
is 0). Well under the ~100 STOP threshold. Grouped by file:

| File | Errors | Nature |
|------|--------|--------|
| `examples/math-duel/index.ts` | 13 | **Cascade** — `schema()` lost its `T`, inferred `unknown`; vanish once `schema.ts` is fixed |
| `tests/unit/core/schema-validation.test.ts` | 4 | Cascade + transform behaviour (see below) |
| `src/core/schema.ts` | 4 | **Root cause** — `ZodTypeDef` no longer exported; `ZodType` generic arity changed (3 args → 2) |
| `src/state/state-store.ts` | 3 | **Real, separate** — `ZodError.issues[].path` is now `PropertyKey[]` (can include `symbol`); `wrapSchemaError`/`StateCorruptionError` expect `(string\|number)[]` |
| `tests/unit/core/schema.test.ts` | 2 | Test-assertion drift on output shape |
| `examples/compound/index.ts` | 2 | Cascade |
| `examples/feature/index.ts` | 1 | Cascade |
| `examples/file-prompts-demo/index.ts` | 1 | Cascade |
| `tests/integration/runners/claude/claude-structured-real.test.ts` | 1 | Cascade |

**Net: only 2 source files have non-cascade type errors** — `src/core/schema.ts`
(fixed by the native swap below) and `src/state/state-store.ts` (one
`ZodError`-shape fix). The 17 example/test errors are all downstream of
`schema()`'s `T` collapsing to `unknown` and resolve once `schema.ts` typechecks.

**Runtime test (the decisive one).** A 10-line scratch script calling orch's
`schema()` on `z.object({ name: z.string() })` with a **v4** schema, via the
*unchanged* `zod-to-json-schema` path:

```
error: schema() produced an empty JSON Schema (no type / anyOf / ...).
  at assertNonEmptyJsonSchema (src/core/schema.ts:50:13)
```

→ `schema()` **throws**. `zod-to-json-schema@3.25.2` emits an empty schema for a
v4 `z.object`, and orch's own guard fires. **Keeping `zod-to-json-schema` is not
an option under v4** — it is the very failure the guard exists to catch.

Schema-focused unit tests on v4 with the unchanged converter:
`tests/unit/core/schema.test.ts` + `schema-validation.test.ts` → both files fail
at module load (the guard throw aborts collection). `0 pass / 2 fail`.

## 4. Native `z.toJSONSchema` feasibility (Step 3) — can we drop `zod-to-json-schema`?

**Yes — `zod-to-json-schema` can and should be dropped entirely.**
`src/core/schema.ts` is its only consumer (`grep -rn "zod-to-json-schema" src/`).

Temporary edit applied to `src/core/schema.ts` (only this file — STOP condition
respected):

```diff
-import type { ZodError, ZodType, ZodTypeDef } from 'zod'
-import zodToJsonSchema from 'zod-to-json-schema'
+import { type ZodError, type ZodType, z } from 'zod'
 ...
-  readonly zodSchema: ZodType<T, ZodTypeDef, unknown>
+  readonly zodSchema: ZodType<T, unknown>
 ...
-export function schema<T>(zodSchema: ZodType<T, ZodTypeDef, unknown>): SchemaWrapper<T> {
-  const jsonSchemaObj = zodToJsonSchema(zodSchema, { $refStrategy: 'none' })
+export function schema<T>(zodSchema: ZodType<T, unknown>): SchemaWrapper<T> {
+  const jsonSchemaObj = z.toJSONSchema(zodSchema, { io: 'input' })
```

Runtime output (native, `io: 'input'`):

```json
{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false}
```

→ has a `type` key, passes the guard, valid Anthropic `input_schema`. Schema
unit tests after this swap: **29 pass / 2 fail** (the 2 are assertion drift, §6).

### Output-shape differences vs `zod-to-json-schema` v3 (downstream notes)

- **`$schema` key**: native v4 *still* emits
  `"$schema":"https://json-schema.org/draft/2020-12/schema"`. orch's existing
  strip (`const { $schema: _, ...rest } = ...`) handles it **unchanged** — no
  adaptation of the strip logic needed.
- **`$refStrategy: 'none'` → no longer needed**: zod v4 defaults to
  `reused: "inline"`. A schema reusing a sub-schema in two fields inlines both
  (verified) — same flat output the old `$refStrategy: 'none'` produced. (Truly
  recursive/self-referential schemas would still emit `$ref` under any setting;
  orch has none today.)
- **`additionalProperties: false`** is emitted on objects by default (strict).
  Anthropic `input_schema` accepts this; it is if anything stricter/safer.
- **`nullable` shape changed**: v3 emitted `type: ["string","null"]`; v4 emits
  `anyOf: [{"type":"string"},{"type":"null"}]`. Both pass the guard (`anyOf` is
  in `NON_EMPTY_SCHEMA_KEYS`) and both are valid `input_schema`. Only a *test
  assertion* encodes the old shape (§6).
- **`.transform()` / pipe schemas**: native `z.toJSONSchema` **throws**
  `"Transforms cannot be represented in JSON Schema"` by **default**.
  `{ io: 'input' }` makes it emit the *input* side (`z.string().transform(...)`
  → `{"type":"string"}`), which is exactly orch's contract: the JSON Schema
  describes what the model/CLI must *produce*; orch's transform runs *after*
  `safeParse`. `{ unrepresentable: 'any' }` is the wrong knob — it emits `{}`
  and trips the guard. **`io: 'input'` is the correct and required setting.**

## 5. Host-mismatch inversion (Step 4) — **experiment result**

Question: after orch→v4, what happens to a host project still on Zod v3 whose
workflow does `import { z } from 'zod'` (the documented anti-pattern)?

Constructed the foreign-schema scenario directly (a schema object lacking v4's
`_zod` internals — faithful to a real v3 `ZodType`, which has `._def` but no
`._zod`):

```
z.toJSONSchema(<v3-style schema>)
→ TypeError: undefined is not an object (evaluating 'schema._zod.def')
```

And through orch's `schema()`:

```
schema(<v3-style schema>) → THROWS the SAME raw TypeError — NOT the guard message.
```

**The hazard inverts *and gets worse*:**

- **Today (orch v3 + host v4):** converter silently returns `{}`, orch's
  `assertNonEmptyJsonSchema` catches it and throws a *friendly, actionable*
  message ("import z from orch / downgrade host to v3").
- **After migration (orch v4 + host v3):** native `z.toJSONSchema` throws a
  *raw internal* `TypeError` deep inside zod, **before** orch's guard runs. The
  carefully-worded guard message **never fires** for the inverted case.

**Therefore the `schema.ts:50-63` message rewrite is necessary but NOT
sufficient.** The migration must *also* wrap the `z.toJSONSchema` call in
try/catch, detect the foreign-schema `TypeError` (e.g. message contains
`_zod`), and re-throw orch's friendly guidance — now reading the *opposite* of
today:

- Old: "…most commonly Zod v4 in the host while orch is on v3 … align your host
  to Zod v3: `bun add zod@^3`."
- New (proposed): "…most commonly Zod **v3** in the host while orch is on Zod
  **v4** … import `{ z } from 'orch'` in `.orch/` workflows, **or** upgrade the
  host to Zod v4: `bun add zod@^4`."

The empty-schema branch should stay too (defends against future converters that
emit `{}` rather than throw), so the guard becomes two-armed: (a) catch the
foreign-schema throw, (b) keep the empty-`rest` check.

## 6. Tests that need updating (drift, not blockers)

- `tests/unit/core/schema.test.ts` → *"produces correct JSON Schema for
  z.nullable"*: asserts `parsed.type` contains `'string'`/`'null'`; v4 emits
  `anyOf`. Rewrite to the `anyOf` shape.
- `tests/unit/core/schema.test.ts` → *"error message names the failure mode…"*
  (and its sibling): both fabricate a `{ _def: { typeName: 'ZodSomethingV4Only' } }`
  to simulate "converter can't read this schema". Under native v4 this throws a
  raw `TypeError`, not the guard message. These tests must be re-pointed at the
  *new* guard (the foreign-schema catch from §5) — they encode the obsolete v3
  failure path verbatim.

## 7. Proposed step list for the real migration plan (007), if green-lit

Effort: **M** (smaller than the audit's "L" guess — the cascade made it look
bigger than it is). Files that actually change:

1. **`package.json`**: `zod` `^3.23.8` → `^4`; **remove** `zod-to-json-schema`.
   Re-`bun install`.
2. **`src/core/schema.ts`**: the §4 swap (native `z.toJSONSchema(s, { io: 'input' })`,
   `ZodType<T, unknown>`, drop `ZodTypeDef`) **plus** the §5 two-armed guard
   (try/catch the foreign-schema `TypeError`, reworded message).
3. **`src/state/state-store.ts`**: widen the `ZodError.issues[].path` handling
   to `PropertyKey[]` (map/`String()` the path segments, or relax
   `StateCorruptionError`'s accepted type). 3 type errors, one mechanical fix.
4. **`tests/unit/core/schema.test.ts`** + **`schema-validation.test.ts`**:
   update the `nullable` assertion and re-point the two guard-simulation tests
   at the inverted hazard.
5. Sanity-sweep the other 14 `from 'zod'` importers — typecheck showed they
   were *cascade-only*; confirm green after steps 1-3 (`z.enum`, `z.union`,
   `z.ZodType<RunMode>` in `config/index.ts` and `scripted-fake/types.ts` all
   typechecked fine under v4 once `schema.ts` was fixed).
6. **Docs + CHANGELOG**: rewrite any `zod@^3` host advice in `docs/public/`;
   CHANGELOG entry flagging the host-compat flip (v4 hosts now first-class, v3
   hosts now the mismatch case); update `docs/public/reference/*` if the public
   `z` re-export note mentions versions.
7. Full `bun run check`.

## Surprises (Step 5.7)

1. `zod-to-json-schema@3.25.2` advertises `^4` peer support but silently fails
   to convert a v4 schema at runtime — the peer range lies.
2. The audit's "L effort, many files" framing is misleading: 31 typecheck
   errors, but **only 2 source files** carry real breakage; 17 are pure cascade
   from one lost generic.
3. The migration *removes* a dependency (`zod-to-json-schema`) rather than
   swapping versions — a net simplification.
4. The biggest risk is **not** types — it is the silent inversion of the
   field-reported hazard (§5): the existing guard goes dead for the new
   mismatch case unless explicitly rebuilt. A message-only rewrite (what the
   plan's maintenance note anticipated) would ship a regression in error
   quality.
