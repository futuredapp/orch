---
status: active
type: refactor
title: "refactor: Phase 11 (U11) — relocate runners/** tests into tests-new/{unit,integration}/runners"
created: 2026-06-06
parent: docs/plans/2026-06-05-001-refactor-testing-strategy-restructure-plan.md
depth: standard
---

# refactor: Phase 11 (U11) — relocate `runners/**` tests into `tests-new/{unit,integration}/runners`

> **This is a phase plan.** It elaborates **U11** of the parent
> [`docs/plans/2026-06-05-001-refactor-testing-strategy-restructure-plan.md`](2026-06-05-001-refactor-testing-strategy-restructure-plan.md)
> (Phase group C — "Migrate the rest of the repo"). It honours every decision in
> the parent §3 (D1–D15) and the §8 script ladder; it does **not** relitigate
> them. Phases 1–10 are complete (see [`docs/plans/phase-summaries.md`](phase-summaries.md));
> group B (the two-pane behavioural surface) is fully migrated and U10 relocated
> `core/**` while building the reusable **import-parity guard**. U11 is the
> **second** of the four relocation phases (U10–U13) and is a near-pure
> application of the U10 recipe — it builds **no new machinery**.

---

## 1. Summary

U11 is a **relocation, not a re-derivation** (parent D1). The `runners/**` tests
are already plain class/integration tests with fakes at the `*Service` seam — the
parent's `unit` category *is* today's unit concept. The work is: move each old
`runners` test file into its mirror under `tests-new/{unit,integration}/runners/`,
fix its import paths, wrap the old file `.skip` with a `// MIGRATED →` marker, and
ledger it. **No behavioural rewrite.** A correct `port` is diff-identical to its
original except for import paths and the `describe`/`it` → `.skip` wrap on the
retained old copy (parent §7 group-C verification).

U11 is materially **simpler than U10** because U10 already paid the one-time
costs:

1. **The import-parity guard already exists and is on the gate.** U10 shipped
   `tests-new/_migration/import-parity.ts` + `check:import-parity` (parent R10).
   U11 reuses it verbatim; the `@orch/runners/` alias and the resolution logic
   already cover runner imports. No guard work in U11.
2. **`fake-host.ts` is already in `_support/`.** U10.2 moved it (shim left at the
   old path, parent D13). The 5 runner integration files that import it via
   `../../../helpers/fake-host.ts` simply rewrite to `@orch/test/fake-host.ts` —
   no new helper move.

What makes U11 **more than a `cp`** is one cross-tree **fixture** dependency:
`tests/integration/runners/scripted-fake/two-step-linear.smoke.test.ts` imports
`tests/fixtures/lifecycle/two-step-linear.ts`. `tests-new/` may never import from
`tests/` (parent D13), so that single fixture must cross the tree boundary first
(§3 PD2, U11.1). The broader `tests/fixtures/lifecycle/` directory move stays
**deferred** (it has a runtime-path consumer the parent and the lifecycle driver
explicitly defer — see PD2).

**Scope guard.** U11 relocates the **36 `test`-classified** runner files (21 unit
`.test.ts(x)` + 15 integration `.test.ts`, ~323 cases). There are **no
`.test-d.ts` type-tests** under `runners/**` (every runner baseline entry is
classified `test`), so U11 carries none of U10's type-test deferral. No `src/`
file is touched.

---

## 2. Problem frame & goals

**Problem.** The parent's frozen baseline (parent D12) classifies 36 runner
entries, all `test`. U10–U13 must drain every `test`/`type-test` entry to a
disposition; U10 drained `core/**`. U11 drains the **`runners/**` `test`
cluster** — the second-largest single module — reusing the U10 machinery
end-to-end.

**Goals (in priority order).**
1. **Parity** — every relocated file imports the **same `src/` symbols** as its
   baseline original and resolves them on disk; no `tests-new → tests` import
   survives. This is the contract a relocation must satisfy (parent R10), now
   enforced automatically by the U10 guard on every `bun run check`.
2. **Honesty of accounting** — every old runner `test` file ends fully `.skip`
   with a `// MIGRATED →` marker and a ledger row keyed to the frozen baseline;
   the U14 reconciliation can later prove completeness against it (parent D12,
   D15).
