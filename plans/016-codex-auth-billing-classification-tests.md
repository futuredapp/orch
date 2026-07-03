# Plan 016: Add regression tests for Codex `auth`/`billing` classification

> **Executor instructions**: Follow step by step; run every verification command.
> Stop and report on any STOP condition. Update the plan 016 row in
> `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 0265592..HEAD -- src/runners/codex/classify-error.ts`
> This classifier was being reworked at planning time. Re-read the `auth`/`billing`
> branches before writing assertions; if the keyword patterns changed, update the
> test inputs to match.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `0265592`, 2026-07-02

## Why this matters

The Codex error classifier has dedicated `auth` and `billing` branches, both marked
`transient: false` (unrecoverable — fail fast). These are exactly the categories
where a misclassification is most costly: classify an auth/billing failure as
transient and the recovery loop burns fork-retries against an error that will never
clear; classify the reverse and a recoverable error aborts. Neither has a test.
Claude's classifier has a dedicated 9-case test file; Codex's covers only
overload/rate_limit/usage_limit/unknown/launch. This closes the gap.

## Current state

- `src/runners/codex/classify-error.ts:65-86` — the keyword matcher:
  ```ts
  function categoryFromKeywords(text: string): ClassifiedError | undefined {
    if (/usage limit|out of credits|usage_limit_reached/.test(text)) {
      return { category: 'usage_limit', transient: false }
    }
    if (/server_is_overloaded|overloaded|at capacity|high demand|slow_down/.test(text)) {
      return { category: 'overload', transient: true }
    }
    if (/too many requests|rate.?limit/.test(text)) {
      return { category: 'rate_limit', transient: false }
    }
    if (/unauthorized|invalid api key|not logged in|authentication/.test(text)) {
      return { category: 'auth', transient: false }
    }
    // Word-boundaried so a path containing "billing" doesn't flip a retryable failure.
    if (/\b(?:quota|billing)\b/.test(text)) {
      return { category: 'billing', transient: false }
    }
    return undefined
  }
  ```
- The classifier is reached via `codex({}).classifyError(signal, 'autonomous')`.
- The existing test file `tests/unit/runners/codex/recovery.test.ts:31-113` has
  helper builders you MUST reuse:
  ```ts
  function turnFailed(message: string, extra = {}): TerminalEvent { /* ... */ }
  function signal(finalEvent: TerminalEvent, exitCode = 1): ClassifyErrorSignal {
    return { finalEvent, exitCode, infoEvents: [], stderr: '' }
  }
  ```
  and a `describe('codex().classifyError', ...)` block. The existing overload case:
  ```ts
  it('classifies exit-1 + turn.failed carrying server_is_overloaded as overload', () => {
    const runner = codex({})
    const classified = runner.classifyError?.(
      signal(turnFailed('stream error', { code: 'server_is_overloaded' })),
      'autonomous',
    )
    expect(classified?.category).toBe('overload')
    expect(classified?.transient).toBe(true)
  })
  ```
- The Claude sibling `tests/unit/runners/claude/classify-error.test.ts` is the
  structural reference for a thorough per-category file.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Confirm the gap | `grep -n "auth\|billing" tests/unit/runners/codex/recovery.test.ts` | no auth/billing cases |
| Typecheck | `bun run typecheck` | exit 0 |
| Codex tests | `bun test tests/unit/runners/codex/recovery.test.ts` | all pass |
| Full gate | `bun run check` | exit 0 |

## Scope

**In scope:**
- `tests/unit/runners/codex/recovery.test.ts` — add cases inside the existing
  `describe('codex().classifyError', ...)` block. (Or a new sibling file
  `tests/unit/runners/codex/classify-error.test.ts` mirroring the Claude one, if you
  prefer symmetry — either is acceptable; pick one and be consistent.)

**Out of scope (do NOT touch):**
- `src/runners/codex/classify-error.ts` — test-only plan. If a test reveals a
  classification bug, STOP and report; do not change the classifier here.

## Steps

### Step 1: Confirm the gap

**Verify**: `grep -n "auth\|billing" tests/unit/runners/codex/recovery.test.ts` →
no auth/billing classification cases. If they already exist, STOP (finding stale).

### Step 2: Add auth cases

Using the existing `signal`/`turnFailed` helpers, add tests asserting an
auth-signaling terminal message classifies as `{ category: 'auth', transient: false }`.
Cover at least two of the matcher's phrasings, e.g.:
- `turnFailed('unauthorized: invalid api key')`
- `turnFailed('not logged in — run codex login')`

Assert `classified?.category === 'auth'` and `classified?.transient === false`.

### Step 3: Add billing cases

Add tests asserting a billing/quota signal classifies as
`{ category: 'billing', transient: false }`:
- `turnFailed('you have exceeded your quota')`
- `turnFailed('billing issue: payment required')`

Also add ONE **negative** case proving the word-boundary guard works: a message
containing "billing" as a substring in a path must NOT classify as billing — e.g.
`turnFailed('cannot read /home/user/billingReport.json')` should fall through to
`launch` or `unknown` (assert `category !== 'billing'`). This locks in the
`\b(?:quota|billing)\b` intent noted in the source comment.

Give every test a full-sentence name (e.g.
`it('classifies an "unauthorized" turn.failed as auth (fail fast)', ...)`).

**Verify**: `bun test tests/unit/runners/codex/recovery.test.ts` → all pass.

### Step 4: Gate

**Verify**: `bun run check` → exit 0.

## Test plan

- ~5 new cases: 2 auth, 2 billing, 1 negative word-boundary case.
- Pattern to copy: the existing `codex().classifyError` cases in the same file, and
  the Claude classifier test file for structure.
- Verification: `bun test tests/unit/runners/codex/recovery.test.ts` → all pass.

## Done criteria

ALL must hold:

- [ ] New auth and billing classification cases exist and pass.
- [ ] The negative word-boundary case (path containing "billing" ⇒ not billing)
      exists and passes.
- [ ] `bun run typecheck` exits 0.
- [ ] `bun run check` exits 0.
- [ ] No `src/` files modified (`git status` shows only the test file).
- [ ] `plans/README.md` row 016 updated.

## STOP conditions

Stop and report if:

- The `auth`/`billing` regexes in the source differ from the excerpt (rework drift)
  — update the test inputs to match the live patterns, and note the change.
- An assertion fails because the classifier returns a different category than
  expected — that is a real classifier bug or a drifted pattern; report it, do NOT
  edit the classifier.

## Maintenance notes

- When a new fail-fast category is added to the Codex classifier, add its cases
  here, including a negative substring case if it uses word-boundary matching.
- Reviewer: confirm the tests assert BOTH `category` and `transient` — the
  `transient` flag is what actually drives the recovery decision.
