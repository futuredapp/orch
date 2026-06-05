---
status: active
type: refactor
title: "refactor: Testing strategy restructure — Phase U3 (recorded-agent + real-agent drivers, script ladder, overlap report, docs/skill rewrite, convention flip)"
created: 2026-06-05
parent: docs/plans/2026-06-05-001-refactor-testing-strategy-restructure-plan.md
origin: docs/brainstorms/2026-06-05-testing-strategy-restructure-spec.md
depth: deep
---

# refactor: Testing strategy restructure — **Phase U3** detailed execution plan

> **This is a phase-level plan.** It elaborates **only parent-plan phase `U3`**
> ([`docs/plans/2026-06-05-001-refactor-testing-strategy-restructure-plan.md`](2026-06-05-001-refactor-testing-strategy-restructure-plan.md) §7
> → `#### U3. recorded-agent + real-agent + convention flip`). It does **not**
> redesign any interface or decision from the parent — it honours the parent's §3
> decisions (D1–D15), §5 interfaces, §6 decision rule, §8 script ladder, and §9
> worked examples, and turns the parent's `U3` unit into concrete, ordered,
> implementation-ready work.
>
> **U-ID note.** The units below (`U3.1`–`U3.5`) are the *implementation units of
> parent-plan phase U3*. They carry their own stable plan-local IDs and are
> distinct from the parent's `U1..U14` phase IDs. "The parent's U3" means parent
> §7 → `#### U3. recorded-agent + real-agent + convention flip (script ladder,
> docs, overlap report)`.

---

## 1. Summary

Parent phase **U3** completes the driver set and flips the repo onto the new
testing model. It is the last *infrastructure* phase before the bulk two-pane
migration (U4–U13) begins. Five distinct deliverables:

1. **The two remaining drivers.** `full-host:recorded-agent` (replays a captured,
   normalised `RunnerEvent` cassette through the existing `full-host:fake-agent`
   engine) and `full-host:real-agent` (the same full-host body with a real
   `ClaudeRunner`/`CodexRunner` in the agent slot, gated). Both currently exist as
   `makeStubDriver(..., 'parent U3')` stubs in the registry.
2. **The cassette format + `record.ts`.** The `RecordedAgentCassette` type (D9),
   the re-record entrypoint that captures at the Runner boundary via the existing
   `onEvent` tap, deterministic formatting, and a replay-verification mode.
3. **The full script ladder + bare-`bun test` guard (D7) + concurrency (D6/D14).**
   The complete §8 ladder — atomic buckets, cumulative levels, `test:legacy`
   (incl. old `tests/e2e`), `test:new-{unit,int,e2e}`, `test:project`, `check`,
   `check:release` — repointing `check` onto both trees, plus the Bun preload that
   warns on bare `bun test`.
4. **The migration audit machinery.** The `overlap-report.ts` (AST-parses scenario
   metadata, flags missing overlap-group twins and ledger gaps against the frozen
   baseline) and the `ledger.md` template with its first rows. Wired
   **non-blocking** in U3; U4's plan flips it to blocking (parent §U3 sequencing).
5. **The docs + skill rewrite (R12) and the convention flip.** Rewrite
   `docs/testing-strategy.md`, `CLAUDE.md`, `README`, and every tier-coded skill
   **before U4 starts**, gated by a repo-wide tier-grep — because every migration
   phase loads `phase-implementer` (runner work loads `runner-author`), and a stale
   tier-coded skill makes an autonomous agent write old-shape tests mid-migration.

The load-bearing risks this phase manages are **R7** (cassette drift silently
re-tests stale CLI behaviour), **R12** (stale tier-coded skills derail autonomous
phases), and the gate-correctness risk of repointing `check` onto two trees
without breaking either.

---

## 2. Current state (verified 2026-06-05)

- **U1 + U2 have landed.** `tests-new/` holds the full DSL spine and four live
  drivers. `DRIVERS` (`tests-new/dsl/drivers/registry.ts`) wires real `model`,
  `screen`, `full-host:fake-agent`, `lifecycle`, and **stubs** exactly the two U3
  drivers via `makeStubDriver('full-host:recorded-agent', 'parent U3')` /
  `makeStubDriver('full-host:real-agent', 'parent U3')` (`skip: () => true`,
  `build → notImplemented`). **U3 replaces exactly these two stubs.**
- **The agent-spec DSL** (`tests-new/dsl/agent-spec.ts`) ships `emits`/`live`/
  `holdsOpen` returning an `AgentSpec` union (`EmitsSpec | LiveSpec | HoldsOpenSpec`)
  and its header comment states verbatim: *"The cassette-backed `fromCassette` /
  `claudeAgent` specs are parent U3."* **U3 adds `fromCassette(...)` and
  `claudeAgent(...)`/`codexAgent(...)` as new `AgentSpec` variants** and exports
  them from the barrel (`tests-new/dsl/index.ts`).
- **The full-host driver the recorded driver reuses already exists**
  (`tests-new/dsl/drivers/full-host-fake-agent-driver.ts`): it boots the full
  two-pane host under real tmux and feeds the agent slot from an `AgentSpec`.
  `FullHostApp` (`tests-new/dsl/app-surfaces.ts`) is `{ launch, complete, leftPane,
  rightPane, agent?, teardown }`; `FullHostSpec` is `LaunchSpec & { agent?: AgentSpec }`.
- **The cassette boundary is real and matches D9 exactly** (verified against
  `src/runners/`):
  - The normalised tap is `runRunner(..., { onEvent })` in
    `src/runners/execute.ts` (`deps.onEvent?.(evt)` fires for every parsed
    `RunnerEvent`, terminal included).
  - `FakeRunner.script(s: FakeScript)` (`src/runners/fake/fake-runner.ts`) takes
    `events?: readonly InfoEvent[]` and **synthesizes its own terminal** from
    `structuredOutput` / `failWith` (it does **not** accept a flat
    `RunnerEvent[]`). So a cassette **cannot** be a flat `RunnerEvent[]`; it must
    split streamed `InfoEvent`s from the single terminal, and the replay shim maps
    `cassette.terminal` → `FakeRunner.script`'s `structuredOutput` (turn-complete)
    or `failWith` (error). This is precisely the parent §5.6 "interface reality
    check."
  - Event types: `InfoEvent = { kind:'info'; type:string; payload? }`,
    `TerminalEvent = { kind:'terminal'; type:'turn-complete'; data? } | { kind:
    'terminal'; type:'error'; message; data? }` (`src/runners/types.ts`).
