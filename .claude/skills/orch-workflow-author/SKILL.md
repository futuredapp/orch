---
name: orch-workflow-author
description: How to author or edit an `orch` workflow file (the TypeScript pipelines that chain Claude Code / Codex agent steps in this repo). Use this skill whenever the user asks to write, create, draft, scaffold, extend, refactor, or modify an orch workflow — including phrases like "new workflow", "another pipeline", "compound-engineering flow", "agent pipeline", "brainstorm-then-plan-then-work workflow", "orch script", or any time they describe a multi-step Claude/Codex automation in this codebase. Also use when the user already has a workflow `.ts` file and wants to add a step, change a prompt, or rework it. Apply even if the user does not say the word "orch" — if they're chaining `claude()` / `codex()` calls behind a `workflow(...)` factory, this skill applies.
---

# orch workflow author

You help the user turn a fuzzy idea ("I want a workflow that brainstorms a feature then implements it") into a single, self-contained orch workflow file: steps and the `workflow(...)` function defined together.

## Phase 0 — read this once

Workflows in this repo are plain TypeScript async functions. Three load-bearing facts:

1. **`run(STEP)` is the only memoization key.** Code outside `run()` re-executes on resume. Anything between `run()` calls must be idempotent — or wrap it with `run.custom`/`command()`.
2. **Re-runs of the same step in one workflow need `as:`** — `await run(WORK, { as: 'work-auth' })`. Two `run(WORK)` without distinct `as:` is a bug.
3. **`parallel()` is for genuinely independent branches.** Sequential dependencies (auth → api → ui) use a plain `for`.

The canonical references already in the repo: [`docs/getting-started.md`](../../../docs/getting-started.md), [`workflows/new-feature/index.ts`](../../../workflows/new-feature/index.ts), [`examples/feature-loop/index.ts`](../../../examples/feature-loop/index.ts), [`examples/compound/index.ts`](../../../examples/compound/index.ts). Read these before you write anything substantial.

## The author flow — four phases, in order

```
1. Interview        →  understand the workflow shape and the per-step intent
2. Propose          →  pseudocode + suggested agent prompts, get user signoff
3. Author           →  write a single self-contained .ts file
4. Register         →  update orch.config.ts and tell the user how to run it
```

**Do not skip phase 2.** Writing the file before the user has approved the pseudocode and prompts wastes both of your time — workflows are about prompts, not boilerplate.

---

## Phase 1 — Interview the user

The user's first message will usually undercook the workflow. Pull on these threads in order; ask in batches via `AskUserQuestion` rather than one at a time. Skip any thread the user already answered.

1. **The goal.** "What does a successful run of this workflow leave behind?" — a committed feature, a markdown plan, a passing test suite, a tagged release? You're looking for an observable end-state, not a vibe.
2. **The shape.** Sketch the rough sequence in your head: brainstorm → plan → work → review? Research-in-parallel then synthesize? Loop-until-done? Bulk fan-out across files? Confirm the shape with the user before sub-questions get specific.
3. **Per-step intent.** For each step in the sketch, ask:
   - What should this step produce? (a file? a structured value? a commit?)
   - Should the user drive it (interactive) or should Claude work alone (autonomous)? **Default to autonomous unless the user explicitly wants to drive a turn.** Surface a recommendation when a step looks like it needs human judgment (brainstorm, scope-deciding) — let the user override.
   - Which agent: Claude, Codex, or either? Most workflows in this repo use `claude()`.
   - Does this step need typed structured output (a Zod schema via `returns:`)? Use it for slugs, phase counts, done-checks, classifications — anywhere downstream code branches on the value.
4. **Loops and branches.** If the shape has a loop, ask for: the exit condition, the max iterations, and what feedback (if any) feeds the next iteration. The orch idiom is `for (let i = 1; i <= MAX; i++) { … if (done) break }`, not `while (true)`.
5. **Worktrees and commits.** Will this workflow touch the repo's working tree? If yes — and if the user wants isolation — propose `createWorktree(branch, { enter: true })` early. If commits should happen mid-flow, mark where with `commit('message')`.
6. **Shared session state.** Multi-step writing workflows usually want one folder per run (`docs/sessions/<slug>/`). If you see brainstorm → plan → work → review, propose a slug-generation step + `sessionsDir` that's threaded through every prompt.

Time-box this. If the user's intent is already concrete after one round, move on. If they're vague, three short rounds beats one giant one.

---

## Phase 2 — Propose pseudocode + prompts, then wait for signoff

Before opening an editor, produce a short Markdown summary with:

