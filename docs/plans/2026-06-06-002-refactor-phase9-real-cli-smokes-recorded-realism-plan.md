---
status: active
type: refactor
title: "refactor: Phase 9 (U9) — real-CLI smokes + recorded realism migration"
created: 2026-06-06
parent: docs/plans/2026-06-05-001-refactor-testing-strategy-restructure-plan.md
origin: docs/brainstorms/2026-06-05-testing-strategy-restructure-spec.md
depth: standard
---

# refactor: Phase 9 (U9) — real-CLI smokes + recorded realism migration

> **This is a phase-level plan** elaborating **U9 only** from the parent
> [`2026-06-05-001-refactor-testing-strategy-restructure-plan.md`](2026-06-05-001-refactor-testing-strategy-restructure-plan.md).
> It inherits every interface and decision in the parent §3–§6 and §9 worked
> examples; it does **not** redesign them. Phases U1–U8 are landed (see
> [`phase-summaries.md`](phase-summaries.md)). Scope is deliberately small — U9 is
> the parent's smallest migration phase (~4 tests).

---

## 1. Summary

U9 closes out the **two-pane real-CLI surface** — the last of the two-pane
migration (group B) before the repo-wide relocations (U10–U13) and the U14
reconciliation. Concretely it migrates the three legacy `tests/e2e/tier-4/*`
real-Claude e2e tests into the new `full-host:real-agent` driver, and adds
**recorded realism** — 1–2 checked-in `full-host:recorded-agent` cassettes for
behaviour whose risk is *event-stream shape* (the realism the inline
`emits(...)` fake cannot reproduce).

The parent gives U9 as a single table row (parent §7, U5–U9 table) plus the
shared U5–U9 requirements/verification. This plan turns that into ordered,
implementable work, grounded against the **actual** repo state:

- **Drivers already exist** (landed in U3): `full-host:real-agent`,
  `full-host:recorded-agent`, `record.ts`, the Zod-validated cassette codec
  (`cassette.ts`), the `claudeAgent`/`codexAgent`/`fromCassette` DSL helpers, one
  real-agent smoke (`autonomous-multi-step.test.ts`) and one recorded tracer
  (`claude-plan-then-work.test.ts`) — both already ledgered `new`. U9 is therefore
  **scenario authoring + one small driver-spec extension + migration close-out**,
  not new driver infrastructure.
- **The one genuine gap**: the shared static full-host engine maps each step to
  `{ agent, prompt }` only; it does not pass per-step `mode: 'interactive'` +
  `autoStop` through to `runWorkflow`. The legacy `auto-stop` case needs exactly
  that, so U9 extends the full-host launch spec to carry it (W1).

The three legacy cases dispose as: `auto-stop` → **port** (the unique AE2 proof,
not yet covered); `autonomous-multi-step` → **port** (strengthen the existing
U3 smoke to faithfully cover the two-step + right-pane-transcript assertion);
`mixed-with-interactive` → **drop** (a never-executed `it.skip` placeholder that
asserted nothing and depends on interactive-PTY-step harness that still does not
exist — out of scope for this phase, recorded as a deferred follow-up).

---

## 2. Problem frame & goals

**Problem.** Today the real-CLI two-pane coverage lives in `tests/e2e/tier-4/`
under the old five-tier vocabulary. The parent migration requires this surface
re-derived through the scenario/driver DSL into `full-host:real-agent`
(2–3 gated smokes) + `full-host:recorded-agent`, every old case ledgered at case
granularity (D15), and the old files flipped from capability-gating (`skipIf`) to
unconditional migration `.skip` (D2) so U14's reconciliation can prove "we are
finished" against the frozen baseline.

**Goals (inherited from parent §2, in priority order).**
1. **Readability/honesty** — each smoke is a plain `scenario(meta, body)`; the
   real-agent smoke asserts the binary integrates *inside* the two-pane system
   (pane painting), never the runner in isolation (parent §5.6, §9.7).
2. **Realism without flake** — recorded cassettes replay deterministically through
   the fake engine (no CLI, no network), capturing event-stream *shape* the inline
   fake cannot (parent D9, §9.6).
3. **Migration honesty** — every legacy tier-4 case ends with a case-granular
   ledger disposition; `drop`s carry a reason; the old files become unconditional
   `.skip` with `// MIGRATED →` / `// DROPPED →` markers; the blocking overlap
   report stays green.

