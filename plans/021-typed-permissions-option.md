# Plan 021: Add a typed `permissions` option to `claude()`

> **Executor instructions**: Follow step by step; run every verification command.
> Stop and report on any STOP condition. Update the plan 021 row in
> `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 0265592..HEAD -- src/runners/claude/claude-runner.ts src/cli/commands/init-templates.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `0265592`, 2026-07-02

## Why this matters

The most common authoring need — run an agent unattended, without permission
prompts — has no typed, discoverable knob for `claude()`. Authors must know a raw
Claude CLI flag, and the project itself models **two inconsistent spellings**:
`flags: ['--dangerously-skip-permissions']` (in `examples/feature`, `examples/ship-many`)
vs `flags: ['--permission-mode', 'bypassPermissions']` (in `examples/math-duel` and
the `orch init` scaffold). A typed `permissions: 'bypass'` option that expands to
one canonical flag makes the common case discoverable and teaches one way.

(Codex already has a typed `sandbox` option — `CodexOptions.sandbox`,
`codex-runner.ts:71-75` — so this plan targets `claude()`, which lacks the
equivalent.)

## Current state

`src/runners/claude/claude-runner.ts`:

- Options (`:88-95`) — only untyped `flags`:
  ```ts
  export interface ClaudeOptions {
    readonly model?: string
    readonly maxTurns?: number
    readonly bare?: boolean
    readonly flags?: readonly string[]
  }
  ```
- `--dangerously-skip-permissions` was deliberately removed from the denylist
  (`:100-106` comment) so unattended runs are allowed — permission bypass is a
  first-class, allowed flag.
- The argv builders spread `opts.flags` at the end, e.g. `buildAutonomousArgv`
  (`:300-320`): `...(opts.flags ?? []), ...ctx.extraArgs`. `buildForkArgv`
  (`:334-356`) does the same, and there is a `buildInteractiveArgv` with the same
  pattern (search for it in the file).
- The factory `claude(opts, deps)` (`:376-383`) destructures
  `{ model, maxTurns, bare = false, flags }`.
- The scaffold uses the bypass spelling: `src/cli/commands/init-templates.ts:22`
  `flags: ['--permission-mode', 'bypassPermissions']`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `bun run typecheck` | exit 0 |
| Argv tests | `bun test tests/tmux-argv` | all pass |
| Runner tests | `bun test tests/unit/runners/claude` | all pass |
| Full gate | `bun run check` | exit 0 |

## Scope

**In scope:**
- `src/runners/claude/claude-runner.ts` — add `permissions?: 'bypass'` to
  `ClaudeOptions`; expand it into the canonical flag wherever `flags` flows into the
  argv builders.
- `src/cli/commands/init-templates.ts` — switch the scaffold to `permissions: 'bypass'`.
- Optionally the example workflows that use the raw flags (see Step 4).
- Tests under `tests/tmux-argv` and/or `tests/unit/runners/claude`.

**Out of scope (do NOT touch):**
- `codex()` — it already has `sandbox`.
- The `flags` escape hatch — keep it working; `permissions` is additive.
- The denylist.

## Steps

### Step 1: Add the option

Extend `ClaudeOptions` (`:88-95`):

```ts
export interface ClaudeOptions {
  readonly model?: string
  readonly maxTurns?: number
  readonly bare?: boolean
  /** Permission handling for unattended runs. 'bypass' expands to
   *  `--permission-mode bypassPermissions`. Omit for Claude's default prompting.
   *  For anything else, use `flags`. */
  readonly permissions?: 'bypass'
  readonly flags?: readonly string[]
}
```

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Expand it to the canonical flag

Define the canonical expansion once, near the top of the file:

```ts
const PERMISSION_FLAGS: Readonly<Record<NonNullable<ClaudeOptions['permissions']>, readonly string[]>> = {
  bypass: ['--permission-mode', 'bypassPermissions'],
}
```

In the `claude()` factory, compute an effective flags list ONCE and use it
everywhere `opts.flags` currently flows into the argv builders:

```ts
const { model, maxTurns, bare = false, permissions, flags } = opts
const effectiveFlags = [
  ...(permissions !== undefined ? PERMISSION_FLAGS[permissions] : []),
  ...(flags ?? []),
]
```

Then pass `effectiveFlags` where each argv builder receives `flags` (i.e. build the
`opts` object handed to `buildInteractiveArgv` / `buildAutonomousArgv` /
`buildForkArgv` with `flags: effectiveFlags`). Locate all three builder call sites
inside `buildCommand`/the recovery path and thread `effectiveFlags` consistently.
The denylist guard (`assertFlagAllowed`) still runs on the resulting flags — the
canonical bypass flag is allowed, so it passes.

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Switch the scaffold

In `src/cli/commands/init-templates.ts:20-23`, replace:
```ts
agent: claude({
  bare: false,
  flags: ['--permission-mode', 'bypassPermissions'],
}),
```
with:
```ts
agent: claude({
  bare: false,
  permissions: 'bypass',
}),
```

**Verify**: `bun test tests/unit/cli/commands/init-templates.test.ts` → all pass
(update the test's expected template string if it asserts the old flags).

### Step 4: (Optional) migrate examples to one spelling

For consistency, switch the example workflows that use raw permission flags to
`permissions: 'bypass'` (search `examples/` for `--permission-mode` and
`--dangerously-skip-permissions`). This is optional polish; if it balloons scope or
an example depends on the exact `--dangerously-skip-permissions` semantics, leave it
and note it. Do NOT change example behavior.

### Step 5: Tests + gate

Add a `tests/tmux-argv` (or `tests/unit/runners/claude`) case asserting that
`claude({ permissions: 'bypass' })` produces an argv containing
`--permission-mode bypassPermissions`, mirroring how existing argv tests assert flag
presence.

**Verify**: `bun test tests/tmux-argv tests/unit/runners/claude` → all pass;
`bun run check` → exit 0.

## Test plan

- New case: `permissions: 'bypass'` → argv includes `--permission-mode
  bypassPermissions`, in autonomous AND fork argv (recovery path).
- Regression: `flags` still appended; `permissions` + `flags` both present works.
- Pattern to copy: existing argv-assembly tests under `tests/tmux-argv`.
- Verification: `bun test tests/tmux-argv tests/unit/runners/claude` → all pass.

## Done criteria

ALL must hold:

- [ ] `ClaudeOptions` has `permissions?: 'bypass'`.
- [ ] `claude({ permissions: 'bypass' })` yields the canonical flag in autonomous
      and fork argv (test passes).
- [ ] The scaffold uses `permissions: 'bypass'`.
- [ ] `flags` still works as before.
- [ ] `bun run check` exits 0.
- [ ] Only in-scope files modified.
- [ ] `plans/README.md` row 021 updated.

## STOP conditions

Stop and report if:

- There are argv-builder call sites for `flags` you cannot all locate/thread
  consistently — report which.
- Reconciling the docs reference (`docs/public/reference/runners.md`) is required by
  the docs gate — if `bun run check` fails on a docs signature mismatch, update
  `runners.md`'s `ClaudeOptions` signature to add `permissions` (quote from source),
  then re-run.

## Maintenance notes

- If a second permission mode is ever needed (e.g. `'ask'` explicit), extend the
  `permissions` union and the `PERMISSION_FLAGS` map together.
- After this lands, reconcile `docs/public/reference/runners.md` per CLAUDE.md ("after
  any change to the public barrels, reconcile the reference").
- Reviewer: confirm `permissions` is expanded in ALL argv paths including fork
  recovery, or an unattended run could prompt during recovery.