- **Header line:** what the workflow is called and what it does in one sentence.
- **Pseudocode (numbered, no TypeScript):** every `run()` call, with the step name, mode (autonomous / interactive), agent, and what it produces. Loops and parallel blocks shown as indented sub-bullets.
- **Suggested prompts:** the actual prompt strings you plan to put in each `step.define(...)` block. These are the part the user will care most about — they encode the contract with each sub-agent.

The pseudocode block should look like:

```
new-feature(prompt)
  1. generate-slug       autonomous, claude(haiku)    → { slug }
  2. mkdir docs/sessions/<slug>                       → (filesystem)
  3. brainstorm          interactive, claude          → docs/sessions/<slug>/brainstorm.md
  4. plan                autonomous, claude           → docs/sessions/<slug>/plan.md
  5. for i in 1..5:
       work-<i>          autonomous, claude           → uncommitted phase-1 work
       check-done-<i>    autonomous, claude(haiku)    → { done, reason }; break if done
  6. review              autonomous, claude           → docs/sessions/<slug>/review.md
```

The suggested prompts should follow the best-practice rules in [`references/prompt-patterns.md`](references/prompt-patterns.md): explicit file paths, hard constraints, verification instructions, and a clear stop condition. Keep them ~3–8 sentences each.

End the proposal with: *"Want me to write it as-is, or change anything first?"* — and stop. Do not start writing the file.

---

## Phase 3 — Author the single-file workflow

Once approved, write **one** TypeScript file that contains:

- Imports (everything from `'orch'` — including `z` if a step uses `returns:`. **Do NOT `import { z } from 'zod'`**; orch re-exports `z` so workflows don't need zod in the host project's `package.json`.)
- Module-scoped constants (`MAX_ITERATIONS`, models, schemas, helper to build a `claude()` runner)
- Step definitions (`step.define(...)`, `ask(...)`, `command(...)`)
- The `workflow(name, async (run, args) => { … })` body

Steps and workflow live in the same file — do not split into `steps.ts` + `workflow.ts` for new workflows. Splitting is fine *after* the file outgrows ~250 lines, but new workflows are easier to reason about as one piece.

### File location