3. **No semantic drift** — `port` rows are diff-identical except import paths. No
   test is rewritten, split, "improved", or pruned (this is relocation, not the
   triage re-derivation group B did — parent R3). Capability gates (`skipIf`) on
   the real/e2e-lite runner files are preserved **verbatim** in the new copies.
4. **Boundary-crossing fixture handled cleanly** — the one cross-tree fixture
   dependency moves to `_support/` with a re-export shim (parent D13), without
   disturbing the deferred lifecycle-fixture-directory move.

**Non-goals.**
- Not touching any `src/` file. U11 changes only tests + the one fixture file +
  `package.json`/migration artifacts.
- Not re-deriving, merging, demoting, or dropping any runner case. A pure
  relocation ports every case 1:1.
- Not relocating the whole `tests/fixtures/lifecycle/` directory or repointing
  the behavioral-dsl runtime `FIXTURES_DIR` — that is a later parent phase (see
  the `tests-new/dsl/drivers/lifecycle-driver.ts` deferral comment and Phase 2
  summary). U11 moves **only** the single fixture a relocating runner test needs.
- Not re-categorising the real/e2e-lite runner integration tests into
  `tests-new/e2e/`. Per "existing convention" (parent U11 row) they stay under
  `tests-new/integration/runners/**`, capability-gated as today (§3 PD4).
- Not chasing the 5 pre-existing `ENOENT` fixture failures under gitignored
  `.orch/` (a long-standing infra artifact, unrelated to this phase — see
  [[orch-test-fixtures-under-gitignored-orch]] and the Phase 4–10 summaries).

---

