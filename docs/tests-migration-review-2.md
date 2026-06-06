# Tests Migration Review - Codex

Date: 2026-06-06

## Verdict

The migration appears to have broadly succeeded at promoting the new test suite:
`tests-new/` is gone, active package scripts point at `tests/`, `tsconfig` includes
`tests`, and `bun run check` passes in an unrestricted local environment with real
tmux available.

It is not a clean closeout yet. The final tree still carries stale migration
docs, stale repo-local skills, broken or false-green migration oracles, and a
release gate that can skip the real coverage it claims to run. Those issues do
not mean the migrated test bodies are broadly wrong, but they do mean the branch
is not yet self-auditable and future contributors can easily write tests in the
wrong place or trust a stale guard.

## Review Inputs

Primary evidence:

- `docs/plans/phase-summaries.md`
- `.orch/state/r-2026-06-05-175103-nt/`
- Commits `426c546`, `b34a6b1`, `8b7cd60`, `735ba6d`, `7cb45f0`, `df3ca1b`,
  `ac8c3a4`, `2e29dd5`, `bf3dd25`, `a406f0a`, `80d35c2`, `91ae1e6`,
  `f761ab2`, `0742468`, `c99a364`
- Current HEAD files under `tests/`, `docs/`, `.claude/skills/`, and scripts.

Subagent perspectives used:

- Completeness and ledger accounting.
- Current gates and package scripts.
- DSL/driver fidelity and behavioral downgrades.
- Final tree cleanup and stale references.
- Orchestration execution logs.

## Verification I Ran

- `bun run typecheck` passed.
- `bun run tests/_migration/reconcile.ts` failed at HEAD with
  `ENOENT: tests-new/_migration/baseline.json`.
- `bun run tests/_migration/overlap-report.ts` failed at HEAD with
  `ENOENT: scandir 'tests-new'`.
- `bun run tests/_migration/import-parity.ts` passed falsely with
  `relocation pairs checked: 0`.
- `bun run test:two-pane:fast` failed once in the restricted sandbox in
  `tests/model/subworkflow--boundary-selection.test.tsx`, then the isolated file
  passed, and a full unrestricted `bun run check` later passed. Treat this as
  a possible timing/order flake to watch, not a proven deterministic failure.
- `bun run check` failed inside the restricted sandbox because tmux could not
  create sockets under `/private/tmp/tmux-501` (`Operation not permitted`).
  Rerunning unrestricted passed: lint, typecheck, unit, integration, e2e,
  two-pane tmux, and lifecycle all completed green.

## What Looks Good

1. The orchestration run completed all phases and final verification.

   `.orch/state/r-2026-06-05-175103-nt/state.json` has `status: completed`.
   The logs show plan/work steps for phases 1-14, a finalization step, and
   `command:verify-check`. The final command was `bun run check` and exited 0.
   There was a transient `plan-phase-8` API overload, but it was retried and the
   run continued.

2. The active test tree has been promoted.

   `tests-new/` no longer exists. Active scripts point at `tests/`: for example
   `test:unit`, `test:int`, `test:e2e`, and the two-pane buckets in
   `package.json:20-35`. `tsconfig.json` includes `tests` and maps
   `@orch/test/*` to `tests/_support/*`.

3. The default local gate is currently green in the intended environment.

   The unrestricted `bun run check` completed with 0 failures, including real
   tmux integration and serial lifecycle buckets. The sandbox failure mode was
   environmental: tmux socket creation under `/private/tmp` was denied.

4. The migration had serious accounting infrastructure before final promotion.

   The phase summaries and logs show a frozen baseline, case-granular ledger,
   overlap report, import parity, and final pre-promotion reconciliation. The
   finalize step also fixed the previously documented `.orch` fixture failures
   by adding tracked fixtures.

## Findings

### P1 - Migration oracles are broken or false-green at HEAD

The retained migration tools still hard-code the old pre-promotion paths:

- `tests/_migration/reconcile.ts:34-35` reads
  `tests-new/_migration/baseline.json` and `tests-new/_migration/ledger.md`.
- `tests/_migration/overlap-report.ts:27-28` scans `tests-new` and reads a
  `tests-new` baseline.
