# Post-migration cleanup plan

- **Date:** 2026-06-06
- **Branch:** `feat/cmux-integration`
- **Scope:** Remediation of issues found in three post-migration reviews of the test-suite restructure
  executed against `docs/plans/2026-06-05-001-refactor-testing-strategy-restructure-plan.md`.
- **Method:** Parallel subagent analysis — three reviewers' findings were deduplicated, validated
  against the actual codebase, and filtered against the brainstorm spec. Only confirmed, non-contradictory
  issues appear here.
- **Source reviews:** `docs/tests-migration-review-1.md`, `docs/tests-migration-review-2.md`,
  `docs/tests-migration-review-3.md`

---

## Filtered out

Before the plan, items that were explicitly **excluded** and why:

| Review finding | Reason excluded |
|---|---|
| Codex P2: "final deletion deviated from keep-old-tests policy" | Directly contradicts spec §10.1 and §10.4, which chose the delete-in-same-PR strangler pattern. The delete is the designed finish. |
| F18: `assertNoCaretEcho` on model driver is vacuous | The spec (§5.7) requires pty-doubling regressions on real-tmux drivers, but the model-layer version catches a different bug (Ink rendering escape leakage). Not a removal candidate; at most a comment clarification, tracked under Phase 3. |
| F20: `scenario.ts` `as unknown` trust seam | Low-priority type improvement. The runtime is correct; the cast is a known constraint of the `SharedApp<D>` intersection approach. Not actionable without significant generic refactoring. |
| ISSUE-8 / F14: `IS_SANDBOX` side effect in `execute-plan/index.ts` | `workflows/` is a script entrypoint tree, not a library module. Whether CLAUDE.md rule 8 applies here is a separate tooling-policy decision unrelated to the test suite. |
| Coverage gaps (M1/F17) | These are deliberate ledger drops with documented reasons; they are follow-up feature work, not migration bugs. Tracked separately at the end of this document. |

---

## Phase 1 — Correctness bugs (must fix before shipping)

These four issues are confirmed correctness bugs. The suite as-is gives false confidence: vacuous assertions, a broken release gate, and unbounded concurrency that is the documented root cause of flakiness.

### 1.1 — Missing `await` on `expect(...).rejects` assertions

- **What:** Several test files call `expect(promise).rejects.toThrow(...)` without `await`. In Bun, this means the assertion runs asynchronously after the test completes — a silent pass even when the code under test stops throwing.
- **Why it matters:** The Codex flag-denylist tests (`--yolo`, `--dangerously-bypass-approvals-and-sandbox`, `--config`, `--sandbox`, `-c`) are security-critical rejections that are all currently vacuous.
- **Files confirmed by validation:**
  - `tests/unit/runners/codex/build-command.test.ts` — **11 bare calls** at lines 173, 180, 191, 200, 209, 216, 225, 247, 256, 267, 432, 439 (the entire flag-denylist + version-gate block)
  - `tests/unit/state/state-store.test.ts` — 2 cases at lines 159, 253
  - `tests/unit/services/fs/fake-fs-service.test.ts` — 1 case at line 62

- [ ] Add `await` to all bare `expect(promise).rejects.toThrow()` calls in `build-command.test.ts`
- [ ] Add `await` to the 2 bare calls in `state-store.test.ts` (lines 159, 253)
- [ ] Add `await` to the bare call in `fake-fs-service.test.ts` (line 62)
- [ ] Optionally add a Biome/ESLint rule banning un-awaited `expect().rejects/.resolves` to prevent recurrence

### 1.2 — `check:release` silently skips all real-CLI suites

- **What:** `check:release` in `package.json` does not export `RUN_REAL_TMUX_E2E=1`. The real-agent driver skip predicate (`full-host-real-agent-driver.ts:63`) gates on `canRunRealTmuxE2E`, which requires that env var. On any machine — including CI — `check:release` reports green while `test:two-pane:full:real` silently skips all real-agent tests.
- **Files:** `package.json:15`, `tests/dsl/drivers/full-host-real-agent-driver.ts:63`
- **Brainstorm spec §8.4:** "The release job must `which claude codex || exit 1` *before* `check:release`, so `real-agent` cannot silently skip on the one run where it matters."

