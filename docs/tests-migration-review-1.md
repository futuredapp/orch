# Test-suite migration — post-mortem review

**Date:** 2026-06-06
**Branch:** `feat/cmux-integration`
**Scope reviewed:** the autonomous testing-strategy restructure executed by
`workflows/execute-plan/index.ts` against
`docs/plans/2026-06-05-001-refactor-testing-strategy-restructure-plan.md`, across
commits `426c546` (phase 1) → `c99a364` (finalize).
**Method:** four parallel audit sub-agents (gate/green verification, completeness
vs. the frozen baseline, run-log forensics on the `finalize` step, and a
weakened/vacuous-test hunt) plus direct inspection of the run logs at
`.orch/state/r-2026-06-05-175103-nt/`.

---

## TL;DR verdict

**The migrated suite is real and substantively sound, and `bun run check` is
green.** The actual test *work* was done with unusual discipline — a frozen
baseline, a 2.5k-case ledger, content-asserting DSL scenarios, and per-phase
verification. Spot-checks across core/runners/cli/two-pane/lifecycle found
matching case counts and genuine assertions, not stubs.

**But the migration was finished one phase too early by a blunt `finalize`
step, and that step disabled the very machinery designed to *prove* the
migration was complete.** The plan's final unit — **U14 "Reconciliation"** — was
supposed to promote the completeness oracle to a blocking gate, flip the gate
onto the new tree, and update docs/skills. Instead the workflow's generic
`finalize` step deleted the old tree and renamed `tests-new/ → tests/`, which:

- left the three completeness oracles (`reconcile.ts`, `import-parity.ts`,
  `overlap-report.ts`) **broken** (stale `tests-new/` paths) and **off the
  gate**, so completeness can no longer be re-verified and nothing guards
  against future drift;
- did exactly the delete-and-rename move the plan's **risk R13** explicitly
  warned makes reconciliation "pass vacuously over a shrunken tree."

Completeness *was* genuinely verified green at the moment of deletion (the
`finalize` agent ran the oracles and an audit sub-agent before deleting), so
there is **no evidence coverage was lost**. The problem is that the proof is no
longer reproducible from `HEAD`, and a handful of small real gaps slipped
through. Net: ship-able, but it needs a short clean-up pass to restore
verifiability and close the loose ends below.

---

## What went well (keep doing this)

- **Frozen baseline + ledger.** `tests/_migration/baseline.json` (425 files,
  2517 cases, never regenerated) plus a case-granular `ledger.md` is the right
  design and was honoured throughout. Every drop has a written reason.
- **Content-asserting DSL.** Two-pane scenarios assert real pane content/decisions
  via co-located `TEXT`/`COLOR` specs (not imported from `src/`), so a production
  wording/colour typo turns a test red. This passes the project's own
  "would it still pass if the pane were empty?" triage.
- **Honest deviations.** Real judgment calls (e.g. `persistedStatus('cancelled')`
  not assertable on current `main`; W6 shim deletion blocked by load-time import
  resolution) were documented in summaries and the ledger rather than hidden.
- **The 5 long-standing `.orch/` ENOENT fixture failures are now fixed** — the
  migration rewrote those tests onto tracked fixtures under
  `tests/_support/fixtures/` instead of gitignored disk reads.
- **The finalize agent verified before deleting** — it ran `reconcile` +
  `import-parity` green, dispatched an audit sub-agent that spot-checked 17
  markers and *caught two real runtime leaks* (`workflow-fixtures.ts`,
  `bunfig.toml`) and fixed them before the delete.

---

## Findings & suggestions, by severity

### 🔴 Critical

#### C1 — The completeness oracles are broken and off the gate
`reconcile.ts`, `overlap-report.ts`, and `import-parity.ts` all hardcode
`tests-new/` paths (e.g. `reconcile.ts:34-35`). After the rename:
- `reconcile.ts` → **crashes** (`ENOENT tests-new/_migration/baseline.json`);
- `overlap-report.ts` → **crashes** (`scandir 'tests-new'`);
- `import-parity.ts` → **runs but is vacuous**: `relocation-map.json` still points
  at `tests-new/` paths, so `loadRelocationMap()` returns `[]` and it prints
  `relocation pairs checked: 0 … ✓` — a **false green**.

None of the three are referenced by any `package.json` script. `bun run check`
is `lint && typecheck && test && test:two-pane:lifecycle` — the migration's own
guards are absent.

