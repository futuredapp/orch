---
status: active
type: refactor
title: "refactor: Phase 13 (U13) — relocate cli/observability/e2e + .test-d.ts type-tests + classify tmux adapter/harness + close the U10–U13 demotes; surface the group-B render-leftover gap"
created: 2026-06-06
parent: docs/plans/2026-06-05-001-refactor-testing-strategy-restructure-plan.md
depth: deep
---

# refactor: Phase 13 (U13) — relocate `cli/**` · `observability/**` · remaining `e2e/**` · `.test-d.ts` type-tests · classify tmux adapter/harness · close the `→ U10–U13` demotes

> **This is a phase plan.** It elaborates **U13** of the parent
> [`docs/plans/2026-06-05-001-refactor-testing-strategy-restructure-plan.md`](2026-06-05-001-refactor-testing-strategy-restructure-plan.md)
> (Phase group C — "Migrate the rest of the repo", the **last** relocation phase
> before U14 reconciliation). It honours every decision in the parent §3 (D1–D15)
> and the §8 script ladder; it does **not** relitigate them. Phases 1–12 are
> complete (see [`docs/plans/phase-summaries.md`](phase-summaries.md)); group B
> (the two-pane behavioural surface) re-derived the bulk of the two-pane tests,
> and U10/U11/U12 relocated `core`/`runners`/`services-state-validators-workflows-
> config-codegen-hosts(non-two-pane)` reusing the U10 import-parity guard.

---

## 1. Summary

U13 is the **terminal relocation phase** (parent D1: relocation, not
re-derivation). It closes out the four module clusters the parent's U13 row
names — `cli/**`, `observability/**`, the remaining non-tier-4 `e2e/**`, and the
deferred `.test-d.ts` **type-tests** — plus the two classification jobs the
parent assigned it (the tmux **adapter/harness** tests: `services/tmux/**`,
`real-tmux/**`) and the `tests/unit/helpers/**` accounting. Because it is the
**last** of U10–U13, it is also the **last home** for the `demote→unit` /
`demote→integration` cases that group-B phases (U5–U8) explicitly routed to
"`→ U10–U13`" — those are non-rendering logic/persistence tests that relocate as
plain `unit`/`integration` tests, and U14 (reconciliation) cannot migrate them.

The mechanical core (cli/observability/e2e/type-tests/stragglers) reuses the
proven U10/U11/U12 recipe verbatim: copy each old file into its mirror under
`tests-new/{unit,integration,e2e}/<src-mirror>/`, rewrite cross-tree helper
specifiers to the `@orch/test/*` alias, preserve capability gates (`skipIf`)
**verbatim** in the new copy, wrap the old file unconditional `.skip` with a
`// MIGRATED →` marker, and ledger it at case granularity. **No behavioural
rewrite.** No new machinery — the import-parity guard, the new-tree buckets, and
the skip-script pattern all already exist.

**What makes U13 more than a `cp` — and why it is `deep`, not `standard`:**

1. **Two genuine classification decisions** the parent left open (PD3, PD4): the
   tmux adapter/harness tests must be split **`tmux-argv` vs `integration`**
   explicitly, and the type-tests + behavioral-dsl-helper tests need homes where
   the gate actually runs/typechecks them.
2. **The `→ U10–U13` demotes** (PD5): seven group-B-deferred files whose
   non-rendering cases relocate here. Some are *pure* demotes (relocate + skip the
   file); others are *mixed* (relocate the demoted case, file **stays LIVE**
   because its render cases belong to group-B closeout — the D15
   green-but-incomplete rule).
3. **A material reality the parent's U13 row did not anticipate (§9, the central
   finding).** Planning-time inspection of the frozen baseline shows a large body
   of **still-live `two-pane/**` host files** whose remaining cases are genuine
   **rendering/projection** behaviour, *not* relocatable logic. Re-deriving them is
   group-B work (model/screen scenarios), which D1 forbids U13 from doing as a
   "relocation". U13 **does not silently absorb them**; it inventories them against
   the frozen baseline and surfaces them as a **blocking precondition for U14**,
   with a recommended group-B-closeout resolution.

**Scope guard.** U13 relocates/classifies the files enumerated in §4 and closes
the §4 Category-A demotes. It **excludes** all group-B render re-derivation
(§9). It is the phase that must leave the frozen baseline (parent D12) drained to
**only** the explicitly-deferred group-B render leftovers — so the U13 exit state
makes the remaining gap *exactly* visible and countable for U14.

---

## 2. Problem frame & goals

**Problem.** The parent's frozen baseline (D12) — 355 `test` + 6 `type-test`
entries — must reach zero unaccounted entries across U10–U13 so U14 can prove
completeness. U10–U12 drained `core`/`runners`/`services`-cluster (≈165 files).
U13 must drain everything that remains **and is a relocation**: cli,
observability, e2e, the type-tests, the tmux adapter/harness classification, the
`unit/helpers` tests, the miscellaneous stragglers, and the group-B `→ U10–U13`
demotes. Whatever U13 cannot legitimately relocate (group-B render leftovers)
must be **named and counted**, not left as a silent hole U14 trips over.

**Goals (in priority order).**
1. **Parity** — every relocated file imports the **same `src/` symbols** as its
   baseline original and resolves them on disk; no `tests-new → tests` import
   survives (parent R10/D13), enforced by the U10 guard (`check:import-parity`) on
   every `bun run check`.
2. **Honest, complete accounting** — every old file U13 touches ends fully `.skip`
   with a `// MIGRATED →` marker (or its cases ledgered if it stays LIVE), keyed to
   the frozen baseline; every `type-test` entry is relocated to where `tsc`
   typechecks it; every tmux adapter/harness file is *classified*, never dropped.
3. **Two clean classification calls** — `tmux-argv` vs `integration` for the tmux
   tests (PD3); the right gate-visible home for type-tests and behavioral-dsl-helper
   tests (PD4) — each with a stated rule, not an ad-hoc per-file guess.
4. **The `→ U10–U13` demotes land in their last home** (PD5) — pure demotes
   relocate + skip; mixed-case files relocate the demoted case and stay LIVE with a
   ledger row, never a premature full skip (D15).
5. **The group-B render gap is surfaced, counted, and blocking** (§9) — U13 does
   **not** absorb re-derivation (D1/R3); it leaves U14 an exact, baseline-grounded
   list and a recommended closeout path.
6. **Shims die only when truly dead** — U13 rewrites its own `make-step-entry` /
   `fake-host` / `real-tmux` consumers to `@orch/test/*`; it deletes a shim **only**
   if U13 was its last live consumer (the `make-step-entry` shim is **not** dead
   after U13 — two live two-pane consumers remain; see PD6).

