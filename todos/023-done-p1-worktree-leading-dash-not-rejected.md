---
status: done
priority: p1
issue_id: "023"
tags: [code-review, security, worktree, argv-injection]
dependencies: []
---

# `createWorktree()` does not reject leading-`-` branches/refs/targets — git option-injection surface

## Problem Statement

`src/core/worktree.ts:111-145` validates `branch`, `from`, and `target` for
empty/whitespace/null/newline content but does **not** reject inputs that
begin with `-`. The plan called this out explicitly:

> "`branch` is validated by the factory before reaching git (reject empty,
> control chars, **leading `-`**)." — `docs/sessions/orch-git-helpers/plan.md`

The implementation skipped that part. The values flow into:

```
git worktree add -b <branch> <path> <fromRef>
```

Modern git generally treats positional args after `-b` as branch/path/ref
even when they start with `-`, but several real git subcommands have
historically been ambushed by leading-dash arguments (CVE-2018-17456 is the
canonical example). Defense-in-depth says: don't pass user-controlled
strings as positional argv after a flag-bearing subcommand without either
(a) rejecting `-` prefixes at the boundary, or (b) using the `--` end-of-
options separator before positional args.

`BunGitService.addWorktree` at `src/services/git/bun-git-service.ts:204` does
neither — no `--` between `-b <branch>` and `<path>/<fromRef>`.

**Why it matters:** A workflow author who programmatically derives a branch
name from external input (env var, CLI arg, prompt output) opens an
option-injection path that is invisible to anyone reviewing the workflow
file. The risk class is the same one the project already takes seriously
elsewhere (path branded type rejects `..`, env passthrough is gated, stderr
is redacted before persistence).

## Findings

- `src/core/worktree.ts:111-145` — `validateBranch`, `validateFrom`, `validateTarget` do not check leading `-`
- `src/services/git/bun-git-service.ts:204-221` — `addWorktree` argv has no `--` separator between flags and positional args
- Plan explicitly required leading-`-` rejection (open question #X / "Argument safety" section)
- Tests do not cover this case (no `'throws for branch starting with dash'`)
- Existing precedent: `path()` smart constructor rejects `..` for the same reason

## Proposed Solutions

### Option A: Reject `-` prefix in factory + add `--` separator in adapter (Recommended)
- `validateBranch` / `validateFrom` / `validateTarget`: throw if `value.startsWith('-')`
- `BunGitService.addWorktree`: insert `--` between `-b <branch>` and `<path> <fromRef>` (git accepts this)
- **Pros:** Belt-and-suspenders. Factory catches the obvious case; adapter survives any reversed argument order in a future git version.
- **Cons:** Slightly more code; one more validation per input.
- **Effort:** Small
- **Risk:** Low

### Option B: Factory rejection only
- Add the leading-`-` check to all three validators
- **Pros:** Minimal; covers the only real attack surface (user-controlled inputs)
- **Cons:** No defense if a future caller bypasses the factory or composes args differently
- **Effort:** Small
- **Risk:** Low

### Option C: Adapter `--` separator only
- Just patch `addWorktree` with `--`
- **Pros:** Matches git's documented contract for "everything after this is positional"
- **Cons:** The factory still accepts garbage like `-` as a branch, which would then fail at the git layer with a confusing message instead of at the workflow boundary where the user is
- **Effort:** Trivial
- **Risk:** Low but worse UX

## Recommended Action

(Triage)

## Technical Details

- **Files:** `src/core/worktree.ts`, `src/services/git/bun-git-service.ts`
- **Tests to add:**
  - `'throws when branch begins with a dash'`
  - `'throws when from begins with a dash'`
  - `'throws when target begins with a dash'`
  - `'addWorktree includes -- separator before path/fromRef'` (BunGitService unit test)
- **Plan reference:** `docs/sessions/orch-git-helpers/plan.md` — "Argument safety"

## Acceptance Criteria

- [x] `createWorktree('-d', { enter: true })` throws at construction time
- [x] `createWorktree('feat/foo', { enter: true, from: '--upload-pack=evil' })` throws at construction
- [x] `createWorktree('feat/foo', { enter: true, target: '-rf' })` throws at construction
- [x] `BunGitService.addWorktree` argv contains `--` between flag args and positional args (verify in unit test)
- [x] All existing worktree tests still green

## Work Log

- 2026-04-30 — Discovered during code review of uncommitted worktree changes; plan called for this validation but the implementation skipped it.
- 2026-04-30 — Hardened: validateBranch/validateFrom/validateTarget reject leading "-"; validateFrom also rejects NUL and newlines (with most-specific checks first); addWorktree argv now includes "--" separator; covered by 5 new factory tests and a new BunGitService argv-shape test (with adversarial counter-fake to detect regression). Existing addWorktree tests updated to the new argv shape. Pre-existing slug test "strips leading and trailing dashes" updated to use non-dash punctuation (`(feat)/foo!!`) since leading-`-` branches are now rejected. worktree-real.test.ts confirms real git accepts `--`.

## Resources

- `docs/sessions/orch-git-helpers/plan.md` — "Argument safety"
- CVE-2018-17456 — historical git option-injection precedent
- `src/services/types.ts:15` — `path()` precedent for boundary validation