**Suggestion.** Decide their post-migration role explicitly:
- If they remain meaningful (they do — `reconcile` proves baseline completeness;
  `import-parity` proves no test reaches a dead module), **repoint them to
  `tests/`** (`tests-new/`→`tests/` in all three + `relocation-map.json`), make
  `reconcile` operate against the now-single tree, and **add
  `reconcile`/`import-parity` scripts to `package.json` and onto `check`** so
  drift is caught. This is the deferred U14 work.
- If they are genuinely single-use, **delete them** rather than leaving broken,
  false-green scripts in the tree that look like guards but aren't.

Either way, do not leave a script that exits `0` while checking nothing.

#### C2 — Plan unit U14 "Reconciliation" was never executed
`count-phases` returned **14** and the loop ran phases 1-14, but execution
drifted by one: phase 14 was spent on the **group-B closeout** (the work Phase
13's handoff flagged), so the plan's actual final unit — **U14 Reconciliation**
(plan §"Phase group D", lines 910-938: *promote reconcile to blocking, flip the
default gate onto the new tree, add assertions #4-#6, final docs/skills
reconcile, record the restructure as landed*) — was simply never reached. The
generic `finalize` step (delete + rename) ran instead and did **only** the
delete/rename, not U14's verification-hardening responsibilities.

**Suggestion.** Run a dedicated U14 reconciliation pass now (manually or as a
one-off workflow), covering the items it owned: oracle-on-gate (C1),
assertions #4-#6 in `reconcile.ts` (overlap-report integration, check-gate
assertion, docs/skills tier-grep clean), and the "record as landed" doc updates.
Separately, fix the workflow process lesson in **L1** below so a phase-count
drift can't silently drop the most important phase again.

### 🟠 High

#### H1 — Completeness is no longer reproducible from HEAD
The plan's **R13** ("a file deleted/renamed rather than skipped vanishes from a
live scan, so completeness passes vacuously over a shrunken tree") was mitigated
by D2/D12: keep every old file on disk `.skip`'d forever and reconcile against
the *frozen* baseline. The `finalize` step deliberately deleted the `.skip`'d
old tree (per its own prompt instruction), removing that safety net. Re-running
`reconcile` today against the merged tree reports ~1986 "unaccounted" — this is
a **false alarm** caused by the broken oracle + deleted archive, **not** lost
coverage (coverage was verified green at deletion time). But it means the only
record of "what used to exist" is now `baseline.json`/`baseline.md`, and the
only place the full proof reproduces is the git history at `0742468`.

**Suggestion.** Once C1 is fixed, re-run the repaired `reconcile` against the
frozen baseline and the merged tree and confirm it comes back clean — that
restores a reproducible proof. Add a short note to `ledger.md` / the plan
recording that the `.skip`'d archive was intentionally removed at `c99a364` and
that `0742468` is the last commit where the dual-tree proof reproduces.

#### H2 — Oracle unit tests are off the gate and one is failing
`tests/_migration/__tests__/` (≈38 tests for the migration tooling) is not run
by any `package.json` script, and `snapshot.test.ts` currently **fails**: it
expects `tests/helpers/` to classify as `helper`, but that dir was moved to
`tests/_support/`, leaving a dead classification rule in `snapshot.ts:55`.

**Suggestion.** If the migration tooling is being kept (C1), fix the stale
`snapshot.ts` rule and put `tests/_migration/__tests__/` on the gate. If the
tooling is being retired, delete the tooling and its tests together.

### 🟡 Medium

#### M1 — Real coverage gaps from `drop` dispositions
The drops are mostly defensible, but three are genuine holes, all
acknowledged in `ledger.md`:
- **Uppercase-`F` follow-live keymap.** `src/hosts/two-pane/steps-view/steps-view.tsx:267`
  handles `input === 'f' || input === 'F'`, but only lowercase `f` is exercised
  — the `F` branch is now tested nowhere (dropped: DSL has no raw-keystroke
  primitive).
