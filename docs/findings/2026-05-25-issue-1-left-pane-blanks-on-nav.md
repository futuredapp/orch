# Issue 1 — Left pane (`<StepsView>`) blanks on a navigation keypress

**Status:** analysis only — NOT fixed. Reproducing test is documented below but is
**not yet deterministic at the unit/projection layer** (see "Reproducing test").

**Mode:** `--mode=two-pane`. **Surface:** the Ink-rendered left pane.

---

## Symptom (as reported)

> "The left panel suddenly disappears when I interact with it — when I press
> arrow-down or the arrow at the top. It just blanks, like it wasn't drawn for
> some reason, then suddenly something changed and it was drawn again."

So: a navigation keypress (arrow ↑/↓, and likely the scroll keys `j`/`k`/`PgUp`/
`PgDn`/`Home`/`End`) momentarily blanks the entire left pane, then it repaints on
the next state emission.

---

## Root-cause hypothesis (ranked)

### 1. Ink's full-screen `clearTerminal` branch fires when the frame height crosses the pane's row count (PRIMARY)

The left pane is mounted with `alternateScreen: true` and Ink's default
`incrementalRendering: false`:

- `src/hosts/two-pane/steps-view/steps-view-runner.tsx:160-164` — `render(..., { exitOnCtrlC: false, patchConsole: false, alternateScreen: true })`.
- `node_modules/ink/build/render.js:17` — `incrementalRendering: false` default → standard log-update renderer.

Every interactive frame runs through Ink's `renderInteractiveFrame`
(`node_modules/ink/build/ink.js:685`). Before writing it computes:

```js
// ink.js:690-699
const viewportRows = isTty ? getWindowSize(this.options.stdout).rows : 24;
const isFullscreen = isTty && outputHeight >= viewportRows;
const shouldClearTerminal = shouldClearTerminalForFrame({
    isTty, viewportRows,
    previousOutputHeight: this.lastOutputHeight,
    nextOutputHeight: outputHeight,
    isUnmounting: this.isUnmounting,
});
```

and `shouldClearTerminalForFrame` (`ink.js:83-102`):

```js
const wasFullscreen   = previousOutputHeight >= viewportRows;
const wasOverflowing  = previousOutputHeight >  viewportRows;
const isOverflowing   = nextOutputHeight     >  viewportRows;
const isLeavingFullscreen = wasFullscreen && nextOutputHeight < viewportRows;
return wasOverflowing
    || (isOverflowing && hadPreviousFrame)
    || isLeavingFullscreen
    || shouldClearOnUnmount;
```

When this returns `true`, the write is a full wipe (`ink.js:700-713`):

```js
this.options.stdout.write(ansiEscapes.clearTerminal + this.fullStaticOutput + output);
```

`ansiEscapes.clearTerminal` (`node_modules/ansi-escapes/base.js:124-128`) erases
the screen + scrollback and homes the cursor. The non-clear path instead does an
in-place `eraseLines(previousLineCount) + str` (`log-update.js:48-51`) — atomic
and flicker-free.

**Why the left pane sits exactly on this boundary.** `StepsView` sizes its body
to fill the pane:

- `src/hosts/two-pane/steps-view/steps-view.tsx:113-114`
  ```ts
  const chromeRows = 5 + (state.banner !== undefined ? 1 : 0)
  const visibleCount = Math.max(1, (stdout?.rows ?? 24) - chromeRows)
  ```
  Body rows ≈ `rows - 5` (or `rows - 6` with a banner), plus header (1) + box
  top/bottom borders (2) + footer with `marginTop:1` (2). The rendered frame's
  `outputHeight` lands at ≈ `viewportRows` or just over — exactly the
  `isFullscreen`/`isOverflowing` regime.

**What a keypress changes to push `outputHeight` across the line for one frame:**

- **Footer wrap-height toggle.** The footer string gains/loses
  ` · ↑ scrolled · End live` depending on `scrollOffset > 0`
  (`steps-view.tsx:435`, `renderViewModeFooter`). At a narrow pane width this
  extra text wraps to an additional terminal row, so the **first** scroll key
  (which moves `scrollOffset` 0→1) and the key that returns to the tail
  (`scrollOffset` →0) change the wrapped height by one row, toggling
  `isOverflowing` / `isLeavingFullscreen`.