- [ ] Add a release preflight step to `check:release` that asserts `RUN_REAL_TMUX_E2E=1` is set (or sets it) and that the `claude`/`tmux` binaries are present (`which claude || exit 1`, etc.)
- [ ] Verify that `test:two-pane:full:real` itself sets or requires `RUN_REAL_TMUX_E2E=1` so it cannot be called silently-skipping from any context
- [ ] Fix the real-agent skip predicate (F7): narrow it from `!(canRunRealTmuxE2E('claude') || canRunRealTmuxE2E('codex'))` to only require `claude`, since all current real-agent scenarios use `claudeAgent`. A Codex-only machine must skip, not run a Claude scenario against an absent binary.

### 1.3 — `test:int` runs real-tmux tests without a concurrency cap

- **What:** `"test:int": "bun test tests/integration"` has no `--max-concurrency`. At least 10+ real-tmux test files under `tests/integration/real-tmux/` and `tests/integration/services/tmux/` boot real tmux. Running them unbounded is the documented root cause of flakiness (leaked scripted-fake puppet daemons piling up).
- **Files:** `package.json:32`
- **Context:** `test:two-pane:tmux` and `test:two-pane:lifecycle` already use `--max-concurrency=2` and `--max-concurrency=1`; `test:int` bypasses this entirely.

- [ ] Split `test:int` into two scripts: `test:int` (pure in-process tests, no cap needed) and `test:int:real-tmux` with `--max-concurrency=2`
- [ ] Update `test:project` to call `test:int:real-tmux` (or keep the split so the caller opts in)
- [ ] Confirm `bun run check` still passes after the split

---

## Phase 2 — Broken tooling and stale documentation

The migration tooling was designed to be permanently useful but was left in a broken state by the generic finalize step. Documentation pointing at a deleted path will cause every new contributor to fail immediately.

### 2.1 — Migration oracles broken/false-green and off the gate

- **What:** All three oracle files still hardcode `tests-new/` paths that no longer exist.
  - `reconcile.ts:34-35` — reads `tests-new/_migration/baseline.json` → **crashes (ENOENT)**
  - `overlap-report.ts:27-28` — scans `tests-new` root → **crashes (ENOENT)**
  - `import-parity.ts:29,39` — reads `tests-new/_migration/relocation-map.json`, alias points at `tests-new/_support/` → **false green** (returns 0 pairs, prints `✓`)
  - None of the three are referenced in any `package.json` script.
- **Additionally:** `relocation-map.json` has 268 entries with `"new": "tests-new/..."` paths. After the rename, none exist. Fixing `import-parity.ts` path alone is insufficient — the map data must be regenerated.
- **Why keep them:** `reconcile` proves baseline completeness; `import-parity` proves no test imports a dead module. These are permanent guards, not single-use scripts.

- [ ] Repoint `reconcile.ts` path constants: `tests-new/_migration/baseline.json` → `tests/_migration/baseline.json`
- [ ] Repoint `overlap-report.ts` root: `tests-new` → `tests`, and baseline path accordingly
- [ ] Repoint `import-parity.ts` map path: `tests-new/_migration/relocation-map.json` → `tests/_migration/relocation-map.json`; update the `@orch/test/` alias from `tests-new/_support/` → `tests/_support/`
- [ ] Regenerate `tests/_migration/relocation-map.json` so all 268 `"new"` entries point at `tests/` (not `tests-new/`)
- [ ] Make zero relocation pairs a **failure** in `import-parity.ts` (currently `loadRelocationMap()` returns `[]` on missing map and the tool exits 0 — this is the false-green path)
- [ ] Add `reconcile` and `import-parity` scripts to `package.json` and hook them into `bun run check` (or a dedicated `check:migration` script that `check` calls)
- [ ] Re-run `reconcile` against the frozen baseline after the repoint; confirm clean exit

### 2.2 — Oracle unit tests off-gate; `snapshot.ts` has a stale classification rule

- **What:** `tests/_migration/__tests__/` (38 tests) is not under `tests/unit/` so it is unreachable from `bun run check`. `snapshot.test.ts` line 32 expects a file at `tests/helpers/make-step-entry.ts` to classify as `'helper'`; that directory was renamed to `tests/_support/` and the `tests/helpers/` rule in `snapshot.ts:55-56` matches no real path.

- [ ] Fix `snapshot.ts:55-56`: change `tests/helpers/` classification rule to `tests/_support/`
- [ ] Add `tests/_migration/__tests__` to the test gate (either merge into `test:unit` script or create `test:migration` and add it to `check`)
- [ ] Confirm `snapshot.test.ts` passes after the fix

### 2.3 — Active documentation still references deleted `tests-new/` path