- **`steps=[]` empty/pre-first-step state.** The initial empty frame and its
  "no hairlines around empty state" rendering are untested at any fidelity
  (dropped: `launch({steps:[...]})` can't express zero steps).
- **Four C6 real-host behavioural cases** — `auto-stop` stop-channel
  ordering/race, `per-step-artifacts` end-to-end, `resume` orchestration
  end-to-end, and `command` output streaming — dropped/demoted for lack of a
  faithful fake substrate. Component-level twins exist but the end-to-end
  wiring is uncovered.

**Suggestion.** File these as tracked follow-ups (not blockers). The cheapest
wins: add a raw-keystroke DSL primitive to cover `F` and revive the two
`steps=[]` cases; the four C6 cases need a host-integration fixture and should
be scoped as their own small task rather than left implicit.

#### M2 — Two vacuous-pass assertions (pre-existing, surfaced by the audit)
`tests/unit/state/state-store.test.ts:159` and `:253` use
`expect(promise).rejects.toThrow(...)` **without `await`** — if the code under
test stops throwing, these pass silently. Introduced in phase 12, not by
finalize, but they weaken the "loadRun throws on corrupt JSON" / "setStatus
throws for unknown run" guarantees.

**Suggestion.** Add the missing `await` (two-line fix).

#### M3 — `_support` shims / sentinels left behind by the early finish
The deferred **W6** (delete the four `_support` re-export shims) was blocked
*while the old tree existed*; now that the old tree is gone, that blocker is
moot, but the cleanup wasn't done. Also `tests/e2e/_pending-relocation.test.ts`
(an `expect(true).toBe(true)` sentinel that says "delete me when real e2e tests
land here") is still present even though `tests/e2e/` now has 5 real test files.

**Suggestion.** Re-evaluate the `_support` re-export shims now that the old
consumers are deleted — remove any that are dead. Delete the `_pending-relocation`
sentinel(s) in directories that now contain real tests.

### 🟢 Low / cosmetic

- **L-lint:** `biome.json` pins schema `2.4.10` while the CLI is `2.4.16` (one
  info), and there are 31 pre-existing `noExcessiveCognitiveComplexity` warnings
  in `src/`. Non-blocking; run `biome migrate` if you want the info gone.
- **Stale invocation comments:** several `tests/_migration/*.ts` headers still
  say `bun run tests-new/_migration/…`. Fix alongside C1.

---

## Process lesson for the orchestration itself

#### L1 — A phase-count drift silently dropped the most important phase
The root cause of C2 is structural, not an agent mistake: `count-phases`
returns a single integer and the loop runs `1..N` with a *generic* `finalize`
afterward. When the agents inserted an extra closeout phase mid-run, the plan's
real final phase (U14) fell off the end of the loop, and the generic `finalize`
silently stood in for it — doing the destructive half (delete/rename) without
the verification half (promote oracle, flip gate, prove complete).

**Suggestions for `execute-plan`:**
- Make the destructive `finalize` **refuse to delete the old tree unless the
  completeness oracle passes** as an explicit pre-condition step (`reconcile`
  exit 0) — fail closed, not open.
- Have `finalize` **repoint and re-run** the migration's own guards as part of
  its contract, rather than assuming a separate phase did it.
- Consider keying the loop on named phases from the plan rather than a bare
  integer count, so an inserted phase can't push the terminal phase out of range.

---

## Suggested action checklist (in priority order)

1. **[C1/C2/H1]** Repoint `reconcile.ts`, `import-parity.ts`, `overlap-report.ts`
   and `relocation-map.json` to `tests/`; re-run `reconcile` against the frozen
   baseline; confirm clean. Add `reconcile` + `import-parity` to `package.json`
   and onto `bun run check`. *(restores the proof + ongoing guard)*
2. **[H2]** Fix the stale `snapshot.ts` `tests/helpers/` rule and put
   `tests/_migration/__tests__/` on the gate — or retire the tooling wholesale.
3. **[M2]** Add the two missing `await`s in `state-store.test.ts`.
4. **[M3]** Delete dead `_support` shims and the now-obsolete
   `_pending-relocation` sentinel(s).
5. **[M1]** File tracked follow-ups for the uppercase-`F` keymap, the `steps=[]`
   empty-state, and the four C6 real-host behavioural cases.
6. **[C2 docs]** Record the restructure as landed (the doc half of U14):
   update `docs/plans/implementation-phases.md` and confirm `CLAUDE.md` /
   `docs/testing-strategy.md` are tier-free.
7. **[L1]** Harden `execute-plan`'s `finalize` to fail closed on an unproven
   migration.

---

## How to re-verify (reproduce this review)

```bash
# Gate (currently green):
bun run check

# The oracles (currently broken/off-gate — see C1):
bun tests/_migration/reconcile.ts        # crashes on tests-new/ path today
bun tests/_migration/import-parity.ts    # false green: "pairs checked: 0"
bun tests/_migration/overlap-report.ts   # crashes on scandir tests-new

# The last commit where the dual-tree completeness proof reproduces:
git stash; git checkout 0742468 -- .   # (phase 14 complete) — for archival check only

# Run logs analysed:
.orch/state/r-2026-06-05-175103-nt/logs/agents/{finalize,work-phase-14}/events.ndjson
```
