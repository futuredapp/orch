---
date: 2026-06-19
topic: hoisted-prompt-assembly-drops-step-lifecycle
status: shipped
tags: [lifecycle, two-pane, error-handling]
category: bug
---

# Hoisting a throwing computation ahead of `withStepLifecycle` silently drops a step's `step:start`/`step:failed` events

## Symptom

After hoisting `assemblePrompt` ahead of `withStepLifecycle` (so the assembled
prompt could ride on `step:start` for the new right-pane preamble), a step whose
prompt had a `{{var}}`/template mismatch lost all of its per-step lifecycle
attribution: the steps-view row, the failure pane, and the cmux pill never
updated for that step. The run was still classified `crashed` (the
workflow-level catch fired), and **no existing test caught the regression** —
the error still propagated, just without per-step events.

## Root cause

`assemblePrompt` → `substitute()` throws on any template/var mismatch (missing
var, extra var, malformed placeholder) — a real, user-reachable input error.
Before the feature, that throw happened *inside* the `produce*Step` body, which
runs *inside* `withStepLifecycle`, so the host saw `step:start` then
`step:failed`. Hoisting the assembly out (to carry the prompt on the event)
moved the throw *before* `withStepLifecycle` ran, so neither `step:start` nor
`step:failed` fired. Per-step diagnosability was lost while every test stayed
green, because tests asserted on the run-level outcome (`crashed`), not on the
per-step lifecycle events.

## Fix / takeaway

Anything you hoist ahead of `withStepLifecycle` that can throw must be routed
back through the lifecycle envelope. In `src/core/workflow.ts`, the hoisted
`assemblePrompt` call is wrapped in `try/catch`; on catch it enters
`failedAssemblyLifecycle`, which opens `withStepLifecycle` (with **no** `prompt`
on the ctx) and a body that re-throws the captured error — so `step:start` →
`step:failed` still fire and the step keeps its attribution, exactly as when the
throw lived inside the produce body. Both the autonomous (`runAgentStep`) and
interactive (`runInteractiveStep`) paths needed it; the hoist exists on both.

General rule: **the lifecycle envelope is the only thing that emits per-step
events. Code that runs before it is invisible to the steps-view/failure
panes/cmux — if it can fail, wrap it so the failure still flows through a
lifecycle span.** Guard it with a unit test that asserts *both* `step:start` and
`step:failed` are emitted on an assembly-time throw — a run-level `crashed`
assertion will not catch this class of regression.
