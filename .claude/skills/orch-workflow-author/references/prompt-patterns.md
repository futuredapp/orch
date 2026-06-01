# Writing prompts for orch sub-agents

A workflow's quality is bounded by the prompts in each `step.define(...)`. The agent at the other end has none of the workflow author's context — only the prompt string, the filesystem, and (optionally) the `extraContext` you appended.

Distilled from [Claude Code best practices](https://code.claude.com/docs/en/best-practices) and the prompts that actually shipped in `workflows/new-feature/index.ts` and `examples/compound/index.ts`.

## 0. Where prompt text lives — file-based by default

For any step whose prompt is longer than ~3 sentences, put the prompt in a **sibling `.md` file** and reference it via `promptFile:`. Inline backticked strings are reserved for trivial prompts (one-liners and slug judges).

```ts
// Inline — fine for trivial prompts only.
const SLUG = step.define('slug', {
  agent: claude({ model: 'claude-haiku-4-5-20251001', bare: false }),
  prompt: 'Return a 2-4 word kebab-case slug for the idea below.',
  returns: schema(SLUG_SCHEMA),
})

// File-based — default for anything longer. Vars live on `run()`, not on
// `step.define` — so the same step can be reused with different inputs.
const RESEARCH = step.define('research', {
  agent: AUTONOMOUS,
  promptFile: 'research.md',           // sibling file next to this workflow .ts
})
await run(RESEARCH, { vars: { slug, sessionsDir } })   // {{slug}} and {{sessionsDir}} substituted
```

**Why default to files?** Markdown tooling (preview, spellcheck, link-check) runs on `.md` files but not on TypeScript template literals. Workflow shape stays readable when prose lives elsewhere. And shared prose moves into its own files instead of being copy-pasted between steps.

### The five rules of file-based prompts

1. **Path resolution.** A bare path (`'research.md'`) resolves relative to the workflow `.ts` file's directory. The sentinel `@/...` resolves to the **orch project root** — the directory containing your `orch.config.ts` (or `.orch/orch.config.ts`).
2. **Shared fragments live in `.orch/prompts/`.** When a fragment is referenced from more than one workflow, put it under `.orch/prompts/` at your project root and use `@/.orch/prompts/<name>.md`. This is the canonical location — adopt it from day one even if you only have one fragment.
3. **Vars live on `run()`, not on `step.define`.** `step.define({ promptFile, vars })` is a definition-time error (`cause: 'vars-on-define'`). Move the vars to the call site: `run(STEP, { vars: { ... } })`. This is what lets the same step be reused with different inputs.
4. **`{{var}}` substitution is strict in both directions.** A placeholder with no matching `vars` key errors at `run()` time (before the runner starts), and an unused `vars` key also errors. The error message names both names so typos surface immediately (`userPrompt` vs `user_prompt`). Use `{{name?}}` for optional placeholders — missing optionals substitute to the empty string.
5. **`vars` accepts only `string | number | boolean`.** No arrays, objects, or `undefined`. For richer composition — concatenating two fragments — use `loadPrompt()`:

   ```ts
   const intro = loadPrompt('intro.md', { topic })
   const ctx   = loadPrompt('@/.orch/prompts/session-context.md', { sessionsDir })
   const STEP = step.define('research', {
     agent: AUTONOMOUS,
     prompt: `${intro}\n\n${ctx}`,
   })
   ```

   `loadPrompt(path, vars)` returns a `string` — same path resolution, same strict substitution, but composed at the call site.

### Where `.md` prompt files live

```
.orch/                              ← orch isolation folder at the project root
  orch.config.ts
  workflows/
    feature-loop/
      index.ts                      ← `import { step, workflow } from 'orch'`
      brainstorm.md                 ← `promptFile: 'brainstorm.md'`
      plan.md
      work.md
  prompts/
    session-context.md              ← `@/.orch/prompts/session-context.md` from any workflow
    research-preamble.md
```

The worked example for every surface — `promptFile`, run-time `vars`, `loadPrompt`, the `@/` sentinel, `.orch/prompts/` — is `examples/file-prompts-demo/`. For the compile-time contract (TypeScript catching missing/extra/wrong vars at every `run()` site), run `bunx orch types` to generate the sidecars; the [Typed prompt vars](../../../docs/public/guides/typed-prompt-vars.md) guide walks through it end-to-end.

### Reusable steps with typed vars

The same step.define can be reused across multiple `run()` calls with different inputs. Three contract sources keep TypeScript on your side:

1. **Inline literal** — `prompt: 'Hi {{name}}'` infers `{ name: string | number | boolean }` via TypeScript's template-literal types. The contract flows through `Step<TResult, TVars>` into `run(STEP, { vars: ... })`.
2. **Sidecar lookup** — `promptFile: '@/.orch/prompts/brainstorm.md'` looks up the contract in the generated `.d.ts` sidecar (produced by `orch types`). Same compile-time guarantees as the inline form.
3. **Explicit `RunOverrides.vars`** — when you want to bypass substitution (`run(STEP, { prompt: 'replaced', vars: { name: 'x' } })`), the `vars` field stays typed but is silently ignored at runtime.

Migration recipe (factory function → typed reusable step):

```ts
// Before — factory rebuilds the step per call site.
function makeBrainstorm(topic: string) {
  return step.define(`brainstorm-${topic}`, {
    agent,
    prompt: `Brainstorm angles on ${topic}.`,
  })
}
await run(makeBrainstorm('crows'))
await run(makeBrainstorm('magpies'))

// After — define once, vary vars per run() call.
const BRAINSTORM = step.define('brainstorm', {
  agent,
  prompt: 'Brainstorm angles on {{topic}}.',
})
await run(BRAINSTORM, { vars: { topic: 'crows' } })
await run(BRAINSTORM, { vars: { topic: 'magpies' } })
```

Two `run()` calls with different `vars` produce distinct cache entries; the same vars on a second call hits the cache. Setting `as:` explicitly overrides the cache name (no vars hash appended) when you want to control checkpointing yourself.

### When to keep an inline `prompt:`

- One-sentence and one-paragraph prompts where the prose is the only thing on screen anyway.
- Prompts that are pure computed strings (`/skillname ${userPrompt}`) and have no static prose worth extracting.
- Quick spikes you expect to throw away in the same session.

Otherwise: file. The cost of a one-line `.md` file is essentially zero; the cost of a 30-line backticked string blocking readers from seeing the pipeline shape is real.

## 1. Give the agent a way to verify its own work

This is the single highest-leverage thing you can do. If a step's prompt cannot end with "and then check that X is true," consider whether the step belongs in the workflow at all.

- **Concrete success criteria**, not vibes. "Produce `docs/sessions/<slug>/plan.md` with a phased implementation plan" beats "make a plan."
- **Verification instructions in the prompt itself.** "After writing the file, list the headings and confirm there's at least one `## Phase 1` heading." The agent reads its own output and self-corrects.
- **Validators (`validate:`)** for facts the workflow itself can check: `fileProduced('docs/plans/*.md')`, `gitDiffCreated()`. Use them; they catch agent self-deception.
- **Structured output (`returns:`)** when downstream code branches on the value. A boolean done-check uses `returns: schema(z.object({ done: z.boolean(), reason: z.string() }))` — the haiku judge can't fake a `done: true` if the rest of the workflow inspects the working tree.

## 2. Specific context beats general intent

The agent can infer, but not telepathically. Every prompt should pin down:

- **The exact file paths to read first.** "Read `docs/sessions/<slug>/brainstorm.md` and `docs/sessions/<slug>/plan.md` first."
- **The exact file paths to produce.** "Write `docs/sessions/<slug>/review.md`."
- **Hard constraints, by negation.** "Do NOT create branches. Do NOT run `git commit`. Do NOT modify files under `node_modules/`." Negations are sharper than positive instructions for an agent.
- **Reference patterns in the codebase.** "Follow the shape in `src/runners/claude/claude-runner.ts` for the new runner." Saves the agent an exploration phase.

Example contrast (from `workflows/new-feature/index.ts`):

> **Vague:** "Implement the next phase of the plan."
>
> **Specific:** "Implement PHASE 1 (and only phase 1) of the plan at `docs/sessions/<slug>/plan.md`. Read `docs/sessions/<slug>/plan.md` and `docs/sessions/<slug>/brainstorm.md` first so you understand the intent. Hard constraints: (1) stay on the current git branch — do NOT create, switch, or delete branches; (2) do NOT run `git commit`, `git stash`, `git push`, or any command that mutates git history; (3) if phase 1 already looks complete in the working tree, do nothing and say so."

## 3. Explore → plan → implement separation

The compound-engineering loop (`brainstorm → plan → work → review`) is the canonical orch shape because each phase has a different cognitive job:

- **Brainstorm** (often interactive) — divergent. Surface options, edge cases, constraints.
- **Plan** — convergent. Pick an approach, sequence the work into phases.
- **Work** — execute. One phase at a time, no scope creep.
- **Review** — verify. Did the work actually match the plan?

Mixing these in one prompt ("brainstorm, plan, and implement this feature") gives the agent permission to skip the parts it finds boring. Separate steps force the conversation through each phase.

## 4. Resume-safety in the prompt

The workflow re-executes top to bottom on resume. Code between `run()` calls re-runs every time. So:

- **Make the prompt idempotent.** "If `docs/sessions/<slug>/plan.md` already exists and looks complete, do nothing and say so" — this lets a re-run be a no-op instead of clobbering work.
- **Pass deterministic values** (a slug computed once, then threaded through every prompt). Don't let the agent re-decide the slug on iteration 2.
- **Loop iterations get a unique `as:`** in the workflow code, but the prompt text should also acknowledge prior iterations: "If a previous iteration already started phase 1, continue from where it left off rather than restarting."

## 5. Sandboxing and permissions

For autonomous steps that need to write files:

- `claude({ bare: false, flags: ['--permission-mode', 'bypassPermissions'] })` — uses subscription auth + plugins + skills, autonomously approves tool use.
- `claude({ bare: false, flags: ['--dangerously-skip-permissions', '--name', sessionName] })` + `process.env.IS_SANDBOX = '1'` at module top — for sandboxed unattended runs; gives the step a stable session name for the two-pane Steps TUI.
- Codex: prefer the typed `sandbox` option (`'workspace-write'`, `'read-only'`, `'danger-full-access'`) over `--config`/`--approval-mode` flags (denied).

## 6. Slash commands and skills inside prompts

Claude Code resolves slash commands inside `-p` autonomous mode when `bare: false`. The compound and new-feature workflows use this to run installed skills:

```ts
prompt: `/compound-engineering:workflows:plan
Analyse and plan the brainstorm written under \`${sessionsDir}/\`. Read every file
in that directory first, then produce \`${sessionsDir}/plan.md\` with a phased
implementation plan derived from the brainstorm.`
```

Rules:
- The slash command goes on the **first line**, no preamble.
- Everything after the first newline is treated as the prompt body the skill receives via `$ARGUMENTS`.
- The skill must be installed (in `.claude/skills/` or as a plugin). Verify before writing the prompt.

## 7. Stopping the agent

Agents will keep going if you don't tell them to stop. Always include a stop condition:

- "Stop after writing `review.md` — do not start fixing anything and do not commit."
- "Make as much progress on phase 1 as you can in this single session" (bounded by `maxTurns` if you set it).
- "Return JSON matching the schema and stop" (for `returns:` steps).

## 8. Suggested prompt structure (use as a checklist)

```
<slash-command-or-skill-invocation-if-any>

<one-sentence goal>

Inputs to read first:
- <path-1>
- <path-2>

Hard constraints:
- <constraint 1, often a negation>
- <constraint 2>

Outputs to produce:
- <exact path or schema field>

Stop condition: <when to call it done>
```

You don't need every section in every prompt — but if a prompt feels off, walking through this checklist usually shows what's missing.

## 9. Things to avoid

- **"Be careful" / "Be thorough" / "Use best practices."** Vacuous; consumes tokens; the agent ignores them.
- **Long preambles about the workflow's grand purpose.** The agent doesn't need the strategy memo. It needs to know what to do *this turn*.
- **Embedding the user's raw prompt without escaping.** If `args.prompt` contains a backtick or a slash command, it can break out of your template. Use template strings with explicit interpolation, and consider sanitizing where appropriate.
- **Asking for unbounded exploration.** "Investigate the codebase" with no scope = the agent reads 200 files and runs out of context. Either bound it (`Read only the files under src/auth/`) or delegate to a sub-agent within the step (the agent itself can spawn its own sub-agents).
