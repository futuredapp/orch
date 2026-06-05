# Codex Code Review — Testing Strategy Restructure Plan

Read-only plan review run by four parallel Codex subagents (GPT-5, codex-tui v0.137.0), each given a different reviewer lens. All four reviewed the same document:

- **Plan reviewed:** [docs/plans/2026-06-05-001-refactor-testing-strategy-restructure-plan.md](plans/2026-06-05-001-refactor-testing-strategy-restructure-plan.md)
- **Prompt:** *"Use subagents to review this plan and provide feedback. Any bugs, issues? Will we convert everything with this approach? Do not change anything, just provide feedback."*
- **Date:** 2026-06-05

Extracted from Codex session rollouts (`~/.codex/sessions/2026/06/05/`):

| Session ID | Reviewer lens |
| --- | --- |
| `019e9837-3809-7a53-9182-10d907d420d1` | Coherence & traceability |
| `019e9837-4d2e-7532-9e38-2fd1cb8b0eec` | Technical feasibility & migration risk |
| `019e9837-6684-7053-a6b7-176bfa7db9d5` | Scope guardian |
| `019e9837-7bc7-7f80-a568-e3cf66416c29` | Adversarial |

## Cross-cutting consensus

All four reviewers independently agreed the two-pane DSL/driver direction is sound, but the **whole-repo "convert everything" claim is not yet airtight**. The recurring blockers across reviews:

1. **No mechanical whole-repo inventory.** Phases name `src/` module clusters but omit `tests/helpers`, `tests/fixtures`, `tests/setup`, `hosts/**`, `.test-d.ts` type-tests, and assets. Fix: generate a baseline manifest from `tests/` early (U1/U3) and reconcile against it, not against prose phase groupings.
2. **File-level ledger is too coarse.** A single old file holds many `it()`/`test()` cases; skipping the whole file after porting one scenario produces green-but-incomplete coverage. Fix: ledger at test-case granularity.
3. **Helper ownership contradicts the "no cross-tree imports" rule.** Drivers are told to reuse `tests/helpers/**`, but U10-U13 forbid `tests-new/` importing from `tests/`. Fix: move helpers to `tests-new/helpers` or `test-support/` and update `@orch/test/*` paths.
4. **Concurrency ceiling is described but not encoded.** §8 uses plain `bun test` commands; D6's serial/bounded real-tmux promise has no runner mechanism. Fix: explicit `--max-concurrency` flags / wrapper per tmux bucket.
5. **E2E falls out of the gate.** `test:legacy` only runs `tests/unit tests/integration`; no `test:new-e2e` exists. Fix: add e2e gating and include old `tests/e2e` until migrated.
6. **Scenario typing sketch is likely wrong.** Indexing a tuple (`AppFor<typeof meta.drivers[number]>`) yields a union, not the claimed capability intersection; the `app.press?.(...)` example weakens the guarantee. Fix: `scenario<const D extends readonly DriverName[]>` plus `@ts-expect-error` negative tests.

---

## Review 1 — Coherence & traceability (`019e9837-3809`)

Read-only review complete. I reviewed it through coherence, feasibility, and scope-guardian lenses. Main answer: **not reliably yet**. The plan's intent is whole-repo conversion, but the current phase trace does not prove every test is converted.

**Findings**

1. **High: Whole-repo conversion is claimed, but Phase C does not inventory the whole repo.**
   §1 lines 42-56 claims every other repo test relocates. U10-U13 lines 699-720 group by `src/` modules, but current tests also include helpers, setup, examples, non-two-pane hosts, real-tmux harness tests, and top-level e2e files. I counted 355 test files: 192 unit, 156 integration, 7 e2e.
   Suggested fix: add a mandatory baseline manifest generated from `find tests -type f ...`, then assign every file to a U-phase before implementation starts.

2. **High: The transition gate omits existing `tests/e2e`.**
   §8 lines 789-796 defines `test:legacy` as only `tests/unit tests/integration`, so existing `tests/e2e/**` drops out before U13. This contradicts the claim that non-two-pane tests stay on the gate throughout at lines 799-802.
   Suggested fix: include `tests/e2e` in `test:legacy`, and add `test:new-e2e` to `test:project`.

3. **High: Real-tmux concurrency is "locked" but not actually encoded.**
   D6 says the ceiling is encoded in the script ladder (line 119), but §8 lines 780-783 only comments "§D6 concurrency ceiling"; it does not specify a runner mechanism. Lifecycle also says serial but has no serial enforcement.
   Suggested fix: specify exact Bun flags, wrapper, file split, or scheduler mechanism per tmux bucket.

