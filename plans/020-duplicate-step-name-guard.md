# Plan 020: Throw on a duplicate step name in the same scope

> **Executor instructions**: Follow step by step; run every verification command.
> This is a behavior-changing correctness guard — honor the STOP conditions
> strictly. Update the plan 020 row in `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 0265592..HEAD -- src/core/workflow.ts src/core/errors.ts`
> If either changed, compare the "Current state" excerpts against the live code;
> on a mismatch, STOP and report.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: dx (footgun / silent-wrong-result)
- **Planned at**: commit `0265592`, 2026-07-02

## Why this matters

Two steps defined with the **same name in the same scope** pass the collision guard
and the second `run()` silently returns the **first step's memoized value** — no
error, no type failure. Because name-keyed memoization is orch's core mechanism,
this is a silent-wrong-result footgun: copy-paste a `step.define('review', …)`, or
forget `as:` on a second step, and the second step never runs. The
`StepNameCollisionError` machinery already exists but only fires for the
cross-subworkflow case. This plan makes a same-scope duplicate (from a **different**
step definition) throw an actionable error instead of silently aliasing.

## Current state

`src/core/workflow.ts`:

- The owner record (`:1877-1880`):
  ```ts
  interface StepKeyOwner {
    readonly subPath: readonly string[]
    readonly subCallId?: string
  }
  ```
- The guard (`:1886-1897`) — returns silently when scope + subCallId match, which is
  the aliasing hole:
  ```ts
  function assertNoExecutionCollision(
    step: AnyStep,
    prior: StepKeyOwner,
    attempted: StepKeyOwner,
  ): void {
    if (
      !sameSubPath(prior.subPath, attempted.subPath) ||
      (attempted.subCallId !== undefined && prior.subCallId !== attempted.subCallId)
    ) {
      throw new StepNameCollisionError(step.name, prior.subPath, attempted.subPath)
    }
  }
  ```
- The registration + cache short-circuit (`:1926-1963`):
  ```ts
  const attemptedOwner: StepKeyOwner = {
    subPath,
    ...(subCallId !== undefined ? { subCallId } : {}),
  }
  // ...
  const executionOwner = keyOwnersThisExecution.get(key)
  if (executionOwner !== undefined) {
    assertNoExecutionCollision(s, executionOwner, attemptedOwner)
  } else {
    keyOwnersThisExecution.set(key, attemptedOwner)
  }
  const state = await deps.stateStore.loadRun(deps.runId)
  const cached = state?.steps[key]
  // ... cache short-circuit replays the first value ...
  ```
- `s` is the `AnyStep` object for this call. The `as:` override changes the derived
  `key` (`deriveStepKey`), so steps that use `as:` do NOT collide — that is the
  documented escape hatch (see `examples/compound/index.ts` using `as:` in loops).
- Existing collision test: `tests/unit/core/run-step-once-collision.test.ts`.
- `StepNameCollisionError` is at `src/core/errors.ts:109-129`; workflow re-exports
  errors at `src/core/workflow.ts:77`.

### Design decision (conservative — do exactly this)

Throw ONLY when a **different Step object** claims an already-owned key at the same
scope. Rationale:
- Two distinct `step.define(...)` calls sharing a name = the copy-paste footgun →
  **throw**.
- The **same** Step object re-invoked (a loop without `as:`) keeps today's behavior
  (no throw) — changing that is higher-risk and out of scope.
- Resume replay is safe: each execution gets a fresh `keyOwnersThisExecution` Map
  and claims each key once, so the guard never fires on resume.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `bun run typecheck` | exit 0 |
| Collision test | `bun test tests/unit/core/run-step-once-collision.test.ts` | all pass |
| Core suites | `bun test tests/unit/core tests/integration/core` | all pass |
| Full gate | `bun run check` | exit 0 |

## Scope

**In scope:**
- `src/core/workflow.ts` — add a `step` field to `StepKeyOwner`; extend
  `assertNoExecutionCollision` with the different-object same-scope throw.
- `src/core/errors.ts` — add a `DuplicateStepNameError` (and re-export it via
  `workflow.ts:77` and wherever the other core errors are surfaced).
- `tests/unit/core/run-step-once-collision.test.ts` — add duplicate-name cases.

**Out of scope (do NOT touch):**
- `deriveStepKey` / the `as:` mechanism.
- The cross-subworkflow `StepNameCollisionError` behavior (keep it firing as today).
- Same-object loop behavior — do NOT try to also catch that here.

## Steps

### Step 1: Carry the step identity on the owner

Add `readonly step: AnyStep` to `StepKeyOwner` (`:1877`). Set it when building
`attemptedOwner` (`:1926`): add `step: s`. (Leave the `cachedOwner` built at `:1955`
alone — it comes from persisted state and has no live object; the different-object
check only applies to the in-execution `keyOwnersThisExecution` path.)

