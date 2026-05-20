---
title: "feat: steps-view visual polish (hairlines + cyan focus + colored glyphs)"
status: active
created: 2026-05-12
type: feat
origin: docs/brainstorms/2026-05-12-steps-view-visual-polish-brainstorm.md
---

# feat: steps-view visual polish (hairlines + cyan focus + colored glyphs)

## Summary

Three small affordances on the two-pane left pane (`--mode=two-pane`): hairline rules above and below the steps list, cyan + bold selection accent on the selected row, and semantic color on status glyphs. Implementation reaches into two Ink files (`src/hosts/two-pane/steps-view/steps-view.tsx`, `src/hosts/two-pane/steps-view/end-of-run-summary.tsx`) plus one new sibling helper in `src/observability/status-pane.ts`. Existing `stepGlyph` and the right-pane renderer are untouched.

---

## Problem Frame

The left-pane steps view currently renders as a flat stream of monochrome `<Text>` rows. Selection is whisper-quiet (a `▌` cursor with no color, only visible during `isUserDriven`), success/failure/running glyphs share the terminal's default foreground, and the header / steps / footer have no breathing room. After a 30-minute run the user can't tell at a glance which row is selected, the eye has nothing to land on, and a green `✓` versus a red `✗` is zero-effort information density we are throwing away.

The bar this clears: nicer to look at while still parseable in plain `cat` output, screen readers, and `NO_COLOR=1` terminals. Color is decoration on top of an already-correct monochrome rendering.

See origin: [`docs/brainstorms/2026-05-12-steps-view-visual-polish-brainstorm.md`](../brainstorms/2026-05-12-steps-view-visual-polish-brainstorm.md).

---

## Requirements

- **R1.** Steps list is visually grouped via hairline rules (one above, one below) without an outer pane border that would double-frame against tmux.
- **R2.** The selected step row is unmistakable at rest: cursor `▌` and step name render in cyan, name renders bold. Selection visibility remains gated on `isUserDriven === true`.
- **R3.** Status glyphs carry semantic color: `✓` green (completed), `✗` red (failed), `◐` yellow (running), `·` dim (pending). Selection cyan applies only to the row name, not the glyph.
- **R4.** `EndOfRunSummary` status label is colored: `completed` green, `failed`/`crashed` red. Hairlines and selection accent apply identically in the terminal state. The `EndOfRunFooter` footer line (`run completed · q to quit · ⏎ to inspect`) remains `dimColor` — only the summary header's status word is colored.
- **R5.** Zero changes to layout columns (adaptive-columns behavior preserved), keymap, intents, viewmodel, step-types, hooks, or right pane.
- **R6.** Zero changes to information density: no row gets taller, no row gets truncated; no extra blank lines.
- **R7.** The banner (`info` / `error`) renders between the header sub-line and the upper hairline — never inside the bordered block.
- **R8.** Empty state `(no steps yet)` renders WITHOUT the surrounding hairlines.
- **R9.** Graceful `NO_COLOR=1` degradation: rendering remains structurally correct and readable when ANSI is stripped (hairlines survive — they are box-drawing chars, not ANSI; color and bold are no-ops by Ink and the terminal).
- **R10.** `bun run check` green; no regression in narrow-terminal rendering (< 70 cols, `adaptive-columns.ts` drop behavior preserved).

---

## Key Technical Decisions

### KD1. New sibling helper `stepGlyphView` — do not modify existing `stepGlyph`

Add a new helper `stepGlyphView(status: StepStatus): { char: string; color?: string; dim?: boolean }` colocated with `stepGlyph` in `src/observability/status-pane.ts`. Export from `src/observability/index.ts`.

**Rationale.** Existing `stepGlyph(status, tty)` returns a plain `string` and is consumed by `renderStatusPane` (the right-pane status output). The brainstorm forbids changes to the right pane and to existing plain-text glyph output. Adding a new sibling that returns char + color + dim:

- Keeps `stepGlyph` callers in `src/observability/status-pane.ts:173` and existing tests in `tests/unit/observability/status-pane.test.ts` untouched.
- Avoids leaking Ink color names into the plain-text rendering path.
- Gives the Ink renderer one helper call and one prop spread (cleaner than two parallel lookups).