4. **High: Scenario typing promise is internally inconsistent.**
   §5.3 lines 278-293 claims driver arrays infer capability intersections and unsupported actions type-error. But the worked model example uses `app.press?.(...)` (line 863), which weakens that guarantee.
   Suggested fix: make the API shape explicit with generic tuple inference and compile-time tests, or remove the intersection claim.

5. **Medium: "Keep skipped forever" conflicts with cited "no long-lived dual suite" requirement.**
   D2 keeps old tests forever (line 115), while U14 cites spec §10 "no long-lived dual suite" (line 731).
   Suggested fix: clarify "no long-lived dual **live** suite"; archive is all-skip and excluded from normal assertions except reconciliation.

6. **Medium: Acceptance criteria overstate "every behaviour is written once as a scenario."**
   DoD lines 1133-1134 conflicts with `tmux-argv` being plain unit tests (lines 255-257) and non-two-pane tests staying normal `bun:test`.
   Suggested fix: change to "every two-pane behavioral scenario that spans fidelities."

7. **Medium: Reconciliation can catch omissions, but only at the end.**
   U14 requires every old file ledgered (lines 741-746), but earlier phases do not require a global remaining-files report. Missing categories may surface only after U10-U13 are "done."
   Suggested fix: make the ledger completeness report exist in U3 and run non-blocking from then on, showing remaining unassigned files by phase.

Net: the plan is coherent for the **two-pane DSL migration**, but the **whole-repo conversion claim needs a manifest-driven accounting pass and script fixes** before it is safe to hand to autonomous phases.

---

## Review 2 — Technical feasibility & migration risk (`019e9837-4d2e`)

Read-only review complete. I found several migration risks; the approach is implementable, but as written it will not prove full conversion.

**Findings**

1. **Critical: `tests-new/` is not typechecked, so the typed DSL guarantees are not enforced.**
   The plan relies on type errors for unsupported driver actions in U1/§5.2/§5.3, but current `tsconfig.json` (line 24) includes only `src`, `tests`, and `examples`. `bun test` transpiles; it does not replace `tsc --noEmit`.
   Fix: add `tests-new` to `tsconfig.include` in U1, and make negative type assertions real `@ts-expect-error` files covered by `typecheck`.

2. **Critical: the Bun/tmux concurrency ceiling is promised but not encoded.**
   D6 and §8 say lifecycle is serial and screen/full-host are bounded, but the script ladder uses plain `bun test` commands at plan:781 and plan:795. Bun's default max concurrency is 20. Worse, `test:legacy` still runs `tests/integration`, which includes existing lifecycle/real-tmux tests, until late migration.
   Fix: encode `--max-concurrency=1` for lifecycle and a small explicit value for tmux buckets; split old real-tmux/lifecycle legacy paths into their own bounded scripts.

3. **Critical: `check:release` can pass by skipping the real-agent tests.**
   U3 says release "requires `which claude codex`" at plan:615, but the actual script at plan:796 has no hard preflight, while §9.7 says real-agent auto-skips when tools are missing.
   Fix: add a release preflight that fails if `tmux`, `claude`, or `codex` is unavailable, and make the real-agent driver fail instead of skip under release mode.

4. **High: final reconciliation is file-level, not test-case-level, so it can miss partial migrations.**
   U14 checks every old file appears in the ledger and is fully skipped at plan:741, but one old file can contain many `it()` cases. A file could be skipped after only one scenario is ported. Also `oldTestRefs` is optional at plan:274.
   Fix: create an initial inventory of every old test case: file, test name, line, stable hash. Make ledger rows test-case keyed, require `oldTestRefs`/disposition for every case, and reconcile against that snapshot.

5. **High: current gate does not protect old e2e tests during migration.**
   The plan says the old suite guards throughout, but `test:legacy` only runs `tests/unit tests/integration` at plan:790, matching current `package.json` (line 19). There are existing `tests/e2e` files, including tier-4 real e2e.
   Fix: explicitly include old e2e in `test:legacy:e2e`/`check:release`, or document that e2e is not protected until U9/U13 and add inventory reconciliation for it.

6. **High: overlap-report metadata collection is under-specified.**
   §5.3 says metadata powers the overlap report, and U3 says the report reads scenario metadata at plan:598. But importing test files to collect metadata will register Bun tests and may execute top-level setup. Static parsing only works if metadata is constrained to object literals.
   Fix: define a machine-readable manifest strategy: either AST parse literal `scenario({...})` calls, or have `scenario()` write to a registry only under a `SCENARIO_COLLECT=1` mode that does not call `it()`.

