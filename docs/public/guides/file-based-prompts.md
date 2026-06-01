# File-based prompts

> **What you'll learn:** how to move multi-paragraph prompt text out of TypeScript backticks and into sibling `.md` files, with strict `{{var}}` substitution and a `loadPrompt()` helper for composition.

A workflow becomes hard to read the moment its `step.define()` calls fill with 30-line backticked prose. Pipeline shape gets buried under prompts. Spellcheck and markdown previews don't run on TypeScript template literals.

orch addresses both with two surfaces: `promptFile:` on `step.define`, and a `loadPrompt(path, vars)` helper. Same strict substitution semantics, same resolution rules.

## When to reach for it

| Prompt size                       | Recommended shape                                    |
| --------------------------------- | ---------------------------------------------------- |
| One sentence to one paragraph     | Inline `prompt:` is fine.                            |
| Two paragraphs or more            | Sibling `.md` file via `promptFile:`.                |
| Prose shared by 2+ workflows      | Shared `.md` under `.orch/prompts/`, via `@/`.       |
| Composition of 2+ fragments       | `loadPrompt(path, vars)` → feed the result via `prompt:`. |

The rule of thumb: if the prompt block hides the pipeline shape from a reader scrolling through the workflow, move it to a file.

## `promptFile:` on a step

A bare path resolves relative to the workflow `.ts` file's directory:

```ts
// .orch/workflows/file-spec/index.ts
import { claude, run, step, workflow } from 'orch'

const SLUG = step.define('slug', {
  agent: claude({ model: 'claude-haiku-4-5-20251001', bare: false }),
  promptFile: 'slug.md',           // sibling to index.ts
})

// Vars live on the call site so the same step can be reused with different
// inputs. The compile-time contract is described in
// [Typed prompt vars](/guides/typed-prompt-vars).
const { slug } = await run(SLUG, { vars: { userPrompt: 'add a CSV exporter' } })
```

```md
<!-- .orch/workflows/file-spec/slug.md -->
Return a 2-4 word kebab-case slug for the idea below.
Lowercase a-z, digits, hyphens only.

Idea:

{{userPrompt}}
```

At `step.define()` time, orch reads the file and stores the raw template on the step. Substitution happens at `run()` time, once per call site — that's what lets the same step be reused with different vars. The runtime still hands the agent an ordinary, fully-substituted string; the substitution moment just shifted.

## The `{{var}}` syntax

```text
{{name}}        // simplest form
{{ name }}      // surrounding whitespace is tolerated
{{ a.b }}       // identifier rule fails — left as literal text
${name}         // not a placeholder — orch does NOT use template-literal syntax
```

`vars` accepts only `string | number | boolean`. Numbers and booleans are stringified with `String(...)`. Anything else (arrays, objects, `null`, `undefined`) throws `PromptFileError` at `run()` time, before the runner starts.

### Strict in both directions

A missing key throws. **An unused key also throws.** Both error messages name what's missing and what's extra so typos surface immediately:

```ts
const SLUG = step.define('slug', {
  agent,
  promptFile: 'slug.md',          // references {{userPrompt}}
})
await run(SLUG, { vars: { user_prompt: 'x' } })   // wrong key
// PromptFileError: step "slug" run(): prompt template references {{userPrompt}}
// but vars supplied [user_prompt] — check for a typo (placeholder name vs key
// name must match exactly)
```

The same typo would also be a compile-time error if you wired `orch types` to generate a sidecar for `slug.md` — see [Typed prompt vars](/guides/typed-prompt-vars).

There is no escape syntax for a literal mustache opener. If you need one in your prompt text, pass it through `vars` as a string and reference it as a placeholder.

## The `@/...` sentinel for project-rooted paths

A path that starts with `@/` resolves against the **orch project root** — the directory that contains your `orch.config.ts` (or `.orch/orch.config.ts`). Anything else is workflow-local.

```ts
const RESEARCH = step.define('research', {
  agent: AUTONOMOUS,
  promptFile: '@/.orch/prompts/research-preamble.md',
})
await run(RESEARCH, { vars: { topic: 'auth' } })
```

Use this for prose shared by multiple workflows. The canonical location is `.orch/prompts/<name>.md` at your project root — adopt it from day one even if you only have one shared fragment.

::: tip Why `@/`?
`@/` is also a common TypeScript path-alias prefix (Webpack/Vite/`tsconfig.paths`). In orch the rule is narrower: `@/` only marks **project-root resolution for prompt files**, and orch's own code does not use TS path aliases.
:::

Paths that resolve outside the project root throw `PromptFileError({ cause: 'traversal' })`.

## Composing fragments with `loadPrompt`

When you want to glue two or more fragments together, use `loadPrompt(path, vars)`. It returns the substituted string synchronously, so you feed the result into the existing `prompt:` field:

```ts
import { loadPrompt, step } from 'orch'

const intro = loadPrompt('intro.md', { topic })
const ctx   = loadPrompt('@/.orch/prompts/session-context.md', { sessionsDir })

const RESEARCH = step.define('research', {
  agent: AUTONOMOUS,
  prompt: `${intro}\n\n${ctx}`,
})
```

Same path resolution and strict substitution as `promptFile:`. Errors throw at the `loadPrompt()` call site, not later.

For a single file with no composition, prefer `promptFile:` directly — it's the same semantics with one fewer concept.

## Errors you can catch

`PromptFileError` has a `cause` discriminator:

| `cause`                | When it fires                                                                  |
| ---------------------- | ------------------------------------------------------------------------------ |
| `mutex`                | Both `prompt:` and `promptFile:` set on the same step.                          |
| `vars-on-define`       | `vars:` supplied directly on `step.define` (move it to `run(STEP, { vars })`).  |
| `missing-placeholder`  | The template references `{{x}}` but `vars.x` was not provided.                  |
| `extra-key`            | `vars.y` was provided but the template never references `{{y}}`.                |
| `unsupported-type`     | `vars.k` is not `string \| number \| boolean`. The message points at `loadPrompt`. |
| `read-failed`          | The file could not be read (path doesn't exist, permission, …).                |
| `traversal`            | The resolved path escapes the project root.                                     |

`PromptFileError` extends `Error`, so existing catch sites that look for `Error` instances still work.

## End-to-end example

The repository ships a worked example at [`examples/file-prompts-demo/`](https://github.com/futured/claude-orchestration/tree/main/examples/file-prompts-demo) that exercises every surface — workflow-local `promptFile`, project-rooted `@/`, `loadPrompt` composition, and shared `.orch/prompts/` fragments. Read it alongside this guide; it's the canonical reference for the file layout.

## Design rationale

The strict-both-directions substitution rule (a missing key AND an unused key both throw) keeps prompts and their call sites honest. Lenient substitution silently swallows typos — `{{user_promt}}` left in the template, or `vars: { topicc: 'x' }` at the call site — and the agent receives a degraded prompt with no signal that anything was wrong. Strict checks turn both shapes into the same error class (`PromptFileError`) at `run()` time, before the runner starts.

The `@/` sentinel exists to give shared `.orch/prompts/` fragments a stable address that does not depend on where the workflow file lives. Workflow-local paths (`promptFile: 'slug.md'`) resolve against the workflow's own directory so a workflow can be moved without rewriting its prompt references. The two resolutions are deliberately disjoint: a bare path never escapes the workflow folder, and `@/` always anchors at the project root.

## Where to go next

- The full reference for `promptFile:`, `vars:`, and `loadPrompt` lives in the [API reference](/reference/api#step-define).
