# Test-suite migration — multi-agent code review (ce-code-review)

**Date:** 2026-06-06
**Branch:** `feat/cmux-integration`
**Scope:** all 15 commits `426c546` (phase 1) → `c99a364` (finalize) against merge-base `2d92b49` — **453 files, +45 491 / −11 172**. The full restructure of the test tree into the scenario/driver shape, plus the `finalize` step that deleted the old `tests/` and renamed `tests-new/ → tests/`.
**Method:** 7 parallel reviewer sub-agents (correctness, adversarial, testing, maintainability, project-standards, reliability, TypeScript), each instructed to *independently verify* — not echo — the two prior reviews ([`tests-migration-review.md`](tests-migration-review.md), [`tests-migration-review-codex.md`](tests-migration-review-codex.md)) and prioritise findings those missed. Every headline claim below was reproduced by running the tooling or reading the code/run-logs directly.

---

## TL;DR

The migrated suite is **real and substantively sound** — content-asserting DSL scenarios, a frozen baseline + ledger, genuine assertions across core/runners/cli/two-pane/lifecycle, and a well-engineered, type-safe DSL. `bun run check` is green in the intended (unrestricted, real-tmux) environment. This review **agrees with both prior reviews** on that bottom line.

It is **not a clean closeout.** The closeout was performed by a generic `finalize` step that (a) deleted the very machinery built to *prove* the migration complete, (b) ran **fail-open** (destructive delete with no passing-oracle precondition), and (c) stood in for plan unit **U14 "Reconciliation"**, which was silently deferred to a phantom "Phase 15" that can never run. The result ships, but it carries broken/false-green oracles, a release gate that silently skips *all* real-CLI coverage, unbounded real-tmux concurrency on the default gate, stale author guidance pointing at a deleted path, and — **new in this review** — a cluster of vacuous `expect(...).rejects` assertions on the **security-critical Codex flag denylist**.

**Verdict: ship-able, but needs a focused closeout pass.** Priorities F1–F5 below.

### What this review adds beyond the two prior ones

- **F4 (P1, NEW):** the missing-`await` defect (prior M2, 2 cases) is far wider — **~10 cases in `tests/unit/runners/codex/build-command.test.ts`** guarding the dangerous-flag denylist (`--yolo`, `--dangerously-bypass-approvals-and-sandbox`, `--config`, `--sandbox`, `-c`) are all vacuous. Plus 2 more in `fake-fs-service` / `codex-auto-stop`.
- **F2 (P0, sharper):** the release-gate skip is broader than codex P1 — it's not just two-pane; **every** real suite needs an env var (`RUN_REAL_CLAUDE=1` *or* `RUN_REAL_TMUX_E2E=1`) that **no script ever exports**. Only 4 trivial `--help` cases actually run.
- **F3 (P0, sharper root cause):** prior L1 said a "phase-count loop drift" dropped U14. The real cause is in the **planning layer** — a sub-agent renumbered U14 to "Phase 15"; and prior L1's fail-closed recommendation was **never implemented** — finalize is still fail-open.
- **F10 (P2, NEW):** driver `build()` throw-path leaks a booted tmux server (no `try/catch → dispose`).
- **F13 (P2, NEW):** a test *named* "the keymap reads it as uppercase-F" runs with `disableStepsView: true` and asserts only that the keystroke send resolves — false coverage confidence for the M1 gap.
- **F14 (P2, NEW):** `process.env.IS_SANDBOX = '1'` executes at module import time in `execute-plan` (violates CLAUDE.md rule 8; leaks into the `verify-check` subprocess).

---

## Verification run (reproducible)

```bash
bun tests/_migration/reconcile.ts        # → ENOENT tests-new/_migration/baseline.json, exit 1  (CRASH)
bun tests/_migration/overlap-report.ts   # → ENOENT scandir 'tests-new', exit 1                 (CRASH)
bun tests/_migration/import-parity.ts    # → "relocation pairs checked: 0 … ✓", exit 0          (FALSE GREEN)
bun test tests/_migration/__tests__      # → 37 pass / 1 fail (snapshot.test.ts), and OFF the gate
grep -n "rejects.toThrow" tests/unit/runners/codex/build-command.test.ts   # ~10 hits, none awaited
grep -rn "tests-new" CLAUDE.md docs/testing-strategy.md .claude/skills/    # active guidance → dead path
```