**Non-goals.**
- **Not** building interactive-PTY-step harness support (driving a Claude PTY
  interactive step with captured human input). The legacy `mixed-with-interactive`
  placeholder needed this; it never ran. It is dropped + recorded as a deferred
  follow-up, not built here (R4 below).
- **Not** changing any `src/` behaviour. U9 is test-only (parent non-goal).
- **Not** writing `reconcile.ts` — that is U14. U9 only leaves clean case-granular
  ledger rows + a green overlap report so U14 can succeed.
- **Not** re-recording cassettes against a live CLI on the gate — cassettes are
  hand-authored valid fixtures (the U3 tracer cassette set the precedent) or
  recorded out-of-band via `record.ts`; the gate replays them deterministically.

---

## 3. Inherited decisions that bind this phase

| Ref | Decision | How U9 honours it |
|---|---|---|
| **D2** | Skip-as-migrated, keep forever; old-file edits limited to `.skip` + a `// MIGRATED →` marker | W4 flips the 3 tier-4 files from `describe.skipIf(!canRun)` (capability) to **unconditional** `describe.skip` + markers, only once every case is ledgered |
| **D8** | Selection by path; `real-agent` reachable only by naming `test:two-pane:full:real`; gated by `canRunRealTmuxE2E` | W2 smokes ride the existing driver gate — they never run on `check`, only on `check:release` / explicit path |
| **D9** | Cassettes capture our normalised `RunnerEvent` stream (split `events: InfoEvent[]` + one `terminal`), validated, with a `record.ts` re-record entrypoint | W3 hand-authors cassettes against the existing `cassette.ts` Zod schema; documents the `record.ts --scenario` re-record path |
| **D10** | Chrome literals co-located on Pane Objects; test-authored *content* uses `assertShowsContent` | Smokes/recorded scenarios assert their own authored prompt/cassette text via `assertShowsContent` (the content escape hatch), not chrome |
| **D12** | Completeness accounting runs against the **frozen** `baseline.json` | The 3 tier-4 baseline cases (one per file, confirmed below) are the exact set W4 must ledger |
| **D15** | Ledger is test-case-granular; `oldTestRefs` required per migrated scenario; a file is `.skip`ped only when **every** child case is mapped | Each of the 3 tier-4 cases gets its own row; W2 smokes carry file-specific `oldTestRefs` (not the directory) for case-granular U14 readiness |
| **Overlap report (parent §5.5)** | Blocking since U4; AST-parses `scenario({...})`; flags missing `model↔screen` twins and `oldTestRefs` absent from baseline | U9 adds no `overlapGroup` pairs (real-agent/recorded have no model twin by nature); every `oldTestRefs` entry resolves to a real baseline path |

> **Frozen-baseline ground truth (verified).** `baseline.json` holds exactly one
> case per tier-4 file:
> - `tests/e2e/tier-4/auto-stop.real.e2e.test.ts` → *"finishes its turn and the pane closes on its own with no keystroke"*
> - `tests/e2e/tier-4/autonomous-multi-step.real.e2e.test.ts` → *"two real-CLI autonomous steps run to completion and right.capture() shows live transcript text"*
> - `tests/e2e/tier-4/mixed-with-interactive.real.e2e.test.ts` → *"autonomous step + interactive step share the same harness body"*
>
> These three case identities are the complete D12 accounting target for W4.

---

## 4. Current-state inventory (what already exists vs what U9 adds)