**Verify**: `bun run typecheck` → exit 0 (fix any other `StepKeyOwner` literal that
now needs `step`).

### Step 2: Add the `DuplicateStepNameError`

In `src/core/errors.ts`, add:

```ts
export class DuplicateStepNameError extends Error {
  constructor(readonly stepName: StepName) {
    super(
      `Duplicate step name "${stepName}" in the same scope. ` +
        `Two different step definitions share this name, so the second would ` +
        `silently return the first step's cached result. ` +
        `Rename one step, or pass a distinct name via run(STEP, { as: '<unique>' }).`,
    )
    this.name = 'DuplicateStepNameError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}
```

Re-export it alongside the other errors at `src/core/workflow.ts:77` and confirm the
core barrel (`src/core/index.ts`) surfaces it the same way it surfaces
`StepNameCollisionError` (match the existing export pattern so it reaches consumers).

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Extend the guard

In `assertNoExecutionCollision`, after the existing cross-scope throw, add the
same-scope different-object case:

```ts
function assertNoExecutionCollision(
  step: AnyStep,
  prior: StepKeyOwner,
  attempted: StepKeyOwner,
): void {
  if (
    !sameSubPath(prior.subPath, attempted.subPath) ||
    (attempted.subCallId !== undefined && prior.subCallId !== attempted.subCallId)
  ) {
    throw new StepNameCollisionError(step.name, prior.subPath, attempted.subPath)
  }
  // Same scope, but a DIFFERENT step definition is claiming an already-owned
  // key — the copy-paste footgun. The same object re-invoked (loop without
  // `as:`) is left as-is (prior.step === attempted.step).
  if (prior.step !== attempted.step) {
    throw new DuplicateStepNameError(step.name)
  }
}
```

Import `DuplicateStepNameError` into `workflow.ts` (from `./errors.ts`).

**Verify**: `bun run typecheck` → exit 0.

### Step 4: Run the core suites and inspect failures carefully

**Verify**: `bun test tests/unit/core tests/integration/core` → all pass.

If a test that uses `parallel(...)`, loops, or subworkflows now throws
`DuplicateStepNameError`, DO NOT loosen the guard blindly. Check whether that test
genuinely defines two different steps with the same name in one scope (then the test
was relying on the bug — fix the test to use `as:` or distinct names) OR whether it
re-uses the SAME step object (then `prior.step !== attempted.step` should be false
and it should NOT throw — if it does, your `step: s` threading is wrong; fix that).
If you cannot tell, STOP and report the failing test.

### Step 5: Add regression tests

In `tests/unit/core/run-step-once-collision.test.ts` (mirror its harness), add:
- **Throws**: two different `step.define('dup', …)` objects run in the same scope →
  `DuplicateStepNameError` naming `dup`.
- **Does not throw**: the same step object run once (normal) completes.
- **Does not throw with `as:`**: two same-named definitions where the second is run
  via `run(STEP, { as: 'dup-2' })` → both run, no error.

Full-sentence names.

**Verify**: `bun test tests/unit/core/run-step-once-collision.test.ts` → all pass;
then `bun run check` → exit 0.

## Test plan

- 3 cases: duplicate different-object throws; single normal run passes; `as:`
  disambiguated pair passes.
- Pattern to copy: `tests/unit/core/run-step-once-collision.test.ts`.
- Verification: that file + `bun test tests/unit/core tests/integration/core` all
  pass.

## Done criteria

ALL must hold:

- [ ] `StepKeyOwner` carries `step`, set from `s` on the attempted owner.
- [ ] `DuplicateStepNameError` exists, is exported from the core barrel, and is
      thrown for a same-scope different-object duplicate.
- [ ] The three regression tests pass.
- [ ] `bun test tests/unit/core tests/integration/core` → all pass (no legitimate
      pattern regressed).
- [ ] `bun run check` exits 0.
- [ ] Only in-scope files modified.
- [ ] `plans/README.md` row 020 updated.

## STOP conditions

Stop and report if:

- Any existing test fails and you cannot classify it as "relied on the bug" vs
  "same-object false positive" — report the test and the diagnosis.
- More than ~3 existing tests start throwing `DuplicateStepNameError` — that
  suggests same-name reuse is a wider intended pattern; STOP and report before
  editing many tests.
- The `as:`-disambiguated case throws (it must not) — your key derivation
  understanding is off; report.

## Maintenance notes

- This intentionally does NOT catch the same-object-in-a-loop footgun (higher risk).
  A follow-up could warn on that too, but only with the loop/`as:` interaction
  fully characterized.
- Reviewer: the critical invariant is that resume and `parallel` reuse of the SAME
  step object never throws — scrutinize those paths in the diff.