## 3. Key decisions (phase-local, inheriting parent D1–D15)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| **PD1** | **No new machinery** | U11 builds **no** parity guard, **no** new move script logic, and adds **no** new `package.json` test buckets. It reuses `tests-new/_migration/import-parity.ts`, `check:import-parity`, `test:new-unit`, `test:new-int`, and the `relocation-map.json`/`ledger.md` artifacts U10 created. Only a new **parameterised skip script** (`scripts/skip-migrated-u11.sh`) is added, mirroring `skip-migrated-u10.sh`. | U10 (parent PD4) explicitly built the guard "once here and reused by U11–U13". Re-deciding any of it would be relitigation. The runner imports already resolve through the existing `@orch/runners/` / `@orch/test/` aliases. |
| **PD2** | **Cross-tree fixture: move one file + shim** | **Move** `tests/fixtures/lifecycle/two-step-linear.ts` → `tests-new/_support/fixtures/lifecycle/two-step-linear.ts`, leaving a thin re-export shim (`export { default } from '@orch/test/fixtures/lifecycle/two-step-linear.ts'`) at the old path (parent D13). The relocated smoke test imports it via the `@orch/test/*` alias. The rest of `tests/fixtures/lifecycle/` is **not** moved; its runtime-path consumer (`tests-new/_support/behavioral-dsl/internal/workflow-fixtures.ts`, which resolves the *directory* at runtime) keeps working because the file still physically exists at the old path as a shim. | The smoke test's `import wf from '.../tests/fixtures/lifecycle/two-step-linear.ts'` is the **only** cross-tree fixture import among the 36 files. A whole-directory move is entangled with the deferred behavioral-dsl `FIXTURES_DIR` repoint (lifecycle-driver comment; Phase 2 summary) and is out of U11 scope. A single-file move + shim satisfies the no-`tests/`-import rule (D13) for the relocated test while leaving the deferred work untouched. *(Fallback if the single-file move proves awkward: **copy** the fixture into `_support/fixtures/lifecycle/`, leave the original in place, and account the baseline `fixture` entry as "kept for runtime-path consumer; duplicated into `_support` for the relocated test; full dir move deferred." U14 reconcile only requires `test`/`type-test` entries to drain — fixtures are `_support`-moved **or** accounted, parent D12.)* |
| **PD3** | **Import-rewrite rules** | `../../../src/...` and `../../../../src/...` → **unchanged** (depth-preserving move). `../../../helpers/fake-host.ts` (any depth) → `@orch/test/fake-host.ts`. `../../../../tests/fixtures/lifecycle/two-step-linear.ts` → `@orch/test/fixtures/lifecycle/two-step-linear.ts`. All other relative imports unchanged. | `tests/unit/runners/X` and `tests-new/unit/runners/X` are both three dirs deep; their `claude/`,`codex/`,`scripted-fake/`,`fake/` subdirs are both four deep; `tests/integration/runners/**` mirrors identically. So every `src/` relative import has the identical `../` count after the move (the U2/U10 invariant). Only the two cross-tree specifiers change, both to the `@orch/test/*` alias already pointed at `_support/` (`tsconfig.json`). |
| **PD4** | **Real/e2e-lite runner files stay under `integration/`, gated** | The 5 capability-gated runner integration files (`scripted-fake/entry.real`, `claude/claude-real`, `claude/claude-structured-real`, `claude/claude-e2e-lite`, `codex/codex-real`) relocate into `tests-new/integration/runners/**` mirroring their current home, keeping their `skipIf`/`describe.skipIf` predicates **verbatim** in the new copy. They are **not** moved to `tests-new/e2e/`. | The parent U11 row says "real runner tests → `tests-new/e2e` **or kept gated under integration per existing convention**." The existing convention is that real runner tests live under `tests/integration/runners/**/*-real.test.ts` (gated), never under `tests/e2e/`. Keeping the existing home preserves the diff-identical relocation contract (R3); moving them would be a re-categorisation, i.e. a re-derivation. Capability gating prevents false failure and never *causes* a run (parent D8). |
| **PD5** | **Ledger granularity** | **One `port` row per old file**, enumerating its cases in the "Old case" column (e.g. `(all 36 cases: …)`), with any regression-pin run-IDs preserved in the reason. Follow the U7/U10 precedent verbatim. | The parent requires case-granular accounting (D15), but the established house convention for **relocations** (U10's `## Relocated — core/**` section) records one row per file with a parenthetical case enumeration — ~323 one-line rows would bury the signal. The enumeration satisfies "every child case is mapped" while staying reviewable. |
| **PD6** | **Old-file disposition** | Wrap every old runner `test` file in unconditional `describe.skip`/`it.skip`/`test.skip` + a top `// MIGRATED → <new path> (parent U11)` marker, via a reusable script (`scripts/skip-migrated-u11.sh`). **Convert any `describe.skipIf(...)` → `describe.skip`** on the old copy so U14 reconcile reads it as *migrated*, not *capability-skipped*. | Parent D2/D15 + R13: the reconcile AST scan distinguishes `skipIf` (capability) from unconditional `.skip` (migrated). The real/e2e-lite runner files currently use `skipIf`; their old copies flip to unconditional `.skip` while the **new** copies keep `skipIf` (legitimate capability gating, D8). A script keeps the edit mechanical and uniform (cf. [[prefer-scripts-over-complex-git]]). |
| **PD7** | **Shim lifetime** | U11 does **not** delete the `tests/helpers/fake-host.ts` shim (U10 left it; non-runner old consumers still use it until U12/U13). U11 leaves the new `tests/fixtures/lifecycle/two-step-linear.ts` shim in place for the deferred dir move / runtime-path consumer. | Parent D13/R11: a shim is deleted only when the *last* old consumer is skipped. `fake-host` still has live non-runner old consumers; the lifecycle fixture dir is deferred. Premature shim deletion breaks the still-green old suite. |

---

## 4. Inventory (from the frozen baseline, parent D12)

> The implementer must confirm this list against `tests-new/_migration/baseline.json`
> at run time (the baseline is the source of truth, not this prose). Expected
> outcome: **36 `test` entries** under the two `runners` prefixes end as `port`
> ledger rows; the **1 cross-tree fixture** (`two-step-linear.ts`) is `_support`-moved
> (D13), not a relocated test; **zero** `type-test` entries exist under `runners/**`.

**`tests/unit/runners/` → `tests-new/unit/runners/` (21 `.test.ts(x)`).**

- Top-level (mirror `src/runners/`): `default-view`, `define-runner`, `execute`,
  `execute-interactive`, `runner-resume` `.test.ts`.
- `scripted-fake/` (4 dirs deep): `addressing`, `command-engine`, `script-loader`,
  `scripted-fake-runner` `.test.ts`.
- `claude/` (4 deep): `build-command`, `claude-auto-stop`, `format-event`,
  `parse-events` `.test.ts`.
- `codex/` (4 deep): `build-command`, `capture-lock`, `capture-session-id`,
  `capture-thread-id`, `codex-auto-stop`, `format-event`, `parse-events` `.test.ts`.
- `fake/` (4 deep): `fake-runner.test.ts`.

**`tests/integration/runners/` → `tests-new/integration/runners/` (15 `.test.ts`).**

- Top-level: `run-runner`, `scripted-fake-interactive`,
  `scripted-fake-puppet-addressing`, `scripted-fake-ink` (`.test.tsx`),
  `cross-runner-parallel` `.test.ts`.
- `scripted-fake/`: `entry.real` *(gated)*, `two-step-linear.smoke` *(imports the
  cross-tree fixture — PD2)*.
- `claude/`: `claude-e2e-lite` *(gated)*, `claude-mocked`, `claude-real` *(gated)*,
  `claude-resume`, `claude-structured-mocked`, `claude-structured-real` *(gated)*.
- `codex/`: `codex-mocked`, `codex-real` *(gated)*.

**Cross-tree dependencies (the complete set across all 36 files).**
- `fake-host.ts` (via `../../../helpers/fake-host.ts`) — imported by **5**
  integration files: `claude-structured-mocked`, `claude-e2e-lite`,
  `claude-structured-real`, `claude-resume`, `scripted-fake/two-step-linear.smoke`.
  **Already in `_support/` (U10.2)** → rewrite specifier to `@orch/test/fake-host.ts`.
- `tests/fixtures/lifecycle/two-step-linear.ts` — imported by **1** file
  (`scripted-fake/two-step-linear.smoke`). **Handled in U11.1 (PD2).**
- No other `tests/`-tree imports exist in the 36 files (re-verify with a grep at
  run time before assuming).

---

## 5. Output structure

```
tests-new/
  _support/
    fixtures/
      lifecycle/
        two-step-linear.ts          # MOVED from tests/fixtures/lifecycle/ (shim left behind) — PD2
  _migration/
    relocation-map.json             # + 36 runner old→new rows (appended)
    ledger.md                       # + "Relocated — runners/** (parent U11)" section
  unit/
    runners/                        # NEW — mirror of src/runners
      *.test.ts                     # 5 top-level
      scripted-fake/*.test.ts       # 4
      claude/*.test.ts              # 4
      codex/*.test.ts               # 7
      fake/fake-runner.test.ts      # 1
  integration/
    runners/                        # NEW — mirror of src/runners
      *.test.ts(x)                  # 5 top-level (incl. scripted-fake-ink.test.tsx)
      scripted-fake/*.test.ts       # 2 (entry.real gated; two-step-linear.smoke)
      claude/*.test.ts              # 6 (3 gated)
      codex/*.test.ts               # 2 (1 gated)
scripts/
  skip-migrated-u11.sh              # NEW reusable skip+marker script (PD6), mirrors skip-migrated-u10.sh
tests/
  fixtures/lifecycle/two-step-linear.ts  # now a re-export shim → @orch/test/fixtures/lifecycle/two-step-linear.ts
  unit/runners/**                   # all .skip with // MIGRATED → markers (kept on disk, D2)
  integration/runners/**            # all .skip with // MIGRATED → markers
```

The per-unit **Files** sections below remain authoritative; this tree is the
scope shape.

---

## 6. Implementation units

Ordered. Each leaves `bun run check` green (new tests + still-running old suite).
A unit is done only when its Definition of Done holds.

### U11.1 — Cross the fixture boundary (`two-step-linear.ts` → `_support` + shim)

**Goal.** Make the one cross-tree fixture importable from `tests-new/` via
`@orch/test/*`, without breaking the still-green old suite or the deferred
behavioral-dsl runtime-path consumer.

**Requirements.** Parent D13, R11; PD2.

**Dependencies.** None (must precede U11.3's relocation of the smoke test).

**Files (move/create).**
- `tests-new/_support/fixtures/lifecycle/two-step-linear.ts` ← moved from
  `tests/fixtures/lifecycle/two-step-linear.ts`.
- `tests/fixtures/lifecycle/two-step-linear.ts` — replaced with a thin
  `export { default } from '@orch/test/fixtures/lifecycle/two-step-linear.ts'`
  re-export shim (preserve any named exports the fixture has; the smoke test uses
  the default export `wf`).
- Reuse/extend `scripts/move-test-infra-to-support.sh` (the U2/U10 script) for the
  move + shim if convenient, to keep the shim shape uniform — or move by hand
  given it is a single file.

**Approach.**
- Confirm the moved file's own imports still resolve. `two-step-linear.ts` is a
  workflow fixture; if it imports from `src/` it must keep resolving from the new
  `_support/fixtures/lifecycle/` location — check the relative depth and adjust
  only that file's `src/` import prefix if the depth changed (it likely does:
  `tests/fixtures/lifecycle/` is 3 deep, `tests-new/_support/fixtures/lifecycle/`
  is 4 deep — verify and fix the fixture's own `src/` specifiers accordingly, or
  prefer an `@orch/*` alias import). This is the **one** place in U11 where a `src/`
  import prefix may legitimately change, because the fixture is `_support`-moved,
  not depth-preserved like the tests.
- Verify the `@orch/test/*` alias resolves the nested subpath
  `@orch/test/fixtures/lifecycle/two-step-linear.ts` →
  `tests-new/_support/fixtures/lifecycle/two-step-linear.ts` (the existing
  `@orch/test/* → tests-new/_support/*` mapping covers nested paths).
- Do **not** move the other 9 lifecycle fixtures and do **not** touch
  `workflow-fixtures.ts`'s `FIXTURES_DIR` (deferred — PD2). The shim keeps the
  file physically present at the old path for the directory-resolving consumer.

**Patterns to follow.** The U1/U2/U10 helper moves (`type-assertions.ts`,
`ink-frame.ts`, `fake-host.ts` — each left a re-export shim; see
`scripts/move-test-infra-to-support.sh` and the Phase 1/2/10 summaries).

**Test scenarios.** *Test expectation: none — infra move.* Correctness is proven
by the existing suites:
- `bun run typecheck` resolves both the new `_support` path and the old shim.
- A sampled `bun run test:legacy` over the old (still-live) smoke test resolves
  the fixture through the shim and stays green.
- `bun run check:import-parity` (after U11.3 lands the relocated smoke test) shows
  the new test's `@orch/test/fixtures/...` import resolves on disk.

**Verification.** `@orch/test/fixtures/lifecycle/two-step-linear.ts` resolves
under `typecheck`; the old shim resolves for the still-live old smoke test and the
runtime-path consumer; no test was skipped or edited beyond the shim and the moved
fixture's own imports.

---

### U11.2 — Relocate `tests/unit/runners/**` → `tests-new/unit/runners/**`

**Goal.** Move the 21 unit `.test.ts(x)` files, fix imports per PD3, and prove the
new copies green. (None of the unit files have cross-tree deps — they are pure
`src/`-relative byte copies.)

**Requirements.** Parent D1, D3, D13; PD3.

**Dependencies.** None for the unit files specifically (no helper/fixture deps);
the U10 parity guard already exists.

**Files (create).**
`tests-new/unit/runners/*.test.ts` (5 top-level),
`tests-new/unit/runners/scripted-fake/*.test.ts` (4),
`tests-new/unit/runners/claude/*.test.ts` (4),
`tests-new/unit/runners/codex/*.test.ts` (7),
`tests-new/unit/runners/fake/fake-runner.test.ts` (1). Create the `runners/` dir
tree under `tests-new/unit/` (no sentinel to delete — removed in U10).

**Approach.**
- Copy each file to its mirror path byte-for-byte; the `src/` relative imports are
  **unchanged** (depth preserved, PD3). The unit cluster has **no** helper or
  fixture imports to rewrite — confirm with a grep before copying.
- Do **not** split, rename, reorder, or edit any `describe`/`it` body — relocation
  only (parent R3). A pre-existing file-size lint **warning** (e.g.
  `codex/capture-thread-id.test.ts` at 490 lines, `codex/build-command.test.ts` at
  467) travels with the file unchanged; do not "fix" it here.
- Run the U10 parity guard on each new file against its old original as the
  acceptance gate for the copy.

**Patterns to follow.** U10.3's relocation of `tests/unit/core/**` (byte-faithful
move, import-depth invariance, regression-pin preservation; see the `## Relocated —
core/**` ledger section).