`buildCommand` is confirmed `async (): Promise<RunnerCommand>` (`src/runners/codex/codex-runner.ts:462`), so the un-awaited `.rejects` assertions are genuinely vacuous.

---

## Findings by severity

Finding IDs are stable; "Reviewers" notes cross-agent agreement; "vs prior" maps to the earlier reviews.

### 🔴 P0 — Critical

| # | File:line | Issue | Reviewers | Conf | vs prior |
|---|-----------|-------|-----------|------|----------|
| **F1** | `tests/_migration/{reconcile,overlap-report,import-parity,snapshot}.ts`; `package.json:20-37` | **Completeness oracles broken/false-green AND off the gate.** `reconcile`/`overlap-report` crash on hardcoded `tests-new/` paths; `import-parity` prints `pairs checked: 0 … ✓` (false green) because `loadRelocationMap()` returns `[]` when the map is missing (`import-parity.ts:194-196`). None are referenced by any `package.json` script, so `bun run check` never runs them. | correctness, maintainability, testing | 100 | C1 / codex-P1 — **confirmed by running** |
| **F2** | `package.json:15,34` | **`check:release` reports green while every real-CLI test silently skips.** Release exports only `RUN_REAL_E2E=1`, but `resume-real-claude`/`steps-tui-e2e` need `RUN_REAL_CLAUDE=1`; `builtin-phased-build.e2e` and the two-pane real-agent driver need `RUN_REAL_TMUX_E2E=1` (`fixture.ts:172`). Only 4 trivial `orch-run --help` cases actually execute. | reliability, correctness | 100 | broader than codex-P1 |
| **F3** | `workflows/execute-plan/index.ts:84-150` | **Finalize fails open; U14 never ran.** The `rm -rf tests` + `mv tests-new tests` execute inside the finalize *agent's* bash, gated only by the LLM's self-judged "green" — no `command()` runs `reconcile` with `onFailure:'abort'` before the delete. `verify-check` runs *after* the commit with `onFailure:'continue'` (`:157`). Separately, a planning sub-agent renumbered the terminal hardening unit U14 → "Phase 15" (`plan-phase-14.value`), so the loop (`1..14`) never reached it. Prior L1 *recommended* fail-closed; it was **not implemented**. | adversarial | 100 | C2/L1 — sharper root cause |

### 🟠 P1 — High

| # | File:line | Issue | Reviewers | Conf | vs prior |
|---|-----------|-------|-----------|------|----------|
| **F4** | `tests/unit/runners/codex/build-command.test.ts:173,180,191,200,209,216,225,247,256,267,432,439` | **NEW — security-critical vacuous assertions.** The entire Codex flag-denylist + version-gate suite uses `expect(runner.buildCommand(...)).rejects.toThrow(...)` **without `await`**. `buildCommand` is async, so if the denylist for `--yolo` / `--dangerously-bypass-approvals-and-sandbox` / `--config` / `--sandbox` / `-c` ever regresses and stops throwing, **every one passes green**. | testing | 100 | **missed by A & B** |
| **F5** | `package.json:32` | **Real-tmux integration runs unbounded on `check`.** `test:int = bun test tests/integration` has no `--max-concurrency`; 17+ files under `tests/integration/real-tmux/**` and `services/tmux/**` boot real tmux. Two-pane caps at 2, lifecycle at 1, but this legacy cluster gets none — the exact contention the bare-`bun test` ban claims to prevent. | reliability, project-standards | 100 | codex-P1 — confirmed |
| **F6** | `CLAUDE.md:42,47,56`; `docs/testing-strategy.md:47,50,72,77,95,110,119,154,155,162,169,183,204`; `.claude/skills/runner-author/SKILL.md:18,21,25,30,136,142,143,147`; `tests/dsl/README.md:18` | **Active author guidance points at the deleted `tests-new/` path.** A contributor following CLAUDE.md writes two-pane tests into a directory that doesn't exist and imports `from 'tests-new/dsl/index.ts'`. `testing-strategy.md:72` also wrongly claims `tests-new/` is in the tsconfig include. | project-standards | 100 | codex-P1 — **fully enumerated** (incl. `tests/dsl/README.md:18`, missed before) |
| **F7** | `tests/dsl/drivers/full-host-real-agent-driver.ts:63` | **real-agent skip predicate is runner-agnostic.** `skip = !(canRunRealTmuxE2E('claude') \|\| canRunRealTmuxE2E('codex'))`. Both scenarios use `claudeAgent(...)`. On a Codex-only box with `RUN_REAL_TMUX_E2E=1`, the test runs and spawns the absent `claude` → spurious *failure* instead of clean skip. | correctness, reliability | 90 | codex P1 — confirmed |
| **F8** | `workflows/execute-plan/index.ts:143-144`; `tests/_migration/baseline.json` | **Completeness no longer reproducible from HEAD.** The finalize prompt hard-codes "delete the tests/ directory entirely", removing the all-`.skip` archive that R13/D12 required be "kept forever". The only record of what existed is now `baseline.json`; the full dual-tree proof reproduces only at commit `0742468`. | adversarial | 100 | H1 — confirmed |