- `tests/_migration/import-parity.ts:29` reads
  `tests-new/_migration/relocation-map.json`, while `tests/_migration/import-parity.ts:39`
  still maps `@orch/test/*` to `tests-new/_support/`.
- `tests/_migration/import-parity.ts:194-196` returns an empty pair list when
  the map is missing, so it can print success while checking zero relocated files.

This is the biggest closeout risk. The migration tooling is retained under
`tests/_migration`, but cannot prove the final tree. Worse, one tool returns a
successful result that looks meaningful but is not.

Recommendation:

- Decide explicitly whether `tests/_migration` is archival or active.
- If archival: add an `ARCHIVE.md` or top-level comments saying the tools are
  not valid after promotion, and remove/exclude their tests from active scripts.
- If active: repoint all constants to `tests`, make zero relocation pairs a
  failure, and restore scripts such as `reconcile`, `overlap-report`, and
  `check:import-parity`.

### P1 - Ledger completeness was never made strict after final promotion

The migration summary says ledger completeness was non-blocking and intended for
a later phase. `tests/_migration/ledger.md` also records that strict #2 would
need normalization before promotion. Final commit `c99a364` removed the migration
guards from active package scripts instead of making the final accounting gate
self-contained.

That leaves the final state relying on pre-promotion audit logs and agent
summaries. Those are useful evidence, but they are not a rerunnable invariant at
HEAD.

Recommendation:

- Normalize ledger rows to a machine-readable key: baseline path, case name/hash,
  disposition, target path(s), and reason.
- Promote strict ledger completeness at least once against the final tree.
- Keep the generated report in `docs/` so future reviewers do not need to replay
  the entire orchestration log to understand what was dropped or demoted.

### P1 - Release gate can pass while real coverage is skipped

`package.json:15` defines:

```sh
bun run lint && bun run typecheck && bun run test:project && bun run test:e2e:real && bun run test:two-pane:lifecycle && bun run test:two-pane:full:real
```

But `package.json:34` sets only `RUN_REAL_E2E=1` for `test:e2e:real`, while
the two-pane real-agent and real-tmux e2e gates require `RUN_REAL_TMUX_E2E=1`.
Some real Claude e2e files also require runner-specific env such as
`RUN_REAL_CLAUDE=1`. As written, `check:release` can report green while the real
CLI/real-agent tests skip.

There is also a runner-specific mismatch: both current full-host real-agent
scenarios use `claudeAgent(...)`, but the driver-level availability predicate is
broader than "Claude is available." On a machine with Codex but no Claude, a
Claude-only scenario can try to run instead of skipping correctly.

Recommendation:

- Add a release preflight that fails unless the intended real-test envs and CLIs
  are present.
- Make `test:e2e:real` and `test:two-pane:full:real` set or require the actual
  env vars they need.
- Make real-agent scenario skipping runner-specific: a Claude scenario should
  require Claude; a Codex scenario should require Codex.

### P1 - Active guidance still tells authors to use `tests-new`

The final tree is `tests/`, but active documentation still describes a
mid-migration world:

- `CLAUDE.md:42` says the repo is mid-relocation into `tests-new`.
- `CLAUDE.md:47` tells scenario authors to import from `tests-new/dsl/index.ts`.
- `CLAUDE.md:56` links to `tests-new/dsl/` and `tests-new/_support/real-tmux/`.
- `docs/testing-strategy.md:47`, `docs/testing-strategy.md:77`,
  `docs/testing-strategy.md:95`, `docs/testing-strategy.md:110`,
  `docs/testing-strategy.md:154-162`, and `docs/testing-strategy.md:204`
  all contain stale `tests-new` routing or examples.
- `docs/testing-strategy.md:183` still describes final repointing as future work.

Recommendation:

- Update `CLAUDE.md`, `docs/testing-strategy.md`, `README.md`, repo-local
  `.claude/skills/*`, and support READMEs to the final `tests/` and
  `tests/_support/` paths.
- Remove "during migration" routing from active author guidance.
- Move purely historical migration detail into `docs/plans/` or an explicit
  archived section.

### P1 - Real-tmux integration tests now run unbounded through `test:int`