7. **High: the scenario typing sketch will not work as claimed without stronger generics.**
   `ScenarioMeta.drivers: readonly DriverName[]` loses literal tuple inference, and `AppFor<typeof meta.drivers[number]>` will not reliably produce the intended per-driver/common surface. Multi-driver scenarios also need a common `launch` spec; otherwise `model` + `screen` bodies will hit incompatible method signatures. The example's `app.press?.(...)` at plan:864 weakens the type guarantee.
   Fix: define `scenario<const D extends readonly DriverName[]>(meta: ScenarioMeta<D>, body: (app: CommonAppFor<D>) => Promise<void>)`, make shared scenarios use shared Given helpers/specs, and ban optional action calls in scenario bodies.

8. **Medium: keeping skipped old tests forever is not "~0 cost."**
   Skipped Bun test files are still discovered/imported, and TypeScript still compiles included files. D2/R8 claim skipped tests are cheap at plan:115 and plan:1104, but the archive can still fail from import side effects or API drift.
   Fix: either accept and document archive maintenance cost, or convert old tests into inert archived source/manifests excluded from `typecheck` and normal test import.

9. **Medium: helper import boundaries conflict with the "no cross-tree imports" rule.**
   §4 says new drivers reuse `tests/helpers/**`, but U10-U13 verification says no imports from `tests-new/` into `tests/` at plan:716. Current `@orch/test/*` points to `tests/helpers/*`.
   Fix: either explicitly exempt `tests/helpers` as shared legacy infrastructure, or move shared helpers to `tests-new/dsl`/`tests-shared` early and update `tsconfig` paths.

**Bottom line:** the DSL/driver direction is feasible, but the proof of "everything converted" needs a stricter inventory/ledger model, explicit Bun concurrency flags, release hard-fail gates, and `tests-new` typechecking before autonomous migration starts.

---

## Review 3 — Scope guardian (`019e9837-6684`)

Read-only review complete. I did not edit files. Short answer: **no, the current plan does not yet guarantee everything converts.**

**Findings**

1. **Critical: `hosts/**` is missing from the whole-repo relocation plan.**
   The plan promises "every other test" moves into `tests-new/{unit,integration,e2e}` (line 50), but the target tree and U10-U13 omit non-two-pane `hosts/**` (line 150, line 707). Current inventory has 59 `unit/hosts` and 44 `integration/hosts` test files.
   Suggested fix: add an explicit U-phase or rows for `hosts/plain`, `hosts/tmux-host`, and two-pane-adjacent host tests, with target destinations.

2. **Critical: helper/fixture ownership contradicts the "no cross-tree imports" rule.**
   The plan says new drivers reuse `tests/helpers/**` (line 172), but U10-U13 verification bans `tests-new/` importing from `tests/` (line 716). `tests/helpers`, `tests/fixtures`, `tests/setup`, `tests/unit/helpers`, `tests/integration/behavioral-dsl`, and `tests/integration/tests-setup` are not clearly migrated or exempted.
   Suggested fix: define `tests-new/helpers` / `tests-new/fixtures` or a neutral `test-support/` home, then state whether these files are ledgered, moved, or intentionally shared.

3. **High: the script ladder drops non-two-pane e2e from the gate.**
   U13 says remaining `e2e/**` migrates (line 712), but §8 defines only `test:new-unit` and `test:new-int`; no `test:new-e2e` exists, and `test:legacy` excludes old `tests/e2e` (line 785, line 790).
   Suggested fix: add `test:new-e2e`, define env gating, and include it in `check:release`; add a transition command for old `tests/e2e` until migrated.

4. **High: U5-U13 are too large and "indicative" for autonomous execution.**
   The plan allows phases to split "if large" (line 675), but gives no threshold. U12 alone spans services, state, validators, workflows, config, and codegen (line 711).
   Suggested fix: require each phase plan to start from a generated file inventory and split when it exceeds a file/test-count cap.

5. **Medium: the migration ledger is introduced too late to guard early setup.**
   U3 creates the ledger template (line 580), but U1-U2 already create new categories and tracers. There is no baseline inventory manifest before migration starts.
   Suggested fix: in U1 or U3, generate a full old-test inventory snapshot and make U4-U14 reconcile against that fixed manifest.

6. **Medium: the scenario typing example is likely wrong as written.**
   The plan claims `AppFor<typeof meta.drivers[number]>` gives an intersection for `['model','screen']` (line 278, line 289). In TypeScript, indexing a tuple like that usually produces a union, not an intersection.
   Suggested fix: require a compile-time type assertion proving multi-driver scenarios expose only shared capabilities.