### 🟡 P2 — Medium

| # | File:line | Issue | Reviewers | Conf | vs prior |
|---|-----------|-------|-----------|------|----------|
| **F9** | `tests/unit/state/state-store.test.ts:159,253`; `tests/unit/services/fs/fake-fs-service.test.ts:62`; `tests/unit/runners/codex/codex-auto-stop.test.ts:68` | More missing-`await` / weak matchers. state-store ×2 (confirms M2 — but present at merge-base, *carried forward*, not "introduced phase 12"); `fake-fs-service:62` and `codex-auto-stop:68` are NEW (the latter also uses `.resolves.toBeDefined()`, a weak matcher). | testing | 100 | M2 + NEW |
| **F10** | `tests/dsl/drivers/full-host-real-agent-driver.ts:37-41` (also fake-agent `:173-184`, recorded `:39-43`, screen) | **NEW — driver `build()` throw-path leaks a booted tmux server.** `createRealTmuxFixture` registers the socket and `mountTmuxHost` boots the server with no `try/catch` calling `fixture.dispose()`. The scenario runner only wraps the test *body* in `finally` (`scenario.ts:103-108`), not `build()`; `LIVE_SOCKETS` reaping fires on SIGINT/SIGTERM, not an in-process throw → server leaks until the >5 min preload reap. | reliability | 75 | **missed by A & B** |
| **F11** | `tests/dsl/panes/left-pane.ts:17`; `tests/dsl/drivers/lifecycle-driver.ts:127`; `tests/dsl/app-surfaces.ts:164` | **Lifecycle pane typing over-promises.** `LifecycleApp.leftPane/rightPane` are typed as the full Pane classes (~25 methods), but the lifecycle backend routes all but `assertFocused` to `notImplemented()`. So `app.leftPane.assertQuitHintVisible()` type-checks and fails only at runtime — inverting the spec's compile-error promise. The `.test-d.ts` negative test structurally cannot catch this (the method exists on the type). | typescript | 75 | codex-P2 — confirmed + located |
| **F12** | `tests/_migration/snapshot.ts:55-56`; `tests/_migration/__tests__/` | Dead `tests/helpers/` classification rule (dir moved to `tests/_support/`) makes `snapshot.test.ts` **fail**; the whole 38-test `_migration/__tests__` dir is on no script. | correctness, testing | 100 | H2 — confirmed by running |
| **F13** | `tests/integration/real-tmux/pane-handle.test.ts:198-206` | **NEW — misleadingly-named test → false coverage confidence.** Named "sends a literal F … so the keymap reads it as uppercase-F" but runs with `disableStepsView: true` and only asserts `sendKeysToPaneId(rightId, 'F')` resolves — the keymap is never exercised, masking the real M1 uppercase-F gap. | testing | 90 | **missed by A & B** |
| **F14** | `workflows/execute-plan/index.ts:39` | **NEW — `process.env.IS_SANDBOX = '1'` at module import time.** Violates CLAUDE.md rule 8 (no side effects on import) and leaks into the `verify-check` subprocess's real-CLI spawns. | adversarial | 75 | **missed by A & B** |
| **F15** | `scripts/skip-migrated-u{7,10,11,12,13,14}.sh`, `relocate-core-u10.sh`, `relocate-u13.sh`, `move-test-infra-to-support.sh` | Stale one-shot migration scripts target gone `tests-new/`/old-tree paths; `skip-migrated-*` rewrite `it(`→`it.skip(` in place. Dangerous to run by mistake; no valid target remains. | maintainability | 90 | codex-P2 — confirmed + enumerated |
| **F16** | `tests/e2e/_pending-relocation.test.ts:11` | Dead `expect(true).toBe(true)` sentinel whose own header says "DELETE … the moment the first real e2e test relocates here" — `tests/e2e/` now has real tests. | maintainability | 100 | M3 / codex-P3 — confirmed |

