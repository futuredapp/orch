---
date: 2026-05-28
status: active
topic: typed-prompt-vars
type: feat
origin: docs/brainstorms/2026-05-28-feat-typed-prompt-vars-requirements.md
---

# feat: Typed prompt vars (inferred from inline literals + sidecar codegen)

## Summary

Add a typed `vars` contract to `Step` and `RunOverrides` so a single step can be reused across multiple `run()` call sites with different inputs, with TypeScript catching missing/extra/wrong vars at every site. The contract is **inferred by default** — from `{{placeholder}}` tokens in inline `prompt:` string literals (via a vendored ~25-line template-literal-type extractor), or from generated `.d.ts` sidecars for `.md`/`.txt` prompt files (via a `PromptFileRegistry` module-augmentation pattern). Substitution moves from `step.define` time to `run()` time, vars participate in the step cache key, and the legacy `step.define({ promptFile, vars })` form (just shipped in [`docs/plans/2026-05-28-001-feat-file-based-prompts-plan.md`](2026-05-28-001-feat-file-based-prompts-plan.md)) becomes a definition-time error before v1. A new `orch types [--watch]` CLI command regenerates sidecars on save; `orch run` also runs the generator idempotently so cold clones work without setup. Each of the four moving parts — TLT extractor, generic threading, sidecar generator, watcher CLI — is structurally isolated so it can be tested independently.

(See origin: [docs/brainstorms/2026-05-28-feat-typed-prompt-vars-requirements.md](../brainstorms/2026-05-28-feat-typed-prompt-vars-requirements.md). Companion shipped plan: [docs/plans/2026-05-28-001-feat-file-based-prompts-plan.md](2026-05-28-001-feat-file-based-prompts-plan.md).)

---

## Problem Frame

Workflow authors who use `step.define({ promptFile, vars })` today bake `vars` into the prompt at module load — the rendered string is frozen into the `Step` config and the `vars` field is stripped before the executor ever sees it (see `src/core/step.ts:240-272`). That makes a step a one-shot artifact: two `run(BRAINSTORM, ...)` calls in the same workflow cannot vary the topic, because the topic was already substituted at definition time. Authors who want reusable steps fall back to either (a) factory functions that call `step.define` per call site, or (b) `loadPrompt()` composed with the `RunOverrides.prompt` escape hatch that bypasses the declared step entirely. Both work; neither is what reusable steps should feel like.

The cost is twofold. **Authoring friction**: writing a tiny factory just to vary one var nudges authors toward inlining one-off prompts as TypeScript strings — losing the file-based prompts win we just shipped. **Error surface**: today no one catches the case where the template says `{{tone}}` and the call site forgets to pass it until the substitution engine throws at workflow runtime, deep inside an agent step that has already started spending tokens.

A typed reusable step addresses both: define once, declare (or — better — infer) what it takes, and let TypeScript catch missing/extra/wrong-type args at every call site. The codegen layer extends the same contract across the `.md` → `.ts` boundary so adding a placeholder in a markdown file produces immediate type errors in every consumer, without forcing the author to re-type the same variable names in TypeScript.

---

## Requirements

R1–R23 carried verbatim from origin. Quick traceability map (full text in origin):

| R-ID | Topic | Owning unit(s) |
| --- | --- | --- |
| R1 | Inferred contract by default (inline TLT or sidecar lookup) | U4, U5 |
| R2 | Explicit `vars:` escape hatch on `RunOverrides` | U4 |
| R3 | Explicit-vs-inferred shape mismatch throws at module load | **Superseded by R23** — see note below |
| R4 | Vars vocabulary `'string' \| 'number' \| 'boolean'` + `?` optional | U3, U6 |
| R5 | `Step<TResult, TVars>` carries var shape downstream | U4 |
| R6 | `RunOverrides.vars` typed by step's contract | U4 |
| R7 | Missing/extra/wrong vars are compile-time errors | U4 |
| R8 | Runtime validator throws before runner starts | U2 |
| R9 | Vars participate in step cache key without `as:` | U1, U2 |
| R10 | `RunOverrides.prompt` continues to bypass vars validation | U2 |
| R11 | Sidecar emits `declare module 'orch' { interface PromptFileRegistry { ... } }` | U7 |
| R12 | `step.define({ promptFile: TPath })` resolves vars via `PromptFileRegistry[TPath]` | U5 |
| R13 | Sidecars co-located with `.md`/`.txt`; picked up by default TS `include` | U7 |
| R14 | `orch types --watch` regenerates on save | U8 |
| R15 | `orch run` runs idempotent generator pass at startup | U9 |
| R16 | Convention-based discovery, configurable via `orch.config.ts` | U7 |
| R17 | Single distribution channel — no bundler plugin, no LSP plugin, no postinstall | U8, U9 |
| R18 | Inline `prompt: '...{{x}}'` literal infers via TLT | U3, U4 |
| R19 | Extractor vendored (~25 lines), `expect-type`-tested | U3 |
| R20 | All three contract sources behave identically downstream | U4 (verified in U10) |
| R21 | Define-time + compile-time + runtime errors cohere | U2, U4, U5, U10 (wording locked in Key Decisions) |
| R22 | Migration recipe documented for factory-function patterns | U10 |
| R23 | Legacy `step.define({ promptFile, vars })` form forbidden before v1 | U2 |

Every R-ID is covered by at least one unit, with two carry-forward adjustments:

- **R3 is superseded by R23.** R3 in origin described "explicit `vars:` on `step.define` conflicting with the inferred contract throws at module load." Under the user's R23 decision (forbid `vars:` on `step.define` before v1), there is no explicit-vs-inferred conflict at module load — explicit `vars:` lives exclusively on `RunOverrides` (R2). The mismatch detection moves to runtime via `substitute()`'s strict both-directions check (U2). R3's intent — "tell the author when their declared shape doesn't match the template" — is preserved at runtime instead of define-time.
- **AE1 is superseded by R23 for the same reason.** AE1 in origin showed `step.define({ promptFile, vars: { topc: 'string' } })` (typo) triggering a define-time error naming both sources. Under R23 this call site is itself a define-time error (`cause: 'vars-on-define'`), so the typo never reaches inference. The replacement coverage is U2's R23 test: `step.define({ promptFile, vars: ... })` always throws with the migration recipe.

**Acceptance Examples AE2–AE8** from origin are mapped to specific test scenarios under each unit (prefixed `Covers AE<N>`). AE1 is replaced by the R23 test in U2.

---

## Key Technical Decisions

Decisions resolved during planning, user-confirmed via Phase 0 questions where noted.