The brainstorm explicitly listed both options ("a sibling `glyphColor()`" vs. "extend `stepGlyph` to return `{ char, color }`"). The sibling-with-char approach combines the merits of both — single helper, no impact on existing consumers. The helper is named `stepGlyphView` (not `glyphColor` as the brainstorm option-name suggested) because it returns a view-layer rendering object (`char + color + dim`), not just a color string — the name reflects the broader return shape.

### KD2. Glyph table delta inside the Ink helper only

`stepGlyphView` defines its own char table that differs from `stepGlyph`'s for two statuses:

| status      | `stepGlyph` (existing) | `stepGlyphView` (new) | color  | dim |
| ----------- | ---------------------- | --------------------- | ------ | --- |
| completed   | `✓`                    | `✓`                   | green  | no  |
| failed      | `✗`                    | `✗`                   | red    | no  |
| running     | `●`                    | `◐`                   | yellow | no  |
| pending     | `○`                    | `·`                   | —      | yes |
| interactive | `⟳`                    | `⟳`                   | —      | yes |
| cached      | `↺`                    | `↺`                   | —      | yes |

The status-pane renderer (right pane) keeps `●` and `○` because the brainstorm scopes the visual change to the left-pane Ink view (see origin: §"Where the code changes land"). `interactive` and `cached` fall through with `dim: true` and no explicit color — the brainstorm did not specify them.

**Note on `skipped` (origin) and `crashed` (run-level only).** The brainstorm's D3 table lists a `skipped` row, but `StepStatus` (`src/hosts/two-pane/steps-view/step-types.ts:8`) does not include `skipped` — the union is `pending | running | interactive | completed | failed | cached`. `skipped` was a brainstorm error corrected here; `stepGlyphView` does not need a row for it. `crashed` is a *run-level* status (`EndOfRunSummaryProps.status`, see `end-of-run-summary.tsx:22`), not a step-level status, so it does not appear in `stepGlyphView`'s table either — `crashed` is handled by KD5/U4's `statusColor` helper.

### KD3. Hairlines via Ink `borderTop`/`borderBottom` on a column Box

Wrap the steps list in `<Box flexDirection="column" borderStyle="single" borderTop borderBottom borderLeft={false} borderRight={false} borderColor="gray">`. The explicit `borderLeft={false} borderRight={false}` is required — Ink 7.0.1 defaults all four edges to `true` when `borderStyle` is set, which would render a full `┌──┐ │…│ └──┘` box and double-frame against the tmux pane border (violating R1). Setting only `borderTop` and `borderBottom` to truthy values does not suppress the side edges; they must be explicitly disabled.

This adapts to terminal resize automatically and uses box-drawing characters that survive `NO_COLOR`.

**Fallback (if Ink renders unexpected behavior under flex column layout).** Sibling `<Text dimColor>` rules sized to `process.stdout.columns` rendered via a `useStdout` width subscription. Documented as a risk; not the primary path.

### KD4. Banner placement above the upper hairline

Move the existing `<BannerBox>` render so it sits between the header (or `EndOfRunSummary`) and the bordered steps block. The bordered block must contain only the steps grid so that hairlines visually frame steps, not transient banner content.

### KD5. EndOfRunSummary status label color via a small helper

Replace the plain `${label}` interpolation in `EndOfRunSummary` with a `<Text color={statusColor(status)}>{label}</Text>` segment inside the existing header line. `statusColor`: `completed` → `'green'`, `failed`/`crashed` → `'red'`. Keep the rest of the header line at default foreground so only the status word is colored.

### KD6. Static `◐` for running — no animation

The brainstorm references "the yellow `◐` already spins via the existing glyph rotation" — the project has no such rotation today (grep across `src/` for `◐|spinner|rotat` returns no matching glyph rotation code). The Non-goals section explicitly states "no animation on the cursor / no spinner re-design." `◐` renders statically in yellow.

### KD7. Tests assert on un-stripped frame ANSI substrings — chalk forced to truecolor in test setup

The existing test harness uses `stripAnsi(renderToString(...))` for content assertions. Color tests use the un-stripped frame and assert substrings like `\x1b[36m` (cyan), `\x1b[32m` (green), `\x1b[31m` (red), `\x1b[33m` (yellow), `\x1b[1m` (bold), `\x1b[2m` (dim).

