---
date: 2026-06-02
topic: default-workflows
---

# Default (Built-In) Workflows

## Summary

Ship workflows *inside* orch that run via an `orch run orch::<name>` namespace — no `.orch/` registration, no authoring required. The first two are phased-build variants, `orch::work-codex` and `orch::work-cc`, that share one parameterized pipeline differing only by runner: an always-run interactive+autoStop step decides a 1–4 phase breakdown, then a loop implements each phase as an interactive+autoStop step.

---

## Problem Frame

Today the only way to run a workflow is to author it: scaffold `.orch/`, write a TypeScript workflow file, and register it in `config.workflows`. That is the right amount of ceremony for a bespoke pipeline a team maintains, but it is a wall for someone who just wants to point orch at a plan and watch it build the thing in phases. The capability already exists in pieces — `examples/feature/index.ts` already does decide-then-dispatch via subworkflows, `autoStop` already closes finished interactive panes, file-based prompts already exist — but a newcomer has to discover, copy, wire, and register all of it before the first run. The friction is distribution and invocation, not capability: there is no way to ship a ready-to-run pipeline with orch and call it without first reconstructing it in the user's project.

---

## Actors

- A1. **Workflow runner (human)**: invokes `orch run orch::<name> <plan-or-prompt>` and chooses between the Codex and Claude variants.
- A2. **The name resolver**: detects the `orch::` prefix and resolves the name to a packaged built-in workflow instead of the user's `config.workflows` map.
- A3. **The phased pipeline**: the shared workflow that decides phases and loops over them; parameterized by runner.
- A4. **The runner adapter** (`CodexRunner` / `ClaudeRunner`): drives each interactive+autoStop step for the chosen variant.
- A5. **The decide-phases step**: an agent step that produces the phase breakdown and emits it as a parseable artifact.

---

## Key Flows

- F1. **Run a built-in phased workflow**
  - **Trigger:** `orch run orch::work-cc <plan-or-prompt>` (or `orch::work-codex`).
  - **Actors:** A1, A2, A3, A4, A5.
  - **Steps:** (1) Resolver sees `orch::` and loads the packaged `work-cc` workflow, skipping the user's workflow map. (2) Pipeline normalizes the input — a path to an existing file is loaded as the plan, otherwise the argument is treated as an inline description. (3) The decide-phases step runs interactively with autoStop and emits a phase breakdown. (4) A cheap step reads the breakdown back into a usable list. (5) For each phase, an interactive+autoStop work step implements it. (6) Run completes; per-step state is persisted and resumable as usual.
  - **Outcome:** the plan is implemented phase by phase with no per-phase human keystrokes on the happy path, and no workflow authoring was required.
  - **Covered by:** R1, R2, R3, R5, R6, R7, R8, R9, R10.

- F2. **Choose the runner variant**
  - **Trigger:** the user decides whether to drive with Codex or Claude Code.
  - **Actors:** A1, A4.
  - **Steps:** the user picks `orch::work-codex` or `orch::work-cc`; both resolve to the same pipeline shape with a different bound runner.
  - **Outcome:** identical behavior and phase logic, different underlying agent.
  - **Covered by:** R4, R5.

---

## Requirements

**Built-in distribution and invocation**
- R1. orch ships a small fixed set of built-in workflows packaged inside orch itself — the two variants in R4 for this iteration; they require no `.orch/orch.config.ts` `workflows` entry to run. The loading mechanism may support additional built-ins internally, but this iteration does not introduce a registry or open-ended built-in catalog (see Scope Boundaries).
- R2. The `orch run` name resolver recognizes an `orch::` prefix and resolves the remainder to a packaged built-in, bypassing the user's `config.workflows` map. Names without the prefix resolve as today (user config map).
- R3. Built-ins are read-only and run in place — orch does not copy them into the user's `.orch/`, and there is no eject/customize path in this iteration.