| Asset | State today | U9 action |
|---|---|---|
| `tests-new/dsl/drivers/full-host-real-agent-driver.ts` | Exists; wraps `createStaticFullHostApp` + `mountTmuxHost(fixture, {})`; `agentForStep → { agent, prompt }` | **No change** unless W1 routes mode/autoStop through it (see W1 approach) |
| `tests-new/dsl/drivers/full-host-static-app.ts` (`createStaticFullHostApp`) | Runs the workflow to completion; builds step descriptors from `agentForStep` | **Extend (W1)** to forward optional `mode`/`autoStop` from the spec into `runWorkflow` step descriptors |
| `tests-new/dsl/app-surfaces.ts` (`FullHostSpec`) | `{ steps, agent? }` (+ shared `LaunchSpec` fields) | **Extend (W1)** with optional `mode?: 'interactive'` + `autoStop?: boolean` |
| `tests-new/full-host/real-agent/autonomous-multi-step.test.ts` | Exists (U3 smoke): **single** step `['plan']`, asserts `'OK'`; `oldTestRefs: ['tests/e2e/tier-4']` (directory) | **Strengthen (W2)** to two steps + right-pane transcript assertion; retarget `oldTestRefs` to the specific file |
| `tests-new/full-host/real-agent/auto-stop.test.ts` | **Does not exist** | **Create (W2)** — the AE2 interactive-auto-stop smoke |
| `tests-new/full-host/recorded-agent/claude-plan-then-work.test.ts` + cassette | Exists (U3 tracer), ledgered `new` | **No change** (it stays the tracer) |
| 1–2 new recorded cassettes + scenarios | **Do not exist** | **Create (W3)** — event-stream-shape realism |
| `tests/e2e/tier-4/*` (3 files) | `describe.skipIf(!canRun)` — capability gate, **not** migrated | **Flip (W4)** to unconditional `describe.skip` + markers; ledger 3 cases |
| `tests-new/_migration/ledger.md` | Rows 57/58 already mark the two U3 `new` tracers | **Append (W4)** the tier-4 area rows; refine row 58 wording if needed |

---

## 5. Implementation units

> Ordered. Each lands behind the appropriate script (parent §8) leaving
> `bun run check` green (the gate excludes `real-agent`, which auto-skips). Unit
> IDs are phase-local (`W1–W4`), matching the prior phase plans' work-item idiom.

### W1. Full-host launch-spec extension: per-run `mode: 'interactive'` + `autoStop`

**Goal.** Let a `full-host:*` scenario launch an interactive auto-stopping step, so
the legacy `auto-stop` behaviour is expressible at all. This is the one piece of
driver/DSL surface U9 must add; everything else is scenario authoring.

**Requirements.** Parent §5.2 (typed app surfaces), §9.5/§9.7 (full-host shape);
unblocks W2's auto-stop smoke.

**Dependencies.** None (extends landed U2/U3 infrastructure).

**Files.**
- `tests-new/dsl/app-surfaces.ts` — add optional `mode?: 'interactive'` and
  `autoStop?: boolean` to `FullHostSpec` (apply to the run's step(s); the auto-stop
  legacy case is single-step, so a run-level flag pair is sufficient — do not build
  per-step heterogeneous modes this phase).
- `tests-new/dsl/drivers/full-host-static-app.ts` — thread the two new fields from
  the spec into the `runWorkflow` step descriptors (`mountTmuxHost`'s `runWorkflow`
  already accepts per-step `mode`/`autoStop`; the legacy test passes exactly those).
- `tests-new/dsl/drivers/__tests__/full-host-static-app.test.ts` (or the nearest
  existing static-app/driver test) — driver-level contract test for the passthrough.

**Approach.**
- The legacy `auto-stop` test calls `harness.runWorkflow([{ name, agent, mode:
  'interactive', autoStop: true, prompt }])`. The static engine already owns
  `runWorkflow`; W1 only widens the spec→descriptor mapping so these two fields are
  forwarded when present, and defaulted off otherwise (zero change to existing
  static/fake/recorded scenarios — they omit the fields).
- Keep the surface minimal and typed: the fields are optional on `FullHostSpec`,
  so a fake/recorded scenario that omits them is unaffected and a real-agent
  scenario opts in explicitly. No new app *method* is needed (completion is already
  awaited by the static engine; the auto-stop mechanic is what lets it resolve with
  no keypress).

**Patterns to follow.** The existing `agentForStep` mapping in
`full-host-real-agent-driver.ts`; `createStaticFullHostApp` step-descriptor
construction; the legacy `auto-stop.real.e2e.test.ts` step shape.

**Test scenarios** (driver-level, fake-agent so it runs on the gate — do **not**
require a real CLI to prove the passthrough):
- *Happy:* a `FullHostSpec` with `mode: 'interactive'` + `autoStop: true` produces a
  `runWorkflow` step descriptor carrying `mode === 'interactive'` and
  `autoStop === true` (assert against a `FakeRunner`-backed static build or a spy on
  the descriptor the engine constructs).
