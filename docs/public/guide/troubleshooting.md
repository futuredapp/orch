# Troubleshooting

> **What you'll learn:** the most common ways a run dies, what each error means, and the one-line fix for each.

This page is a lookup table, not a tutorial.
Find the error name or message you saw, read the cause, apply the fix.
When the fix is not obvious from the message, follow the flow in [Debugging](/guide/6-debugging) to read the run's logs.

## Runner CLI missing or not authenticated

**You see:** a step fails immediately with `Failed to spawn: claude ...` (or `codex ...`), or a Claude step reports `Not logged in · Please run /login`.

**Cause:** the runner's CLI is not installed on your `PATH`, or it is installed but not logged in.
orch spawns each runner's own binary and uses that binary's own auth.
There is no `orch login`.

**Fix:** install the CLI and authenticate it, then re-run.

- `claude` (Claude Code) for the [`claude()`](/reference/runners#claude) runner, logged in via its own `/login`.
- `codex` for the [`codex()`](/reference/runners#codex) runner, logged in via `codex login`.

See [Getting started → Prerequisites](/guide/2-getting-started#prerequisites) for the full list.

## `CodexVersionError` - Codex CLI too old or missing

**You see:**

```
codex CLI version 0.110.0 is too old. orch requires >= 0.118.0. Upgrade with: npm i -g @openai/codex
```

(When the binary is absent the version reads `not found`.)

**Cause:** orch runs a version preflight before the first Codex step.
The installed `codex` is older than the minimum orch supports, or is not on `PATH` at all.

**Fix:** upgrade (or install) the CLI.

```bash
npm i -g @openai/codex
```

## Empty JSON Schema - usually a Zod version mismatch

**You see** (at workflow load, from `schema()`):

```
schema() produced an empty JSON Schema (no type / anyOf / oneOf / allOf / enum / const / $ref).

This usually means the Zod schema was created with a Zod version that orch's
`zod-to-json-schema` does not recognise - most commonly Zod v4 in the host
project while orch is on Zod v3.
```

**Cause:** the Zod schema you passed to `schema()` came from a Zod major version orch's converter does not understand.
The field-reported case is Zod v4 in the host project while orch is on Zod v3.
The converter silently emits an empty schema, which would fail mid-run at the runner.

**Fix:** use a `z` that matches orch, one of:

- In workflows under `.orch/`, import `z` from orch, not from the host package:

```ts
import { z } from 'orch'   // ✅
import { z } from 'zod'    // ❌ resolves to the host project's zod
```

- Or align your host project to Zod v3:

```bash
bun add zod@^3
```

## `ConfigLoadError` - bad or missing `orch.config.ts`

**You see** one of:

```
Config at <path> has no export. Use: export const config = defineConfig({ ... })
Invalid config at <path>: <field>: <reason>
Cannot load config at <path>: <import error>
```

**Cause:** orch found (or expected) an `orch.config.ts` but could not use it.
Either the file has no `config` / default export, its shape failed validation, or it threw while importing.
The config schema is strict, so an unknown or misspelled key is rejected as an invalid config.

**Fix:** export a config and correct the reported field.

```ts
import { defineConfig } from 'orch'

export const config = defineConfig({
  workflows: { feature: 'workflows/feature.ts' },
})
```

Match the key names in [Configuration](/reference/config) exactly.
The message names the file and the offending field, so start there.

## `StepNameCollisionError` - two steps share a name

**You see:**

```
Step "review" collides across sub-paths: prior=[...], attempted=[...]. Two different sub-paths produced the same step name; rename one step or invoke the sub through a different parent.
```

**Cause:** two steps resolved to the same name in one run, so their results would overwrite each other in state.
The message names both call sites.

**Fix:** give the steps distinct names, or override the cache key on one call:

```ts
await run(REVIEW, { as: 'review-second-pass' })
```

## `SubworkflowDepthError` - subworkflow recursion too deep

**You see:**

```
runWorkflow depth 9 exceeds max 8. Chain: parent → child → ... Override via WorkflowDeps.maxSubworkflowDepth when nesting is intentional.
```

**Cause:** subworkflows nested past the depth bound (default 8).
This usually means an unintended recursion, where a workflow keeps invoking itself.

**Fix:** fix the recursion so it terminates.
If the deep nesting is intentional, raise the bound via `WorkflowDeps.maxSubworkflowDepth`.

## `PromptFileError` - prompt file missing, empty, or outside the project

**You see** one of:

```
loadPrompt("<path>"): file is empty — prompt templates must contain at least one non-whitespace character
promptFile: path "<path>" resolves outside the project root "<root>" — remove ".." segments or use the "@/..." sentinel for project-rooted paths
prompt template references {{name}} but no value was supplied — add the matching key(s) to `vars`
```

**Cause:** the prompt file could not be read, was blank, escaped the project root, or its `{{placeholder}}` set did not match the `vars` you passed.

**Fix:** depends on the message.

- Empty file: put at least one non-whitespace character in the template.
- Outside the project root: remove `..` segments, or use the `@/...` sentinel for a path rooted at the project.
- Placeholder mismatch: make the `vars` keys and the `{{placeholder}}` names match exactly.

See [File-based prompts](/guides/file-based-prompts) for the full contract.

## tmux missing or too old for two-pane mode

**You see** (only when two-pane mode was requested explicitly):

```
--mode=two-pane requires tmux in PATH, but none was found
--mode=two-pane requires tmux >= 3.3
```

**Cause:** the two-pane host needs tmux 3.3 or newer.
When you do not force the mode, orch detects this and falls back to plain mode on its own.
Forcing `--mode=two-pane` (or `defaultMode: 'two-pane'` in config) turns the missing capability into a hard error.

**Fix:** install or upgrade tmux to 3.3+, or run the plain host instead:

```bash
orch run feature --mode=plain
```

## Where to go next

- [Debugging](/guide/6-debugging) - read a run's logs when the error alone is not enough.
- [Running workflows](/guide/5-running-workflows) - the run and resume commands.
- [Configuration](/reference/config) - every config key and environment variable.
