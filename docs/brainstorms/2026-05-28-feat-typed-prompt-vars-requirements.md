---
date: 2026-05-28
topic: typed-prompt-vars
---

# Typed Prompt Vars for Reusable Steps

## Summary

Add a typed `vars` contract to `step.define` so a single step can be reused across multiple `run()` call sites with different inputs, with TypeScript catching missing or wrong vars at every site. The contract is **inferred by default**: from `{{placeholder}}` tokens in inline `prompt:` string literals (via TypeScript template literal types), or from generated `.d.ts` sidecars for `.md` prompt files (via a `PromptFileRegistry` module-augmentation pattern). Explicit `vars:` declarations remain available as an escape hatch for dynamically constructed prompts or for callers who want to deliberately over-constrain. Ship all three contract sources — runtime contract, inline TLT inference, and file-based codegen with a save-time watcher — working after `bun install` with no extra build step.

---

## Problem Frame

Workflow authors who use `step.define({ promptFile, vars })` today bake `vars` into the prompt at module load — the rendered string is frozen into the `Step` config and the `vars` field is stripped before the executor ever sees it. That makes a step a one-shot artifact: two `run(BRAINSTORM, ...)` calls in the same workflow cannot vary the topic, because the topic was already substituted at definition time. Authors who want reusable steps fall back to either (a) factory functions that call `step.define` per call site, or (b) `loadPrompt()` composed with the `RunOverrides.prompt` escape hatch that bypasses the declared step entirely. Both work; neither is what reusable steps should feel like.

The cost has two shapes. First, authoring friction: writing a tiny factory just to vary one var is the kind of ceremony that nudges authors toward inlining one-off prompts as TypeScript strings — losing the file-based prompts win we just shipped. Second, error surface: today no one catches the case where the template says `{{tone}}` and the call site forgets to pass it. The substitution engine throws at workflow runtime, deep inside an agent step that has already started spending tokens.

A reusable step with a typed vars contract addresses both: define the prompt once, declare (or — better — infer) what it takes, and let TypeScript catch missing/extra/wrong-type args at every call site. The codegen layer extends the same contract across the `.md` → `.ts` boundary so adding a placeholder in a markdown file produces immediate type errors in every consumer, without forcing the author to re-type the same variable names in TS.

---

## Requirements

**How the contract is determined (inference by default)**

- R1. `step.define` infers the `vars` contract automatically from its source: from `{{placeholder}}` tokens in an inline `prompt:` string literal, or from the generated module declaration when `promptFile:` references a `.md` file with a known sidecar. No explicit `vars:` is needed in the common case.
- R2. Explicit `vars:` is an opt-in escape hatch — used when the type system cannot read the prompt (dynamically constructed strings, prompts from outside codegen-covered paths) or when the author wants to deliberately over-constrain or self-document the contract inline.
- R3. When explicit `vars:` is provided alongside an inferable contract, the explicit one wins; a shape mismatch between explicit and inferred throws at module load with an error naming both sources.

**Vars vocabulary and typed `Step<T, V>`**

- R4. The supported vars vocabulary is `'string' | 'number' | 'boolean'` with `?` suffix for optional. Inference produces equivalent shapes from the corresponding placeholder syntax in templates (in-template optional marker syntax is an Outstanding Question).
- R5. The `Step<TResult, TVars>` type carries the var shape (inferred or explicit) downstream — read by the executor, `RunOverrides`, and future tooling through standard TypeScript inference.

**Typed injection at `run()`**

- R6. `RunOverrides` gains a typed `vars` field; calling `run(step, { vars: ... })` enforces the var shape declared or inferred on the step at compile time.
- R7. Missing required vars, extra unknown keys, or type mismatches at `run()` call sites surface as TypeScript errors visible in both the IDE and under `bun run check`.
- R8. At runtime, the executor validates incoming vars against the contract before the agent step starts and throws an error that names the step, the failing keys, the expected shape, and the prompt source.
- R9. Vars participate in the step cache key — `run(STEP, { vars: { topic: 'A' } })` and `run(STEP, { vars: { topic: 'B' } })` resolve to distinct cache entries within the same run without requiring an `as:` override.
- R10. `RunOverrides.prompt` continues to fully replace the prompt and bypass vars validation, preserving the existing escape hatch for callers who want to compose a prompt manually.

