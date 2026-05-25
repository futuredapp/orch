# Issue 2 — Left-pane selection is not in sync with the right pane

**Status:** analysis only — NOT fixed. Reproducing test written and **confirmed
failing** (4/4 red on current code).

**Mode:** `--mode=two-pane`. **Surfaces:** Ink left pane (`<StepsView>`) ↔ tmux
right pane (driven by `right-pane-controller`).

---

## Symptom (as reported)

The LEFT pane shows the list of steps with one highlighted row; the RIGHT pane
shows the transcript of ONE step. The user states a **HARD RULE**:

> "If we have a selected left-panel item, it should always be the thing we see in
> the right panel."

Observed violations:

1. **Startup.** With a single step, NO row is highlighted in the left pane even
   though the right pane is already showing that step.
2. **Auto-advance.** After the user manually selects a step (say step 3), live
   progresses and the right pane auto-advances to step 4 — but the left
   highlight stays frozen on step 3. The left highlight does not follow the
   right pane.
3. **General divergence.** The highlighted left item and the right-pane content
   must stay equal in BOTH directions (user-driven and auto-advance).

---

## Root cause: two independent sources of truth, never reconciled

There are two separate state machines that each decide "which step is current,"
and nothing binds them:

1. **Left-pane highlight** — local React state inside the Ink child:
   - `selectedName` + `isUserDriven` in `useStepsSelection`
     (`src/hosts/two-pane/steps-view/steps-view-hooks.ts:50-51`).
   - This is the ONLY input to the highlight render
     (`steps-view.tsx:256`).

2. **Right-pane view** — controller state in the parent process:
   - `currentView` / `currentKey` / `visiblePaneId` in
     `right-pane-controller.ts:283, 243, 229`.
   - Projected into `StepsViewState.view` and shipped back to the child via
     `tui-overlay.ndjson` (`right-pane-controller.ts:291-305` →
     `steps-view-model.ts:111-120` → `project-steps-view.ts:65`).

