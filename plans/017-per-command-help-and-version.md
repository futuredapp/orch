# Plan 017: Per-command `--help` and a `--version` flag

> **Executor instructions**: Follow step by step; run every verification command.
> Stop and report on any STOP condition. Update the plan 017 row in
> `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 0265592..HEAD -- src/cli/main.ts`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `0265592`, 2026-07-02

## Why this matters

`orch <cmd> --help` prints the single global help blob for every command, so a user
who runs `orch logs --help` or `orch resume --help` learns nothing about that
command's flags (`--step`, `--follow`, `--latest`, `--watch`) at the point of use.
There is also no `orch --version`. Standard CLI muscle memory (`tool cmd --help`,
`tool --version`) fails silently. Per-command help and a version flag are baseline
CLI ergonomics.

## Current state

`src/cli/main.ts`:

- `--help` is handled before dispatch, always printing the global `HELP`
  (`main.ts:464-467`):
  ```ts
  if (parsed.help) {
    process.stdout.write(HELP)
    process.exit(EXIT.OK)
  }
  ```
- The global `HELP` string is at `main.ts:123-156`; command list and flags are all
  in it.
- Commands are dispatched via the `COMMANDS` record (`main.ts:385-405`):
  `run, resume, retry, runs, status, logs, dry-run, init, new, types`.
- `parseArgs` (`main.ts:177-200`) does not define a `version` option.
- A version string is already available: `orchVersion()` is exported from
  `../observability/index.ts` (used in `src/cli/commands/resume-execution.ts:42,86`).

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `bun run typecheck` | exit 0 |
| CLI arg tests | `bun test tests/unit/cli` | all pass |
| Manual smoke | `bun src/cli/main.ts logs --help` | prints logs-specific help |
| Manual smoke | `bun src/cli/main.ts --version` | prints a version string |
| Full gate | `bun run check` | exit 0 |

## Scope

**In scope:**
- `src/cli/main.ts` — add a per-command help map, route `--help` through the
  resolved command, add `--version`.
- `tests/unit/cli/` — add tests (there is an existing argv-parsing test file; find
  it with `ls tests/unit/cli`).

**Out of scope (do NOT touch):**
- The individual command handlers in `src/cli/commands/` — help text lives in
  `main.ts` alongside the existing `HELP`.
- Behavior of the commands themselves.

## Steps

### Step 1: Add a per-command help map

In `src/cli/main.ts`, next to the global `HELP`, add a `COMMAND_HELP: Record<string, string>`
mapping each command name to a focused usage string. Derive the content from the
existing global `HELP` sections — e.g. the `logs` entry includes the `--latest`,
`--step`, `--follow` lines already in `HELP:149-153`; the `types` entry includes
`--watch` (`HELP:154-156`). Every command in `COMMANDS` should have an entry; keep
each short (usage line + its flags + a one-line description).

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Route `--help` through the resolved command

Change the help handling so that when a command is present, per-command help prints;
otherwise the global help prints. Replace the block at `main.ts:464-467` with logic
like:

```ts
if (parsed.help) {
  const cmdHelp = parsed.command !== undefined ? COMMAND_HELP[parsed.command] : undefined
  process.stdout.write(cmdHelp ?? HELP)
  process.exit(EXIT.OK)
}
```

Place this AFTER `parsed.command` is known (it already is — `parseArgv` returns
`command`). Keep the no-command case printing the global `HELP`.

**Verify**: `bun src/cli/main.ts logs --help` prints the logs-specific help;
`bun src/cli/main.ts --help` prints the global help.

### Step 3: Add `--version`

Add a `version` boolean option to the `parseArgs` options block (`main.ts:177-200`)
and thread it through `parseArgv`'s return (mirror how `help` is threaded). In
`main()`, before command dispatch (near the help handling), add:

```ts
if (parsed.version) {
  process.stdout.write(`${await orchVersion()}\n`)
  process.exit(EXIT.OK)
}
```

Import `orchVersion` from `../observability/index.ts`. Add `--version` to the
`Options:` section of the global `HELP`.

**Verify**: `bun src/cli/main.ts --version` prints a version string and exits 0.

### Step 4: Tests

In `tests/unit/cli/` (use the existing argv/parse test file as the pattern — find it
via `ls tests/unit/cli`), add tests for:
- `parseArgv(['logs', '--help'])` yields `{ help: true, command: 'logs' }` (or
  whatever the parse contract is) so per-command help routing is covered.
- `parseArgv(['--version'])` sets `version: true`.

If the help/version behavior is only observable via `process.exit`/stdout (hard to
unit-test), at minimum unit-test that `COMMAND_HELP` has an entry for every key in
`COMMANDS` (a `for` loop asserting `COMMAND_HELP[name]` is a non-empty string) — this
prevents a future command from shipping without help.

**Verify**: `bun test tests/unit/cli` → all pass; `bun run check` → exit 0.

## Test plan

- `parseArgv` recognizes `--version`.
- `COMMAND_HELP` covers every command in `COMMANDS` (loop assertion).
- Pattern to copy: the existing argv-parsing unit test in `tests/unit/cli/`.
- Verification: `bun test tests/unit/cli` → all pass.

## Done criteria

ALL must hold:

- [ ] `bun src/cli/main.ts logs --help` prints logs-specific help (contains
      `--step` and `--follow`).
- [ ] `bun src/cli/main.ts --version` prints a version and exits 0.
- [ ] `bun src/cli/main.ts --help` still prints the global help.
- [ ] Every command in `COMMANDS` has a `COMMAND_HELP` entry (loop test passes).
- [ ] `bun run check` exits 0.
- [ ] Only in-scope files modified.
- [ ] `plans/README.md` row 017 updated.

## STOP conditions

Stop and report if:

- `orchVersion` is not importable from `../observability/index.ts` or is not async
  as assumed — adjust and note it.
- The `strict: false` parseArgs config makes `--version` collide with an existing
  positional/flag — report.

## Maintenance notes

- When a new subcommand is added to `COMMANDS`, the loop test will fail until a
  `COMMAND_HELP` entry is added — that's the intended forcing function.
- Reviewer: confirm per-command help is printed to stdout (not stderr) and exits 0,
  matching the existing global `--help` behavior.