**Test scenarios.** *Test expectation: relocation parity — same assertions, new
path.* A diff of old vs new is import paths only (here, identical for the unit
cluster). Acceptance is mechanical:
- `bun run test:new-unit` runs the relocated runner unit tests green. *(happy)*
- Import-parity guard passes for every relocated unit file (same `src/` symbol-set;
  resolves; no `tests/` import). *(critical)* `Covers R10.`
- The `scripted-fake/`, `claude/`, `codex/`, `fake/` subdir tests resolve their
  `../../../../src/runners/...` imports from the new four-deep location. *(integration)*

**Verification.** `bun run test:new-unit` green; `bun run typecheck` green;
`bun run check:import-parity` green for the unit-runners map rows (added in U11.4,
or add the map rows incrementally as files land); the new `tests-new/unit/runners/`
tree is non-empty and green for a real reason.

---

### U11.3 — Relocate `tests/integration/runners/**` → `tests-new/integration/runners/**`

**Goal.** Move the 15 integration `.test.ts` files, fix imports per PD3
(`fake-host` → alias; the one fixture → alias), preserve capability gating
verbatim on the gated files (PD4), and prove green.

**Requirements.** Parent D1, D3, D8, D13; PD3, PD4.

**Dependencies.** U11.1 (the fixture must be in `_support` before the smoke test
relocates).