Overall: the two-pane migration concept is well covered, but the whole-repo conversion is not yet airtight. The biggest blockers are omitted `hosts/**`, unresolved helpers/fixtures ownership, and missing e2e gating.

---

## Review 4 — Adversarial (`019e9837-7bc7`)

Reviewed read-only with coherence, feasibility, scope, and adversarial lenses. Short answer: the approach is strong for the two-pane taxonomy, but as written it will not reliably convert everything. It needs stricter inventory and reconciliation mechanics.

**Findings**

1. **Critical: Whole-repo coverage is not mechanically defined.**
   The plan says "every other test" relocates (§1, line 50), but U10-U13 only name module clusters and omit/blur `tests/helpers`, `tests/fixtures`, `tests/setup`, `tests/unit/helpers`, `.test-d.ts`, and some e2e/gated assets. The repo currently has ~361 test files plus many helper/fixture assets.
   **Fix:** In U3, generate a manifest from `tests/` and classify every file as `test`, `type-test`, `helper`, `fixture`, `setup`, `asset`, or `archive-only`. Make U14 reconcile against that manifest, not prose phase groupings.

2. **Critical: "Skip old file after replacement lands" can produce green but incomplete coverage.**
   D2 allows wrapping old files in `.skip` (§3, line 115); migration rows are per old file/example (§9.10, line 1084). Files can contain multiple assertions/cases, existing skipped placeholders, and mixed risks.
   **Fix:** Ledger at test-case/assertion granularity. Extract old `it`/`test` nodes, require each to map to `port|merge|demote|drop`, and only skip the whole file once all child cases are accounted for.

3. **High: Final reconciliation scan is too brittle.**
   U14 proposes failing on surviving non-skipped `it(`/`test(` in `tests/` (§U14, line 741). That misses `describe.skipIf`, aliases, `test.each`, nested skipped ancestry, and can be fooled by comments or wrappers.
   **Fix:** Use an AST-based scanner that resolves skipped ancestry and validates each `MIGRATED ->` target exists and back-references the old case via `oldTestRefs`.

4. **High: Helper strategy contradicts the "no cross-tree imports" rule.**
   The plan says new drivers reuse `tests/helpers/**` (§4, line 172), but U10-U13 verification forbids imports from `tests-new/` into `tests/` (§C, line 716). Current `tsconfig` maps `@orch/test/*` to `./tests/helpers/*`.
   **Fix:** Decide explicitly: move helpers to `tests-new/helpers` or `test-support/`, update `@orch/test/*`, and include helper tests in the manifest.

5. **High: Script ladder does not actually encode the concurrency ceiling.**
   D6 says bounded real-tmux concurrency (§3, line 119), but §8 uses plain `bun test tests-new/screen tests-new/full-host/...` (§8, line 781). That does not itself prove serial/limited execution.
   **Fix:** Add an explicit runner/wrapper for tmux buckets with serial/limited scheduling, and test that concurrent tmux tests cannot exceed the configured limit.

6. **High: Type-safety examples are internally inconsistent.**
   `ModelApp` has no `press`, but the worked model example calls `app.press?.(...)` (§9.2, line 863). `liveDriven` and `app.agent` appear in examples but not in `ScenarioMeta`/`FullHostApp` (§5.2, line 237).
   **Fix:** Define `scenario<const D extends readonly DriverName[]>`, exact app surfaces, and negative `@ts-expect-error` tests. No optional chaining escape hatches for unsupported capabilities.

7. **Medium: "Write behaviour once" conflicts with the model/screen twin examples.**
   DoD says every behaviour is written once (§12, line 1133), but examples create separate model and screen files tied by `overlapGroup` (§9.4, line 911).
   **Fix:** Define when one scenario may list multiple drivers versus when separate contract twins are required. Make overlap rows include relationship type and justification.

8. **Medium: E2E handling is underspecified in the gate.**
   `tests-new/e2e` exists in the target tree (§4, line 153), but §8 adds only `test:new-unit` and `test:new-int` to `test:project` (§8, line 785).
   **Fix:** Add `test:new-e2e`, decide whether it belongs in `check` or only `check:release`, and reconcile old `tests/e2e/**` against that policy.

Bottom line: this can convert everything if you add a manifest-driven migration ledger, AST reconciliation, explicit helper disposition, and real concurrency/gating scripts. Without those, it can go green while leaving uncovered old cases, orphaned helpers, skipped placeholders, or e2e/type-test gaps behind.
