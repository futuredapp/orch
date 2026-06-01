---
date: 2026-05-28
topic: file-based-prompts
---

# File-based prompts for orch workflows

## Summary

Add a file-based prompt API to orch so workflow authors stop hand-writing hundred-line backticked prose inside `step.define()`. Two new shapes — a first-class `promptFile` + `vars` field on the agent step, and a `loadPrompt(...)` helper for composing fragments — with strict `{{var}}` templating that errors at workflow-module load time.

---

## Problem Frame

Workflow authors are the affected party. As soon as a workflow does anything non-trivial, its `step.define()` calls fill with multi-paragraph backticked strings — slash command on line one, file paths threaded through `${...}`, hard constraints by negation, stop conditions. The `feature` workflow that triggered this brainstorm is ~270 lines, the majority of which is prose interleaved with TypeScript.

Three pains compound:

1. **Reading the workflow's shape is hard.** The pipeline structure (slug → brainstorm → plan → work loop → review → fixes → summary) gets buried under the prose each step contains. A reader who wants the shape has to skim past every prompt.
2. **Editing the prose is hard.** Markdown highlighters, spellcheckers, and prose linters do not run on TypeScript template literals. Re-indenting a multi-line prompt to keep the surrounding TypeScript readable distorts the prose. A small prose change shows up in git as a giant string-literal diff.
3. **Reuse already wants to exist and is being faked.** The `feature` workflow has already extracted `sessionContext` (a shared suffix appended to most prompts) and `findingsContract(reviewer)` (a parameterized prose fragment) as ad-hoc TypeScript helpers returning strings. Those helpers are evidence that prose composition is a real workflow-authoring activity; today the only tool available for it is string concatenation.

`docs/public/` is the orch project's user-facing documentation site (recently added per `CLAUDE.md`). Whatever pattern we adopt will become part of the documented orch interface, so the convention's clarity matters beyond this repo.

---

## Actors

- A1. **Workflow author**: Writes orch workflow files (e.g. the `feature` workflow). Chooses how to express each step's prompt. Primary user of the new API.
- A2. **Workflow reader / reviewer**: Reads workflow files to understand pipeline shape — could be the original author returning later, a teammate, or a code reviewer. Optimizes for "see the pipeline at a glance."
- A3. **orch maintainer**: Owns the `step.define()` surface, the orch barrel exports, and the two affected skills (`orch`, `orch-workflow-author`) plus the `docs/public/` reference pages.

---

## Requirements

**Agent step API**

- R1. `step.define()` accepts a new field `promptFile: string` on both the autonomous and interactive overloads.
- R2. `step.define()` accepts a new field `vars: Record<string, string | number | boolean>` alongside `promptFile`. Other value types (arrays, objects, null, undefined) are rejected at definition time with an error pointing the author at `loadPrompt` for composition cases.
- R3. Setting both `prompt` and `promptFile` on the same step is a definition-time error. The existing inline `prompt` field continues to work unchanged for callers that do not opt in.
- R4. Setting `vars` without `promptFile` is a definition-time error.
- R5. The `promptFile` string is resolved as a path relative to the workflow file that declared the step. Authors get colocation by default with no further configuration.
- R6. A `promptFile` path that starts with a project-root sentinel (exact sentinel chosen during planning) resolves relative to the orch project root instead, enabling shared fragments like `session-context.md` to live in one canonical project-rooted folder.
- R7. Resolved paths that escape the project root (e.g., via `..` traversal above root) are rejected at definition time.

**Templating**

- R8. Variable substitution uses `{{var}}` (Mustache-style) syntax. The `${...}` syntax is explicitly not used so prompts that discuss source code containing `${...}` do not need escaping.
- R9. Substitution is strict in both directions: any `{{var}}` placeholder in the file with no matching key in `vars` is an error, and any key in `vars` with no matching placeholder in the file is an error.
- R10. The error fires when the workflow module loads — at `step.define()` time — not when the step runs. A workflow with a broken prompt file fails before any subprocess is spawned.
- R11. Substituted values are stringified the same way template literals stringify them (strings pass through, numbers and booleans converted with `String(...)`). Per R2, only those types are accepted as input.
- R12. There is no escape syntax for literal `{{`. If a prompt genuinely needs to contain `{{` (the corner case), the author passes it as a `vars` value. No `{{{...}}}` Mustache triple-brace handling, no Handlebars helpers, no conditional or loop directives in the file.

**Composition helper**

- R13. `orch` exports a `loadPrompt(path, vars)` function with the same path-resolution and templating semantics as `promptFile` (R5-R12). Returns the substituted string.
- R14. `loadPrompt` is the supported way to compose prompts from multiple files — authors call it once per fragment in TypeScript and concatenate, then pass the result to a step's inline `prompt` field.
- R15. `loadPrompt`'s strictness errors at the call site (synchronously, before the step factory runs), preserving the same "fail at workflow-module load" property as R10 for the common case where `loadPrompt` is called at module-top or inside a step factory called at module-top.