**Files (create).**
`tests-new/integration/runners/*.test.ts(x)` (5 top-level, incl.
`scripted-fake-ink.test.tsx`),
`tests-new/integration/runners/scripted-fake/*.test.ts` (2),
`tests-new/integration/runners/claude/*.test.ts` (6),
`tests-new/integration/runners/codex/*.test.ts` (2). Create the `runners/` dir
tree under `tests-new/integration/` (no sentinel to delete).

**Approach.**
- Same mechanical move + PD3 rewrites as U11.2. The cross-tree rewrites here:
  `../../../helpers/fake-host.ts` → `@orch/test/fake-host.ts` (5 files); the
  `two-step-linear.ts` fixture import → `@orch/test/fixtures/lifecycle/two-step-linear.ts`
  (1 file). A codemod/`sed` over those two specifier patterns keeps it mechanical;
  everything else is byte-copy.
- The **new** copies of `entry.real`, `claude-real`, `claude-structured-real`,
  `claude-e2e-lite`, `codex-real` keep their existing `skipIf`/`describe.skipIf`
  predicates **verbatim** — capability gating prevents false failure on an
  incapable box and never *causes* a run (parent D8, PD4). Only the **old** copies
  flip to unconditional `.skip` (U11.4, PD6).
- Re-verify (grep) that no integration-runner file imports any other fixture/
  setup/helper outside the two known specifiers before assuming the inventory is
  complete.

