# Plan 025: Add a troubleshooting guide page

> **Executor instructions**: Follow step by step; run every verification command.
> Stop and report on any STOP condition. Update the plan 025 row in
> `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 0265592..HEAD -- docs/public`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `0265592`, 2026-07-02

## Why this matters

There is no troubleshooting page, and the ~60 `*Error` types in the codebase link to
nothing. When a run dies with `CodexVersionError`, a config-shape error, a
step-name collision, or a subworkflow-depth error, the user gets a message with no
pointer to a fix. The debugging guide only covers "read the transcript / what's on
disk / heavy captures / the resume lens" — not "common failure → fix." A single
symptom→cause→fix page turns the highest-frequency DX dead-ends into recoverable
situations.

## Current state

- Debugging guide: `docs/public/guide/6-debugging.md` — headings are
  "Read the transcript / What's on disk / Turn on heavy captures / The resume lens".
  No failure→fix mapping.
- No `docs/public/guide/troubleshooting.md` exists.
- VitePress sidebar config: `docs/public/.vitepress/config.mts` (a new page must be
  added to the sidebar or it won't be navigable). `bun run docs:build` fails on dead
  internal links — that is the docs gate.
- User-facing errors worth documenting (each has an actionable message in-code; the
  page collects them in one place):
  - Missing/old runner CLI or auth — Claude/Codex not installed or not logged in.
  - `CodexVersionError` — Codex CLI too old (`src/runners/codex/`).
  - Empty-JSON-Schema error — usually Zod v4 in the host project vs orch's Zod v3;
    the full remedy is already in `src/core/schema.ts:50-63` (import `z` from
    `'orch'`, or `bun add zod@^3`).
  - `ConfigLoadError` — bad/missing `orch.config.ts` export or (after plan 019)
    an unknown/typo'd key.
  - `StepNameCollisionError` / `DuplicateStepNameError` (plan 020) — same step name
    reused; fix with distinct names or `run(STEP, { as: '...' })`.
  - `SubworkflowDepthError` — recursion past the depth bound; raise
    `WorkflowDeps.maxSubworkflowDepth` or fix the recursion (`src/core/errors.ts:137`).
  - `PromptFileError` — prompt file missing/empty/traversal.
  - tmux missing or too old for `--mode=two-pane` — fall back to `--mode=plain`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Docs build (gate) | `bun run docs:build` | exit 0, no dead links |
| Docs preview | `bun run docs:dev` | serves locally (manual check) |

## Scope

**In scope:**
- `docs/public/guide/troubleshooting.md` (create).
- `docs/public/.vitepress/config.mts` — add the page to the sidebar.
- `docs/public/guide/6-debugging.md` — add a link to the new page.

**Out of scope (do NOT touch):**
- Source error messages — this plan is docs-only. (Adding doc anchors to error
  strings is a separate follow-up.)
- Internal docs under `docs/` outside `docs/public/`.

## Steps

### Step 1: Load the doc-writer conventions

Read the `doc-writer` skill (it codifies house style: one concept per page, runnable
examples with imports shown, reference signatures quoted from `src/`, no forward
references in the numbered guide). Match it. Quote each error's cause/remedy from the
source (e.g. the schema remedy from `src/core/schema.ts:50-63`) rather than
inventing text.

### Step 2: Write the troubleshooting page

Create `docs/public/guide/troubleshooting.md` as a symptom → cause → fix table/list
covering the errors in "Current state". For each: the symptom the user sees (the
error name + a representative message), the cause, and the concrete fix (command or
edit). Keep entries short and copy-pasteable. Cross-link to `6-debugging.md` for the
deeper log-reading flow. Do NOT reference unshipped features (e.g. triggers — see
plan 026).

Verify each documented message against the source before writing it (open the cited
file) — a wrong remedy is worse than none.

### Step 3: Wire it into the sidebar and link from debugging

Add the new page to `docs/public/.vitepress/config.mts` sidebar (mirror how the
existing guide pages are registered). Add a one-line link from
`docs/public/guide/6-debugging.md` to the troubleshooting page ("For common
failures and their fixes, see Troubleshooting.").

**Verify**: `bun run docs:build` → exit 0 (no dead internal links; the new page is
reachable).

## Test plan

- Docs gate: `bun run docs:build` passes (this is the only automated gate for docs).
- Manual: `bun run docs:dev`, open the troubleshooting page, confirm it renders and
  the debugging→troubleshooting link works.
- No source tests (docs-only change).

## Done criteria

ALL must hold:

- [ ] `docs/public/guide/troubleshooting.md` exists and covers the listed errors
      (each with cause + fix quoted/derived from source).
- [ ] The page is in the VitePress sidebar and linked from `6-debugging.md`.
- [ ] `bun run docs:build` exits 0 with no dead links.
- [ ] No `src/` files modified.
- [ ] `plans/README.md` row 025 updated.

## STOP conditions

Stop and report if:

- `bun run docs:build` fails on a dead link you cannot resolve (a referenced page
  moved) — report the link.
- An error's actual message/remedy in source contradicts this plan's summary (drift)
  — document the source's version and note the discrepancy.

## Maintenance notes

- Follow-up (separate plan): append a doc anchor to the richest error messages
  (schema, config, version) pointing at this page's section, so the CLI output links
  to the fix.
- When plans 019/020 land, add their new failure modes (unknown config key;
  `DuplicateStepNameError`) to this page.
- Reviewer: verify every remedy actually works (e.g. the Zod-v3 fix, the tmux
  fallback) — a troubleshooting page with a wrong fix erodes trust.