**Required test setup (mandatory).** Under `bun test`, `process.stdout.isTTY` is `false`, which causes chalk's `supports-color` detector to return level 0 — Ink then emits no ANSI sequences regardless of `color=` / `bold` / `dimColor` props. Each color-asserting test file (or a single shared preload) must force chalk level 3 before any `renderToString` call. Use one of:

- Top-of-file: `import chalk from 'chalk'; chalk.level = 3` (preferred — explicit, file-local)
- Top-of-file: `process.env.FORCE_COLOR = '3'` before any chalk-dependent import resolves
- A `bun test --preload` script setting either of the above globally

Pick one approach during U1 implementation and use it consistently across U1, U3, U4. Existing tests that use `stripAnsi(renderToString(...))` continue to pass unchanged — `stripAnsi` is a no-op on monochrome output and remains correct on colored output.

**Rationale.** `renderToString` returns ANSI-encoded output when chalk has a color level. There is no in-tree React tree introspection helper for `<Text>` props. Asserting on ANSI substrings is the established Ink test pattern at this scale and keeps the test surface consistent with the existing snapshot tests in the same directory. Existing snapshot/text assertions in `tests/unit/hosts/two-pane/steps-view/` keep using `stripAnsi` and continue to assert on textual content only.

---

## Output / Visual Target

Target wide-terminal rendering (>= 70 cols), live, hot step running:

```
orch · my-workflow · r-...-xyz
──────────────────────────────────────────────────────────────────────
   write-riddle      ✓     00:12
 ▌ solve-riddle      ◐     00:05    ← cyan cursor, bold cyan name, yellow glyph
──────────────────────────────────────────────────────────────────────
▶ live · ⏎ view step · q quit · ? help
```

Narrow (< 70 cols), elapsed column dropped (existing `adaptive-columns` behaviour):

```
orch · my-workflow · r-...-xyz
───────────────────────────────────────
   write-riddle      ✓
 ▌ solve-riddle      ◐
───────────────────────────────────────
▶ live · ⏎ view step · q quit · ? help
```

*Directional rendering only; the implementing agent should treat this as visual context, not pixel-exact specification.*

---

## Implementation Units

### U1. Add `stepGlyphView` helper in observability

**Goal:** Introduce the new sibling helper that returns `{ char, color?, dim? }` for Ink consumers, without touching `stepGlyph`.

**Requirements:** R3, R5 (preserves `stepGlyph`).

**Dependencies:** none.

**Files:**
- `src/observability/status-pane.ts` (add helper next to existing `stepGlyph`)
- `src/observability/index.ts` (re-export)
- `tests/unit/observability/status-pane.test.ts` (extend with `stepGlyphView` tests)

**Approach:**
- Define a new `INK_STEP_VIEW: Record<StepStatus, { char: string; color?: string; dim?: boolean }>` table per KD2.
- Export `stepGlyphView(status: StepStatus): { char: string; color?: string; dim?: boolean }`.
- Pure function, no Ink imports — keeps `observability/` free of UI deps.
- TypeScript strict + `noUncheckedIndexedAccess` enforces exhaustiveness at compile time since `INK_STEP_VIEW` is a `Record<StepStatus, …>`. `crashed` is not a `StepStatus` (it is a run-level status only), so it does not need a row. `skipped` from the brainstorm's table does not exist in `StepStatus`.

**Patterns to follow:**
- Existing `UNICODE_STEP_GLYPHS` / `ASCII_STEP_GLYPHS` Record-of-StepStatus pattern in `src/observability/status-pane.ts:62-78`.
- Pure-function export style with the same JSDoc-free shape used for `stepGlyph` and `formatElapsed`.

**Test scenarios:**
- `stepGlyphView('completed')` returns `{ char: '✓', color: 'green' }` (no dim).
- `stepGlyphView('failed')` returns `{ char: '✗', color: 'red' }`.
- `stepGlyphView('running')` returns `{ char: '◐', color: 'yellow' }`.
- `stepGlyphView('pending')` returns `{ char: '·', dim: true }` (no color).
- `stepGlyphView('interactive')` returns `{ char: '⟳', dim: true }`.
- `stepGlyphView('cached')` returns `{ char: '↺', dim: true }`.
- Existing `stepGlyph(status, tty)` tests still pass unchanged (regression guard for KD1).

