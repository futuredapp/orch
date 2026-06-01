---
date: 2026-05-28
status: active
topic: file-based-prompts
type: feat
origin: docs/brainstorms/2026-05-28-feat-file-based-prompts-requirements.md
---

# feat: File-based prompts for orch workflows

## Summary

Add a file-based prompt API so workflow authors stop hand-writing multi-paragraph backticked prose inside `step.define()`. Two new shapes — a first-class `promptFile` + `vars` field on the agent step, and a `loadPrompt(path, vars)` helper for composing fragments — with strict `{{var}}` templating that errors at `step.define` / `loadPrompt` call time. Adds a new sentinel `@/...` for project-rooted shared fragments under `.orch/prompts/`, a greenfield worked example, full unit + integration test coverage, and complete docs updates across the `orch-workflow-author` skill and `docs/public/`.

---

## Problem Frame

Per origin: workflow authors are the affected party. As soon as a workflow does anything non-trivial, its `step.define()` calls fill with multi-paragraph backticked strings, and pipeline shape gets buried under prose. Markdown tooling does not run on TypeScript template literals; prose reuse is faked via ad-hoc TypeScript helpers (`sessionContext`, `findingsContract`). The `feature` workflow that triggered the brainstorm is ~270 lines, mostly prose.

The brainstorm's [Problem Frame](../brainstorms/2026-05-28-feat-file-based-prompts-requirements.md#problem-frame) names three compounding pains: reading workflow shape is hard, editing prose is hard (no MD tooling), and prose-reuse is already happening but only via string-concatenation helpers. The new API turns prose into colocated `.md` files and gives composition a real primitive instead of TypeScript helpers.

(See origin: [docs/brainstorms/2026-05-28-feat-file-based-prompts-requirements.md](../brainstorms/2026-05-28-feat-file-based-prompts-requirements.md).)

---

## Requirements

Requirements R1–R19 carried verbatim from origin. Quick traceability map (full text in origin):

| R-ID | Topic | Owning unit(s) |
| --- | --- | --- |
| R1 | `promptFile` field on both step.define overloads | U4 |
| R2 | `vars` field with `string \| number \| boolean` only | U2, U4 |
| R3 | `prompt` + `promptFile` mutually exclusive | U4 |
| R4 | `vars` without `promptFile` is an error | U4 |
| R5 | `promptFile` resolves relative to declaring workflow file | U1 |
| R6 | `@/...` sentinel resolves to project root | U1 |
| R7 | Paths escaping project root are rejected | U1 |
| R8 | `{{var}}` (Mustache-style) syntax, no `${...}` | U2 |
| R9 | Strict in both directions: missing placeholder and missing key both error | U2 |
| R10 | Error fires at `step.define()` time, not at run time | U2, U4 |
| R11 | Stringify with `String(...)` (already constrained by R2) | U2 |
| R12 | No escape syntax for literal `{{`; pass via `vars` | U2 |
| R13 | `loadPrompt(path, vars)` exported with same semantics as `promptFile` | U3 |
| R14 | `loadPrompt` is the supported composition path | U3 |
| R15 | `loadPrompt` errors at call site, synchronously | U3 |
| R16 | `orch-workflow-author` skill updated; file-based pattern is default | U7 |
| R17 | `docs/public/` updated (api.md + new guide page) | U8 |
| R18 | Greenfield worked example under `examples/` | U6 |
| R19 | No migration of existing workflows | (out of scope) |