- *Edge:* a spec omitting both fields produces descriptors with no `mode`/`autoStop`
  (or their documented defaults) — proving existing scenarios are byte-for-byte
  unaffected.
- *Type:* `mode` is constrained to `'interactive'` (the only value this phase
  supports); an arbitrary string is a compile error (rides the D11 typecheck gate).

**Verification.** `bun run typecheck` green (the new optional fields compile and the
negative type holds); the driver-level passthrough test passes under
`bun run test:two-pane:fast` or `:full:fake`; no existing full-host scenario changes
behaviour.

---

### W2. Real-agent smokes — `autonomous-multi-step` (strengthen) + `auto-stop` (new)

**Goal.** Land the 2 gated real-CLI smokes that faithfully port the two genuine
tier-4 cases, asserting two-pane *pane integration* (parent §9.7).

**Requirements.** Parent §7 (U9 row), §9.7, §5.6; D2, D8, D15. Depends on W1 for the
auto-stop smoke.

**Dependencies.** W1.

**Files.**
- `tests-new/full-host/real-agent/autonomous-multi-step.test.ts` — **modify**:
  two steps (`['plan', 'work']` with distinct one-word prompts), assert the second
  step's transcript word reaches the right pane via `rightPane.assertShowsContent`;
  retarget `oldTestRefs` from `['tests/e2e/tier-4']` to
  `['tests/e2e/tier-4/autonomous-multi-step.real.e2e.test.ts']`.
- `tests-new/full-host/real-agent/auto-stop.test.ts` — **create**: a single
  interactive `autoStop` step (`mode: 'interactive'`, `autoStop: true`), a prompt
  that finishes a turn quickly ("Reply with exactly: done"), and an assertion that
  the pane painted the reply (`rightPane.assertShowsContent('done')`) **with no
  `press`** — completion-without-keystroke is the AE2 proof;
  `oldTestRefs: ['tests/e2e/tier-4/auto-stop.real.e2e.test.ts']`.

**Approach.**
- Both smokes use `claudeAgent(prompt)` in the agent slot — the swap *is* the
  promotion (parent D-P3.3); no copy-paste from the fake body.