- **`package.json` scripts (U2 state).** Present: `test:two-pane:{model,tmux-argv,
  fast,screen,full:fake,tmux,lifecycle}` with encoded concurrency
  (`tmux`=`--max-concurrency=2`, `lifecycle`=`--max-concurrency=1`). **Missing
  (U3 adds):** `test:two-pane:full:recorded`, `test:two-pane:full:real`,
  `test:new-unit`, `test:new-int`, `test:new-e2e`, `test:legacy`,
  `test:legacy:e2e`, `test:project`, `check:release`, and the bare-`bun test`
  guard. `check` is still the **legacy** `lint && typecheck && test` where
  `test = bun test tests/unit tests/integration` — **U3 repoints it** onto the full
  ladder. Old `tests/e2e/{tier-4,workflows,cli}` exists and must join `test:legacy`.
- **`bunfig.toml`** preloads only `./tests/setup/cleanup-stale-tmux.ts`. The D7
  bare-`bun test` warn preload is **not** wired. (`tests/setup/**` itself does not
  move in U3 — that is U13.)
- **The frozen baseline** (`tests-new/_migration/baseline.json`, 425 files, 2517
  cases) is committed; `snapshot.ts` is a deterministic TS-AST walker that never
  imports test files. **No `overlap-report.ts`, `reconcile.ts`, or `ledger.md`
  exists yet** — U3 ships the overlap report + ledger template (reconcile is U14).
- **R12 tier-grep surface (verified).** Files that hard-code the five tiers or old
  `tests/` paths: `docs/testing-strategy.md` (47 hits), `CLAUDE.md` (3),
  `.claude/skills/testing-strategy/SKILL.md` (10, incl. `tests/…` paths),
  `.claude/skills/orch-acceptance-tests/SKILL.md` (4), `.claude/skills/
  orch-workflow-author/SKILL.md` (1), `.claude/skills/runner-author/SKILL.md`
  (5, old `tests/` paths, no "tier" word), and `README.md` (test-script section,
  no tier word). `orch-qa-engineer` and `phase-implementer` SKILL.md exist with
  **zero** tier/`tests/`-path hits in the combined grep but are named by R12 — they
  must be re-read for prose tier references the grep pattern misses.
  `improve-codebase-architecture/LANGUAGE.md`'s single "tier" is **architectural**,
  not testing — explicitly out of the gate.

---

## 3. Scope & non-goals

**In scope (this phase = parent U3 only).**
- The `full-host:recorded-agent` driver (cassette replay via the fake-agent
  engine) and `full-host:real-agent` driver (real runner in the agent slot, gated).
- The `RecordedAgentCassette` type, `record.ts` (record + verify-by-replay), and
  one checked-in fixture cassette for the tracer.
- The `fromCassette(...)`, `claudeAgent(...)`, `codexAgent(...)` agent-spec helpers.
- The full §8 script ladder, the §D6/D14 concurrency flags on every tmux bucket,
  the `check`/`check:release` repoint, and the bare-`bun test` guard preload (D7).
- The `overlap-report.ts` (AST parse of scenario metadata; missing-overlap-group +
  ledger-gap detection vs the **frozen** baseline; registers **zero** Bun tests)
  and the `ledger.md` template + first rows. Wired **non-blocking** in U3.
- The docs/skill rewrite (R12) gated by a repo-wide tier-grep, completed **within
  U3, before U4**, plus the documented during-migration routing rule.

**Out of scope (deferred to later parent phases).**
- Any **behaviour migration** of old two-pane tests (U4–U9) or relocation of
  non-two-pane tests (U10–U13). U3 marks **no** old test `.skip` and writes only
  the recorded/real tracers + driver tests; it seeds the ledger **template** and
  its first illustrative rows only.
- **Flipping the overlap report to blocking** — that is U4's plan (parent §U3:
  "U3 wires it non-blocking, U4's plan flips it to blocking"). U3 only ships the
  report and an `overlap-report` script not on the `check` gate.
- The **reconciliation check** (`reconcile.ts`) and the final default-gate repoint
  onto `tests-new/` — both U14.
- Moving `tests/setup/**` / `tests/fixtures/**` to `_support/` — U13. U3's preload
  wiring lives in `bunfig.toml`'s `preload` array; the new warn preload file lands
  under `tests-new/dsl/` (parent Files list).

**Non-goals (carried from parent §2).** Not changing what the orchestrator does;
not replacing runner *parser* contract tests with cassettes (raw CLI parser
fixtures stay at the runner layer, §5.6/D9); not redesigning the parent's
interfaces.

---

## 4. Decisions inherited & phase-local decisions

**Inherited (must not relitigate):** D2 (no old-test deletion — U3 skips none),
D6/D14 (concurrency encoded as flags; `lifecycle` serial), D7 (bare-`bun test`
guidance + lightweight guard), D8 (selection by path; `skip()` only prevents false
failure), D9 (cassette captures the normalised `RunnerEvent` stream, never raw CLI
stdout; `record.ts` required), D10 (co-located chrome literals). Parent §5.3
(import-time purity — the report must AST-parse, never import scenario files),
§5.6 (cassette interface reality check), §8 (the script ladder), §10.4 PR2–PR3.