**Patterns to follow.** U10.4's relocation of gated `*-real` core integration
tests (kept `skipIf` in the new copy); the unchanged three-layer model
(CLAUDE.md "How to write tests").

**Test scenarios.** *Test expectation: relocation parity.*
- `bun run test:new-int` runs the relocated mocked runner integration tests green;
  the gated `*-real`/`*-e2e-lite` tests auto-skip without their capability
  (CLI/tmux/env), proving the gate predicate survived the move. *(happy + gating)*
- Import-parity guard passes for every relocated integration file — including the
  smoke test's `@orch/test/fixtures/...` resolving to the U11.1 `_support` file and
  the 5 `@orch/test/fake-host.ts` imports resolving. *(critical)* `Covers R10, D13.`
- `scripted-fake-ink.test.tsx` (the `.tsx` ink test) renders and asserts green
  from the new location. *(integration)*

**Verification.** `bun run test:new-int` green; the gated files auto-skip off the
gate and run only under their capability; parity guard green for the
integration-runners map; the new `tests-new/integration/runners/` tree non-empty
and green.

---

### U11.4 — Append the relocation map, skip the old files, ledger, and reconcile-readiness

**Goal.** Append the 36 old→new rows to the relocation map, wrap every old runner
`test` file `.skip` with a `// MIGRATED →` marker, write the ledger section, and
confirm the migration accounting is consistent with the frozen baseline.

