---
status: done
priority: high
issue_id: "019"
tags: [code-review, correctness, workflow]
dependencies: []
---

# workflow.ts ignores non-zero exit code when finalEvent is not an error

## Problem Statement

`src/core/workflow.ts:120` — the step-failure check only fires when
`result.finalEvent.type === 'error'`. A runner that emits a `turn-complete`
terminal event and then exits with a non-zero exit code is silently recorded
as `completed` and its (possibly partial/garbage) structured output is
persisted. Any downstream step that reads the cached value trusts a value
produced by a process that actually crashed.

**Why it matters:** This is the highest-severity correctness bug in the
current tree. Every runner whose CLI can emit a "turn-complete" envelope
before abnormal exit (SIGKILL, post-output crash, stream-json buffer flush
followed by panic) will bypass the failure path. Review 2 (R2-N1) flagged
this as a new finding not covered by Review 1.

## Findings

- Flagged by: Review 2, R2-N1
- `src/core/workflow.ts:120` — `if (result.finalEvent.type === 'error')` is
  the only error branch; `result.exitCode` is never inspected
- Dead-code twin #014: the `msg` ternary inside the same block has an
  unreachable false branch

## Proposed Solutions

### Option A: Treat non-zero exit code as failure (Recommended)

```ts
const isError = result.finalEvent.type === 'error' || result.exitCode !== 0
if (isError) {
  const msg = result.finalEvent.type === 'error'
    ? result.finalEvent.message
    : `runner exited ${result.exitCode}`
  throw new StepError(key, result.exitCode, msg)
}
```

- **Pros:** Fixes #019 and #014 in one edit; no new state
- **Cons:** Runners that intentionally exit non-zero for "soft" failures
  must emit an explicit error event — but none do today
- **Effort:** Trivial
- **Risk:** Low

## Acceptance Criteria

- [ ] A runner that emits `turn-complete` then exits with code 1 causes
      `workflow.execute` to throw `StepError`
- [ ] The dead `msg` ternary branch is collapsed
- [ ] Existing success path (exit 0 + turn-complete) is unchanged
- [ ] A unit test covers the "turn-complete then non-zero exit" case

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-04-11 | Created from code review (R2-N1) | Highest-severity correctness bug on branch |
| 2026-04-11 | G3: added `isError = ... || exitCode !== 0` check in workflow.ts; covered by new unit test | Fixes #019 and #014 in one edit |
