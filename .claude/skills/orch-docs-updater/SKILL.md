---
name: orch-docs-updater
description: Analyze a set of code/design changes and update this repo's documentation to match. Use whenever the user wants docs brought in sync with a change — phrased as "update the docs for this", "what docs need updating", "document this change", "sync the docs with the code", "did this change need a doc update", or after a feature lands. Accepts any change scope: a prose description of what changed, the current working tree, the current branch (vs its base), or a specific commit/range. Knows the full documentation map of this repo (README, CLAUDE.md, AGENTS.md, docs/public, docs/solutions, docs/issues, …) and routes each change to the surface that owns it. Does NOT cover docs/public house style in depth — it defers to the doc-writer skill for that.
---

# orch docs updater

Given a change, this skill tells you **which documentation surfaces it touches** and **updates them**. It is the routing layer over the whole doc taxonomy; for the `docs/public/` VitePress site it hands off house-style decisions to the `doc-writer` skill rather than duplicating them.

Work in this order: resolve the change set → classify impact against the map → apply edits → capture learnings → verify.

## 1. Resolve the change set

The caller describes *what changed* in one of four scopes. Pin it down first — every later decision depends on knowing the concrete diff, not a vibe.

| Scope the user gives | How to resolve it |
|---|---|
| A prose description ("I added env passthrough") | Treat the description as intent, then ground it: `git log --oneline -20` and `git diff` to find the matching real changes. Never document from the description alone. |
| "the working tree" / "my uncommitted changes" | `git status` + `git diff` (and `git diff --staged`). |
| "this branch" / "what I've been working on" | Diff against the base: `git diff $(git merge-base HEAD origin/develop)...HEAD`. The default branch here is `develop`. |
| "commit `<sha>`" / "the last commit" / a range | `git show <sha>` or `git diff <range>`. |

Always read the **actual diff of `src/`**, and specifically whether the public barrel `src/index.ts` (and the module barrels it re-exports — `src/core/`, `src/runners/`, `src/validators/`, `src/config/`) changed. The public API is defined by those exports; a change there is the single strongest signal that user docs must move.

If the scope is genuinely ambiguous (e.g. the user says "the docs are stale" with no anchor), ask which scope they mean before editing anything.

## 2. The documentation map

Every documentation surface in this repo, what belongs in it, and who owns its conventions:

| Surface | What belongs here | Convention / owner |
|---|---|---|
| `README.md` | The repo pitch, install, and a high-level summary of user-facing capability. Update when a *headline* capability is added/removed or install/usage changes. | Prose. Keep it short — it is not the manual. |
| `CLAUDE.md` | Agent-facing **project rules** and conventions: the non-negotiable rules, how to add a feature/runner/test, where things live. Update when a convention, seam, or workflow rule changes. | The numbered "Non-negotiable rules" + "How to…" lists. |
| `AGENTS.md` | Generic, tool-agnostic agent rules. **Does not exist in this repo today.** Only create it if a rule must be readable by non-Claude agents and genuinely does not belong in `CLAUDE.md`; otherwise `CLAUDE.md` is the home. | Mirror, don't fork, `CLAUDE.md`. |
| `docs/public/guide/N-*.md` | The numbered, linear tutorial (read top-to-bottom once). Update when the learning path for a feature changes. | **Defer to `doc-writer`.** No forward references; one concept per page. |
| `docs/public/guides/*.md` | How-to recipes ("how do I X?"), one task per page. Add a page when a new user-facing capability needs a task recipe. | **Defer to `doc-writer`.** |
| `docs/public/reference/*.md` | Exhaustive facts: `api.md`, `runners.md`, `cli.md`, `config.md`, `built-ins.md`. Signatures **must match `src/`**. | **Defer to `doc-writer`** + the sync-guard (below). |
| `docs/public/examples.md` | Indexed tour of `examples/`. Update when an example is added/removed. | **Defer to `doc-writer`.** |
| `docs/solutions/*.md` | Compound learnings: a non-obvious problem that was solved and the insight worth carrying forward. | Dated frontmatter: `date`, `topic`, `status` (+ optional `tags`, `category`). See the "worth remembering" bar below. |
| `docs/issues/*.md` | Known issues, architectural debt, deferred follow-ups surfaced during work. | Dated frontmatter: `date`, `status`, `area`, `type`, `severity`, `resolution`. |
| `docs/findings/`, `docs/handovers/`, `docs/code-review/`, `docs/rebase/` | Point-in-time investigation/handoff/review records. | Append-only history; don't retro-edit. |
| `docs/brainstorms/`, `docs/plans/` | Design history per feature/phase. | Append-only; a finished feature does not rewrite its own plan. |
| `docs/sessions/<slug>/` | Per-run artifacts produced by the `feature` workflow. | Owned by the workflow; not hand-edited. |
| `docs/logging.md`, `docs/testing-strategy.md` | Internal deep-dives on logging and the test strategy. Update when those subsystems change. | Internal prose. |