**The phased-build pipeline**
- R4. Two built-in variants ship first: `orch::work-codex` (driven by Codex) and `orch::work-cc` (driven by Claude Code). They share one parameterized pipeline and differ only in the runner bound to the steps.
- R5. Every agent step in the pipeline runs as an interactive session with `autoStop` enabled, for both variants.
- R6. A decide-phases step **always** runs and produces the phase breakdown. It does not parse or honor any pre-written phases in the input — the decision is always freshly made.
- R7. The phase count targets 1–4 phases, chosen from a complexity heuristic ("how many changes, how many unrelated concerns"). More than 4 phases is reserved for genuinely exceptional complexity, not the normal case. The pipeline biases toward fewer phases.
- R8. The decide-phases step emits its breakdown as an artifact the pipeline can read back into an ordered phase list to drive the loop (the breakdown is not produced as a headless typed JSON return). The emit format must be parseable by deterministic code without an LLM, and the read-back step must validate that it parsed a non-empty, well-formed phase list — halting the run with a clear error on a parse failure rather than silently proceeding with zero or one phase.
- R9. The per-phase loop is implement-only: each phase runs exactly one interactive+autoStop work step. No commit, validation, or other step is performed by the built-in per phase. This excludes project-specific validation (typecheck/tests), not failure handling: if a per-phase work step exits with a non-zero status, the pipeline halts and surfaces the failure before starting the next phase rather than compounding failures across phases.

**Input handling**
- R10. The pipeline accepts either a plan file or an inline prompt/description as its input. When the input refers to an existing file, it is loaded as the plan; otherwise it is treated as an inline description.

---

## Acceptance Examples

- AE1. **Covers R2.** Given a name passed to `orch run`, when it begins with `orch::`, then the workflow is loaded from the packaged built-ins and the user's `config.workflows` map is not consulted; when it does not, then resolution is unchanged from today.
- AE2. **Covers R4, R5.** Given `orch run orch::work-cc <plan>` and `orch run orch::work-codex <plan>`, when each runs, then the phase logic and step sequence are identical and only the driving runner differs, with every agent step interactive and auto-stopping.
- AE3. **Covers R6.** Given an input plan that already contains a written phase breakdown, when the pipeline runs, then the decide-phases step still runs and produces its own breakdown rather than reusing the pre-written one.
- AE4. **Covers R7.** Given a small, single-concern change, when decide-phases runs, then it returns a single phase (not padded to more); given a large multi-concern change, it returns more phases, capped near 4 except in exceptional cases.
- AE5. **Covers R10.** Given the input argument is a path to an existing file, when the pipeline starts, then the file is loaded as the plan; given it is not a path, then the argument is used as an inline description.

---

## Success Criteria

- A new user can run `orch run orch::work-cc <plan>` (or `work-codex`) against a real plan without authoring or registering any workflow, and the plan gets implemented phase by phase.
- On the happy path the run completes with no per-phase human keystrokes, each interactive step closing itself via autoStop.
- The two variants stay genuinely single-source: a change to the phase logic lands in one place and both variants inherit it.
- Decide-phases reliably stays within 1–4 phases for ordinary work and only exceeds it for clearly exceptional complexity.
- A downstream implementer can build this from the requirements without re-deriving the resolver mechanism or the phase-emit/parse contract.

---

## Scope Boundaries

- `orch add` / `orch eject` / seeding built-ins into the user's `.orch/` for editing — excluded; built-ins are read-only run-in-place.
- Per-phase commits and per-phase validation (typecheck/tests) inside the built-in — excluded; the user owns commits and verification.
- A single-pipeline Claude+Codex cross-check variant (both agents per phase) — excluded; the two runners ship as separate variants the user chooses between.
- Parsing or honoring pre-written phases from the input plan — excluded; decide-phases always decides fresh.
- A registry/marketplace for third-party built-ins, version negotiation, or rich `orch::` discovery/listing UX beyond what is needed to run the shipped variants — excluded for this iteration.

---

## Key Decisions

