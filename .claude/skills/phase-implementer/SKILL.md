---
name: phase-implementer
description: How to pick up and implement a phase from the orch implementation plan. Use at the start of any feature work in this repo to enforce the phased development discipline.
---

# Phase Implementer

Every phase is a PR-sized slice. Implement one at a time, always behind passing tests.

## Before you write code

1. **Read the phase** in `docs/plans/implementation-phases.md`. Find the **Definition of Done** section for the phase — every item there blocks the PR.
2. **Check the previous phase is green**: `bun run check` passes on `main` before you start.
3. **Load the `testing-strategy` skill** — every phase adds tests; this skill tells you how they should look.
4. **If the phase adds a runner**, also load the `runner-author` skill.

## Order of operations

1. **Sketch the interface first.**
   Write the `.ts` file with type signatures only and `throw new Error('not implemented')` bodies. Commit this scaffold as a separate commit — it makes review easier.

2. **Write the tests next.**
   Follow the layer prescribed by the phase (unit / integration-mocked / integration-real / e2e). The `testing-strategy` skill tells you what "good" looks like for each layer.

3. **Make the tests pass.**
   Fill in implementations until green. Resist adding anything outside the phase's scope — open a new phase instead.

4. **Run the full gate.**
   ```
   bun run check
   ```
   This runs lint + typecheck + unit + mocked-integration tests. If it fails, stop and fix — don't push.

5. **Optionally run real-CLI tests** if the phase touches a runner:
   ```
   RUN_REAL_CLAUDE=1 bun run test:int
   RUN_REAL_CODEX=1  bun run test:int
   ```

6. **Update `docs/plans/<phase>.md`** with a one-line note: `landed YYYY-MM-DD` and any surprises worth recording.

7. **PR description must list tests added at each layer.** Missing a layer (without justification) is a review blocker. Template:
   ```
   ## Phase N — <title>
   - Unit: <which tests>
   - Integration (mocked): <which tests>
   - Integration (real, env-gated): <which tests>
   - E2E: <which tests, if any>
   ```

## Universal Definition of Done

- [ ] All new code lives under `src/<module>/`; all new tests under `tests/<layer>/<module>/`.
- [ ] No file exceeds 300 lines (warning; justify in a comment if unavoidable).
- [ ] No function exceeds 60 lines.
- [ ] `bun run check` is green.
- [ ] Tests added at every layer the phase prescribes.
- [ ] PR description lists tests per layer.
- [ ] CLAUDE.md non-negotiables honored:
  - No direct `child_process`/`Bun.spawn`/`node-pty` outside `src/services/process/`.
  - No concrete runner imported inside `src/core/`.
  - No `mock.module` on internal modules.
  - No `any`, no `!` non-null assertions.
  - No side effects at module import time.

## Anti-patterns (these fail review)

- **Skipping a test layer** because "it's covered by the next phase". It isn't; each layer proves a different property.
- **Landing a phase with a failing test you swore you'd fix later.** There is no later.
- **"While I'm here" refactors.** Open a new phase.
- **Bypassing the seam.** If you're tempted to mock an internal module, fix the architecture.
- **Touching unrelated files.** If a rename is needed, it's a separate PR.
- **Silencing a lint warning without a comment explaining why.**

## If you get stuck

- Re-read the phase's Definition of Done — the goal is usually narrower than it feels.
- Check `docs/brainstorms/` and `docs/getting-started.md` for design intent.
- If the design itself needs to change, stop coding and update the plan document first; ask the human for a quick review.
