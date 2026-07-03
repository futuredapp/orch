# Plan 018: Accept a runId prefix in `orch logs`

> **Executor instructions**: Follow step by step; run every verification command.
> Stop and report on any STOP condition. Update the plan 018 row in
> `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 0265592..HEAD -- src/cli/commands/logs.ts src/cli/commands/status.ts`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `0265592`, 2026-07-02

## Why this matters

`orch status` and `orch resume` accept a **runId prefix** (`findByPrefix`), but
`orch logs` demands the **full** runId. In the normal debug loop you run
`orch runs` → copy a prefix → `orch status <prefix>` (works) → `orch logs <prefix>`
(rejected with `invalid runId`), forcing you to hunt down the full
`r-YYYY-MM-DD-HHMMSS-xx` hash. This is pure, avoidable friction and an inconsistency
trap. Making `logs` resolve prefixes like `status` does removes it.

## Current state

- `src/cli/commands/logs.ts:119-130` — `logs` resolves the id via exact-match
  `parseRunId`:
  ```ts
  if (!idArg) {
    process.stderr.write('Usage: orch logs <runId> | orch logs --latest\n')
    return EXIT.CONFIG_ERROR
  }
  try {
    return parseRunId(idArg)
  } catch {
    process.stderr.write(`orch: invalid runId "${idArg}"\n`)
    return EXIT.CONFIG_ERROR
  }
  ```
- `src/cli/commands/status.ts:31-44` — `status` resolves via prefix and handles
  not-found / ambiguous:
  ```ts
  const matches = await deps.registry.findByPrefix(idArg)
  if (matches.length === 0) {
    process.stderr.write(`No run found matching "${idArg}"\n`)
    return EXIT.CONFIG_ERROR
  }
  if (matches.length > 1) {
    process.stderr.write(
      `Ambiguous run ID prefix "${idArg}" matches ${matches.length} runs: ${matches.join(', ')}\n`,
    )
    return EXIT.CONFIG_ERROR
  }
  const rid = matches[0] as RunId
  ```
- `logs.ts` already uses `deps` and (per plan context) has access to the same
  registry `status` uses (`deps.registry`). Confirm `deps.registry.findByPrefix`
  is reachable in `logs.ts` (it is the same `CliDeps`).

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `bun run typecheck` | exit 0 |
| Logs tests | `bun test tests/unit/cli/logs-command.test.ts` | all pass |
| Full gate | `bun run check` | exit 0 |

## Scope

**In scope:**
- `src/cli/commands/logs.ts` — make the non-`--latest` id resolution prefix-match.
- `tests/unit/cli/logs-command.test.ts` — add prefix / ambiguous / not-found cases.

**Out of scope (do NOT touch):**
- `status.ts` / `resume.ts` — already prefix-aware.
- The `--latest` resolution branch in `logs.ts` (the `if (opts.latest)` path above
  line 119) — leave it as is.
- The path-traversal guard: because the resolved id comes from the registry's known
  ids (not raw user fs input), prefix resolution is safe — do not weaken any
  validation.

## Steps

### Step 1: Resolve by prefix, keep exact-parse as validation

In `logs.ts`, replace the exact `parseRunId(idArg)` block (`:124-129`) with a
prefix resolution that mirrors `status.ts:32-44`: call
`await deps.registry.findByPrefix(idArg)`, handle `length === 0`
(`No run found matching "<id>"`, exit `CONFIG_ERROR`) and `length > 1` (ambiguous
message listing matches, exit `CONFIG_ERROR`), then take `matches[0]`. Keep the
empty-`idArg` usage message.

Because the rest of `logs.ts` types the id as `ReturnType<typeof parseRunId>`, pass
the resolved id through `parseRunId` (or the same smart-constructor `status` uses)
so the return type stays a validated `RunId` — the resolved prefix match IS a known
valid id, so this parse will not throw.

Note: `resolveRunId` in `logs.ts` may be a sync function today. If it must become
`async` to call `findByPrefix`, update its call site to `await` it. Check whether
`resolveRunId`'s caller already runs in an async context (it does — the command is
async).

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Tests

In `tests/unit/cli/logs-command.test.ts`, add cases mirroring the `status` tests'
prefix handling (look at `tests/integration/cli/commands/status.test.ts` for the
prefix/ambiguous/not-found patterns and the registry fake):
- A unique prefix resolves and streams the run's transcript.
- An ambiguous prefix (2+ matches) exits `CONFIG_ERROR` with the ambiguous message.
- A no-match prefix exits `CONFIG_ERROR` with the not-found message.

Full-sentence names, e.g. `it('resolves a unique runId prefix like status does', ...)`.

**Verify**: `bun test tests/unit/cli/logs-command.test.ts` → all pass; then
`bun run check` → exit 0.

## Test plan

- 3 new cases: unique prefix, ambiguous prefix, no match.
- Pattern to copy: `tests/integration/cli/commands/status.test.ts` prefix handling +
  the existing `logs-command.test.ts` harness.
- Verification: `bun test tests/unit/cli/logs-command.test.ts` → all pass.

## Done criteria

ALL must hold:

- [ ] `orch logs <unique-prefix>` resolves to the full run (new test passes).
- [ ] Ambiguous and not-found prefixes exit `CONFIG_ERROR` with the same message
      shape as `status`.
- [ ] `--latest` behavior unchanged.
- [ ] `bun run check` exits 0.
- [ ] Only in-scope files modified.
- [ ] `plans/README.md` row 018 updated.

## STOP conditions

Stop and report if:

- `deps.registry.findByPrefix` is not reachable from `logs.ts`'s deps (unexpected —
  `status.ts` uses the same `CliDeps`). Report the actual deps shape.
- Making `resolveRunId` async cascades into non-async callers you'd have to
  restructure — report before a large refactor.

## Maintenance notes

- Consider a shared `resolveRunTarget(deps, idArg, { latest })` helper used by
  `logs`/`status`/`resume`/`retry` as a follow-up (this is the CLI-05 finding about
  `--latest` inconsistency) — out of scope here, but this plan is a step toward it.
- Reviewer: confirm the ambiguous/not-found messages match `status`'s wording so the
  CLI stays consistent.
