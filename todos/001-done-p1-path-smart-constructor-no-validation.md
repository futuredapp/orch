---
status: done
priority: p1
issue_id: "001"
tags: [code-review, security, architecture]
dependencies: []
---

# path() smart constructor performs zero validation

## Problem Statement

`src/services/types.ts:6` — the `path()` function is an unconditional cast: `(s: string): Path => s as Path`. Any string — including `../../etc/passwd`, null bytes, empty strings, or symlinks — becomes a valid `Path`. Every downstream consumer (`BunFsService.readFile`, `writeFile`, `remove`, `mkdir`) trusts this branded type blindly. The comment says "Phase 3 introduces validating smart constructors" but Phase 3 shipped without them.

**Why it matters:** If any external input flows through `path()` (e.g., a future CLI arg, API parameter, or untrusted step output), an attacker can read/write/delete arbitrary files. Combined with `BunFsService.remove({ recursive: true, force: true })`, this is a remote code execution path.

## Findings

- Flagged by: Security Sentinel (P1-1), TypeScript Reviewer (P2-9), Architecture Strategist
- `src/services/types.ts:6` — zero validation, unconditional cast
- `src/services/fs/bun-fs-service.ts:50` — `remove()` uses `recursive: true, force: true` with no safeguard
- Stale TODO on line 1 says "Phase 3 introduces validating smart constructors" — Phase 3 already landed

## Proposed Solutions

### Option A: Validate in path() (Recommended)
- Reject empty strings, null bytes, `..` components
- Resolve to absolute path or reject relative paths
- Keep cast private so no module can bypass
- **Pros:** Centralized, catches all callers
- **Cons:** May need `pathRelative()` variant for test fixtures
- **Effort:** Small
- **Risk:** Low — failing tests reveal unchecked raw strings

### Option B: Validate at BunFsService boundary
- Add path validation in every BunFsService method
- **Pros:** Defense in depth
- **Cons:** Duplicated logic, easy to miss a method
- **Effort:** Medium
- **Risk:** Low

## Recommended Action

<!-- Filled during triage -->

## Technical Details

**Affected files:**
- `src/services/types.ts` (the cast)
- `src/services/fs/bun-fs-service.ts` (all methods trust Path blindly)
- `src/state/state-store.ts` (constructs paths via string concatenation)

## Acceptance Criteria

- [x] `path('')` throws
- [x] `path('../../etc/passwd')` throws
- [x] `path('foo\0bar')` throws
- [x] Existing tests still pass (legitimate paths remain valid)
- [x] Remove stale TODO(phase-3) comment

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-04-11 | Created from code review | Flagged by 3 agents independently |
| 2026-04-11 | G1: hardened `path()` in `src/services/types.ts` — rejects empty string, NUL byte, and any `..` component; deleted the stale `TODO(phase-3)` comment; kept the cast private. New unit tests in `tests/unit/services/types.test.ts` cover all four acceptance bullets. | Every existing callsite passes absolute paths derived from `process.cwd()` / `os.tmpdir()` / run-id concat — no legitimate caller was broken. |

## Resources

- CLAUDE.md rule 9: "Paths are branded types"
- `src/services/types.ts:1` — stale TODO