(These are pure-data lookups against a `Record<StepStatus, …>` table — TypeScript exhaustiveness already enforces shape correctness, so each scenario is a one-line assertion. The list errs toward enumeration so the implementer doesn't have to decide which to include.)

**Verification:** `bun run check` green; the new helper is reachable via `import { stepGlyphView } from '../../../observability/index.ts'`.

---

### U2. Render hairlines, banner repositioning, and bordered steps block

**Goal:** Wrap the steps grid in a column `<Box>` with `borderTop` + `borderBottom` (`borderStyle="single"`, `borderColor="gray"`); move `<BannerBox>` above the upper hairline; preserve the empty-state path (no hairlines around `(no steps yet)`).

**Requirements:** R1, R6, R7, R8.

**Dependencies:** none (independent of U1).

**Files:**
- `src/hosts/two-pane/steps-view/steps-view.tsx`
- `tests/unit/hosts/two-pane/steps-view/steps-view.test.tsx`

**Approach:**
- Restructure the JSX returned by `StepsView`: header → banner (when present) → bordered steps `<Box>` → footer.
- The bordered block wraps the existing `state.steps.map(...) -> <StepRow>` content unchanged.
- Use `<Box flexDirection="column" borderStyle="single" borderTop borderBottom borderLeft={false} borderRight={false} borderColor="gray">` for the bordered block (KD3). Side borders must be explicitly `false` — Ink defaults all four edges to truthy when `borderStyle` is set.
- Keep the existing `state.steps.length === 0` branch outside the bordered block so the empty state has no surrounding rules.
- The `HelpOverlay` render path (`state.helpOpen === true`) is unchanged: hairlines remain rendered above and below the steps block when the overlay is open. The overlay appends below the footer slot as it does today; no visual nesting issue arises because the overlay sits *outside* the bordered block.
- If unexpected behavior emerges (missing edge after explicit prop, layout shift), fall back to sibling `<Text dimColor>` rules sized to `process.stdout.columns` via Ink's `useStdout` (KD3 fallback). The fallback is a risk note, not the primary path.

**Patterns to follow:**
- The existing `HelpOverlay` border usage at `src/hosts/two-pane/steps-view/steps-view.tsx:289` (`<Box flexDirection="column" borderStyle="round" paddingX={1} marginTop={1}>`) — same `borderStyle` family, narrower edge selection.
- `BannerBox` positioning convention: it currently renders between header and steps grid (`steps-view.tsx:171`); after this unit it renders between header and the bordered steps block.

**Test scenarios:**
- Hairlines: rendered frame contains the upper and lower rule (a substring of `─` characters spanning the terminal width) when `state.steps.length > 0`.
- Empty state: when `state.steps.length === 0`, the frame contains `(no steps yet)` and NO hairline rule above or below it.
- Banner position: when a banner is present and `state.steps.length > 0`, the banner text appears in the frame BEFORE the upper hairline (assert via index ordering of substrings in the stripped frame).
- No regression: existing `renders the run header, every step name, and the keymap on a live run` test continues to pass with the same substring assertions.
- No regression: existing `renders the end-of-run footer when the run is no longer live` continues to pass.
- Narrow terminal (< 70 cols): assert on a 60-column `renderToString` frame that elapsed column is still dropped per `adaptive-columns.ts` AND the hairlines still render (rules adapt to width).

**Verification:** `bun run check` green; manual smoke via `bun run examples/<any>/index.ts` (two-pane mode) optional but encouraged — confirms hairlines render visually as single rules without doubling against the tmux pane border.

---

### U3. Cyan + bold selection accent on `<StepRow>`

**Goal:** Render the selection cursor and step name with `color="cyan"` and bold when `selected === true`; render the colored status glyph via `stepGlyphView`.

**Requirements:** R2, R3.

**Dependencies:** U1 (consumes `stepGlyphView`).

**Files:**
- `src/hosts/two-pane/steps-view/steps-view.tsx` (the `<StepRow>` memo'd component)
- `tests/unit/hosts/two-pane/steps-view/steps-view.test.tsx`

**Approach:**
- Inside `StepRowImpl` (`steps-view.tsx:226-248`), replace the single `<Text>{parts.join('  ')}</Text>` render with three `<Text>` segments inside a `<Box flexDirection="row">` (or equivalent): cursor segment, name segment, glyph segment, optional elapsed segment.
- Cursor segment: `<Text color={selected ? 'cyan' : undefined}>{cursor}</Text>` where `cursor` is `▌` or `' '`.
- Name segment: `<Text color={selected ? 'cyan' : undefined} bold={selected}>{name}</Text>`.
- Glyph segment: `const view = stepGlyphView(step.status); <Text color={view.color} dimColor={view.dim}>{view.char}</Text>`. The selection cyan accent does NOT override glyph color (KD2).
- Preserve the visual two-space spacing between cursor/name and name/glyph and glyph/elapsed by emitting the spacing as literal string content inside one of the adjacent `<Text>` segments (e.g. `{` ` + name}` or a sibling `<Text>{`  `}</Text>`) — Ink may collapse a bare ` ` string child of a flex `<Box>` in some renderings. Concretely: produce the same character byte sequence as the current `parts.join('  ')` output, just with embedded style spans around the cursor, name, and glyph. No row should change in column count (R6).
- Preserve the `memo` equality function unchanged (`prev.selected !== next.selected` already triggers re-render).
- Selection prop is unchanged: `selected={step.name === selectedName && isUserDriven}` — the existing `isUserDriven` gate stays in `StepsView`'s map call. Do not introduce a path where `<StepRow>` receives `selected=true` without the gate.

**Patterns to follow:**
- The existing `<BannerBox>` cyan + `dimColor` combination at `src/hosts/two-pane/steps-view/steps-view.tsx:208` — same palette role.
- `<Text bold>` usage in `HelpOverlay` (`steps-view.tsx:290`).

**Test scenarios:**
- Selected row: un-stripped frame contains the cyan ANSI substring (`\x1b[36m`) and the bold ANSI substring (`\x1b[1m`) on the same logical line as the selected step name.
- Unselected row: un-stripped frame for an unselected row does NOT contain `\x1b[36m` on the name OR `\x1b[1m` on the name.
- Selection cursor: when `isUserDriven === true` and the row is selected, the `▌` glyph appears in the frame with `\x1b[36m`.
- Cursor placeholder: when the row is unselected, the cursor cell renders as a literal space with no preceding color ANSI sequence.
- Glyph color: rendered frame for a row with `status: 'completed'` contains `\x1b[32m` (green) preceding `✓`; `status: 'failed'` contains `\x1b[31m` (red) preceding `✗`; `status: 'running'` contains `\x1b[33m` (yellow) preceding `◐`; `status: 'pending'` contains `\x1b[2m` (dim) preceding `·`.
- Selection × glyph independence: a selected row with `status: 'failed'` has cyan on the name AND red on the glyph (both ANSI substrings present, glyph color is not cyan).
- No bold on glyph: a selected row's glyph segment does not include `\x1b[1m`.
- `isUserDriven` gate enforcement: when the parent passes `selected=false` (because the gate is closed), no row in the frame carries `\x1b[36m` on the cursor or name — closes the gate's negative case.
- Stripped-frame regression: `stripAnsi(frame)` for a selected row still contains the cursor, name, and glyph as plain text — i.e., the row width and text content is unchanged from current behavior (R6).
- Column-alignment check: render two rows with names of different lengths (e.g. `plan` and `solve-riddle-now`) and assert that the byte-for-byte plain-text width of each row matches what `parts.join('  ')` would have produced — no collapsed whitespace, no extra padding introduced by `<Box flexDirection="row">` flex behavior.

**Verification:** `bun run check` green; all existing `<StepsView>` snapshot tests continue passing (they assert on stripped content, which is unchanged).

---

### U4. EndOfRunSummary status label color

**Goal:** Color the status word inside `EndOfRunSummary`'s header line — green for `completed`, red for `failed` and `crashed`. The rest of the line stays default.

**Requirements:** R4.

**Dependencies:** none.

**Files:**
- `src/hosts/two-pane/steps-view/end-of-run-summary.tsx`
- `tests/unit/hosts/two-pane/steps-view/end-of-run-summary.test.tsx`

**Approach:**
- Replace the single-string header line in `EndOfRunSummary` (`end-of-run-summary.tsx:34`) with a `<Text>` containing an inline `<Text color={statusColor(status)}>{label}</Text>` segment for the status word.
- Add a `statusColor(status: 'completed' | 'failed' | 'crashed'): string` local helper returning `'green'` for `completed` and `'red'` for the rest. Keep it colocated; it does not need to live in `observability/`.
- `EndOfRunFooter` is unchanged — only the summary header line gets the colored label.

**Patterns to follow:**
- Inline `<Text color="...">` segments nested inside a parent `<Text>` is the established Ink composition pattern in this file's neighbors.

**Test scenarios:**
- `status="completed"`: un-stripped frame contains `\x1b[32m` (green) preceding the word `completed` in the header line.
- `status="failed"`: un-stripped frame contains `\x1b[31m` (red) preceding the word `failed`.
- `status="crashed"`: un-stripped frame contains `\x1b[31m` (red) preceding the word `crashed`.
- The rest of the header line (`orch · workflow · runId`) does not pick up the status color.
- Existing tests in `end-of-run-summary.test.tsx` that use `stripAnsi` continue to pass — text content unchanged.

**Verification:** `bun run check` green.

---

### U5. NO_COLOR and stripped-frame integrity check

**Goal:** Verify the rendering degrades cleanly when ANSI is stripped (the `NO_COLOR=1` posture). One focused test asserts structural integrity.

**Requirements:** R9.

**Dependencies:** U2, U3, U4 (renders the final UI shape).

**Files:**
- `tests/unit/hosts/two-pane/steps-view/steps-view.test.tsx` (one additional test case)

**Approach:**
- Render `<StepsView>` with a representative live state (one completed step, one running step, selection on the running step) via `renderToString` at columns: 110.
- `stripAnsi` the frame.
- Assert: every step name appears, both glyph characters appear (`✓` and `◐`), both hairline rules appear (rows of `─` chars), the footer keymap appears, the selection cursor `▌` appears on the selected row.
- This validates that color + bold do not provide load-bearing information — the screen is fully parseable without them.

**Patterns to follow:**
- Existing `stripAnsi(renderToString(...))` pattern throughout `tests/unit/hosts/two-pane/steps-view/steps-view.test.tsx`.

**Test scenarios:**
- Stripped frame contains the run header, both step names, both colored-glyph characters as plain chars, both hairline rules, the live-mode footer text, and the `▌` cursor on the selected row.
- No regression: rendering a `NO_COLOR=1` shape (via `stripAnsi`) does not lose any structural content compared to the colored rendering's stripped form.

**Verification:** `bun run check` green.

---

## Scope Boundaries

### In scope
- The three affordances (hairlines, cyan focus, colored glyphs) inside `steps-view.tsx` and `end-of-run-summary.tsx`.
- The new `stepGlyphView` helper in `src/observability/status-pane.ts` and its re-export.
- Test coverage for color, bold, dim, hairline presence, banner positioning, empty state, and stripped-frame integrity.

### Out of scope (origin non-goals carried forward)
- Outer pane border around the whole steps view (would double-frame against tmux pane border).
- Background-color highlight on the selected row (foreground cyan + bold is the chosen accent).
- New keybindings, intents, or state.
- Theming / configuration / a NO_COLOR config switch (Ink and the terminal handle it).
- Changes to the right pane (replay / live), the help overlay (already has its own rounded border treatment), or the rollup display.
- Animation on the cursor or running glyph (`◐` stays static).
- Changes to `stepGlyph`, `status-pane.ts` renderer, `step-types.ts`, `steps-view-model.ts`, `parallel-rollup.ts`, or any hook.

### Deferred to Follow-Up Work
- Step-block card variant (rounded border ONLY around the steps list) — kept as the "if hairlines feel too bare" fallback. Not built now; can be revisited based on user feedback after this lands.
- Colored glyphs in the right-pane status output (`renderStatusPane` / `parallel-rollup.ts`). Out of scope today because the right pane is governed by separate rendering constraints (it writes plain text into tmux), but a future plan could extend `stepGlyphView` semantics there.
- `interactive` and `cached` glyph color choices — currently dim-only; could be given semantic color if user feedback wants it.

---

## System-Wide Impact

| Surface                          | Impact                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/observability/index.ts`     | One new export: `stepGlyphView`. Additive, no breaking change.                                  |
| `src/observability/status-pane.ts` | New helper colocated with `stepGlyph`. `stepGlyph` itself unchanged.                          |
| `src/hosts/two-pane/steps-view/steps-view.tsx` | `<StepRow>` re-shaped into multi-segment `<Text>` render; hairlines wrap steps grid; banner repositioned. |
| `src/hosts/two-pane/steps-view/end-of-run-summary.tsx` | Status label gets inline colored segment.                                              |
| Right pane (replay/live, rollup) | Untouched. `parallel-rollup.ts` glyphs unchanged.                                               |
| Hooks (`steps-view-hooks.ts`)    | Untouched.                                                                                      |
| Step viewmodel (`steps-view-model.ts`, `step-types.ts`) | Untouched.                                                                       |
| Existing snapshot tests          | All continue to pass — they assert on stripped text content, which is unchanged.                |

No migration, no env-var, no dependency change, no public API contract change.

---

## Risk Analysis

| Risk                                                                 | Mitigation                                                                                                                                                                                                          |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ink 7 `borderTop`/`borderBottom` on a flex column behaves unexpectedly (double rule, missing edge, layout shift). | Verify visually during U2 implementation. Fallback: sibling `<Text dimColor>` rules sized to `process.stdout.columns` via Ink's `useStdout` width subscription. Plan ships either way. |
| ANSI substring assertions are brittle if Ink changes its emit order. | Assert on individual color/style escape *substrings* (presence/absence) rather than exact-byte ordering. Existing test files already use this style for the `BannerBox` red color implicitly via `stripAnsi` content asserts. |
| Multi-segment `<Text>` rendering changes row width by a single space. | U3's "stripped-frame regression" test asserts row text content is byte-identical (within whitespace tolerance) to current `parts.join('  ')` output. R6 is the contract. |
| The selection accent doesn't visibly differentiate on light themes. | On light terminals cyan may be low-contrast. Selection remains unambiguous because the `▌` cursor is the load-bearing signal — bold + cyan are supplementary. Theming/configurability is explicitly out of scope (origin Non-goals); the cursor carries selection in all themes including `NO_COLOR=1`. |
| `NO_COLOR=1` strips the bold prop unexpectedly.                      | U5 asserts the stripped frame is structurally intact. Bold-presence is not load-bearing — selection is also indicated by the `▌` cursor.                                                                          |

---

## Verification

A successful landing satisfies all of:

1. `bun run check` is green (lint + typecheck + unit + mocked-integration).
2. All new test scenarios in U1–U5 pass.
3. All existing tests in `tests/unit/hosts/two-pane/steps-view/` and `tests/unit/observability/status-pane.test.ts` pass unchanged.
4. Manual smoke (encouraged): run any two-pane example workflow (e.g., `bun run examples/riddle-solver/index.ts` with `--mode=two-pane`) and visually confirm:
   - Hairlines render as single rules (not doubled against the tmux pane border).
   - Selected row stands out via cyan + bold.
   - Completed steps glow green; running step glows yellow; a failed step glows red.
   - Narrow terminal (resize < 70 cols) still drops the elapsed column and the hairlines adapt.
5. `NO_COLOR=1 bun run examples/...` (optional manual check): rendering remains structurally correct in monochrome.

---

## Open Questions

None blocking. All three open questions from the origin doc are resolved in Key Technical Decisions:
- Hairline shape: KD3 (Ink `borderTop`/`borderBottom`, fallback documented).
- `stepGlyph` reshape: KD1 (new sibling helper, existing function untouched).
- `NO_COLOR` posture: U5 verifies via stripped-frame integrity test.

Verify-during-implementation items (not blockers):
- Confirm Ink 7's per-edge border props render exactly one rule each in a column flex parent (U2 verification step).
- Confirm `<Text bold>` degrades cleanly under `NO_COLOR=1` (U5 verification step).