**Phase-local decisions** (resolving genuine gaps this plan surfaced; each is a
"how", inside the parent's "what"):

| # | Decision | Choice | Rationale |
|---|---|---|---|
| **D-P3.1** | **Cassette = split `events` + `terminal`; replay maps terminal → `FakeRunner.script`** | The `RecordedAgentCassette` (parent §5.6) carries `events: readonly InfoEvent[]` and `terminal: TerminalEvent` as **separate** fields. The replay shim feeds `events` to `FakeRunner.script({ events, structuredOutput?, failWith? })` and derives the last two from `terminal` (`turn-complete` → `structuredOutput: terminal.data`; `error` → `failWith: { message }`). | Verified against `src/runners/fake/fake-runner.ts`: `script()` takes `InfoEvent[]` and synthesizes its own terminal. A flat `RunnerEvent[]` would type-error on the terminal element and double the terminal on replay (parent §5.6). |
| **D-P3.2** | **`recorded-agent` reuses the `full-host:fake-agent` engine; only the event source differs** | The recorded driver does **not** re-implement full-host wiring. It reuses the U2 `full-host:fake-agent` app factory, swapping the `AgentSpec` interpretation: a `CassetteSpec` loads the cassette JSON and produces the same `FakeRunner.script(...)` call the static `emits()` path produces. Replay = fake-agent engine, different event source. | Parent §5.6 ("Replay = `fake-agent` engine, different event source") + §11 north star (no copy-paste). Keeps the recorded driver thin. |
| **D-P3.3** | **`real-agent` reuses the same full-host body; the swap *is* the promotion** | The real driver reuses the same full-host app factory with a `RealAgentSpec` carrying a real `ClaudeRunner`/`CodexRunner` + prompt in the agent slot. `skip()` = `!canRunRealTmuxE2E()` (or `!which claude/codex`). `timeout` budgets a real CLI turn (larger than the fake budget). | Parent §9.7 ("the real ClaudeRunner in the agent slot — the ONLY difference from §9.5") + D8 (reachable only by path). It asserts pane integration, not the runner in isolation (§5.6). |
| **D-P3.4** | **`fromCassette`/`claudeAgent`/`codexAgent` are new `AgentSpec` variants** | Add `CassetteSpec { kind:'cassette'; file: string }` and `RealAgentSpec { kind:'real-agent'; runner:'claude'\|'codex'; prompt: string }` to the `AgentSpec` union in `tests-new/dsl/agent-spec.ts`; export `fromCassette(file)`, `claudeAgent(prompt)`, `codexAgent(prompt)` from the barrel. Cassette file paths resolve relative to `tests-new/full-host/recorded-agent/cassettes/`. | Mirrors the U2 pattern for `emits`/`live`/`holdsOpen`; the worked examples (§9.6/§9.7) pass `agent: fromCassette(...)` / `agent: claudeAgent(...)`. |
| **D-P3.5** | **`record.ts` is a `bun run` entrypoint, not a test; verify-by-replay is the test** | `record.ts` (under `tests-new/full-host/recorded-agent/`) runs a `real-agent` scenario once via the `onEvent` tap, dumps `{ events, terminal }` + metadata to `cassettes/<scenario>.json`, validates the schema (Zod), and formats deterministically (stable key order, trailing newline). A **`--verify` mode** replays the cassette through the shim and asserts round-trip. The driver-level test (`recorded-agent-driver.test.ts`) exercises schema-reject / schema-accept / replay round-trip against a **checked-in fixture cassette** (no live CLI). | Parent §5.6 + D9. The tracer must be deterministic and CLI-free; only `record.ts` itself touches a real CLI, and only when a human re-records. |
| **D-P3.6** | **Overlap report AST-parses; non-blocking in U3** | `overlap-report.ts` reuses the U1 `snapshot.ts` TS-AST approach to read the literal `scenario({...})` first argument across `tests-new/**` (never `import`s a scenario file — that would register/execute Bun tests, parent §5.3). It flags (a) any `overlapGroup` with a `model` member but no `screen`/`full-host` twin, and (b) `oldTestRefs` not present in the frozen `baseline.json`. In U3 it is exposed as a `bun run overlap-report` script that **prints findings and exits 0** (non-blocking); it is **not** added to `check`. U4's plan makes it blocking. | Parent §U3 ("U3 wires it non-blocking, U4's plan flips it to blocking") + §5.3 import-time purity. |
| **D-P3.7** | **`check` repoint is additive and stays green on both trees** | `test` → `test:project` (= `test:legacy` + `test:new-unit` + `test:new-int` + `test:new-e2e` + `test:two-pane`); `check` → `lint && typecheck && test && test:two-pane:lifecycle`; `check:release` adds `test:project` (incl. real e2e gates) + `test:two-pane:full:real`. `real-agent` is unreachable from `check` (only `check:release`). `test:legacy` keeps old `tests/{unit,integration}` **and** old `tests/e2e` (via `test:legacy:e2e`, env-gated) on the gate until U14. | Parent §8 verbatim ladder + D8. The gate must not silently drop the old suite or old e2e during migration (R8). |
| **D-P3.8** | **Bare-`bun test` guard is a preload appended to `bunfig.toml`** | Ship `tests-new/dsl/preload-warn-bare-bun-test.ts`; add it to the existing `bunfig.toml` `preload` array (alongside `cleanup-stale-tmux.ts`). It inspects `Bun.argv`/`process.argv` and, when `bun test` ran with **no path argument**, prints a one-line warning naming `bun run test:two-pane:fast` as the default. Non-blocking (warn only, never exits non-zero). | Parent D7 ("cheap, honest, non-blocking"). Directional detection only — exact argv heuristic resolved at implementation time (see Deferred notes). |
| **D-P3.9** | **R12 tier-grep gate definition** | "Done" = a repo-wide grep `grep -rniE 'tier[ -][1-5]\|five-tier' .claude/skills CLAUDE.md README.md docs/testing-strategy.md` returns only **intentional historical** references (e.g. a "superseded the five tiers" sentence in the rewritten doc, marked as such). `improve-codebase-architecture/LANGUAGE.md` is excluded (architectural "tier"). `orch-qa-engineer` and `phase-implementer` are re-read for prose tier references even though the pattern grep is clean. | Parent R12 + §U3 sequencing note ("grep returns only intentional historical references"). |

---

## 5. Directional design — how the two drivers and the audit machinery plug in

> *Directional guidance for review — not implementation specification. The
> implementing agent refines names/shapes in its own work where reality demands,
> honouring the parent's §5 contract.*

### 5.1 Recorded / real drivers reuse the full-host engine

```
  scenario(meta, body)                         [unchanged, U1]
        │  meta.drivers → DRIVERS[name].build(meta)
        ▼
  full-host engine (U2 factory)  ── boots two-pane host on real tmux,
        │                            feeds the agent slot from an AgentSpec
        ├── AgentSpec = emits/live          → FakeRunner / scriptedFake   [U2]
        ├── AgentSpec = cassette            → FakeRunner.script(from cassette)  [U3 recorded]
        └── AgentSpec = real-agent          → ClaudeRunner / CodexRunner        [U3 real]
        ▼
  RightPane (real-tmux bytes / semantic methods)   [U2]
```

**`full-host:recorded-agent`** — `build(meta)` reuses the U2 full-host app factory.
The cassette path: `fromCassette('x.json')` → load + Zod-validate the cassette →
shim `{ events, terminal }` into `FakeRunner.script({ events, ...mapTerminal(terminal) })`.
`skip()` = `!canRunRealTmux()` (boots real tmux, no real CLI). `timeout` =
`REAL_TMUX_TEST_TIMEOUT_MS`. Deterministic, no CLI, no network — safe on the gate.

**`full-host:real-agent`** — same factory, `claudeAgent(prompt)`/`codexAgent(prompt)`
puts a real runner in the agent slot. `skip()` = `!canRunRealTmuxE2E()` (tmux +
`which claude`/`which codex`). `timeout` budgets a real CLI turn. Reachable **only**
via `test:two-pane:full:real` (D8); never in `check`.

### 5.2 The cassette type (D9, verified against `src/runners/types.ts`)

```ts
// tests-new/full-host/recorded-agent/cassette.ts  (directional)
interface RecordedAgentCassette {
  schemaVersion: 1
  runner: 'claude' | 'codex'
  runnerVersion?: string
  recordedAt: string
  sourceCommand: readonly string[]
  workflowName: string
  scenarioId: string
  prompt: string
  eventSchema: 'RunnerEvent'
  events: readonly InfoEvent[]        // streamed info events (kind:'info'), via the onEvent tap
  terminal: TerminalEvent             // the single terminal outcome, captured separately
}

// replay shim (directional)
function cassetteToScript(c: RecordedAgentCassette): FakeScript {
  return c.terminal.type === 'error'
    ? { events: c.events, failWith: { message: c.terminal.message } }
    : { events: c.events, structuredOutput: c.terminal.data }
}
```

### 5.3 `record.ts` (re-record entrypoint, D9/§5.6)

`bun run tests-new/full-host/recorded-agent/record.ts --scenario <id>` runs a
`real-agent` scenario once with the `onEvent` tap installed; partitions the stream
into `events` (info) + `terminal`; writes `cassettes/<id>.json` validated +
deterministically formatted; `--verify` replays through `cassetteToScript` →
`FakeRunner.script` and asserts the round-trip. Raw parser fixtures stay at the
runner layer (§5.6) — the cassette is **not** raw CLI stdout.

### 5.4 The overlap report (§5.5/§5.3, non-blocking in U3)

`overlap-report.ts` AST-walks `tests-new/**` for literal `scenario({...})` first
arguments (the same TS-AST technique `snapshot.ts` uses, **never** importing the
file). It builds `{ overlapGroup → [{file, drivers, oldTestRefs}] }` and reports:
groups missing a cross-fidelity twin, and `oldTestRefs` absent from the frozen
`baseline.json`. In U3 it runs via `bun run overlap-report`, prints, and exits 0.

---

## 6. Implementation units

> **Ordering rationale.** U3.1 (cassette + recorded driver) and U3.2 (real driver)
> complete the driver set and reuse the proven U2 full-host engine — recorded
> first because it is CLI-free and gives the real driver a verified body to swap
> into. U3.3 (overlap report + ledger) builds the audit machinery the migration
> phases lean on. U3.4 (script ladder + guard) wires the gate, which needs every
> bucket to already exist. U3.5 (docs/skill rewrite + convention flip) is last but
> still **within U3, before U4** — it is gated by the tier-grep and is the
> precondition for autonomous migration phases writing new-shape tests. Each unit
> wires its driver/script into place as it completes; `bun run check` (old gate)
> stays green until U3.4 deliberately repoints it onto both trees.

---

### U3.1. Cassette format + `record.ts` + `recorded-agent` driver + `fromCassette`

**Goal.** Define the `RecordedAgentCassette` type and replay shim (D-P3.1), build
the `full-host:recorded-agent` driver by reusing the U2 full-host engine with a
cassette event source (D-P3.2), ship `record.ts` (record + `--verify`, D-P3.5),
add the `fromCassette` agent-spec helper (D-P3.4), and prove it with a tracer
backed by a checked-in fixture cassette.

**Requirements.** Parent §4 (recorded mode), §5.4, §5.5, §5.6, D9; this plan
D-P3.1, D-P3.2, D-P3.5.

**Dependencies.** Parent U2 (the full-host engine, `_support/real-tmux`).

**Files (create / modify).**
- `tests-new/full-host/recorded-agent/cassette.ts` — `RecordedAgentCassette` type,
  Zod schema, `cassetteToScript()` shim, deterministic serializer.
- `tests-new/full-host/recorded-agent/record.ts` — re-record + `--verify`
  entrypoint (runs a `real-agent` scenario through the `onEvent` tap).
- `tests-new/full-host/recorded-agent/cassettes/.gitkeep` + one checked-in fixture
  cassette `claude-plan-then-work.json` for the tracer.
- `tests-new/dsl/drivers/full-host-recorded-agent-driver.ts` — the driver
  (reuses the U2 full-host factory; `skip()`=`!canRunRealTmux()`;
  `timeout`=`REAL_TMUX_TEST_TIMEOUT_MS`).
- `tests-new/dsl/drivers/__tests__/recorded-agent-driver.test.ts` — schema
  validation + replay round-trip (against the fixture cassette).
- `tests-new/full-host/recorded-agent/claude-plan-then-work.test.ts` — tracer.
- `tests-new/dsl/agent-spec.ts` — add `CassetteSpec` to the union + `fromCassette()`.
- `tests-new/dsl/index.ts` — export `fromCassette`.
- `tests-new/dsl/drivers/registry.ts` — replace the `full-host:recorded-agent` stub.
- `package.json` — add `test:two-pane:full:recorded` (bucket; folded into `tmux`
  level in U3.4).

**Approach.**
- The driver reads `meta`/`spec.agent`; for a `CassetteSpec` it loads + validates
  the cassette and calls `FakeRunner.script(cassetteToScript(cassette))`, then
  drives the full-host engine exactly as the static `emits()` path does (D-P3.2).
- `record.ts` installs the `onEvent` tap (`runRunner(..., { onEvent })`,
  `src/runners/execute.ts`), partitions `info` vs `terminal`, validates, formats
  deterministically (sorted keys, fixed timestamp source passed in, trailing
  newline), writes the cassette. `--verify` round-trips through the shim.
- The tracer uses the **checked-in fixture cassette**, never a live record — it must
  be deterministic and CLI-free.

**Patterns to follow.** `tests-new/dsl/drivers/full-host-fake-agent-driver.ts`
(the factory + `AgentSpec` interpretation to extend); `tests-new/_migration/snapshot.ts`
(deterministic serialization discipline); `src/runners/fake/fake-runner.ts`
(`FakeScript` target shape); `src/runners/execute.ts` (`onEvent`); Zod usage in
`src/runners/types.ts`.

**Test scenarios.**
- `record.ts` (via its exported pure core) **rejects** a cassette missing a
  required field (e.g. no `terminal`, wrong `eventSchema`) and **accepts** a valid
  one. *(error + happy)* — `Covers D9.`
- `cassetteToScript` maps a `turn-complete` terminal to `structuredOutput` and an
  `error` terminal to `failWith: { message }`; replay round-trips the `events`
  through `FakeRunner.script` and the parsed stream equals the cassette stream.
  *(integration / critical)*
- The serializer is **deterministic**: serializing the same cassette twice yields
  byte-identical output; key order is stable. *(edge)*
- `recorded-agent` driver `build()` boots real tmux but spawns **no** real CLI
  (assert no `claude`/`codex` process); `teardown()` reaps server + socket, zero
  orphans. *(integration / critical)*
- Tracer `claude-plan-then-work [full-host:recorded-agent]` replays the fixture
  cassette deterministically and the right pane shows the rendered event
  (`assertRenderedToolUse('Write')` or content escape hatch). *(integration)*

**Verification.** `bun run test:two-pane:full:recorded` green and CLI-free;
`record.ts --verify` round-trips the fixture; `fromCassette` exported + typed;
the recorded stub is replaced in `DRIVERS`; old `check` still green.

---

### U3.2. `real-agent` driver + `claudeAgent`/`codexAgent`

**Goal.** Build the `full-host:real-agent` driver by reusing the same full-host
body with a real `ClaudeRunner`/`CodexRunner` in the agent slot (D-P3.3), add the
`claudeAgent`/`codexAgent` agent-spec helpers (D-P3.4), gate it so it is reachable
only by path (D8), and prove it with one smoke tracer (the swap-agent-slot proof).

**Requirements.** Parent §4 (real mode), §4.1, §5.6, D8; this plan D-P3.3, D-P3.4.

**Dependencies.** U3.1 (a verified full-host recorded body to swap the runner into).

**Files (create / modify).**
- `tests-new/dsl/drivers/full-host-real-agent-driver.ts` — driver
  (`skip()`=`!canRunRealTmuxE2E()`; larger real-CLI `timeout`).
- `tests-new/full-host/real-agent/autonomous-multi-step.test.ts` — gated smoke tracer.
- `tests-new/dsl/agent-spec.ts` — add `RealAgentSpec` + `claudeAgent()`/`codexAgent()`.
- `tests-new/dsl/index.ts` — export `claudeAgent`, `codexAgent`.
- `tests-new/dsl/drivers/registry.ts` — replace the `full-host:real-agent` stub.
- `package.json` — add `test:two-pane:full:real` (bucket; never in `check`).

**Approach.**
- The driver reuses the U2 full-host factory; for a `RealAgentSpec` it constructs
  the named real runner (`src/runners/index.ts`) with the spec's `prompt` and
  places it in the agent slot — the swap **is** the promotion, no copy-paste
  (parent §9.7).
- `skip()` = `!canRunRealTmuxE2E()` (tmux + `which claude`/`which codex` on PATH,
  per `_support/real-tmux`); auto-skips cleanly on an incapable box, never a false
  failure (D8).

**Patterns to follow.** `tests-new/dsl/drivers/full-host-recorded-agent-driver.ts`
(U3.1, the body to reuse); `src/runners/claude/`, `src/runners/codex/`,
`src/runners/index.ts` (constructing the real runner); old `tests/e2e/tier-4/*`
(the assertion style being re-derived as a smoke).

**Test scenarios.**
- `real-agent` driver is **unreachable** except by naming its path; it auto-skips
  when `canRunRealTmuxE2E()` is false (no `claude`/`codex` or no tmux) — assert the
  scenario reports skipped, not failed. *(gating / critical)*
- `claudeAgent('...')` / `codexAgent('...')` produce a `RealAgentSpec` the driver
  routes to the correct real runner. *(happy)*
- Tracer `autonomous-multi-step [full-host:real-agent]`: a real Claude step's
  output paints in the right pane (`assertShowsContent('OK')`), proving the binary
  integrates **inside** the two-pane system — runnable only on a capable box.
  *(integration, gated)*

**Verification.** `bun run test:two-pane:full:real` runs the smoke on a capable
box and auto-skips otherwise; `claudeAgent`/`codexAgent` exported + typed; the real
stub is replaced in `DRIVERS`; `bun run typecheck` green; old `check` still green.

---

### U3.3. Overlap report + ledger template (non-blocking)

**Goal.** Ship `overlap-report.ts` (AST-parses scenario metadata; flags missing
overlap-group twins and ledger gaps against the frozen baseline; registers zero
Bun tests, D-P3.6) and the `ledger.md` template with its first illustrative rows.
Wire it as a **non-blocking** `bun run overlap-report` script (U4 flips it to
blocking).

**Requirements.** Parent §5.3 (import-time purity), §5.5 (overlap report), §10.4,
D12 (queries the frozen baseline); this plan D-P3.6.

**Dependencies.** U3.1, U3.2 (so the report sees a complete driver set and real
`overlapGroup` examples from the tracers).

**Files (create).**
- `tests-new/_migration/overlap-report.ts` — AST parser + report (reuses the
  `snapshot.ts` TS-AST technique; **never** imports a scenario file).
- `tests-new/_migration/__tests__/overlap-report.test.ts` — unit tests over the
  report on fixture inputs (missing-twin, ledger-gap, zero-Bun-tests-fired).
- `tests-new/_migration/ledger.md` — template (the §9.10 table shape) + first rows
  for the existing U1/U2 tracers' `oldTestRefs`.
- `package.json` — add `overlap-report` script (non-blocking; **not** in `check`).

**Approach.**
- The parser walks `tests-new/**` source, finds `CallExpression`s named `scenario`
  whose first argument is an object literal, and reads `drivers`, `overlapGroup`,
  `oldTestRefs` as static literals (parent §5.3 guarantees they are). It must
  **not** `import` the files (that registers/executes Bun tests, §5.3).
- Cross-references `oldTestRefs` against `tests-new/_migration/baseline.json`
  (frozen, D12) and reports any ref not found, and any `overlapGroup` whose members
  span only one fidelity family.
- The ledger template carries the columns from §9.10 (`Old file | Old scenario |
  New scenario (path) | Disposition | Reason`) and the `new`-tag convention (parent
  §U3 during-migration routing rule) for tests born in `tests-new/` with no baseline
  entry.

**Patterns to follow.** `tests-new/_migration/snapshot.ts` (TS-AST walk that never
imports test files — the exact technique); parent §9.10 (ledger row shape); parent
§5.3 import-time-purity note.

**Test scenarios.**
- The report, run over a fixture tree, flags a **deliberately missing** overlap
  twin (a `model` member with no `screen`/`full-host` twin) and passes when the
  twin is present. *(critical)*
- The report flags a `oldTestRefs` entry **absent** from the frozen baseline and
  passes when present. *(critical)* — `Covers D12.`
- Running the report registers **zero** Bun tests during collection (assert no
  `it()` fires — it parses, never imports). *(critical)* — parent §5.3 guard.
- The ledger template parses as the §9.10 table shape and includes a `new`-tag row
  convention example. *(edge)*

**Verification.** `bun run overlap-report` runs, prints findings, and exits 0
(non-blocking in U3); its unit tests pass; the report imports **no** scenario file;
`ledger.md` exists with the template + first rows; old `check` still green.

---

### U3.4. Full script ladder + bare-`bun test` guard + concurrency + `check` repoint

**Goal.** Lay down the complete §8 script ladder (atomic buckets incl. the two new
full-host buckets, cumulative levels, `test:legacy` incl. old e2e,
`test:new-{unit,int,e2e}`, `test:project`, `check`, `check:release`), encode the
§D6/D14 concurrency flags on every tmux bucket, repoint `check`/`test` onto **both**
trees (D-P3.7), and ship the bare-`bun test` guard preload (D-P3.8).

**Requirements.** Parent §7 (PR-style ladder), §8 (the verbatim ladder), D6, D7,
D8, D14; this plan D-P3.7, D-P3.8.

**Dependencies.** U3.1, U3.2 (the `full:recorded` / `full:real` buckets must exist
before the cumulative levels reference them).

**Files (create / modify).**
- `package.json` — the full §8 ladder:
  - atomic: confirm `test:two-pane:{model,tmux-argv,screen,full:fake,lifecycle}`;
    add `test:two-pane:full:recorded`, `test:two-pane:full:real`.
  - cumulative: `test:two-pane:fast` (model + tmux-argv); `test:two-pane:tmux`
    (`--max-concurrency=2` over screen + full:fake + **full:recorded**);
    `test:two-pane` (`fast && tmux`); `test:two-pane:lifecycle`
    (`--max-concurrency=1`); `test:two-pane:all` (`+ full:real`).
  - rest-of-repo: `test:new-unit`, `test:new-int`, `test:new-e2e` (env-gated).
  - transition: `test:legacy:e2e` (`RUN_REAL_E2E=1 bun test tests/e2e`),
    `test:legacy` (`bun test tests/unit tests/integration && test:legacy:e2e`),
    `test:project`, `test` (→ `test:project`).
  - gate: `check` (`lint && typecheck && test && test:two-pane:lifecycle`),
    `check:release` (`+ test:project + test:two-pane:full:real`).
- `tests-new/dsl/preload-warn-bare-bun-test.ts` — the D7 guard preload.
- `bunfig.toml` — append the guard preload to the existing `preload` array.

**Approach.**
- Mirror parent §8 exactly; keep the `// D14` concurrency comments. Fold the new
  `full:recorded` bucket into the `tmux` cumulative level (parent §8 marks this).
- The `check` repoint is the load-bearing edit: after it, `bun run check` runs old
  `tests/{unit,integration}` + old e2e (env-gated) + the full new tree (`test:new-*`
  + `test:two-pane`) + serial lifecycle. `real-agent` stays out of `check`; only
  `check:release` runs it (after `which claude codex`).
- The guard preload inspects argv for a bare `bun test` (no path) and prints a
  one-line warning; never exits non-zero (D7).

**Patterns to follow.** Parent §8 ladder block (verbatim target); the existing
U2 buckets in `package.json`; `bunfig.toml`'s current `preload` array shape.

**Test scenarios.**
- Each of the seven atomic buckets is runnable **by path** (D8); a quick dry-run of
  each resolves to the right directory set. *(happy)*
- `bun run check` runs old + new and is **green** (the repoint did not drop the old
  suite or break the new tree). *(critical)* — `Covers R8.`
- `bun run check:release` additionally requires `which claude codex` and runs
  `test:two-pane:full:real`. *(gating)*
- `test:legacy` includes old `tests/e2e` (env-gated) so it is not silently dropped
  from the gate during migration. *(edge)* — `Covers R8.`
- Bare `bun test` (no path) prints the guard warning naming
  `bun run test:two-pane:fast`; `bun test <path>` does **not**. *(edge)* — `Covers D7.`

**Verification.** `bun run check` green on both trees; all atomic buckets runnable
by path; the §D6/D14 concurrency flags present on every tmux bucket
(`lifecycle`=1 serial); the bare-`bun test` warning fires only with no path;
`bun run typecheck` green.

---

### U3.5. Docs + skill rewrite (R12) + convention flip + phase DoD

**Goal.** Rewrite `docs/testing-strategy.md` as the canonical new reference, update
`CLAUDE.md` / `README` / every tier-coded skill, gate the rewrite with the
repo-wide tier-grep (D-P3.9), document the during-migration routing rule, and close
the phase. This **must complete before U4 starts** — autonomous migration phases
load these skills.

**Requirements.** Parent §6 (decision rule replaces "when to write at which tier"),
§7 (docs rewrite BEFORE any migration phase), §11 (per-feature recipe), R12; this
plan D-P3.9.

**Dependencies.** U3.1–U3.4 (the docs describe the now-complete driver set, ladder,
and overlap report).

**Files (rewrite / modify).**
- `docs/testing-strategy.md` — **rewrite** as the canonical reference: the
  scenario/driver DSL, the §6 decision rule (`model`/`screen`/`full-host`/
  `lifecycle`/`tmux-argv`/`unit`), the §11 per-feature recipe, the predictability
  rules (now owned by drivers), the script ladder. Supersede the five tiers (a
  single "this replaces the former five-tier model" historical note is allowed).
- `CLAUDE.md` — rewrite "How to write tests" + "How to write a two-pane test" + run
  guidance; name `bun run test:two-pane:fast` as the default; ban bare `bun test`.
- `README.md` — update the test-script section (`bun run test`, `test:two-pane:*`,
  `check`/`check:release`) to the new ladder.
- `.claude/skills/testing-strategy/SKILL.md` — rewrite to the DSL/decision-rule.
- `.claude/skills/runner-author/SKILL.md` — fix old `tests/` paths → new layout
  (`tests-new/unit/runners/**`, the recorded/real cassette guidance).
- `.claude/skills/orch-acceptance-tests/SKILL.md` — de-tier (remove the Tier 1–5
  enumeration; map to the new categories).
- `.claude/skills/orch-workflow-author/SKILL.md` — fix the single tier reference.
- `.claude/skills/orch-qa-engineer/SKILL.md`, `.claude/skills/phase-implementer/SKILL.md`
  — re-read for prose tier references the pattern grep misses; de-tier the
  `scriptedFake`/two-pane-test guidance (qa-engineer stays "not a tier, not on the
  gate", parent §6).
- This plan (`## 7` DoD) — record the convention flip + during-migration routing rule.

**Approach.**
- The decision rule (parent §6) replaces "when to write at which tier" everywhere.
- Document the **during-migration routing rule** (parent §U3): after U3, new
  two-pane behavioural tests go under `tests-new/` in the new shape; new
  *non-two-pane* tests go to their **old** `tests/{unit,integration,e2e}` home
  (so U10–U13 relocate them) **unless** that module is already relocated, in which
  case they go straight to `tests-new/` with a same-PR ledger row tagged `new`.
- `orch-qa-engineer` stays explicitly **outside** the automated taxonomy (parent
  §6 — not a driver, not on `check`); only de-tier its prose.

**Test scenarios.** *Test expectation: none — documentation + skill prose, no
behavioural change.* The verification gate is the tier-grep (D-P3.9), not a unit
test.

**Verification.** The repo-wide tier-grep (D-P3.9) returns only intentional
historical references across `.claude/skills/**`, `CLAUDE.md`, `README.md`,
`docs/testing-strategy.md`; `docs/testing-strategy.md` documents the DSL/decision
rule, not tiers; `CLAUDE.md` names `bun run test:two-pane:fast` and bans bare
`bun test`; `bun run docs:build` green (no dead internal links) if public docs were
touched; **the convention is now flipped** — subsequent work writes only new-shape
tests, routed per the during-migration rule.

---

## 7. Definition of Done (phase U3)

- `DRIVERS` wires real `full-host:recorded-agent` and `full-host:real-agent`
  drivers; **no** stub drivers remain (the `DriverName` union is fully live).
- The `RecordedAgentCassette` type + Zod schema + `cassetteToScript` shim exist;
  `record.ts` records (via the `onEvent` tap) and `--verify`-replays; one checked-in
  fixture cassette backs the recorded tracer (CLI-free, deterministic).
- `fromCassette`, `claudeAgent`, `codexAgent` agent-spec helpers are exported and
  typed; the `AgentSpec` union carries `CassetteSpec` + `RealAgentSpec`.
- Three driver/tracer deliverables green: recorded-agent driver test + tracer
  (`bun run test:two-pane:full:recorded`); real-agent smoke runs on a capable box
  and auto-skips otherwise (`bun run test:two-pane:full:real`).
- The full §8 script ladder exists with §D6/D14 concurrency flags on every tmux
  bucket (`tmux`=`--max-concurrency=2`, `lifecycle`=`--max-concurrency=1` serial);
  `check` runs old + new and is green; `check:release` adds real e2e + real-agent
  behind `which claude codex`; `test:legacy` keeps old e2e on the gate.
- The bare-`bun test` guard preload is wired into `bunfig.toml` and warns only with
  no path (D7).
- `overlap-report.ts` exists, AST-parses scenario metadata (registers zero Bun
  tests), cross-checks the **frozen** baseline, and runs **non-blocking** via
  `bun run overlap-report`; `ledger.md` template + first rows exist. (U4 flips the
  report to blocking — not U3.)
- `docs/testing-strategy.md`, `CLAUDE.md`, `README`, and all tier-coded skills are
  rewritten; the repo-wide tier-grep (D-P3.9) is clean of unintentional references;
  the during-migration routing rule is documented. **The convention is flipped.**
- `bun run check` green (both trees); `bun run typecheck` green; U3 marks **no**
  old test `.skip` and adds **no** migration ledger rows beyond the template's
  illustrative seed rows.

---

## 8. Deferred to implementation (execution-time unknowns)

These depend on reading real code / running real CLIs and must **not** be
pretended-resolved here:
- The exact argv heuristic the bare-`bun test` guard uses to detect "no path"
  (`Bun.argv` shape under `bun test` vs `bun run test:*` vs `bun test <path>`) —
  discover by inspecting `process.argv`/`Bun.argv` at preload time (U3.4/D-P3.8).
- The precise right-pane assertion for the recorded tracer (`assertRenderedToolUse`
  vs the content escape hatch) — depends on how the fixture cassette's `tool_use`
  event renders through `toTranscriptLines` on the real terminal (U3.1).
- Whether `record.ts` shares the `real-agent` driver's launch path directly or a
  thinner harness — pick the shape that keeps record + replay using the same body
  (U3.1/U3.2).
- The exact measured wall-clock impact of folding `full:recorded` into the `tmux`
  cumulative level at `--max-concurrency=2` — confirm no leak accumulation on a
  capable box (U3.4; the U2 measurement found N flat, re-confirm with recorded added).
- Whether any public `docs/public/**` page references the old test commands and must
  be reconciled (run `bun run docs:build`) — scope discovered at U3.5.
- The final list of prose tier references in `orch-qa-engineer` / `phase-implementer`
  the pattern grep misses — resolved by re-reading both at U3.5 (D-P3.9).

---

## 9. Risks & mitigations (phase-local view)

| Risk | Likelihood | Mitigation |
|---|---|---|
| **R7 (parent) — cassette drift silently re-tests stale CLI behaviour.** | Low | D9/D-P3.1: cassettes capture *our* normalised `RunnerEvent` (changes rarely), not raw CLI stdout; `record.ts --verify` round-trips; raw parser fixtures stay at the runner layer as the real drift guard; the recorded tracer uses a checked-in fixture, never a live record. |
| **R12 (parent) — stale tier-coded skills make U4+ write old-shape tests.** | Medium | U3.5 rewrites **all** tier-coded docs/skills **before U4 starts**, gated by the repo-wide tier-grep (D-P3.9), incl. re-reading the two grep-clean skills for prose references; U14 re-runs the grep repo-wide. |
| **P3-A — `check` repoint breaks one tree while greening the other.** | Medium | D-P3.7: the repoint is additive (`test:legacy` keeps old `{unit,integration}` + old e2e; `test:new-*` + `test:two-pane` add the new tree); U3.4's critical scenario is "`bun run check` green on both trees"; `real-agent` stays out of `check`. |
| **P3-B — overlap report imports a scenario file and registers/executes Bun tests.** | Medium | D-P3.6/§5.3: the report **AST-parses** the literal `scenario({...})` first argument (reusing `snapshot.ts`'s technique) and never `import`s a scenario file; a dedicated test asserts zero `it()` fired during a report run. |
| **P3-C — recorded driver re-implements full-host wiring (copy-paste).** | Low | D-P3.2: the recorded/real drivers **reuse** the U2 full-host factory; only the `AgentSpec` interpretation (event source) differs — the north star (parent §11) bars copy-paste. |
| **P3-D — `real-agent` accidentally runs in `check` / CI without a CLI.** | Low | D8/D-P3.3: `skip()`=`!canRunRealTmuxE2E()` (auto-skips, never false-fails); the bucket is reachable **only** by path and is in `check:release` (gated by `which claude codex`), never `check`. |
| **P3-E — overlap report flipped to blocking too early, failing U3.** | Low | Parent §U3 + D-P3.6: U3 wires it **non-blocking** (`bun run overlap-report`, exits 0, not in `check`); U4's plan — not this one — flips it to blocking once the first real ledger rows exist. |

---

## 10. Requirements traceability

| Parent requirement | Where addressed |
|---|---|
| §4 (recorded mode) + §5.6 + D9 (cassette = normalised events) | U3.1 |
| §4 (real mode) + §4.1 + §9.7 (swap agent slot) | U3.2 |
| §5.4 (predictability rules in the driver — reused from U2 engine) | U3.1, U3.2 (full-host factory) |
| §5.3 (import-time purity — AST parse, never import) | U3.3 / D-P3.6, P3-B |
| §5.5 (overlap report; `model`↔`screen` contract twin) | U3.3 |
| §7 / §8 (full script ladder, PR2–PR3, concurrency) | U3.4 / D-P3.7 |
| D6 / D14 (concurrency encoded; lifecycle serial) | U3.4 |
| D7 (bare-`bun test` guard) | U3.4 / D-P3.8 |
| D8 (selection by path; `skip()` only prevents false failure) | U3.2, U3.4 |
| D12 (overlap report queries the frozen baseline) | U3.3 |
| §6 (decision rule replaces "which tier") + §11 (per-feature recipe) | U3.5 |
| R12 (rewrite all tier-coded skills before U4, grep-gated) | U3.5 / D-P3.9 |
| Parent §U3 "convention flip + during-migration routing rule" | U3.5 §7 DoD |
| Parent §U3 "overlap report non-blocking in U3, blocking at U4" | U3.3 / D-P3.6, P3-E |
| Parent U3 **non-goal**: no old-test skip, no real ledger rows (template only) | §3 Out of scope, §7 DoD |
