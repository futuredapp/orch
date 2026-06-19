---
date: 2026-06-19
topic: await-in-lifecycle-fifo-head-of-line-blocks
status: shipped
tags: [two-pane, concurrency, lifecycle-choreographer]
category: architecture
---

# An `await`ed I/O write inside the two-pane lifecycle FIFO head-of-line-blocks every later event

## Symptom

The always-on prompt-store write (`promptStore.write`, an `mkdir -p` +
`writeFile`) was added to the `step:start` branch of the two-pane
`LifecycleChoreographer` and `await`ed inline. On a slow or stalled filesystem,
a single `step:start` could stall the entire right-pane choreography — no later
lifecycle event for *any* step (downstream `registerSource`, `step:complete`,
parallel rollups) could begin until that one write resolved.

## Root cause

The choreographer serializes **all** lifecycle events through a single promise
chain — the `tail` FIFO (`tail = tail.then(() => process(event)…)` in
`src/hosts/two-pane/lifecycle-choreographer.ts`). Anything `await`ed inside
`process()` therefore sits at the head of the line and blocks every queued
event behind it, across all steps. The prompt-store write's only consumer is the
replay *fallback* branch, read long after the step completes — so it never needed
to finish before the live pane registered its source. Awaiting it coupled
unrelated downstream choreography to a filesystem write's latency.

## Fix / takeaway

Fire-and-forget the write so it leaves the FIFO:
`void deps.promptStore.write(event.stepName, prompt).catch(deps.onSendError)`.
The `tee.write` immediately above already hands the prompt to the live pane and
the replay-from-tee path, so nothing downstream depends on the store write having
flushed.

General rule: **inside a single-FIFO event choreographer, only `await` work that
a *later event in the same FIFO* genuinely depends on. Best-effort persistence
whose consumer reads after the step ends must be `void`-dispatched with a
`.catch(onSendError)`, never awaited** — otherwise its latency becomes every
other event's latency. Guard it with a test that a slow/never-resolving fake
store does not stall a subsequent `step:start`'s `registerSource`.
