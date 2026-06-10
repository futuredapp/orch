# `orch resume <failed>` can't show the failure if the workflow no longer loads

**Source:** Codex Finding 4 (MEDIUM). Verified against the code.
**Status:** Not a fix in this pass — design change beyond the U6 "load once" shape.

## What the issue is

`openFailed` loads the workflow **before** mounting the failed-run viewer. If the workflow file was renamed,
deleted, or its config is temporarily invalid, `orch resume <failed-id>` exits with the load error and the
user never sees the saved failure view — even though they only wanted to *look* at what failed.

## Where it is

- `src/cli/commands/open-failed.ts:81` — `const loaded = args.loaded ?? (await loadWorkflow(deps.cwd, workflowName))`,
  immediately followed by `if (isLoadError(loaded)) return loaded.code` (`:82`), before any viewer opens.
  The comment at `:79-82` states this is deliberate ("both `[r]` and `[c]` need the executor; a load error
  short-circuits before any viewer opens").

Contrast the completed path: `src/cli/commands/open-finished.ts` opens the read-only viewer purely from
persisted `state.json` and never loads the workflow — so a completed run is inspectable even with a
missing/broken workflow, while a failed run is not.

## Why it matters

The brainstorm's accepted behavior for a failed run is **"see the failure first, then choose"** (D3 / AT-2):
pure observation of an existing failed run should be possible from persisted state, the same way completed
read-only viewing is. Loading the workflow is required to **act** (`[r]`/`[c]` need the executor), but not to
**inspect or quit**. The current ordering couples the two, so a transient or unrelated workflow-load problem
blocks the observation path the feature exists to provide.

## Why it is recorded here, not fixed

The plan (U6) explicitly chose to load the workflow once up front so both actions share the executor. Fixing
this means splitting failed-viewing from failed-acting: open the failed viewer first from persisted state,
and lazily load the workflow only when the user presses `[r]`/`[c]`. That is a structural change to the
open loop (and its tests), not a localized patch — a scope decision for the feature owner rather than a
correctness fix to slot into this pass.

## Suggested next step

Split observation from action in `openFailed`:
- Mount the failed viewer using only persisted `state.json` (as `open-finished.ts` does).
- Lazily `loadWorkflow` on the first `[r]`/`[c]`; if it fails *then*, surface the error and either return to
  the failed view with quit still available or exit non-zero with a clear message.
- Regression test: a `failed` `state.json` exists but `loadWorkflow()` fails — `resume <failed>` should still
  render the failure view and quit cleanly (exit 0), mutating nothing.
