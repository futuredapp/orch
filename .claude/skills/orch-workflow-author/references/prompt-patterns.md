# Writing prompts for orch sub-agents

A workflow's quality is bounded by the prompts in each `step.define(...)`. The agent at the other end has none of the workflow author's context — only the prompt string, the filesystem, and (optionally) the `extraContext` you appended.

Distilled from [Claude Code best practices](https://code.claude.com/docs/en/best-practices) and the prompts that actually shipped in `workflows/new-feature/index.ts` and `examples/compound/index.ts`.

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