- **Banner row appearing/disappearing** mid-interaction (`chromeRows` +1,
  `BannerBox` adds a row) shifts both `visibleCount` and total height by one,
  again straddling the boundary.

The repo already has a regression test that *acknowledges* this mechanism —
`tests/unit/hosts/two-pane/steps-view/header-rerender.test.tsx:343-348`
deliberately drives "output will overflow the small viewport and exercise Ink's
clearTerminal + log-update mix." But that test only asserts the breadcrumb
appears once; it does NOT assert the pane stays non-blank on a navigation
keypress, so the flicker slips through.

This is the strongest explanation because it is (a) keypress-correlated,
(b) a true full-screen blank (not just a wrong row), and (c) self-heals on the
next emission — matching "blanks, then suddenly drawn again" precisely.

### 2. Selection `useEffect` + concurrent reproject → extra render at the boundary (CONTRIBUTING)

`useStepsSelection`'s effect runs on **every** `steps` change
(`steps-view-hooks.ts:53-65`) and calls `setSelectedName(...)`. A keypress
(`moveDown` → `setSelectedName` + `setIsUserDriven`) coinciding with a
tail-driven reproject (`steps-view-model.ts:57-68` emits `change` on every
lifecycle/state/overlay line) yields back-to-back renders. Each render
re-evaluates `renderInteractiveFrame`; if either render's `outputHeight` crosses
`viewportRows`, branch #1 fires. This does not independently blank the screen —
it increases how often the boundary is crossed during interaction. It also
explains the "then suddenly drawn again" half: the redraw is the next `change`
emission, not a recovery built into the keypress handler.

### 3. The runner's resize handler full-clears (SECONDARY, resize-only)

`steps-view-runner.tsx:184-186` prepends a resize listener that writes
`\x1b[H\x1b[2J` (home + erase) *before* Ink's own `resized` handler
(`ink.js:261-272`) re-renders. This is a real full blank but is gated on a
genuine SIGWINCH / `resize` event, not a keypress. Listed because it is a second
independent full-clear path on the same surface and may compound perceived
flicker during tmux pane resizes.

### Ruled out

- **Empty visible slice on keypress.** `visibleSlice` (`steps-view.tsx:270-279`)
  returns the whole array when `steps.length <= visibleCount`, otherwise slices
  `[start, end)` with `end = steps.length - scrollOffset`,
  `start = max(0, end - visibleCount)`. `scrollOffset` is derived from a clamped
  `effectiveTop` (`steps-view-hooks.ts:133-135`), so `0 ≤ scrollOffset ≤ maxTop`,
  giving a non-empty slice in every case. The arithmetic **cannot** produce `[]`.
  (It can change the slice's row count by ±1 at the edges — which feeds #1 via
  height — but is never empty.) An exhaustive Tier-2 probe (arrow ↑/↓, j/k,
  PgUp/PgDn, Home/End across buffers of exactly `visibleCount`, one-over, and
  growing/shrinking mid-scroll) found **no** blank or `(no steps yet)` frame.
- **State-driven blank during reproject.** `reloadState` catches schema
  corruption and returns *without* reprojecting (`steps-view-model.ts:71-79`),
  keeping the last good state. The `(no steps yet)` branch
  (`steps-view.tsx:235`) is unreachable mid-run from a keypress.
- **Keypress misread as resize.** Nothing in `useInput` or the runner emits a
  synthetic `resize`; `useAdaptiveColumns` only listens to real `stdout 'resize'`
  and `setColumns` does not remount Ink.

---

## Reproduction conditions (deterministic at Tier 1, not at Tier 2)

Set the rendered frame at the height boundary, then press a key that flips the
footer's wrap height:

- Pane (TTY) rows: small, e.g. `rows = 12`. Width narrow enough to wrap the
  footer, e.g. `columns = 30`.
- Steps: at least `visibleCount + 1` so scrolling is meaningful — with `rows=12`,
  `chromeRows=5`, `visibleCount = 7`; use ~10 steps.
