---
status: active
type: refactor
title: "refactor: Phase 12 (U12) — relocate services/state/validators/workflows/config/codegen + non-two-pane hosts into tests-new/{unit,integration}"
created: 2026-06-06
parent: docs/plans/2026-06-05-001-refactor-testing-strategy-restructure-plan.md
depth: standard
---

# refactor: Phase 12 (U12) — relocate `services` (excl. tmux) / `state` / `validators` / `workflows` / `config` / `codegen` + non-two-pane `hosts` into `tests-new/{unit,integration}`

> **This is a phase plan.** It elaborates **U12** of the parent
> [`docs/plans/2026-06-05-001-refactor-testing-strategy-restructure-plan.md`](2026-06-05-001-refactor-testing-strategy-restructure-plan.md)
> (Phase group C — "Migrate the rest of the repo"). It honours every decision in
> the parent §3 (D1–D15) and the §8 script ladder; it does **not** relitigate
> them. Phases 1–11 are complete (see [`docs/plans/phase-summaries.md`](phase-summaries.md));
> group B (the two-pane behavioural surface) is fully migrated, U10 relocated
> `core/**` while building the reusable **import-parity guard**, and U11 relocated
> `runners/**` reusing it verbatim. U12 is the **third** of the four relocation
> phases (U10–U13) and is a near-pure application of the U10/U11 recipe — it builds
> **no new machinery**.

---

## 1. Summary

U12 is a **relocation, not a re-derivation** (parent D1). The seven non-two-pane
module clusters it owns are already plain class/integration tests with fakes at
the `*Service` seam — the parent's `unit`/`integration` categories *are* today's
concepts. The work, per cluster, is mechanical: move each old test file into its
mirror under `tests-new/{unit,integration}/<src-mirror>/`, fix its import paths,
wrap the old file `.skip` with a `// MIGRATED →` marker, and ledger it. **No
behavioural rewrite.** A correct `port` is diff-identical to its original except
for import paths and the `describe`/`it` → `.skip` wrap on the retained old copy
(parent §7 group-C verification).

U12 is materially **simpler than its size suggests** because U10/U11 paid every
one-time cost:

1. **The import-parity guard already exists and is on the gate.** U10 shipped
   `tests-new/_migration/import-parity.ts` + `check:import-parity` (parent R10).
   U12 reuses it verbatim; the `@orch/services/`, `@orch/state/`,
   `@orch/validators/`, `@orch/test/` aliases and the resolution logic already
   cover every import U12 touches. No guard work in U12.
2. **The new-tree buckets already exist.** `test:new-unit` / `test:new-int`
   (parent §8) already run `tests-new/unit` / `tests-new/integration`; U12 only
   adds files under them. No new `package.json` test buckets.
3. **`temp-git-repo.ts` and `ink-frame.ts` are already in `_support/`** (U10/U1,
   shims left at the old paths, parent D13). U12's consumers rewrite their
   specifiers to the `@orch/test/*` alias — no new helper move for these.

What makes U12 **more than a `cp`** is exactly three things, all with proven
precedents:

- **One helper move (`make-step-entry.ts` → `_support/` + shim).** Six `state/**`
  tests import it. Phase 7 explicitly **deferred its move to the state
  relocation** because it has many still-live non-`state` consumers (cli,
  observability — U13; still-live two-pane files) and is path-present in the
  frozen-baseline snapshot scan. U12 *is* the state relocation, so it performs the
  standard D13 move-with-shim (identical to U10's `fake-host`/`temp-git-repo`
  moves). The shim stays until U13 skips the last old consumer.
- **One runtime fixture-path trap (`transcript-render-claude.test.ts`).** It reads
  a transcript fixture via `import.meta.dir` (a *runtime* path, **not** an import
  specifier the parity guard sees — the exact trap class U11 flagged). Its fixture
  already exists in `tests-new/_support/fixtures/claude/` (U11 copied it), so the
  fix is a single relative-path repoint, verified by running the test green.
