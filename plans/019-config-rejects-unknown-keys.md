# Plan 019: Reject unknown/typo'd keys in `orch.config.ts`

> **Executor instructions**: Follow step by step; run every verification command.
> Stop and report on any STOP condition. Update the plan 019 row in
> `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 0265592..HEAD -- src/config/index.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `0265592`, 2026-07-02

## Why this matters

The config schema is not `.strict()`, so Zod silently drops unknown keys. A user who
typos `defalutMode`, `promps`, or `cmux: { enabld: false }` gets **no warning** and
silently wrong behavior: the typo'd `defaultMode` falls back to autodetect; the
typo'd `cmux.enabled` leaves the integration on. Since `defineConfig` only gives
compile-time typing when the user runs a typecheck, runtime is the real guardrail —
and today it's permissive. Rejecting unknown keys with a message that names the
offending path turns a silent misconfiguration into an actionable error.

## Current state

`src/config/index.ts`:

- The schema (`:75-80`) — no `.strict()` anywhere, including the nested `cmux`:
  ```ts
  const ConfigSchema = z.object({
    workflows: z.record(z.string().min(1), z.string().min(1)),
    defaultMode: RunModeSchema.optional(),
    prompts: PromptsSchema.optional(),
    cmux: z.object({ enabled: z.boolean().optional() }).optional(),
  })
  ```
- `PromptsSchema` (`:70-73`) — also a plain `z.object`.
- The error path (`:186-190`) already formats issue paths nicely:
  ```ts
  const result = ConfigSchema.safeParse(exported)
  if (!result.success) {
    const summary = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new ConfigLoadError(`Invalid config at ${configPath}: ${summary}`, configPath)
  }
  ```
- Tests: `tests/unit/config/load-config.test.ts`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `bun run typecheck` | exit 0 |
| Config tests | `bun test tests/unit/config/load-config.test.ts` | all pass |
| Whole-repo self-check | `bun test tests/unit/config tests/integration/cli` | all pass |
| Full gate | `bun run check` | exit 0 |

## Scope

**In scope:**
- `src/config/index.ts` — make `ConfigSchema` (and the nested `cmux` and
  `PromptsSchema` objects) reject unknown keys.
- `tests/unit/config/load-config.test.ts` — add typo/unknown-key cases.
- If any in-repo config legitimately carries an extra key (see STOP conditions),
  that is a signal to reconsider — do not blanket-add keys to the schema to make a
  bad config pass.

**Out of scope (do NOT touch):**
- The `OrchestratorConfig` TypeScript interface (`:11-33`) — it stays the source of
  truth; `.strict()` just enforces it at runtime.
- The example configs under `examples/` — unless a strict run flags one; if it does,
  see STOP conditions.

## Steps

### Step 1: Make the schemas strict

Add `.strict()` to `ConfigSchema`, to the inline `cmux` object, and to
`PromptsSchema`:

```ts
const PromptsSchema = z
  .object({
    include: z.array(z.string().min(1)),
    exclude: z.array(z.string().min(1)),
  })
  .strict()

const ConfigSchema = z
  .object({
    workflows: z.record(z.string().min(1), z.string().min(1)),
    defaultMode: RunModeSchema.optional(),
    prompts: PromptsSchema.optional(),
    cmux: z.object({ enabled: z.boolean().optional() }).strict().optional(),
  })
  .strict()
```

The existing error formatter at `:186-190` already surfaces the offending key path,
so an unknown key produces `Invalid config at <path>: <key>: Unrecognized key(s)…`.

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Verify no in-repo config breaks

Run the config + CLI test suites AND load the example configs:

**Verify**: `bun test tests/unit/config tests/integration/cli` → all pass. If a
test that loads a real/example config now fails on an unknown key, STOP — that key
is either (a) a legitimate option missing from `OrchestratorConfig` (report it — it
should be added to the interface AND schema deliberately, not silently) or (b) a
real typo in a fixture worth fixing. Do not add the key to the schema just to make
the test pass without understanding it.

### Step 3: Add regression tests

In `tests/unit/config/load-config.test.ts`, add cases (mirror the existing invalid-
config test that asserts `ConfigLoadError`):
- A config with a top-level typo (`defalutMode`) throws `ConfigLoadError` whose
  message contains the offending key.
- A config with `cmux: { enabld: false }` throws `ConfigLoadError`.
- A valid config with exactly the known keys still loads successfully (regression).

Full-sentence names, e.g.
`it('rejects an unknown top-level config key with the offending key in the message', ...)`.

**Verify**: `bun test tests/unit/config/load-config.test.ts` → all pass; then
`bun run check` → exit 0.

## Test plan

- 3 cases: top-level typo rejected, nested `cmux` typo rejected, valid config still
  loads.
- Pattern to copy: the existing invalid-config test in
  `tests/unit/config/load-config.test.ts`.
- Verification: `bun test tests/unit/config/load-config.test.ts` → all pass.

## Done criteria

ALL must hold:

- [ ] `ConfigSchema`, its `cmux` object, and `PromptsSchema` all call `.strict()`.
- [ ] An unknown/typo'd key throws `ConfigLoadError` naming the key (new tests pass).
- [ ] A valid config still loads (regression test passes).
- [ ] `bun test tests/unit/config tests/integration/cli` → all pass (no in-repo
      config broke).
- [ ] `bun run check` exits 0.
- [ ] Only in-scope files modified.
- [ ] `plans/README.md` row 019 updated.

## STOP conditions

Stop and report if:

- Making the schema strict breaks loading of an example or fixture config — report
  the key; it needs a deliberate decision (add to interface+schema, or fix the
  config), not a silent widening.
- The Zod version in use spells strict-object rejection differently (`.strict()`
  should exist on Zod v3, which this repo uses) — report and adapt.

## Maintenance notes

- Forward-compat: if a future need arises for extra keys (plugin config), prefer a
  typed, namespaced field over relaxing `.strict()`. A blanket `.passthrough()`
  would re-open exactly this silent-typo hole.
- Reviewer: confirm the error message names the offending path (the value of a
  strict rejection is the actionable key name).
