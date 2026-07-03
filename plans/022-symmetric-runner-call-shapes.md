# Plan 022: Make `codex()` and `claude()` call shapes symmetric

> **Executor instructions**: Follow step by step; run every verification command.
> Stop and report on any STOP condition. Update the plan 022 row in
> `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 0265592..HEAD -- src/runners/codex/codex-runner.ts src/runners/claude/claude-runner.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `0265592`, 2026-07-02

## Why this matters

`claude()` can be called with no arguments (`opts` defaults to `{}`), but `codex()`
**requires** an argument — so `codex()` is a compile error while `claude()` is fine.
An author who learns `claude()` and tries `codex()` first hits a confusing
"Expected 1 argument, but got 0". The two option types also share no base, so their
common fields (`model`, `flags`) can't be documented once. Defaulting `codex`'s arg
and extracting a shared base makes the two builders transferable knowledge.

## Current state

- `src/runners/claude/claude-runner.ts:376-379` — `claude` defaults `opts`:
  ```ts
  export function claude(
    opts: ClaudeOptions = {},
    deps: { readonly fs?: FsService } = {},
  ): Readonly<Runner> {
  ```
- `src/runners/codex/codex-runner.ts:492-499` — `codex` does NOT default `opts`:
  ```ts
  export function codex(
    opts: CodexOptions,
    deps: { readonly fs?: FsService; readonly ps?: ProcessService } = {},
  ): Readonly<...> {
  ```
  Its body already destructures with defaults (`:500` `const { model, sandbox = 'full-auto', flags } = opts`),
  so a `{}` default is safe — the missing `= {}` is the only reason `codex()`
  fails.
- Option types:
  - `ClaudeOptions` (`claude-runner.ts:88-95`): `{ model?, maxTurns?, bare?, flags? }`
  - `CodexOptions` (`codex-runner.ts:71-75`): `{ model?, sandbox?, flags? }`
  - Overlap: `model?`, `flags?`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `bun run typecheck` | exit 0 |
| Runner tests | `bun test tests/unit/runners` | all pass |
| Full gate | `bun run check` | exit 0 |

## Scope

**In scope:**
- `src/runners/codex/codex-runner.ts` — default `opts` to `{}`.
- A shared base type for the common `{ model?, flags? }` fields (place it in a
  runner-internal module, e.g. `src/runners/runner-options.ts`, NOT the public
  barrel — or reuse `src/runners/types.ts` if it already hosts shared runner types;
  check first).
- `tests/unit/runners/` — add a `codex()` no-arg test.

**Out of scope (do NOT touch):**
- The divergent fields (`maxTurns`/`bare` vs `sandbox`) — they stay per-runner.
- Runtime behavior of either runner.

## Steps

### Step 1: Default `codex`'s `opts`

Change `codex-runner.ts:492-493` to:

```ts
export function codex(
  opts: CodexOptions = {},
  deps: { readonly fs?: FsService; readonly ps?: ProcessService } = {},
): Readonly<...> {
```

(The body already applies field defaults, so no body change is needed.)

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Extract a shared options base

Create the shared base (check whether `src/runners/types.ts` is the right home — it
already holds the `Runner` port; if a small options base fits there, add it, else
make `src/runners/runner-options.ts`):

```ts
export interface RunnerOptionsBase {
  readonly model?: string
  readonly flags?: readonly string[]
}
```

Have both `ClaudeOptions` and `CodexOptions` extend it:

```ts
export interface ClaudeOptions extends RunnerOptionsBase {
  readonly maxTurns?: number
  readonly bare?: boolean
  // ...any options from plan 021 if that landed first
}

export interface CodexOptions extends RunnerOptionsBase {
  readonly sandbox?: SandboxMode
}
```

Keep `model` and `flags` OFF the derived interfaces (they come from the base). Do
not change field semantics.

**Verify**: `bun run typecheck` → exit 0; `bun test tests/unit/runners` → all pass.

### Step 3: Add a `codex()` no-arg test

In `tests/unit/runners/codex/` (mirror an existing codex runner test), add a test
asserting `codex()` constructs a runner without throwing and with the default
`sandbox` behavior. Full-sentence name, e.g.
`it('constructs a runner when called with no arguments, like claude()', ...)`.

**Verify**: `bun test tests/unit/runners/codex` → all pass; `bun run check` → exit 0.

## Test plan

- New: `codex()` (no args) constructs a runner.
- Regression: existing `codex({...})` and `claude({...})` tests unchanged.
- Pattern to copy: an existing codex runner unit test.
- Verification: `bun test tests/unit/runners` → all pass.

## Done criteria

ALL must hold:

- [ ] `codex()` with no arguments type-checks and constructs a runner (test passes).
- [ ] `ClaudeOptions` and `CodexOptions` both extend `RunnerOptionsBase`.
- [ ] `bun run typecheck` exits 0; `bun test tests/unit/runners` → all pass.
- [ ] `bun run check` exits 0.
- [ ] Only in-scope files modified.
- [ ] `plans/README.md` row 022 updated.

## STOP conditions

Stop and report if:

- Extracting the base causes a public-barrel signature mismatch that the docs gate
  (`bun run check`) flags — update `docs/public/reference/runners.md` to match, then
  re-run. If the base type needs to be exported publicly for the docs to reference,
  export it from `src/runners/index.ts` deliberately and note it.
- Any existing runner test breaks in a way not explained by the type refactor.

## Maintenance notes

- New runners should extend `RunnerOptionsBase` for `model`/`flags` so the shared
  fields stay documented once.
- Reviewer: confirm `codex()`'s body still applies `sandbox = 'full-auto'` — the
  `= {}` default must not change the effective sandbox default.