- **A scope-boundary flag.** Five files literally **named** `two-pane-*.test.ts`
  sit directly under `tests/integration/hosts/` (not under `hosts/two-pane/`).
  They are two-pane host integration tests, still live, and **explicitly outside
  U12** (the parent scopes U12's integration-hosts to "**4** files NOT under
  `two-pane/`"). U12 must **not** relocate them; it flags them as an open
  accounting gap for group B / U14 (§9).

**Scope guard.** U12 relocates the **68 `test`-classified** files (51 unit + 17
integration) listed in §4. It **excludes**: all of `services/tmux/**` (parent
routes tmux argv/adapter tests to `tmux-argv`/U13), every `.test-d.ts` type-test
(none exist in these clusters; deferred type-test work is U13), and the 5
`two-pane-*` integration files (group B surface). **U12 boots no real tmux** —
every tmux-booting test in these directories lives under the excluded
`services/tmux/**`. No `src/` file is touched.

---

## 2. Problem frame & goals

**Problem.** The parent's frozen baseline (parent D12) must drain every
`test`/`type-test` entry to a disposition across U10–U13. U10 drained `core/**`
(61 files); U11 drained `runners/**` (36 files). U12 drains the **seven remaining
non-two-pane, non-cli/observability `src/` modules** plus the **non-two-pane
`hosts/**`** — the bulk of what is left before U13 closes out `cli`/
`observability`/`e2e`/type-tests/tmux-classification and U14 reconciles.

**Goals (in priority order).**
1. **Parity** — every relocated file imports the **same `src/` symbols** as its
   baseline original and resolves them on disk; no `tests-new → tests` import
   survives (parent R10/D13), enforced automatically by the U10 guard on every
   `bun run check`.
2. **Honesty of accounting** — every old file in these clusters ends fully `.skip`
   with a `// MIGRATED →` marker and a ledger row keyed to the frozen baseline, so
   U14 reconciliation can later prove completeness (parent D12, D15). The
   `make-step-entry.ts` baseline `helper` entry is accounted as a D13 `_support`
   move, not a relocated test.
3. **No semantic drift** — `port` rows are diff-identical except import paths. No
   test is rewritten, split, "improved", or pruned — this is relocation, not the
   triage re-derivation group B did (parent R3). Capability gates (`skipIf`) are
   preserved **verbatim** in the new copies and flipped to unconditional `.skip`
   **only** on the retained old copies (R13).
4. **The one helper move + one fixture-path trap handled cleanly** — `make-step-entry`
   moves to `_support` with a re-export shim (D13) without disturbing its live
   non-`state` consumers; the `transcript-render-claude` runtime fixture path is
   repointed to the existing `_support` fixture and verified green.
5. **The scope boundary is explicit, not silent** — the 5 `two-pane-*` integration
   files and all of `services/tmux/**` are documented exclusions with rationale, so
   the autonomous implementer neither absorbs them nor leaves the reconcile gap
   unremarked.

**Non-goals.**
- Not touching any `src/` file. U12 changes only tests + the one helper file (move
  + shim) + the one fixture-path repoint + `package.json` migration artifacts
  (relocation map / ledger) + the skip script.
- Not re-deriving, merging, demoting, or dropping any case. A pure relocation
  ports every case 1:1.
- Not relocating or classifying `services/tmux/**` (unit *or* integration). The
  parent assigns tmux argv to the `tmux-argv` category and the real-tmux
  adapter/harness classification to **U13** (parent U13 row, §7 note). U12 leaves
  every `services/tmux/**` file untouched and live.
- Not relocating the 5 `tests/integration/hosts/two-pane-*.test.ts` files — they
  are two-pane host integration (group B). U12 flags them (§9) and leaves them
  exactly as found.
- Not relocating any `.test-d.ts` type-test — there are none in U12's clusters;
  the deferred type-test relocation is U13.
- Not deleting the `make-step-entry.ts` shim (its cli/observability/two-pane
  consumers stay live until U13+); not deleting any other `_support` shim left by
  U10/U11/U2 (parent D13/R11 — a shim dies only when its last old consumer skips).
- Not chasing the 5 pre-existing `ENOENT` fixture failures under gitignored
  `.orch/` (long-standing infra, unrelated — see
  [[orch-test-fixtures-under-gitignored-orch]] and the Phase 4–11 summaries).

---

## 3. Key decisions (phase-local, inheriting parent D1–D15)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| **PD1** | **No new machinery** | U12 builds **no** parity guard, **no** new move-script logic, and adds **no** new `package.json` test buckets. It reuses `tests-new/_migration/import-parity.ts`, `check:import-parity`, `test:new-unit`, `test:new-int`, and the `relocation-map.json`/`ledger.md` artifacts. Only a new **parameterised skip script** (`scripts/skip-migrated-u12.sh`) is added, mirroring `skip-migrated-u11.sh`, and the existing `scripts/move-test-infra-to-support.sh` is reused for the one helper move. | U10 built the guard "once here and reused by U11–U13" (parent PD4); U11 confirmed the reuse. The imports U12 touches already resolve through the existing `@orch/*` aliases (`tsconfig.json`). Re-deciding any of it is relitigation. |
| **PD2** | **One helper move: `make-step-entry.ts` → `_support` + shim** | **Move** `tests/helpers/make-step-entry.ts` → `tests-new/_support/make-step-entry.ts`, leaving a thin re-export shim at the old path (parent D13). The 6 `state/**` consumers rewrite their specifier to `@orch/test/make-step-entry.ts`. The shim is **kept** (not deleted) because cli/observability (U13) and still-live two-pane files still import it. | Phase 7 explicitly deferred this move to "the U10–U13 **state** relocation" — U12 is that relocation. The move is the standard D13 pattern proven by U10's `fake-host`/`temp-git-repo` moves (shim → old suite stays green; snapshot scan still sees a path-present file, so the frozen baseline is undisturbed). |
| **PD3** | **Import-rewrite rules (depth-preserving)** | `../../../src/...` / `../../../../src/...` → **unchanged** (every `tests/<x>` → `tests-new/<x>` move preserves relative depth). `../../helpers/make-step-entry.ts` → `@orch/test/make-step-entry.ts` (6 files). `../../helpers/temp-git-repo.ts` → `@orch/test/temp-git-repo.ts` (1 file: `integration/validators/git-validators.test.ts`). Any `../**/helpers/<X>` whose `<X>` lives in `_support` → `@orch/test/<X>`. All other relative imports unchanged. | `tests/unit/services/clock/` and `tests-new/unit/services/clock/` are both the same number of dirs deep; the entire mirror is depth-identical (the U2/U10/U11 invariant). So every `src/` relative import keeps its identical `../` count after the move. Only cross-tree helper specifiers change, all to the `@orch/test/*` alias already pointed at `_support/`. |
| **PD4** | **Runtime fixture-path repoint (the `import.meta.dir` trap)** | `tests/integration/hosts/plain/transcript-render-claude.test.ts` resolves its transcript fixture via `import.meta.dir + '../../../fixtures/claude/<f>.ndjson'`. After relocation to `tests-new/integration/hosts/plain/`, repoint the **relative literal** to `'../../../_support/fixtures/claude/<f>.ndjson'` (the fixture already exists there, copied by U11). Verify by **running the relocated test green** — the parity guard does **not** inspect `import.meta.dir` reads. | U11's lesson: the import-only inventory misses runtime `import.meta.dir`/`__dirname` paths; a wrong one silently `ENOENT`s. A grep for `import.meta.dir`/`__dirname` per cluster before copying is mandatory (this is the **only** hit in U12 — re-confirm at run time). |
| **PD5** | **`services/tmux/**` is OUT of scope** | U12 relocates **`services` minus `tmux`**: `clock`, `fs`, `git`, `process`, `prompt`, and `types.test.ts`. It leaves every `tests/{unit,integration}/services/tmux/**` file untouched and live. | Parent U12 row: services "**excluding** `services/tmux` argv which is already `tmux-argv`". Parent U13 row owns the explicit `tmux-argv`-vs-`integration` classification of `tests/integration/services/tmux/**` and `tests/integration/real-tmux/**`. Splitting tmux off keeps U12 a no-tmux relocation and avoids pre-empting U13's classification call. |
| **PD6** | **Ledger granularity** | **One `port` row per old file**, enumerating its cases in the "Old case" column (e.g. `(all N cases: …)`), with any regression-pin run-IDs preserved in the reason. Follow the U10/U11 precedent verbatim. The `make-step-entry.ts` move gets a one-line **infra** note in the section header (D13 `_support` move, not a `port`/`drop` test row). | Parent requires case-granular accounting (D15), but the house convention for **relocations** records one row per file with a parenthetical case enumeration — ~1,000 one-line rows across 68 files would bury the signal. The enumeration satisfies "every child case is mapped" while staying reviewable. |
| **PD7** | **Old-file disposition** | Wrap every old U12 `test` file in unconditional `describe.skip`/`it.skip`/`test.skip` + a top `// MIGRATED → <new path> (parent U12)` marker, via `scripts/skip-migrated-u12.sh`. **Convert any `describe.skipIf(...)` → `describe.skip`** on the old copy so U14 reconcile reads it as *migrated*, not *capability-skipped*; the **new** copy keeps `skipIf` (legitimate capability gating, D8). Idempotent (skips already-marked files). The script must **not** touch `services/tmux/**`, the 5 `two-pane-*` files, the moved `_support` helper, or its old-path shim. | Parent D2/D15 + R13: the reconcile AST scan distinguishes `skipIf` (capability) from unconditional `.skip` (migrated). A script keeps the 68-file edit mechanical and uniform (cf. [[prefer-scripts-over-complex-git]]). |
| **PD8** | **The 5 `two-pane-*` integration files are flagged, not touched** | U12 leaves `tests/integration/hosts/{two-pane-mocked,two-pane-interactive,two-pane-interactive-session-lost,two-pane-failure-and-parallel,two-pane-sequential-runs}.test.ts` exactly as found (4 live `describe(`, 1 `describe.skipIf(`). It records them in §9 as an **open accounting gap** for group-B closeout / U14, with no relocation and no ledger row. | The parent scopes U12 integration-hosts to "**4** files NOT under `two-pane/`". These 5 are two-pane host plumbing tests whose behaviours group B re-derived into scenarios; their disposition (skip-as-covered vs port vs drop) belongs to whoever owns the two-pane host integration surface, not the non-two-pane relocation. Silently relocating them would mis-categorise two-pane tests into `tests-new/integration/hosts/`; silently ignoring them would hide a reconcile gap. Flagging is the honest middle (parent §3.7 anti-expansion). |

---

## 4. Inventory (from the frozen baseline, parent D12)

> The implementer must confirm this list against `tests-new/_migration/baseline.json`
> at run time (the baseline is the source of truth, not this prose). Expected
> outcome: **68 `test` entries** across the clusters below end as `port` ledger
> rows; the **1 helper** (`make-step-entry.ts`) is `_support`-moved (D13), not a
> relocated test; **zero** `type-test` entries exist in these clusters; the **5
> `two-pane-*`** integration files and **all `services/tmux/**`** are untouched.

**Unit (51 files) — `tests/unit/<x>/` → `tests-new/unit/<x>/`.**

| Cluster | Files | Notes |
|---|---|---|
| `services/clock` | `fake-clock`, `sleep` (2) | no cross-tree deps |
| `services/fs` | `bun-fs-service`, `fake-fs-service-remove`, `fake-fs-service`, `symlink` (4) | |
| `services/git` | `bun-git-service`, `fake-git-service` (2) | |
| `services/process` | `fake-process-service`, `foreground`, `line-framer`, `merge-env`, `raw-streams` (5) | `raw-streams` uses `process.cwd()` — CWD-relative, invariant to file location (not a trap) |
| `services/prompt` | `confirm-service`, `fake-prompt-service`, `ink-app` (`.test.tsx`), `readline-prompt-service` (4) | |
| `services/types.test.ts` | `types` (1) | |
| `state` | `run-id`, `run-registry`, `state-store`, `state-store-runner-name-and-capture-error`, `state-store-session-id`, `state-store-subpath`, `state-store-v5` (7) | **5 import `make-step-entry` → PD2** (`state-store`, `-runner-name-and-capture-error`, `-session-id`, `-subpath`, `-v5`) |
| `validators` | `check`, `define-validator`, `file-produced`, `git-commit-created`, `git-diff-created`, `validation-error` (6) | |
| `workflows` | `parse-phases`, `resolve-builtin` (2) | `resolve-builtin` references `process.cwd()` in a comment only — not a trap |
| `config` | `load-config` (1) | |
| `codegen` | `discover-prompts`, `emit-sidecar`, `extract-placeholders`, `run-codegen` (4) | |
| `hosts` (non-two-pane) | `await-foreground-shutdown`, `failure-text`, `host-registry`, `pane-queue`, `parallel-rollup`, `plain-host-attach-foreground`, `plain-host`, `terminal-reset`, `tmux-host-attach-foreground`, `tmux-host`, `plain/per-step-tee`, `plain/plain-host-subworkflow-divider`, `plain/render-line-no-duplicate` (13) | uses fake services, **boots no real tmux** (confirmed) |

**Integration (17 files) — `tests/integration/<x>/` → `tests-new/integration/<x>/`.**

| Cluster | Files | Notes |
|---|---|---|
| `services/fs` | `bun-fs-service` (1) | |
| `services/process` | `bun-process-service` (1) | |
| `services/prompt` | `ink-prompt-service`, `ink-prompt-service-real` (2) | `-real` may be capability-gated — preserve gating verbatim in the new copy (PD7) |
| `state` | `run-registry`, `state-store` (2) | `state-store` imports `make-step-entry` → PD2 (the 6th consumer) |
| `validators` | `file-produced`, `git-validators` (2) | `git-validators` imports `temp-git-repo` (already `_support`-shimmed) → `@orch/test/temp-git-repo.ts` |
| `workflows` | `builtin-variants`, `phased-build-decide`, `phased-build-input`, `phased-build-loop` (4) | |
| `codegen` | `codegen-fixture` (1) | uses `mkdtemp(tmpdir())` — self-contained, no fixture-path trap |
| `hosts` (non-two-pane) | `plain-host-command-line`, `plain-mode`, `tmux-host-command-line`, `plain/transcript-render-claude` (4) | `transcript-render-claude` is the **PD4 runtime fixture-path trap** |

**Cross-tree dependencies (the complete set across all 68 files).**
- `make-step-entry.ts` — imported by **6** files (5 unit `state` + `integration/state/state-store`). **Moved to `_support` in U12.1 (PD2)** → rewrite specifier to `@orch/test/make-step-entry.ts`.
- `temp-git-repo.ts` — imported by **1** file (`integration/validators/git-validators`). **Already in `_support/` (U10)** → rewrite to `@orch/test/temp-git-repo.ts`.
- `transcript-render-claude.test.ts` — **runtime** fixture path via `import.meta.dir` (PD4), fixture already in `_support/fixtures/claude/`.
- No `fake-host`, no `ink-frame`, no other `tests/`-tree import exists in the 68 files (re-verify with a grep at run time before assuming). All apparent `fake-host`/`real-tmux`/`ink-frame` hits in a naïve grep belong to the excluded `services/tmux/**` or the excluded `two-pane-*` files.

**Explicit exclusions (untouched by U12).**
- `tests/{unit,integration}/services/tmux/**` (7 files: 5 unit + 2 integration) — PD5, → U13.
- `tests/integration/hosts/two-pane-*.test.ts` (5 files) — PD8, → group B / U14.
- All `tests/**/two-pane/**` (already migrated by group B).
- Any `.test-d.ts` (none in these clusters; → U13).

---

## 5. Output structure

```
tests-new/
  _support/
    make-step-entry.ts              # MOVED from tests/helpers/ (shim left behind) — PD2
  _migration/
    relocation-map.json             # + 68 old→new rows (appended)
    ledger.md                       # + "Relocated — services/state/validators/workflows/config/codegen/hosts (parent U12)" section
  unit/
    services/{clock,fs,git,process,prompt}/*.test.ts(x)   # NEW — 18 (mirror src/services, NO tmux)
    services/types.test.ts
    state/*.test.ts                 # NEW — 7
    validators/*.test.ts            # NEW — 6
    workflows/*.test.ts             # NEW — 2
    config/*.test.ts                # NEW — 1
    codegen/*.test.ts               # NEW — 4
    hosts/                          # NEW — 13 non-two-pane (mirror src/hosts top-level + plain/)
      *.test.ts ; plain/*.test.ts
  integration/
    services/{fs,process,prompt}/*.test.ts                # NEW — 4 (NO tmux)
    state/*.test.ts                 # NEW — 2
    validators/*.test.ts            # NEW — 2
    workflows/*.test.ts             # NEW — 4
    codegen/codegen-fixture.test.ts # NEW — 1
    hosts/                          # NEW — 4 non-two-pane
      plain-host-command-line.test.ts ; plain-mode.test.ts ; tmux-host-command-line.test.ts
      plain/transcript-render-claude.test.ts   # PD4 fixture-path repoint
scripts/
  skip-migrated-u12.sh              # NEW reusable skip+marker script (PD7), mirrors skip-migrated-u11.sh
tests/
  helpers/make-step-entry.ts        # now a re-export shim → @orch/test/make-step-entry.ts (kept; live cli/obs/two-pane consumers)
  {unit,integration}/{services(excl tmux),state,validators,workflows,config,codegen,hosts(non-two-pane)}/**
                                    # all .skip with // MIGRATED → markers (kept on disk, D2)
  {unit,integration}/services/tmux/**          # UNTOUCHED, live (→ U13)
  integration/hosts/two-pane-*.test.ts         # UNTOUCHED, live (→ group B / U14)
```

The per-unit **Files** sections below remain authoritative; this tree is the
scope shape.

---

## 6. Implementation units

Ordered. Each leaves `bun run check` green (new tests + still-running old suite).
A unit is done only when its Definition of Done holds. Within each relocation
unit, the **acceptance gate per file is the U10 parity guard** (`check:import-parity`
against the file's baseline original) — not merely "`bun run check` is green".

### U12.1 — Move `make-step-entry.ts` to `_support` + shim

**Goal.** Make `make-step-entry` importable from `tests-new/` via `@orch/test/*`,
without breaking the still-live old suite (cli/observability/two-pane consumers)
or the frozen-baseline snapshot scan.

**Requirements.** Parent D13, R11; PD2.

**Dependencies.** None (must precede U12.3's `state` relocation, which imports it).

**Files (move/create).**
- `tests-new/_support/make-step-entry.ts` ← moved from `tests/helpers/make-step-entry.ts`.
- `tests/helpers/make-step-entry.ts` — replaced with a thin re-export shim
  (`export * from '@orch/test/make-step-entry.ts'`, preserving the value+type
  surface the consumers use, e.g. `makeStepEntry`, `makeRunState`).
- Reuse `scripts/move-test-infra-to-support.sh`'s `move_file` helper for the move
  + shim, to keep the shim shape uniform (or move by hand — it is a single file).

**Approach.**
- `tests/helpers/<X>.ts` and `tests-new/_support/<X>.ts` are both two dirs deep
  from the repo root (the `move_file` invariant), so the moved file's own
  `../../src/...` imports are **preserved unchanged**. Confirm with `typecheck`.
- Verify the `@orch/test/* → tests-new/_support/*` alias resolves
  `@orch/test/make-step-entry.ts` (the existing mapping covers top-level files —
  proven by `fake-host`/`temp-git-repo`/`ink-frame`).
- Do **not** delete the shim (PD2): cli, observability (U13), and still-live
  two-pane files (`steps-view-model`, `subworkflow-boundary-projection`,
  `subworkflow-parallel-suppression`) still import the old path.
- Leave Phase 7's local copy in `tests-new/model/projector/_support.ts` untouched
  (it is an independent copy, not an import of this helper — out of scope).

**Patterns to follow.** The U10 `fake-host.ts`/`temp-git-repo.ts` moves and the
U1/U2 `ink-frame`/`type-assertions` moves (each left a re-export shim; see
`scripts/move-test-infra-to-support.sh` and the Phase 1/2/10 summaries).

**Test scenarios.** *Test expectation: none — infra move.* Correctness is proven
by the existing suites:
- `bun run typecheck` resolves both the new `_support` path and the old shim.
- A sampled `bun run test:legacy` over a still-live old consumer (e.g.
  `tests/unit/cli/format.test.ts` or a live two-pane `steps-view-model` test)
  resolves `make-step-entry` through the shim and stays green.
- `tests-new/_migration/__tests__/snapshot.test.ts` stays green (the path-present
  shim keeps the baseline `helper` entry satisfied; the frozen baseline is **never**
  regenerated, parent D12).

**Verification.** `@orch/test/make-step-entry.ts` resolves under `typecheck`; the
old shim resolves for every still-live old consumer; the snapshot test is green;
no test file was skipped or edited beyond the move + shim.

---

### U12.2 — Relocate `services/**` (excl. `tmux`) — 18 unit + 4 integration

**Goal.** Move the 22 `services` test files (clock, fs, git, process, prompt,
`types.test.ts`) into their mirror, fix imports per PD3, preserve capability
gating verbatim on `ink-prompt-service-real`, and prove green.

**Requirements.** Parent D1, D3, D8, D13; PD3, PD5.

**Dependencies.** None (no `make-step-entry` dep in this cluster).

**Files (create).** `tests-new/unit/services/{clock,fs,git,process,prompt}/*.test.ts(x)`
(18, incl. `prompt/ink-app.test.tsx`), `tests-new/unit/services/types.test.ts`;
`tests-new/integration/services/{fs,process,prompt}/*.test.ts` (4). Create the
`services/` dir trees under `tests-new/{unit,integration}/`.

**Approach.**
- Copy each file byte-for-byte; `src/` relative imports are **unchanged** (depth
  preserved). This cluster has **no** helper/fixture imports to rewrite (confirm
  with a grep first).
- **Do not relocate, classify, or touch `services/tmux/**`** (PD5) — leave all 7
  tmux files live.
- Preserve any `skipIf`/`describe.skipIf` on the new copy of
  `ink-prompt-service-real` verbatim (D8) — capability gating prevents false
  failure and never *causes* a run.
- Grep this cluster for `import.meta.dir`/`__dirname` before copying (expected:
  none; `raw-streams` uses `process.cwd()`, which is invariant).

**Patterns to follow.** U10.3 / U11.2 byte-faithful unit relocation (import-depth
invariance, regression-pin preservation; the `## Relocated — core/**` and
`## Relocated — runners/**` ledger sections).

**Test scenarios.** *Test expectation: relocation parity — same assertions, new
path.*
- `bun run test:new-unit` runs the relocated `services` unit tests green. *(happy)*
- `bun run test:new-int` runs the relocated `services` integration tests green;
  `ink-prompt-service-real` auto-skips without its capability. *(happy + gating)*
- Import-parity guard passes for every relocated file (same `src/` symbol-set;
  resolves; no `tests/` import). *(critical)* `Covers R10.`
- The 4-deep `services/<sub>/` tests resolve `../../../../src/services/...` from
  the new location. *(integration)*

**Verification.** `bun run test:new-unit` + `bun run test:new-int` green for the
`services` rows; `bun run check:import-parity` green for those map rows;
`services/tmux/**` untouched and still live.

---

### U12.3 — Relocate `state/**` — 7 unit + 2 integration

**Goal.** Move the 9 `state` test files, rewrite the 6 `make-step-entry` imports
to `@orch/test/*` (PD3), and prove green.

**Requirements.** Parent D1, D3, D13; PD2, PD3.

**Dependencies.** U12.1 (`make-step-entry` must be in `_support` first).

**Files (create).** `tests-new/unit/state/*.test.ts` (7);
`tests-new/integration/state/*.test.ts` (2).

**Approach.**
- Byte-copy + PD3 rewrites. The only cross-tree specifier is
  `../../helpers/make-step-entry.ts` → `@orch/test/make-step-entry.ts` (5 unit +
  `integration/state/state-store`). A `sed` over that single pattern keeps it
  mechanical; everything else is byte-copy with unchanged `src/` imports.
- No body edits (R3). A pre-existing file-size lint **warning** travels unchanged.

**Patterns to follow.** U11.3's mechanical specifier rewrite (`fake-host` → alias)
applied to the single `make-step-entry` pattern here.

**Test scenarios.** *Test expectation: relocation parity.*
- `bun run test:new-unit` + `bun run test:new-int` run the relocated `state` tests
  green. *(happy)*
- Import-parity guard passes — including the 6 `@orch/test/make-step-entry.ts`
  imports resolving to the U12.1 `_support` file. *(critical)* `Covers R10, D13.`

**Verification.** `state` rows green under `test:new-unit`/`test:new-int`; parity
guard green; no `tests/` import survives in any relocated `state` file.

---

### U12.4 — Relocate `validators/** + workflows/** + config/** + codegen/**` — 13 unit + 9 integration

**Goal.** Move the 22 files of the four mid-size pure clusters, fix the one
`temp-git-repo` import (PD3), and prove green. (`codegen-fixture` uses
`mkdtemp(tmpdir())` — self-contained, no fixture-path edit.)

**Requirements.** Parent D1, D3, D13; PD3.

**Dependencies.** None (`temp-git-repo` already in `_support`).

**Files (create).**
- `tests-new/unit/validators/*.test.ts` (6); `tests-new/integration/validators/*.test.ts` (2).
- `tests-new/unit/workflows/*.test.ts` (2); `tests-new/integration/workflows/*.test.ts` (4).
- `tests-new/unit/config/load-config.test.ts` (1).
- `tests-new/unit/codegen/*.test.ts` (4); `tests-new/integration/codegen/codegen-fixture.test.ts` (1).

**Approach.**
- Byte-copy + PD3. The only cross-tree specifier is
  `../../helpers/temp-git-repo.ts` → `@orch/test/temp-git-repo.ts` in
  `integration/validators/git-validators.test.ts`.
- Grep each of the four clusters for `import.meta.dir`/`__dirname`/runtime
  `fixtures` reads before copying (expected: none — `codegen-fixture` uses a temp
  dir; `resolve-builtin` only mentions `process.cwd()` in a comment).

**Patterns to follow.** U10/U11 byte-faithful relocation; the unchanged
three-layer model (CLAUDE.md "How to write tests").

**Test scenarios.** *Test expectation: relocation parity.*
- `bun run test:new-unit` + `bun run test:new-int` run all four clusters green.
  *(happy)*
- Import-parity guard passes for every relocated file, including
  `git-validators`'s `@orch/test/temp-git-repo.ts`. *(critical)* `Covers R10.`
- `codegen-fixture` builds its temp project under `tmpdir()` from the new location
  (no fixture-path dependency on file location). *(integration)*

**Verification.** All four clusters green under `test:new-unit`/`test:new-int`;
parity guard green for their map rows.

---

### U12.5 — Relocate non-two-pane `hosts/**` — 13 unit + 4 integration

**Goal.** Move the 17 non-two-pane host test files, perform the **one** runtime
fixture-path repoint (PD4), and prove green — **without** touching the 5
`two-pane-*` integration files (PD8).

**Requirements.** Parent D1, D3, D13; PD3, PD4, PD8.

**Dependencies.** None (no `make-step-entry`/`temp-git-repo` dep in this cluster;
`transcript-render-claude`'s fixture already exists in `_support` from U11).

**Files (create).**
- `tests-new/unit/hosts/*.test.ts` (10 top-level: `await-foreground-shutdown`,
  `failure-text`, `host-registry`, `pane-queue`, `parallel-rollup`,
  `plain-host-attach-foreground`, `plain-host`, `terminal-reset`,
  `tmux-host-attach-foreground`, `tmux-host`) + `tests-new/unit/hosts/plain/*.test.ts`
  (3: `per-step-tee`, `plain-host-subworkflow-divider`, `render-line-no-duplicate`).
- `tests-new/integration/hosts/{plain-host-command-line,plain-mode,tmux-host-command-line}.test.ts`
  (3) + `tests-new/integration/hosts/plain/transcript-render-claude.test.ts` (1).

**Approach.**
- Byte-copy with unchanged `src/` imports (depth preserved). Confirm no cross-tree
  helper import in this cluster (the precise grep shows none; the apparent
  `fake-host`/`real-tmux` hits all belong to the excluded `two-pane-*`/`services/tmux`
  files — re-verify before copying).
- **PD4 repoint (the one non-byte-identical edit in U12):** in the relocated
  `transcript-render-claude.test.ts`, change the `import.meta.dir`-relative literal
  `'../../../fixtures/claude/<f>.ndjson'` → `'../../../_support/fixtures/claude/<f>.ndjson'`.
  Verify by **running the relocated test green** (parity guard does not see this
  path). Account this single edit explicitly in the ledger reason (it is still a
  `port` — same assertions, only the runtime fixture root moved to `_support`).
- **PD8:** do **not** relocate, skip, or edit any
  `tests/integration/hosts/two-pane-*.test.ts`. Confirm `tmux-host*.test.ts` and
  `tmux-host-command-line.test.ts` use a **fake** tmux service and boot no real
  tmux (confirmed — they are not in the real-tmux booker set); if a hidden real-tmux
  boot is discovered at run time, stop and treat it as a scope question, not a
  silent gating addition.

**Patterns to follow.** U11's `import.meta.dir` fixture-trap handling (the PD2/PD4
analogue); U10/U11 byte-faithful relocation otherwise.

**Test scenarios.** *Test expectation: relocation parity (with one runtime-path
repoint).*
- `bun run test:new-unit` runs the 13 relocated host unit tests green. *(happy)*
- `bun run test:new-int` runs the 4 relocated host integration tests green —
  including `transcript-render-claude` reading its fixture from the `_support`
  path. *(critical — the PD4 trap)* `Covers PD4.`
- Import-parity guard passes for all 17 files (same `src/` symbol-set; resolves;
  no `tests/` import). *(critical)* `Covers R10.`
- The 5 `two-pane-*` integration files are byte-for-byte unchanged after this unit
  (grep: still `describe(`/`describe.skipIf(`, no `// MIGRATED →` marker). *(scope guard)*

**Verification.** All 17 host files green under `test:new-unit`/`test:new-int`;
`transcript-render-claude` green from its new location; parity guard green; the 5
`two-pane-*` files untouched.

---

### U12.6 — Append the relocation map, skip the old files, ledger, and reconcile-readiness

**Goal.** Append the 68 old→new rows to the relocation map, wrap every old U12
`test` file `.skip` with a `// MIGRATED →` marker, write the ledger section, and
confirm the migration accounting is consistent with the frozen baseline.

**Requirements.** Parent D2, D12, D15, R3, R13; PD6, PD7, PD8.

**Dependencies.** U12.2–U12.5 (new copies must be green before the old guard is
dropped). U12.1 (the helper move is accounted here).

**Files (create/modify).**
- `tests-new/_migration/relocation-map.json` — append 68 `{ old, new }` rows (or
  add them incrementally in U12.2–U12.5; land them no later than here).
- `scripts/skip-migrated-u12.sh` — reusable, modelled on `skip-migrated-u11.sh`:
  for each old U12 `test` file, wrap top-level `describe(`→`describe.skip(`,
  `it(`/`test(`→`.skip(`, **convert `describe.skipIf(...)`→`describe.skip`**, and
  prepend `// MIGRATED → <new path> (parent U12)`. Idempotent. **Hard exclusions
  baked into the file globs:** never touch `services/tmux/**`, the 5
  `integration/hosts/two-pane-*.test.ts` files, `tests/helpers/make-step-entry.ts`
  (the shim), or any `_support` file.
- The old U12 `test` files — `.skip` + marker applied by the script (content
  otherwise unchanged, kept on disk; D2).
- `tests-new/_migration/ledger.md` — new section
  `## Relocated — services(excl tmux)/state/validators/workflows/config/codegen/hosts (parent U12)`
  with **one `port` row per old file** (PD6), enumerating cases + preserving any
  regression-pin run-IDs, an infra note for the `make-step-entry` `_support` move
  (D13), the `transcript-render-claude` runtime-path repoint noted in its row, and
  a short prose note recording the PD8 exclusions (`services/tmux/**` → U13; the 5
  `two-pane-*` files → group B / U14).

**Approach.**
- Each relocated file is **not** a `scenario()`, so it carries no
  `oldTestRefs`/overlap metadata — the ledger row *is* its accounting (U7/U10/U11
  precedent). Mirror U11's section-header prose.
- Verify reconcile-readiness by AST/grep: every old U12 `test` file is now
  unconditional `.skip` (no surviving non-skipped top-level `it(`/`test(`; no
  `skipIf` left on a migrated file); every `MIGRATED →` target exists on disk.
- Confirm the **excluded** files are still live and unmarked: `services/tmux/**`
  and the 5 `two-pane-*` files carry **no** `// MIGRATED →` marker (a grep guard).

**Patterns to follow.** `scripts/skip-migrated-u11.sh`; the `ledger.md`
`## Relocated — runners/**` section shape; the old skipped-file marker style.

**Test scenarios.** *Test expectation: none — mechanical skip + documentation.*
Acceptance is structural:
- Every old U12 `test` file is unconditional `describe.skip`/`it.skip` (grep: no
  surviving non-skipped top-level `it(`/`test(`; no `skipIf` on a migrated file).
  *(critical — the D15 green-but-incomplete trap)*
- Every `// MIGRATED →` target path exists. *(critical)*
- The ledger section has one row per old file; every row is `port` with a reason;
  regression-pins preserved; the `make-step-entry` move noted as a D13 `_support`
  account; the PD8 exclusions recorded. *(coverage)*
- `relocation-map.json` contains all 68 rows and `check:import-parity` passes over
  them. *(integration)*
- **Exclusion guard:** no `services/tmux/**` file and none of the 5 `two-pane-*`
  files carry a `// MIGRATED →` marker; all remain live. *(scope guard)*

**Verification.** `bun run check` green (old U12 tests now skip, new ones run); a
grep confirms no old U12 file is left non-skipped or `skipIf`-gated, and the
excluded files are untouched; ledger section complete;
`tests-new/_migration/__tests__/snapshot.test.ts` green (frozen baseline untouched
— U12 never regenerates it, parent D12).

---

## 7. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Mis-resolved `../` after the move** (R10): a wrong depth resolves to nothing or the wrong module while looking diff-identical. | Low | The U10 parity guard (`check:import-parity`) is the per-file acceptance gate for U12.2–U12.5 — not just "`check` is green". Depth is unchanged for every `src/` import (PD3), so the guard mostly protects against a stray hand-edit across 68 files. |
| **The `import.meta.dir` fixture trap (PD4) silently `ENOENT`s** — the parity guard does not inspect runtime paths. | Medium | PD4: the one hit (`transcript-render-claude`) is repointed to the existing `_support` fixture and **proven by running the test green**; U12.5's test scenario asserts it explicitly. A per-cluster `import.meta.dir`/`__dirname` grep is mandatory before each copy (U11's lesson). |
| **`make-step-entry` move breaks a still-live consumer** (cli/observability/two-pane) or the snapshot scan. | Medium | PD2/D13: a re-export shim is left at the old path, so every old consumer and the path-present baseline `helper` entry stay satisfied; U12.1 verifies via a sampled `test:legacy` over a live consumer and the green snapshot test (the exact pattern U10 proved for `fake-host`/`temp-git-repo`). |
| **Accidentally relocating the 5 `two-pane-*` integration files** into `tests-new/integration/hosts/`, mis-categorising two-pane tests. | Medium | PD8: the files are named exclusions baked into the U12.5 copy step and the U12.6 skip-script globs; U12.5/U12.6 test scenarios assert they are byte-unchanged and unmarked. They are flagged in §9, not absorbed. |
| **Accidentally touching `services/tmux/**`** (pre-empting U13's classification). | Low | PD5: services relocation is explicitly "minus tmux"; the skip-script globs exclude `services/tmux/**`; U12.2 leaves all 7 tmux files live and the U12.6 exclusion guard greps for any stray marker. |
| **`skipIf` mistaken for migrated** by the future U14 reconcile (R13). | Medium | PD7: old copies of any gated file (e.g. `ink-prompt-service-real`) flip `skipIf`→unconditional `.skip`; the new copies keep `skipIf`. The U12.6 grep checks no `skipIf` survives on an old migrated file. |
| **Skipping a file before every case is accounted** (D15 green-but-incomplete trap). | Low | One row per file enumerating *all* cases (PD6); the U12.6 grep proves no non-skipped top-level `it(`/`test(` remains; each new copy is proven green first. |
| **Accidental semantic edit during "relocation"** (R3 drift) across 68 files. | Low | No body edits permitted; rewrites limited to the cross-tree specifiers (PD3) + the one PD4 runtime-path literal, all via codemod/`sed`; a per-file old↔new diff should show import lines + the old-copy `.skip` wrap only (plus the single PD4 literal in one file). |
| **Re-running the baseline snapshot** against the mutating tree (parent D12 hazard). | Low | U12 never regenerates `baseline.json`; `snapshot.test.ts` staying green confirms it. |

---

## 8. Definition of Done (U12)

- The 51 unit + 17 integration `test` files run green from
  `tests-new/{unit,integration}/{services(excl tmux),state,validators,workflows,config,codegen,hosts}/**`
  (`bun run test:new-unit` + `bun run test:new-int`).
- Any capability-gated file (e.g. `ink-prompt-service-real`) keeps `skipIf` in its
  **new** copy and auto-skips off the gate without its capability.
- `tests/helpers/make-step-entry.ts` lives in `tests-new/_support/make-step-entry.ts`
  with a re-export shim at the old path; every still-live old consumer
  (cli/observability/two-pane) and the snapshot scan stay green through it; the
  shim is **kept** (not deleted — deferred to when U13 skips the last consumer).
- `tests-new/_support/fixtures/claude/` is used by the relocated
  `transcript-render-claude` test (PD4 repoint), which is green from its new
  location; no `tests/`-tree runtime path survives in it.
- `tests-new/_migration/relocation-map.json` has all 68 rows and
  `bun run check:import-parity` passes for every relocated file (same `src/`
  symbol-set, resolves, no `tests/` import).
- Every old U12 `test` file is unconditional `.skip` with a `// MIGRATED →` marker
  (kept on disk, D2); no `skipIf` survives on a migrated old file.
- `tests-new/_migration/ledger.md` has the U12 `## Relocated — …` section: one
  `port` row per old file, all cases enumerated, regression-pins preserved, the
  `make-step-entry` move noted as a D13 `_support` account, the PD4 repoint noted,
  and the PD5/PD8 exclusions recorded.
- **Exclusions honoured:** all 7 `services/tmux/**` files and all 5
  `integration/hosts/two-pane-*.test.ts` files are **untouched and live** (no
  `// MIGRATED →` marker, no relocation); no `.test-d.ts` work (none in scope).
- `scripts/skip-migrated-u12.sh` exists, is idempotent, excludes the protected
  paths, and was used for the skip pass.
- No `src/` file changed.
- `bun run check` green except for the documented, pre-existing 5 `ENOENT` fixture
  failures under gitignored `.orch/` (unrelated to this phase).
- `tests-new/_migration/__tests__/snapshot.test.ts` green (frozen baseline
  untouched). `bun run typecheck` + `bun run lint` clean (no new warnings
  introduced by the move).

---

## 9. Open accounting gap surfaced by U12 (for group-B closeout / U14)

> Flagged per parent §3.7 (anti-expansion) and the parent's whole-tree-drain
> requirement (D12). **Not U12 work** — recorded so it is not lost.

Five files **named** `two-pane-*.test.ts` sit directly under
`tests/integration/hosts/` (not under `hosts/two-pane/`):
`two-pane-mocked`, `two-pane-interactive`, `two-pane-interactive-session-lost`,
`two-pane-failure-and-parallel` (all live `describe(`), and
`two-pane-sequential-runs` (live `describe.skipIf(`).

They are **two-pane host integration tests** (they boot the two-pane host and
assert two-pane plumbing) whose behaviours group B (U4–U9) re-derived into
scenario/driver tests. But the **files themselves** are still live and **not yet
dispositioned** in the ledger against the frozen baseline (D12). The parent
explicitly scopes U12's integration-hosts to the **4** non-two-pane files, so U12
leaves these 5 untouched (PD8).

**Action for a later phase (group-B closeout or U14 reconcile):** decide each
file's disposition — `skip-as-covered` (their scenarios already exist under
`tests-new/full-host/**` / `model/**`), `port`, or `drop` — and ledger every child
case, so U14's reconciliation against the frozen baseline does not flag them as
unaccounted. If U13 ends up owning the last two-pane host integration cleanup, it
should pick these up explicitly; otherwise U14 must.

Likewise, `tests/{unit,integration}/services/tmux/**` (7 files) is the **U13**
classification job (`tmux-argv` vs `integration`, parent §7 note) — U12 leaves it
untouched by design (PD5), not as an oversight.
