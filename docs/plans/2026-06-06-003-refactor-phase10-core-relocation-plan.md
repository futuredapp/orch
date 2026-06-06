---
status: active
type: refactor
title: "refactor: Phase 10 (U10) — relocate core/** tests into tests-new/{unit,integration}/core"
created: 2026-06-06
parent: docs/plans/2026-06-05-001-refactor-testing-strategy-restructure-plan.md
depth: standard
---

# refactor: Phase 10 (U10) — relocate `core/**` tests into `tests-new/{unit,integration}/core`

> **This is a phase plan.** It elaborates **U10** of the parent
> [`docs/plans/2026-06-05-001-refactor-testing-strategy-restructure-plan.md`](2026-06-05-001-refactor-testing-strategy-restructure-plan.md)
> (Phase group C — "Migrate the rest of the repo"). It honours every decision in
> the parent §3 (D1–D15) and the §8 script ladder; it does **not** relitigate
> them. Phase 1–9 are complete (see [`docs/plans/phase-summaries.md`](phase-summaries.md));
> group B (the two-pane behavioural surface) is fully migrated. U10 is the
> **first** of the four relocation phases (U10–U13) and therefore also builds the
> reusable **import-parity guard** the later relocations depend on (parent R10).

---

## 1. Summary

U10 is a **relocation, not a re-derivation** (parent D1). The `core/**` tests are
already plain class/integration tests with fakes at the `*Service` seam — the
parent's `unit` category *is* today's unit concept. The work is: move each old
`core` test file into its mirror under `tests-new/{unit,integration}/core/`, fix
its import paths, wrap the old file `.skip` with a `// MIGRATED →` marker, and
ledger it. **No behavioural rewrite.** A correct `port` is diff-identical to its
original except for import paths and the `describe`/`it` → `.skip` wrap on the
retained old copy (parent §7 group-C verification).

Two things make U10 more than a `mv`:

1. **Helper dependencies must cross the tree boundary first.** Core tests import
   two shared helpers that still live under `tests/helpers/` —
   `fake-host.ts` (46 imports) and `temp-git-repo.ts` (2 imports). `tests-new/`
   may never import from `tests/` (parent D13). Both helpers have **live
   non-core consumers** in the still-green old suite, so each is **moved** to
   `tests-new/_support/` with a **thin re-export shim** left at the old path
   (parent D13) — exactly the mechanic U1/U2 used for `type-assertions`,
   `ink-frame`, and `behavioral-dsl`.

2. **U10 builds the import-parity guard (parent R10).** Moving files changes
   relative depth; a wrong `../` count resolves to nothing or the wrong module
   while "looking" diff-identical. U10 ships a reusable AST-based parity check
   (`tests-new/_migration/import-parity.ts`) and wires it onto the gate, so
   U11–U13 inherit it.

**Scope guard.** U10 relocates the **61 `test`-classified** core files (44
unit `.test.ts` + 16 integration `.test.ts` + 1 integration file already counted).
The **6 `.test-d.ts` type-tests** under `tests/unit/core/**` are **deferred to
U13** (the parent assigns `.test-d.ts` relocation + the global type-test handling
rule to U13 — see §3 PD1). The core-local `_worktree-test-helpers.ts` (baseline
class `asset`) relocates **with** the cluster.

---

## 2. Problem frame & goals

**Problem.** `tests-new/unit/` and `tests-new/integration/` are empty except for
a `_pending-relocation.test.ts` sentinel that keeps the gate bucket green. The
parent's frozen baseline (parent D12) classifies **68 core entries** (61 `test`,
6 `type-test`, 1 `asset`); U10–U13 must drain every `test`/`type-test` entry to
a disposition. U10 drains the **core `test` cluster** and stands up the
relocation machinery the rest of group C reuses.

**Goals (in priority order).**
1. **Parity** — every relocated file imports the **same `src/` symbols** as its
   baseline original and resolves them on disk; no `tests-new → tests` import
   survives. This is the contract a relocation must satisfy (parent R10).
2. **Honesty of accounting** — every old core `test` file ends fully `.skip` with
   a `// MIGRATED →` marker and a ledger row keyed to the frozen baseline; the
   U14 reconciliation can later prove completeness against it (parent D12, D15).
3. **No semantic drift** — `port` rows are diff-identical except import paths.
   No test is rewritten, split, "improved", or pruned (this is relocation, not
   the triage re-derivation that group B did — parent R3).