Every R-ID is covered by at least one implementation unit. R19 is explicitly out of scope and recorded under [Scope Boundaries](#scope-boundaries).

**Acceptance Examples** AE1–AE6 from origin are mapped to specific test scenarios under each unit (cross-referenced with `Covers AE<N>` prefixes).

---

## Key Technical Decisions

Decisions resolved during planning (user-confirmed via Phase 0 questions where noted):

- **Sentinel: `@/...`** for project-rooted paths. *(User-decided.)* `promptFile: '@/prompts/session-context.md'` resolves against the project root; any other path resolves against the declaring workflow's directory. Trade-off: `@/` is a common TS path-alias prefix, which could confuse readers expecting Webpack/Vite-style alias semantics. Mitigation: docs (U8) explicitly call this out and link to `orch`'s rationale; the orch codebase does not use TS path aliases itself, so there is no in-repo collision.
- **Canonical shared-fragments folder: `.orch/prompts/`.** *(User-decided.)* Co-locates prompts with the recommended isolated `.orch/orch.config.ts` layout. The worked example (U6) lives at the project root for now (the example tree uses `examples/orch.config.ts`, not `.orch/`) — for the example, project-root resolution lands fragments under `.orch/prompts/` *inside the examples folder*, mirroring what a real orch user's project root would look like. Project-root detection reuses `findConfigPath` from `src/config/index.ts` (walks up looking for `.orch/orch.config.ts` then `orch.config.ts`).
- **Synchronous I/O.** *(User-decided.)* `step.define` stays sync (returns `Step`, not `Promise<Step>`); `loadPrompt` returns `string`, not `Promise<string>`. Backing read uses `node:fs.readFileSync` behind a new `PromptFileReader` seam so unit tests can fake reads without touching the real filesystem. The FsService is async by design and is left untouched — adding sync variants there would muddy its contract; a dedicated thin seam is the cleaner boundary. The seam is internal (not exported from `orch`) and lives under `src/core/prompt-file/` to keep the core's prompt-reading logic close to `step.define`. (R10 / R15 strictness errors fire synchronously at the `step.define` / `loadPrompt` call site.)
- **Caller-file resolution via stack-trace inspection.** `step.define` and `loadPrompt` use `new Error().stack` parsing (with `Error.captureStackTrace(err, fn)` to drop their own frame) to discover the calling workflow file's directory. This is the standard mechanism — Vitest/Jest's `vi.mock` / `jest.mock`, Vite plugins, and `tsx`/`esbuild` source-map handlers all use the same pattern. Stack format is parsed defensively (Bun and Node `at <fn> (file:///path:line:col)` / `at file:///path:line:col`) with a single test fixture for both forms. Failure to parse falls back to project-root resolution with a clear error advising `loadPrompt` callers to pass an absolute or `@/...` path.
- **Sentinel-only project-rooted form.** No separate `baseDir` option, no leading-`/` magic. One way to ask for project-rooted; everything else is workflow-local.
- **Resolved prompt stored in existing `prompt` field.** After `step.define` resolves `promptFile + vars`, the substituted string is placed in `AgentStepConfig.prompt` (the existing field), so downstream executors observe no shape change. The original `promptFile` path is retained on the config for observability (log lines naming the source file). `vars` is *not* retained — its lifecycle ends at resolution. (Resolves origin "Outstanding Questions → R10 storage shape".)
- **`{{var}}` lexer is a deliberately tiny regex** (`/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g`). Identifier rules match TypeScript variable conventions; whitespace inside braces is tolerated (`{{ foo }}` is equivalent to `{{foo}}`); anything not matching that shape is a literal pass-through (so a Markdown link `[{{foo}}](url)` works, but a stray `{{ ` doesn't accidentally start a placeholder). No nested braces, no helpers, no triple-brace, no escapes — R12.
- **Error messages standardize on the existing orch convention** (`step.define("<name>"): <what was wrong> — <how to fix>`). New error class `PromptFileError extends Error` carries `{ stepName?: string, promptFile?: string, cause?: 'mutex' | 'vars-without-file' | 'missing-placeholder' | 'extra-key' | 'unsupported-type' | 'read-failed' | 'traversal' }` for structured handling and tests. Single class to keep the public error surface small.

---

## High-Level Technical Design

This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.

```text
                  ┌────────────────────────────────────────────────────┐
                  │  Workflow author writes:                            │
                  │    step.define('brainstorm', {                      │
                  │      agent: claude(),                               │
                  │      promptFile: 'brainstorm.md',                   │
                  │      vars: { userPrompt },                          │
                  │    })                                               │
                  └─────────────────────┬──────────────────────────────┘
                                        │
                  step.define (sync)    │
                                        ▼
        ┌──────────────────────────────────────────────────────────────┐
        │  1. Validate field combinations (R3, R4, R2 type check)      │
        │  2. callerDir() — stack-parse caller's file → dirname         │
        │  3. resolvePromptPath(promptFile, callerDir, projectRoot)    │
        │       - leading "@/" → project root                          │
        │       - else        → callerDir                              │
        │       - assert resolved path stays inside projectRoot (R7)   │
        │  4. PromptFileReader.readSync(resolved) → file contents      │
        │  5. substitute(template, vars)                               │
        │       - validate { strict, both directions } (R9)            │
        │       - String(...) numbers/booleans (R11)                   │
        │       - throws PromptFileError on any mismatch (R10)         │
        │  6. AgentStepConfig.prompt = substituted string              │
        │     AgentStepConfig.promptFile = resolved path (observability) │
        └──────────────────────────────────────────────────────────────┘

  loadPrompt(path, vars) takes the same pipeline starting at step 2
  (callerDir is loadPrompt's own caller) and returns the substituted
  string for inline composition in TypeScript.
```

Key invariant: once `step.define` returns, the step looks identical in shape to one defined with inline `prompt:`. No downstream executor, runner, or state-store code needs to know about `promptFile`.

---

## Output Structure

New files this plan introduces (the per-unit `**Files:**` sections are authoritative for what each unit produces):

```text
src/core/prompt-file/
├── index.ts                        — barrel: loadPrompt, PromptFileError, types
├── prompt-file-reader.ts           — sync read seam (PromptFileReader interface + node:fs impl)
├── fake-prompt-file-reader.ts      — in-memory fake for unit tests
├── resolve-prompt-path.ts          — @/... sentinel + traversal guard
├── caller-dir.ts                   — stack-parse caller file → dirname
├── substitute.ts                   — strict {{var}} substitution + error types
└── load-prompt.ts                  — public loadPrompt(path, vars) helper

examples/file-prompts-demo/
├── index.ts                        — 3-step workflow demonstrating the new API
├── slug.md                         — promptFile, workflow-local
├── research.md                     — promptFile + loadPrompt composition
└── summarize.md                    — promptFile, references shared fragment

examples/.orch/prompts/
└── session-context.md              — shared fragment, referenced via @/ sentinel

docs/public/guides/
└── file-based-prompts.md           — new how-to guide (sidebar entry)

tests/unit/core/prompt-file/
├── caller-dir.test.ts
├── resolve-prompt-path.test.ts
├── substitute.test.ts
├── load-prompt.test.ts
└── step-define-prompt-file.test.ts

tests/integration/core/
└── prompt-file-workflow.test.ts    — end-to-end workflow loading
```

Modified files (touched, not created — see unit `**Files:**` for the full list):

```text
src/core/step.ts                            — wire promptFile/vars into defineStep
src/core/index.ts                           — re-export loadPrompt, PromptFileError
docs/public/reference/api.md                — AgentStepConfig fields + loadPrompt signature
docs/public/.vitepress/config.mts           — sidebar entry for new guide
.claude/skills/orch-workflow-author/SKILL.md
.claude/skills/orch-workflow-author/references/prompt-patterns.md
.claude/skills/orch-workflow-author/references/templates.md
.claude/skills/orch-workflow-author/references/api.md
examples/orch.config.ts                     — register file-prompts-demo workflow
```

---

## Implementation Units

### U1. Path resolution and caller-file detection

**Goal:** Resolve a `promptFile` string into an absolute `Path`, honoring the `@/` sentinel and rejecting traversal.

**Requirements:** R5, R6, R7.

**Dependencies:** none.

**Files:**

- `src/core/prompt-file/caller-dir.ts` (new) — `callerDir(skipFn: Function): Path` using `Error.captureStackTrace`.
- `src/core/prompt-file/resolve-prompt-path.ts` (new) — `resolvePromptPath(input: string, callerDir: Path, projectRoot: Path): Path`.
- `src/core/prompt-file/index.ts` (new) — re-export resolve helpers.
- `tests/unit/core/prompt-file/caller-dir.test.ts` (new)
- `tests/unit/core/prompt-file/resolve-prompt-path.test.ts` (new)

**Approach:**

- `callerDir(skipFn)` constructs `new Error()`, calls `Error.captureStackTrace(err, skipFn)` so the immediate caller of `skipFn` becomes the top frame, then parses the first `file://` URL (or absolute path) from the stack via `fileURLToPath` (`import { fileURLToPath } from 'node:url'`). Returns the dirname as a `Path`. Throws `PromptFileError({ cause: 'read-failed' })` with a clear message if the stack cannot be parsed (this is the fallback path).
- `resolvePromptPath(input, callerDir, projectRoot)`:
  - If `input.startsWith('@/')` → resolve `${projectRoot}/${input.slice(2)}`.
  - Else → resolve `${callerDir}/${input}`.
  - Normalize using `node:path.resolve`.
  - Assert the normalized path is inside `projectRoot` (string `.startsWith(projectRoot + sep)` or equal); throw `PromptFileError({ cause: 'traversal' })` otherwise. (R7.)
  - Return as branded `Path` via `path()`. Note: `path()` rejects `..` components, so the normalize-then-`path()` round-trip is the final guard.
- Project root is supplied by the caller of `step.define` — the orch core resolves it lazily on first use via `findConfigPath(process.cwd(), { exists: ... })` reused from `src/config/index.ts`. To keep `step.define` sync, U1 adds a sync sibling: `findConfigPathSync` (or inlines the small walk-up loop using `node:fs.statSync`). If no `orch.config.ts` is found upward, project root defaults to `process.cwd()` and a debug log line records the fallback.

**Patterns to follow:**

- `src/config/index.ts` `findConfigPath` — same walk-up shape, sync variant.
- `src/services/types.ts` `path()` — branded type construction with traversal guard.
- `src/observability/orch-version.ts:28` — `fileURLToPath(import.meta.url)` pattern.

**Test scenarios:**

- `callerDir` returns the directory of the test file itself when called from a test (round-trip sanity).
- `callerDir` skips a wrapper function frame correctly when passed as `skipFn` (sentinel: wrapper file's dir is NOT returned).
- `callerDir` parses both Bun-style (`at file:///path/foo.ts:10:5`) and Node-style (`at /path/foo.ts:10:5`) stack frames — fixture lines fed via a helper that throws a synthetic error with a hand-crafted stack.
- `callerDir` throws `PromptFileError({ cause: 'read-failed' })` when the stack is unparseable (empty stack fixture).
- `resolvePromptPath('foo.md', '/proj/examples/foo', '/proj')` returns `/proj/examples/foo/foo.md`.
- `resolvePromptPath('@/prompts/session-context.md', '/proj/examples/foo', '/proj')` returns `/proj/prompts/session-context.md`. **Covers AE4** (same shared fragment from two different workflow dirs both resolve to the project-rooted path).
- `resolvePromptPath('../../etc/passwd', '/proj/examples/foo', '/proj')` throws `PromptFileError({ cause: 'traversal' })`. **Covers R7.**
- `resolvePromptPath('@/../outside.md', '/proj/examples/foo', '/proj')` throws `PromptFileError({ cause: 'traversal' })`.
- `resolvePromptPath('subdir/nested.md', '/proj/examples/foo', '/proj')` returns the workflow-local nested path.

### U2. Strict `{{var}}` templater + error type

**Goal:** Substitute `{{var}}` placeholders in a string against a typed-`vars` record; error on either-direction mismatches.

**Requirements:** R2, R8, R9, R10, R11, R12.

**Dependencies:** none (consumed by U3 and U4).

**Files:**

- `src/core/prompt-file/substitute.ts` (new) — `substitute(template: string, vars: PromptVars): string`, plus internal `PromptVars` type.
- `src/core/errors.ts` — add `PromptFileError` class with `cause` discriminator, OR new `src/core/prompt-file/errors.ts` re-exported via `src/core/errors.ts`. Choice deferred to implementation; either lives behind the existing `errors.ts` barrel.
- `tests/unit/core/prompt-file/substitute.test.ts` (new)

**Approach:**

- `PromptVars = Readonly<Record<string, string | number | boolean>>` enforced by a runtime assertion (`assertPromptVars(vars)`) since TypeScript can't catch every misuse from JS callers and the brainstorm explicitly requires runtime validation. Rejects: `undefined`, `null`, arrays, plain objects, `Symbol`, `bigint`. (R2, R11.)
- `substitute(template, vars)`:
  1. Find every `{{...}}` match via the regex above. Identifier must match `/^[a-zA-Z_][a-zA-Z0-9_]*$/`; otherwise the literal stays in place (e.g., `{{ a.b }}` is not a placeholder).
  2. Build a `Set<string>` of placeholder names found.
  3. Build a `Set<string>` of `vars` keys provided.
  4. Compute `missing = placeholders - keys` (used in template but no value supplied) and `extra = keys - placeholders` (supplied but unused).
  5. If either set is non-empty, throw `PromptFileError({ cause: 'missing-placeholder' | 'extra-key', missing, extra })` with a message naming both sets and pointing the author at the file. (R9.)
  6. Otherwise replace each placeholder with `String(vars[name])` (R11).
- `String()` rules: strings pass through unchanged, numbers stringify decimal (`String(42) === '42'`, `String(NaN) === 'NaN'`), booleans stringify lowercase (`String(true) === 'true'`). No locale-aware formatting; the brainstorm asked for template-literal parity.

**Patterns to follow:**

- `src/core/errors.ts` for the error-class shape (matches `StepError`, `AskNoDefaultError`, etc.).
- `src/core/run-mode.ts` `RunModeError` for the discriminated-union error pattern.

**Test scenarios:**

- `substitute('Hello {{name}}', { name: 'world' })` returns `'Hello world'`. **Covers AE1.**
- `substitute('{{ name }}', { name: 'x' })` returns `'x'` (whitespace tolerance).
- `substitute('count={{n}}', { n: 42 })` returns `'count=42'` (number stringify, R11).
- `substitute('on={{flag}}', { flag: true })` returns `'on=true'` (boolean stringify, R11).
- `substitute('Hello {{userPrompt}}', { user_prompt: 'x' })` throws `PromptFileError({ cause: 'missing-placeholder' })` whose message names both `userPrompt` (missing) and `user_prompt` (extra). **Covers AE3.**
- `substitute('plain text', { extra: 'x' })` throws `PromptFileError({ cause: 'extra-key' })` naming `extra`.
- `substitute('{{a}} {{b}}', { a: 'x', b: 'y' })` returns `'x y'`.
- `substitute('{{a}}', { a: 'x', b: 'y' })` throws (`extra: ['b']`).
- `substitute('{{a}} {{a}}', { a: 'x' })` returns `'x x'` (same placeholder used twice — not an extra-key error).
- `substitute('literal { { not-a-placeholder } }', {})` returns the input unchanged (spaces between braces disqualify).
- `substitute('a.b: {{ a.b }}', {})` returns the input unchanged (invalid identifier inside braces).
- `substitute('${greeting}', { greeting: 'x' })` returns `'${greeting}'` literally (R8: no `${...}` interpolation, no escape needed).
- `assertPromptVars({ items: ['a', 'b'] })` throws `PromptFileError({ cause: 'unsupported-type' })` whose message names `items`, the unsupported type (`array`), AND suggests `loadPrompt` for composition. **Covers AE6.**
- `assertPromptVars({ x: null })` throws `unsupported-type` for `null`.
- `assertPromptVars({ x: undefined })` throws `unsupported-type` for `undefined`.
- `assertPromptVars({ x: { nested: 1 } })` throws `unsupported-type` for plain objects.

### U3. `loadPrompt` helper

**Goal:** Export a `loadPrompt(path, vars)` function with the same semantics as `promptFile` for composition cases.

**Requirements:** R13, R14, R15.

**Dependencies:** U1 (path resolution), U2 (substitute).

**Files:**

- `src/core/prompt-file/load-prompt.ts` (new) — the public function.
- `src/core/prompt-file/prompt-file-reader.ts` (new) — sync read seam interface + `node:fs` impl + project-root-detection wiring.
- `src/core/prompt-file/fake-prompt-file-reader.ts` (new) — in-memory fake used by U3, U4 tests.
- `src/core/prompt-file/index.ts` — export `loadPrompt`, `PromptFileError`, `PromptVars`.
- `tests/unit/core/prompt-file/load-prompt.test.ts` (new)

**Approach:**

- `interface PromptFileReader { readSync(path: Path): string; projectRoot(): Path }`. The `node:fs` impl wraps `readFileSync(p, 'utf8')` and the sync project-root walk-up; the fake takes a `Map<string, string>` of files plus a project root.
- A module-level mutable singleton holds the active reader. Default is the `node:fs` impl. Tests override it via an exported `__setPromptFileReader(reader)` helper (named with leading underscores to signal test-only; not part of the documented public surface). The brainstorm's testing rule ("mock only at the edge") is satisfied — the reader is the edge.
- `loadPrompt(input: string, vars: PromptVars): string`:
  1. `assertPromptVars(vars)` (U2 reuse).
  2. `callerDir(loadPrompt)` (U1) → `dir`.
  3. `resolvePromptPath(input, dir, reader.projectRoot())` (U1) → `resolved`.
  4. `reader.readSync(resolved)` → `template`. Wrap any thrown error in `PromptFileError({ cause: 'read-failed', promptFile: resolved })`.
  5. `substitute(template, vars)` (U2) → return.
- All errors fire synchronously at the `loadPrompt` call site — preserving the R15 / R10 property when called from module top or inside the workflow factory.

**Patterns to follow:**

- `src/services/fs/fs-service.ts` — the `FsService` interface shape (but kept async; we deliberately do not extend it; see Key Technical Decisions).
- `src/services/fs/fake-fs-service.ts` — the in-memory `Map`-backed fake pattern.

**Test scenarios:**

- `loadPrompt('greeting.md', { name: 'world' })` returns the substituted file contents when the fake reader has `greeting.md → 'Hello {{name}}'`.
- `loadPrompt('@/shared/preamble.md', vars)` resolves the project-rooted path against the fake's project root. **Covers AE5** (combined with the composition test below).
- `loadPrompt('intro.md', vars) + loadPrompt('@/.orch/prompts/session-context.md', vars)` produces the substituted concatenation. **Covers AE5.**
- `loadPrompt('missing.md', {})` throws `PromptFileError({ cause: 'read-failed' })` naming the resolved path when the fake reader has no entry for it.
- `loadPrompt('foo.md', { name: 'x' })` propagates `PromptFileError({ cause: 'missing-placeholder' })` from U2 when the file uses `{{title}}`.
- `loadPrompt('../../etc/passwd', {})` throws `PromptFileError({ cause: 'traversal' })` (R7).
- `loadPrompt('foo.md', { items: ['a'] })` throws `PromptFileError({ cause: 'unsupported-type' })` (R2 enforcement at the loadPrompt edge).
- Composition: substituting the same `vars` against two different fragments produces independently-substituted strings (no shared state between calls).

### U4. `step.define` accepts `promptFile` and `vars`

**Goal:** Wire the new fields into both `step.define` overloads, validate mutual-exclusion rules, resolve and substitute at define time, store the resolved string in the existing `prompt` field.

**Requirements:** R1, R2, R3, R4, R10, R11.

**Dependencies:** U1, U2, U3 (reuses the same reader and resolution helpers).

**Files:**

- `src/core/step.ts` — extend `InteractiveStepInput` and `AutonomousStepInput<T>` with optional `promptFile?: string` and `vars?: PromptVars`. Extend `defineStep` to enforce R3/R4 and call the resolution pipeline.
- `src/core/step.ts` — extend `AgentStepConfig` with `readonly promptFile?: Path` (observability; never reads `vars` after substitution).
- `tests/unit/core/prompt-file/step-define-prompt-file.test.ts` (new) — full coverage of mutex + resolution path for both overloads.

**Approach:**

- Add to both overload input types:

  ```ts
  readonly promptFile?: string
  readonly vars?: PromptVars
  ```

  Both default-optional. The existing `prompt?: string` stays untouched.
- In `defineStep`, after the existing reserved-prefix / interactive / autoStop guards, add a new `assertPromptFieldsValid(name, config)` step that runs *before* `assertViewFieldsValid`:
  - If `config.promptFile !== undefined && config.prompt !== undefined` → throw `PromptFileError({ cause: 'mutex' })` with message `step.define("<name>"): cannot set both "prompt" and "promptFile" — pick one`. **Covers AE2 (R3).**
  - If `config.vars !== undefined && config.promptFile === undefined` → throw `PromptFileError({ cause: 'vars-without-file' })` with message `step.define("<name>"): "vars" is only valid with "promptFile" — set promptFile, or use loadPrompt() for composition`. (R4.)
  - If `config.promptFile !== undefined`:
    - `assertPromptVars(config.vars ?? {})` (R2).
    - `dir = callerDir(defineStep)` (U1).
    - `resolved = resolvePromptPath(config.promptFile, dir, reader.projectRoot())` (U1).
    - `template = reader.readSync(resolved)` (U3 reader, wrapped error).
    - `substituted = substitute(template, config.vars ?? {})` (U2).
    - Build the final config as `{ kind: 'agent', ...rest, prompt: substituted, promptFile: resolved }` (stripping `vars` from the stored config).
  - If neither `promptFile` nor `prompt` is set — that is already the existing legal shape (some steps use only `extraPrompt` overrides at `run()` time). No new rule.
- `vars` is **not** stored on the resulting config (decision: it has no downstream use after substitution).
- Both interactive and autonomous overloads accept the new fields identically; the existing `mode: 'interactive'` / `returns:` rule is unchanged.
- The `extraPrompt` / `extraContext` overrides at `run()` time still work — they append to whatever `prompt` field is now present, including the substituted one.

**Patterns to follow:**

- `src/core/step.ts` `assertViewFieldsValid` — same shape: pure-validation helper called from `defineStep`.
- `src/core/errors.ts` for error shape; `step.define("<name>"): <what> — <how to fix>` message pattern matches existing throws in `step.ts:174–189`.

**Test scenarios:**

- `step.define('foo', { agent, promptFile: 'foo.md', vars: { name: 'x' } })` returns a `Step` whose `config.prompt` is the substituted file content and `config.promptFile` is the resolved absolute path. **Covers AE1 (R1, R5).**
- `step.define('foo', { agent, prompt: 'inline', promptFile: 'foo.md' })` throws `PromptFileError({ cause: 'mutex' })` naming the step. **Covers AE2 (R3).**
- `step.define('foo', { agent, vars: { x: 'y' } })` throws `PromptFileError({ cause: 'vars-without-file' })`. **Covers R4.**
- `step.define('foo', { agent, promptFile: 'foo.md', vars: { items: ['a'] } })` throws `PromptFileError({ cause: 'unsupported-type' })`. **Covers AE6 (R2).**
- `step.define('foo', { agent, promptFile: 'foo.md' })` (no `vars`) still works when the file has no placeholders; returns substituted prompt equal to file contents.
- `step.define('foo', { agent, promptFile: 'foo.md' })` throws when the file has `{{name}}` and no `vars` is supplied (`cause: 'missing-placeholder'`).
- `step.define('foo', { agent, promptFile: 'foo.md', vars: { name: 'x' } })` throws when the file has no placeholders (`cause: 'extra-key'`).
- Interactive overload: `step.define('chat', { agent, mode: 'interactive', promptFile: 'chat.md', vars: { topic: 'x' } })` works identically and produces an interactive step.
- Interactive overload: `step.define('chat', { agent, mode: 'interactive', promptFile: 'chat.md', returns: schema(...) })` throws the existing "interactive cannot have returns" error (regression guard — new fields do not weaken existing rules).
- Step is `Object.freeze`d (existing behavior preserved); the new `promptFile` field on `config` is read-only.
- `step.define('foo', { agent, promptFile: '@/.orch/prompts/preamble.md', vars: { user: 'x' } })` resolves to the fake reader's project-rooted entry. **Covers AE4.**
- `step.define('foo', { agent, promptFile: '../escape.md' })` throws `cause: 'traversal'` (R7).

### U5. Public barrel exports

**Goal:** Export `loadPrompt`, `PromptFileError`, and the `PromptVars` type from `orch` so workflow authors can `import { loadPrompt } from 'orch'`.

**Requirements:** R13, R14.

**Dependencies:** U3, U4.

**Files:**

- `src/core/index.ts` — re-export from `./prompt-file/index.ts`.
- `src/index.ts` — already re-exports `* from './core/index.ts'`; no change needed unless an explicit name conflict surfaces.
- `tests/unit/barrel.test.ts` — extend the existing public-surface snapshot/list to include `loadPrompt`, `PromptFileError`, `PromptVars`.

**Approach:**

- Add to `src/core/index.ts`:

  ```ts
  export { loadPrompt, PromptFileError } from './prompt-file/index.ts'
  export type { PromptVars } from './prompt-file/index.ts'
  ```

- The `step.define()` extensions (`promptFile`, `vars` fields) are accessible via the existing `step` export with no additional barrel work.
- The internal helpers (`callerDir`, `resolvePromptPath`, `substitute`, `PromptFileReader`, `FakePromptFileReader`, `__setPromptFileReader`) are **not** exported from `src/core/index.ts`. Tests that need the fake reader import it directly from `src/core/prompt-file/fake-prompt-file-reader.ts`. This keeps the public surface minimal and matches CLAUDE.md rule 7 ("Single public barrel per module") in spirit — the prompt-file module's barrel is `src/core/prompt-file/index.ts`, which exports only the public-facing names.

**Patterns to follow:**

- `src/core/index.ts` existing re-exports (e.g., the way `ask` is exposed but `ink-prompt-service` internals are not exported to userland).

**Test scenarios:**

- `import { loadPrompt, PromptFileError } from 'orch'` (via the existing `barrel.test.ts` style) succeeds and both are functions/classes.
- `import { loadPrompt } from '../../src/index.ts'` from a test file works identically to the `'orch'` import (sanity, since `barrel.test.ts` uses the relative path).
- `loadPrompt`'s function type matches `(path: string, vars: PromptVars) => string` (compile-time check via `.test-d.ts` or runtime via `typeof`).
- `PromptFileError instanceof Error` is `true`.
- The internal helpers (`callerDir`, `resolvePromptPath`, `substitute`) are **not** exported from `'orch'` (assert via `Object.keys` of the namespace import — they should be absent).

### U6. Greenfield worked example: `examples/file-prompts-demo/`

**Goal:** A small, real workflow that demonstrates every new surface: workflow-local `promptFile`, project-rooted `@/...` `promptFile`, `vars`, and `loadPrompt` composition. Built greenfield (R18) — not retrofitted.

**Requirements:** R18.

**Dependencies:** U1–U5.

**Files:**

- `examples/file-prompts-demo/index.ts` (new) — ~50–70 lines, 3 steps.
- `examples/file-prompts-demo/slug.md` (new) — workflow-local, uses `{{userPrompt}}`.
- `examples/file-prompts-demo/research.md` (new) — workflow-local, uses `{{slug}}` and `{{sessionsDir}}`.
- `examples/file-prompts-demo/summarize.md` (new) — workflow-local, uses `{{sessionsDir}}`.
- `examples/.orch/prompts/session-context.md` (new) — shared fragment referenced via `@/.orch/prompts/session-context.md` from the `research` step's `loadPrompt` call.
- `examples/orch.config.ts` — register `'file-prompts-demo': 'file-prompts-demo/index.ts'`.

**Approach:**

- 3-step pipeline: `slug` (autonomous, haiku, returns `{ slug }`) → `research` (autonomous, claude, writes a `findings.md`) → `summarize` (autonomous, claude, writes a `summary.md`).
- Step 1 (`slug`): `promptFile: 'slug.md', vars: { userPrompt: args.prompt }` — workflow-local.
- Step 2 (`research`): uses `loadPrompt` composition to glue `research.md` + the shared `@/.orch/prompts/session-context.md` and feeds the result via the standard inline `prompt:` field — exact pattern from AE5.
- Step 3 (`summarize`): `promptFile: 'summarize.md', vars: { sessionsDir }` — workflow-local, no composition.
- Every step's `step.define()` call fits on roughly one screen — the success criterion stated in the brainstorm.
- The workflow runs end-to-end against real CLIs only in environment-gated tests (not the default `bun run check` gate). It is exercised at unit/integration level via fake runners in U6's tests.

**Patterns to follow:**

- `examples/feature-loop/index.ts` for the small, module-top-defined step layout.
- `workflows/new-feature/index.ts` for the slug-generation + sessions-dir threading.
- `.claude/skills/orch-workflow-author/references/prompt-patterns.md` for prompt content (slash command on line 1, hard constraints, stop condition).

**Test scenarios:**

- The workflow module imports successfully and produces a `WorkflowExecutor` (`import('examples/file-prompts-demo/index.ts')` resolves without throwing — sanity that `step.define()` calls succeed at module load).
- Each step's `config.prompt` field contains the expected substituted content after `step.define()` runs — verified by running a tiny test that drives the workflow module and inspects exported step constants (if the example exports them) or by reusing the workflow-loading harness from `tests/integration/cli/`.
- The shared `session-context.md` is referenced via the project-rooted form and resolves identically when invoked from either of two distinct workflow directories (use a second tiny fixture workflow under `tests/fixtures/` that loads the same fragment — proves project-root resolution is callsite-independent). **Re-covers AE4 in integration form.**
- A typo (`vars: { user_prompt: ... }` instead of `userPrompt`) introduced into the example throws at module-load — proven by a regression test that imports the example with a fake reader returning a deliberately-misnamed file, asserting the error message names both placeholder and key. **Covers AE3 at integration scope.**

### U7. Update `orch-workflow-author` skill

**Goal:** The skill presents file-based prompts as the default authoring pattern. Inline `prompt` strings remain documented as the trivial-case option.

**Requirements:** R16.

**Dependencies:** U1–U5 (so the documented API matches reality).

**Files:**

- `.claude/skills/orch-workflow-author/SKILL.md` — Phase 2 / Phase 3 prose: change "Suggested prompts" guidance to recommend `promptFile` + sibling `.md` for any step whose prompt exceeds ~3 sentences; show the inline form only for trivial prompts.
- `.claude/skills/orch-workflow-author/references/prompt-patterns.md` — add a "Where prompt text lives" section near the top that contrasts inline vs file-based, with a worked example pointing at `examples/file-prompts-demo/`.
- `.claude/skills/orch-workflow-author/references/templates.md` — update or add a template that uses `promptFile` end-to-end.
- `.claude/skills/orch-workflow-author/references/api.md` — add `promptFile`, `vars`, and `loadPrompt` to the API reference inside the skill.

**Approach:**

- Establish the convention: "If a step's prompt is more than ~3 sentences, put it in a sibling `.md` file." Document the `@/` sentinel and the `.orch/prompts/` shared-fragment convention. Cross-link `examples/file-prompts-demo/` as the worked reference.
- Preserve the existing "slash command on line 1" rule from `prompt-patterns.md` — the rule transfers unchanged to `.md` files.
- The skill's Phase 2 "Suggested prompts" output still includes the prose; only the recommended way to drop that prose into the eventual TypeScript file changes (sibling `.md` instead of backtick string).
- Migration: the skill does **not** recommend retrofitting existing inline prompts (R19) — only new work uses the file pattern by default.

**Patterns to follow:**

- The skill's existing voice and structure — don't rewrite from scratch.
- `docs/getting-started.md` and `docs/public/` for tone consistency.

**Test scenarios:**

- `Test expectation: none -- this unit is documentation-only.` However, U7 has one mechanical check: run `bun run check` after edits to confirm nothing in the skill references non-existent symbols (the skill markdown is not parsed by tsc, but its example snippets must use names exported in U5 — verified by visual review against `src/core/index.ts` during the implementation pass).

### U8. Update `docs/public/` user-facing documentation

**Goal:** `docs/public/reference/api.md` reflects the new `step.define` fields and `loadPrompt`. A new how-to guide page teaches the pattern. Sidebar updated.

**Requirements:** R17.

**Dependencies:** U1–U5 (so signatures match reality), U6 (so the guide can link to a real example).

**Files:**

- `docs/public/reference/api.md` — add `promptFile` and `vars` rows to the `AgentStepConfig` table at lines ~80–90; add a new `## loadPrompt` section after `## step.define` quoting the real signature from `src/core/prompt-file/load-prompt.ts`.
- `docs/public/guides/file-based-prompts.md` (new) — full how-to following the doc-writer template (H1, "what you'll learn" callout, runnable example with imports, "Where to go next" linking to the API reference and the example).
- `docs/public/guide/4-writing-a-workflow.md` — add a short subsection (~10 lines) near "Defining several steps" that introduces the file-based pattern by reference, links to the new how-to guide. Stay top-to-bottom (no forward refs).
- `docs/public/examples.md` — add an entry pointing at `examples/file-prompts-demo/`.
- `docs/public/.vitepress/config.mts` — add `{ text: 'File-based prompts', link: '/guides/file-based-prompts' }` to the Guides sidebar section (alphabetic placement).

**Approach:**

- Follow `doc-writer` skill rules: signatures quoted verbatim from `src/`, runnable examples with imports, no forward references in the numbered guide.
- The new how-to guide page covers:
  - When to use `promptFile` (any step with >3-sentence prompt) vs inline (trivial prompts).
  - The `@/` sentinel and `.orch/prompts/` convention.
  - `loadPrompt` for composition; the AE5 pattern verbatim.
  - The strictness rules (R9, R12) and a worked error example.
  - Link to `examples/file-prompts-demo/`.
- The api.md table update preserves the existing 7-row structure; two new rows for `promptFile` and `vars`. New `## loadPrompt` section sits between `## step.define` and `## ask`.
- Visual: a small mermaid sequence diagram in the guide showing "workflow load → step.define → file read → substitute → store on AgentStepConfig" (optional, only if it clarifies; doc-writer judgment).

**Patterns to follow:**

- `docs/public/guides/typed-returns.md` for the how-to-guide page template (a runnable end-to-end example with imports, "Where to go next" footer).
- `docs/public/reference/api.md` existing field-table format.

**Test scenarios:**

- `Test expectation: none -- this unit is documentation-only.` However, U8 carries the mandatory `bun run docs:build` gate from CLAUDE.md (dead-link check). One automated assertion: a unit test under `tests/unit/barrel.test.ts` (or a sibling) cross-checks that every name in `docs/public/reference/api.md`'s headings exists as an export from `src/index.ts` — the existing api.md sync test if any (see `docs/public/reference/api.md` mentions in `tests/`), or add one if the convention is missing. The doc-writer skill calls out this sync requirement explicitly.

**Execution note:** Before writing the guide, re-read `docs/public/guide/3-core-concepts.md` and `docs/public/guides/typed-returns.md` for voice and structure. The doc-writer skill (`.claude/skills/doc-writer/SKILL.md`) is the authority.

### U9. End-to-end workflow integration test + CI gates

**Goal:** One integration-tier test that exercises the full path (real `node:fs` read, real `step.define`, real workflow loader) against the greenfield example using `FakeRunner` for agent execution. Confirms `bun run check` and `bun run docs:build` pass.

**Requirements:** integration coverage of R1–R15 in a single test; doc-build gate (R17).

**Dependencies:** U1–U8.

**Files:**

- `tests/integration/core/prompt-file-workflow.test.ts` (new) — drives `examples/file-prompts-demo/index.ts` end-to-end with a `FakeRunner`.
- No source changes; this unit is gates + final integration test.

**Approach:**

- Import the example workflow module directly (real `node:fs` read this time, no fake reader), build a fake-runner-backed run harness from `tests/helpers/`, execute the workflow with a synthetic prompt, and assert that:
  - Each step's prompt (observable via runner spawn capture) matches what we'd expect after substitution against the real `.md` files.
  - The project-rooted shared fragment is present in step 2's prompt.
- Add (or extend, if it exists) an automated check that `src/core/index.ts` exports `loadPrompt` and `PromptFileError` — covered by U5's barrel test but worth a single line of duplication here for the integration tier.
- Run `bun run docs:build` locally; address any dead-link or build errors before completion.
- Run `bun run check` locally; address any lint, type, or test errors.

**Patterns to follow:**

- `tests/integration/core/workflow.test.ts` for the workflow-loading harness pattern.
- `tests/integration/cli/` for an existing end-to-end workflow loader (find the closest analogue at implementation time).

**Test scenarios:**

- Loading `examples/file-prompts-demo/index.ts` resolves without error; the workflow module exports a default `WorkflowExecutor`.
- Running the workflow with `args.prompt: 'add a CSV exporter'` produces three `FakeRunner` spawn captures whose prompts contain the substituted `userPrompt` / `slug` / `sessionsDir` values from the corresponding `.md` files.
- Step 2's captured prompt contains the verbatim text of `examples/.orch/prompts/session-context.md` (proving the `@/` sentinel resolution worked end-to-end).
- A regression test: temporarily breaking one of the `.md` files (e.g., editing `slug.md` to use `{{user_prompt}}` instead of `{{userPrompt}}`) makes the workflow module load fail with `PromptFileError({ cause: 'missing-placeholder' })` — proven by a separate fixture file under `tests/fixtures/prompt-file-workflows/broken-typo/` that is structurally identical but intentionally broken.
- `bun run check` passes after all units land.
- `bun run docs:build` passes (no dead links) after U8.

**Execution note:** Run as the final unit; it is the gate. If any earlier unit's tests fail, fix at source rather than masking in this unit.

---

## Scope Boundaries

### In scope

Everything in [Requirements](#requirements) R1–R18.

### Deferred to Follow-Up Work

- **Retrofitting existing workflows** (`feature.ts`, `examples/compound`, `examples/feature-loop`, `workflows/new-feature/`) to use `promptFile`. R19 explicitly defers this; the new pattern proves itself on the greenfield example first.
- **A second how-to guide** showing the migration pattern for retrofitting an old workflow. Defer until at least one retrofit has been done in anger.
- **Project-root memoization.** The first call to `findConfigPathSync` walks the filesystem; subsequent calls within the same process could cache the result. Skip for now — workflow modules typically load once per process and the walk is cheap.

### Outside this product's identity

- **Type-safe per-prompt argument schemas** (Zod schemas embedded in frontmatter, codegen of `.d.ts` from `.md` files, or `.prompt.ts` modules exporting a typed function). Acknowledged future possibility in origin; remains explicitly out.
- **In-file partials, includes, or `{{> partial}}` directives.** Composition is `loadPrompt` in TypeScript.
- **Conditional logic, loops, or any expression language inside prompt files.**
- **A lenient/forgiving templating mode.** Strict is the only mode.
- **An escape syntax for literal `{{`.** Pass it as a `vars` value if needed.
- **Cross-language extensions** (`.txt`, `.prompt`, `.hbs`). Convention is `.md`; orch does not enforce it but does not advertise other extensions.
- **Editor / IDE affordances** (`{{var}}` linting, jump-to-definition from `promptFile: 'x.md'`, schema-aware autocomplete on `vars`).
- **Cache invalidation on prompt-text change.** Step-name memoization is unchanged from origin; whether changing prompt text re-runs a step is the same question it has always been.

---

## System-Wide Impact

| Surface | Impact |
| --- | --- |
| `src/core/step.ts` | Two new optional fields on both overload inputs; one new field on `AgentStepConfig`. Existing call sites unaffected (`prompt?: string` semantics preserved). |
| `src/core/index.ts` | Two new exports (`loadPrompt`, `PromptFileError`) and one new type export (`PromptVars`). |
| `src/index.ts` | No change required — `* from './core/index.ts'` picks up the new exports. |
| `FsService` / `BunFsService` / `FakeFsService` | **Untouched.** New sync `PromptFileReader` seam lives in `src/core/prompt-file/`, not in services. |
| Runners (`ClaudeRunner`, `CodexRunner`, others) | **Untouched.** They see only the substituted `prompt` string on `AgentStepConfig`. |
| State store / resume registry | **Untouched.** `AgentStepConfig.prompt` carries the resolved string; the cache key for an agent step is the step name, not the prompt. |
| Existing workflows under `examples/` and `workflows/` | **Untouched.** R19 defers migration. |
| `examples/orch.config.ts` | One new line registering `'file-prompts-demo'`. |
| `docs/public/` site | New how-to guide, updated api.md, updated 4-writing-a-workflow.md, updated examples.md, updated sidebar. |
| `.claude/skills/orch-workflow-author/` | SKILL.md + 3 reference docs updated. |
| `CLAUDE.md` | **Untouched.** No new non-negotiable rules; the new code follows existing rules. |

---

## Dependencies / Assumptions

- `step.define()` overload structure in `src/core/step.ts:142–164` carries forward unchanged. Verified by reading the file.
- `findConfigPath` in `src/config/index.ts` is the right blueprint for sync project-root detection. Verified.
- `Error.captureStackTrace` is available in Bun (it is — Bun implements V8 error API surface). Verified by `src/observability/orch-version.ts:28` pattern.
- `path()` in `src/services/types.ts` rejects `..` components; this is the final traversal guard. Verified.
- The `barrel.test.ts` pattern of asserting the shape of `orch`'s exports is the right hook for U5's tests. Verified.
- `bun run check` and `bun run docs:build` are the project gates. Verified (CLAUDE.md non-negotiable rule 10; doc-writer skill).

---

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Stack-frame parsing fails on a Bun version we haven't tested. | Low | Med (broken at user's first `step.define`) | Defensive parser handles both `at file://...` and `at /path...` formats; clear `PromptFileError` if parse fails advising the user to file a bug with stack contents. Tested with hand-crafted stack fixtures (U1). |
| Project-root detection picks the wrong root in monorepos (walks too far up). | Med | Med | Reuse `findConfigPath`'s walk-up; first match wins. Fallback to `process.cwd()` if no config found, with a debug log. |
| The `@/` sentinel collides with a workflow author's existing TS path-alias convention or with an actual `@` directory at project root. | Low | Low | Document the collision in U8 explicitly. orch's own codebase doesn't use TS path aliases. An `@` directory at root would be unusual; if it exists, the resolved path is `<root>/<rest>` (treating `@/` as the sentinel, not the prefix of a directory name), so a literal `@` directory is unreachable via `promptFile` and must be reached via workflow-local relative paths or an absolute path. |
| Authors confuse `loadPrompt` (composition) with `promptFile` (single file). | Med | Low | The new how-to guide (U8) leads with the recommendation: `promptFile` first; reach for `loadPrompt` only when composing fragments. Error message on AE6 (unsupported `vars` type) explicitly suggests `loadPrompt`. |
| Stack-parsing slowdown at workflow load time. | Low | Low | A single `new Error()` + regex parse per `step.define` / `loadPrompt` call. Workflow files typically have 3–10 steps; the overhead is negligible (microseconds). |
| Hidden behavior change for existing workflows. | Low | High (regressions in shipped pipelines) | Existing `step.define` call sites do not pass `promptFile` or `vars`, so the new resolution pipeline never runs for them. Regression test: run the full existing test suite under `bun run check` after each unit. |

---

## Verification Strategy

- **Unit-level.** Every helper (U1, U2, U3, U4) has its own `.test.ts` covering the test scenarios enumerated above. The `PromptFileReader` seam is faked in unit tests; no `node:fs` access except in the `node:fs` impl's own (small) test.
- **Integration-level.** U6's example workflow plus U9's end-to-end test load the real workflow module, read real `.md` files, and confirm substitution end-to-end.
- **Surface-level.** U5's barrel test asserts the public exports. U8 carries `bun run docs:build` as the doc gate.
- **Regression.** Existing test suite under `bun run check` must remain green. The new fields are additive and opt-in; no existing test should change behavior.
- **Manual.** Run `bunx orch run file-prompts-demo "add a CSV exporter"` after U6 lands and visually confirm the three steps' prompts look correct in the two-pane TUI. (Optional, but recommended before merge.)

---

## Documentation Plan

The doc updates are tracked as U7 (skill) and U8 (public docs). Highlights:

- New page: `docs/public/guides/file-based-prompts.md`.
- Updated: `docs/public/reference/api.md`, `docs/public/guide/4-writing-a-workflow.md`, `docs/public/examples.md`, `docs/public/.vitepress/config.mts`.
- Updated: `.claude/skills/orch-workflow-author/SKILL.md` and all three `references/*.md` files.
- Gate: `bun run docs:build` must pass with no dead links.
- Sync: `docs/public/reference/api.md` is cross-checked against `src/index.ts`'s actual exports per the doc-writer skill's sync guard.

---

## Sequencing

```text
U1 (path + caller dir)  ─┐
                          ├──> U3 (loadPrompt) ──┐
U2 (substitute + errors) ─┘                      │
                                                  ├──> U4 (step.define)
                                                  │       │
                                                  │       ├──> U5 (barrel exports)
                                                  │       │
                                                  │       ├──> U6 (worked example)
                                                  │       │
                                                  │       ├──> U7 (skill docs)
                                                  │       │
                                                  │       ├──> U8 (public docs)
                                                  │       │
                                                  │       └──> U9 (e2e test + gates)
```

U1, U2 are independent and can land in either order. U3 depends on U1 + U2. U4 depends on U1 + U2 + U3 (reuses the same reader singleton). U5 depends on U3 + U4. U6, U7, U8 depend on U5 and can land in parallel. U9 is the gate; it depends on everything.

A reasonable PR shape: one PR for U1–U5 (the core API, tested in isolation), a second PR for U6 (worked example), and a third PR for U7 + U8 + U9 (docs + gate). Author judgment; nothing in the plan requires three PRs.