**Non-goals.**
- Not touching any `src/` file.
- Not re-deriving, merging, or "improving" any case. Pure relocations port 1:1;
  demotes relocate the *existing* case verbatim into a cheaper category.
- Not authoring any new `model`/`screen`/`full-host`/`lifecycle` **scenario**.
  Closing the group-B render leftovers (§9) is **out of scope** — it is group-B
  re-derivation, not a U13 relocation.
- Not deleting the `make-step-entry` shim (PD6 — live two-pane consumers remain).
- Not regenerating the frozen baseline (parent D12 hazard).
- Not chasing the 5 pre-existing `ENOENT` fixture failures under gitignored
  `.orch/` ([[orch-test-fixtures-under-gitignored-orch]]).

---

## 3. Key decisions (phase-local, inheriting parent D1–D15)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| **PD1** | **No new machinery** | Reuse `tests-new/_migration/import-parity.ts` + `check:import-parity`, `test:new-unit`/`test:new-int`/`test:new-e2e`, `relocation-map.json`, `ledger.md`, and the `scripts/skip-migrated-*.sh` pattern. Add only `scripts/skip-migrated-u13.sh` (mirrors `skip-migrated-u12.sh`). | U10 built the guard "once, reused by U11–U13" (parent PD4); U11/U12 confirmed reuse. Re-deciding any of it is relitigation. |
| **PD2** | **Import-rewrite rules (depth-preserving)** | `tests/<x>` → `tests-new/<x>` preserves relative depth, so every `../../../src/...` import is **unchanged**. Only cross-tree helper specifiers change, all to the `@orch/test/*` alias already pointed at `_support/`: `helpers/make-step-entry.ts` → `@orch/test/make-step-entry.ts` (6 cli/obs files); `helpers/fake-host.ts` → `@orch/test/fake-host.ts` (1 e2e file); `helpers/real-tmux/index.ts` → `@orch/test/real-tmux/index.ts` (status-real + builtin-phased-build + the tmux/real-tmux classification set); `helpers/type-assertions.ts` → `@orch/test/type-assertions.ts` (6 type-tests). | The depth-invariance holds for every prior relocation (U2/U10/U11/U12). The four `@orch/test/*` targets all already exist in `_support/` (moved by U1/U2/U10). |
| **PD3** | **tmux adapter/harness classification (`tmux-argv` vs `integration`)** | Apply the parent §6 decision rule per file: **argv/escaping/no-tmux** → `tests-new/tmux-argv/` (plain `it()`, the `tmux-argv` category — RealTmuxService + FakeProcessService); **boots real tmux** → `tests-new/integration/services/tmux/**` or `tests-new/integration/real-tmux/**` keeping `skipIf` **verbatim**. The real-tmux **harness internals** tests (`real-tmux-harness/{pane-handle,socket-allocation}`) test `_support/real-tmux/**` infrastructure → `tests-new/integration/real-tmux/` (they exercise socket allocation / pane handles, the U2 driver substrate). | Parent U13 row + §6 + §7 note explicitly require an *explicit* classification, "classified, not dropped". The fake-driven unit tmux files match the §9.3 `tmux-argv` worked example; the `*.real.*`/skipIf files are genuine real-tmux integration. |
| **PD4** | **Type-test + behavioral-dsl-helper homes (gate-visible)** | The 6 `core/**` `.test-d.ts` files → `tests-new/unit/core/**` (mirror), import rewritten to `@orch/test/type-assertions.ts`. They are typechecked because `tests-new` is in `tsconfig` `include` (parent D11) — verify a deliberate `@ts-expect-error` removal goes red. The 3 `tests/unit/helpers/behavioral-dsl/*.test.ts` → `tests-new/unit/support/behavioral-dsl/**`, imports rewritten to `@orch/test/behavioral-dsl/...`, so `test:new-unit` runs them. | Parent: "`.test-d.ts` files land where `tsconfig` typechecks them"; the behavioral-dsl-helper tests test `_support` infra (moved U2) and must stay on the gate. `tests-new/unit/support/` keeps them under the existing `test:new-unit` bucket without inventing a category. |
| **PD5** | **The `→ U10–U13` demotes land here (last home), per-case** | Relocate the demoted cases group-B routed to "`→ U10–U13`" (ledger rows) as **plain** `tests-new/unit` / `tests-new/integration` tests (the case body verbatim — a demote moves *category*, not *content*). **Pure-demote** files (every case demoted) are then fully `.skip` + `// MIGRATED →`. **Mixed** files (some cases are group-B render, §9) relocate only the demoted case, get a per-case ledger row, and **stay LIVE** (D15 — no premature full skip; reconcile rule 3 forbids a marker to a non-existent target). | These were explicitly assigned to "U10–U13"; U13 is the last such phase, so it is their only remaining home before reconciliation. U14 reconciles, it does not migrate. Including them is *required* for U14 to pass; excluding render re-derivation honours D1/R3. |
| **PD6** | **Shim lifecycle** | Rewrite U13's own consumers to `@orch/test/*`. **Delete** a `_support` shim **iff** U13 skips/relocates its last live old consumer. The `make-step-entry` shim is **kept** — after U13, `tests/unit/hosts/two-pane/steps-view/steps-view-model.test.ts` and `…/subworkflow-parallel-suppression.test.ts` (group-B-render-LIVE / PD5-mixed) still import it. The `fake-host` / `real-tmux` shims are likewise kept unless a run-time grep proves zero live consumers. | Parent D13/R11: a shim dies only when its last old consumer skips. Two live two-pane consumers of `make-step-entry` survive U13 → shim stays (handed to the §9 closeout). |
| **PD7** | **Old-file disposition** | `scripts/skip-migrated-u13.sh` (idempotent, mirrors `skip-migrated-u12.sh`): wrap top-level `describe(`→`describe.skip(`, `it(`/`test(`→`.skip(`, **convert `describe.skipIf(...)`→`describe.skip`** on the old copy (R13 — so U14 reconcile reads *migrated*, not *capability-skipped*), prepend `// MIGRATED → <new path> (parent U13)`. The **new** copy keeps `skipIf` verbatim (legitimate gating, D8). **Hard exclusions baked into the globs:** never touch any still-LIVE group-B file (§9), the `make-step-entry`/`fake-host`/`real-tmux` shims, or any `_support` file. | Parent D2/D15 + R13. A script keeps the ~60-file edit mechanical and uniform ([[prefer-scripts-over-complex-git]]). |
| **PD8** | **The group-B render leftovers are surfaced, not absorbed** | U13 inventories every still-LIVE `two-pane/**` file (and the 5 `integration/hosts/two-pane-*.test.ts` files U12 flagged) against the frozen baseline, classifies each as **Category A** (demoted → relocated by U13) or **Category B** (render/projection → group-B closeout), and records Category B in §9 as a **blocking U14 precondition** with a recommended resolution. No Category-B file is relocated, skipped, or re-derived by U13. | Parent §3.7 (anti-expansion) + D1/R3. Silently relocating render tests would mis-categorise two-pane tests into `tests-new/{unit,integration}`; silently skipping them is the D15 green-but-incomplete trap; silently ignoring them hides a U14-fatal gap. Flagging is the honest middle. |

