# examples-021-migration

Optional plan-021 follow-up: migrate example workflows off the raw `--permission-mode bypassPermissions` flag onto the typed `permissions: 'bypass'` option added by commit `d521685`.

## What I did

Replaced all 10 occurrences of `flags: ['--permission-mode', 'bypassPermissions']` with `permissions: 'bypass'` on the same `claude({...})` call, across 8 files:

- examples/riddle-solver-proper/index.ts (2×)
- examples/riddle-solver/index.ts (2×)
- examples/hello-file/index.ts
- examples/math-duel/index.ts (inline single-line form)
- examples/steps-tui-demo/index.ts (inline single-line form)
- examples/feature-loop/index.ts
- examples/favourite-animal/index.ts
- examples/file-prompts-demo/index.ts

Scope stayed strictly under `examples/`; no `src/`, `tests/`, `docs/` (except this diary), or `plans/` touched.

## Key decisions

- Confirmed the accepted shape from `src/runners/claude/claude-runner.ts:98` (`readonly permissions?: 'bypass'`) and the existing usage in `src/cli/commands/init-templates.ts` (`permissions: 'bypass'`) — matched it exactly.
- Every one of the 10 call sites was `bare: false` (autonomous) with the permission pair as its *only* flag, so each became a clean one-for-one swap with no leftover `flags` array to preserve. **No example used `bare: true`**, so the caveat about interactive mode did not apply — nothing was left alone.
- Used a per-file `for` loop with `perl -i -pe` (not an unquoted `$files` var — zsh does not word-split unquoted variables, which silently made the first attempt a no-op).

## Verified

- `grep -rn "permission-mode" examples/` → returns NOTHING (confirmed empty).
- `bun run typecheck` (`tsc --noEmit`) → **EXIT=0**.

## Left for later / gotchas

- Nothing deliberately left within `examples/`; migration is complete.
- Gotcha for later workers running bulk shell edits in this repo: the shell is **zsh**, so unquoted `$var` does not word-split. Use an explicit array or `for` loop when passing a file list to a command.