**Convention & docs**

- R16. The `orch-workflow-author` skill (`SKILL.md` and `references/prompt-patterns.md`, `references/templates.md`, `references/api.md`) is updated so the new file-based pattern is presented as the default way to author prompts. Inline `prompt` strings remain documented as a legitimate option for trivially-short prompts.
- R17. The public docs under `docs/public/` (per `CLAUDE.md`'s docs rules and the `doc-writer` skill) are updated to teach the new pattern. The reference pages (`docs/public/reference/api.md` and any step-specific page) reflect the new fields.
- R18. A **new** workflow is added to `examples/` (or wherever fresh examples live) that demonstrates the file-based prompt pattern end-to-end. This workflow is built greenfield, not by retrofitting an existing one, and it is the worked reference the docs and skill point at.

**Migration posture**

- R19. The existing `feature` workflow and other workflows under `examples/` and `workflows/` are not migrated as part of this work. They keep their inline `prompt` strings. Migration is an explicitly deferred phase.

---

## Acceptance Examples

- AE1. **Covers R1, R5, R8, R9.** Given a workflow file at `examples/foo/index.ts` that defines a step with `promptFile: 'brainstorm.md'` and `vars: { userPrompt, sessionsDir }`, and a sibling file `examples/foo/brainstorm.md` containing `/compound-engineering:ce-brainstorm {{userPrompt}}\n\nWrite to {{sessionsDir}}/brainstorm.md.`, when the workflow module loads, the step's resolved prompt is the file content with both placeholders substituted.
- AE2. **Covers R3.** Given a `step.define()` call with both `prompt: 'foo'` and `promptFile: 'bar.md'`, when the workflow module loads, a definition-time error is thrown naming the step and pointing out that the two fields are mutually exclusive.
- AE3. **Covers R9, R10.** Given a prompt file containing `{{userPrompt}}` and a step that passes `vars: { user_prompt: '...' }` (typo), when the workflow module loads, an error is thrown identifying the unknown placeholder `userPrompt` and the unused arg `user_prompt`. No subprocess is spawned.
- AE4. **Covers R6.** Given a project-rooted path sentinel applied to `promptFile`, when the same shared fragment is referenced from two workflows in different directories, both resolve to the identical project-rooted file.
- AE5. **Covers R13, R14.** Given a step's prompt that needs a shared `sessionContext` suffix, when the author writes `prompt: loadPrompt('intro.md', vars) + loadPrompt('<project>/session-context.md', vars)` and passes the result to the step's inline `prompt`, the resulting step prompt equals the substituted concatenation.
- AE6. **Covers R2.** Given `vars: { items: ['a', 'b'] }` passed alongside `promptFile`, when the workflow module loads, an error is thrown naming `items` as an unsupported value type and suggesting `loadPrompt` for composition cases.

---

## Success Criteria

- A workflow author can write a non-trivial workflow (3-6 steps, each with a real prompt) where every step's `step.define()` block fits on one screen. The pipeline shape is readable in the TypeScript file; the prose lives next door.
- A workflow reader can answer "what is this pipeline's shape?" by scanning the workflow file alone, without reading any prompt.
- Editing a prompt is a one-file change in a `.md` file with normal Markdown tooling. No surrounding TypeScript moves in the diff.
- Both reusable fragments from the `feature` workflow (`sessionContext`, `findingsContract`) can be expressed in the new system without a TypeScript helper returning a string.
- A typo'd variable name (placeholder vs args mismatch) is caught before any agent process is spawned.
- The downstream `ce-plan` handoff has enough information to choose the exact project-root sentinel, the canonical shared-fragments directory, and the precise error messages without re-litigating any product decision recorded above.

---

## Scope Boundaries

- Type-safe per-prompt argument schemas (Zod schemas embedded in frontmatter, codegen of `.d.ts` from `.md` files, or `.prompt.ts` modules exporting a typed function). Acknowledged future possibility. Not in this work.
- Migration of any existing workflow (`feature.ts`, `examples/compound`, `examples/feature-loop`, `workflows/new-feature/`) to the new pattern. Separate, later phase.
- In-file partials, includes, or `{{> partial}}` directives. Composition happens in TypeScript via `loadPrompt`.
- Conditional logic, loops, or any expression language inside prompt files.
- Caching strategy changes. The existing step-name-based memoization is untouched; the existing question of "does changing a prompt's text invalidate the cache" is unchanged from how it works for inline prompts today.
- Editor / IDE affordances (`{{var}}` linting, jump-to-definition from `promptFile: 'x.md'` to the file, schema-aware autocomplete on `vars`).
- A lenient/forgiving templating mode. Strict is the only mode.
- An escape syntax for literal `{{`. The corner-case workaround is to pass it as a `vars` value.
- Cross-language prompt files (`.txt`, `.prompt`, `.hbs`, etc. as distinct supported extensions). Convention is `.md`; orch does not enforce the extension but does not advertise others.

---

## Key Decisions

- **Both `promptFile` field and `loadPrompt` helper, not one or the other.** The field handles the dominant single-prompt-per-step case ergonomically; the helper handles composition (the `sessionContext` and `findingsContract` patterns) without forcing every author to assemble strings even when they don't need to.
- **Strict templating, define-time errors.** Lenient passthrough is exactly the failure mode being fixed (a missing variable surfacing three steps later as the agent reading `undefined`). The orch codebase's strict-TypeScript posture (`strict: true`, `noUncheckedIndexedAccess`, no `any`) maps cleanly onto strict templates.
- **`{{var}}` over `${var}`.** Prompts frequently discuss code that contains literal `${...}`; `{{var}}` avoids the escape problem at the cost of one moment of "this isn't a template literal."
- **Project-root sentinel for shared fragments.** Pure workflow-local would re-introduce a TypeScript-helper escape hatch for the very pattern (`sessionContext`) being fixed.
- **Runtime-checked, not type-safe.** The user explicitly accepted runtime errors. Type-safe variants (R-out-of-scope above) are noted as future work.
- **Additive, no deprecation of inline `prompt`.** Existing workflows keep working without modification; the new pattern is the documented default for new work.
- **Prove on greenfield, defer migration.** Writing a fresh workflow with the new API is a sharper test of API ergonomics than retrofitting a workflow whose shape was chosen around the old constraints.

---

## Dependencies / Assumptions

- `step.define()` currently has two TypeScript overloads (`InteractiveStepInput` and `AutonomousStepInput<T>`) in `src/core/step.ts`. The new `promptFile` + `vars` fields land on both. Verified.
- `orch` exports its public surface from `src/index.ts` via module-barrel re-exports. `loadPrompt` lands as a new export from `src/core/index.ts` (the most likely home, subject to planning). Verified.
- The orch project has a stable notion of "project root" (the directory containing `orch.config.ts` and where the workflow runner is invoked). The project-root sentinel for `promptFile` paths resolves against that. Verified by inspection of `examples/orch.config.ts`.
- The "slash command must be on the first line" rule (from `references/prompt-patterns.md`) transfers to prompt files unchanged — authors place the slash command on line 1 of the `.md` file.
- The orch project's testing-strategy rules (`testing-strategy` skill, `CLAUDE.md` rule 3 — mock only at the edge) apply to the new code. The file-reading seam is the natural service boundary if isolation is needed for tests; planning chooses whether a new `*Service` is warranted or whether direct `node:fs` access is acceptable at the orch-core layer.
- The `docs/public/` site uses VitePress and `bun run docs:build` is the gate. Any new reference page lands in that build.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R6][User decision] What the exact project-root path sentinel looks like (`@/...`, `~/...`, leading `/`, a `{ baseDir: 'project' }` option, a designated top-level folder name treated specially, etc.). This is an API ergonomics decision worth resolving in planning with the precise call sites of `findingsContract` and `sessionContext` in front of the planner.
- [Affects R6, R18][User decision] Where the canonical shared-fragments folder lives (`prompts/` at project root, `workflows/_shared/`, alongside `orch.config.ts`, etc.). Tied to the sentinel decision above.
- [Affects R15][Technical] Whether `loadPrompt` is synchronous (`fs.readFileSync`) or async (`fs.promises.readFile`). Sync gives the cleanest "errors at module load" semantics for the `promptFile` path; async is more idiomatic for the rest of the orch codebase. Planning resolves this against orch's existing IO conventions.
- [Affects R1, R2][Technical] How the new fields appear in the two `step.define()` overload input types (`InteractiveStepInput`, `AutonomousStepInput<T>`) without bloating the signatures or muddying the existing `prompt`-is-optional shape.
- [Affects R10][Technical] How the resolved prompt is stored on the `AgentStepConfig` shape — likely the substituted string occupies the existing `prompt` field after `step.define()` runs, but planning confirms the storage shape and whether `promptFile` / `vars` are retained for observability (log lines mentioning which file produced the prompt).
- [Affects R17][Needs research] Which `docs/public/` pages need new content vs. updates. The `doc-writer` skill is the authority; planning consults it.
- [Affects R18][User decision] What greenfield workflow to build as the worked example. It should be small enough that the file-prompt pattern dominates the diff (not a fresh 11-step `feature`-style pipeline), but real enough to exercise `promptFile`, `loadPrompt`, project-root paths, and at least one composition case.
- [Affects R12][Technical] Error message text and shape for the strictness errors (R3, R4, R9). Planning chooses wording that maps onto orch's existing error conventions.
