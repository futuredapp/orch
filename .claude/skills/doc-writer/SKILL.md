---
name: doc-writer
description: How to write and maintain orch's user-facing documentation under docs/public/ (the VitePress site). Use when adding or editing any guide/reference/examples page, or after a change to the public API in src/index.ts.
---

# Doc Writer Guide

User-facing docs live under `docs/public/` and are published as a VitePress site. The rest of `docs/` (brainstorms, plans, adr, findings, issues, solutions) is **internal** — never link the public site into it, and never publish it.

The audience is developers evaluating or onboarding to orch. They read top to bottom, once. Optimize for that.

## The three rules

These are non-negotiable. A page that breaks one is not done.

1. **Simple and top-to-bottom.** One concept per page. The numbered `guide/` pages must read in order — never reference a concept the reader hasn't met yet (no forward references). Define a term the first time you use it. Short sentences, plain language, active voice.

2. **Every user-facing API gets a complete, runnable example.** Show the imports. No `...` elisions in the core path of the example. A reader must be able to copy the block and run it. Prefer adapting a real snippet from `examples/` over inventing one.

3. **Reference pages quote the real signature.** For anything under `reference/`, the signature must match the source in `src/` — not a paraphrase. If you're unsure, read the file in `src/core/`, `src/runners/`, `src/validators/`, or `src/config/` and copy the actual type.

## Information architecture

```
docs/public/
├── index.md            # landing (hero + one-file pitch)
├── guide/              # linear narrative, numbered, read in order
├── guides/             # how-to recipes, consult as needed
├── reference/          # exhaustive, consulted not read
└── examples.md         # indexed tour of examples/
```

- **Guide** (`guide/N-*.md`) — teaches. Tutorial + explanation. Numbered.
- **Guides** (`guides/*.md`) — task recipes. "How do I X?" One task per page.
- **Reference** (`reference/*.md`) — facts. Signatures, flags, tables. Dry and complete.

When in doubt about where content goes: if the reader is *learning*, it's a guide; if they're *doing a known task*, it's a how-to guide; if they're *looking something up*, it's reference.

## Per-page template

Every page starts with an H1 and a one-line "what you'll learn" callout, and ends with a "Where to go next" section linking 2-3 related pages. See `references/page-template.md`.

## Wiring a new page

A new page is invisible until it's in the sidebar. After creating `docs/public/<section>/<name>.md`, add it to the `sidebar` (and `nav` if top-level) in `docs/public/.vitepress/config.mts`.

## The sync guard

The public API is the set of exports from `src/index.ts` (which re-exports `src/core/`, `src/runners/`, `src/validators/`, `src/config/`, etc.). `reference/api.md` and `reference/runners.md` must stay in sync with it.

After any change to those barrels — or before publishing — verify nothing drifted:

```bash
# List the public exports the docs are supposed to cover.
grep -hoE 'export (function|const|class) [A-Za-z]+' src/core/*.ts src/runners/*/index.ts src/validators/*.ts src/config/*.ts
```

Cross-check each user-facing export against `reference/`. If an export is new, document it. If a documented symbol no longer exists, remove it. **Do not document private helpers** — only what a workflow author imports from `orch`.

> Watch for stale aspirational docs. `docs/getting-started.md` (the old decision-review doc) describes APIs that were never shipped (`step.define` was kept, but `run.custom`, `@you/orch`, and `orch.requestHumanInput` were not). Always ground content in `src/`, not in older docs.

## Checklist before you call a page done

- [ ] One concept; no forward references to unmet concepts.
- [ ] At least one complete, runnable example with imports shown.
- [ ] Reference signatures copied from `src/`, not paraphrased.
- [ ] Added to the sidebar in `.vitepress/config.mts`.
- [ ] All internal links resolve (`bun run docs:build` fails on dead links).
- [ ] No links into internal `docs/` (brainstorms, plans, adr, …).

## Build and preview

```bash
bun run docs:dev      # local dev server with hot reload
bun run docs:build    # production build — FAILS on any dead internal link
bun run docs:preview  # serve the built site
```

`docs:build` passing (no dead links) is the correctness gate for docs.