**Requirements.** Parent D2, D12, D15, R3, R13; PD5, PD6.

**Dependencies.** U11.2, U11.3 (new copies must be green before the old guard is
dropped).

**Files (create/modify).**
- `tests-new/_migration/relocation-map.json` — append 36 `{ old, new }` runner
  rows (the `check:import-parity` gate reads this map; the rows may instead be
  added incrementally in U11.2/U11.3 — land them no later than here).
- `scripts/skip-migrated-u11.sh` — reusable, modelled on `skip-migrated-u10.sh`:
  for each old runner `test` file, wrap top-level `describe(`→`describe.skip(`,
  `it(`/`test(`→`.skip(`, **convert `describe.skipIf(...)`→`describe.skip`**, and
  prepend `// MIGRATED → <new path> (parent U11)`. Idempotent (skips files already
  marked); takes the old→new map / targets the two runner directories.
- `tests/unit/runners/**/*.test.ts`, `tests/integration/runners/**/*.test.ts` —
  `.skip` + marker applied by the script (content otherwise unchanged, kept on
  disk; D2).
- `tests-new/_migration/ledger.md` — new section
  `## Relocated — runners/** (parent U11)` with **one `port` row per old file**
  (PD5), enumerating cases + preserving any regression-pin run-IDs from the file.

**Approach.**
- The script must skip only the 36 `test` files; it must not touch the moved
  `_support` fixture or its old-path shim.
- Each new relocated file is **not** a `scenario()`, so it carries no
  `oldTestRefs`/overlap metadata — the ledger row *is* its accounting (the U7/U10
  precedent). Add a short prose note to the section header explaining this,
  mirroring U10's `## Relocated — core/**` header.
- Account the `two-step-linear.ts` fixture as a **D13 `_support` move** (not a
  `port`/`drop` test row) so U14 reconciles the baseline `fixture` entry via the
  move, not as a relocated test — add a one-line infra note in the ledger section
  header.
- Verify reconcile-readiness by hand/AST: every old runner `test` file is now
  unconditional `.skip` (not `skipIf`); every ledger row's `MIGRATED →` target
  exists on disk. (The U14 `reconcile.ts` does not exist yet — U11 only needs the
  inputs to be correct.)

**Patterns to follow.** `scripts/skip-migrated-u10.sh`; the `ledger.md`
`## Relocated — core/**` section shape; the old skipped-file marker style
(`// MIGRATED → tests-new/... (parent U10) … kept skipped on disk (D2).`).

**Test scenarios.** *Test expectation: none — mechanical skip + documentation.*
Acceptance is structural:
- Every old runner `test` file is unconditional `describe.skip`/`it.skip` (grep:
  no surviving non-skipped `it(`/`test(` at the top level; no `skipIf` left on a
  migrated file). *(critical — the D15 green-but-incomplete trap)*
- Every `// MIGRATED →` target path exists. *(critical)*
- The ledger section has one row per old file; every row is `port` with a reason;
  regression-pin IDs preserved; the fixture move is noted as a D13 `_support`
  account. *(coverage)*
- `relocation-map.json` contains all 36 runner rows and `check:import-parity`
  passes over them. *(integration)*

**Verification.** `bun run check` green (old runner tests now skip, new ones run);
a grep confirms no old runner file is left non-skipped or `skipIf`-gated; ledger
section complete; `tests-new/_migration/__tests__/snapshot.test.ts` still green
(the frozen baseline is untouched — U11 never regenerates it, parent D12).

---