- `auto-stop` proves the real Stop-hook + real env + real tmux `wait-for` transport
  closes the finished turn with no keystroke (the unique value the fake cannot
  exercise — see the legacy file's own triage comment). The scenario reaching its
  end (driver completion + teardown) is the "pane closes on its own" proof; the
  content assertion proves the turn actually finished and painted.
- Multi-step in the static engine is already proven (U6 summary: "Static full-host
  multi-step navigation works"), so `autonomous-multi-step` needs no driver change —
  only the scenario body grows to two steps + the transcript assertion.

**Patterns to follow.** The existing `autonomous-multi-step.test.ts` body and the
`§9.7` worked example; the legacy `auto-stop.real.e2e.test.ts` for the
interactive/autoStop step shape and the generous real-CLI timeout (the driver
already budgets `REAL_AGENT_TIMEOUT_MS = 120_000`).

**Test scenarios** (these scenarios *are* the tests; all gated/auto-skipped off the
normal gate):
- *Smoke (port of autonomous-multi-step):* `Covers AE-equivalent of tier-4
  autonomous multi-step.` Two real Claude steps run to completion; the second
  step's transcript word paints in the right pane. Auto-skips unless `tmux` +
  `claude` + `RUN_REAL_TMUX_E2E=1`.
- *Smoke (port of auto-stop):* `Covers AE2.` An interactive auto-stop step finishes
  its turn and the pane closes on its own with **no keystroke**; the reply paints in
  the right pane. Auto-skips identically.
- *Gating (meta, asserted via existing driver gate, not a new test):* both smokes
  are unreachable except via `test:two-pane:full:real`; neither runs under
  `bun run check`.

**Verification.** On a capable box (`which claude`, tmux, `RUN_REAL_TMUX_E2E=1`):
`bun run test:two-pane:full:real` green, both smokes execute and pass. On the normal
gate: both auto-skip (no false failure), `bun run check` unaffected. The blocking
overlap report stays green (both `oldTestRefs` resolve to real baseline paths).

---

### W3. Recorded-agent realism — 1–2 event-stream-shape cassettes + scenarios

**Goal.** Add deterministic recorded coverage for behaviour whose risk is
*event-stream shape* — the realism the inline `emits(...)` fake cannot produce —
distinct from the U3 plan→work tracer.

**Requirements.** Parent §4 (recorded mode), §5.6 (cassette format), §9.6; D9, D10.

**Dependencies.** None (the `recorded-agent` driver, `cassette.ts` codec, and
`fromCassette` helper are landed). Independent of W1/W2 — may proceed in parallel.

**Files.**
- `tests-new/full-host/recorded-agent/cassettes/<scenario>.json` — 1–2 new
  hand-authored cassettes conforming to the `cassette.ts` Zod schema (`schemaVersion`,
  `runner`, `eventSchema: 'RunnerEvent'`, `events: InfoEvent[]`, single `terminal`).
- `tests-new/full-host/recorded-agent/<scenario>.test.ts` — 1–2 scenarios that
  `launch({ ..., agent: fromCassette('<scenario>.json') })`, run to completion, and
  assert the rendered event-shape outcome (test-authored cassette content via
  `assertShowsContent`; rendered-event chrome — e.g. a tool-use render — via the
  existing semantic `rightPane` method if one fits).
- (No change to `record.ts` / `cassette.ts` — reuse as-is.)

**Approach.**
- Target a genuinely *event-shape-dependent* rendering risk the tracer does not
  cover. Candidate shapes (the phase plan picks 1–2 by where the rendering risk is
  real, not all): a multi-`tool_use` sequence (several tool events in one turn), a
  `thinking`/text/`tool_use` interleave, or an **error terminal** stream
  (`terminal.type: 'error'`) painting a failure outcome in the right pane. Prefer
  shapes already reachable by existing `rightPane` semantic methods so no DSL
  extension is needed; if a new render assertion is required, prefer
  `assertShowsContent` over adding chrome surface.
- Cassettes are hand-authored valid fixtures (the U3 `claude-plan-then-work.json`
  precedent) so they run on the normal gate deterministically — no CLI. The
  `record.ts --scenario <name>` re-record path is documented in a header comment for
  when a real run is available and drift is suspected (D9), but is **not** required
  to land or run this phase.
- These are **`new`** ledger rows (born in `tests-new/`, no old twin — the old
  harness had no realistic-event replay; parent §U3 during-migration routing).

**Patterns to follow.** `tests-new/full-host/recorded-agent/claude-plan-then-work.test.ts`
and its cassette; the cassette excerpt in parent §9.6; the `cassette.ts` schema for
exact field shapes.

**Test scenarios** (the scenarios *are* the tests; these run on the gate):
- *Happy/integration:* a cassette with the chosen event shape replays
  deterministically through `FakeRunner` on the real two-pane host and the expected
  rendered outcome reaches the right pane (no CLI, no network, no flake).
- *Error path (if the error-terminal cassette is chosen):* a cassette with
  `terminal.type: 'error'` renders the failure outcome in the right pane (not a
  hang, not a crash).
- *Schema guard (reuse, not new):* an intentionally malformed cassette is rejected
  by the `cassette.ts` Zod validator — already covered by the U3
  `recorded-agent-driver.test.ts`; W3 only confirms the new cassettes *pass*
  validation (they load without error in the replay).

**Verification.** `bun run test:two-pane:full:recorded` green (new cassettes replay,
deterministic, on the gate); cassettes validate against `cassette.ts`; ledger carries
`new` rows for each. Overlap report green (`oldTestRefs: []` is valid for born-new
scenarios).

---

### W4. Migration close-out — flip the 3 tier-4 files to `.skip`, ledger every case

**Goal.** Make the tier-4 area fully accounted for at case granularity (D15) and
flip the old files from capability-gating to unconditional migration `.skip` (D2),
so U14's frozen-baseline reconciliation can later prove completeness.

**Requirements.** Parent §7 (U5–U9 verification), §10.2, §11; D2, D12, D15.

**Dependencies.** W2 (the two ported cases must be green/landed before their old
files are skipped), W3 (recorded `new` rows landed). The `mixed-with-interactive`
drop has no dependency.

**Files.**
- `tests/e2e/tier-4/autonomous-multi-step.real.e2e.test.ts` — **modify**: convert
  `describe.skipIf(!canRun)` → unconditional `describe.skip`; add
  `// MIGRATED → tests-new/full-host/real-agent/autonomous-multi-step.test.ts`.
- `tests/e2e/tier-4/auto-stop.real.e2e.test.ts` — **modify**: same flip +
  `// MIGRATED → tests-new/full-host/real-agent/auto-stop.test.ts`.
- `tests/e2e/tier-4/mixed-with-interactive.real.e2e.test.ts` — **modify**: convert to
  unconditional `describe.skip` + `// DROPPED → never executed (it.skip placeholder);
  interactive-PTY-step harness not built — deferred follow-up`.
- `tests-new/_migration/ledger.md` — **append** a `### tier-4 / real-CLI` area
  section with one row per baseline case (2 `port`, 1 `drop`); refine the existing
  row 58 (the U3 `new` real-agent smoke) so it references the specific
  `autonomous-multi-step` file rather than "the spirit of tests/e2e/tier-4", keeping
  the case mapping unambiguous; add `new` rows for the W3 cassettes.

**Approach.**
- Only flip an old file once **every** child case it owns is ledgered (D15). Each
  tier-4 file has exactly one case (verified against the frozen baseline), so each
  file flips as soon as its single case has a row.
- Distinguish `skipIf` (capability) from `.skip` (migrated): the current
  `describe.skipIf(!canRun)` must become **unconditional** `describe.skip` — U14's
  reconcile scanner treats `skipIf` as *not migrated* (parent D15, reconcile rule 1).
  Leaving the `skipIf` in place would make U14 fail.
- `mixed-with-interactive` is a `drop`: its case is an `it.skip` that never executed
  and asserted nothing. Dropping (not porting) is the honest disposition; the
  interactive-PTY capability it waited on still does not exist and is out of U9 scope.
  Record it as a deferred follow-up in Scope Boundaries below.

**Patterns to follow.** The prior phases' close-out idiom — `// MIGRATED →` /
`// COVERED BY →` / `// DROPPED →` markers and the case-granular row format in
`tests-new/_migration/ledger.md` (see the U8 §W6 and §G4 rows for `port`/`demote`/
`drop` wording; parent §9.10 for the row template).

**Test scenarios.** `Test expectation: none — migration bookkeeping` (this unit
adds no behavioural test; the behaviour is covered by W2/W3). Its correctness is
proven by the verification queries below, not by a new `it()`.

**Verification.**
- The 3 tier-4 files are unconditional `describe.skip` (no `skipIf`) with a
  `// MIGRATED →` (×2) / `// DROPPED →` (×1) marker; a grep confirms no
  `skipIf` remains in `tests/e2e/tier-4/`.
- `tests-new/_migration/ledger.md` has a row for each of the 3 frozen-baseline
  tier-4 cases with a disposition + reason, plus `new` rows for the W3 cassettes.
- `bun run` the overlap report — green and blocking (every `oldTestRefs` resolves;
  no missing twin introduced).
- `bun run check` green (old tier-4 now skipped, not gating; new recorded cassettes
  on the gate green; real-agent smokes auto-skip).

---

## 6. Sequencing & dependency graph

```
W1 (spec extension) ─┐
                     ├─► W2 (real-agent smokes) ─┐
W3 (recorded cassettes) ─────────────────────────┼─► W4 (close-out: skip + ledger)
                                                  │
W3 ──────────────────────────────────────────────┘  (its `new` rows land in W4's ledger pass)
```

- **W1 → W2:** the auto-stop smoke cannot launch without the interactive/autoStop
  passthrough.
- **W3 ∥ W1/W2:** recorded cassettes are independent of the real-agent work; may run
  in parallel.
- **W2, W3 → W4:** an old file is flipped to `.skip` only after its replacement is
  green (D2); the ledger close-out folds in W3's `new` rows.

A natural single-PR order is W1 → W3 → W2 → W4, or W1+W3 in parallel then W2 then W4.

---

## 7. Scope boundaries

**In scope.**
- Migrate the 3 `tests/e2e/tier-4/*` cases (2 `port`, 1 `drop`) into the new tree.
- The minimal `FullHostSpec` interactive/autoStop passthrough (W1).
- 1–2 new recorded-agent cassettes + scenarios for event-stream-shape realism.
- Old-file `.skip` flip + case-granular ledger close-out for the tier-4 area.

**Outside this product's identity / unchanged (parent non-goals).**
- No `src/` behaviour change; no new runner contract.
- Manual screen QA (`orch-qa-engineer` / `scriptedFake`) stays outside the taxonomy.

### Deferred to follow-up work
- **Interactive-PTY real-agent step** (the dropped `mixed-with-interactive` shape):
  driving a real Claude *interactive* step with captured human input end-to-end.
  Needs an `interactiveStep(prompt, agent)`-style harness helper that does not exist
  (confirmed against `tests-new/_support/real-tmux/` and the legacy file's own
  comment). Re-derive as a `full-host:real-agent` (or `lifecycle` + real-agent)
  smoke when that helper lands. Recorded in the W4 ledger `drop` reason and
  cross-referenced by the existing ledger rows 43/170 that already point at "U9".
- **Live cassette re-recording on a capable box** via `record.ts --scenario` — out
  of band; only needed if a cassette is suspected of drift (D9).
- **`reconcile.ts`** (U14) — consumes the clean ledger/skip state U9 leaves; not
  built here.

---

## 8. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| **R1 — The interactive/autoStop passthrough (W1) regresses existing full-host scenarios.** The static engine is shared by fake/recorded/real drivers. | Medium | Make the two fields **optional** and default-off so omitting them is byte-for-byte unchanged; W1 ships a driver-level test proving an omitting spec produces identical descriptors; run `:full:fake` + `:full:recorded` after W1. |
| **R2 — auto-stop smoke flakes under real tmux** (the historical flake surface). | Medium | Reuse the landed driver's hardened predictability rules (unique socket, reaping, both timeout constants) — W2 adds *no* new tmux lifecycle code, only a scenario; the driver already budgets `REAL_AGENT_TIMEOUT_MS`. It auto-skips off the gate, so a flake never blocks `check`. |
| **R3 — Dropping `mixed-with-interactive` loses coverage.** | Low | The case **never executed** (`it.skip` placeholder asserting nothing) — dropping loses zero real coverage. The honest disposition is `drop` + a deferred follow-up, not a forced build of absent harness support. |
| **R4 — Hand-authored cassettes drift from real CLI event shape** (re-testing stale shape). | Low | Cassettes capture *our* normalised `RunnerEvent` (changes rarely, D9); the `record.ts --verify` replay + re-record path is documented; raw CLI parser fixtures remain the real drift guard at the runner layer. |
| **R5 — Old tier-4 files left on `skipIf` (not `.skip`) silently fail U14.** Reconcile distinguishes capability-gating from migration. | Medium | W4 converts to **unconditional** `describe.skip` and a grep gate confirms no `skipIf` remains under `tests/e2e/tier-4/`; every baseline case is ledgered before the flip (D15). |
| **R6 — `oldTestRefs` left as the directory (`tests/e2e/tier-4`) passes the overlap report but is too coarse for U14's case-granular check.** | Low | W2 retargets each smoke's `oldTestRefs` to its specific old file; W4 ledgers all three cases individually. |

---

## 9. Definition of Done (this phase)

- `tests-new/full-host/real-agent/` holds **2** smokes (autonomous-multi-step
  strengthened to two-step + right-pane transcript; auto-stop new), each with
  file-specific `oldTestRefs`, both auto-skipping off the gate and passing under
  `test:two-pane:full:real` on a capable box.
- `tests-new/full-host/recorded-agent/` holds **1–2 new** cassettes + scenarios for
  event-stream-shape realism, replaying deterministically on the gate.
- The `FullHostSpec` interactive/autoStop passthrough (W1) is landed, typed, and
  proven not to alter existing full-host scenarios.
- All **3** `tests/e2e/tier-4/*` files are unconditional `describe.skip` with
  `// MIGRATED →` (×2) / `// DROPPED →` (×1) markers; **no `skipIf` remains** there.
- `tests-new/_migration/ledger.md` accounts for all **3** frozen-baseline tier-4
  cases (2 `port`, 1 `drop` + reasons) and the W3 `new` cassettes.
- The blocking overlap report is green; `bun run typecheck`, `bun run check`, and
  `bun run test:two-pane:full:recorded` are green (modulo the documented pre-existing
  5 `ENOENT` fixture failures under gitignored `.orch/`, unrelated to this phase).
- No `src/` change. The two-pane migration surface (group B) is complete; U10–U13
  (repo-wide relocation) and U14 (reconciliation) remain.