- Frame height ≈ `rows` so `previousOutputHeight ≈ viewportRows`.
- Key: the **first** scroll/up key that moves `scrollOffset` 0→1 (arrow-up, `k`,
  or `PgUp`), which appends ` · ↑ scrolled · End live` and wraps the footer onto
  an extra row → `isOverflowing && hadPreviousFrame` (or `isLeavingFullscreen` on
  the return key) → `clearTerminal`. Equivalently, toggle a banner on/off via a
  state emission during interaction (`chromeRows` ±1).

---

## Reproducing test

**Important honest finding:** this bug is **invisible at Tier 2 (Ink projection
/ `ink-testing-library`)**. Under `ink-testing-library`, `stdout.rows` is
`undefined` (so `visibleCount = 24 - 5 = 19`) and Ink coalesces intermediate
renders, so the full-clear write window is never observable. A Tier-2 invariant
test was written and **passes on current code** — it is a regression fence
against `visibleSlice` ever returning `[]`, not a reproduction of this bug.

The deterministic reproduction must live at **Tier 1 (real tmux + `TmuxHost`)**
using `tests/helpers/real-tmux/`:

1. Boot a real tmux server and mount `StepsView` into a pane at a controlled
   height where `steps.length > visibleCount` (so Ink does a full clear+repaint
   rather than an in-place diff) and a width that wraps the footer (≈30 cols).
2. Drive a navigation key (arrow-up / `k` / `PgUp` — the one that moves
   `scrollOffset` 0→1).
3. Scrape the left pane via the harness `PaneHandle` in a tight poll across the
   write window and assert it is **never** read empty between the canvas-clear
   and the repaint.

Mirror: `tests/integration/hosts/two-pane/tier-1/replay-revisit-reuses-pane.real.integration.test.ts`
and siblings (these auto-skip when tmux is unavailable). This Tier-1 test was
**not authored yet** — it needs the live harness to confirm the flush window is
observable rather than guessed.

### Observable signal to assert

- **Primary (byte-level):** for a navigation keypress that does not change the
  step set, the write must NOT contain `ansiEscapes.clearTerminal` (`\x1b[2J` +
  scrollback-erase + home). Selection/scroll moves should be incremental
  (`eraseLines`-based), never a full terminal clear.
- **Screen-state:** after `moveUp()`/`scrollUp()` from the live tail, the scraped
  pane must still contain the breadcrumb and ≥1 step row — `stripAnsi(screen)`
  non-empty and includes a visible step.
- **Cheap unit guard (passes today):**
  `visibleSlice(state.steps, scroll.scrollOffset, visibleCount).length >= 1` for
  all reachable `(scrollOffset, visibleCount)`.

---

## Fix direction (NOT implemented)

Candidates, for the fixer to weigh:

- Stop the frame height from crossing `viewportRows` on benign keypresses — e.g.
  keep the footer a fixed single row (reserve the ` · ↑ scrolled` text width
  rather than appending it), or shrink `visibleCount` so the frame never reaches
  `outputHeight >= viewportRows`.
- Avoid the banner-toggle height shift mid-interaction (reserve the banner row).
- Investigate enabling Ink `incrementalRendering` for this surface so the
  full-clear branch is not taken.

---

## Uncertainties

- The actual `outputHeight` Ink computes depends on Yoga layout + ANSI wrapping
  at render time; the "frame sits at `outputHeight ≈ viewportRows`" claim is
  inferred from `chromeRows` + header/borders/footer-margin and corroborated by
  the pre-existing overflow regression test at width 30. A definitive
  confirmation needs the harness to print `outputHeight` vs `rows` at the repro
  size.
- Whether the user's pane is in the `isOverflowing` or `isLeavingFullscreen`
  sub-branch depends on exact pane height; both lead to the same `clearTerminal`
  write, so the root cause holds either way, but the precise triggering key
  (scroll-away vs return-to-tail) flips between them.
- Not traced: whether Ink reads the *pane* rows or the outer terminal rows inside
  tmux via `getWindowSize`/SIGWINCH. A stale/larger `rows` would shift the
  boundary but not the mechanism.