`package.json:32` runs `bun test tests/integration` without a concurrency cap.
That includes many real-tmux tests under `tests/integration/real-tmux` and
`tests/integration/services/tmux`, gated only by tmux availability.

The migration design repeatedly says real-tmux concurrency must be encoded as
flags. The two-pane bucket does this (`package.json:27` has
`--max-concurrency=2`), but `test:int` bypasses it.

Recommendation:

- Split real-tmux integration into a capped script, for example
  `test:int:real-tmux` with `--max-concurrency=2`.
- Make `test:int` exclude real-tmux directories or call sub-buckets explicitly.
- Keep `check` green in normal local environments, but make the concurrency
  guarantee true by construction.

### P2 - Some behavioral coverage was downgraded during closeout

The closeout ledger explicitly drops or demotes several old real-fidelity
behaviors as disproportionate or already covered elsewhere. The judgment may be
reasonable, but these are residual behavioral risks, not pure accounting noise.

Examples called out by the audit:

- Auto-stop event ordering and pane-exit race.
- Real-host per-step artifact wiring.
- Real driven-host resume orchestration.
- Command stdout through the real command-host pipe.
- Key intent mapping: old tests pressed actual `StepsView` keys including `q`;
  some current coverage checks hints or injects intents at the driver seam.
- Empty steps behavior: old placeholder/no-op behavior appears to have been
  dropped even though the synthetic model/screen substrate can represent empty
  step lists.

Recommendation:

- Add targeted follow-up tests for the residual high-risk cases instead of
  reopening the whole migration.
- In particular, add a fast component/model harness that presses `q`, Enter,
  Esc, `f`, `?`, and arrows against `StepsView` with an intent spy.
- Add model/screen empty-state tests, or explicitly make empty step lists
  unsupported and document that product decision.

### P2 - Lifecycle app typing over-promises unsupported pane actions

The migration goal says unsupported driver actions should be compile errors.
However, lifecycle scenarios still expose broad `leftPane` and `rightPane`
objects, while the lifecycle backend throws `notImplemented` for most pane
content/snapshot methods. That means some invalid lifecycle scenarios compile
and fail only at runtime.

Recommendation:

- Either implement snapshot-backed lifecycle pane reads, or narrow the lifecycle
  app surface to the methods it actually supports.
- Add negative type tests so a lifecycle-only scenario cannot call content
  methods that the lifecycle driver cannot satisfy.

### P2 - Final deletion deviated from documented "keep old tests" policy

Phase 14 and the ledger repeatedly describe keeping old skipped test files on
disk. The finalization step deleted old `tests/` and renamed `tests-new/` to
`tests/`. That may be the right final state, but it is a policy deviation and
should be recorded as such.

Recommendation:

- Add a short final closeout note explaining why old skipped files were deleted,
  how to audit them from commit `0742468`, and what evidence replaces the
  on-disk skipped-old-file convention.

### P2 - Stale migration scripts are dangerous in a final tree

One-shot scripts under `scripts/` still target `tests-new` or mutate old-test
state. In a final tree, they are easy to run by mistake and hard to reason about.

Recommendation:

- Delete them, or move them under an archived migration directory with a clear
  "do not run on HEAD" README.

### P3 - E2E relocation sentinel remains

`tests/e2e/_pending-relocation.test.ts` remains even though real e2e tests now
exist under `tests/e2e`.

Recommendation:

- Delete the sentinel.

## Suggested Fix Order

1. Repair or archive `tests/_migration`. Do not leave false-green tooling at
   HEAD.
2. Update active author guidance from `tests-new` to `tests`.
3. Fix `check:release` so real coverage cannot silently skip.
4. Split/cap real-tmux integration out of unbounded `test:int`.
5. Add targeted tests for key-intent mapping and empty-step behavior.
6. Narrow or complete lifecycle pane typing.
7. Delete the e2e sentinel and archive one-shot migration scripts.
8. Record the final old-test deletion policy deviation.

## Bottom Line

The migration is much closer to successful than not: the promoted suite runs,
the orchestration completed, and the unrestricted gate is green. The remaining
work is closeout quality and future-proofing. Fix the stale oracles, stale docs,
release-gate skips, and the small set of explicit behavioral downgrades before
calling the migration fully done.