**Type flow for file-based prompts (codegen + module augmentation)**

- R11. orch ships a sidecar generator that, given a `.md` template, emits a `.d.ts` next to the file that extends a global `PromptFileRegistry` interface declared in the `orch` module — keyed by the literal path string used as `promptFile:`, valued by the var shape extracted from the file's placeholders.
- R12. `step.define` resolves the var shape by looking up `PromptFileRegistry[TPath]` when `promptFile:` is a literal string — the TanStack-Router-style module-augmentation pattern that flows a string literal into typed inference without runtime cost and without requiring an `import` of the `.md`.
- R13. Sidecar files are positioned to be picked up by TypeScript's default `include` patterns; no `tsconfig.json` changes are required from the user. The public guide recommends a single `*.md.d.ts` line in `.gitignore` to keep generated artifacts out of source control.

**Codegen execution — no extra build step**

- R14. The generator runs automatically inside orch's dev workflow (watcher command name resolved during planning), re-emitting sidecars on file save. The latency target is sub-200 ms at typical project sizes; the actual measured upper bound is set during planning.
- R15. The generator also runs at the start of `orch run` as an idempotent step, so a fresh `git clone && bun install && orch run <workflow>` succeeds on the first try without requiring the dev watcher to have been started.
- R16. Generation is convention-based: a default prompt-file location requires no user configuration; explicit overrides remain available for projects that prefer a different layout. The default location is resolved during planning (see Outstanding Questions).
- R17. Distribution stays single-channel via orch's CLI — no bundler plugin (Vite / esbuild / Webpack), no `postinstall` hook, no TypeScript Language Service plugin. This avoids IDE-vs-`tsc` divergence and bundler-bound coupling.

**Inline string-literal inference (no codegen path)**

- R18. When `prompt:` is an inline string literal (typically with `as const`), the var contract is inferred via TypeScript template literal types — no codegen, no sidecar, no declaration ceremony.
- R19. The template-literal extraction logic is vendored into orch's source tree rather than added as a runtime dependency. Attribution to the prior art (`type-safe-prompt`, `ts-prompt`, `prompt-builder`) is preserved in code comments. The vendored type is small (~20-30 lines of conditional template literal types) and is covered by `tsd` / `expect-type` tests so TypeScript version upgrades do not silently regress inference.
- R20. All three contract sources — inferred-from-literal, inferred-from-sidecar, explicit `vars:` — behave identically downstream. `run()` enforcement, runtime validation, and cache-key participation are source-agnostic.

**Error surface, authoring DX, and migration**

