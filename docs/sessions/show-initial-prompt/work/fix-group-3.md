# Fix Group C — Don't head-of-line-block the lifecycle FIFO on the persistence write

Status: **done**

## What was wrong

The always-on prompt-store write in the `step:start` branch of
`src/hosts/two-pane/lifecycle-choreographer.ts` was `await`ed inside `process()`,
which is chained behind the single FIFO tail that serializes **all** lifecycle
events. `createPromptStore.write` does `mkdir(...,{recursive})` then `writeFile`.
Until both resolved, no later lifecycle work could begin — not this step's own
`registerSource`, not later steps' `step:start` / `step:complete`, not parallel
rollups. On a slow/stalled filesystem a single `step:start` stalled the entire
right-pane choreography. The write's only consumer is the replay *fallback*
branch (read long after the step completes), so nothing downstream needs it to
have flushed.

## What I changed

**Production (1 line + comment):**
`src/hosts/two-pane/lifecycle-choreographer.ts` — changed the awaited write to
fire-and-forget:

```ts
void deps.promptStore.write(event.stepName, prompt).catch(deps.onSendError)
```

The `tee.write` immediately above already handed the prompt to the live pane and
the replay-from-tee path; the `.catch(deps.onSendError)` keeps a rejected write
from surfacing as an unhandled rejection. Added a comment explaining why the
write must leave the FIFO.

**Tests:** `tests/unit/hosts/two-pane/lifecycle-choreographer.test.ts`
- Confirmed the existing `step:start` prompt-store tests assert the *call*
  (`rec.calls.find(c => c.on === 'promptStore')`), not write *completion* — the
  recording fake pushes the call synchronously (before its internal `await`), so
  `void` keeps them green. No change to the fake was needed.
- Added a focused regression test (under the *FIFO serialization* block): with a
  **never-resolving** prompt store, two autonomous `step:start` events both still
  reach `registerSource`. Added a `promptStore?` override to the `BuildOpts`
  helper to inject the stalled store.

## Verification

- `lifecycle-choreographer.test.ts`: 19 pass / 0 fail.
- **Falsifiability check:** temporarily reverting `void` → `await` makes the new
  test go red by assertion (`registered` is `[]` — the first event suspends on the
  stalled write and the FIFO never reaches either `registerSource`), then green
  again under the fix.
- `bun run lint` clean, `bun run typecheck` clean.
- Full unit suite (`bun run test:unit`): **1921 pass / 0 fail** on a quiet run.

## Issues hit along the way

- **Import ordering lint nit** — Biome's organize-imports wanted the new
  `PromptStore` type import after the local `lifecycle-choreographer` import.
  Fixed.
- **Load-induced test flakes (not regressions).** During bundled `bun run check`
  runs under heavy concurrent load (180 unit files), two *unrelated*
  timing-sensitive tests flaked intermittently:
  `tests/unit/hosts/tmux-host.test.ts` "drains every per-source session … (U4)"
  and `tests/unit/cli/types-command-watch.test.ts` "regenerates sidecars …". Each
  run failed a *different* file, both pass in isolation, and **U4 fails on the
  original `await` code too** under the same load — proving they are pre-existing
  load flakes, not caused by this change (this matches the documented
  "concurrent load poisons timing budgets" pattern). A subsequent quiet
  `test:unit` run was fully green (1921/0).

## Remaining groups

Group D (escaper/keying test-fidelity, tests-only) and Group E (AT-6 OSC 52
clipboard observability, real-tmux harness) are still `Status: not-started`.