- **What:** New contributors following CLAUDE.md will write two-pane tests under `tests-new/` (which does not exist) and import from `tests-new/dsl/index.ts` (which does not exist).
- **Confirmed stale references:**
  - `CLAUDE.md` lines 42, 47, 56 — writing location, DSL import path, support README link
  - `docs/testing-strategy.md` — lines 47, 50, 72, 77, 95, 110, 119, 154, 155, 162, 169, 183, 204
  - `.claude/skills/runner-author/SKILL.md` — integration/unit path references
  - `tests/dsl/scenario.ts:14-15` — comment claiming `tests-new/` is in tsconfig include
  - `tests/dsl/README.md:18` — import path example
  - Stale invocation comments in `tests/_migration/reconcile.ts:27` and `snapshot.ts:14` (`bun run tests-new/_migration/...`)

- [ ] Update `CLAUDE.md` lines 42, 47, 56: replace `tests-new/` with `tests/`; remove "during migration" routing paragraph
- [ ] Update `docs/testing-strategy.md`: global replace `tests-new/` → `tests/`; remove the section at line 183 describing repointing as future work
- [ ] Update `.claude/skills/runner-author/SKILL.md`: replace stale integration/unit paths
- [ ] Update `tests/dsl/scenario.ts` comment at line 14-15
- [ ] Update `tests/dsl/README.md:18` import path example
- [ ] Fix `reconcile.ts:27` and `snapshot.ts:14` invocation comments

### 2.4 — Dead `_pending-relocation.test.ts` sentinel

- **What:** `tests/e2e/_pending-relocation.test.ts` is a `expect(true).toBe(true)` sentinel whose own header says "DELETE this file the moment the first real e2e test relocates here." Real e2e tests now live in `tests/e2e/`.

- [ ] Delete `tests/e2e/_pending-relocation.test.ts`

### 2.5 — Completeness proof is not reproducible from HEAD (documentation)

- **What:** The finalize step verified completeness before deleting the old tree, so no coverage was lost. However, re-running `reconcile` today (even after fixing 2.1) will not reproduce the full dual-tree proof — the old skipped tests are gone and only `baseline.json` records what they were. The only commit where the proof fully reproduces is `0742468`.
- **This is a documentation issue, not a bug.** The migration succeeded; the record needs to be explicit.

- [ ] Add a short note to `tests/_migration/README.md` (or `baseline.md`) recording: the `.skip` archive was intentionally removed at `c99a364`; `0742468` is the last commit where the full dual-tree completeness proof reproduces; `baseline.json` is the frozen record of the pre-migration test count

---

## Phase 3 — Reliability improvements (should fix, lower urgency)

These issues are real but non-blocking. They can be addressed incrementally.

### 3.1 — Driver `build()` leaks a booted tmux server on throw

- **What:** In `full-host-fake-agent-driver.ts` and `full-host-real-agent-driver.ts`, `build()` calls `createRealTmuxFixture()` then `mountTmuxHost(fixture, ...)` with no `try/catch`. If `mountTmuxHost` throws mid-build, the already-booted fixture is never disposed. The `scenario.ts` wrapper only wraps the test *body* in `finally`; it does not call `app.teardown()` if `build()` itself throws.
- **Files:** `tests/dsl/drivers/full-host-fake-agent-driver.ts`, `tests/dsl/drivers/full-host-real-agent-driver.ts`, potentially screen and recorded-agent drivers

- [ ] Wrap `build()` bodies in `try { ... } catch (err) { await fixture.dispose(); throw err }` in all real-tmux drivers
- [ ] Check `screen-driver.ts` and `full-host-recorded-agent-driver.ts` for the same pattern

### 3.2 — `assertNoCaretEcho` on model driver scope is undocumented

- **What:** `model-driver.ts:212-218` implements `assertNoCaretEcho` by checking `lastFrame()` for `^[`, `^M`, `^J`. The spec §5.1 requires pty-doubling regressions to run on a real tmux driver — the model frame can never have pty echo artifacts. The model version catches a different bug class (Ink rendering accidentally encoding escape sequences as literal text), but this distinction is invisible to readers.

- [ ] Add a comment to `assertNoCaretEcho` in `model-driver.ts` clarifying: this catches Ink rendering escape leakage, NOT pty/tmux escape doubling (which requires a screen or full-host driver per spec §5.7)

### 3.3 — `LifecycleApp` pane types over-promise (type gap, not runtime safety issue)