---

## 4. Inventory (from the frozen baseline, parent D12)

> The implementer **must** confirm every count and classification against
> `tests-new/_migration/baseline.json` at run time (the baseline is the source of
> truth, not this prose) and re-run the per-cluster `import.meta.dir`/`__dirname`
> grep before each copy (the U11/U12 runtime-path lesson).

### 4.1 Mechanical relocations (parent-named U13 scope)

**`cli/**` — 13 unit + 18 integration (31).** `tests/{unit,integration}/cli/**`
→ `tests-new/{unit,integration}/cli/**`.
- Cross-tree imports: `make-step-entry` in `unit/cli/format`, `unit/cli/logs-command`,
  `integration/cli/run-resume-cycle`, `integration/cli/commands/{logs-old-and-new-runs,status}`
  (→ `@orch/test/make-step-entry.ts`). No other cross-tree helper in the cli cluster
  except `fake-host` (none here — it is in e2e, see 4.1 e2e).
- **Runtime-path trap (PD2/U11 lesson):** five integration cli files read via
  `import.meta.dir`/`__dirname` — `commands/init-e2e`, `interactive-plain-error`,
  `main-dispatch`, `single-pane-no-terminal-clear`, `unknown-flag`. Confirm each
  resolves a path that is **invariant to file location** (e.g. a built `dist`/CWD
  path, a `tmpdir()` scratch, or `src/` via a depth-preserved `../`), and **run each
  relocated file green** — the parity guard does not see runtime reads.
- Capability gates: preserve any `skipIf` verbatim in the new copy.

**`observability/**` — 7 unit + 6 integration (13).**
`tests/{unit,integration}/observability/**` → mirror.
- Cross-tree imports: `make-step-entry` in `unit/observability/status-pane`
  (→ `@orch/test/make-step-entry.ts`); `real-tmux/index` in
  `integration/observability/status-real.integration` (→ `@orch/test/real-tmux/index.ts`,
  keep its `skipIf`).
- Gated/real files: `session-logger.e2e`, `session-logger-*.integration`,
  `status-real.integration` — preserve gating verbatim; classify `.e2e`-suffixed
  files as integration-or-e2e per their existing location (keep the directory the
  baseline recorded; do not re-tier).

**Remaining `e2e/**` (non-tier-4) — 4 files.**
`tests/e2e/{cli/orch-run, resume-real-claude, steps-tui-e2e, workflows/builtin-phased-build}`
→ `tests-new/e2e/**` (mirror). All four are env-gated (`RUN_REAL_E2E` /
`RUN_REAL_CLAUDE` / `RUN_REAL_TMUX_E2E`); `test:new-e2e` is env-gated like the old
e2e bucket. Cross-tree: `fake-host` in `resume-real-claude` (→ `@orch/test/fake-host.ts`);
`real-tmux/index` in `workflows/builtin-phased-build` (→ `@orch/test/real-tmux/index.ts`).
- The three `tier-4/*` e2e files are **already migrated** (U9 → `full-host:real-agent`);
  do **not** re-touch them.

**`.test-d.ts` type-tests — 6 (all `core/`).**
`tests/unit/core/{ask-types, run-workflow-typing, step-runfn-typed-vars,
workflow-typing}.test-d.ts` + `core/prompt-file/{promptfile-registry,
template-vars}.test-d.ts` → `tests-new/unit/core/**`. Each imports
`type-assertions` → `@orch/test/type-assertions.ts` (already in `_support`). These
are the U10-deferred type-tests; they are `type-test` baseline entries.

**`tests/unit/helpers/behavioral-dsl/**` — 3.**
`{invariants, pane-matchers, snapshot}.test.ts` → `tests-new/unit/support/behavioral-dsl/**`,
imports rewritten from `helpers/behavioral-dsl/...` → `@orch/test/behavioral-dsl/...`.

**Miscellaneous stragglers (confirm against baseline — drain to zero).**
- `tests/unit/barrel.test.ts` → `tests-new/unit/barrel.test.ts` (`test`).
- `tests/integration/examples/subworkflows-smoke.test.ts` →
  `tests-new/integration/examples/` (`test`).
- `tests/integration/tests-setup/cleanup-reaper.real.integration.test.ts` →
  `tests-new/integration/real-tmux/` (real-tmux reaper; keep gating) — classify with
  PD3.
- `tests/unit/setup/reap-test-sockets.test.ts` → `tests-new/unit/support/` (tests a
  setup helper).
- `tests/setup/{cleanup-stale-tmux,reap-test-sockets}.ts` are the **2 `setup`**
  baseline entries (the bunfig preload) — accounted as a **D13 `_support` move**, not
  a relocated test (confirm whether U1/U2/U3 already moved the active preload to
  `_support/setup/`; if a live old copy remains, move-with-shim per D13). **Not test
  relocations** — record as an infra note, not `port` rows.

### 4.2 Classification cluster — tmux adapter/harness (PD3)

| Old file | Boots real tmux? | Target (classify) |
|---|---|---|
| `unit/services/tmux/{tmux-service,has-session-server}.test.ts` | no (FakeProcessService) | `tests-new/tmux-argv/` (argv/adapter) — *confirm argv-shaped* |
| `unit/services/tmux/{external-mouse-events,session-init,tmux-service-window}.test.ts` | no | `tmux-argv` **or** `tests-new/unit/services/tmux/` — argv/escaping → `tmux-argv`; broader fake-driven service logic → `unit/services/tmux` (per-file call, state the choice in the ledger) |
| `integration/services/tmux/tmux-integration.test.ts` | no (FakeProcessService) | `tmux-argv` (no real tmux) **or** `tests-new/integration/services/tmux/` — classify by whether it asserts argv vs broader behaviour |
| `integration/services/tmux/tmux-real.integration.test.ts` | **yes** (skipIf) | `tests-new/integration/services/tmux/` (keep `skipIf`; `real-tmux/index` → `@orch/test/real-tmux/index.ts`) |
| `integration/real-tmux/*.test.ts` (6: `agent-handle`, `predictable-fake-{f1,f2,ink,three-step}`, `teardown-leak-guard`) | **yes** (skipIf) | `tests-new/integration/real-tmux/` (keep gating; rewrite real-tmux helper imports to `@orch/test/real-tmux/*`) |
| `unit/hosts/two-pane/real-tmux-harness/{pane-handle,socket-allocation}.test.ts` | socket/pane infra | `tests-new/integration/real-tmux/` (harness-internals tests of the `_support/real-tmux/**` substrate; **not** two-pane render — exempt from §9) |

