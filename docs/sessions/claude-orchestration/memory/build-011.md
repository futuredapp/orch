# build-011: serialize state-store writers through the write-queue

- Drift check `git diff --stat 0265592..HEAD -- src/state/state-store.ts` was clean (no diff); live code matched the plan's "Current state" excerpts, so no STOP.
- Extracted the queue mechanics from `saveStep` into a private `#enqueueWrite<T>(rid, op)` helper in `src/state/state-store.ts` and rewrote `saveStep` to `return this.#enqueueWrite(rid, () => this.#doSaveStep(rid, entry))`.
- Routed `initRun`, `setArgs`, and `setStatus` through `#enqueueWrite` by wrapping each existing body (the `loadRun` + `#atomicWrite` and the "does not exist" throws) in the serialized `op` closure; all existing throws and early-returns preserved.
- Used `.then(() => {}, () => {})` (not `.catch`) for the swallowed chain ref so it stays typed `Promise<void>` under the generic `<T>` and the `Map<string, Promise<void>>` queue; error propagation is unchanged (caller still awaits the un-swallowed `next`).
- Added a one-line rule comment on the helper: any new method that mutates a run's state.json MUST route through `#enqueueWrite`.
- Added test `does not drop a concurrent saveStep when setStatus runs at the same time` in `tests/unit/state/state-store.test.ts`: initRun, then `Promise.all([saveStep, setStatus])`, then assert final `loadRun` has both the step value and status `completed`.
- Verified: `bun test tests/unit/state/state-store.test.ts` -> 22 pass, 0 fail (needed `bun install` first; node_modules was absent). `bun run typecheck` -> exit 0. `grep -n "#enqueueWrite" src/state/state-store.ts` -> 1 definition + 4 call sites.
- Did NOT run `bun run check` (operator runs the full gate) and did NOT touch `plans/README.md` or any caller in `src/core/workflow.ts`, per task instructions.
- No STOP condition hit: the `initRun`/resume note (`state-store.ts` comment) held - all existing state-store tests still pass, so serializing `initRun` did not break resume behavior in this file's scope.
- Left unverified: cross-module resume tests outside `src/state/` (out of scope, path-scoped run only); the FakeFsService may be synchronous enough that the race never manifests, so the new test primarily documents/guards the invariant per the plan's Step 3 note.
