---
date: 2026-05-27
topic: vitepress-user-docs
status: shipped
tags: [docs, tooling, vitepress]
category: documentation
---

# User-facing docs: why VitePress in docs/public/

## Symptom

orch had a rich user-facing surface — a CLI, the `workflow`/`step`/`run`/`parallel`
authoring API, `claude()`/`codex()` runners, validators, `schema()`, config, run
modes, and ~13 examples — but no published, read-top-to-bottom documentation.
The only narrative was `docs/getting-started.md`, and that had drifted: it is a
2026-04-09 *decision-review* doc describing aspirational APIs that were never
shipped (`run.custom`, `@you/orch`, `orch.requestHumanInput`). Everything else
under `docs/` is internal (brainstorms, plans, adr, findings, issues, solutions).

The instinct was to reach for **MkDocs** (Material).

## Root cause / decision

Two facts ruled MkDocs out for a project starting its docs now:

1. **MkDocs Material entered maintenance mode** (announced 2025-11-05): critical
   and security fixes only through ~Nov 2026, then EOL. Its successor (Zensical)
   is not ready. Adopting it means a near-certain migration in 12–24 months.
2. **Python sidecar.** orch is a Bun/TypeScript project. MkDocs would add a
   Python + pip toolchain just for docs.

For a JS/Bun developer tool, **VitePress** is the best fit: TypeScript-native
config, zero Python, native `::: code-group` tabs, offline local search
(MiniSearch), and it's what the most analogous projects use (Vite, Vitest,
Rollup, Pinia). Starlight (Astro) was the close runner-up; Docusaurus only wins
when you need best-in-class versioning, which a v0 CLI does not.

Structure: a **linear narrative** (Diátaxis-informed but read top to bottom),
since the audience is homogeneous (developers onboarding) and the doc surface is
still small.

## What we shipped

- **VitePress site rooted at `docs/public/`** (not `docs/`), so the internal
  `docs/` tree is never published. `.vitepress/config.mts` carries nav + sidebar
  in TypeScript with `ignoreDeadLinks: false` as the correctness gate.
- **Linear structure:** `guide/` (numbered, read in order) → `guides/` (how-to
  recipes) → `reference/` (api, runners, cli, config) → `examples.md`. Key pages
  written in full; the rest are titled stubs to fill via the skill.
- **`doc-writer` skill** (`.claude/skills/doc-writer/`) enforcing three rules:
  simple/top-to-bottom, every user-facing API gets a complete runnable example,
  and reference pages quote the real signature from `src/`. Includes a sync guard
  to diff `src/index.ts` exports against `reference/`.
- **package.json scripts:** `docs:dev`, `docs:build`, `docs:preview`; `vitepress`
  as a devDependency; `docs/public/.vitepress/{cache,dist}/` gitignored.
- **No deploy workflow yet** — deferred to a later pass by choice.

## Why VitePress over the alternatives

| Tool | Verdict |
| --- | --- |
| VitePress | **Chosen.** TS config, no Python, native code tabs, offline search, ecosystem fit. |
| Starlight (Astro) | Close second; component customization needs Astro, no built-in Mermaid. |
| Docusaurus | Only if versioned docs across release lines are needed soon; React overhead otherwise. |
| MkDocs Material | Rejected: maintenance mode (EOL ~Nov 2026) + Python sidecar in a Bun repo. |
| Nextra | Vercel/Next coupling; not a fit for a Bun-first project. |

## Lesson

When grounding docs, read `src/`, not older narrative docs. `docs/getting-started.md`
looked authoritative but documented APIs that don't exist — copying it verbatim
would have shipped wrong examples. The `doc-writer` skill encodes this as a hard
rule (the "stale aspirational docs" warning + the sync guard).

## Related

- Plan: `~/.claude/plans/lets-focus-this-on-quizzical-stearns.md`
- Skill: `.claude/skills/doc-writer/SKILL.md`
- Old narrative (internal, do not publish): `docs/getting-started.md`
- Published docs root: `docs/public/`