4. **Reusable machinery** — the parity guard and the skip/marker script are built
   once here and reused by U11–U13.

**Non-goals.**
- Not relocating the 6 core `.test-d.ts` type-tests (→ U13).
- Not touching any `src/` file. U10 changes only tests + test infra + `package.json`.
- Not re-deriving, merging, demoting, or dropping any core case. A pure relocation
  ports every case 1:1.
- Not chasing the 5 pre-existing `ENOENT` fixture failures under gitignored
  `.orch/` (a long-standing infra artifact, unrelated to this phase — see
  [[orch-test-fixtures-under-gitignored-orch]] and Phase 4–8 summaries).

---

## 3. Key decisions (phase-local, inheriting parent D1–D15)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| **PD1** | **`.test-d.ts` scope** | **Defer all 6 core `.test-d.ts` to U13.** U10 relocates only `test`-classified files. The old `tests/unit/core/` dir retains its 6 type-tests (still typechecked, untouched) until U13. | The parent explicitly assigns `.test-d.ts` relocation to U13, which also owns the global type-test handling rule. Type-tests are not run by `bun test` and cannot be `.skip`-wrapped; "migrating" one means relocating the file **and** neutralising the old copy without deletion (D2) — a distinct mechanic the parent batches into U13. Keeping U10 to runnable files keeps the first relocation clean and its parity guard focused on `bun test` files. |
| **PD2** | **Shared-helper move** | **Move `fake-host.ts` and `temp-git-repo.ts` to `tests-new/_support/`, leaving a re-export shim at the old `tests/helpers/` path** (parent D13). `type-assertions.ts` already moved (U1) and is used only by the deferred type-tests — U10 does not touch it. | Core tests depend on these helpers and `tests-new → tests` imports are banned (D13). Both helpers have live non-core consumers (`fake-host`: 10; `temp-git-repo`: 1), so a shim keeps the still-green old suite resolving until those consumers relocate in U11–U13. Both helpers import `src/` via `../../src/...` and sit exactly two dirs deep both before (`tests/helpers/`) and after (`tests-new/_support/`) the move, so their relative `src/` imports are **unchanged** (the U2 invariant). |
| **PD3** | **Import-rewrite rules** | `../../../src/...` and `../../../../src/...` (prompt-file) → **unchanged** (depth-preserving move). `../../helpers/fake-host.ts` → `@orch/test/fake-host.ts`. `../../helpers/temp-git-repo.ts` → `@orch/test/temp-git-repo.ts`. `./_worktree-test-helpers.ts` → **unchanged** (relocates as a sibling). | `tests/unit/core/X` and `tests-new/unit/core/X` are both three dirs deep; `tests/integration/core/X` and `tests-new/integration/core/X` likewise. So every `src/` relative import has the identical `../` count after the move. Only the two cross-tree helper imports change, and they move to the `@orch/test/*` alias (already pointed at `_support/`, `tsconfig.json:28`). |
| **PD4** | **Build the parity guard here** | Ship `tests-new/_migration/import-parity.ts` (reusable AST check) + tests + a `check:import-parity` gate script in U10; U11–U13 reuse it. | U10 is the first relocation; R10 is a group-C-wide risk. Building the guard now (rather than U14) catches a mis-resolved `../` the moment it lands, and amortises across all four relocation phases. |
| **PD5** | **Ledger granularity** | **One `port` row per old file**, enumerating its cases in the "Old case" column (e.g. `(all 14 cases: …)`), with regression-pin run-IDs preserved in the reason. Follow the U7 precedent verbatim. | The parent requires case-granular accounting (D15), but the established house convention for **relocations** (U7a/U7b in `ledger.md`) records one row per file with a parenthetical case enumeration — 650 one-line rows would bury the signal. The enumeration satisfies "every child case is mapped" while staying reviewable. |
| **PD6** | **Old-file disposition** | Wrap every old core `test` file in unconditional `describe.skip`/`it.skip`/`test.skip` + a top `// MIGRATED → <new path> (parent U10)` marker, via a **reusable script** (`scripts/skip-migrated-u10.sh`). **Convert any `describe.skipIf(...)` → `describe.skip`** on the old copy so the U14 reconcile reads it as *migrated*, not *capability-skipped*. | Parent D2/D15 + R13: the reconcile AST scan distinguishes `skipIf` (capability) from unconditional `.skip` (migrated). The real-gated integration tests (`*-real.test.ts`) currently use `skipIf`; their old copies must flip to unconditional `.skip` while the **new** copies keep `skipIf` (capability gating is legitimate there, D8). A script keeps the edit mechanical and uniform (cf. [[prefer-scripts-over-complex-git]]). |
| **PD7** | **Sentinel cleanup** | Delete both `tests-new/unit/_pending-relocation.test.ts` and `tests-new/integration/_pending-relocation.test.ts` once real core tests land in each dir. | Their own header instructs deletion "the moment the first real unit test relocates here." Both buckets receive real tests in U10, so both sentinels go. `.gitkeep` files are harmless and may stay. |