`state.view` (the right pane's truth) arrives in the child and is rendered ONLY
by the footer (`ViewModeFooter`, `steps-view.tsx:263`). It is **never read by
`useStepsSelection`** and **never compared against `selectedName`**. The
invariant "highlighted left item === what the right pane shows" is enforced by no
code.

### Symptom 1 — startup: nothing highlighted

`steps-view.tsx:256`:
```tsx
selected={step.name === selectedName && isUserDriven}
```
At startup `useStepsSelection` initializes `isUserDriven = false`
(`steps-view-hooks.ts:51`). The effect at `steps-view-hooks.ts:53-65` *does* set
`selectedName` to the live/last step:
```ts
setSelectedName(findLive(steps) ?? steps[steps.length - 1]?.name)   // L64
```
But the render gate `&& isUserDriven` is `false`, so the cursor (`▌`), bold, and
cyan accent are all suppressed (`steps-view.tsx:315, 325-330`). Meanwhile the
controller's auto-swap path already put that step in the right pane
(`registerSource` sees `currentView.mode === 'live'` → `showSource(key)`,
`right-pane-controller.ts:436-439`). **Divergence at frame zero.**

### Symptom 2 — frozen highlight on auto-advance

Once the user presses ↑/↓, `move()` sets `isUserDriven = true`
(`steps-view-hooks.ts:75`). From then on the follow-live effect short-circuits:
```ts
useEffect(() => {
  if (isUserDriven && selectedName !== undefined) {
    const stillThere = steps.some((s) => s.name === selectedName)
    if (!stillThere) { setSelectedName(findLive(steps)); setIsUserDriven(false) }
    return                          // ← L62: bails; selectedName is FROZEN
  }
  setSelectedName(findLive(steps) ?? steps[steps.length - 1]?.name)
}, [steps, isUserDriven, selectedName])
```
The highlight only moves again if the selected step *disappears*
(`!stillThere`, L57-58) — which never happens for a completed step.

The right pane keeps auto-advancing **independently**: when step 4 starts,
`registerSource(live:step4)` runs and, gated only on `currentView.mode === 'live'`
(`right-pane-controller.ts:436-446`), swaps to step 4. The controller has no
knowledge of the child's `isUserDriven`.

**Key asymmetry:** pressing ↑/↓ emits NO intent — `move()` only mutates local
React state (`steps-view-hooks.ts:67-76`). Intents are emitted only by `Enter`,
`f`, `quit`, `dismiss-banner` (`steps-view.tsx:180-205`). So the controller never
learns the user "selected" step 3 and stays in live-follow mode, happily swapping
to step 4. Pressing **Enter**, by contrast, *does* sync them (`enter` intent →
`dispatchEnter` → `setViewMode({mode:'replay'})` at
`right-pane-controller.ts:870`, which flips off `live` and stops auto-advance).

### Symptom 3 — general divergence (both directions)

- **Right → Left:** every controller change to `currentView` (auto-swap `:438`,
  `followLive` `:743-777`, live→replay on completion `unregisterSource` →
  `setViewMode` `:676`) writes a new `tui-overlay` line; the child re-projects and
  `state.view` updates, the footer updates — **but `selectedName` is untouched.**
- **Left → Right:** `move()` changes `selectedName` but emits no intent, so the
  controller never hears it. Only `Enter` propagates left→right.

`state.view` is, today, used only by the footer text
(`renderViewModeFooter`, `steps-view.tsx:427-436`). The selection logic does not
import, receive, or reference `state.view` at all.

---

## Violated invariant (state crisply)

> At every render, the highlighted left row's step name must equal the step the
> right pane is displaying:
> `selectedName === (state.view.mode === 'replay' ? state.view.stepName : <live step name>)`,
> and that row must visibly render as selected (cursor + bold + accent).

Today this holds only transiently right after `Enter`/`f` and breaks on
(a) startup, (b) ↑/↓ movement, and (c) any controller-side auto-advance.

---

## Reproducing test (CONFIRMED FAILING — 4/4 red)

**File:** `tests/unit/hosts/two-pane/steps-view/selection-tracks-view.test.tsx`
(Tier 2, Ink projection via `ink-testing-library`).

**Run:**
```
bun test tests/unit/hosts/two-pane/steps-view/selection-tracks-view.test.tsx
```

**Verified result on current code:** `0 pass / 4 fail` — each fails with
`Received: undefined` / cursor-line length `0` (no `▌` cursor renders).

The test parses each rendered frame for the `▌` cursor glyph that `<StepRow>`
prepends to the selected row (`const cursor = selected ? '▌' : ' '`) — the only
selection signal that survives `stripAnsi` — and compares the highlighted row to
`state.view`. Cases:

- **A — startup highlight (single step):** `view = {mode:'replay', stepName:'work'}`,
  one running step `work`; asserts `work` is highlighted. Fails: `&& isUserDriven`
  gate suppresses the cursor.
- **B — startup highlight (multiple steps):** same, with `plan` + `work`; asserts
  `work` highlighted. Fails for the same reason.
- **C — auto-advance reconciliation:** render with `view` → `plan` (highlighted),
  then `rerender` with `view` → `work` WITHOUT a keypress; asserts the highlight
  moved to `work`. Fails: `useStepsSelection` never consumes `state.view`.
- **D — exactly one highlighted row, equal to view:** guards against a fix that
  double-highlights or leaves it empty.

The assertions detect the SPECIFIC highlighted row (cursor glyph on a given step
name), satisfying the triage rule — they fail on a blank/wrong highlight.

### API gap the fixer must close

`<StepsView>` currently has **no path** by which `state.view` drives the left
highlight: `useStepsSelection` takes only `state.steps`, and the render gate
hard-requires `isUserDriven`. The desired behavior cannot even be expressed
through today's wiring, so the test is written against the **expected post-fix
contract**. To pass, the fixer must couple selection to `state.view` (e.g. pass
`state.view` into `useStepsSelection` / add a reconciliation effect) AND drop the
unconditional `&& isUserDriven` gate so the row matching the right pane is always
highlighted — while still letting an explicit user `↑/↓` selection take
precedence until `f`/snap-to-live hands control back to `view`.

---

## Fix direction (described, NOT implemented)

### Option A — derive the highlight from `state.view` (right pane authoritative)
Make the highlighted row a pure function of `state.view`: `replay → stepName`,
`live → findLive(steps)`. Local ↑/↓ would emit an intent so the controller
updates `currentView`, which round-trips back as `state.view`.
- **Pros:** single source of truth; the invariant becomes *structural*; kills all
  three symptoms; removes the `&& isUserDriven` hack.
- **Cons:** ↑/↓ now incurs an IPC round-trip + a pane swap per arrow key (today
  ↓ is instant/local); likely needs a debounce or a hover-vs-commit distinction;
  changes UX (today you can move the cursor without disturbing the right pane).

### Option B — push selection into the controller (keep local cursor)
Emit a lightweight `select` intent on ↑/↓ so the controller leaves `live` mode
(stops auto-advance), and have the controller reflect any auto-advance back so the
highlight follows. Plus drop `&& isUserDriven`.
- **Pros:** preserves the snappy local cursor; smaller hot-path change.
- **Cons:** still two stores kept in sync by discipline (the exact bug class that
  caused this); many `setViewMode` sites (`:676, :827, :870`) to keep coherent;
  must explicitly resolve who wins when the user has a selection and a new live
  step starts.

**Lean (for the implementer):** Option A makes the invariant structural rather
than discipline-maintained, which matches the codebase's single-source-of-truth
emphasis. The startup gate (`&& isUserDriven`, `steps-view.tsx:256`) should be
dropped regardless of option.

---

## Uncertainties / product decisions needed

1. **Hover vs commit.** Should ↑/↓ only move a cursor (right pane unchanged until
   Enter), or immediately switch the right pane? Today it's half-hover (↓ moves
   the cursor, no swap). The rule "selected === shown" only makes sense if every
   cursor move also swaps — OR if "selected" means "committed (post-Enter)."
   This must be decided before choosing A vs B.
2. **Precedence on auto-advance.** When the user has selected step 3 and step 4
   goes live, should the pair stay on 3 or jump to 4? Today the controller
   silently wins (swaps to 4), the highlight loses (frozen on 3). The fix must
   define the winner.
3. **IPC latency on ↑/↓** if Option A swaps on every arrow key; the serialized
   `swapChain` (`right-pane-controller.ts:506-515`) means rapid presses queue and
   could lag the cursor.
4. The host wiring in `tmux-host.ts` that fires `registerSource`/`unregisterSource`
   on lifecycle events (the auto-advance trigger) was not deeply inspected; the
   exact `step:start` ordering relative to the user's keypress could affect a fix
   that makes the controller respect a pending user selection.