### 🟢 P3 — Low / cosmetic

| # | File:line | Issue | vs prior |
|---|-----------|-------|----------|
| **F17** | `src/hosts/two-pane/steps-view/steps-view.tsx:267`; ledger drops | Real coverage gaps from `drop` dispositions: uppercase-`F` follow-live branch, `steps=[]` empty-state, four C6 real-host behavioural cases (auto-stop ordering, per-step-artifacts, resume orchestration, command streaming). Defensible drops, but real — file as tracked follow-ups. | M1 / codex-P2 — confirmed |
| **F18** | `tests/dsl/drivers/model-driver.ts:212` | `assertNoCaretEcho` on the model driver is vacuous by construction (a no-tmux frame can never echo a caret, spec §5.1). Contained today (no model scenario calls it) but exposed on the surface. | NEW |
| **F19** | `tests/_migration/relocation-map.json` | Doubly stale: `import-parity` can't be fixed by repointing `MAP_PATH` alone — all 268 `new` paths point at deleted `tests-new/*`; needs full regeneration. The `@orch/test/` alias (`import-parity.ts:39`) still targets `tests-new/_support/`. | NEW (refines F1 fix) |
| **F20** | `tests/dsl/scenario.ts:105` | `body(app as unknown as SharedApp<D>)` is the single trust seam the typed DSL rests on; `driver.build` returns only `AppBase`. Deliberate + isolated, but a typed `build<D>` overload would remove the `unknown` hop. | NEW |
| **F21** | `tests/_migration/*.ts` headers; `tests/dsl/scenario.ts:14-15,35`; `agent-spec.ts:37`; `biome.json` | Stale `bun run tests-new/_migration/…` invocation comments; biome schema pinned `2.4.10` vs CLI `2.4.16`. | L-cosmetic — confirmed |

---

## What went well (independently confirmed)

- **Frozen baseline + case-granular ledger** with a written reason for every drop — honoured throughout.
- **Content-asserting DSL.** Scenarios assert real pane affordances via co-located `TEXT`/`COLOR` constants (never imported from `src/`, never inlined in scenarios) — verified across model/screen/full-host/lifecycle scenario files. Passes the "would it pass if the pane were empty?" triage.
- **Genuinely type-safe DSL.** `SharedApp<D>` over a `<const D>` tuple makes a `['model']` scenario unable to touch `rightPane`, and `['model','screen']` unable to call `resize` — real compile errors, proven in `scenario.test-d.ts`. Driver registry uses `satisfies Record<DriverName, …>` (exhaustive). No `any`, no `!` in the new infra/scenarios.
- **The 5 long-standing `.orch/` ENOENT fixture failures are fixed** — rewritten onto tracked fixtures under `tests/_support/fixtures/`.
- **The finalize agent verified before deleting** — it ran `reconcile` green and dispatched an audit sub-agent that caught two real runtime leaks (`workflow-fixtures.ts`, `bunfig.toml`) and fixed them. **There is no evidence coverage was lost** at deletion time; the problem is the proof is no longer reproducible from HEAD.

---

## Process lesson for `execute-plan` (root cause of F3)

The terminal "prove-it / harden-the-gate" unit is exactly the one most likely to be (a) deferred by a per-phase planning agent *and* (b) silently replaced by the generic destructive `finalize`. Recommended hardening:

