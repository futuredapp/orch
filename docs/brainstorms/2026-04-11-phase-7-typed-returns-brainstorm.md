---
date: 2026-04-11
status: ready-for-plan
topic: Phase 7 — Typed returns (`schema`) via Claude `--json-schema`
---

# Phase 7 — Typed returns brainstorm

## What we're building

The "typed handoffs between steps" feature from the original orch brainstorm. Concretely:

- A `schema(zodSchema)` wrapper in `src/core/schema.ts` that boxes a Zod schema into a `SchemaWrapper` orch can recognise.
- A `returns:` key on `step.define` that accepts a `SchemaWrapper`.
- `step.define` becomes generic over the wrapped Zod type so `await run(STEP)` returns `z.infer<typeof STEP.returns>` with zero caller-side annotations.
- `ClaudeRunner` gains structured-output support: converts the Zod schema to JSON Schema, appends `--json-schema '<inline>'` to argv, reads `structured_output` from the final `result` envelope, Zod-parses it, and hands back the validated value.
- `FakeRunner` gains `returns:` scripting support (inline value **and** `'path/to/fixture.json'` file path).
- The executor performs a capability check and throws at step start if a step declares `returns:` against a runner whose `supports.structuredOutput` is `false`.

The end-state DX target (from the original brainstorm, confirmed):

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

## Why this approach

**Full inference over explicit type params.** Typed handoffs is the killer feature; anything less than zero-ceremony inference defeats the point. The TS plumbing — making `step.define` generic over the Zod schema and threading the inferred type through `RunFn` — is a one-time cost paid in the core.

**`zod-to-json-schema` over hand-rolling or Zod 4 native.** One battle-tested dep, correct handling of unions/enums/refinements, decoupled from the Zod major version. Hand-rolling would need its own test matrix for dubious gain; Zod-4-native locks our public API to a specific Zod release.

**Throw on validation failure, don't route through validators.** A schema mismatch is a runner contract violation, not a post-exit assertion. It fails the step, produces a readable Zod-path error, and lets resume re-run the step from scratch — symmetric with any other runner error. Keeping it out of the validator loop also keeps `validate:` free for things the user wrote, not things the framework enforces.

**Schema lives on `RunnerContext`.** Parallels `prompt` and `extraArgs`: it's per-invocation data the executor threads into `buildCommand`. `extractStructuredOutput` gains a second `ctx` arg so runners can read the schema when validating the final envelope. Minimal contract growth; no per-step runner factories needed.

**Capability check at runtime, at step start.** A compile-time `Runner<SupportsSchema>` generic would infect every runner definition and every call site for a bug that fires once per misconfiguration. A fast runtime throw with a clear message (`Runner 'aider' does not support structured output; remove 'returns:' or pick a runner that does`) is the right cost/benefit.

**FakeRunner keeps inline AND adds file.** Inline stays for tiny one-line tests; file-based unlocks sharing one realistic JSON fixture across several tests and gives Zod a realistic payload to parse in mocked integration tests.

## Key decisions

1. **Schema lifecycle.** `schema(zodSchema)` produces a `SchemaWrapper` that carries (a) the Zod schema for parsing and (b) a memoised JSON Schema for the CLI flag. Conversion happens once at wrap time.
2. **Generic propagation.** `step.define<T>` infers `T` from the wrapped Zod schema; `StepConfig<T>` carries `returns?: SchemaWrapper<T>`; `run<T>(STEP): Promise<T>` with `T` defaulting to `unknown` when no schema is declared.
3. **Envelope parsing.** `ClaudeResultSuccess.structured_output` is already in the Zod schema for the envelope (`z.unknown().optional()`). `extractStructuredOutput(finalEvent, ctx)` reads it, Zod-parses against `ctx.schema`, throws a wrapped error on failure.
4. **Runner capability.** `ClaudeRunner.supports.structuredOutput` flips from `false` to `true`. `FakeRunner` declares `true`. The executor checks it in `run()` before spawning.
5. **Persisted value.** `StepEntry.value` stays `unknown` at the store level (no schema bump) and holds the **parsed** value. The original `structured_output` is reachable via the stored raw final envelope if we ever need to re-validate offline.
6. **FakeRunner scripting.** `.when().respondWith({ returns: { … } })` for inline and `.when().respondWith({ returns: 'tests/fixtures/foo.json' })` for file-based. File reads go through `FsService`, not raw Bun.
7. **Zod → JSON Schema conversion.** Add `zod-to-json-schema` as a runtime dep. Converter output is passed inline via `--json-schema <serialised>` in argv.

## Open questions

- **Argv size.** Very large schemas passed inline via `--json-schema '<json>'` will balloon argv. Leave as-is for Phase 7 (every schema we're imagining is small); revisit with a `--json-schema @file` fallback only if a real workflow hits the OS argv limit.
- **Memoization key.** Does changing `returns:` invalidate the cached step entry? Current plan: no — the step name is still the sole memoization key, and schema changes are handled by changing the step name (or clearing state). Explicit in the plan doc for Phase 7.
- **Raw envelope retention.** Do we need to store the raw final envelope alongside `value` for debugging? Probably not in Phase 7; defer until someone asks.
- **Unwrapping ergonomics.** `step.define` accepts either `returns: schema(z.object(...))` or `returns: z.object(...)` directly? Decision: **wrapper-only** in Phase 7 — it gives us a single branded type to pattern-match on in the executor, and keeps the door open for non-Zod schema backends later without overloading `returns`.

## Out of scope for Phase 7

- Codex structured output via `--output-schema` (Phase 9 ships the CodexRunner).
- `parallel()` with structured returns (Phase 8).
- Retries on schema validation failure (never — caller decides).
- Streaming partial structured output (not a feature Claude CLI exposes).