## 7. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Mis-resolved `../` after the move** (R10): a wrong depth resolves to nothing or the wrong module while looking diff-identical. | Low | The U10 parity guard (`check:import-parity`) runs as the acceptance gate for U11.2/U11.3 — not just "`check` is green". Depth is in fact unchanged for every `src/` import (PD3), so the guard mostly protects against a stray hand-edit. |
| **Cross-tree fixture import survives** in the relocated smoke test (D13 violation). | Medium | U11.1 moves the fixture to `_support` + shim **before** U11.3 relocates the smoke test; PD3 rewrites the specifier to `@orch/test/*`; the parity guard's "no `tests/` import" check fails the build if any `tests/` specifier remains. |
| **Moving the fixture breaks the deferred runtime-path consumer** (`FIXTURES_DIR` directory resolution). | Medium | PD2: only the single file moves and a shim is left at the old path, so the directory-resolving consumer still finds it; the other 9 fixtures and `workflow-fixtures.ts` are untouched. A sampled `bun run test:legacy` over the old smoke test confirms resolution through the shim. |
| **`skipIf` mistaken for migrated** by the future U14 reconcile (R13). | Medium | PD6: old copies of the 5 gated files flip `skipIf`→unconditional `.skip`; the new copies keep `skipIf`. The U11.4 grep explicitly checks no `skipIf` survives on an old migrated file. |
| **Skipping a file before every case is accounted** (D15 green-but-incomplete trap). | Low | One row per file enumerating *all* cases (PD5); the U11.4 grep proves no non-skipped top-level `it(`/`test(` remains; the new copy is proven green first. |
| **Accidental semantic edit during "relocation"** (R3 drift). | Low | No body edits permitted; rewrites limited to the two cross-tree specifiers via codemod; a per-file old↔new diff should show import lines + the old-copy `.skip` wrap only. |
| **The moved fixture's own `src/` imports break** (depth changes from 3→4 deep). | Low | U11.1 explicitly checks and fixes the fixture's own `src/` specifiers (or switches them to an `@orch/*` alias) — the one sanctioned `src/`-prefix change in U11, because the fixture is `_support`-moved, not depth-preserved. `typecheck` catches a miss. |
| **Re-running the baseline snapshot** against the mutating tree (parent D12 hazard). | Low | U11 never regenerates `baseline.json`; `snapshot.test.ts` staying green confirms it. |

---

## 8. Definition of Done (U11)

- The 21 unit + 15 integration runner `test` files run green from
  `tests-new/{unit,integration}/runners/**` (`bun run test:new-unit` +
  `bun run test:new-int`).
- The 5 gated runner integration files keep `skipIf` in their **new** copies and
  auto-skip off the gate without their capability (CLI/tmux/env).
- `tests/fixtures/lifecycle/two-step-linear.ts` lives in
  `tests-new/_support/fixtures/lifecycle/` with a re-export shim at the old path;
  the still-live old smoke test and the behavioral-dsl runtime-path consumer stay
  green through it; the rest of `tests/fixtures/lifecycle/` is untouched (deferred).
- `tests-new/_migration/relocation-map.json` has all 36 runner rows and
  `bun run check:import-parity` passes for every relocated runner file (same
  `src/` symbol-set, resolves, no `tests/` import).
- Every old runner `test` file is unconditional `.skip` with a `// MIGRATED →`
  marker (kept on disk, D2); no `skipIf` survives on a migrated old file.
- `tests-new/_migration/ledger.md` has a `## Relocated — runners/** (parent U11)`
  section: one `port` row per old file, all cases enumerated, regression-pins
  preserved, with the fixture move noted as a D13 `_support` account.
- `scripts/skip-migrated-u11.sh` exists, is idempotent, and was used for the skip
  pass.
- No `src/` file changed; no `.test-d.ts` work (there are none under `runners/**`).
- `bun run check` green except for the documented, pre-existing 5 `ENOENT`
  fixture failures under gitignored `.orch/` (unrelated to this phase).
- `tests-new/_migration/__tests__/snapshot.test.ts` green (frozen baseline
  untouched). `bun run typecheck` + `bun run lint` clean (no new warnings
  introduced by the move).
```
