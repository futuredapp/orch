---
name: orch-acceptance-tests
description: >-
  Author plain-language behavioral acceptance tests (Given/When/Then) from a finished
  brainstorm or plan — the step between brainstorming and planning. Use this whenever a
  brainstorm, requirements, or plan doc is ready and you need acceptance criteria,
  acceptance tests, behavioral tests, or a readable definition of "done" — even if the user
  only says "what should we test", "turn this into testable behaviors", "add acceptance
  criteria", "how will we know it works", or names a brainstorm/plan file and asks for the
  tests. Produces ID'd, behavior-only tests (never implementation details) in a sidecar doc,
  with an infrastructure-feasibility appendix and an implementation status table. This is the
  authoring step BEFORE planning or implementation — it does not write real test code.
---

# Acceptance Test Author

Turn a finished brainstorm or plan into a small set of **plain-language behavioral acceptance tests**: one behavior per test, written so a non-technical reader understands exactly what the change must do. These become the contract the implementation is later checked against — read the tests, know the feature works, without reading the code.

You are authoring *specifications of behavior*, not test code. The plan and implementation phases turn these into real, executing tests. Your job is to make sure the right behaviors are named, unambiguously, before anyone writes a line of implementation.

## What a good acceptance test is

A good test describes **observable behavior through the public surface** — what a user or caller experiences — and nothing about how it is built.

- **Name says the *what*, never the *how*.** "Empty input is not sent to the backend" — not "validateInput returns false for empty string."
- **One behavior, one logical assertion.** If a test needs "and also," split it.
- **Behavior, not internals.** Never assert on call counts, invocation order, private methods, or by reaching past the interface (e.g. reading the database directly when the app exposes a way to read it back). Verify results the same way a real caller would.
- **Refactor-resilient.** A correct test survives any internal rewrite that keeps the behavior. If renaming an internal function would break it, it was testing implementation.
- **Plain language.** A product person reads it and agrees it is what they want. No type names, no function names, no framework nouns.
- **Negatives and edges are first-class.** "Does nothing when X" and "rejects Y" carry as much of the spec as the happy path. Most under-specified features hide in the negatives.
- **Default to the real entry point.** Drive the behavior the way the system is actually triggered — launch the real run / request / command — and observe at its true external boundary. Drop to an internal seam (constructing a synthetic event and poking a port directly) *only* when the behavior is genuinely unreachable from outside, and say so when you do. The trap: a seam-poked test passes even if the production wiring never emits that event — i.e. even if the feature is **completely unwired**. An acceptance test that can pass on an unwired feature is not an acceptance test. When you must use a seam (e.g. "the signal is observable by a second, non-primary consumer"), name that as the surface deliberately, not by convenience.

You are NOT covering everything. Cover the **change delta** — what this brainstorm/plan adds, changes, or removes — plus the few behaviors that must *not* break. Skip behavior the change does not touch.

## Test format

Each test is exactly this shape:

```
### AT-3 — Empty input is not sent to the backend

- **Given** the form is open and the field is empty
- **When** the user submits
- **Then** no request carrying that field reaches the backend
- **Observable through** the real submit flow + the network boundary
```

ID (`AT-N`, stable for the life of the doc) · one-sentence name describing the *what* · Given/When/Then · single assertion in the **Then** · an **Observable through** line.

**The `Observable through` line** names the *outermost* surface the behavior can be observed at — what drives it and where you watch. "The real submit flow + the network boundary", not "the validator's return value". This is the altitude decision made explicit at spec time: naming the outermost reachable surface structurally pushes the eventual test to drive the real entry point (per "Default to the real entry point" above) rather than reach for an inner seam. If the only honest surface *is* an internal seam, say so here ("a second consumer of the X port") — that records a conscious choice the Phase 5 review can audit.

**Worked example** — "add an optional field that posts to the backend" yields a *family* of tests, including the negatives:

- `AT-1 — A typed value is sent on submit` (Given a value is typed / When submit / Then the request carries that value).
- `AT-2 — Empty input is not sent` (Given empty / When submit / Then no such field in the request).
- `AT-3 — A typed-then-cleared input is not sent` (Given typed then deleted / When submit / Then no such field in the request).
- `AT-4 — A received value is persisted` (Given the backend receives the value / When stored / Then reading it back returns it).