---

## 4. Inventory (from the frozen baseline, parent D12)

**`tests/unit/core/` → `tests-new/unit/core/` (44 `.test.ts` + 1 asset; 6 `.test-d.ts` deferred to U13).**

- Top-level (mirror `src/core/`): `ask`, `command`, `commit`, `derive-step-key`,
  `errors`, `execution-context`, `failure-summary`, `interactive-mode`,
  `parallel`, `parallel-inherits-subworkflow-fields`, `resume-registry`,
  `run-mode`, `run-mode-tty-guard`, `run-step-once-collision`, `run-workflow`,
  `runner-addressing`, `schema`, `schema-validation`, `session-id-capture`,
  `step`, `step-lifecycle`, `types`, `types-step-name-pattern`, `view-registry`,
  `workflow`, `workflow-args`, `workflow-auto-stop`, `workflow-name-validation`,
  `workflow-parallel-lifecycle`, `workflow-resume-registry`, `workflow-tmux-guards`,
  `workflow-validators`, `workflow-vars-cache-key`, `worktree`,
  `worktree-executor`, `worktree-executor-cache`, `worktree-executor-conflicts`,
  `worktree-executor-postcreate` `.test.ts`.
- `prompt-file/` (4 dirs deep): `cache-key`, `caller-dir`, `load-prompt`,
  `resolve-prompt-path`, `step-define-prompt-file`, `substitute` `.test.ts`.
- Asset (relocates with cluster, no shim): `_worktree-test-helpers.ts`
  (consumed only by the four `worktree-executor*` tests, all in this phase).
- **Deferred to U13** (do **not** relocate or skip in U10): `ask-types.test-d.ts`,
  `run-workflow-typing.test-d.ts`, `step-runfn-typed-vars.test-d.ts`,
  `workflow-typing.test-d.ts`, `prompt-file/promptfile-registry.test-d.ts`,
  `prompt-file/template-vars.test-d.ts`.

**`tests/integration/core/` → `tests-new/integration/core/` (16 `.test.ts`).**

- `ask-lifecycle`, `ask-mocked`, `codex-thread-id-capture.integration`,
  `command-mocked`, `command-real`, `commit-mocked`, `commit-real`,
  `interactive-workflow`, `parallel-mocked`, `prompt-file-workflow`, `resume`,
  `typed-vars-workflow`, `validators-workflow`, `view-resolution`, `workflow`,
  `worktree-mocked`, `worktree-real` `.test.ts`. *(The `*-real` files are
  capability-gated with `skipIf` today — keep the gate in the new copy, PD6.)*

> The implementer must confirm this list against `baseline.json` at run time (the
> baseline is the source of truth, not this prose). The expected outcome:
> **61 `test` entries** under the two `core` prefixes end as `port` ledger rows;
> the **1 asset** relocates with the cluster; the **6 `type-test` entries** remain
> unassigned (explicitly deferred to U13).

---

## 5. Output structure

