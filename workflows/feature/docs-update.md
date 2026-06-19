Load the `orch-docs-updater` skill — it is the authoritative map of every documentation surface in this repo and the rules for where a given change belongs. Follow it. For anything you change under `docs/public/`, that skill will tell you to load `doc-writer`; do so.

**The change set you are documenting** is everything this feature session produced. Read `{{sessionsDir}}/brainstorm.md` and `{{sessionsDir}}/plan.md` first — they state what this change is and why; treat them as the primary signal for intent. Then ground that intent in what actually shipped: skim `{{sessionsDir}}/acceptance-tests.md`, the two code reviews, `{{sessionsDir}}/fix-plan.md`, and the logs under `{{sessionsDir}}/work/`, and use `git` to read the real diff in `src/` — especially whether the public barrel `src/index.ts` and the module barrels it re-exports changed.

**Classify and apply.** Using the documentation map and routing rules from the skill, decide which surfaces this change touches and update them directly:
- Public API changed (exports from `src/index.ts`) → reconcile `docs/public/reference/api.md` / `runners.md` and any affected guide, via `doc-writer` and its sync-guard.
- User-facing capability, CLI, or config changed → update `README.md` (only if it is a headline capability) and the relevant `docs/public` page.
- Agent-facing rules or conventions changed → update `CLAUDE.md` (and `AGENTS.md` only if it already exists or the rule genuinely belongs outside `CLAUDE.md`).
- Nothing user- or agent-facing changed → say so explicitly and edit no docs. Do not invent doc churn.

If you touched anything under `docs/public/`, run `bun run docs:build` and fix any dead-link failures before finishing.

**Capture learnings worth remembering.** For each genuinely non-obvious problem this build solved — a root cause that took digging, a gotcha that passes every test, an insight that would save a future developer real time — write one file under `docs/solutions/` with the dated frontmatter (`date`, `topic`, `status`) and Symptom / Root cause / Fix sections. Do NOT record what the repo already encodes (code structure, obvious decisions, anything already in `CLAUDE.md`, the plan, or the brainstorm). If nothing clears that bar, write none — that is a normal outcome.

**Report.** Write `{{sessionsDir}}/docs-update.md` as a concise summary: a table of every documentation surface with `updated` / `not needed` and a one-line reason, the list of `docs/solutions/` files you created (or "none"), and any doc work you deliberately deferred with its reason.
