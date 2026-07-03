# Plan 015: Extract the shared runner flag-denylist guard

> **Executor instructions**: Follow step by step; run every verification command.
> Stop and report on any STOP condition. Update the plan 015 row in
> `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 0265592..HEAD -- src/runners/claude/claude-runner.ts src/runners/codex/codex-runner.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt / security
- **Planned at**: commit `0265592`, 2026-07-02

## Why this matters

`claude()` and `codex()` each define a structurally identical `assertFlagAllowed`
guard that blocks dangerous CLI flags (config/MCP injection vectors). Two copies of
a **security-relevant** guard means a fix to its matching semantics (e.g. handling
`--flag value` vs `--flag=value`) must be duplicated, and divergence here is a
real injection footgun. Extracting one factory keeps the enforcement logic single-
sourced while each runner keeps its own denylist content.

## Current state

- `src/runners/claude/claude-runner.ts:106-114`:
  ```ts
  const CLAUDE_FLAG_DENYLIST = ['--settings', '--mcp-config'] as const

  function assertFlagAllowed(flag: string): void {
    for (const deny of CLAUDE_FLAG_DENYLIST) {
      if (flag === deny || flag.startsWith(`${deny}=`)) {
        throw new Error(`claude(): flag "${flag}" is on the denylist`)
      }
    }
  }
  ```
- `src/runners/codex/codex-runner.ts:81-96`:
  ```ts
  const CODEX_FLAG_DENYLIST = [
    '--dangerously-bypass-approvals-and-sandbox',
    '--yolo', '--config', '--sandbox', '-c', '--approval-mode',
  ] as const

  function assertFlagAllowed(flag: string): void {
    for (const deny of CODEX_FLAG_DENYLIST) {
      if (flag === deny || flag.startsWith(`${deny}=`)) {
        throw new Error(`codex(): flag "${flag}" is on the denylist`)
      }
    }
  }
  ```
  The guard body is identical; only the denylist constant and the `claude()` /
  `codex()` prefix in the error message differ.
- Call sites: e.g. `claude-runner.ts:391-392` and the equivalent codex argv builder
  loop over `flags`/`ctx.extraArgs` calling `assertFlagAllowed`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `bun run typecheck` | exit 0 |
| Runner tests | `bun test tests/unit/runners` | all pass |
| Full gate | `bun run check` | exit 0 |

## Scope

**In scope:**
- Create `src/runners/flag-guard.ts` (runner-internal, NOT on the public barrel).
- `src/runners/claude/claude-runner.ts` and `src/runners/codex/codex-runner.ts` —
  replace the local `assertFlagAllowed` with a guard built from the shared factory;
  keep each denylist constant local.

**Out of scope (do NOT touch):**
- The denylist CONTENTS — they legitimately differ per runner; do not merge them.
- The argv builders (`buildInteractiveArgv`/`buildAutonomousArgv`/`buildForkArgv`)
  beyond swapping the guard call.
- `prepareAutoStop` logic in either runner.
- The public barrels.

## Steps

### Step 1: Create the shared guard factory

Create `src/runners/flag-guard.ts`:

```ts
// Runner-internal: builds the flag-denylist guard shared by claude()/codex().
// Not exported from the public barrel.
export function makeFlagGuard(
  runnerName: string,
  denylist: readonly string[],
): (flag: string) => void {
  return (flag: string): void => {
    for (const deny of denylist) {
      if (flag === deny || flag.startsWith(`${deny}=`)) {
        throw new Error(`${runnerName}(): flag "${flag}" is on the denylist`)
      }
    }
  }
}
```

Match the exact error-message format the runners use today
(`` `${runnerName}(): flag "${flag}" is on the denylist` ``) so no test that
asserts the message changes.

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Use it in the Claude runner

In `claude-runner.ts`, keep `CLAUDE_FLAG_DENYLIST`, delete the local
`assertFlagAllowed` function, and create the guard:
`const assertFlagAllowed = makeFlagGuard('claude', CLAUDE_FLAG_DENYLIST)`
(place it where the function was, so existing call sites are unchanged). Add
`import { makeFlagGuard } from '../flag-guard.ts'`.

**Verify**: `bun test tests/unit/runners/claude` → all pass.

### Step 3: Use it in the Codex runner

Same change in `codex-runner.ts` with
`const assertFlagAllowed = makeFlagGuard('codex', CODEX_FLAG_DENYLIST)`.

**Verify**: `bun test tests/unit/runners/codex` → all pass.

### Step 4: Gate

**Verify**: `bun run check` → exit 0.

## Test plan

- No new tests required if existing runner tests already assert a denied flag throws
  (search `tests/unit/runners` for `denylist` / `is on the denylist`). They are the
  regression guard and must pass unchanged.
- If NO existing test covers the denylist, add one to
  `tests/unit/runners/flag-guard.test.ts`: assert `makeFlagGuard('x', ['--settings'])`
  throws for `--settings` and `--settings=foo` and does NOT throw for an allowed
  flag. Mirror the assertion style of a nearby runner unit test.
- Verification: `bun test tests/unit/runners` → all pass.

## Done criteria

ALL must hold:

- [ ] `src/runners/flag-guard.ts` exists and is imported by both runners.
- [ ] `grep -n "function assertFlagAllowed" src/runners/claude/claude-runner.ts src/runners/codex/codex-runner.ts`
      returns nothing (the standalone functions are gone).
- [ ] The denylist constants remain per-runner (both `CLAUDE_FLAG_DENYLIST` and
      `CODEX_FLAG_DENYLIST` still exist).
- [ ] `grep -rn "flag-guard" src/index.ts src/runners/index.ts` returns nothing (not
      public).
- [ ] `bun run check` exits 0.
- [ ] Only in-scope files modified.
- [ ] `plans/README.md` row 015 updated.

## STOP conditions

Stop and report if:

- The error-message format differs between the two runners in a way the factory
  can't reproduce with just `runnerName` — report it.
- A runner test asserting the denylist message fails after the swap — the message
  format drifted; align the factory and report.

## Maintenance notes

- New runners should build their guard via `makeFlagGuard(name, THEIR_DENYLIST)`
  rather than re-implementing the loop — note this in the runner-author skill if
  updating docs later.
- Reviewer: confirm the matching semantics (`=`-prefix) are preserved exactly; this
  is the security-relevant part.