```
tests-new/
  _support/
    fake-host.ts                 # MOVED from tests/helpers/ (shim left behind) — PD2
    temp-git-repo.ts             # MOVED from tests/helpers/ (shim left behind) — PD2
  _migration/
    import-parity.ts             # NEW reusable AST parity guard (PD4)
    __tests__/import-parity.test.ts
    ledger.md                    # + "Relocated — core/** (parent U10)" section
  unit/
    core/                        # NEW — mirror of src/core
      *.test.ts                  # 38 top-level + 6 prompt-file
      prompt-file/*.test.ts
      _worktree-test-helpers.ts  # relocated asset
    # _pending-relocation.test.ts  ← DELETED (PD7)
  integration/
    core/                        # NEW — mirror of src/core
      *.test.ts                  # 16 files
    # _pending-relocation.test.ts  ← DELETED (PD7)
scripts/
  skip-migrated-u10.sh           # NEW reusable skip+marker script (PD6)
tests/
  helpers/fake-host.ts           # now a re-export shim → @orch/test/fake-host.ts
  helpers/temp-git-repo.ts       # now a re-export shim → @orch/test/temp-git-repo.ts
  unit/core/*.test.ts            # all .skip with // MIGRATED → markers (kept on disk, D2)
  integration/core/*.test.ts     # all .skip with // MIGRATED → markers
```

The per-unit **Files** sections below remain authoritative; this tree is the
scope shape.

---

## 6. Implementation units

Ordered. Each leaves `bun run check` green (new tests + still-running old suite).
A unit is done only when its Definition of Done holds.

### U10.1 — Build the reusable import-parity guard

**Goal.** Ship the AST-based parity check that every relocation phase (U10–U13)
runs, and wire it onto the gate. This lands **first** so the relocations in
U10.3/U10.4 are validated as they happen.

**Requirements.** Parent R10, D12; group-C verification (parent §7).

**Dependencies.** None (uses the existing `typescript` AST dep that
`overlap-report.ts`/`snapshot.ts` already use).

**Files (create/modify).**
- `tests-new/_migration/import-parity.ts` — exports a pure
  `parseSrcImports(text): Set<string>` (resolves each import's specifier to a
  canonical `src/<module>#<symbol>` tuple set, ignoring non-`src/` specifiers)
  and a `checkParity(oldPath, newPath)` that asserts the new file's `src/`
  symbol-set **equals** the old file's, that every import in the new file
  **resolves on disk**, and that no new-file import specifier points into
  `tests/` (cross-tree ban, parent D13). Reads source text + walks the TS AST —
  it must **not** import the test files (mirror the `overlap-report.ts` rule).
- `tests-new/_migration/__tests__/import-parity.test.ts` — unit tests.
- `package.json` — add `"check:import-parity": "bun run tests-new/_migration/import-parity.ts"`
  and include it in `check` (next to `overlap-report`). It takes the relocation
  map from the ledger's `port` rows (or a small committed manifest the script
  reads) so it self-updates as rows land.

**Approach.**
- Resolution: turn `../../../src/core/step.ts` (relative to the **new** file's
  dir) into an absolute repo-relative `src/core/step.ts`; pair each with its
  imported names. The same for the old file relative to **its** dir. Equality of
  the two `src/`-symbol sets is the parity assertion. Helper specifiers
  (`@orch/test/*`, `../../helpers/*`) are **excluded** from the parity set — they
  legitimately differ (alias vs shim) and are covered by the separate
  "resolves on disk" + "no `tests/` import" checks.
- Keep `import-parity.ts` ≤ 300 lines / functions ≤ 60 (CLAUDE.md rule 5); split
  pure-core (`parseSrcImports`) from the file-walking CLI shell.

**Patterns to follow.** `tests-new/_migration/overlap-report.ts` (AST parse, no
test imports, exit non-zero on findings, exported pure core +
`tests-new/_migration/__tests__/overlap-report.test.ts` shape).

**Test scenarios.**
- `parseSrcImports` returns the exact `{src/<module>#<symbol>}` set for a fixture
  with mixed `src/`, `@orch/test`, and `bun:test` imports; non-`src/` specifiers
  are excluded. *(happy)*
- `checkParity` **passes** when old and new files import the identical `src/`
  symbol set but differ only in helper specifier (`../../helpers/fake-host` vs
  `@orch/test/fake-host`). *(happy — the core relocation case)*
- `checkParity` **fails** when the new file's `src/` import has a wrong `../`
  count that resolves to a different module or to nothing (the R10 failure). *(critical)*
- `checkParity` **fails** when a new file imports anything under `tests/`
  (cross-tree ban). *(critical)* `Covers D13.`
- The script registers **zero** Bun tests when run (it AST-parses, never
  imports). *(edge)*
- `bun run check:import-parity` exits non-zero on a planted parity violation and
  zero on a clean tree. *(integration)*