Default to `.orch/workflows/<name>/index.ts` (where `<name>` matches the workflow's identifier). If `.orch/workflows/` does not exist but `workflows/` does (as in this repo currently), use `workflows/<name>/index.ts` — match what's already there rather than introducing a new folder. If the workflow is a one-off teaching example, `examples/<name>/index.ts` is fine.

### Skeleton (use this verbatim, then fill in)

```ts
/**
 * <name> — <one-line description>.
 *
 * Pipeline:
 *   1. <step-name>   <mode>, <runner>   <what it produces>
 *   …
 *
 * Usage:
 *   bunx orch run <name> "<prompt>"
 */

// Host project (.orch/workflows/<name>.ts in a downstream repo):
import { claude, schema, step, workflow, z } from 'orch'
import type { Runner } from 'orch'
// Inside this repo (workflows/<name>/index.ts in the orch source repo) use
// relative paths instead: `from '../../src/core/index.ts'` etc., and
// `import { z } from 'zod'` (this repo has zod installed).
//
// Either way: NEVER write `import { z } from 'zod'` in a workflow that lives
// under .orch/ in a host project — that requires the host to install zod.
// orch re-exports z so `import { z } from 'orch'` is the canonical form there.

// --- constants & helpers ----------------------------------------------------

const MAX_ITERATIONS = 5
const HAIKU_MODEL = 'claude-haiku-4-5-20251001'

// Schemas, if any:
const SLUG_SCHEMA = z.object({ slug: z.string().regex(/^[a-z][a-z0-9-]*$/) })

// Optional helper to keep step.define calls short:
function claudeFor(sessionName: string): Runner {
  return claude({
    bare: false,
    flags: ['--dangerously-skip-permissions', '--name', sessionName],
  })
}

// --- step definitions -------------------------------------------------------

const STEP_ONE = step.define('step-one', {
  agent: claude({ bare: false, flags: ['--permission-mode', 'bypassPermissions'] }),
  prompt: `<the actual prompt — see references/prompt-patterns.md>`,
  // returns: schema(SLUG_SCHEMA),      // only when downstream branches on the value
  // validate: fileProduced('foo.md'),  // when there's a checkable side effect
})

// --- workflow body ----------------------------------------------------------

export default workflow('<name>', async (run, args) => {
  if (args.prompt === undefined || args.prompt.trim() === '') {
    throw new Error('<name> requires a prompt. Usage: orch run <name> "<what to do>"')
  }
  const userPrompt = args.prompt.trim()

  await run(STEP_ONE)
  // …
})
```

### Hard rules while writing

1. **Imports must come through the public barrel.** Host-project workflows import from `'orch'`; in-repo workflows import from `'../../src/core/index.ts'` / `'../../src/runners/index.ts'`. Never reach into internal files (e.g. `../../src/core/step.ts` directly).
2. **Use `Path` (branded type) when a function expects a filesystem path.** Direct `string` is banned by the project's CLAUDE.md.
3. **No `child_process` / `Bun.spawn` / `node-pty` imports.** Use `command(...)` if you need to shell out. `ProcessService` is the only edge for subprocesses.
4. **Re-runs of the same step get distinct `as:` names.** `await run(WORK, { as: \`work-${i}\` })` inside a loop.
5. **Anything between `run()` calls must be idempotent.** Calculating a directory name from `args.prompt` is fine (deterministic). Writing a file directly with `fs.writeFile` is not — wrap it in `command()` if you need it memoized, or accept that it re-runs on resume.
6. **TypeScript strict, no `any`, no `!`.** This is enforced by `bun run check`.
7. **Interactive steps cannot have `returns:`.** Schema output only flows out of autonomous steps.
8. **`createWorktree({ enter: true })` inside `parallel()` only works with the homogeneous form** (`parallel(items, fn)`), not the heterogeneous tuple form.

### Common patterns

See [`references/templates.md`](references/templates.md) for full code for: linear pipeline, loop-until-done, parallel research, brainstorm→plan→work→review.

---

## Phase 4 — Register and tell the user how to run it

Edit `orch.config.ts` to add the entry:

```ts
import { defineConfig } from './src/config/index.ts'

export const config = defineConfig({
  workflows: {
    '<name>': 'workflows/<name>/index.ts',
    // …
  },
})
```

Tell the user the run command (`bunx orch run <name> "<prompt>"`), and call out any preconditions you've encoded into the prompts:
- Does it need `claude` (or `codex`) on PATH?
- Does it write under `docs/sessions/<slug>/`?
- Does it require `--mode=two-pane` because of an interactive step? (Interactive steps fail under `--mode=plain` with `ViewResolutionError`.)
- Should it be runnable under `--noninteractive`? If so, every `ask()` must declare `defaultWhenNoninteractive`.

Finally: run `bun run check` (or at least mention it). The project's hard gate is "every PR green locally before push."

---

## Public API at a glance

The full cheatsheet with signatures and minimal examples lives at [`references/api.md`](references/api.md). One-line index:

| Primitive | What it is |
|---|---|
| `workflow(name, fn)` | declares the workflow; gives you `run` and `args` |
| `step.define(name, config)` | autonomous or interactive agent step |
| `ask({ name, question, fields, buttons, defaultWhenNoninteractive })` | typed prompt step |
| `command(name, { argv, onFailure })` | shell command step; streams stdout/stderr to the host pane |
| `commit(message)` | `git add . && git commit -m message` as a memoized step |
| `createWorktree(branch, { enter })` | materialize a worktree and (optionally) switch the workflow's cwd |
| `parallel([...])` / `parallel(items, fn)` | concurrent branches; all settled before throwing |
| `schema(zodType)` | wraps a Zod schema for `returns:` and `--json-schema` plumbing |
| `tail(text, n)` | trim the last `n` lines of captured command output |
| `claude(opts)` / `codex(opts)` | the two built-in runners |

## Writing good sub-agent prompts

The biggest determinant of workflow quality is the prompt content of each `step.define(...)`. The rules — explicit paths, hard constraints, verification instructions, scoped exploration — are in [`references/prompt-patterns.md`](references/prompt-patterns.md). Read that file before you write any prompt longer than two sentences.

## Modifying an existing workflow

The skill applies just as much when the user already has a workflow. Workflow:

1. **Read the whole file first.** Don't guess at the existing shape from a function name.
2. **Map the user's change onto the four phases.** Are they adding a step (Phase 3), changing a prompt (Phase 2 + 3), or restructuring the pipeline (Phase 1 + 2 + 3)?
3. **Honor existing conventions.** If every step in the file uses a `claudeFor(name)` helper, your new step uses it too. If the file already threads `sessionsDir` through every prompt, your new prompt threads it too.
4. **Keep memoization keys stable.** Renaming an existing `step.define` name invalidates the cache for all in-flight runs. Don't do it casually.
5. **Run the full author flow if the change is non-trivial.** A one-line tweak doesn't need pseudocode signoff; a new loop or a new branch does.

## When this skill does NOT apply

- Adding a new runner adapter (Aider, Amp, Ollama). Use the `runner-author` skill instead — that's a different surface (`src/runners/<name>/`).
- Implementing a phase from `docs/plans/implementation-phases.md`. Use the `phase-implementer` skill.
- Writing tests for an existing workflow. Use the `testing-strategy` skill — workflows are tested as Tier 1 / Tier 2 cells, not as unit tests over the workflow file directly.