1. **Fail closed.** `finalize` must run a workflow-owned `command()` step (`reconcile`, `onFailure:'abort'`) and perform the `mv` itself — never delete the old tree from inside an LLM agent's bash on self-judged "green".
2. **Key the loop on named units, not a bare integer count.** Assert the *terminal named unit* (U14) executed; an inserted/renumbered phase must not be able to push it out of range.
3. **`finalize` repoints and re-runs the migration's own guards** as part of its contract, rather than assuming a separate phase did.
4. Move `process.env.IS_SANDBOX` out of module scope (F14).

---

## Suggested action checklist (priority order)

1. **[F1/F19]** Repoint `reconcile`/`overlap-report`/`import-parity`/`snapshot` + `relocation-map.json` to `tests/` (regenerate the map data, don't just swap the string), make zero relocation pairs a **failure**, re-run `reconcile` against the frozen baseline to confirm clean, and add `reconcile` + `import-parity` to `package.json` and onto `bun run check`. *Or* archive the tooling with an `ARCHIVE.md` "not valid after promotion" — but do not leave a script that exits 0 while checking nothing.
2. **[F2]** Add a release preflight that hard-fails unless `RUN_REAL_CLAUDE`/`RUN_REAL_TMUX_E2E` and the `claude`/`codex`/`tmux` binaries are present, and make `test:e2e:real`/`test:two-pane:full:real` set/require the envs they actually need.
3. **[F4/F9]** Add the missing `await`s — start with `build-command.test.ts` (security-critical), then state-store, fake-fs-service, codex-auto-stop. Consider a lint rule banning un-awaited `expect().rejects/.resolves`.
4. **[F5]** Split a capped `test:int:real-tmux` (`--max-concurrency=2`) and exclude real-tmux dirs from `test:int`.
5. **[F6]** Update CLAUDE.md, `docs/testing-strategy.md`, `runner-author/SKILL.md`, and `tests/dsl/README.md` from `tests-new/` → `tests/`; delete the "during migration" routing.
6. **[F3/F14]** Harden `execute-plan` finalize (fail-closed delete, named-unit loop, move `IS_SANDBOX`). Run the deferred U14 reconciliation pass.
7. **[F7/F10/F11]** Make real-agent skip runner-specific; wrap driver `build()` in `try/catch → dispose → rethrow`; narrow `LifecycleApp` pane types to the methods the lifecycle backend supports (or implement them).
8. **[F12/F13/F15/F16]** Fix the `snapshot.ts` `tests/helpers` rule and put `_migration/__tests__` on the gate (or retire); rename/fix the false uppercase-F test; delete the eight completed one-shot scripts and the `_pending-relocation` sentinel.
9. **[F17]** File tracked follow-ups for the dropped behaviours (cheapest: a raw-keystroke DSL primitive for `F` and the `steps=[]` cases; the four C6 cases need a host-integration fixture).
10. **[F8]** Add a ledger/plan note: the `.skip` archive was intentionally removed at `c99a364`; `0742468` is the last commit where the dual-tree proof reproduces.

---

## Coverage notes

- **Reviewers run:** correctness, adversarial, testing, maintainability, project-standards, reliability, kieran-typescript. Skipped as inapplicable: security (no auth/endpoints/user-input surface — though F4 is security-*relevant*), api-contract, data-migrations, rails/python/swift.
- **Cross-reviewer corroboration:** F1 (oracles) was independently surfaced by correctness, maintainability, *and* testing — highest-confidence finding. F5/F6 (gate + docs) by reliability + project-standards. F7 by correctness + reliability.
- **Checked and cleared:** no `any`/`!` in the new DSL; the prior review's "four `_support` re-export shims" are **not present** at HEAD (every `tests/_support/` file is a real implementation — they were removed in the rename); `?.` usages in scenarios are on mock-call arrays, not the banned `app?.<driver-cap>` dodge; `behavioral-dsl` and two-pane `dsl` are distinct justified surfaces, not duplicated infra.
- **Protected artifacts** (`docs/brainstorms/`, `docs/plans/`) were excluded from cleanup findings.
- Per-agent full JSON: `/tmp/compound-engineering/ce-code-review/20260606-121438-cemig/`.