> **Why the `real-tmux-harness/**` pair is U13, not group B (§9).** Despite their
> `two-pane/` path, they test the **real-tmux harness infrastructure** (socket
> allocation, pane handle) that U2 moved to `_support/real-tmux/**` — pure infra,
> "passes if the pane is empty" is *false* for them (they assert socket/handle
> mechanics, not rendering). They are a relocation/classification, not a render
> re-derivation. State this explicitly in the ledger so U14 does not mistake them
> for group-B leftovers.

### 4.3 Category-A demotes — `→ U10–U13`, relocate here (PD5)

> Confirm each against the ledger (`tests-new/_migration/ledger.md`) and the
> baseline at run time. **Pure** = every case in the file is demoted (relocate +
> fully `.skip`). **Mixed** = only some cases demote; relocate those, **file stays
> LIVE** (its render cases → §9), per-case ledger rows.

| Old file | Demoted case(s) → target | Pure/Mixed | New home |
|---|---|---|---|
| `unit/hosts/two-pane/steps-view/tui-overlay.test.ts` | all 11 `parse/serializeTuiOverlayLine` codec cases → `demote→unit` | **Pure** | `tests-new/unit/hosts/two-pane/tui-overlay.test.ts` (pure codec; mirror `src/hosts/two-pane/**` overlay codec) |
| `integration/hosts/two-pane/tier-1/auto-stop.real.integration.test.ts` | 4 stop-channel coordination cases → `demote→integration` | **Pure** | `tests-new/integration/hosts/two-pane/auto-stop.test.ts` (host-coordinator + fakes; drop the real-tmux boot — the demoted assertions are stop-channel/disk, not pane bytes) |
| `integration/lifecycle/progression.per-step-artifacts-land-on-disk.behavioral.real.test.ts` | disk-artifact case → `demote→integration` | **Pure** (confirm) | `tests-new/integration/` (per-step artifact persistence) |
| `integration/lifecycle/resume.cached-steps-replay-with-cached-glyph.behavioral.real.test.ts` | resume-orchestration case → `demote→integration` | **Pure** (cached-glyph render overlaps U8; orchestration dominant) | `tests-new/integration/` (resume orchestration) |
| `integration/lifecycle/command.output-streams-to-right-pane-and-exit-code-recorded.behavioral.real.test.ts` | disk-stream + `state.json` exitCode case → `demote→integration` | **Pure** (the visible-command-output-to-pane behaviour was never a separate old case — note as a future command-step-render gap, non-blocking) | `tests-new/integration/` (command persistence) |
| `unit/hosts/two-pane/steps-view/subworkflow-parallel-suppression.test.ts` | 1 real-`parallel()` persisted-records case → `demote→integration` | **Pure** | `tests-new/integration/` (execution/persistence; rewrite `make-step-entry` → `@orch/test/*`) |
| `unit/hosts/two-pane/steps-view/adaptive-columns.test.ts` | `COLUMN_THRESHOLDS` policy case → `demote→unit` | **Mixed** (other cases are adaptive-column **render** → §9) | relocate the policy case → `tests-new/unit/hosts/two-pane/adaptive-columns-thresholds.test.ts`; **file stays LIVE**, per-case ledger row |

### 4.4 Explicit exclusions (untouched by U13)

- All Category-B group-B render/projection leftovers (§9) — flagged, not relocated.
- The 5 `integration/hosts/two-pane-*.test.ts` files (U12 PD8) — §9, group-B closeout.
- Anything already `.skip` with a `// MIGRATED →`/`// COVERED BY →`/`// DROPPED →`
  marker (U4–U12).
- The `make-step-entry` shim (live two-pane consumers remain — PD6).

---

## 5. Output structure

```
tests-new/
  unit/
    cli/**                          # NEW — 13 (mirror src/cli)
    observability/**                # NEW — 7
    core/*.test-d.ts                # NEW — 6 type-tests (typechecked via tsconfig include, D11)
    core/prompt-file/*.test-d.ts
    support/
      behavioral-dsl/**             # NEW — 3 helper tests (→ @orch/test/behavioral-dsl/*)
      reap-test-sockets.test.ts     # NEW — setup-helper test
    services/tmux/**                # NEW — only the unit tmux files classified as integration-logic (PD3)
    hosts/two-pane/
      tui-overlay.test.ts           # NEW — demote→unit (Category A)
      adaptive-columns-thresholds.test.ts  # NEW — demote→unit (Category A, mixed-file case extract)
    barrel.test.ts                  # NEW — straggler
  tmux-argv/
    <classified unit tmux argv tests>   # NEW (PD3) — argv/escaping files
  integration/
    cli/**                          # NEW — 18
    observability/**                # NEW — 6 (gating preserved)
    services/tmux/tmux-real.integration.test.ts   # NEW — real tmux (skipIf)
    real-tmux/**                    # NEW — 6 + harness-internals 2 + cleanup-reaper (PD3, gating preserved)
    examples/subworkflows-smoke.test.ts           # NEW — straggler
    hosts/two-pane/auto-stop.test.ts              # NEW — demote→integration (Category A)
    <per-step-artifacts / resume / command / subworkflow-parallel demotes>  # NEW — Category A
  e2e/
    cli/orch-run.test.ts ; resume-real-claude.test.ts ; steps-tui-e2e.test.ts
    workflows/builtin-phased-build.e2e.test.ts    # NEW — 4 (env-gated)
  _migration/
    relocation-map.json             # + U13 old→new rows (appended)
    ledger.md                       # + "Relocated/Classified — cli/observability/e2e/type-tests/tmux/demotes (parent U13)"
                                    #   + "Open accounting gap — group-B render leftovers (for U14)" prose
scripts/
  skip-migrated-u13.sh              # NEW (PD7), mirrors skip-migrated-u12.sh
tests/
  {unit,integration}/{cli,observability}/**       # all .skip + // MIGRATED → (kept on disk, D2)
  e2e/{cli,resume-real-claude,steps-tui-e2e,workflows}  # .skip + marker
  unit/core/*.test-d.ts ; unit/helpers/behavioral-dsl/**  # .skip + marker
  {unit,integration}/services/tmux/** ; integration/real-tmux/**  # .skip + marker (classified copies live in new tree)
  helpers/make-step-entry.ts        # KEPT shim (live two-pane consumers remain — PD6)
  **/two-pane/** (Category B)        # UNTOUCHED, LIVE (→ §9 group-B closeout / U14)
```