**Verification.** `bun run check:import-parity` is green on the (still-empty)
relocation map; the guard's own tests pass under `bun run typecheck` + `bun test
tests-new/_migration/__tests__`. A deliberately mis-counted `../` in a scratch
fixture turns it red.

---

### U10.2 — Move shared helpers (`fake-host`, `temp-git-repo`) to `_support` with shims

**Goal.** Make the two cross-tree helper deps importable from `tests-new/` via
`@orch/test/*`, without breaking the still-green old suite.

**Requirements.** Parent D13, R11.

**Dependencies.** None (can run before or parallel to U10.1; must precede U10.3/U10.4).

**Files (move/create).**
- `tests-new/_support/fake-host.ts` ← moved from `tests/helpers/fake-host.ts`.
- `tests-new/_support/temp-git-repo.ts` ← moved from `tests/helpers/temp-git-repo.ts`.
- `tests/helpers/fake-host.ts` — replaced with a thin
  `export * from '@orch/test/fake-host.ts'` (+ `export type` re-exports as needed)
  re-export shim (parent D13).
- `tests/helpers/temp-git-repo.ts` — same shim treatment.
- Reuse/extend `scripts/move-test-infra-to-support.sh` (the U2 script) rather than
  hand-moving, to keep the shim shape uniform.

**Approach.**
- Both helpers import `src/` via `../../src/...` and are two dirs deep before
  (`tests/helpers/`) and after (`tests-new/_support/`) the move, so their
  internal relative imports are **unchanged** — verify with the U10.1 parity
  guard pointed at the helper move (or by `bun run typecheck`).
- The shim must re-export the **full public surface** the 10+1 live old consumers
  use (values **and** types). Confirm by `grep`-ing the named imports across the
  non-core consumers and by a green `bun run test:legacy` sample.
- Shims are deleted later, when the last old consumer of each helper is skipped
  (U11–U13 own that cleanup; U10 leaves the shims in place).

**Patterns to follow.** The U1/U2 moves of `type-assertions.ts`, `ink-frame.ts`,
and `behavioral-dsl/` (each left a re-export shim; see Phase 1/2 summaries and
`scripts/move-test-infra-to-support.sh`).

**Test scenarios.** *Test expectation: none — infra move.* Correctness is proven
by the existing suites: `bun run typecheck` resolves both new paths and both
shims; a sampled `bun run test:legacy` (old non-core consumers of `fake-host`)
stays green through the shim. Record the move (not as `port`/`drop` test rows but
as a D13 infra note) so U14 accounts for the helper entries via the `_support`
move, not as relocated tests.

**Verification.** `@orch/test/fake-host.ts` and `@orch/test/temp-git-repo.ts`
resolve under `typecheck`; the old shims resolve for the live non-core consumers;
no old test was skipped or edited beyond the two shim files.

---

### U10.3 — Relocate `tests/unit/core/**` → `tests-new/unit/core/**`

**Goal.** Move the 44 unit `.test.ts` + the `_worktree-test-helpers.ts` asset,
fix imports per PD3, and prove the new copies green.

**Requirements.** Parent D1, D3, D13; PD3.

**Dependencies.** U10.1 (guard), U10.2 (helpers in `_support`).

**Files (create).** `tests-new/unit/core/*.test.ts` (38 top-level),
`tests-new/unit/core/prompt-file/*.test.ts` (6),
`tests-new/unit/core/_worktree-test-helpers.ts`. Delete
`tests-new/unit/_pending-relocation.test.ts` (PD7).

**Approach.**
- Copy each file to its mirror path; apply the PD3 rewrites
  (`src/` imports unchanged; the two helper imports → `@orch/test/*`;
  `./_worktree-test-helpers.ts` unchanged). A codemod/`sed` over the two
  helper-specifier patterns keeps it mechanical; everything else is byte-copy.
- Do **not** split, rename, reorder, or edit any `describe`/`it` body — relocation
  only (parent R3). A pre-existing file-size lint **warning** travels with the
  file unchanged; do not "fix" it here.
- Run the U10.1 parity guard on each new file against its old original as the
  acceptance gate for the rewrite.

**Patterns to follow.** U7's relocations into `tests-new/model/controller/`
(byte-faithful move, import-depth fix, regression-pin preservation; see
`ledger.md` U7a/U7b rows).

**Test scenarios.** *Test expectation: relocation parity — same assertions, new
path.* Per parent group-C verification: a diff of old vs new is import paths only.
The acceptance checks are mechanical, not new test cases:
- `bun run test:new-unit` runs the relocated core unit tests green. *(happy)*
- Import-parity guard passes for every relocated file (same `src/` symbol-set;
  resolves; no `tests/` import). *(critical)* `Covers R10.`
- The four `worktree-executor*` tests resolve `./_worktree-test-helpers.ts` from
  the new sibling. *(integration)*

**Verification.** `bun run test:new-unit` green; `bun run typecheck` green;
`bun run check:import-parity` green for the unit-core map; sentinel deleted and
the bucket still non-empty (so green for a real reason).

---

### U10.4 — Relocate `tests/integration/core/**` → `tests-new/integration/core/**`

**Goal.** Move the 16 integration `.test.ts`, fix imports, preserve capability
gating on the `*-real` files, prove green.

**Requirements.** Parent D1, D3, D8, D13; PD3, PD6.

**Dependencies.** U10.1, U10.2.

**Files (create).** `tests-new/integration/core/*.test.ts` (16). Delete
`tests-new/integration/_pending-relocation.test.ts` (PD7).

**Approach.**
- Same mechanical move + PD3 rewrites as U10.3.
- The **new** copies of `command-real`, `commit-real`, `worktree-real`,
  `codex-thread-id-capture.integration` (and any other env/CLI-gated file) keep
  their existing `skipIf`/`describe.skipIf` predicates **verbatim** — capability
  gating prevents false failure on an incapable box and never *causes* a run
  (parent D8). Only the **old** copies flip to unconditional `.skip` (U10.5, PD6).
- Confirm no integration-core file imports a fixture/setup outside the two known
  helpers (the inventory found none; re-verify at run time before assuming).

**Patterns to follow.** Existing mocked-edge integration tests under
`tests/integration/core/` (unchanged three-layer model, CLAUDE.md "How to write
tests"); U8's relocation of gated lifecycle side-effect tests.

**Test scenarios.** *Test expectation: relocation parity.*
- `bun run test:new-int` runs the relocated mocked core integration tests green;
  the `*-real` tests auto-skip without their capability (CLI/git), proving the
  gate predicate survived the move. *(happy + gating)*
- Import-parity guard passes for every relocated integration file. *(critical)*

**Verification.** `bun run test:new-int` green; `*-real` files auto-skip off the
gate and run only under their capability; parity guard green for the
integration-core map; sentinel deleted.

---

### U10.5 — Skip the old core files, ledger, and reconcile-readiness

**Goal.** Wrap every old core `test` file `.skip` with a `// MIGRATED →` marker,
write the ledger section, and confirm the migration accounting is consistent with
the frozen baseline.

**Requirements.** Parent D2, D12, D15, R3, R13; PD5, PD6.

**Dependencies.** U10.3, U10.4 (new copies must be green before the old guard is
dropped).

**Files (create/modify).**
- `scripts/skip-migrated-u10.sh` — reusable: for each old core `test` file, wrap
  top-level `describe(`→`describe.skip(`, `it(`/`test(`→`.skip(`,
  **convert `describe.skipIf(...)`→`describe.skip`**, and prepend
  `// MIGRATED → <new path> (parent U10)`. Idempotent; takes the old→new map.
- `tests/unit/core/*.test.ts`, `tests/integration/core/*.test.ts` — `.skip` +
  marker applied by the script (content otherwise unchanged, kept on disk; D2).
- `tests-new/_migration/ledger.md` — new section
  `## Relocated — core/** (parent U10)` with **one `port` row per old file**
  (PD5), enumerating cases + preserving any regression-pin run-IDs from the file.

**Approach.**
- The script must skip only the 61 `test` files; it must **not** touch the 6
  `.test-d.ts` (PD1) or the relocated `_worktree-test-helpers.ts`.
- Each new relocated file is **not** a `scenario()`, so it carries no
  `oldTestRefs`/overlap metadata — the ledger row *is* its accounting (exactly the
  U7 `model/controller` precedent). Add a short prose note to the section header
  explaining this, mirroring U7.
- Verify reconcile-readiness by hand/AST: every old core `test` file is now
  unconditional `.skip` (not `skipIf`); every ledger row's `MIGRATED →` target
  exists on disk. (The U14 `reconcile.ts` does not exist yet — U10 only needs the
  inputs to be correct, not to run the U14 check.)

**Patterns to follow.** `scripts/skip-migrated-u7.sh`; the `ledger.md` U7a/U7b
section shape; the old skipped-file marker style
(`// MIGRATED → tests-new/... (parent U7) … kept skipped on disk (D2).`).

**Test scenarios.** *Test expectation: none — mechanical skip + documentation.*
Acceptance is structural:
- Every old core `test` file is unconditional `describe.skip`/`it.skip` (grep:
  no surviving non-skipped `it(`/`test(` at the top level; no `skipIf` left on a
  migrated file). *(critical — the D15 green-but-incomplete trap)*
- Every `// MIGRATED →` target path exists. *(critical)*
- The ledger section has one row per old file; every row is `port` with a reason;
  regression-pin IDs preserved. *(coverage)*

**Verification.** `bun run check` green (old core tests now skip, new ones run);
a grep confirms no old core file is left non-skipped or `skipIf`-gated; ledger
section complete; `tests-new/_migration/__tests__/snapshot.test.ts` still green
(the frozen baseline is untouched — U10 never regenerates it, parent D12).

---

## 7. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Mis-resolved `../` after the move** (R10): a wrong depth resolves to nothing or the wrong module while looking diff-identical. | Medium | U10.1 parity guard asserts identical `src/` symbol-set + on-disk resolution per file, run as the acceptance gate for U10.3/U10.4 — not just "`check` is green". Depth is in fact unchanged (PD3), so the guard mostly protects against a stray hand-edit. |
| **Shim under-exports** and a live non-core consumer breaks (R11). | Medium | U10.2 re-exports the full public surface (values + types); a sampled `bun run test:legacy` over `fake-host`'s non-core consumers must stay green before U10.3 proceeds. |
| **Skipping a file before every case is accounted** (D15 green-but-incomplete trap). | Medium | One row per file enumerating *all* cases (PD5); the U10.5 grep proves no non-skipped top-level `it(`/`test(` remains; the new copy is proven green first. |
| **`skipIf` mistaken for migrated** by the future U14 reconcile (R13). | Medium | PD6: old copies of `*-real` files flip `skipIf`→unconditional `.skip`; the new copies keep `skipIf`. The U10.5 grep explicitly checks no `skipIf` survives on an old migrated file. |
| **Accidental semantic edit during "relocation"** (R3 drift). | Low | No body edits permitted; rewrites limited to the two helper specifiers via codemod; a per-file old↔new diff should show import lines + the old-copy `.skip` wrap only. |
| **Type-test deferral leaves the old dir partially populated** and confuses accounting. | Low | PD1 documents the deferral explicitly; the 6 `type-test` baseline entries remain *intentionally unassigned* until U13. U10's DoD counts only the 61 `test` entries drained. |
| **Re-running the baseline snapshot** against the mutating tree (parent D12 hazard). | Low | U10 never regenerates `baseline.json`; `snapshot.test.ts` staying green confirms it. |

---

## 8. Definition of Done (U10)

- The 44 unit + 16 integration core `test` files run green from
  `tests-new/{unit,integration}/core/**` (`bun run test:new-unit` +
  `bun run test:new-int`); `_worktree-test-helpers.ts` relocated with them.
- `fake-host.ts` and `temp-git-repo.ts` live in `tests-new/_support/` with
  re-export shims at the old paths; the old non-core suite stays green through them.
- `tests-new/_migration/import-parity.ts` + tests + `check:import-parity` exist,
  are on the `check` gate, and pass for every relocated core file (same `src/`
  symbol-set, resolves, no `tests/` import).
- Every old core `test` file is unconditional `.skip` with a `// MIGRATED →`
  marker (kept on disk, D2); no `skipIf` survives on a migrated old file.
- `tests-new/_migration/ledger.md` has a `## Relocated — core/** (parent U10)`
  section: one `port` row per old file, all cases enumerated, regression-pins
  preserved.
- Both `_pending-relocation.test.ts` sentinels deleted.
- The 6 core `.test-d.ts` type-tests are untouched and explicitly deferred to U13.
- `bun run check` green except for the documented, pre-existing 5 `ENOENT`
  fixture failures under gitignored `.orch/` (unrelated to this phase).
- `tests-new/_migration/__tests__/snapshot.test.ts` green (frozen baseline
  untouched). `bun run typecheck` + `bun run lint` clean (no new warnings
  introduced by the move).
```
