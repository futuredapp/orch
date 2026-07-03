# Plan 014: Extract shared transcript-format helpers used by both runners

> **Executor instructions**: Follow step by step; run every verification command.
> Stop and report on any STOP condition. Update the plan 014 row in
> `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 0265592..HEAD -- src/runners/claude/format-event.ts src/runners/codex/format-event.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `0265592`, 2026-07-02

## Why this matters

The Claude and Codex transcript formatters carry byte-identical string helpers
(`truncate`, `middleEllipsis`, `firstLine`, `firstNonEmptyLine`, `humanCount`,
`readString`, `readObject`, `numberField`, plus `MAX_*` constants). The copies have
already drifted (`formatDuration` exists only in the Claude copy), and any
transcript-rendering fix must be applied twice or the two runners silently diverge.
Extracting the shared helpers into one internal module removes ~90 duplicated lines
and makes the two formatters diverge only where they legitimately should.

## Current state

- `src/runners/claude/format-event.ts:235-287` defines the helpers; the `MAX_*`
  constants are near the top (`format-event.ts:21-26`). Example (`:235-268`):
  ```ts
  function truncate(s: string, max: number): string { /* ... */ }
  function middleEllipsis(p: string, max: number): string { /* ... */ }
  function firstLine(s: string): string { /* ... */ }
  function firstNonEmptyLine(s: string): string { /* ... */ }
  function formatDuration(ms: number): string { /* ... */ }   // Claude only
  function humanCount(n: number): string { /* ... */ }
  function readString(obj, key): string | undefined { /* ... */ }
  function readObject(obj, key): Readonly<Record<string, unknown>> | undefined { /* ... */ }
  function numberField(obj, key): number | undefined { /* ... */ }
  ```
- `src/runners/codex/format-event.ts:205-263` defines the same helpers (per the
  audit, byte-identical except `formatDuration` is absent), and `MAX_*` at
  `codex/format-event.ts:23-27`.
- `formatTokens` (`claude:219` / `codex:194`) and `formatTurnComplete`
  (`claude:190` / `codex:168`) are NEAR-identical but legitimately diverge (Claude
  adds cache-token lines) — **leave those per-runner**.
- Tests: `tests/unit/runners/claude/format-event.test.ts` and
  `tests/unit/runners/codex/format-event.test.ts` cover the formatters.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Confirm identity | `diff <(sed -n '235,287p' src/runners/claude/format-event.ts) <(sed -n '205,263p' src/runners/codex/format-event.ts)` | only `formatDuration` differs |
| Typecheck | `bun run typecheck` | exit 0 |
| Format tests | `bun test tests/unit/runners/claude/format-event.test.ts tests/unit/runners/codex/format-event.test.ts` | all pass |
| Full gate | `bun run check` | exit 0 |

## Scope

**In scope:**
- Create `src/runners/transcript-format-utils.ts` (a runner-internal module, NOT
  exported from the public barrel `src/index.ts`).
- `src/runners/claude/format-event.ts` and `src/runners/codex/format-event.ts` —
  delete the moved helpers, import them from the new module.

**Out of scope (do NOT touch):**
- `formatTokens` / `formatTurnComplete` in either file — they diverge on purpose.
- `src/index.ts` and `src/runners/index.ts` — do not export the new util publicly.
- The `MAX_*` constants that are NOT identical between the two files (verify first;
  only move the ones that match exactly).

## Steps

### Step 1: Verify which helpers/constants are truly identical

Run the `diff` command above and manually compare the `MAX_*` constant blocks
(`claude:21-26` vs `codex:23-27`). Make a list of helpers + constants that are
**byte-identical** between the files. Only those move. `formatDuration` (Claude
only) also moves (it's used by Claude and harmless to share).

If a helper you expected to be identical actually differs, exclude it and note the
divergence in your report.

### Step 2: Create the shared module

Create `src/runners/transcript-format-utils.ts` exporting the identical helpers and
the identical `MAX_*` constants. Add a top-of-file comment:
`// Runner-internal transcript formatting helpers shared by claude/ and codex/. Not on the public barrel.`
Match the surrounding code style (no default export; named exports; strict types;
no `any`).

**Verify**: `bun run typecheck` → exit 0 (module compiles standalone).

### Step 3: Switch both formatters to import from it

In each of `claude/format-event.ts` and `codex/format-event.ts`: delete the
now-moved local helper/const definitions and add
`import { truncate, middleEllipsis, /* ...the moved names... */ } from '../transcript-format-utils.ts'`.
Keep the per-runner `formatTokens`/`formatTurnComplete` and anything that diverges.

**Verify**: `bun run typecheck` → exit 0;
`bun test tests/unit/runners/claude/format-event.test.ts tests/unit/runners/codex/format-event.test.ts`
→ all pass.

### Step 4: Confirm no behavior change

**Verify**: `bun run check` → exit 0. The transcript-format tests passing unchanged
is the proof that the extraction is behavior-preserving.

## Test plan

- No new tests required — the existing format-event tests for both runners are the
  regression guard (they must pass unchanged).
- Optionally add one tiny unit test `tests/unit/runners/transcript-format-utils.test.ts`
  for `middleEllipsis` (the least-obvious helper) if you want direct coverage; mirror
  the assertion style in the existing format-event tests.
- Verification: both format-event test files pass unchanged.

## Done criteria

ALL must hold:

- [ ] `src/runners/transcript-format-utils.ts` exists and is imported by both
      `format-event.ts` files.
- [ ] `grep -n "function truncate" src/runners/claude/format-event.ts src/runners/codex/format-event.ts`
      returns nothing (the definitions moved).
- [ ] `grep -rn "transcript-format-utils" src/index.ts src/runners/index.ts` returns
      nothing (not public).
- [ ] Both format-event test files pass unchanged.
- [ ] `bun run check` exits 0.
- [ ] Only in-scope files modified.
- [ ] `plans/README.md` row 014 updated.

## STOP conditions

Stop and report if:

- The `diff` shows the helper bodies are NOT identical beyond `formatDuration` —
  report what differs; move only the truly-identical subset.
- A format-event test fails after the switch — that means a helper was not actually
  identical; revert that helper to per-runner and report.

## Maintenance notes

- Future transcript-formatting fixes to a shared helper now land once. If a runner
  needs a divergent variant, keep it local rather than adding a flag to the shared
  helper.
- Reviewer: confirm the new module is not re-exported publicly (it's an internal
  detail; the public surface is `toClaudeTranscriptLines` etc., unchanged).
