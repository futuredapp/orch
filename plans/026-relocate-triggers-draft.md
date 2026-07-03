# Plan 026: Move the unshipped `triggers.md` draft out of the published docs

> **Executor instructions**: Follow step by step; run every verification command.
> Stop and report on any STOP condition. Update the plan 026 row in
> `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git status --porcelain docs/public/guides/triggers.md`
> This file was untracked at planning time. If it is now tracked, committed, or the
> triggers feature has shipped in `src/`, STOP and reassess (see STOP conditions).

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs (hygiene)
- **Planned at**: commit `0265592`, 2026-07-02

## Why this matters

`docs/public/guides/triggers.md` is a **design draft for an unshipped feature** — it
self-declares "Design draft — not shipped yet … Triggers don't exist in orch yet"
and documents `defineTrigger`, `cron()`, `webhook()`, `manual()`, `ctx.launch()`,
`orch ps`, `orch attach`, `orch fire`, `run --background` — none of which exist in
`src/`. It lives under the **published** `docs/public/` tree. It is one sidebar edit
away from publishing vaporware, and it violates house style (signatures must be
quoted from `src/`; no forward references). The published docs should describe only
shipped behavior; the draft belongs in the internal design-docs area until the
feature lands.

## Current state

- `docs/public/guides/triggers.md:5-7` — the "not shipped yet" banner; the rest
  documents the speculative API.
- It is NOT wired into the sidebar (`docs/public/.vitepress/config.mts` omits it), so
  `bun run docs:build` currently passes — but the file sits in the published root.
- `grep -rn "defineTrigger\|orch ps" src/` returns nothing (feature absent).
- Internal design docs live under `docs/` outside `docs/public/` (per CLAUDE.md:
  `docs/brainstorms/`, `docs/plans/`, `docs/adr/`, `docs/findings/`, `docs/issues/`,
  `docs/solutions/`). `docs/brainstorms/` is the right home for a forward-looking
  design draft.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Confirm feature absent | `grep -rn "defineTrigger" src/` | no output |
| Confirm not in sidebar | `grep -n "triggers" docs/public/.vitepress/config.mts` | no output |
| No inbound links | `grep -rn "guides/triggers" docs/public` | no output (or only the file itself) |
| Docs build (gate) | `bun run docs:build` | exit 0 |

## Scope

**In scope:**
- Move `docs/public/guides/triggers.md` →
  `docs/brainstorms/2026-07-02-triggers-design-draft.md` (or the dated naming
  convention already used in `docs/brainstorms/` — match existing filenames there).

**Out of scope (do NOT touch):**
- The draft's CONTENT — just relocate it (optionally add a one-line header noting it
  is an internal design draft, but do not rewrite it).
- Any shipped guide.
- The sidebar (the file isn't in it; nothing to remove).

## Steps

### Step 1: Confirm it is safe to move

Run the three "confirm" commands above. All three must show the feature is absent,
the page isn't in the sidebar, and nothing in `docs/public/` links to it. If ANY
inbound link exists in a published page, STOP and report (removing the page would
break the docs gate; the link must be handled first).

### Step 2: Check the brainstorms naming convention

`ls docs/brainstorms/` and match its filename convention (the repo uses
`YYYY-MM-DD-<slug>` style — see the memory/CLAUDE references). Pick a matching name,
e.g. `docs/brainstorms/2026-07-02-triggers-design-draft.md`.

### Step 3: Move the file

Move `docs/public/guides/triggers.md` to the chosen internal path (use `git mv` if
the file is tracked; a plain move if it is untracked — the drift check told you
which). Optionally prepend a single line:
`> Internal design draft — the triggers feature is not shipped. Do not publish.`

**Verify**: `bun run docs:build` → exit 0 (the published tree no longer contains the
draft; no dead links).

## Test plan

- Docs gate: `bun run docs:build` passes.
- Confirm the file no longer exists under `docs/public/`:
  `test ! -f docs/public/guides/triggers.md && echo OK`.
- No source tests (docs-only).

## Done criteria

ALL must hold:

- [ ] `docs/public/guides/triggers.md` no longer exists.
- [ ] The draft now lives under `docs/brainstorms/` (or the internal design area).
- [ ] `bun run docs:build` exits 0.
- [ ] `grep -rn "guides/triggers" docs/public` returns nothing.
- [ ] `plans/README.md` row 026 updated.

## STOP conditions

Stop and report if:

- A published page links to `guides/triggers` — the link must be removed/redirected
  first; report it.
- The triggers feature has actually shipped in `src/` since planning (drift) — then
  the page should be REWRITTEN as a real guide (signatures quoted from source), not
  relocated; STOP and report so that becomes a different task.

## Maintenance notes

- When triggers ship, bring the design back as a real `docs/public/guides/` page,
  quoting signatures from the implementing module, and wire it into the sidebar.
- This draft is the strongest signal of the project's next direction (see the
  Round-2 direction note in `plans/README.md`) — keep it discoverable internally.
- Reviewer: confirm nothing in the published site depended on the page.