- R21. The three error layers cohere: define-time (vars contract mismatched against the template), compile-time (call-site missing or wrong vars), and runtime (vars came from outside the type system and don't match). Each error names the step, the prompt source, and the offending keys. Exact wording is fixed during planning so it stays consistent across layers and matches the public-guide examples.
- R22. Existing factory-function patterns (functions that call `step.define` per call site with different vars baked in) continue to work; the public guide includes a migration recipe for converting them into a single declared-once-reused-many-times step.
- R23. The new vars surface is purely additive — pre-existing `step.define({ promptFile, vars: { topic: 'caching' } })` invocations that bake values at module-load time continue to compile and run with the same semantics. Whether to deprecate that legacy form is an Outstanding Question.

---

## Acceptance Examples

- AE1. **Covers R3, R7.** Given a `promptFile: 'prompts/brainstorm.md'` with a sidecar declaring `{ topic: string }` and an explicit `vars: { topc: 'string' }` (typo) on `step.define`, when the workflow module loads, then a definition-time error fires that names the file, the inferred shape, and the explicit shape that disagrees.
- AE2. **Covers R7, R8.** Given a step typed with `vars: { topic: 'string', depth: 'number' }`, when an author writes `run(STEP, { vars: { topic: 'caching' } })`, then TypeScript reports `depth` as a missing required key at the call site, and if the code is compiled past the error the executor throws before the runner starts.
- AE3. **Covers R9.** Given two `run(BRAINSTORM, { vars: { topic: 'A' } })` and `run(BRAINSTORM, { vars: { topic: 'B' } })` calls in the same workflow, when the workflow is interrupted and resumed, then both calls resume from their independent cache entries — neither replays as the other and no `as:` override was required.
- AE4. **Covers R18, R20.** Given `step.define('greet', { prompt: 'Hi {{name}}' as const })` with no `vars:` declaration, when the author writes `run(greet, {})`, then TypeScript reports `name` as a missing required key — the same error shape produced by an explicitly declared contract.
- AE5. **Covers R11, R12.** Given `step.define('brainstorm', { promptFile: 'prompts/brainstorm.md' })` with no `vars:` and a generated sidecar that registers `{ topic: string }`, when the author writes `run(brainstorm, {})`, then TypeScript reports `topic` as missing — the var shape flows via `PromptFileRegistry` lookup, and the developer never typed `topic` twice.
- AE6. **Covers R14.** Given the dev watcher is running and the author edits `prompts/brainstorm.md` to add a new `{{audience}}` placeholder, when the file is saved, then the sidecar regenerates and every `run(brainstorm, ...)` call site that does not pass `audience` shows a red squiggle within roughly one save cycle.
- AE7. **Covers R15.** Given a contributor freshly clones the project and runs `bun install && orch run my-workflow` without ever invoking the dev watcher, when the workflow starts, then sidecars are generated as the first step (no-op when already current) and the workflow proceeds with correct types — the cold-clone path is not blocked on a separate setup command.
- AE8. **Covers R2, R17.** Given a step whose prompt is computed at runtime (`prompt: composePrompt(args)`, not a string literal), when the author wants type-checking, then they declare `vars:` explicitly; no codegen path covers this case and no TypeScript Language Service plugin is added to bridge the gap — the explicit declaration is the documented escape hatch.

---

## Success Criteria

- A workflow author can define a reusable step once and pass different vars per `run()` call without writing factory functions, with full TypeScript enforcement at every call site.
- For `promptFile:` with a sidecar, the var contract flows from the `.md` file to every `run()` call site automatically — the developer does not type the same variable name twice across the two surfaces.
- `bun run check` and IDE TypeScript agree about prompt vars on every workflow we ship — no surface where one is green and the other is red.
- Renaming a `{{placeholder}}` in a `.md` file produces compile-time errors at every `run()` consumer within roughly one save cycle (watcher running) or within the first `orch run` (watcher not running).
- A contributor onboarding to an orch project runs `bun install && orch run <workflow>` and gets working types without any additional setup command, watcher invocation, or `tsconfig.json` change.
- ce-plan produces a phased implementation plan without inventing API shape, validator semantics, or codegen invocation triggers — and explicitly verifies every claim flagged `[Needs verification]` in Outstanding Questions before declaring the plan ready.

---

## Scope Boundaries

- Zod schemas as the `vars` declaration syntax — explicitly rejected in favor of the simpler tag vocabulary. Zod stays the right tool for `returns:`, not for prompt interpolation.
- A TypeScript Language Service plugin that synthesizes types in-memory without writing files — rejected because `tsc` and CI ignore Language Service plugins, so IDE-only typing would let red squiggles disagree with `bun run check`. Strictly worse DX than honest codegen.
- A bundler plugin (Vite, esbuild, Webpack) as the distribution mechanism — orch is not bundler-bound; this would fragment the install path. Revisit only if user demand emerges.
- `postinstall` script that generates types at install time — Bun's `postinstall` semantics vary across workspace configs, and the user has no prompt files at install time.
- Auto-migration of existing factory-function-based steps in user workflows — the migration path is documented in the public guide but not performed automatically.
- Default values for vars, computed / derived vars (e.g., `{{topic.toUpperCase()}}`), nested key paths (`{{user.name}}`), and structured-object substitution — vars stay flat scalar substitutions. Richer composition is reachable via `loadPrompt()` plus the `RunOverrides.prompt` escape hatch.
- HTML / MDX templates — `.md` is treated as text only; no rendering pipeline.
- Localization-style multi-locale prompt selection.
- Templates loaded from non-filesystem sources (databases, network, remote URLs) — the codegen path is filesystem-only. Runtime use of `loadPrompt` with an explicit `vars:` declaration on the consuming step is the documented workaround.

---

## Key Decisions

- **Inference is the default; explicit `vars:` is the escape hatch.** Reason: with TLT inference (inline) and codegen (file-based) active, requiring developers to also declare `vars:` re-types information the framework already knows and creates drift between declaration and reality. Inference flips the question from "what do I declare?" to "what is special about my case that the framework could not infer?"
- **File-based contract flows via `PromptFileRegistry` module augmentation.** Reason: TanStack-Router-style global interface keyed by literal-string paths is the established pattern for "string path → typed module" in modern TypeScript. No `import` of the `.md`, no Language Service plugin, no bundler coupling — plain TS resolution. The sidecar emits `declare module 'orch' { interface PromptFileRegistry { 'path/to/file.md': { topic: string } } }`.
- **Vars vocabulary is `'string' | 'number' | 'boolean'` with `?` for optional.** Reason: symmetric with `{{x}}` substitution (which is stringification), zero new dependencies, fits the actual usage shape of prompt interpolation. Zod stays reserved for structured-output `returns:`.
- **Sidecar `.d.ts` lives next to the `.md` file, not under `.orch/types/` or a generated index.** Reason: picked up by default TypeScript `include` globs, requires no `tsconfig.json` changes from the user, easy to gitignore via one pattern.
- **Codegen runs in both the dev watcher AND at the start of `orch run`.** Reason: the watcher gives sub-200 ms IDE feedback during authoring; the `orch run` pass catches the cold-clone case so no contributor is blocked on a missing setup step they didn't know existed.
- **Vars are folded into the cache key automatically.** Reason: requiring `as:` per call would tax the reusable-step DX exactly where it should feel cleanest. Cache correctness is the load-bearing property; vars-in-key delivers it without authoring overhead.
- **Vendor the template-literal extractor; do not depend on `type-safe-prompt` / `ts-prompt` / `prompt-builder`.** Reason: web research (May 2026) confirmed the core trick is ~20 lines of conditional template literal types, must integrate tightly with `Step<TResult, TVars>`, and the upstream packages are small single-author projects (low star counts, single-contributor history) without the maintenance signal we want from a load-bearing dependency.
- **No off-the-shelf library covers file-based template → type generation.** Reason: confirmed by web research — `type-safe-prompt` and `ts-prompt` explicitly state file-based templates are unsupported because TypeScript cannot read file contents at type-check time. `vite-plugin-markdown` imports `.md` but does not extract placeholders. The codegen path is build-it-ourselves; the design space is closed enough that we are not reinventing a wheel.
- **No TypeScript Language Service plugin even though it would give "magic" IDE inference.** Reason: `tsc` and CI ignore Language Service plugins, so IDE-only typing would let red squiggles disagree with `bun run check`. Strictly worse DX than honest codegen.
- **No `postinstall` codegen.** Reason: Bun's `postinstall` semantics vary across workspace setups; at install time the user has no prompt files; conventional `orch run` first-pass codegen covers the cold-clone case without depending on package-manager hooks.
- **Convention over configuration for prompt paths.** Reason: most workflows fit a single default location; explicit configuration remains as an escape hatch, not as a setup tax.

---

## Dependencies / Assumptions

- The file-based prompts feature (`docs/plans/2026-05-28-001-feat-file-based-prompts-plan.md`) lands first, or folds into the same delivery as this brainstorm. This document assumes `promptFile`, `loadPrompt()`, `PromptFileError`, and the placeholder substitution engine already exist; the new work builds on top of that surface rather than replacing it.
- Bun's FS-watch APIs (or `chokidar` as a portable fallback) can sustain sub-200 ms regen latency under typical prompt counts. To be measured during planning.
- orch already has, or will gain alongside this work, a dev workflow command suitable for hosting the watcher. Exact command name is an Outstanding Question.
- The existing `RunOverrides` and `Step` types can be made generic over `TVars` without breaking the homogeneous-parallel form, the autonomous overload, the interactive overload, or the structured-output `returns:` overload. To be confirmed during planning.
- TypeScript's `declare module` augmentation pattern resolves correctly for the `orch` package when sidecars are co-located with `.md` files under the user's `include`. To be confirmed during planning with a dedicated `tsd` / `expect-type` test mimicking a real user project layout.
- Web research (May 2026) on existing TypeScript prompt-templating libraries (`type-safe-prompt`, `ts-prompt`, `prompt-builder`, `llm-exe`, `@prompt-template/core`, `vite-plugin-markdown`) confirmed: (a) several libraries do inline-string TLT inference, (b) none do file-based template → type generation, (c) all candidate libraries are small single-author projects. The vendoring decision is supported by this finding, not by speculation.

---

## Outstanding Questions

### Resolve Before Planning

- [Affects R14, R15][User decision] What is the watcher command's name and shape? Reuse an existing `orch dev` if one exists, introduce a dedicated `orch types --watch`, or attach as a `--watch` flag to `orch run`?
- [Affects R16][User decision] What is the default prompt-file path convention? Co-located next to the workflow `.ts` file (recursive discovery), a top-level `prompts/` directory, or `.orch/prompts/`?
- [Affects R23][User decision] How should the legacy define-time substitution form (`step.define({ promptFile, vars: { topic: 'caching' } })`) be treated after this lands — kept silently, kept with a runtime deprecation warning, or replaced before v1 ships?
- [Affects R4][User decision] What in-template syntax marks an optional placeholder for inference purposes — `{{x?}}`, `{{x|optional}}`, or only via explicit `vars: { x: 'string?' }` (no in-file convention)? The inferred path needs an answer or it cannot represent optional vars without explicit declaration.

### Deferred to Planning

- [Affects R11, R12][Technical][Needs verification] Confirm the `declare module 'orch' { interface PromptFileRegistry { ... } }` augmentation pattern resolves correctly when sidecars are co-located with `.md` files under typical user `tsconfig.json` `include` globs. Write a `tsd` / `expect-type` test that mimics a real user project layout. The TanStack Router precedent is cited as evidence the pattern works; verify it for orch's specific package structure.
- [Affects R14][Technical][Needs verification] Measure actual regen latency at 10 / 100 / 1000 prompt files using Bun's FS-watch APIs vs `chokidar` vs interval polling. Set a hard SLO before declaring the feature shippable. The "~200 ms" target in this document is aspirational, not measured.
- [Affects R5, R6][Technical][Needs verification] Confirm `Step<TResult, TVars>` flows cleanly through `RunFn`'s two overloads (interactive vs autonomous), `parallel()` homogeneous and heterogeneous forms, and the `returns:` schema overload without forcing duplicate generic parameters at every call site. Write `expect-type` tests covering each combination.
- [Affects R18, R19][Technical][Needs verification] Verify the vendored template-literal-types extractor handles orch-specific edge cases: optional whitespace inside braces (`{{ x }}` vs `{{x}}`), multi-line prompts, escape sequences (`\{{literal\}}`), the `?` optional suffix if R4 adopts an in-template marker, and TypeScript's recursion-depth limits for very large prompts. Cover with `tsd` tests.
- [Affects R17][Technical][Needs verification] Confirm no widely-used IDE relies on a Language Service plugin to surface red squiggles for prompt vars; if the inference path produces a standard TS error, every common editor (VS Code, JetBrains IDEs, Neovim TS LSP) shows it without orch-specific configuration.
- [Affects R8, R9][Technical] Stable JSON serialization of vars for cache-key derivation — handling of optional / undefined values, key ordering, and how floating-point numbers are normalized to avoid spurious cache misses.
- [Affects R11][Technical] Sidecar generator implementation strategy — pure TypeScript via Bun's FS APIs vs delegating to a small AST-aware library. Whether the generator emits one sidecar per `.md` file or a single combined declaration per directory.
- [Affects R21][Technical] Define-time, compile-time, and runtime error message wording — fix exact strings during planning so they match across all three layers and the public-guide examples.
- [Affects R3][Technical] Behavior when explicit `vars:` is a *strict subset* of the inferred shape (e.g., the template has `{{topic}}` and `{{depth}}`, but `vars:` declares only `{ topic: 'string' }`). Decide whether subset is a valid over-constraint move or a misuse that should throw at module load.