- **Namespace, run-in-place over seed/eject.** `orch::<name>` resolves to packaged read-only workflows. Chosen over copying into `.orch/` because the goal is zero-ceremony invocation; editability is a later concern and adds copy/registration surface now.
- **Two variants, one pipeline.** "Both" means two runner-bound built-ins (`work-codex`, `work-cc`) the user selects between — not Claude+Codex in one run. Keeps each run single-runner and the phase logic single-source.
- **Always decide phases.** One code path; the built-in never has to detect, trust, or reconcile pre-written phase structure in arbitrary input plans.
- **Interactive + autoStop everywhere, including the decision.** Keeps the watchable-pane experience consistent and rules out the headless structured-output route for the decision — so the breakdown is emitted as a readable artifact and parsed back, rather than returned as typed JSON.
- **Implement-only per phase.** Leanest runnable example; no project-specific assumptions (test/verify commands) baked into a built-in that cannot know the host project.

---

## Dependencies / Assumptions

- Relies on shipped features: `autoStop` for interactive steps, subworkflow/`runWorkflow` composition, and file-based prompts for the plan-file input path.
- `examples/feature/index.ts` is reference precedent for the decide-then-dispatch shape, not a runtime dependency.
- Assumes a built-in run still expects `.orch/` to exist for run state and mode resolution; running with no `.orch/` at all is not a goal of this iteration.
- The env-merge helper lives at `src/services/process/merge-env.ts` (CLAUDE.md's `src/runners/_shared/` reference is stale) — relevant if the resolver or built-ins touch env wiring.

---

## Outstanding Questions

### Resolve Before Planning

- *(none — scope is settled.)*

### Deferred to Planning

- [Affects R1, R2][Technical] Where packaged built-ins physically live (e.g. `src/workflows/`) and how the resolver imports them in both dev (source) and any packaged/installed form.
- [Affects R8][Technical] The exact emit/parse contract between the interactive decide-phases step and the loop — what file the agent writes, in what format, and how the cheap read-back step (likely `run.custom`) parses it reliably. Smoke-test the agent's adherence to the format.
- [Affects R7][Needs research] How to express the 1–4 ceiling and complexity heuristic in the decide-phases prompt so it holds in practice (resists over-splitting), and whether a guardrail beyond the prompt is warranted.
- [Affects R3, R1][Technical] Whether a built-in run requires `.orch/` to exist and, if so, the failure message when it does not — confirm against `loadConfig`/state-path wiring.
- [Affects R10][Technical] The precise rule for "refers to an existing file" vs inline description, reusing the file-based-prompts detection rather than inventing a new one.

### From 2026-06-02 review

- [Affects R4][Scope] Ship one variant (`work-cc`) first vs. both variants simultaneously. Shipping both doubles the resolver/acceptance/runner-binding surface before the parameterized pipeline is proven, and the primary Success Criterion only names `work-cc`. Decide whether `work-codex` ships in this iteration or follows once the resolver and emit/parse contract are validated. *(scope-guardian)*
- [Affects R5][Design] `autoStop` on the decide-phases step removes the only human checkpoint before all phases run unattended — a bad phase cut is never catchable. Decide whether decide-phases is the one intentional non-autoStop step, or whether a cheap preview/confirm gate sits between the decision and the loop. *(adversarial)*
- [Affects R6, AE3][Premise] Always-decide-fresh discards the deliberate phase breakdown in a user's input plan (the most likely input, since plans here are phased by convention), justified only by code-path simplicity. Decide whether the input's existing structure is fed to the decision step as followable context, and reconcile the justification with user value. *(product-lens, adversarial)*
- [Affects Problem Frame, Dependencies, Success Criteria][Coherence] The "newcomer points orch at a plan with zero setup" goal contradicts the assumption that `.orch/` must already exist. A true newcomer's first run fails until `orch init`. Decide the direction: target a user who has already run `orch init` (removes authoring ceremony, not bootstrap), or scope in a graceful no-`.orch/` path. *(product-lens)*
- [Affects R7, AE4][Correctness] The 1–4 phase cap is enforced only by prompt wording, yet AE4 and the Success Criteria assert it as a testable guarantee. Decide whether the cap is hard (read-back step enforces the ceiling) or soft (reword AE4/Success Criteria so they don't assert an unenforceable invariant). *(adversarial)*