- **What:** `LifecycleApp.leftPane` and `rightPane` are typed as the full `LeftPane`/`RightPane` classes (~25 methods), but the lifecycle driver routes most pane methods to `notImplemented()`. A lifecycle scenario calling `app.leftPane.assertContains()` type-checks but fails at runtime.
- **Spec position:** §6.1 says "unsupported actions are caught by types first; runtime errors are acceptable as defense-in-depth." The current implementation has the defense-in-depth (runtime error) but not the compile-time enforcement.

- [ ] Either: narrow `LifecycleApp`'s `leftPane`/`rightPane` to a restricted interface exposing only `assertFocused` and the methods the lifecycle driver actually supports
- [ ] Or: add a `.test-d.ts` negative type test that `expectTypeOf(lifecycleApp.leftPane).not.toHaveProperty('assertContains')` (to at least document the expectation)

---

## Phase 4 — Stale one-shot migration scripts (cleanup)

Scripts under `scripts/` that target old tree paths are dangerous to run by mistake now that `tests-new/` is gone.

- **Confirmed stale scripts:** `scripts/skip-migrated-u7.sh`, `scripts/skip-migrated-u10.sh`, `scripts/skip-migrated-u11.sh`, `scripts/skip-migrated-u12.sh`, `scripts/skip-migrated-u13.sh`, `scripts/skip-migrated-u14.sh`, `scripts/relocate-core-u10.sh`, `scripts/relocate-u13.sh`, `scripts/move-test-infra-to-support.sh`

- [ ] Delete all one-shot migration scripts from `scripts/` that reference `tests-new/` or the old `tests/` tree paths (they have no valid target and can corrupt a working tree if run by mistake)
- [ ] Optionally: move them to `docs/plans/archive/migration-scripts/` with a `README.md` saying "these were one-shot scripts, do not run on HEAD"

---

## Separate backlog (not part of this plan — follow-up tasks)

These are deliberate ledger drops with documented rationale, not bugs caused by the migration. They should be filed as separate issues or tasks:

1. **Uppercase-F follow-live keymap** — `src/hosts/two-pane/steps-view/steps-view.tsx:267` handles `input === 'F'` but no DSL scenario exercises it. The DSL currently lacks a raw-keystroke primitive. Add a keystroke primitive and a `model` scenario covering `F`.

2. **`steps=[]` empty state** — the initial empty frame and "no hairlines around empty state" rendering are untested at any fidelity. `launch({steps:[...]})` cannot express zero steps today. Add support and a `model`/`screen` scenario.

3. **Note on F13 (misleadingly-named uppercase-F pane-handle test):** `tests/integration/real-tmux/pane-handle.test.ts:197-209` is named "so the keymap reads it as uppercase-F" but runs with `disableStepsView: true` and only asserts `sendKeysToPaneId` resolves. When the keystroke primitive (item 1 above) is added, this test should either be deleted (replaced by the new scenario) or its name corrected to reflect what it actually verifies (service API contract, not keymap).

4. **Four C6 real-host behavioral cases** — `auto-stop` stop-channel ordering/race, `per-step-artifacts` end-to-end, `resume` orchestration end-to-end, `command` output streaming — all dropped because no faithful fake substrate exists. These need a host-integration fixture and should be scoped as their own task.

5. **biome.json schema version** — `biome.json` pins schema `2.4.10` while a newer patch exists. Run `biome migrate` when convenient; this is cosmetic.

---

## Suggested execution order

| Phase | Issues | Effort | Gate impact |
|---|---|---|---|
| 1 | 1.1 (missing await) | ~30 min | Immediately fixes vacuous security tests |
| 1 | 1.2 (check:release) | ~30 min | Makes the release gate meaningful |
| 1 | 1.3 (test:int cap) | ~15 min | Prevents flakiness in the default gate |
| 2 | 2.1 (oracle paths) | ~1 hr | Restores ongoing completeness guard |
| 2 | 2.3 (stale docs) | ~30 min | Unblocks new contributors |
| 2 | 2.2 (oracle unit tests) | ~20 min | Adds 38 previously invisible tests to gate |
| 2 | 2.4 (dead sentinel) | ~5 min | Cleanup |
| 2 | 2.5 (completeness doc) | ~10 min | Historical record |
| 3 | 3.1 (driver build leak) | ~1 hr | Prevents rare tmux server leak on setup failure |
| 3 | 3.2 (assertNoCaretEcho comment) | ~5 min | Documentation clarity |
| 3 | 3.3 (lifecycle type gap) | ~1 hr | Type safety improvement |
| 4 | 4 (stale scripts) | ~15 min | Safety cleanup |
