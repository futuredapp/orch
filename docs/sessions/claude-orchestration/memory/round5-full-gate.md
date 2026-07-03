# round5-full-gate

Full consolidated gate run over `feat/claude-orchestration` (28 commits ahead of develop, all 20 Round-2 plans committed). Read-only: no source/test/doc edits, no git.

## Verdict

**GATE RED** — real regression in `src/core/step.ts` (a lint failure). NOT the known real-tmux flake, NOT a pre-existing ENOENT fixture failure.

## Commands run and exit codes

- `bun run check` → **exit 1** (captured to /tmp/orch-check.log via `(bun run check > log 2>&1; echo EXIT_CODE=$? >> log)`; the wrapper subshell's own exit was 0 because the trailing `echo` succeeded — the real gate exit is the `EXIT_CODE=1` line inside the log, do not trust the wrapper status).
- `bun run lint` (rerun alone to confirm determinism) → **exit 1**, reproduced identically. One error, no other lint issues.

`check` runs `lint && typecheck && test && test:two-pane:lifecycle && check:migration`. Lint is the **first** stage, so it fails fast and **typecheck + all tests never ran**. We therefore have no signal on the test suites this round — the gate must be re-run after lint is green.

## The failure

- File: `src/core/step.ts:16`
- Rule: biome `assist/source/organizeImports` — "Sort the imported names." (Safe fix available.)
- Current (failing) line:
  ```ts
  import { SchemaValidationError, schema, type SchemaWrapper } from './schema.ts'
  ```
- Biome-required order:
  ```ts
  import { SchemaValidationError, type SchemaWrapper, schema } from './schema.ts'
  ```
  (Biome sorts named members case-insensitively: `SchemaValidationError`, `SchemaWrapper`, then `schema`; the value `schema` currently sits before the type member `SchemaWrapper`.)

## Classification

**Real regression**, deterministic and reproducible on every run. Introduced by build-023 (bare-Zod `returns:`), which added the `SchemaWrapper` type import to `src/core/step.ts` (footprint = `src/core/{step.ts,schema.ts}`, per the build-023 / review-round4 diaries). Build-023's worker ran only path-scoped tests + `bun run typecheck` (never `bun run lint` or the full `bun run check`), so biome's import-sort assist never gated it — which is exactly why it slipped through to this first consolidated gate.

It is NOT the documented real-tmux ~5s timeout flake in `tests/integration/services/tmux/tmux-real.integration.test.ts`, and NOT the 5 known pre-existing ENOENT failures under gitignored `.orch/` fixtures. Neither category was reached, because lint gates before any test runs.

## Reproduce (for the follow-up fix task)

```
bun run lint        # exit 1, single error at src/core/step.ts:16
```

## Fix (for a later task — NOT done here per read-only rules)

Trivial and mechanical. Either apply biome's safe fix (`bun run lint:fix`, which is `biome check --write .`) or hand-edit line 16 to the required member order shown above. Scope is one line in `src/core/step.ts`; nothing else needs to change. After fixing, **re-run the full `bun run check`** from the top — because lint short-circuited, typecheck / unit / mocked-integration / real-tmux / two-pane-lifecycle / check:migration are all still unverified this round and must be exercised (watch for the known real-tmux flake at that point: rerun `bun test tests/integration/services/tmux/tmux-real.integration.test.ts` up to 3× before calling it a regression).

## Left for later / risk

- Whole gate below lint is unverified — do not assume the test tree is green just because only lint failed. The lint fix must be followed by a clean full-gate pass before Round-2 can be declared shippable / a PR to develop opened.
- Process note for the master: any worker that touches source but skips `bun run lint` can leave a biome-assist regression that only the consolidated gate catches. Build-023's diary explicitly recorded typecheck-only verification.