- **R23 breaking change before v1.** *(User-decided.)* `vars:` on `step.define` becomes a definition-time error (`cause: 'vars-on-define'`). Migration target inside the repo is small: only `examples/file-prompts-demo/index.ts:56-61, 79-83` uses the form (two call sites). Affected tests: `tests/unit/core/prompt-file/step-define-prompt-file.test.ts` and `tests/integration/core/prompt-file-workflow.test.ts`. Migration is bundled into U2 (the same PR that introduces the substitution-timing shift) so the test gate is never red between units.
- **Sentinel `@/...` is the canonical `promptFile:` form for typed inference.** Workflow-local relative paths (`promptFile: 'slug.md'`) continue to work at runtime, but only `@/...` paths get static type inference in v1. Reason: workflow-local paths would require the sidecar to emit per-workflow-directory keys keyed by relative form, which collides between identically-named files in sibling workflows. The project-rooted form has a unique key and a clean lookup. Workflow-local keys can be added in a follow-up without breaking changes. Documented as the v1 trade-off in U10's guide.
- **Optional placeholder syntax: `{{x?}}`.** *(User-decided.)* Both regex (`PLACEHOLDER_RE` in `src/core/prompt-file/substitute.ts:13`) and TLT extractor handle the `?` suffix. Inferred shape: `{ [K in opt]?: string \| number \| boolean }`. Whitespace tolerant: `{{x?}}`, `{{ x? }}`, `{{ x ? }}` all parse identically. Runtime substitution of a missing optional placeholder emits an empty string (`''`) — chosen over `'undefined'` to avoid leaking JavaScript stringification quirks into prompts.
- **Watcher: `orch types --watch` + auto-regen at start of `orch run`.** *(User-decided.)* One-shot `orch types` runs the generator and exits; `--watch` keeps an `fs.watch` + 250 ms poll-backstop + 50 ms debounce loop alive following the pattern in `src/hosts/two-pane/steps-view/tail-state-json.ts`. Auto-regen inside `runCmd` (`src/cli/commands/run.ts:105`) lands sidecars before the workflow's `import` evaluates — note that the runtime `import` does NOT depend on `.d.ts` files (vars are validated at runtime); the sidecars exist for `tsc --noEmit` and IDE feedback on subsequent edits. AE7's "cold clone path is not blocked" is satisfied by R15's idempotent pass plus the runtime substitution guarantee.
- **Discovery defaults configurable via `orch.config.ts`.** *(User-decided.)* New `prompts: { include: string[]; exclude: string[] }` field with defaults `include: ['.orch/workflows/**/*.{md,txt}', '.orch/prompts/**/*.{md,txt}']`, `exclude: []`. Glob matching follows Bun's `Bun.Glob` (which orch already runs under). `.txt` is first-class alongside `.md` — orch does not enforce extension semantics on prompt files.
- **Vendored extractor; no dependency on `type-safe-prompt` / `ts-prompt`.** *(Origin-decided.)* External research confirmed: `type-safe-prompt` (5 stars, 2 contributors), `ts-prompt` (1 contributor, no commits since Sept 2024), `prompt-builder` (7 stars). All three repos converge on the same ~4-line conditional template literal type — peel `${string}{{${infer K}}}${string}` and accumulate `K` into a union. Vendoring is ~25 lines including the optional-marker extension; lower load-bearing dependency than relying on a single-author micro-package. Attribution preserved in code comments. Lives in `src/core/prompt-file/template-vars.ts`.
- **Cache-key fold via deterministic JSON hash.** When `overrides.as` is set, key = `stepName(overrides.as)` (caller's explicit choice wins; no implicit vars-hash). When `overrides.as` is unset and `overrides.vars` is non-empty, key = `stepName('${s.name}:vars=${shortHashHex(vars)}')`. The `:` separator is already legal mid-string in `STEP_NAME_PATTERN` (verified at `src/core/types.ts:36`); hex hash uses only `[a-f0-9]`. Empty/undefined vars → no key modification (back-compat for existing call sites). Hash function: SHA-256 of canonical JSON (keys sorted ASCII; numbers via `String()` to match substitution; optional/missing keys omitted; no whitespace) truncated to 16 hex chars (~64 bits of collision space, ample for a single workflow run). Locked in U1.
- **Substitution shifts from define-time to `assemblePrompt`.** `step.define({ promptFile })` still reads the file synchronously at module load (so missing-file errors stay at define-time per R5/R10 of origin file-based-prompts) but stores the **raw template** on `AgentStepConfig.prompt`. `assemblePrompt` (`src/core/workflow.ts:261-272`) calls `substitute(config.prompt, overrides.vars ?? {})` per `run()` invocation. The strict both-directions error fires here — R8 is satisfied (before runner starts). `RunOverrides.prompt` (full replacement, R10) short-circuits substitution entirely.
- **`Step<TResult = unknown, TVars extends PromptVars = Record<never, never>>` defaults.** The `Record<never, never>` default (rather than `{}`) lets callers distinguish "no vars required" from "any vars OK" — a `Step<T, Record<never, never>>` rejects extra keys in `run(STEP, { vars: { x: 'y' } })`. Origin's Synthesis section flags this; external research confirms it's the right default. All existing `Step<...>` literal call sites (12 in `src/`, 2 in `tests/`) default-handle via the second generic.
- **`PromptFileRegistry` is an empty `interface` declared in orch.** New file `src/core/prompt-file/registry.ts` declares the empty interface; generated sidecars augment it via `declare module 'orch' { interface PromptFileRegistry { ... } }`. Re-exported from both `src/core/index.ts` and `src/index.ts` so the augmentation resolves against the public `'orch'` module. No precedent for `declare module` augmentation in the repo (verified — the `ViewKindRegistry` comment at `src/core/view.ts:48` is aspirational, not real); this plan introduces the first one.
- **Standardized error wording (R21).** Locked in U2 (define-time) / U4 (compile-time, via TLT mismatch) / U2 (runtime, via `assemblePrompt`-time substitute). Pattern matches existing orch convention (`step.define("<name>"): <what> — <how to fix>`). Runtime wording:
  - Missing required: `step "<name>" run(): prompt template references {{topic}}, {{depth}} but no value supplied for those keys — add them to RunOverrides.vars`
  - Extra unknown: `step "<name>" run(): RunOverrides.vars supplies [extraKey] that the prompt template does not use — remove the unused key`
  - Unsupported type: `step "<name>" run(): RunOverrides.vars.<key> has type "array" — only string|number|boolean are allowed`
  - Define-time R23: `step.define("<name>"): "vars" is no longer allowed on define — move vars to run(STEP, { vars: ... }) for typed per-call injection. See docs/public/guides/typed-prompt-vars.md for migration recipe.`
- **No new dev dependency.** Existing `tests/helpers/type-assertions.ts` (`Expect<Equal<X, Y>>` pattern, 12 lines) covers all `.test-d.ts` cases. `tsd` / `expect-type` rejected as load-bearing dev dep — the homegrown helper is already in use at `tests/unit/core/ask-types.test-d.ts` and is sufficient for the TLT correctness tests. `tsc --noEmit` (existing `bun run check` gate) catches every type-level assertion failure.
- **File-watcher pattern lifted from `tail-state-json.ts` inline; no shared helper extracted (yet).** `src/hosts/two-pane/steps-view/tail-state-json.ts` is the established precedent — hybrid `fs.watch` + 250 ms poll backstop + 50 ms trailing debounce + 200 ms max-wait. U8 reproduces the pattern inline rather than lifting it into `src/services/fs/file-watcher.ts` — extraction is a YAGNI candidate until a third consumer appears.

---

## High-Level Technical Design

This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.

### Type-flow shape (compile-time)

```text
  Inline prompt literal             promptFile sidecar (codegen)
  ─────────────────────             ────────────────────────────
  prompt: 'Hi {{name?}}'            promptFile: '@/prompts/x.md'
       │                                    │
       ▼                                    ▼
  ExtractVars<T> (TLT)              PromptFileRegistry[T] lookup
       │                                    │
       └─────────────┬──────────────────────┘
                     ▼
              TVars contract
                     │
                     ▼
        Step<TResult, TVars>
                     │
                     ▼
        run(STEP, { vars: TVars })   ← TS enforces shape here
```

### Runtime pipeline (per `run()` call)

```text
   run(STEP, { vars }) ──► runStepOnce ──► assemblePrompt ──► substitute ──► agent
                                │              │                  │
                                │              │                  └─ throws PromptFileError
                                │              │                     if missing / extra / wrong type
                                │              │
                                │              └─ reads config.prompt (raw template), vars from overrides
                                │
                                └─ cache-key = stepName(name) OR stepName(name:vars=<hexhash>)
                                                                     │
                                                                     └─ from U1's stableHashHex(vars)
```

Key invariant: at runtime, the executor sees a single substituted string — the same path as today — but the substitution moment moved from `step.define` to `assemblePrompt`. Runners are untouched. State store is untouched.

### Codegen pipeline (build-time, decoupled)

```text
  .orch/workflows/foo/slug.md ─┐
  .orch/prompts/preamble.md   ─┤
  (resolved from              ─┤    orch types[--watch]    ┌── slug.md.d.ts
   orch.config.ts             ─┤────────────────────────►  ├── preamble.md.d.ts
   .prompts.{include,exclude}) ┘                            └── (one .d.ts per source file)

  each .d.ts emits:
    declare module 'orch' {
      interface PromptFileRegistry {
        '@/.orch/workflows/foo/slug.md': { userPrompt: string; tone?: string }
      }
    }
    export {}
```

---

## Output Structure

New files this plan introduces. Per-unit `**Files:**` sections are authoritative.

```text
src/core/prompt-file/
├── template-vars.ts            — vendored TLT extractor (~25 lines, U3)
├── registry.ts                  — empty PromptFileRegistry interface (U5)
├── cache-key.ts                 — stable hash of PromptVars for cache keys (U1)
└── (existing files modified: substitute.ts, load-prompt.ts, prompt-file-reader.ts,
       resolve-prompt-path.ts, caller-dir.ts, errors.ts, index.ts)

src/codegen/                     — new module, isolated subsystem (U7)
├── index.ts                     — barrel: runCodegen(), CodegenResult types
├── discover-prompts.ts          — glob expansion against config.prompts
├── extract-placeholders.ts      — runtime parity of the TLT extractor
├── emit-sidecar.ts              — renders one .d.ts per source file (idempotent via mtime)
└── codegen-result.ts            — { written, skipped, errors }

src/cli/commands/
└── types.ts                     — `orch types [--watch]` (U8)

tests/unit/core/prompt-file/
├── template-vars.test-d.ts      — type-level Expect<Equal<...>> for extractor (U3)
├── cache-key.test.ts            — stable hash properties (U1)
└── (existing files modified or added: substitute.test.ts, load-prompt.test.ts,
       step-define-prompt-file.test.ts — rewritten under U2's substitution shift)

tests/unit/codegen/              — new test directory (U7, U8)
├── extract-placeholders.test.ts
├── emit-sidecar.test.ts
├── discover-prompts.test.ts
└── run-codegen.test.ts

tests/unit/cli/
└── types-command.test.ts        — orch types one-shot and --watch (U8)

tests/unit/core/
└── step-runfn-typed-vars.test-d.ts — Step<T,V> + RunFn overload type tests (U4, U5, U6)

tests/integration/core/
└── typed-vars-workflow.test.ts  — end-to-end: workflow loads, run() with vars, cache splits by vars (U10)

tests/integration/codegen/
└── codegen-fixture.test.ts      — fixture project layout, sidecar emission, augmentation flows (U7)

tests/fixtures/typed-vars/       — fixture workflows used by integration tests (U10)
├── reusable-step-workflow/
│   ├── orch.config.ts
│   ├── workflows/reuse.ts
│   └── .orch/prompts/brainstorm.md
└── cold-clone-fixture/          — used by U9 to prove R15
    └── (similar layout, no pre-generated sidecars)

docs/public/guides/
└── typed-prompt-vars.md         — new how-to guide (sidebar entry, U10)
```

Modified files (touched, not created):

```text
src/config/index.ts              — add prompts: { include, exclude } field + Zod schema (U7)
src/core/step.ts                 — Step<T,V>, defineStep generics, R23 break, template-not-substituted (U2, U4)
src/core/workflow.ts             — RunOverrides.vars, RunFn overloads, assemblePrompt does substitution, cache-key (U2, U4)
src/core/prompt-file/substitute.ts        — optional {{x?}} support (U6)
src/core/prompt-file/index.ts             — re-export PromptFileRegistry, ExtractVars, VarsOf (U3, U5)
src/core/index.ts                — re-export new types (U3, U5)
src/cli/main.ts                  — register `types` command, --watch flag (U8)
src/cli/commands/run.ts          — auto-regen pre-step at startup (U9)
examples/file-prompts-demo/index.ts       — migrate to run-time vars (U2)
.claude/skills/orch-workflow-author/SKILL.md          (U10)
.claude/skills/orch-workflow-author/references/api.md (U10)
.claude/skills/orch-workflow-author/references/prompt-patterns.md (U10)
.claude/skills/orch-workflow-author/references/templates.md       (U10)
docs/public/reference/api.md     — Step<T,V>, RunOverrides.vars, PromptFileRegistry (U10)
docs/public/guide/4-writing-a-workflow.md — link to new guide (U10)
docs/public/examples.md          — reference new example workflow (U10)
docs/public/.vitepress/config.mts — sidebar entry (U10)
tests/unit/barrel.test.ts        — extend public-surface snapshot (U3, U5)
tests/unit/core/schema.test.ts   — verify Step<T> literals still type-check with default TVars (U4)
```

---

## Implementation Units

The ten units are grouped into three phases. Each phase is independently shippable and corresponds to one PR; dependencies do not cross backwards across phase boundaries.

- **Phase 1 — Runtime mechanics (U1, U2):** move substitution to run-time and fold vars into the cache key. After this phase, workflows can reuse a step with different `vars` at runtime; types are still widened to `PromptVars`.
- **Phase 2 — Static typing (U3, U4, U5, U6):** thread `TVars` through `Step`/`RunFn`, infer it from inline literals, expose the empty `PromptFileRegistry`, and add the `{{x?}}` optional syntax. Purely additive TypeScript over Phase 1's runtime.
- **Phase 3 — Codegen, CLI, docs (U7, U8, U9, U10):** sidecar generator + `orch types [--watch]` + `orch run` pre-pass + docs/skill sweep + end-to-end integration test. Closes the loop on `promptFile` typing automation.

### Phase 1 — Runtime mechanics

#### U1. Stable vars-hash for cache-key derivation

**Goal:** A pure, well-tested function `stableHashHex(vars: PromptVars): string` that produces a deterministic 16-char hex digest of any `PromptVars` object, ignoring key insertion order and handling number/boolean stringification consistently with `String()` substitution.

**Requirements:** R9 (vars participate in cache key).

**Dependencies:** none.

**Files:**

- `src/core/prompt-file/cache-key.ts` (new) — `stableHashHex(vars: PromptVars): string` plus `canonicalJson(vars: PromptVars): string` (exported for testability).
- `tests/unit/core/prompt-file/cache-key.test.ts` (new).

**Approach:**

- `canonicalJson(vars)`:
  - `Object.keys(vars).sort()` (ASCII-sorted).
  - For each key, emit `"<key>":<value>` where value is `JSON.stringify(value)` for strings, `String(value)` for numbers and booleans (matches what `substitute` will inject). Use canonical decimal for numbers (so `42` and `42.0` collide — intentional, they substitute identically).
  - Concatenate with `,` and wrap in `{...}`. No whitespace.
  - Keys with `undefined` values are omitted (optional vars that are unset).
- `stableHashHex(vars)`:
  - If `Object.keys(vars).length === 0`, return `''` (empty hash signals "no vars participation in key" — caller short-circuits).
  - Else: `createHash('sha256').update(canonicalJson(vars)).digest('hex').slice(0, 16)`.
  - Uses `node:crypto`'s `createHash` (already in use in `src/core/workflow.ts:1` for `randomUUID`).

**Patterns to follow:**

- `src/core/workflow.ts:1` for `node:crypto` import shape.
- The brand-and-validate pattern in `src/services/types.ts` `path()` for runtime parameter validation.

**Execution note:** Test-first. Edge cases (NaN, Infinity, very long strings, key-ordering invariance) are the high-value scenarios; a typo in `canonicalJson` silently spoils every cache key.

**Test scenarios:**

- `stableHashHex({})` returns `''` (sentinel for "no vars in key").
- `stableHashHex({ topic: 'A' })` returns a stable 16-char hex string. Snapshot the value so future regressions surface.
- `stableHashHex({ topic: 'A' })` and `stableHashHex({ topic: 'A' })` produce identical output across two calls.
- `stableHashHex({ a: 1, b: 2 })` and `stableHashHex({ b: 2, a: 1 })` produce identical output (key-order invariance). **Covers AE3.**
- `stableHashHex({ topic: 'A' })` and `stableHashHex({ topic: 'B' })` produce **distinct** outputs.
- `stableHashHex({ n: 42 })` and `stableHashHex({ n: 42.0 })` produce identical outputs (same canonical decimal).
- `stableHashHex({ flag: true })` and `stableHashHex({ flag: 'true' })` produce **distinct** outputs (booleans and string-truthy not equivalent; the substituter outputs the same string but the type information differs and we want cache to reflect that).
- `stableHashHex({ x: 'hello "world"' })` correctly escapes the embedded quote (JSON.stringify behavior).
- `stableHashHex({ x: Number.NaN })` does NOT crash and produces a stable value (NaN canonicalizes to the literal string `NaN`; document this in a code comment as the deliberate choice — workflows passing NaN are buggy anyway, but the hash function must not throw).
- `canonicalJson({ a: 1, b: undefined as unknown as string })` omits `b` (optional-var omission semantics; coerced through `unknown as string` because TypeScript would normally reject `undefined`).
- Output uses only characters in `[0-9a-f]` for any input (verified by regex assertion across a random fuzz of 100 input vars). Critical: the hex must fit `STEP_NAME_PATTERN` (`/^[a-z0-9][a-z0-9:-]*$/`) when concatenated as `name:vars=<hex>`.

#### U2. Run-time substitution + `RunOverrides.vars` + cache-key fold + R23 break + example migration

**Goal:** Move substitution from `step.define` time to `assemblePrompt`; add `vars?: PromptVars` to `RunOverrides`; fold `stableHashHex(vars)` into the cache key when `overrides.as` is absent; forbid `vars:` on `step.define` with a clear migration error; migrate `examples/file-prompts-demo/index.ts` and rewrite affected tests so the `bun run check` gate stays green inside the PR.

**Requirements:** R2, R6, R8, R9, R10, R23.

**Dependencies:** U1.

**Files:**

- `src/core/step.ts` — modify `assertPromptFieldsValid` to throw on `config.vars !== undefined` regardless of `promptFile` presence (R23 break); modify `resolvePromptFile` to read the file content but NOT substitute — store the raw template on `AgentStepConfig.prompt`; drop the `vars` field from the resulting config.
- `src/core/workflow.ts` — add `vars?: PromptVars` to `RunOverrides` (untyped for now; U4 makes it generic); modify `assemblePrompt(defaultPrompt, overrides)` to call `substitute(defaultPrompt, overrides.vars ?? {})` when `defaultPrompt` contains `{{...}}` tokens (or always — see decision); modify `runStepOnce` cache-key derivation at `src/core/workflow.ts:1100` to fold in `stableHashHex(overrides.vars ?? {})` when `overrides.as` is undefined and the hash is non-empty.
- `src/core/prompt-file/errors.ts` — add `'vars-on-define'` to `PromptFileErrorCause` union.
- `examples/file-prompts-demo/index.ts` — migrate two call sites (slug step and summarize step) from `step.define({ promptFile, vars })` to `step.define({ promptFile })` + `run(STEP, { vars: ... })`.
- `tests/unit/core/prompt-file/step-define-prompt-file.test.ts` — rewrite: the substitution-at-define assertions become substitution-at-run assertions; add a new R23 test that asserts `step.define({ promptFile, vars: ... })` throws with `cause: 'vars-on-define'`.
- `tests/unit/core/prompt-file/substitute.test.ts` — keep verbatim (this unit doesn't change `substitute()` semantics, only its call site; U6 changes the regex).
- `tests/integration/core/prompt-file-workflow.test.ts` — rewrite end-to-end assertions: workflow loads (define-time succeeds even with `{{slug}}` unresolved), `run(STEP, { vars })` substitutes and the FakeRunner observes the substituted prompt.
- `tests/unit/core/workflow.test.ts` (or wherever cache-key behavior lives — likely a new sibling test file) — assert cache-key derivation:
  - Two `run(STEP)` calls with identical (empty) vars produce identical keys (back-compat).
  - Two `run(STEP, { vars: { topic: 'A' } })` and `run(STEP, { vars: { topic: 'B' } })` produce distinct keys.
  - `run(STEP, { as: 'custom-name', vars: { topic: 'A' } })` uses `'custom-name'` verbatim (caller's `as:` wins; no vars-hash appended).
- `tests/unit/core/prompt-file/cache-key.test.ts` — already covered in U1.

**Approach:**

- **Substitution timing shift.** Today `resolvePromptFile` (`src/core/step.ts:240-272`) reads the file AND substitutes. Change it to read the file AND store the unsubstituted template in `AgentStepConfig.prompt`. The `promptFile` (resolved `Path`) stays on the config for observability and future reload-aware diagnostics. `assertPromptVars(config.vars ?? {})` is removed from `resolvePromptFile` (vars are no longer stored or accepted at define-time).
- **R23 break.** `assertPromptFieldsValid` now throws when `config.vars !== undefined`, regardless of whether `promptFile` is set. New `cause: 'vars-on-define'` carries the migration message verbatim from Key Technical Decisions above.
- **`assemblePrompt` substitution.** Single funnel — the prompt-file substitution moves here. Pseudo-shape (directional, not implementation):

  ```text
  assemblePrompt(defaultPrompt, overrides):
    base = overrides.prompt ?? defaultPrompt ?? ''
    if (overrides.prompt is set):
      // R10: full replacement bypasses vars validation
      substituted = base
    else if (defaultPrompt has {{...}} tokens OR overrides.vars is non-empty):
      substituted = substitute(base, overrides.vars ?? {}, { stepName: key, ... })
    else:
      substituted = base
    ... extraContext + extraPrompt concatenation as today ...
  ```

  The "defaultPrompt has tokens OR vars non-empty" guard preserves back-compat for steps that have no template AND no vars — strict-both-directions would otherwise throw on a non-template step. Edge case test: a step with `prompt: 'static text, no vars'` and a call site that passes `{ vars: { x: 'y' } }` SHOULD throw extra-key (the user clearly meant something).
- **Cache-key fold.** At `src/core/workflow.ts:1100`:

  ```text
  baseName = overrides?.as ?? s.name
  varsHash = stableHashHex(overrides?.vars ?? {})    // U1
  key = stepName(varsHash === '' ? baseName : `${baseName}:vars=${varsHash}`)
  ```

  `STEP_NAME_PATTERN` (`src/core/types.ts:36`) accepts `:` mid-string and hex chars; verified.
- **`assemblePrompt` signature.** Today: `assemblePrompt(defaultPrompt: string | undefined, overrides: RunOverrides | undefined): string`. New: same signature plus the substitution behavior. The caller already passes `config.prompt` (raw template under the new design) — no shape change at the call site.
- **Example migration shape** (`examples/file-prompts-demo/index.ts`):

  Before (current `slug` step, lines 56-61):
  ```text
  const slugStep = step.define('slug', {
    agent: claude({ model: HAIKU_MODEL, bare: false }),
    promptFile: 'slug.md',
    vars: { userPrompt },        ← moves to run()
    returns: schema(SLUG_SCHEMA),
  })
  const { slug } = await run(slugStep)
  ```

  After:
  ```text
  const slugStep = step.define('slug', {
    agent: claude({ model: HAIKU_MODEL, bare: false }),
    promptFile: 'slug.md',
    returns: schema(SLUG_SCHEMA),
  })
  const { slug } = await run(slugStep, { vars: { userPrompt } })
  ```

  Same migration for the `summarize` step. The `research` step does NOT need migration (it uses `loadPrompt` composition, not `step.define`-time vars).

**Patterns to follow:**

- `src/core/step.ts:215-232` (`assertPromptFieldsValid`) — same shape, new branch.
- `src/core/prompt-file/errors.ts` for adding a new cause to the discriminated union.
- `src/core/workflow.ts:261-272` (`assemblePrompt`) — single funnel; the substitution call slots in naturally before `extraContext` join.

**Execution note:** This unit is the load-bearing functional change. Write the new tests FIRST (red), then make them green. The example migration is a separate commit at the end of the unit so the migration is reviewable in isolation from the core change. The PR cannot land green without the example migration — the existing `bun run check` gate runs the example fixture.

**Test scenarios:**

- `step.define('foo', { agent, promptFile: 'foo.md' })` returns a `Step` whose `config.prompt` equals the raw file content (NOT substituted). **Foundation for AE2, AE4, AE5.**
- `step.define('foo', { agent, promptFile: 'foo.md', vars: { x: 'y' } })` throws `PromptFileError({ cause: 'vars-on-define' })` whose message names the step AND includes "move vars to run(STEP, { vars: ... })". **Covers R23.**
- `step.define('foo', { agent, prompt: 'inline', promptFile: 'foo.md' })` still throws `cause: 'mutex'` (existing behavior preserved).
- `assemblePrompt('Hi {{name}}', { vars: { name: 'world' } })` returns `'Hi world'`.
- `assemblePrompt('Hi {{name}}', { vars: {} })` throws `PromptFileError({ cause: 'missing-placeholder' })` whose message names `name`. **Covers AE2 (runtime portion).**
- `assemblePrompt('Hi {{name}}', { vars: { name: 'x', extra: 'y' } })` throws `cause: 'extra-key'` naming `extra`.
- `assemblePrompt('static, no vars', { vars: {} })` returns `'static, no vars'` (no-vars + no-tokens passes through).
- `assemblePrompt('static, no vars', { vars: { x: 'y' } })` throws `cause: 'extra-key'` (caller passed vars to a static step).
- `assemblePrompt('Hi {{name}}', { prompt: 'totally different', vars: { name: 'world' } })` returns `'totally different'` (R10: overrides.prompt bypasses substitution; vars are ignored, no error).
- `assemblePrompt('Hi {{name}}', { vars: { name: 'world' }, extraPrompt: 'PS: be brief' })` returns `'Hi world\n\nPS: be brief'`.
- `run(STEP, { vars: { topic: 'A' } })` and `run(STEP, { vars: { topic: 'B' } })` resolve to distinct cache entries in `state.steps` within the same workflow run. **Covers AE3.**
- `run(STEP, { vars: { topic: 'A' } })` and a second `run(STEP, { vars: { topic: 'A' } })` (same vars) inside the same workflow run produce a cache hit on the second call.
- `run(STEP, { as: 'override-name', vars: { topic: 'A' } })` produces cache key `'override-name'` (no hash appended; caller's `as:` wins per Key Decisions).
- `run(STEP, { vars: { topic: 'A' } })` with empty `STEP_NAME_PATTERN`-incompatible char in step name throws today's clear error (no regression).
- **Migrated example:** `examples/file-prompts-demo/index.ts` loads (module-import succeeds) and running the workflow with a synthetic prompt produces the substituted file content in the FakeRunner's prompt capture for the slug step. **Covers AE1 (integration scope).**

### Phase 2 — Static typing

#### U3. Vendored TLT extractor for inline `prompt:` literals

**Goal:** A pure type-level module that extracts the var contract from a string literal type via conditional template literal types. Required-keys via `{{x}}`, optional-keys via `{{x?}}`. Whitespace-tolerant inside braces. Survives reordering. ~25 lines of TypeScript, fully covered by `.test-d.ts` `Expect<Equal<...>>` assertions.

**Requirements:** R1, R18, R19.

**Dependencies:** none (pure type module, isolated from runtime).

**Files:**

- `src/core/prompt-file/template-vars.ts` (new) — exports `ExtractRequiredVars<T>`, `ExtractOptionalVars<T>`, `VarsOf<T>`. Attribution comment cites `d-kimuson/type-safe-prompt` and `SchoolAI/ts-prompt` (the verbatim extractor from both repos is ~4 lines; the optional-marker extension and `VarsOf` composition are new).
- `tests/unit/core/prompt-file/template-vars.test-d.ts` (new) — `Expect<Equal<...>>` cases.
- `src/core/prompt-file/index.ts` — re-export `ExtractRequiredVars`, `ExtractOptionalVars`, `VarsOf`.
- `src/core/index.ts` — re-export `VarsOf` (the public-facing composition type).
- `tests/unit/barrel.test.ts` — extend the public-surface snapshot to include `VarsOf`.

**Approach:**

Directional sketch (illustrative, not implementation specification):

```text
// Extracts a union of required keys: 'Hi {{name}}' → 'name'
type ExtractRequiredVars<T extends string> =
  T extends `${string}{{${infer K}}}${infer Rest}`
    ? K extends `${string}?` ? ExtractRequiredVars<Rest>            // skip optionals
                              : Trim<K> | ExtractRequiredVars<Rest>
    : never

// Extracts a union of optional keys (those marked {{x?}})
type ExtractOptionalVars<T extends string> = ...

// Composes the final shape
type VarsOf<T extends string> =
  ([ExtractRequiredVars<T>] extends [never] ? {} : { [K in ExtractRequiredVars<T>]: string | number | boolean }) &
  ([ExtractOptionalVars<T>] extends [never] ? {} : { [K in ExtractOptionalVars<T>]?: string | number | boolean })
```

- Use the `[T] extends [never]` pattern to distinguish "no required vars" from "any vars" — matches the `Record<never, never>` default in `Step<T, V>`.
- `Trim<S>` strips leading/trailing whitespace inside `{{ x }}` so type and runtime agree about the placeholder name. External research surfaced this as a footgun in both reference libraries — orch must NOT inherit it.
- The runtime regex in `substitute.ts` already trims via `\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*`; the type-level `Trim<K>` keeps the contract parity.
- Document the TypeScript recursion-depth limit (~100 placeholders per prompt) in a code comment; orch prompts fit easily within this bound. Long-prompt regression test asserts a 50-placeholder prompt still type-checks.

**Patterns to follow:**

- `tests/unit/core/ask-types.test-d.ts` — `Expect<Equal<...>>` test shape.
- `tests/helpers/type-assertions.ts` — existing `Expect`/`Equal` helpers; no new dep.

**Execution note:** Test-first; the test file IS the spec. Each `Expect<Equal<X, Y>>` is one row of behavior.

**Test scenarios:**

- `ExtractRequiredVars<'Hi {{name}}'>` → `'name'`. **Covers AE4.**
- `ExtractRequiredVars<'Hi {{name}} {{name}}'>` → `'name'` (union dedupe).
- `ExtractRequiredVars<'Hi {{a}} {{b}} {{c}}'>` → `'a' | 'b' | 'c'`.
- `ExtractRequiredVars<'plain text, no vars'>` → `never`.
- `ExtractRequiredVars<'Hi {{ name }}'>` → `'name'` (whitespace tolerance).
- `ExtractRequiredVars<'Hi {{name?}}'>` → `never` (optional excluded from required).
- `ExtractOptionalVars<'Hi {{name?}}'>` → `'name'`.
- `ExtractOptionalVars<'Hi {{ name? }}'>` → `'name'`.
- `ExtractOptionalVars<'Hi {{a}} {{b?}}'>` → `'b'`.
- `VarsOf<'Hi {{name}}'>` → `{ name: string \| number \| boolean }`.
- `VarsOf<'Hi {{name?}}'>` → `{ name?: string \| number \| boolean }`.
- `VarsOf<'Hi {{a}} {{b?}}'>` → `{ a: string \| number \| boolean; b?: string \| number \| boolean }`.
- `VarsOf<'plain'>` → `Record<never, never>` (the "no vars required" sentinel that matches the `Step<T, V>` default).
- `VarsOf<'plain'>` and `Step<unknown>` (default-handled `TVars`) compose so `run(STEP, { vars: { extra: 'y' } })` is a type error (extra-key rejection on a no-vars step).
- Multi-line prompt with placeholders across line breaks extracts correctly.
- Prompt containing `${greeting}` (literal `$` syntax) is not extracted (R8: only `{{...}}` is template syntax).
- Prompt with 50 placeholders type-checks without hitting recursion limits.
- `VarsOf` is re-exported from `'orch'` (barrel-test assertion).

#### U4. `Step<TResult, TVars>` generic + typed `RunFn` overrides + inline-literal inference

**Goal:** Thread `TVars` through `Step`, both `step.define` overloads, `RunFn`, and `RunOverrides`. When `prompt:` is an inline literal (typically `as const`), `TVars` is inferred via U3's `VarsOf<T>`. Existing call sites that omit a second generic continue to compile via the `Record<never, never>` default. Compile-time errors fire at every `run()` call site that supplies a wrong, missing, or extra var.

**Requirements:** R1, R2, R5, R6, R7, R18, R20.

**Dependencies:** U3 (the inference machinery).

**Files:**

- `src/core/step.ts` — add `TVars extends PromptVars = Record<never, never>` second generic to `Step`, `InteractiveStepInput`, `AutonomousStepInput`, `StepFactory.define` overloads, `defineStep`. For inline `prompt:` paths use `<const T extends string>` to infer `VarsOf<T>`; for `promptFile:` paths use `PromptFileRegistry[TPath]` lookup (deferred to U5; this unit ships the generic threading + inline path only and leaves `promptFile` `TVars` as `Record<string, string|number|boolean>` for now).
- `src/core/workflow.ts` — add `TVars` to `RunFn` overloads; `RunOverrides<V>` becomes generic over the var contract; the second overload makes `vars` required when `V` has required keys and optional when `V` has only optional or no keys. The `const run: RunFn = ...` body uses the conditional shape so the public type is enforced even though the implementation passes through unchanged.
- `src/core/index.ts` — export the updated types unchanged in name; barrel test verifies the snapshot still includes `Step`, `RunFn`, `RunOverrides`, `AgentStepConfig`.
- `tests/unit/core/step-runfn-typed-vars.test-d.ts` (new) — comprehensive `Expect<Equal<...>>` and `@ts-expect-error` cases.
- `tests/unit/core/schema.test.ts` — verify the existing `Step<{a:string}>` / `Step<unknown>` / `Step<string>` literals still type-check (default `TVars` handles).

**Approach:**

Directional sketch:

```text
interface Step<TResult = unknown, TVars extends PromptVars = Record<never, never>> {
  readonly name: StepName
  readonly config: StepConfig<TResult>
  // TVars exists purely at the type level — not stored at runtime
}

interface StepFactory {
  // Inline-literal path: const T preserves literal, TVars inferred via VarsOf
  define<const T extends string>(
    name: string,
    config: InteractiveStepInput & { prompt: T }
  ): Step<InteractiveResult, VarsOf<T>>
  define<TResult, const T extends string>(
    name: string,
    config: AutonomousStepInput<TResult> & { prompt: T }
  ): Step<TResult, VarsOf<T>>
  // promptFile path (U5 will tighten this): falls back to widened PromptVars
  define<TResult = unknown>(
    name: string,
    config: AutonomousStepInput<TResult>
  ): Step<TResult>
}
```

- `RunFn` overload shape (directional):
  ```text
  <T, V>(step: Step<T, V>, overrides: RunOverrides<V> & { mode: 'interactive' }): Promise<InteractiveResult>
  <T, V>(step: Step<T, V>, overrides?: RunOverrides<V>): Promise<T>
  ```
  Required-vs-optional `vars` falls out of `RunOverrides<V>` where `vars` is `V` (TypeScript treats `vars: V` as required if `V` has required keys).
- The `const T extends string` on `define` is the TypeScript 5.0+ const modifier that preserves the literal type WITHOUT requiring authors to write `as const`. Verified compatible with the project's `tsconfig.json` (Bun ships TS 5+).
- **`Step<T>` (single-generic) literals**: 12 sites in `src/`, 2 in `tests/` (enumerated from research section C). All default-handle via `TVars = Record<never, never>`. The `tests/unit/core/schema.test.ts` cases (lines 170, 173, 179) check `Step<{a:string}>` / `Step<unknown>` / `Step<string>` — confirm via the existing `Expect<Equal<...>>` rows that these now produce `Step<X, Record<never, never>>` and the equality still holds (TypeScript treats omitted defaults as the default value in equality checks).

**Patterns to follow:**

- `src/core/ask.ts:107-109` — existing `<const B extends string>` const-generic precedent.
- `src/core/workflow.ts:235-241` — existing `RunFn` overload pattern.

**Execution note:** Compile-only; no runtime change in this unit (U2 already moved substitution to run-time). The win is the type-checker now refuses bad call sites.

**Test scenarios:**

- `Step<TResult>` literal (no second generic) still compiles where it compiled before. **Covers R20.**
- `Step<{ slug: string }>` in `tests/unit/core/schema.test.ts` still matches the test's `Expect<Equal<...>>` assertion after the `TVars` default lands.
- `step.define('greet', { agent, prompt: 'Hi {{name}}' as const })` produces a `Step<unknown, { name: string | number | boolean }>`. `run(greet, { vars: { name: 'world' } })` typechecks. `run(greet, {})` is a `@ts-expect-error` (missing required key). **Covers AE4.**
- **No-`as const` inference (load-bearing for author ergonomics):** `step.define('greet', { agent, prompt: 'Hi {{name}}' })` (NO `as const` at the call site) produces the same `Step<unknown, { name: string | number | boolean }>`. This is the critical scenario — authors will overwhelmingly write the bare literal, relying on `<const T extends string>` on `define` to preserve the literal type. A failing assertion here means the const modifier isn't wired correctly and every "inline literal" promise in the requirements collapses to `string` → `Record<never, never>` and skips type-checking silently. Pair with a `@ts-expect-error` on the missing-key call to prove the inference actually flows.
- `step.define('greet', { agent, prompt: 'Hi {{name}}' as const })` then `run(greet, { vars: { name: 'world', extra: 'oops' } })` is a `@ts-expect-error` (extra key).
- `step.define('greet', { agent, prompt: 'Hi {{name?}}' as const })` produces a `Step<unknown, { name?: string | number | boolean }>`. `run(greet)` typechecks (vars optional). `run(greet, { vars: { name: 'world' } })` typechecks.
- `step.define('greet', { agent, prompt: 'static' as const })` produces a `Step<unknown, Record<never, never>>`. `run(greet)` typechecks. `run(greet, { vars: { x: 'y' } })` is a `@ts-expect-error` (extra-key on no-vars step).
- `step.define('foo', { agent, prompt: 'Hi {{name}}' as const, returns: schema(z.object({ slug: z.string() })) })` produces `Step<{ slug: string }, { name: ... }>`. `run(foo, { vars: { name: 'x' } })` returns `Promise<{ slug: string }>`.
- `step.define('foo', { agent, mode: 'interactive', prompt: 'Hi {{name}}' as const })` produces `Step<InteractiveResult, { name: ... }>`. `run(foo, { vars: { name: 'x' }, mode: 'interactive' })` returns `Promise<InteractiveResult>`.
- `RunOverrides<V>` accepts `prompt: string` to bypass substitution AND no longer enforces `vars` (R10): `run(STEP_WITH_VARS, { prompt: 'replacement', vars: { name: 'x' } })` typechecks but `vars` is silently ignored at runtime (a runtime test in U2 already covers this; the type-level check here just confirms TS allows it).
- Heterogeneous parallel: `parallel([run(A, { vars: ... }), run(B, { vars: ... })])` type-flows correctly. Each promise inside the tuple has already been typed by `run()`, so `parallel` needs no signature change.
- Homogeneous parallel: `parallel(items, async (item) => run(STEP, { vars: { x: item.id } }))` type-flows correctly through the closure.
- `Step<TResult, TVars>` in `tests/unit/core/ask-types.test-d.ts:37` (`type StepResult<S> = S extends Step<infer T> ? T : never`) continues to work — `infer T` on a two-arg generic with a default does NOT break.

#### U5. `PromptFileRegistry` interface + sidecar-driven `promptFile` typing

**Goal:** Empty `PromptFileRegistry` interface declared in orch's barrel; `step.define({ promptFile: TPath })` infers `TVars` via `PromptFileRegistry[TPath]` lookup when the literal string `TPath` is a key in the registry. Generated `.d.ts` sidecars (U7) augment the registry. Confirm the augmentation pattern resolves correctly against orch's package structure with a `.test-d.ts` test that simulates a generated sidecar.

**Requirements:** R1, R11, R12, R20.

**Dependencies:** U3, U4.

**Files:**

- `src/core/prompt-file/registry.ts` (new) — declares `export interface PromptFileRegistry {}` (intentionally empty; augmented by generated sidecars).
- `src/core/prompt-file/index.ts` — re-export `PromptFileRegistry`.
- `src/core/index.ts` — re-export `PromptFileRegistry`.
- `src/index.ts` — already re-exports `* from './core/index.ts'`; verify the augmentation target is reachable as `declare module 'orch' { interface PromptFileRegistry { ... } }` end-to-end.
- `src/core/step.ts` — tighten the `promptFile`-branch overload: `define<TResult, TPath extends keyof PromptFileRegistry & string>(name, config: AutonomousStepInput<TResult> & { promptFile: TPath }): Step<TResult, PromptFileRegistry[TPath] extends PromptVars ? PromptFileRegistry[TPath] : Record<string, string|number|boolean>>`.
- `tests/unit/core/prompt-file/promptfile-registry.test-d.ts` (new) — simulates a generated sidecar inline using `declare module 'orch' { ... }` at the top of the test file; asserts the augmentation flows through `step.define`.
- `tests/unit/barrel.test.ts` — extend snapshot to include `PromptFileRegistry`.

**Approach:**

- The empty interface is the load-bearing piece. Before any sidecar is generated, `keyof PromptFileRegistry` is `never`, so `PromptFileRegistry[TPath]` widens to a fallback. The fallback shape must be **structurally compatible with PromptVars** so existing `promptFile:` call sites continue to type-check while the user is mid-codegen.
- Augmentation target verification: the test file ships a synthetic sidecar via:

  ```text
  declare module 'orch' {
    interface PromptFileRegistry {
      '@/.orch/prompts/test-fixture.md': { topic: string; depth?: number }
    }
  }
  ```

  …followed by `step.define('x', { agent, promptFile: '@/.orch/prompts/test-fixture.md' })` and `Expect<Equal<typeof step['config']['vars'], ...>>` — wait, `vars` is not stored on the config. The right assertion shape is on the returned `Step<TResult, TVars>` type: `Expect<Equal<typeof step extends Step<infer T, infer V> ? V : never, { topic: string; depth?: number }>>`.
- **Fallback (no augmentation for the literal path)**: typing falls back to `Record<string, string | number | boolean>` (PromptVars-equivalent) — `step.define({ promptFile: '@/.orch/prompts/unregistered.md' })` still type-checks; `run(STEP, { vars: ... })` accepts any PromptVars but the strict-both-directions runtime substitute still throws on mismatches.

**Patterns to follow:**

- TanStack Router's `FileRoutesByPath` augmentation pattern (external research): empty interface declared in core, augmented by generated `routeTree.gen.ts` via `declare module '@tanstack/react-router' { interface FileRoutesByPath { ... } }`. Same shape; the URL-of-augmentation is the package name.

**Test scenarios:**

- `PromptFileRegistry` is re-exported from `'orch'` — `import type { PromptFileRegistry } from 'orch'` resolves.
- With no augmentation, `PromptFileRegistry` is `{}` and `keyof PromptFileRegistry` is `never`.
- A test file augments `PromptFileRegistry` via `declare module 'orch'` and asserts `step.define({ promptFile: '<key>' })` produces a `Step<unknown, <expected shape>>`. **Covers AE5.**
- `run(STEP, { vars: { topic: 'x' } })` against the augmented step typechecks; `run(STEP, {})` is a `@ts-expect-error` (missing required `topic`).
- `step.define({ promptFile: '<unregistered>' })` falls back to a widened `PromptVars` contract; no `@ts-expect-error` on `run(STEP, { vars: { anything: 'x' } })` because the contract is unknown. Runtime substitution still enforces the actual placeholders.
- **Multi-file augmentation merge:** add a sibling `tests/unit/core/prompt-file/promptfile-registry-merge.test-d.ts` (or a `fixtures/` pair imported by the main test) that declares augmentations in two separate files for two distinct keys `'@/a.md'` and `'@/b.md'`. Assert via `Expect<Equal<PromptFileRegistry['@/a.md'], { ... }>>` AND `Expect<Equal<PromptFileRegistry['@/b.md'], { ... }>>` from a third file. This proves TypeScript's interface-merging actually fires across files at `tsc --noEmit` time — the real-world scenario when N sidecars sit next to N prompt files.
- **Unregistered-path fallback (explicit):** `step.define('x', { agent, promptFile: '@/.orch/prompts/never-generated.md' as const })` produces a `Step` whose `TVars` is the widened `Record<string, string | number | boolean>` fallback. `run(STEP, { vars: { anyKey: 'whatever' } })` typechecks (no compile error). This guarantees a mid-codegen edit doesn't red-light every consuming workflow before `orch types` catches up.

#### U6. Optional placeholder syntax `{{x?}}` end-to-end

**Goal:** Extend `substitute.ts` regex and runtime semantics to recognize `{{x?}}` as an optional placeholder. Missing optional substitutes to empty string. Whitespace-tolerant (`{{x?}}`, `{{ x? }}`, `{{ x ? }}` all parse identically). Inferred shape uses `?:` for optional keys (already covered by U3).

**Requirements:** R4.

**Dependencies:** U3 (type-level extractor already supports it), U4 (generic threading already accepts the optional shape), U5 (sidecar emitter — but U7 codes the runtime extractor; U6 just unifies the runtime substitute with the TLT extractor).

**Files:**

- `src/core/prompt-file/substitute.ts` — extend `PLACEHOLDER_RE` to capture the `?` suffix; `substitute()` treats optional placeholders as: if key is missing or `undefined`, substitute empty string; if key is present, substitute as today.
- `tests/unit/core/prompt-file/substitute.test.ts` — add scenarios for optional placeholders.
- (Type-level coverage already lives in U3's `template-vars.test-d.ts`.)

**Approach:**

- New regex: `/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(\?)?\s*\}\}/g`. Capture group 2 (`(\?)?`) flags optionality.
- Strict-both-directions check: an unsupplied **required** key is `missing-placeholder`; an unsupplied **optional** key is silently substituted with `''`; an extra key (provided but not used) is `extra-key` whether the template marks the placeholder optional or not.
- Runtime parity guarantee: the type-level `Trim` from U3 trims `\s*` inside braces; runtime regex's `\s*` matches the same characters.

**Patterns to follow:**

- Existing `substitute()` strict-both-directions logic stays — only the placeholder collection changes to also track which placeholders are optional vs required.

**Execution note:** This unit is small but cross-cutting because every prior test that uses the substituter must still pass. Run the full `tests/unit/core/prompt-file/` suite after the change before moving on.

**Test scenarios:**

- `substitute('Hi {{name?}}', { name: 'world' })` returns `'Hi world'`.
- `substitute('Hi {{name?}}', {})` returns `'Hi '` (empty substitution for missing optional, no error).
- `substitute('Hi {{name?}}', { name: undefined as unknown as string })` returns `'Hi '` (assertPromptVars normally rejects `undefined` at runtime — but the optional `{{x?}}` case must allow undefined OR force callers to omit the key. Decision: omitting the key is the canonical way to opt out; passing `undefined` is rejected by `assertPromptVars` as today, with a message advising to omit the key for optional placeholders).
- `substitute('Hi {{ name? }}', { name: 'x' })` returns `'Hi x'`.
- `substitute('Hi {{ name ? }}', { name: 'x' })` returns `'Hi x'` (`?` is allowed to be whitespace-separated from the identifier).
- `substitute('Hi {{name}} {{age?}}', { name: 'x' })` returns `'Hi x '` (required satisfied, optional empty).
- `substitute('Hi {{name}} {{age?}}', {})` throws `cause: 'missing-placeholder'` naming only `name` (required), NOT `age` (optional).
- `substitute('Hi {{name?}}', { name: 'x', extra: 'y' })` throws `cause: 'extra-key'` naming `extra`.
- Type-level: `VarsOf<'Hi {{name?}}'>` matches `{ name?: string | number | boolean }` (covered in U3).

### Phase 3 — Codegen, CLI, docs

#### U7. Sidecar generator library + `prompts` config field

**Goal:** A pure-TypeScript library that takes a list of `.md`/`.txt` paths, extracts placeholders (using a runtime extractor that mirrors U3's TLT extractor exactly), and emits one `.d.ts` sidecar per source file. New `prompts: { include: string[]; exclude: string[] }` field in `orch.config.ts` controls discovery. Idempotent — re-running with no changes is a no-op (mtime + content-hash gate).

**Requirements:** R11, R13, R16.

**Dependencies:** U3 (for runtime parity of the extractor), U5 (sidecar emits augmentation against `PromptFileRegistry`).

**Files:**

- `src/codegen/index.ts` (new) — barrel: `runCodegen(deps: { fs: FsService }, opts): Promise<CodegenResult>`. Deps-first signature mirrors `runCmd` / `typesCmd` so the same `FakeFsService` can drive discovery, read, and write.
- `src/codegen/discover-prompts.ts` (new) — `discoverPrompts(fs: FsService, configDir: Path, include: string[], exclude: string[]): Promise<Path[]>`. Takes `FsService` as a parameter so the discovery seam is the existing `FsService.glob()` port — NOT `Bun.Glob` directly. (Per CLAUDE.md "mock only at the edge": `Bun.Glob` lives behind `BunFsService.glob()` already at `src/services/fs/bun-fs-service.ts:61`. Direct `Bun.Glob` use here would bypass `FakeFsService` and break the unit-test seam.)
- `src/codegen/extract-placeholders.ts` (new) — runtime extractor that mirrors U3's TLT shape: returns `{ required: string[]; optional: string[] }`.
- `src/codegen/emit-sidecar.ts` (new) — `emitSidecar(source: Path, projectRoot: Path, vars: ExtractedVars): { content: string; targetPath: Path }`. Pure: builds the `.d.ts` string and decides where it goes. All disk reads/writes (existing-content compare, write) live in `runCodegen` via `FsService` so the only I/O seam in codegen is `FsService`.
- `src/codegen/codegen-result.ts` (new) — `interface CodegenResult { written: Path[]; skipped: Path[]; errors: Array<{ path: Path; error: string }> }`.
- `src/config/index.ts` — add `prompts: { include: string[]; exclude: string[] }` field (optional with defaults); extend `ConfigSchema` Zod schema; document in jsdoc.
- `tests/unit/codegen/extract-placeholders.test.ts` (new).
- `tests/unit/codegen/emit-sidecar.test.ts` (new).
- `tests/unit/codegen/discover-prompts.test.ts` (new) — uses `FakeFsService` from `src/services/fs/fake-fs-service.ts` to simulate a fixture project layout.
- `tests/unit/codegen/run-codegen.test.ts` (new) — end-to-end of the library, no CLI.
- `tests/integration/codegen/codegen-fixture.test.ts` (new) — runs the generator against a real on-disk fixture under `tests/fixtures/typed-vars/` and asserts the augmentation flows through `tsc`. **This is the load-bearing integration test for R11.**

**Approach:**

- **`discoverPrompts`** uses the injected `FsService.glob()` (which wraps `Bun.Glob` in `BunFsService` and a regex matcher in `FakeFsService`). Each glob in `include` is expanded relative to `configDir`; `exclude` globs filter the result. Returns absolute `Path[]`. This keeps the unit tests boundary-clean: pass a `FakeFsService` seeded with files, assert the returned path set, no real I/O.
- **`extractPlaceholders`** parses the source file's content using the same regex as U6's `PLACEHOLDER_RE`, deduping placeholders, separating required from optional. Returns `{ required, optional }`. **Critical:** this regex MUST stay byte-identical with `substitute.ts`'s regex. The two are kept in sync by a single shared constant exported from `src/core/prompt-file/substitute.ts` (or a sibling) and imported by `extract-placeholders.ts`. A parity test asserts the round-trip: any placeholder name extracted by the codegen matches what `substitute()` actually substitutes.
- **`emitSidecar`** produces:

  ```text
  // AUTO-GENERATED by `orch types` — do not edit.
  // Source: <relative path>
  declare module 'orch' {
    interface PromptFileRegistry {
      '@/<project-rooted path>': { <required>: string; <optional>?: string }
    }
  }
  export {}
  ```

  Path key form: `@/` followed by the file's path relative to `projectRoot`, using forward slashes. The `export {}` at the bottom makes the file a module (TypeScript requires module context for `declare module` augmentation).
- **Idempotence.** Before writing, read the existing `.d.ts` file (if any) and compare content; skip write if identical. The mtime check is a fast-path; content check is the truth.
- **Discovery defaults.** When `prompts` is unset in `orch.config.ts`: `include = ['.orch/workflows/**/*.{md,txt}', '.orch/prompts/**/*.{md,txt}']`, `exclude = []`. When `prompts.include` is set, defaults are not merged in — explicit configuration is the full list. Documented in U10.
- **Errors.** Read failures, parse failures, write failures all collected into `result.errors` rather than thrown. The caller (`typesCmd` U8 / `runCmd` U9) decides what to do with them. U8 prints them to stderr and exits non-zero; U9 prints a warning and continues (the workflow's runtime substitution still enforces correctness even without sidecars).
- **Scope: v1 emits project-rooted (`@/...`) keys only.** Workflow-local keys (e.g., `'slug.md'` resolving differently per workflow directory) are deferred. The skill docs (U10) tell users to use `@/.orch/workflows/.../slug.md` form in `promptFile:` when they want static inference.

**Patterns to follow:**

- `src/services/fs/fake-fs-service.ts` for the in-memory FS pattern (used by unit tests).
- `src/config/index.ts:36-39` for the Zod schema extension shape.

**Execution note:** Run the parity test FIRST. If the codegen extractor and the runtime substituter disagree about what counts as a placeholder, every downstream test is unreliable.

**Test scenarios:**

- `extractPlaceholders('Hi {{name}}')` returns `{ required: ['name'], optional: [] }`.
- `extractPlaceholders('Hi {{name?}}')` returns `{ required: [], optional: ['name'] }`.
- `extractPlaceholders('Hi {{a}} {{a}} {{b?}}')` returns `{ required: ['a'], optional: ['b'] }` (deduped).
- `extractPlaceholders('${legacy}')` returns `{ required: [], optional: [] }` (no `${...}` syntax).
- **Parity test (regex constant):** `extractPlaceholders` imports the same exported regex constant from `src/core/prompt-file/substitute.ts` that runtime `substitute()` uses. A unit assertion verifies the identity of the constant (referential equality) so the two cannot diverge silently.
- **Parity test (round-trip):** for every prompt across 50 random fixtures, the placeholders surfaced by `extractPlaceholders` equal the placeholders that `substitute()` actually substitutes when given matching vars.
- **Type/runtime whitespace parity:** for inputs `'{{x}}'`, `'{{ x }}'`, `'{{ x? }}'`, `'{{ x ? }}'`, `extractPlaceholders` produces the same `{required, optional}` shape that `VarsOf<...>` (U3) infers at the type level. (Verified by a paired `.test-d.ts` row that constructs `Expect<Equal<VarsOf<'{{ x ? }}'>, { x?: string|number|boolean }>>` alongside a runtime assertion on the same string. Closes the U3↔U6↔U7 parity loop.)
- `emitSidecar('/proj/.orch/prompts/x.md', '/proj', { required: ['a'], optional: ['b'] })` produces a `.d.ts` whose content augments `PromptFileRegistry['@/.orch/prompts/x.md']` to `{ a: string; b?: string }`.
- `emitSidecar` for a file with no placeholders produces an augmentation to `Record<never, never>` (so `step.define({ promptFile: '<key>' })` enforces no vars).
- `discoverPrompts('/proj', ['.orch/workflows/**/*.{md,txt}'], [])` against a FakeFsService with workflows finds the right files.
- `discoverPrompts` with an `exclude` pattern filters correctly.
- `discoverPrompts` returns absolute paths sorted ASCII (stable across runs — important for idempotent output ordering).
- `runCodegen` over a directory with 3 prompt files writes 3 sidecars on first run; re-running writes 0 (idempotent).
- `runCodegen` after editing one prompt file rewrites only that file's sidecar.
- `runCodegen` collects (does not throw on) read errors.
- **Integration:** the fixture at `tests/fixtures/typed-vars/reusable-step-workflow/` has `.orch/prompts/brainstorm.md` with `{{topic}}` and `{{depth?}}`. After `runCodegen`, the emitted sidecar augments `PromptFileRegistry`, and a `.test-d.ts` companion asserts `step.define({ promptFile: '@/.orch/prompts/brainstorm.md' })` produces the right `TVars` shape via `tsc --noEmit`. **Covers AE5 end-to-end.**
- New config field: `loadConfig` with `prompts: { include: ['custom/**/*.md'], exclude: [] }` validates; with missing `prompts` field, defaults are applied at load time.
- Invalid config (`prompts.include: 'string-instead-of-array'`) throws `ConfigLoadError` with a clear message.

#### U8. `orch types [--watch]` CLI command

**Goal:** A new `orch types` command runs the codegen once and exits. `--watch` mode keeps an fs.watch + poll-backstop + debounce loop alive, regenerating affected sidecars on save. Clean SIGINT teardown.

**Requirements:** R14, R17.

**Dependencies:** U7.

**Files:**

- `src/cli/commands/types.ts` (new) — `typesCmd(deps, _positional, _args, opts): Promise<number>`.
- `src/cli/main.ts` — register `'types'` in `COMMANDS`; add `--watch` to the argv parser; update `HELP` text; NOT in `CONFIG_FREE_COMMANDS` (the command reads `orch.config.ts` for the `prompts` field).
- `tests/unit/cli/types-command.test.ts` (new) — one-shot dispatch / argv plumbing / config-load error paths against a `FakeFsService` (no `fs.watch`, no real I/O).
- `tests/unit/cli/types-command-watch.test.ts` (new) — `--watch` mode against a **real fs tempdir**, mirroring the established precedent in `tests/unit/hosts/two-pane/steps-view/tail-state-json.test.ts:1` ("Unit tests for `tailStateJson` against real fs in a tempdir"). `fs.watch` cannot be intercepted by `FakeFsService`; the precedent is real-fs tempdirs even at the unit tier. Each test creates an isolated `tmpdir`, runs the watch loop with a short debounce, and cleans up on `afterEach`. Timing-sensitive scenarios use the same poll-backstop deadline pattern (`waitFor`-style helper) the steps-view tests already use.

**Approach:**

- **One-shot (`orch types`).**
  1. Load config (sync wrapper around `loadConfig`).
  2. Call `runCodegen({ configDir, include, exclude, projectRoot })`.
  3. Print summary (`<n> written, <m> skipped, <k> errors`) via `process.stdout.write`.
  4. Exit `EXIT.OK` (or `EXIT.GENERIC` on error).
- **Watch (`orch types --watch`).**
  1. Run one-shot pass first (so the initial state is correct).
  2. Open `fs.watch` on each discovered prompt file plus the `.orch/workflows/` and `.orch/prompts/` directories (for new-file detection).
  3. Add a 250 ms `setInterval` poll backstop with `unref()` (the same pattern as `src/hosts/two-pane/steps-view/tail-state-json.ts:79+`).
  4. Coalesce bursts via 50 ms trailing debounce, capped at 200 ms max-wait.
  5. On each event: re-run `discoverPrompts` (to catch new files) → re-run codegen → print a per-file summary.
  6. `process.once('SIGINT', ...)` closes the watcher cleanly and exits `EXIT.SIGINT` (130).
- The watcher pattern is reproduced inline. NOT lifted into `src/services/fs/file-watcher.ts` (YAGNI — only one new caller; the steps-view tail is its own caller).
- **Argv wiring.** Add `watch: { type: 'boolean', default: false }` to the `parseArgs.options` block in `src/cli/main.ts:159-180`. The flag is read off `CliOpts`.

**Patterns to follow:**

- `src/cli/commands/logs.ts:281, 294` for the SIGINT + `process.once` shape (the `--follow` path is the closest precedent).
- `src/hosts/two-pane/steps-view/tail-state-json.ts` for the watcher + debounce pattern.
- `src/cli/commands/init.ts:22-46` for the minimal command-shape skeleton.

**Execution note:** Test the one-shot path before the watch path. The watch tests are timing-sensitive and harder to make reliable.

**Test scenarios:**

- One-shot `orch types` against a fixture with 3 prompt files writes 3 sidecars and prints `3 written`.
- One-shot `orch types` after sidecars exist writes 0 and prints `0 written, 3 skipped`.
- `orch types` with a malformed `prompts.include` in `orch.config.ts` exits non-zero with a clear error message.
- `orch types --watch` writes initial sidecars, then a modification to a `.md` file triggers a regen within 250 ms (poll backstop).
- `orch types --watch` SIGINT exits `130` cleanly and closes the watcher.
- `orch types --watch` against an empty `.orch/workflows/` watches the directory and picks up a newly-created `.md` file.
- Help output (`orch types --help`) describes the command.
- `orch types` is reachable via `COMMANDS['types']` (CLI dispatch sanity).

#### U9. `orch run` auto-regen pre-step

**Goal:** `orch run` runs an idempotent codegen pass at startup, before the workflow module is imported. Cold-clone scenario (`bun install && orch run <workflow>`) succeeds without a separate setup step. Failed codegen prints a warning but does not abort the run — runtime substitution still enforces correctness.

**Requirements:** R15, R17.

**Dependencies:** U7.

**Files:**

- `src/cli/commands/run.ts` — add a leading `await runCodegen(...)` call between argv-parsing and `loadWorkflow`. Best home: inside `runCmd` right after `loadConfig`, before `loadWorkflow`.
- `tests/unit/cli/run-codegen-prepass.test.ts` (new) — assert the codegen runs and that a failure logs but does not abort.
- `tests/fixtures/typed-vars/cold-clone-fixture/` (new) — a workflow that uses a `promptFile:` with no pre-existing sidecar; integration test asserts `orch run` loads it successfully.

**Approach:**

- After `loadConfig`, call `runCodegen({ configDir, ...config.prompts, projectRoot })`.
- On `result.errors.length > 0`: print a stderr warning naming each error, but continue to `loadWorkflow`. The runtime substitution path in U2/U6 still enforces var correctness — sidecars affect `tsc` and IDE, not runtime.
- On `result.written.length > 0`: print a short stdout note (one line: `Generated <n> prompt-file type sidecar(s).`) so the user knows something happened. Suppressed when `--quiet` (if such a flag exists; else, suppress when `process.env.ORCH_QUIET === '1'` — define this lightly).
- **Subtle clarification (re-stated from Key Decisions):** The runtime `import` does NOT depend on `.d.ts` files. Substitution happens at run() via `assemblePrompt`. So the cold-clone path works even if codegen completely fails — sidecars only matter for the NEXT `bun run check` / IDE feedback session. AE7 ("workflow proceeds with correct types") is read as "workflow loads and runs"; the explicit type-correctness check is `bun run check` which runs codegen via U8.

**Patterns to follow:**

- `src/cli/commands/run.ts:93-198` for the existing command structure.

**Execution note:** Keep the prepass fast (the integration test asserts <100 ms on the cold-clone fixture). If the prepass ever exceeds 500 ms, fail loudly in tests so the slowdown isn't shipped.

**Test scenarios:**

- `orch run <workflow>` on the `cold-clone-fixture` (sidecars absent) succeeds and the workflow's `step.define({ promptFile })` calls resolve at runtime via the FakeRunner.
- `orch run` against a config with broken `prompts.include` prints a warning but still runs the workflow.
- `orch run` prepass writes any missing sidecars in <100 ms for the 3-file fixture.
- `orch run` does NOT regenerate when sidecars are current (skipped count > 0, written count = 0).
- `orch run` with `ORCH_QUIET=1` suppresses the "Generated N sidecar(s)" line.
- Regression: existing workflows that do not use `promptFile:` are unaffected — the prepass discovers no files and is a fast no-op.

#### U10. Docs + skill sweep + end-to-end integration test + gates

**Goal:** Document the typed-vars feature end-to-end. Migrate the `orch-workflow-author` skill to recommend the new pattern. Update `docs/public/` (api.md, the writing-a-workflow guide, examples.md, sidebar). Land a new how-to guide `docs/public/guides/typed-prompt-vars.md`. Add the end-to-end integration test that exercises all three contract sources (inline literal, sidecar lookup, explicit RunOverrides.vars). Run the gates: `bun run check` and `bun run docs:build` both green.

**Requirements:** R20 (verified by integration), R21 (error wording consistency), R22 (migration recipe).

**Dependencies:** U2–U9.

**Files:**

- `tests/integration/core/typed-vars-workflow.test.ts` (new) — drives `tests/fixtures/typed-vars/reusable-step-workflow/` end-to-end:
  - Loads the workflow.
  - Runs it twice with different `vars`; asserts two distinct cache entries (R9).
  - Resumes (mid-run) and asserts each `vars` variant resumes from its own entry (AE3 full coverage).
  - Asserts the FakeRunner observes the substituted prompts for both calls.
- `tests/fixtures/typed-vars/reusable-step-workflow/` (new) — a real workflow that reuses a single `step.define` across multiple `run()` calls with different vars. Demonstrates the AE3 pattern in anger.
- `docs/public/guides/typed-prompt-vars.md` (new) — the load-bearing guide. Sections: When to use; Three contract sources (inline, sidecar, explicit RunOverrides.vars); Optional placeholders (`{{x?}}`); Migration recipe from factory-functions (R22); The `@/...` form for sidecar inference; The `orch types` and `orch types --watch` workflow.
- `docs/public/reference/api.md` — update `step.define` signature (Step<TResult, TVars>), update `RunOverrides` table to add `vars`, add `PromptFileRegistry` reference section, document `orch types` command.
- `docs/public/guide/4-writing-a-workflow.md` — add a short subsection introducing typed reusable steps with a link to the new guide. Stay top-to-bottom.
- `docs/public/examples.md` — point at the new fixture / `reusable-step-workflow` example.
- `docs/public/.vitepress/config.mts` — add `{ text: 'Typed prompt vars', link: '/guides/typed-prompt-vars' }` to the Guides sidebar.
- `.claude/skills/orch-workflow-author/SKILL.md` — Phase 2 / Phase 3 prose: present the new pattern as the default for reusable steps; show the `{{x?}}` syntax; cite the new fixture.
- `.claude/skills/orch-workflow-author/references/prompt-patterns.md` — add a "Reusable steps with typed vars" section. Document the three contract sources and the migration recipe from factory functions.
- `.claude/skills/orch-workflow-author/references/templates.md` — add a template that uses inline `{{x}}` literal and another that uses `promptFile:` with `@/...`.
- `.claude/skills/orch-workflow-author/references/api.md` — update with `Step<T, V>`, `RunOverrides.vars`, `PromptFileRegistry`, `VarsOf`, and the `orch types` command.

**Approach:**

- Follow `doc-writer` skill conventions (`.claude/skills/doc-writer/SKILL.md`): signatures quoted from `src/`, runnable examples with imports, no forward references in the numbered guide, monospace API surface.
- The new guide page leads with the AE3 reusable-step pattern (define once, vary vars per `run()` call). Reaches the sidecar + `@/...` form by the third section, with the migration recipe and `orch types --watch` workflow last.
- Migration recipe (R22) shows the before/after for a factory-function pattern, mapped to the `examples/file-prompts-demo/index.ts` migration done in U2.
- The api.md sync test (`tests/unit/barrel.test.ts` extension from U3 and U5) is the automated guard against signature drift.

**Patterns to follow:**

- `docs/public/guides/typed-returns.md` for the how-to guide template.
- `docs/public/reference/api.md` for the field-table format.
- `examples/file-prompts-demo/index.ts` (post-U2 migration) as the worked reference.

**Execution note:** Run `bun run docs:build` to catch dead links. Run `bun run check` to catch type-test regressions across the project. Both must be green before declaring U10 complete.

**Test scenarios:**

- **Integration:** loading `tests/fixtures/typed-vars/reusable-step-workflow/` and running it with two distinct `vars` payloads produces two distinct cache entries; the FakeRunner sees correctly-substituted prompts for both. **Covers AE3.**
- **Integration:** the same fixture's `.d.ts` sidecar (generated by U7's codegen) augments `PromptFileRegistry` such that a `.test-d.ts` companion asserts `Expect<Equal<typeof run extends ... , ...>>`. **Covers AE5 end-to-end.**
- **Integration:** an inline `step.define('foo', { agent, prompt: 'Hi {{name}}' as const })` step run with `{ vars: { name: 'world' } }` substitutes correctly; run with `{}` throws at `assemblePrompt` time. **Covers AE4 + AE2 (runtime portion).**
- **Integration:** a workflow that mixes all three contract sources (inline literal, sidecar lookup, computed-prompt with explicit `vars:` declared via `run()` override-only) round-trips correctly. **Covers AE8 / R20.**
- **Cold-clone end-to-end (AE7):** add `tests/integration/cli/orch-run-cold-clone.test.ts`. Copies `tests/fixtures/typed-vars/cold-clone-fixture/` to a tempdir, deletes every `*.d.ts` sidecar, runs `orch run <workflow>` against it with a FakeRunner, asserts (a) the workflow loads despite zero pre-existing sidecars, (b) `runCodegen` writes the missing sidecars during the prepass, (c) the workflow's FakeRunner sees the substituted prompt. This is the only test that proves the cold-clone story end-to-end — U9's unit test exercises the prepass in isolation but not the "no setup step" promise.
- **Legacy `Step<T>` literal regression:** explicit `Expect<Equal<Step<{ slug: string }>, Step<{ slug: string }, Record<never, never>>>>` row in `tests/unit/core/schema.test.ts`. If TypeScript ever stops defaulting `TVars` to `Record<never, never>` (e.g. someone changes the default to `PromptVars`), this row fails and surfaces the regression before it lands in shipped code that uses bare `Step<T>` literals (12 sites in `src/`, 2 in `tests/`).
- **Documentation:** `bun run docs:build` passes — no dead links into the new guide or from the api.md.
- **Surface:** `bun run check` passes — typescript, biome, all unit tests, all integration tests.
- **Skill sanity:** the orch-workflow-author skill's example snippets typecheck against the new types (eye-verified during the implementation pass; CLAUDE.md does not require parsed-skill validation).

---

## Scope Boundaries

### In scope

Everything in [Requirements](#requirements) R1–R23.

### Deferred to Follow-Up Work

- **Workflow-local sidecar keys.** v1 emits project-rooted (`@/...`) keys only. Sidecar augmentation for workflow-local `promptFile: 'slug.md'` is deferred — requires resolving the per-workflow-directory key collision and is not load-bearing now that the `@/...` form is documented as the typed-inference path.
- **Per-prompt argument-validation schemas (Zod) embedded in templates.** Origin scope-boundary: explicitly out. Mentioned again here because the `vars: 'string' | 'number' | 'boolean'` vocabulary is intentionally minimal; richer constraints (enum, regex) belong in a future iteration if user demand emerges.
- **Workflow-local prompt-file discovery in `orch types`.** v1's discovery list is `.orch/workflows/**` and `.orch/prompts/**`. Workflows under `examples/` or `workflows/` (root-level) won't auto-discover unless the user adds them to `orch.config.ts.prompts.include`. Documented in U10.
- **Sidecar combined-per-directory form.** Each `.md`/`.txt` gets its own `.d.ts`. A single combined declaration per directory could reduce file count for projects with hundreds of prompts; defer until measured.
- **Project-root memoization across orch invocations.** The walk-up is cheap; skip.

### Outside this product's identity

- **TypeScript Language Service plugin** for in-memory type synthesis. Rejected in origin Key Decisions; remains rejected — `tsc` and CI ignore LSP plugins.
- **Bundler plugin** (Vite, esbuild, Webpack) as the distribution channel. orch is not bundler-bound.
- **`postinstall` codegen.** Bun's `postinstall` semantics vary and the user has no prompt files at install time.
- **Default values for vars** (`{{name=default}}`), computed/derived vars (`{{topic.toUpperCase()}}`), nested key paths (`{{user.name}}`), structured-object substitution. Vars stay flat scalars; richer composition is `loadPrompt()`.
- **HTML/MDX templates.** `.md` is text only.
- **Localization-style multi-locale selection.**
- **Templates from non-filesystem sources** (database, network). Codegen path is filesystem-only.
- **Auto-migration of existing factory-function patterns** in user workflows. Documented in U10's migration recipe but not performed automatically.

---

## System-Wide Impact

| Surface | Impact |
| --- | --- |
| `src/core/step.ts` | `Step<T, V>` second generic with default. Both `step.define` overloads accept inline-`prompt:` literals (TLT path) or `promptFile:` literals (registry path). R23 break: `vars:` on define throws `cause: 'vars-on-define'`. `resolvePromptFile` stores raw template (no longer substitutes). |
| `src/core/workflow.ts` | `RunOverrides<V>` is generic. `RunFn` overloads thread `<T, V>`. `assemblePrompt` calls `substitute(template, overrides.vars)`. Cache-key fold via `stableHashHex`. |
| `src/core/prompt-file/` | New files: `template-vars.ts` (TLT), `registry.ts` (interface), `cache-key.ts` (hash). Existing `substitute.ts` gains `{{x?}}` support. |
| `src/codegen/` | **New module.** Discovery + extraction + sidecar emission. Isolated subsystem with its own tests. |
| `src/cli/commands/types.ts` | **New file.** `orch types [--watch]` command. |
| `src/cli/commands/run.ts` | Adds a leading `await runCodegen(...)` pre-pass. |
| `src/cli/main.ts` | Registers `types` in `COMMANDS`. Adds `--watch` flag. Updates `HELP`. |
| `src/config/index.ts` | New `prompts: { include, exclude }` field on `OrchestratorConfig`. Zod schema extension with defaults. |
| `src/core/index.ts`, `src/index.ts` | Re-export `PromptFileRegistry`, `VarsOf`. |
| FsService / BunFsService / FakeFsService | **Untouched.** Codegen uses `Bun.Glob` + `node:fs` directly; sidecar I/O is async but not on the hot run path. |
| Runners | **Untouched.** Substitution still produces a plain string on `config.prompt` by the time the runner sees it. |
| State store | **Untouched.** Cache keys are still string-typed via `stepName`; the new key suffix (`:vars=<hex>`) passes existing validation. |
| Existing tests | `tests/unit/core/schema.test.ts` verifies single-generic `Step<T>` literals still match. `tests/unit/core/prompt-file/step-define-prompt-file.test.ts` and `tests/integration/core/prompt-file-workflow.test.ts` rewritten under U2. |
| `examples/file-prompts-demo/index.ts` | Migrated under U2 (2 call sites). |
| Other examples (`feature-loop/`, `compound/`, `new-feature/`) | **Untouched.** None use `step.define({ promptFile, vars })`; verified by repo research. |
| `docs/public/` | New how-to guide, updated api.md, updated 4-writing-a-workflow.md, updated examples.md, sidebar entry. |
| `.claude/skills/orch-workflow-author/` | SKILL.md + 3 reference docs updated. |
| `CLAUDE.md` | **Untouched.** No new non-negotiable rules; the new code follows existing rules. |

---

## Alternative Approaches Considered

- **TypeScript Language Service plugin** (in-memory type synthesis): would give magic-feeling IDE inference without writing `.d.ts` files, but `tsc --noEmit` and CI ignore Language Service plugins, so the IDE would disagree with `bun run check`. Strictly worse DX. Rejected in origin; kept rejected.
- **Bundler plugin (Vite / esbuild / Webpack)**: orch is not bundler-bound; users invoke `bunx orch run` and import workflows directly. A bundler plugin would fragment the install path. Rejected in origin; revisit only if user demand emerges.
- **`postinstall` codegen via `package.json` script**: Bun's `postinstall` semantics vary across workspace setups, and at install time the user has no prompt files. The combination of `orch types` + auto-regen at `orch run` start covers the cold-clone case without depending on package-manager hooks.
- **Depending on `type-safe-prompt` or `ts-prompt` as a runtime dep**: external research confirmed both are micro-projects (5 stars / 2 contributors and 1 contributor / no commits since 2024-09 respectively). Vendoring ~25 lines of conditional template literal types removes the single-author dependency risk. Attribution preserved in code comments.
- **Combined-per-directory sidecar (one `.d.ts` per directory)**: could reduce file count for projects with hundreds of prompts. Deferred — current scale is dozens of prompts at most, per-file sidecars are simpler to attribute back to their source.
- **Forbidding workflow-local `promptFile:` paths altogether** (require `@/...` everywhere): would simplify type inference (one canonical key form) but breaks the just-shipped file-based-prompts ergonomics (`examples/file-prompts-demo/` uses workflow-local `'slug.md'`). Kept: workflow-local works at runtime, only `@/...` gets static inference. Documented trade-off.
- **Storing the raw template AND a pre-substituted-with-defaults string on `AgentStepConfig`**: would let some steps skip substitution at run-time. Rejected — adds a second source of truth and the substitution is fast enough that the optimization isn't load-bearing.
- **Implicit cache-key derivation that always folds vars regardless of `as:`**: simpler invariant but breaks back-compat for call sites that today use `as:` for cache discrimination. Current rule (`as:` wins; otherwise fold) preserves intent.

---

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| TLT extractor recursion-depth limit hit on very large prompts. | Low | Med (compile error at user's call site, confusing) | Document the limit in `template-vars.ts` comments. U3 includes a 50-placeholder regression test. If a user hits the limit, the workaround is to split the prompt with `loadPrompt()`. |
| Whitespace-in-braces footgun (`{{ x }}` infers a different key from `{{x}}`). | Low | Med (silent type/runtime divergence) | U3 type-extractor includes a `Trim<S>` helper so type and runtime substitute agree byte-for-byte. Parity test in U7 verifies. |
| Sidecar key collision between identically-named files in sibling workflow dirs. | Low | High (TypeScript declaration-merging mismatch silently picks one) | v1 emits project-rooted keys only — unique by construction. Workflow-local keys deferred. |
| Cache-key fold breaks back-compat for steps with no vars. | Low | High (regressions in shipped pipelines) | `stableHashHex({})` returns `''` and the cache-key derivation skips the suffix entirely when vars are empty. U2 has explicit regression tests for the no-vars case. |
| R23 break catches users who have already shipped the just-released file-based-prompts feature with `vars:` on `step.define`. | Medium | Med (one PR migration per user) | Single repo-internal call site (`examples/file-prompts-demo/`) verified by research; migrated in U2. Error message includes the exact migration recipe. The new guide (U10) leads with the migration story. |
| Sidecar mismatch with the regex in `substitute.ts` (codegen disagrees with runtime). | Med | High (red squiggles disagree with runtime) | The placeholder regex is exported as a single constant from `substitute.ts` and imported by `extract-placeholders.ts`. U7's parity test asserts round-trip for 50 random fixtures. |
| Watch loop missed events on macOS due to atomic-rename. | Med | Low (stale sidecar until next save) | 250 ms poll backstop catches missed events (the same pattern as `tail-state-json.ts` already does for `state.json`). |
| Auto-regen at `orch run` startup slows down user-perceived launch time. | Low | Low | Idempotent skip via content-hash; <100 ms gate enforced in U9 tests. Suppressed when ORCH_QUIET=1. |
| `Step<TResult>` literal sites break after adding the second generic. | Low | High (compile errors across the project) | Default `TVars = Record<never, never>` keeps all 12 src-tree literals and 2 test-tree literals working. Verified in U4 by extending `tests/unit/core/schema.test.ts`. |
| Substitution shift introduces hidden behavior change for existing inline `prompt: 'static text'` workflows. | Low | High (every shipped workflow could regress) | `assemblePrompt` short-circuits when the template has no `{{...}}` tokens AND `overrides.vars` is empty. U2 regression test: a static-prompt workflow with no vars runs identically to today. |
| `declare module 'orch'` augmentation does NOT resolve at the user's project (TanStack-Router-style trust assumption). | Low | High (the whole sidecar path silently no-ops) | U5 ships a `.test-d.ts` test that augments `PromptFileRegistry` inline and asserts the flow end-to-end. U7's integration test does the same against a real on-disk fixture, gated by `tsc --noEmit`. |
| Vendored extractor drifts from runtime regex over time. | Med (months) | High (type/runtime divergence) | The placeholder regex is the single source of truth (shared constant); U7's parity test surfaces drift in CI. |

---

## Verification Strategy

- **Unit-level (per module, in isolation).**
  - U1: `cache-key.test.ts` — stable hash properties (key order, NaN, numeric equivalence).
  - U2: rewritten `substitute.test.ts` + `step-define-prompt-file.test.ts` + new cache-key behavioral test in `workflow.test.ts`.
  - U3: `template-vars.test-d.ts` — every TLT extractor edge case via `Expect<Equal<...>>`.
  - U4: `step-runfn-typed-vars.test-d.ts` — generic threading through all overloads.
  - U5: `promptfile-registry.test-d.ts` — augmentation pattern resolves end-to-end.
  - U6: extended `substitute.test.ts` — optional placeholder runtime semantics.
  - U7: `extract-placeholders.test.ts` + `emit-sidecar.test.ts` + `discover-prompts.test.ts` + `run-codegen.test.ts` + **the parity test** (codegen extractor vs runtime substituter).
  - U8: `types-command.test.ts` — one-shot and `--watch` modes.
  - U9: `run-codegen-prepass.test.ts` — prepass runs, failures warn-not-abort.
- **Integration-level.**
  - U7: `codegen-fixture.test.ts` — real on-disk fixture, sidecars emitted, augmentation flows through `tsc`.
  - U10: `typed-vars-workflow.test.ts` — end-to-end workflow with all three contract sources, distinct cache entries per vars, resume across vars splits.
- **Surface-level.**
  - `tests/unit/barrel.test.ts` extended to include `PromptFileRegistry`, `VarsOf`.
  - U10: `bun run docs:build` gate (no dead links).
- **Regression.**
  - `bun run check` (existing gate) must remain green after each unit.
  - Existing `tests/unit/core/schema.test.ts` `Step<T>` literals continue to match after the generic addition.
- **Manual (optional, recommended before merge).**
  - Run `bunx orch run file-prompts-demo "explore a feature idea"` after U2/U10 land and visually confirm the slug/summarize prompts substitute correctly at run-time.
  - Open VS Code on a fresh project, write `step.define('x', { agent, prompt: 'Hi {{name}}' as const })`, and confirm the IDE shows a red squiggle on `run(x)` (missing `name`).
  - Same as above WITHOUT `as const` to confirm the `<const T extends string>` modifier delivers the no-`as const` inference promise (U4's load-bearing scenario).

### Testing-strategy adherence notes

- **Boundary rule.** Per CLAUDE.md non-negotiables 1 and 3 + [docs/testing-strategy.md](../testing-strategy.md), the only fake in any unit test is a `*Service`. The two places this plan touched a non-Service boundary — `Bun.Glob` (U7) and `fs.watch` (U8) — are resolved: U7 routes through the existing `FsService.glob()` port so `FakeFsService` is the seam; U8 follows the established `tail-state-json.test.ts` precedent of real-fs tempdirs at the unit tier (because `fs.watch` has no port and a `WatchService` abstraction would be YAGNI per the plan's own Key Decisions).
- **File-size budget (CLAUDE.md rule 5).** `tests/unit/core/step-runfn-typed-vars.test-d.ts` (U4) hosts 10+ `Expect<Equal<...>>` rows plus `@ts-expect-error` rows; pre-emptively split by scenario family if the file approaches 300 lines (one `describe` per file is fine — see `tests/unit/core/ask-types.test-d.ts` for the split shape). Same precaution for `tests/integration/core/typed-vars-workflow.test.ts` (U10) which orchestrates three contract sources end-to-end.
- **No `mock.module` in `src/core/`** (CLAUDE.md non-negotiable 3). Verified across every test file enumerated in this plan: U2's rewrites, U3/U4/U5 type-level tests, U6 substitute tests, U7 codegen tests, U8 CLI tests, U9 prepass tests, U10 integration test — all inject `*Service` fakes or use real fs tempdirs; none reach for `mock.module`/`vi.mock`/`jest.mock` against an internal module.

---

## Documentation Plan

Tracked as U10. Highlights:

- New page: `docs/public/guides/typed-prompt-vars.md` (sidebar entry).
- Updated: `docs/public/reference/api.md` (Step generics, RunOverrides.vars, PromptFileRegistry, orch types).
- Updated: `docs/public/guide/4-writing-a-workflow.md` (short subsection linking to the new guide).
- Updated: `docs/public/examples.md` (point at new fixture-style example).
- Updated: `docs/public/.vitepress/config.mts` (sidebar entry).
- Updated: `.claude/skills/orch-workflow-author/SKILL.md` + all three reference docs.
- Gate: `bun run docs:build` must pass with no dead links.
- Sync: `docs/public/reference/api.md` cross-checked against `src/index.ts` exports per the doc-writer skill's guard.

---

## Sequencing

```text
   ╔═══════════ Phase 1 — Runtime mechanics ═══════════╗
                       U1 (cache-key hash)
                           │
                           ▼
                       U2 (run-time substitution + R23 break + example migration)
   ╚════════════════════════ (Phase 1 boundary) ═══════╝
                           │
                           ▼
   ╔═══════════ Phase 2 — Static typing ════════════════╗
                       U3 (TLT extractor) ──────────────┐
                           │                            │
                           ▼                            │
                       U4 (Step<T,V> + RunFn overloads) │
                           │                            │
                           ▼                            │
                       U5 (PromptFileRegistry)          │
                           │                            │
                           ▼                            │
                       U6 (optional {{x?}}) ────────────┘
   ╚════════════════════════ (Phase 2 boundary) ═══════╝
                           │
                           ▼
   ╔═══════════ Phase 3 — Codegen, CLI, docs ═══════════╗
                       U7 (codegen library + config field)
                           │
                ┌──────────┼──────────┐
                ▼                     ▼
            U8 (orch types CLI)  U9 (orch run pre-pass)
                │                     │
                └──────────┬──────────┘
                           ▼
                       U10 (docs + skill + integration test + gates)
   ╚════════════════════════ (Phase 3 boundary) ═══════╝
```

**Phase → PR mapping.** Each phase is one PR by default.

- **Phase 1 PR (U1+U2)** — substitution shift + R23 breaking change ship together so the `bun run check` gate stays green inside one review.
- **Phase 2 PR (U3+U4+U5+U6)** — purely additive TypeScript with no runtime impact. U6 lives here, not Phase 1, because its regex must stay byte-identical with U3's type-level `Trim` (parity is enforced by a single shared regex constant; splitting them risks silent drift).
- **Phase 3 PR (U7+U8+U9+U10)** — codegen subsystem + CLI surface + the docs/skill/integration sweep that closes the loop. Splitting U10 off as a fourth PR is reasonable if Phase 3 grows too large for one review; collapsing U8+U9 into U7 is also acceptable if reviewer fatigue is a concern.
