# Issue 3 — `tmux swap-pane failed (exit 1): can't find pane: %7`

**Status:** analysis only — NOT fixed. Reproducing test written and **confirmed
failing** (1/1 red on current code).

**Mode:** `--mode=two-pane`. **Surface:** `right-pane-controller` + per-source
tmux sessions + the tmux service.

---

## Symptom (as reported)

Triggering a replay/view of an earlier step produced an error banner in the left
pane:

> `! replay failed for check-1-1 — TmuxCommandError: tmux swap-pane failed (exit 1): can't find pane: %7 · Esc dismiss`

A `tmux swap-pane` referenced pane id `%7`, which tmux says no longer exists. The
user also flagged the "locks" as suspect: "I'm not sure why there are locks. I
want you to analyze these locks."

Run context (from the screenshots): a tic-tac-toe workflow of `move`/`check`
pairs; the right pane swaps between per-source panes; sources register when a
step goes live and tear down when it ends. The error fired on a replay of an
**earlier** step (`check-1-1`) after later steps had already run and torn down.

---

## What the "locks" are (and whether they cause the bug)

Two serialization mechanisms — neither an OS mutex; both promise chains/maps.

### (a) `pendingRegistrations` — the in-flight-registration map
`right-pane-controller.ts:273`
```ts
const pendingRegistrations = new Map<string, Promise<void>>()
```
- Keyed by `sourceKeyToString(key)` (e.g. `live:check-1-1`, `replay:check-1-1`).
- **Why it exists** (comment `:262-272`): lifecycle handlers fire
  `registerSource`/`unregisterSource` fire-and-forget (`void controller.X(...)`
  at `tmux-host.ts:746, :785`). Without the map, an `unregisterSource` queued
  behind a still-pending `registerSource` of the **same key** would read
  `panes.get(skey) === undefined`, bail, and leave the live→replay transform
  un-run. Drained at the head of `unregisterSource` (`:651-654`) and in
  `dispatchEnter` (`:861-864`).
- **Does NOT guard:** register/show against an `unregisterSource`/teardown of a
  *different* key, and does NOT re-validate that a pane id is still alive before a
  swap.

### (b) `swapChain` + `paneQueue` — swap serialization
- `swapChain` (`:241, :506-515`): controller-wide serial chain so the read of
  `visiblePaneId`, the `swap-pane`, and the write-back are atomic across
  concurrent `showSource` callers (comment `:230-240`).
- `paneQueue` (`pane-queue.ts`): per-`PaneId` serial chains so writes to a pane
  finish before a swap targeting it (`right-pane-controller.ts:486-487`).

**Verdict:** the locks are correct for what they target (register/register and
swap/swap ordering). They are **NOT the cause** — they **fail to prevent** this
bug because none establishes a happens-before between *teardown of a pane* and a
*later swap that references that pane id*, and none re-validates the pane id at
swap time.

---

## Root cause (ranked)

### 1. Stale cached pane id — the `dst` (`visiblePaneId`) is a torn-down pane (PRIMARY)

A pane id is captured once at session-create time and never re-validated until
teardown; `swapPane` is issued against the raw id with no liveness check:

- **Capture:** `createSourceSession` returns `result.paneId` from
  `tmux new-session -P -F '#{pane_id}'` (`source-session.ts:181-198`), stored
  verbatim into `panes` (`right-pane-controller.ts:419`).
- **Use:** `doShowSource` reads `const src = entry.paneId` (`:477`) and issues
  `opts.tmux.swapPane({ socket, src, dst })` (`:487`) with **no**
  `hasSession`/`listPanes`/`displayMessage` probe first. The comment at
  `:246-249` asserts the id is "the canonical reference for every subsequent
  swap" — true only while the session lives.
- **Invalidation:** a pane id leaves `panes` only via `killHiddenSource` (`:597`,
  after `teardownSourceSession` `:608`) or `teardownSessions` (`:702`). Nothing
  invalidates an id still referenced by a queued/pending swap or by
  `visiblePaneId`.

**Which side is `%7`: the `dst` (`visiblePaneId`).** `doShowSource`
(`:477-487`):
```ts
const src = entry.paneId         // fresh replay pane — ALIVE
const dst = visiblePaneId        // last pane swapped into the visible slot
...
await opts.paneQueue.enqueue(src, () => opts.tmux.swapPane({ socket, src, dst }))
```
`visiblePaneId` starts as `opts.rightPaneId` (`:229`) and is **reassigned to
`src` after every successful swap** (`:501`). So after any swap, `visiblePaneId`
holds the pane id of some source's `orch-src-*` session — NOT the durable `orch`
session. The failure sequence:

1. Earlier, source S (pane `%7`) was viewed; after the swap, `visiblePaneId = %7`,
   where `%7` physically lives in S's `orch-src-*` session.
2. S ends and is unregistered. If S is **not** `currentKey` at teardown,
   `killHiddenSource`'s relocation block (`:574-596`) is **skipped** — it only
   relocates when `currentKey === skey`. The session (and `%7`) is killed
   (`:608`), but `visiblePaneId` is **never re-pointed off `%7`**.
3. The user presses Enter on `check-1-1`. A fresh `replay:check-1-1` pane (`src`,
   alive) is swapped with `dst = visiblePaneId = %7` → tmux: `can't find pane: %7`.

The controller carefully relocates the visible slot to the placeholder **only**
when the killed pane is `currentKey` (`:575`, comment `:576-582` names exactly
this failure: "orphans visiblePaneId at a dead pane id — every subsequent
swapPane then fails with `can't find pane`"). But `visiblePaneId` can hold an id
whose source is no longer `currentKey`, so the guard never fires and the slot is
orphaned.

### 2. Replay of an already-torn-down step (CONTRIBUTING — explains *which* step)

`check-1-1` is a **command** step. Command steps do NOT register a live source —
`step:start` registers only for `event.mode === 'autonomous'` (`tmux-host.ts:733`).
So there is no warm-cached `replay:check-1-1` entry. On Enter, `dispatchEnter`
(`:811`): `liveExists`/`interactiveExists` false → `lookupStep` finds the
completed step (`:836`) → `replayKeyFor` → `{type:'replay', stepName:'check-1-1'}`
→ `panes.has(replaySkey)` false → `resolveReplaySpec` (command path: `file-tail`
over the pipe-pane log, `:969-977`) + `registerSource` creates a **brand-new**
`orch-src-replay-check-1-1` session (`:865-868`) → `showSource(replayKey)`
(`:869`) swaps that fresh `src` against the dead `dst`. So under this path `src`
is alive and `%7` is confirmed to be the `dst`.

### 3. Teardown-vs-swap race via the queue (POSSIBLE secondary, lower confidence)

`killHiddenSource`'s relocation guard fires only when the killed source is the
current visible key (`:575`). A swap to source X sitting in
`swapChain`/`paneQueue` while a *different* key's `unregisterSource` kills its
pane can fire after the kill — the queue keys on pane id, so a swap and a
teardown of different sources don't share a lane and aren't ordered. Narrower
than #1+#2.

### Ruled out / resolved
- **Pane-id reuse / off-by-one:** tmux pane ids are monotonic server-wide; a
  killed `%7` is not reused while the server lives. "can't find pane" means
  genuinely gone, not reassigned.
- **`src` being dead:** the live→replay transform keeps the pane alive (comment
  `:538-542`), so for the command-replay path `src` is fresh; `%7` is the `dst`.

---

## Reproduction conditions (concrete)

Minimal trigger: the visible slot holds a per-source pane whose session is later
killed **without** the relocation guard firing, then a swap is issued. With the
move/check pairs:

1. Run several steps; each live auto-swap makes `visiblePaneId` that source's
   pane id (`:438` → `:501`).
2. A source whose pane currently sits in `visiblePaneId` is killed on unregister
   while `currentKey` has already moved to another source — `rollup`
   (`step:parallel-complete`, `tmux-host.ts:864-865`) and `interactive` sources
   are killed on unregister (`killHiddenSource`), and the relocation guard is
   skipped because the killed source is not `currentKey`. `visiblePaneId` is now a
   dead id.
3. User presses Enter to replay an earlier completed **command** step
   (`check-1-1`); a fresh pane is created and swapped against the dead
   `visiblePaneId` → `can't find pane: %7`.

**Smoking gun in logs** (`.orch/state/<runId>/logs/`): a `pane-killed`/teardown
record with `paneId: %7` followed by a later `right-pane-swap-start` with
`dstPaneId: %7`.

---

## Reproducing test (CONFIRMED FAILING — 1/1 red)

**File:** `tests/unit/hosts/two-pane/pane-map/right-pane-controller-replay-dead-pane.test.ts`
(unit / mocked edge — drives the real `createRightPaneController` with
`FakeTmuxService`; no real tmux, fully deterministic).

**Run:**
```
bun test tests/unit/hosts/two-pane/pane-map/right-pane-controller-replay-dead-pane.test.ts
```

**Verified result on current code:** `0 pass / 1 fail` —
`expect(owned.has(String(swap.opts.src))).toBe(true)` receives `false` (the swap
targets the dead pane).

The test drives the live→replay warm-cache variant of the bug:
1. `registerSource(live:check-1-1)` creates pane `%5` in
   `orch-src-live-check-1-1` and auto-swaps it visible.
2. `unregisterSource(live)` runs `transformLiveToReplay` (`:522-543`): rekeys the
   entry `live:` → `replay:` and keeps `%5` (warm cache). `panes` now holds
   `replay:check-1-1` → `%5`.
3. The per-source session is torn down out-of-band (`tmux.killSession`), so `%5`
   no longer exists.
4. `onIntent({type:'enter', stepName:'check-1-1'})` → `dispatchEnter` finds the
   warm-cached `replay:` entry, **skips re-registration** (`if (!panes.has(...))`
   at `:865` is false), and `showSource` swaps the dead `%5` in.

**Assertion (not weakened to "doesn't crash"):** after replay, every `swapPane`
the controller issues must have a `src` still owned by a live session. The fake's
own per-session ownership table (`#panesBySession`, exposed read-only via
`paneIdsForSession`, cleared by `killSession`) provides ground truth. Today the
controller swaps to `%5`, owned by no live session → fails.

### Important seam finding: `FakeTmuxService.swapPane` does not validate panes

`FakeTmuxService.swapPane` (`fake-tmux-service.ts:233-236`) only fails on socket
loss — it does NOT consult `#panesBySession`, so a swap to a dead pane is
silently accepted. That is exactly why a naive integration test (assert "no
throw") would miss this bug. The reproducing test sidesteps this by asserting the
*ownership invariant* (no swap to a pane whose session was killed) via the
existing public `paneIdsForSession` API — **no fake modification required**. A
real tmux (Tier 1) test would surface the same bug as a literal `TmuxCommandError`,
but the unit layer reproduces it deterministically, so no Tier 1 test is needed.

### Observable signals
- No `swapPane` is ever called with a `src` or `dst` whose owning session was
  previously killed.
- Replaying a completed step must not throw `can't find pane` / emit a
  `right-pane-swap-failed` lifecycle record (`:489`) or an error banner matching
  `can't find pane`.

---

## Fix direction (described, NOT implemented)

The primary path (#1+#2) is **not a race** — `visiblePaneId` is already durably
dead before the replay starts, so "serialize teardown before swap" alone is
insufficient. The cleanest fix re-anchors/invalidates so `visiblePaneId` (and any
cached id) can never reference a killed pane:

- **Most surgical:** extend the `killHiddenSource` relocation guard
  (`right-pane-controller.ts:574-596`) to also trigger when
  `entry.paneId === visiblePaneId` (the visible slot is about to lose its pane),
  not only when `currentKey === skey`. Closes the `currentKey`/`visiblePaneId`
  desync.
- **Defensive complement:** re-validate (or re-anchor to `opts.rightPaneId` /
  re-establish the placeholder) the `dst` before issuing `swapPane`, e.g. a
  `displayMessage`/`listPanes` liveness probe.
- For the warm-cache variant exercised by the test: invalidate a cached `replay:`
  entry whose backing session/pane is gone so `dispatchEnter` re-registers a fresh
  source before swapping.

---

## Uncertainties

- Confirmed `check-1-1` resolves down the **command** replay path (no warm live
  cache), forcing a fresh `src` and pinning `%7` to the `dst`. The actual run's
  lifecycle log was not inspected; if `check`/`move` were autonomous (registering
  live sources), `src` could instead be a warm-cached replay pane whose session
  was reaped — less likely given the "session stays alive" transform comment
  (`:538-542`).
- The exact interleaving that left a *killed* source's pane in `visiblePaneId`
  while `currentKey` moved elsewhere depends on the specific
  `showSource`/`unregisterSource`/relocation sequence in that run. The lifecycle
  log (`right-pane-swap` / `pane-killed` / `visible-pane-relocation-*` records)
  would pin the precise step that orphaned `%7`.
- Whether a `rollup` or `interactive` kill (vs the no-kill live→replay transform)
  is the specific killer of `%7` can't be determined without the log; both are
  kill paths that skip relocation when not `currentKey`.