Note how `AT-1` and `AT-4` sit on different surfaces (frontend submit vs. backend persistence). Keep each test on a single surface; feasibility of *combining* surfaces is an infrastructure concern handled in the appendix, never a reason to merge or drop a behavior.

## Process

Work the phases in order. Do not skip the subagent passes — they are why the output is trustworthy.

### Phase 1 — Scope and parse the input

Read the input doc. Detect whether it is a **brainstorm/requirements** doc or a **plan**.

- Pull candidate behaviors from its Requirements, Key Flows, Success Criteria, Acceptance Examples, and Scope Boundaries (boundaries tell you what *not* to test).
- Identify the **delta**: what behavior is new, changed, or removed versus how things work today.
- If the input is a **plan**, add a standing note to the output (see Output) that a planning/implementation pass should confirm the infrastructure exists to realize these tests — the tests are the target, the plan must make them runnable.

### Phase 2 — Research current test infrastructure (subagent)

Launch a research subagent to map the **current** testing setup against the behaviors you found. It answers, per behavior: *can this be tested today, and where?* — and where it cannot, *what is missing?*

Give the subagent the behavior list and the project's testing strategy (see Project Details for the doc to point it at). Ask it to return, per behavior: testable-today (yes / no / partial), the **driving surface** (what would trigger it — prefer the real entry point: launching a run/request/command, not constructing a synthetic internal event), the **observation surface** (where the result is read — prefer the true external boundary), and any infrastructure gap. Tell it to favor the real entry point and flag any behavior whose only path today is poking an internal seam — that flag is a gap to record, not the recommended shape.

**Feasibility never gates which tests you write.** If a behavior matters but cannot be tested today, write the test anyway and record the gap in the appendix with a concrete suggestion for the testing-environment change needed. The only thing that removes a test is an **explicit, hard restriction** the user has stated — not "this would be slow" or "we have no harness for it yet."

### Phase 3 — Derive behaviors and resolve ambiguity

Turn the delta into the test family. For each behavior decide the happy path, the negatives, and the edges.

**Whenever a behavior is ambiguous — you cannot write a confident `Then`, or the doc gives conflicting/missing expected outcomes — stop and ask the user.** Use AskUserQuestion. Batch ambiguities so you ask in as few prompts as possible (up to four options each) rather than one at a time. Do *not* ask about anything you can resolve from the doc itself; only ask where the answer changes which tests exist or what their `Then` asserts.

### Phase 4 — Write the output

Write the **sidecar file** as the source of truth, and a **short linked section** back in the input doc. See Output structure below for the exact layout.

### Phase 5 — Review for coverage (subagent)

Launch a review subagent. Give it the input doc's delta and your test set. It checks: does every delta behavior have a test? Are the negatives and edges present, not just the happy path? Is any test secretly asserting on implementation? Does any test cover behavior outside the delta (cut it)?

It also applies the **unwired-feature triage rule** to every test: *"Would this test still pass if the feature were never wired into the real entry point — if the line that composes/registers it were deleted?"* If yes, the test is poking an internal seam and must be raised to drive the real entry point (or its `Observable through` surface corrected). This is the acceptance-test analog of the project's own triage rule (see Project Details) — it catches the failure mode where a test exercises a component in isolation and passes even though the feature does nothing in production. The only sanctioned exception is a behavior whose `Observable through` line *deliberately* names an internal seam because the behavior is genuinely unreachable from outside; the review confirms that choice was conscious, not convenient.

Fold its findings in, then have it (or you) populate the **status table** so every test starts auditable.

## Output structure

**Sidecar file** — `<input-doc-basename>-acceptance-tests.md`, in the same directory as the input. Source of truth. Layout:

```markdown
# Acceptance Tests — <feature name>

> High-level **behavioral acceptance criteria** for <feature>, derived from
> [<input doc>](<relative-link>). Each is meant to become a real, executing test.
> They describe behavior, not implementation — read them to know the feature works
> without reading the code. Track implementation by AT-ID in the status table below.
> <If input was a plan: "A planning pass should confirm the infrastructure to run these exists.">

## Tests

### AT-1 — <name>
- **Given** …
- **When** …
- **Then** …
- **Observable through** <outermost driving + observation surface>

### AT-2 — …

## Status

| ID   | Behavior            | Status | Test file | Notes |
| ---- | ------------------- | ------ | --------- | ----- |
| AT-1 | <short name>        | ⬜ todo |           |       |
| AT-2 | …                   | ⬜ todo |           |       |

Legend: ⬜ todo · ✅ implemented · 🚫 won't implement (reason in Notes)

## Feasibility appendix

The **Driving surface** is what triggers the behavior in the test (prefer the real
entry point — launch a run / request / command); the **Observation surface** is where
the result is read (prefer the true external boundary). These two columns replace a bare
"tier" verdict on purpose: naming both forces the altitude decision and exposes any test
that would drive an inner seam instead of the real entry point.

| ID   | Testable today | Driving surface | Observation surface | Gap & suggested change |
| ---- | -------------- | --------------- | ------------------- | ---------------------- |
| AT-1 | yes            | <launch real run / request> | <external boundary> | —          |
| AT-4 | no             | <what would drive it>       | <where you'd watch> | <what's missing + the testing-env change to add> |
```

**Linked section in the input doc** — append a compact `## Acceptance Tests` section near the end of the brainstorm/plan: the one-paragraph standing note, a link to the sidecar, and the at-a-glance ID + name list (not the full bodies — those live in the sidecar).

## This skill is done when

- The sidecar exists with ID'd, plain-language Given/When/Then tests covering the delta, including its negatives and edges.
- Every test is behavior-only — no test asserts on internals — and carries an **Observable through** line naming the outermost driving + observation surface (an internal seam appears there only when deliberately chosen and noted).
- Every test passes the unwired-feature triage rule: it would fail if the feature were never wired into the real entry point.
- The status table is present, one row per test, all auditable by ID.
- The feasibility appendix records, per test, testable-today, its **driving surface** and **observation surface**, and any infra gap with a concrete suggested change.
- The input doc links the sidecar with the standing note (and, for a plan input, the planning-pass note).
- The review pass is clean and every ambiguity was resolved with the user.

A reader who opens the sidecar should be able to say "if all these pass, the feature works" — without opening the implementation.

## Project Details

*Swap this section to retarget the skill at another project. Everything above is generic.*

This is **orch**, a TypeScript (Bun) orchestrator. Testing specifics:

- **Testing strategy docs** to feed the Phase 2 research subagent: [`docs/testing-strategy.md`](../../../docs/testing-strategy.md) (the scenario/driver DSL + decision rule for the two-pane host) and [CLAUDE.md](../../../CLAUDE.md) "How to write tests" (the three-layer unit / integration / e2e model for everything else).
- **Category map** to inform the feasibility appendix's driving/observation surfaces: `model` (controller decision / Ink projection — pure state→view, no tmux, the bulk), `screen` (left-pane bytes on real tmux — only for formatting/rendering behaviors), `full-host` (two-pane plumbing on real tmux, agent mode `fake`/`recorded`/`real`), `lifecycle` (signals / attached-TTY / teardown), `tmux-argv` (tmux argv contract). Outside the two-pane host: unit / mocked-integration / e2e. **Note the project's bias toward driving a real run** — drive a real workflow with a `FakeRunner` and assert the external outcome (a `full-host` scenario) rather than unit-poking a component — and carry it into the appendix: prefer a driving surface that launches a real run over one that constructs a synthetic lifecycle event and calls a host port directly. Reserve the `model` projection altitude for genuinely pure formatting.
- **Triage rule** to keep tests honest: *"Would this test still pass if the visible pane were empty / wrong / unformatted? If yes, demote or delete."* The Phase 5 **unwired-feature triage rule** is the direct acceptance-test analog: *"Would this test still pass if the feature were never wired into the real entry point?"* Apply both — if a test would pass with the behavior absent **or** with the integration unwired, it is not testing the behavior.
- **The two fakes** the research subagent should know about: `FakeRunner` (in-process, default) and `scriptedFake` (subprocess, for outside-the-process driving). A behavior that needs a fake agent is usually testable today; a behavior that needs the real Claude/Codex CLI lands at the gated `full-host:real-agent` driver and is env-gated.
- **Gate**: real tests must pass `bun run check` (lint + typecheck + unit + mocked-integration). Note this where an acceptance test will become a gated test.
- Input docs live under `docs/brainstorms/` (brainstorms + requirements) and `docs/plans/` (plans); write each sidecar next to its input.
