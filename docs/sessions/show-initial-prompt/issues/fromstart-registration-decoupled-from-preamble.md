# `fromStart` source registration is decoupled from the "has a prompt" decision

**Source:** CE review L-5 (low / P3, maintainability).

**Status:** Not selected for fixing — only reachable in fixtures (empty prompt is
out of scope per the acceptance contract). Recorded as a fragility note.

## What it is

In the `step:start` branch of the choreographer
(`src/hosts/two-pane/lifecycle-choreographer.ts:123-143`), two decisions that
should track each other are split:

- The **preamble write** is conditional on a non-empty prompt: when
  `event.prompt` is empty/undefined it writes the bare `[<step>] starting…`
  marker instead of a `prompt:` preamble (`:123-127`).
- The **live source registration** is **unconditionally** `fromStart: true`
  (`:143`).

For the empty-prompt path the source is still registered `fromStart` and later
top-pinned (`pinSourceToPromptTop` gates only on `fromStart === true`), so the
pane would open pinned to a one-line `starting…` marker. The "has a prompt" and
"should pin to top" decisions live in two files and stay correlated only by luck.

## Where

- `src/hosts/two-pane/lifecycle-choreographer.ts:123-143` (preamble write vs
  source registration).
- `src/hosts/two-pane/pane-map/right-pane-controller.ts:472` (the `fromStart` pin
  gate that consumes it).

## Why it matters (low)

The empty/whitespace-prompt state is **not reachable in a real run** — a
non-interactive step is always launched with an assembled prompt, and the
acceptance contract explicitly puts the empty-prompt case out of scope
(`acceptance-tests.md` — "Deliberately out of scope — empty/whitespace prompt").
So today this is fixture-only and harmless. It is flagged because the implicit
linkage becomes a real bug surface if the bare-marker path ever ships to real
runs: a pane pinned to a one-line marker with `fromStart` set.

## Suggested next step

Gate the source registration's `fromStart` on the same `prompt !== undefined`
condition the preamble write uses, so "from-start + pin" tracks "preamble present"
as one decision in one place. Cheap and purely defensive; safe to defer until the
marker path is otherwise touched.