**Never** link the public site (`docs/public/`) into internal docs, and never publish internal docs.

## 3. Routing rules

Map the change set to surfaces. A change can hit several:

- **Public API changed** (exports from `src/index.ts` / the re-exported barrels) → `docs/public/reference/api.md` or `runners.md` **must** be reconciled, plus any guide that demonstrates the changed symbol. This is mandatory, not optional — a drifted reference is a bug.
- **User-facing behavior, CLI flags, or config changed** → `README.md` (if headline) and the relevant `docs/public/guide` or `guides` page.
- **A new user-facing capability** → usually a new `docs/public/guides/*.md` how-to, wired into the sidebar (`doc-writer` covers wiring).
- **Agent-facing rules, seams, or conventions changed** (a new non-negotiable rule, a moved boundary, a new "how to add X" flow) → `CLAUDE.md`. Touch `AGENTS.md` only under the rule above.
- **A non-obvious problem was solved along the way** → `docs/solutions/` (see below).
- **Something is broken / deferred / risky and left for later** → `docs/issues/`.
- **Nothing user- or agent-facing changed** (internal refactor, test-only change) → say so explicitly and edit nothing. Inventing doc churn is a failure mode, not thoroughness.

### The sync-guard (when the public API moved)

The `doc-writer` skill owns this, but the trigger lives here. After any barrel change, list what the docs must cover and cross-check:

```bash
grep -hoE 'export (function|const|class) [A-Za-z]+' \
  src/core/*.ts src/runners/*/index.ts src/validators/*.ts src/config/*.ts
```

New export → document it. Documented symbol that no longer exists → remove it. Document only what a workflow author imports from `orch`, never private helpers.

## 4. Apply the updates

- For anything under `docs/public/`, **load the `doc-writer` skill** and follow it (three rules: simple/top-to-bottom, runnable examples with imports, reference signatures quoted from `src/`). Don't reinvent its conventions here.
- For `README.md` / `CLAUDE.md`, match the surrounding voice and structure — edit in place, keep it tight.
- Use repo-relative paths in everything you write.

## 5. Capture learnings worth remembering → `docs/solutions/`

The bar is **non-obvious + solved + would save a future developer real time**. A learning qualifies when someone hitting the same wall later would have been stuck without it: a root cause that took digging, a gotcha that passes every test, a seam that isn't where you'd expect.

Write one file per learning, `docs/solutions/<topic>.md`, with frontmatter:

```markdown
---
date: <YYYY-MM-DD>
topic: <kebab-topic>
status: shipped
---

# <Title — the insight, not the task>

## Symptom        ## Root cause        ## Fix / takeaway
```

Do **not** record what the repo already encodes: code structure, an obvious decision, anything already stated in `CLAUDE.md`, a plan, or a brainstorm. If nothing clears the bar, write nothing — an empty learnings set is a valid, common outcome.

> Note: this repo also has an auto-memory at `.claude/.../memory/` for durable cross-session *facts about the user/project*. That is a different sink from `docs/solutions/` (which is for *engineering learnings*). This skill writes to `docs/solutions/`; leave memory to the memory workflow unless the user asks otherwise.

## 6. Verify

- If you touched anything under `docs/public/`, run `bun run docs:build` — it fails on dead internal links — and fix what it reports before declaring done.
- Re-read each file you edited and confirm it still reads top-to-bottom and contradicts nothing.

## When this skill does NOT apply

- Writing brand-new `docs/public/` pages from scratch with no preceding change → that's just `doc-writer`.
- Authoring or editing a workflow → `orch-workflow-author`.
- Recording a durable user/project fact → the auto-memory workflow.