The per-unit **Files** sections below remain authoritative; this tree is the
scope shape.

---

## 6. Implementation units

Ordered. Each leaves `bun run check` green (new tests + still-running old suite).
The per-file acceptance gate is the U10 **parity guard** (`check:import-parity`
against the file's baseline original), not merely "`check` is green".

### U13.1 — Relocate the `.test-d.ts` type-tests (6, `core/**`)

**Goal.** Move the 6 deferred type-tests into `tests-new/unit/core/**` where the
`tsc --noEmit` gate (parent D11) typechecks them, proving the negative
`@ts-expect-error` assertions still bind.

**Requirements.** Parent D11, D13; PD2, PD4.

**Dependencies.** None (`type-assertions` already in `_support`).

**Files (create).** `tests-new/unit/core/{ask-types,run-workflow-typing,
step-runfn-typed-vars,workflow-typing}.test-d.ts` +
`tests-new/unit/core/prompt-file/{promptfile-registry,template-vars}.test-d.ts`.

**Approach.** Byte-copy; rewrite `helpers/type-assertions.ts` →
`@orch/test/type-assertions.ts`; `src/` imports unchanged (depth preserved).

**Patterns to follow.** Parent D11 `scenario.test-d.ts` precedent; U10's deferral
note ("`.test-d.ts` deferred to U13").

**Test scenarios.** *Test expectation: relocation parity (type-level).*
- `bun run typecheck` compiles the relocated type-tests; removing one
  `@ts-expect-error` locally makes `typecheck` go **red** (the guarantee is real
  only if the gate enforces it). *(critical)* `Covers D11.`
- Import-parity guard passes (same `src/` symbol-set; resolves; no `tests/`
  import). *(critical)*

**Verification.** `bun run typecheck` green with the 6 type-tests in the new tree;
deliberate-violation red confirmed; old copies untouched until U13.8 skips them.

---

### U13.2 — Relocate `cli/**` (13 unit + 18 integration)

**Goal.** Move the 31 cli test files into their mirror, rewrite the 5
`make-step-entry` cli consumers, handle the 5 `import.meta.dir` runtime-path
files, preserve gating, prove green.

**Requirements.** Parent D1, D3, D8, D13; PD2.

**Dependencies.** None.

**Files (create).** `tests-new/unit/cli/**` (13, incl. `commands/{init-templates,
scaffold}`), `tests-new/integration/cli/**` (18, incl. `commands/**`).

**Approach.** Byte-copy; rewrite `make-step-entry` specifiers (`format`,
`logs-command`, `run-resume-cycle`, `commands/logs-old-and-new-runs`,
`commands/status`) → `@orch/test/make-step-entry.ts`. **Before copying, grep the
cluster for `import.meta.dir`/`__dirname`** (5 hits) and, for each, confirm the
resolved path is location-invariant or repoint it; **run each relocated runtime-path
file green** (parity guard blind to runtime reads — PD2). Preserve `skipIf` verbatim.

**Patterns to follow.** U12.5's PD4 runtime-fixture handling; U10/U11 byte-faithful
relocation.

**Test scenarios.** *Test expectation: relocation parity.*
- `bun run test:new-unit` + `bun run test:new-int` run the relocated cli tests
  green. *(happy)*
- The 5 `import.meta.dir` cli files resolve their runtime paths from the new
  location and pass. *(critical — runtime-path trap)* `Covers R10 (runtime analogue).`
- Import-parity guard passes for all 31 files. *(critical)* `Covers R10.`

**Verification.** cli rows green under `test:new-unit`/`test:new-int`; parity guard
green; the 5 runtime-path files proven green from the new location.

---

### U13.3 — Relocate `observability/**` (7 unit + 6 integration)

**Goal.** Move the 13 observability files, rewrite the `make-step-entry` and
`real-tmux` consumers, preserve gating on the real/e2e files, prove green.

**Requirements.** Parent D1, D3, D8, D13; PD2.

**Dependencies.** None.

**Files (create).** `tests-new/unit/observability/**` (7),
`tests-new/integration/observability/**` (6).

**Approach.** Byte-copy; rewrite `status-pane` `make-step-entry` →
`@orch/test/make-step-entry.ts`; `status-real.integration` `real-tmux/index` →
`@orch/test/real-tmux/index.ts` (keep `skipIf`). Preserve gating on
`session-logger-*.integration`, `session-logger.e2e`, `status-real.integration`
verbatim. Keep each file in the directory the baseline recorded (do not re-tier an
`.e2e`-suffixed file out of `integration/`).

**Test scenarios.** *Test expectation: relocation parity.*
- `bun run test:new-unit` + `bun run test:new-int` green for observability;
  gated real/e2e files auto-skip without their capability. *(happy + gating)*
- Import-parity guard passes for all 13 files. *(critical)* `Covers R10.`

**Verification.** observability rows green; gated files auto-skip; parity guard green.

---

### U13.4 — Relocate the remaining `e2e/**` (4, non-tier-4)

**Goal.** Move the 4 remaining e2e files into `tests-new/e2e/**`, rewrite
`fake-host`/`real-tmux` specifiers, preserve env-gating verbatim, prove the gated
files auto-skip on the normal gate.

**Requirements.** Parent D1, D8, D13; PD2.

**Dependencies.** None.

**Files (create).** `tests-new/e2e/cli/orch-run.test.ts`,
`tests-new/e2e/resume-real-claude.test.ts`, `tests-new/e2e/steps-tui-e2e.test.ts`,
`tests-new/e2e/workflows/builtin-phased-build.e2e.test.ts`.

**Approach.** Byte-copy; rewrite `resume-real-claude` `fake-host` →
`@orch/test/fake-host.ts`; `builtin-phased-build` `real-tmux/index` →
`@orch/test/real-tmux/index.ts`. Preserve the `RUN_REAL_E2E` / `RUN_REAL_CLAUDE` /
`RUN_REAL_TMUX_E2E` gates verbatim. **Do not** re-touch the already-migrated
`tier-4/*` files.

**Test scenarios.** *Test expectation: relocation parity (env-gated).*
- `bun run test:new-e2e` collects the 4 files; all auto-skip without their env
  flags (normal gate). *(gating)*
- With the env flag + CLI present, each runs from the new location (manual/release
  check; not on the normal gate). *(happy — release)*
- Import-parity guard passes for all 4 files. *(critical)* `Covers R10.`

**Verification.** `test:new-e2e` green (auto-skipped) on the normal gate; parity
guard green; gates preserved byte-for-byte.

---

### U13.5 — Classify & relocate the tmux adapter/harness tests (PD3)

**Goal.** Make the explicit `tmux-argv` vs `integration` classification call for
every tmux adapter/harness test (the parent's named U13 job), relocate each to its
classified home keeping real-tmux gating verbatim, and record the classification
rationale per file in the ledger.

**Requirements.** Parent §6, §7 note, §14; D5, D8, D13; PD3.

**Dependencies.** None (`real-tmux/**` already in `_support` from U2).

**Files (create).** Per the §4.2 table: argv-shaped unit tmux files →
`tests-new/tmux-argv/**`; broader fake-driven unit/integration tmux logic →
`tests-new/unit/services/tmux/**` / `tests-new/integration/services/tmux/**`;
`tmux-real.integration` + the 6 `real-tmux/*` + the 2 `real-tmux-harness/*` +
`cleanup-reaper.real.integration` → `tests-new/integration/real-tmux/**` (or
`integration/services/tmux/` for the service-specific one), all keeping `skipIf`.

**Approach.** For each file apply the §6 decision rule: *argv/escaping/no real
tmux* → `tmux-argv`; *boots real tmux* → `integration/**` with gating preserved.
Rewrite `real-tmux/index` imports → `@orch/test/real-tmux/index.ts`. **State the
classification choice + reason in each ledger row** (parent "classified, not
dropped"). The `real-tmux-harness/{pane-handle,socket-allocation}` pair is infra,
not render — explicitly note it is exempt from §9 (see §4.2 callout).

**Execution note.** Run the real-tmux-gated relocations on a tmux-capable box (or
confirm they auto-skip cleanly off the gate) before skipping the old copies — these
are the historically-flaky files; verify zero socket/puppet residue post-run
([[real-tmux-suite-flakiness-root-cause]]).

**Test scenarios.** *Test expectation: relocation parity + explicit classification.*
- The argv-classified files run under `bun run test:two-pane:tmux-argv` (or
  `test:new-unit`) at unit speed, no tmux booted. *(happy)*
- The real-tmux-classified files auto-skip off the normal gate and (on a capable
  box) run green with zero leaked sockets/puppets. *(gating + critical)*
  `Covers R1.`
- Import-parity guard passes for every relocated tmux file. *(critical)* `Covers R10.`
- Every tmux adapter/harness baseline entry ends `classified` (relocated), **none
  dropped**. *(coverage)* `Covers parent §7 note.`

**Verification.** Every tmux adapter/harness file relocated to a classified home
with a ledger reason; gating preserved; parity guard green; no real-tmux flake.

---

### U13.6 — Relocate `unit/helpers/behavioral-dsl/**` + stragglers

**Goal.** Move the 3 behavioral-dsl-helper tests to a gate-visible home, relocate
the miscellaneous stragglers, and account the `setup` preload entries as a D13
infra move (not test relocations).

**Requirements.** Parent D12, D13; PD2, PD4.

**Dependencies.** None.

**Files (create).** `tests-new/unit/support/behavioral-dsl/{invariants,
pane-matchers,snapshot}.test.ts`; `tests-new/unit/barrel.test.ts`;
`tests-new/integration/examples/subworkflows-smoke.test.ts`;
`tests-new/unit/support/reap-test-sockets.test.ts`;
`cleanup-reaper.real.integration` handled in U13.5.

**Approach.** Byte-copy; rewrite `helpers/behavioral-dsl/...` →
`@orch/test/behavioral-dsl/...`. For the 2 `setup` baseline entries
(`tests/setup/{cleanup-stale-tmux,reap-test-sockets}.ts`): confirm whether the
active bunfig preload already resolves from `_support/setup/` (U1–U3); if a live old
copy remains, move-with-shim per D13. Record them as an **infra note**, not `port`
rows.

**Test scenarios.** *Test expectation: relocation parity.*
- `bun run test:new-unit` runs the 3 behavioral-dsl-helper tests + barrel +
  reap-test-sockets green; `test:new-int` runs the examples smoke green. *(happy)*
- Import-parity guard passes for all relocated files. *(critical)* `Covers R10.`
- The bunfig preload still loads (no double-preload, no missing preload) after the
  setup accounting. *(integration)*

**Verification.** All stragglers green from the new tree; parity guard green;
preload intact; `setup` entries accounted as infra.

---

### U13.7 — Relocate the Category-A `→ U10–U13` demotes (PD5)

**Goal.** Land the group-B-deferred demoted cases in their **last home**:
pure-demote files relocated + fully skipped; mixed-case files' demoted case
relocated with the file left LIVE and a per-case ledger row.

**Requirements.** Parent D1, D2, D15, R3; PD5, the ledger `→ U10–U13` rows.

**Dependencies.** None (`make-step-entry` reachable via `@orch/test/*`).

**Files (create).** Per §4.3: `tests-new/unit/hosts/two-pane/tui-overlay.test.ts`
(pure); `tests-new/integration/hosts/two-pane/auto-stop.test.ts` (pure);
`tests-new/integration/**` homes for `per-step-artifacts`, `resume.cached-steps`,
`command.output-streams` (persistence), `subworkflow-parallel-suppression` (pure);
`tests-new/unit/hosts/two-pane/adaptive-columns-thresholds.test.ts` (mixed — case
extract; old file stays LIVE).

**Approach.** Relocate the **existing** demoted case body verbatim into the cheaper
category (a demote moves *category*, not *content*). For `auto-stop` and the
`*.behavioral.real` lifecycle demotes, the demoted assertions are stop-channel /
disk / orchestration — drop the real-tmux boot and run them as plain
integration tests with fakes (the cases "pass if the pane is empty", per their
ledger reasons). Confirm each file's pure/mixed status against the baseline **before
skipping**: a pure-demote file is fully `.skip`'d in U13.8; a mixed file (e.g.
`adaptive-columns`) keeps every non-demoted (render) case LIVE for §9 — **never**
skip it (D15). Rewrite `subworkflow-parallel-suppression`'s `make-step-entry` →
`@orch/test/*`.

**Test scenarios.** *Test expectation: relocation parity (category demote).*
- `bun run test:new-unit`/`test:new-int` run each relocated demote green from its
  cheaper category. *(happy)*
- The `tui-overlay` codec, `auto-stop` stop-channel, and `subworkflow-parallel`
  persisted-records cases assert identically to the originals (diff = category +
  import paths + dropped tmux boot). *(critical — no semantic drift)* `Covers R3.`
- The mixed `adaptive-columns` file is **not** skipped (grep: still LIVE, no
  `// MIGRATED →`) and its threshold case is ledgered as relocated. *(scope guard — D15)*
- Import-parity guard passes for every relocated demote. *(critical)* `Covers R10.`

**Verification.** Every Category-A demote green in its new home; pure files queued
for U13.8 skip; mixed files LIVE with per-case ledger rows; parity guard green.

---

### U13.8 — Append the map, skip old files, ledger, shim handling, reconcile-readiness

**Goal.** Append every U13 old→new row to the relocation map, skip the old files
U13 fully migrated, write the ledger section, handle shim lifecycle (PD6), write the
§9 group-B-gap accounting, and confirm U13's exit state is consistent with the
frozen baseline.

**Requirements.** Parent D2, D12, D15, R3, R13; PD1, PD6, PD7, PD8.

**Dependencies.** U13.1–U13.7 (new copies green before the old guard drops).

**Files (create/modify).**
- `tests-new/_migration/relocation-map.json` — append all U13 `{ old, new }` rows.
- `scripts/skip-migrated-u13.sh` — reusable, modelled on `skip-migrated-u12.sh`;
  idempotent; **hard exclusions baked into the globs:** every still-LIVE Category-B
  file (§9), the 5 `two-pane-*` integration files, the mixed-LIVE Category-A files
  (`adaptive-columns`), the `make-step-entry`/`fake-host`/`real-tmux` shims, any
  `_support` file.
- The old U13 `test`/`type-test` files — `.skip` + `// MIGRATED → … (parent U13)`
  via the script (content otherwise unchanged, kept on disk; D2). `describe.skipIf`
  → `describe.skip` on old copies (R13).
- `tests-new/_migration/ledger.md` — new section
  `## Relocated/Classified — cli · observability · e2e · type-tests · tmux · demotes (parent U13)`
  with one row per old file (case enumeration in the "Old case" column, PD-aligned
  with U10–U12), the tmux classification reason per file (PD3), the Category-A demote
  reasons (PD5), the `setup`-preload infra note, **and** the §9 group-B-gap prose.
- Shim handling (PD6): rewrite U13's own consumers; **keep** the `make-step-entry`
  shim (two live two-pane consumers remain); delete `fake-host`/`real-tmux` shims
  **only** if a run-time grep proves zero live old consumers (likely **not** — §9
  files may still import `real-tmux`; default to keep).

**Approach.** Mirror U11/U12 section-header prose. Verify reconcile-readiness by
AST/grep: every old file U13 fully migrated is now unconditional `.skip` (no
surviving non-skipped top-level `it(`/`test(`; no `skipIf` left on a migrated file);
every `MIGRATED →` target exists; every mixed/Category-B file is still LIVE and
**unmarked**. Confirm the frozen baseline is **never** regenerated
(`snapshot.test.ts` green).

**Test scenarios.** *Test expectation: none — mechanical skip + documentation;
acceptance is structural.*
- Every old file U13 fully migrated is unconditional `describe.skip`/`it.skip`
  (grep: no surviving non-skipped top-level `it(`/`test(`; no `skipIf` on a migrated
  file). *(critical — D15)*
- Every `// MIGRATED →` target path exists. *(critical)*
- Mixed Category-A files and all Category-B files carry **no** `// MIGRATED →`
  marker and remain LIVE. *(scope guard — D15/PD8)*
- `relocation-map.json` contains all U13 rows; `check:import-parity` passes over
  them. *(integration)* `Covers R10.`
- The `make-step-entry` shim is **kept** and resolves for its 2 surviving live
  two-pane consumers. *(scope guard — PD6)*
- `snapshot.test.ts` green (frozen baseline untouched). *(critical — D12)*

**Verification.** `bun run check` green except the documented pre-existing 5
`ENOENT` failures; grep confirms no fully-migrated U13 file is left non-skipped or
`skipIf`-gated, and every excluded file is untouched; ledger section + §9 gap
complete; parity guard green; baseline untouched.

---

## 7. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Group-B render leftovers silently absorbed into a "relocation"** (D1/R3 violation), or silently skipped (D15 trap), or silently ignored (U14-fatal hole). | **High** | PD8/§9: U13 inventories every Category-B file against the frozen baseline, relocates **none**, skips **none**, and records them as a **blocking U14 precondition** with a recommended closeout. The U13.8 grep proves they stay LIVE and unmarked. |
| **`import.meta.dir` runtime-path traps** (5 cli files) silently `ENOENT` — the parity guard is blind to runtime reads. | Medium | PD2 + U13.2: per-cluster `import.meta.dir`/`__dirname` grep before copying; **run each runtime-path file green** from the new location as an explicit U13.2 acceptance step (the U11/U12 lesson). |
| **tmux classification wrong** (an argv test landed in `integration` boots no tmux and runs needlessly slow, or a real-tmux test landed in `tmux-argv` flakes/false-greens). | Medium | PD3 + U13.5: apply the §6 decision rule per file, **state the choice + reason in the ledger**, and verify argv files boot no tmux / real files auto-skip-or-run-clean. The `real-tmux-harness` exemption from §9 is stated explicitly. |
| **Type-tests inert** — relocated `.test-d.ts` not actually typechecked (the whole D11 guarantee). | Medium | U13.1: relocate into `tests-new/unit/core/**` (in `tsconfig` include); prove a removed `@ts-expect-error` goes red under `bun run typecheck`. |
| **Premature full skip of a mixed Category-A file** (e.g. `adaptive-columns`) — buries undispositioned render cases (D15 green-but-incomplete). | Medium | PD5 + U13.7/U13.8: relocate only the demoted case; keep the file LIVE; per-case ledger row; the skip-script globs **exclude** mixed files; U13.8 grep asserts they stay LIVE. |
| **`make-step-entry` shim deleted too early**, breaking the 2 live two-pane consumers. | Medium | PD6: shim **kept** (run-time grep confirms `steps-view-model` + `subworkflow-parallel-suppression`-adjacent consumers survive); deletion handed to the §9 closeout. |
| **Mis-resolved `../` after the move** (R10) while looking diff-identical. | Low | U10 parity guard is the per-file acceptance gate; depth is unchanged for every `src/` import (PD2), so the guard mainly catches a stray hand-edit. |
| **Real-tmux relocations re-introduce flake** (leaked sockets/puppets). | Low | U13.5 execution note: run gated relocations on a capable box, verify zero residue ([[real-tmux-suite-flakiness-root-cause]]); the drivers/predictability rules are unchanged (U2). |
| **Re-running the baseline snapshot** against the mutating tree (D12 hazard). | Low | U13 never regenerates `baseline.json`; `snapshot.test.ts` staying green confirms it. |

---

## 8. Definition of Done (U13)

- The cli (31), observability (13), remaining e2e (4), type-tests (6),
  behavioral-dsl-helper tests (3), and stragglers run green from
  `tests-new/{unit,integration,e2e}/**` (`test:new-unit` / `test:new-int` /
  `test:new-e2e`); gated files auto-skip off the normal gate.
- The 6 `.test-d.ts` type-tests are typechecked in the new tree (a removed
  `@ts-expect-error` goes red under `bun run typecheck`).
- Every tmux adapter/harness file (`services/tmux/**`, `real-tmux/**`, the
  `real-tmux-harness` pair, `cleanup-reaper`) is **classified and relocated** to a
  `tmux-argv`/`integration` home with a ledger reason — none dropped; real-tmux
  gating preserved verbatim.
- The Category-A `→ U10–U13` demotes are relocated to their cheaper category;
  pure-demote files are fully `.skip` + `// MIGRATED →`; mixed files
  (`adaptive-columns`) relocate only the demoted case and **stay LIVE** with a
  per-case ledger row.
- `tests-new/_migration/relocation-map.json` has every U13 row and
  `bun run check:import-parity` passes (same `src/` symbol-set, resolves, no
  `tests/` import).
- Every old file U13 **fully** migrated is unconditional `.skip` with a
  `// MIGRATED →` marker (kept on disk, D2); no `skipIf` survives on a migrated old
  file.
- The `make-step-entry` shim is **kept** (PD6); `fake-host`/`real-tmux` shims kept
  unless a run-time grep proves zero live consumers.
- `tests-new/_migration/ledger.md` has the U13 `## Relocated/Classified — …`
  section (one row per old file, cases enumerated, tmux classification reasons,
  demote reasons, `setup`-preload infra note) **and** the §9 group-B-gap prose.
- `scripts/skip-migrated-u13.sh` exists, is idempotent, and excludes every LIVE
  Category-B/mixed file and every shim/`_support` file.
- **§9 group-B render-leftover gap is written, baseline-grounded, and counted** —
  U14's remaining migration surface is now *exactly* the §9 list, nothing hidden.
- No `src/` file changed; `bun run check` green except the documented pre-existing
  5 `ENOENT` fixture failures; `bun run typecheck` + `bun run lint` clean (no new
  warnings); `snapshot.test.ts` green (frozen baseline untouched).

---

## 9. Open accounting gap — group-B render/projection leftovers (blocking U14)

> **The central finding of this plan.** Flagged per parent §3.7 (anti-expansion),
> D1 (relocation ≠ re-derivation), and D12 (whole-tree drain). **Not U13 work** —
> recorded so U14 inherits an exact, counted gap rather than a surprise.

Planning-time inspection of the frozen baseline shows the parent's assumption that
**group B (U4–U9) fully drained the two-pane surface is not yet true.** A
substantial body of `tests/**/two-pane/**` files remains **LIVE** with
**rendering/projection** cases that are *not* relocatable logic — re-deriving them
is group-B work (new `model`/`screen` scenarios), which D1 forbids U13 from doing as
a "relocation". U13 therefore **does not touch them**; it counts them here.

**Category B — render/projection leftovers (need group-B re-derivation, NOT
relocation).** Confirm the full set against the frozen baseline at run time; the
known members from the ledger's deferred rows include:
- `unit/hosts/two-pane/steps-view/steps-view-colors.test.tsx` — per-status render
  (dim-pending / cyan-selection / preview-chevron / interactive / cached /
  stripAnsi-structure), ledgered `→U8/U10–U13` but genuinely render.
- `unit/hosts/two-pane/steps-view/steps-view-banner.test.tsx` — Esc/help keymap
  mechanics + footer truncation + seq-restart timer, ledgered `→U6/U10–U13`.
- `unit/hosts/two-pane/steps-view/adaptive-columns.test.ts` — the adaptive-column
  **render** cases (the `COLUMN_THRESHOLDS` policy case is the U13.7 demote; the rest
  stay LIVE).
- The remaining LIVE `steps-view/*.test.tsx` "spans-files" set group B left live
  (`steps-view`, `steps-view-scroll`, `selection-tracks-view`, `header-rerender`,
  `key-intent-mapping`, `empty-steps-state`, `scroll-no-clear-flicker`,
  `start-steps-view`, etc.) — and the LIVE `integration/hosts/two-pane/**` plumbing
  files (`right-pane-*`, `resume-*-mocked`, `kind-details`, `transcript-replay-memory`,
  `tmux-host-rollup-pane-map`, the `*.real.*` skipIf files, …).

**Plus the 5 `integration/hosts/two-pane-*.test.ts` files** U12 flagged
(`two-pane-mocked`, `two-pane-interactive`, `two-pane-interactive-session-lost`,
`two-pane-failure-and-parallel`, `two-pane-sequential-runs`) — two-pane host
plumbing, still LIVE and undispositioned.

**Recommended resolution (before U14 can reconcile).** Insert a **group-B
closeout** between U13 and U14 (the cleanest fit for the parent's structure — a new
phase, e.g. "U13.5 / group-B closeout", owned by a group-B-literate agent loading
the two-pane scenario DSL, **not** the relocation recipe). For each Category-B
case it must decide:
- **`skip-as-covered`** — its behaviour already exists under `tests-new/{model,
  screen,full-host,lifecycle}/**`; add a ledger row mapping the old case to the
  covering scenario and `.skip` the old file (the cheap, common path where group B
  already re-derived the behaviour).
- **re-derive** — a genuine gap the new DSL does not yet express; author the missing
  `model`/`screen` scenario, then skip (the expensive path the phase summaries
  flagged for `steps-view-colors`/`steps-view-banner`).
- **`drop`** — a vacuous fake-tmux byte assertion or never-executed placeholder
  (per the triage rule), with a reason.

Until that closeout lands, **U14 reconciliation cannot pass** — its frozen-baseline
scan will (correctly) flag every Category-B file as an unaccounted `test` entry.
U13's job is to make that gap **exact and visible**, which the U13 exit state does:
after U13, the only un-`.skip`'d, un-ledgered baseline `test` entries remaining are
precisely the §9 Category-B set (+ the 5 `two-pane-*` files). U14's owner (or the
parent-plan owner) should schedule the closeout accordingly.
