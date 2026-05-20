# Brainstorm — steps-view visual polish (hairline sections + cyan focus + colored glyphs)

> Status: requirements captured, ready for planning. Decisions below are
> agreed; open items at the bottom are small follow-ups for ce-plan.

## What changes

The left-pane steps view in `--mode=two-pane` currently renders as a flat
stream of `<Text>` rows with no visual grouping. Selection is whisper-quiet
(a `▌` cursor with no color), success/failure/running glyphs share the
terminal's default foreground, and the header / steps / footer have no
breathing room between them. The user reads the screen as one wall of grey
type.

We want to keep the "honest CLI" character — no full pane border, no
heavy chrome — and add three small affordances:

1. **Hairline sections.** Dim horizontal rules separate the header block
   from the steps list and the steps list from the footer.
2. **Cyan focus accent.** The selection cursor and the selected step's name
   render in cyan (`color="cyan"`) and the name renders bold.
3. **Colored status glyphs.** `✓` green for completed steps, `✗` red for
   failed, `◐` yellow for running. Pending steps stay neutral / dim.

A target rendering, terminal width ~70:

```
orch · codex-riddle-solver · r-2026-05-12-101859-6t · completed
steps 2/2 completed · duration 28m51s
──────────────────────────────────────────────────────────────────────
   write-riddle      ✓                          ← green ✓
 ▌ solve-riddle      ✓                          ← cyan cursor + bold
──────────────────────────────────────────────────────────────────────
run completed · q to quit · ⏎ to inspect
```

## Why

Three observations against the current screen
(`docs/brainstorms/2026-05-12-steps-view-screenshot.png` is the source of
truth — see the user's brainstorm input):

- **No visual hierarchy.** The eye has nothing to land on. Header, steps,
  footer flow as one paragraph.
- **Selection is invisible at rest.** A monochrome `▌` cursor only registers
  while the user is actively pressing arrows. Returning to the TUI after a
  context-switch, you can't tell which row is selected.
- **Glyphs carry no semantic weight.** A green `✓` versus a red `✗` is
  zero-effort information density that we're throwing away today.

The bar this clears: nicer to look at while still parseable in plain `cat`
output, screen readers, and `NO_COLOR=1` terminals. Color is decoration on
top of an already-correct monochrome rendering.

## Goals

- Steps view feels grouped without feeling boxed-in (no second border
  competing with the tmux pane border that already wraps the view).
- Selected row is unmistakable at a glance, even after a 30-minute run when
  nothing else is moving.
- Status (completed / failed / running) is readable from peripheral vision
  via color, not just glyph shape.
- Zero change to layout columns, keymap, intents, or viewmodel.
- Zero change to information density — no row gets taller, no row gets
  truncated.

## Non-goals

- No outer border around the whole pane (full-card layout was considered
  and rejected — would clash with the tmux pane border).
- No background-color highlight on the selected row. Foreground color +
  bold is enough and avoids ANSI quirks across terminal themes.
- No new keybindings, no new intents, no new state.
- No theming / configuration. One palette, one look. (A `NO_COLOR` env
  fallback is automatic via Ink and the terminal; we don't add a switch.)
- No changes to the right pane (replay / live) or the help overlay (which
  already has its own rounded border treatment and reads fine).
- No animation on the cursor / no spinner re-design (yellow `◐` already
  spins via the existing glyph rotation).

## Decisions

### D1. Hairline sections, not borders

Two horizontal rules: one above the steps list, one below it. Implemented
as `<Box borderStyle="single" borderTop borderColor="gray">` (or the
equivalent `borderBottom`-only on the preceding block) so we get a single
rule that spans the available width and adapts to resize.

Rationale: the steps view lives inside a tmux pane with its own border. A
full Ink border around our content would double-frame. Hairlines give the
grouping without the frame. They also degrade gracefully in clients that
don't render box-drawing characters (the `─` becomes `-`-ish).

### D2. Cyan selection accent + bold name

- Selected row cursor: `▌` in `color="cyan"`.
- Selected row name: `<Text color="cyan" bold>{name}</Text>`.
- Unselected rows: unchanged (default foreground, no bold).
- Selection is only visible when `isUserDriven === true` — same gate the
  current code uses. The cursor stays a space until the user touches an
  arrow key.

Rationale: cyan is already the codebase's "informational / attention" hue
(`BannerBox` in `src/hosts/two-pane/steps-view/steps-view.tsx:208`).
Reusing it keeps the palette to three roles: cyan = attention, red = error,
dim grey = secondary.

### D3. Colored status glyphs

`stepGlyph(status)` returns a character today; the row passes it through a
plain `<Text>`. We add a sibling `glyphColor(status)` helper (or extend
`stepGlyph` to return `{ char, color }`) so the row renders the glyph as:

| status      | glyph | color   |
| ----------- | ----- | ------- |
| completed   | `✓`   | green   |
| failed      | `✗`   | red     |
| running     | `◐`   | yellow  |
| pending     | `·`   | dim     |
| skipped     | (existing) | dim |

The selected-row cyan accent does NOT override glyph color — the name is
cyan, the glyph stays its semantic color. Two distinct signals.

### D4. Minimal padding, no extra blank lines

The hairlines provide the visual separation. We do not add an extra blank
line above or below the steps block (avoids stealing vertical space on
short terminals). The current `marginTop={1}` on `ViewModeFooter` already
gives the footer one line of breathing room — we keep that.

The banner, when present, renders **between the header sub-line and the
upper hairline** (so the steps block stays clean even when an info banner
is on screen).

### D5. EndOfRunSummary gets the same treatment

`EndOfRunSummary` and `EndOfRunFooter`
(`src/hosts/two-pane/steps-view/end-of-run-summary.tsx`) sit in the same
slot as the live header / footer. They use the same hairlines, the same
cyan accent on the selected past step, the same colored glyphs.

One small touch: the status label in the summary header — `completed` /
`failed` / `crashed` — gets a one-word color (green / red / red). The rest
of the line stays default.

## How it lays out — terminal-by-terminal

**Wide (>= 70 cols), live, hot step running:**

```
orch · my-workflow · r-...-xyz
──────────────────────────────────────────────────────────────────────
   write-riddle      ✓     00:12
 ▌ solve-riddle      ◐     00:05    ← cyan cursor, bold cyan name,
                                       yellow glyph
──────────────────────────────────────────────────────────────────────
▶ live · ⏎ view step · q quit · ? help
```

**Narrow (< 70 cols), elapsed column dropped (existing behaviour):**

```
orch · my-workflow · r-...-xyz
───────────────────────────────────────
   write-riddle      ✓
 ▌ solve-riddle      ◐
───────────────────────────────────────
▶ live · ⏎ view step · q quit · ? help
```

**Terminal state with error banner:**

```
orch · my-workflow · r-...-xyz · failed
steps 1/2 completed · 1 failed · duration 12m04s
! resume failed: pane respawn lost output · Esc dismiss
──────────────────────────────────────────────────────────────────────
   write-riddle      ✓
 ▌ solve-riddle      ✗                          ← red glyph + cyan name
──────────────────────────────────────────────────────────────────────
run failed · q to quit · ⏎ to inspect
```

## Where the code changes land

All changes are in two files:

- `src/hosts/two-pane/steps-view/steps-view.tsx`
  - `<StepRow>`: render name as `<Text color={selected ? 'cyan' : undefined}
    bold={selected}>`, render glyph through new `glyphColor(status)` helper.
  - Wrap the steps list in a `<Box flexDirection="column" borderStyle="single"
    borderTop borderBottom borderColor="gray">` (or equivalent two-sibling
    rule approach if `borderTop`/`borderBottom` only doesn't span width
    correctly under Ink's flex model — verify during planning).
  - Move `<BannerBox>` to render above the upper hairline.
- `src/hosts/two-pane/steps-view/end-of-run-summary.tsx`
  - Color the status label inside `EndOfRunSummary` (`completed` → green,
    `failed` / `crashed` → red).

`src/hosts/two-pane/steps-view/step-types.ts` and the steps-view-model do
not change. `stepGlyph` in `src/observability/index.ts` may grow a sibling
`glyphColor()` that takes the same `StepStatus` — or we extend `stepGlyph`
to return `{ char, color }` and update both call sites. ce-plan picks the
shape.

## Alternatives considered

- **Full pane card** — rounded border around header + steps + footer.
  Visually strongest but double-frames against the tmux pane border.
  Rejected.
- **Step block card** — rounded border ONLY around the steps list (not
  header / footer). Cleaner than full pane card, still adds chrome. The
  user picked hairlines over this; keeping it as a "if hairlines feel too
  bare, this is the next step up" fallback.
- **Background-color highlight on selected row** — works on most terminals
  but reads inconsistently across themes (light themes vs dark themes vs
  high-contrast). Foreground cyan + bold is universally legible.
- **Green for everything success-related (success status, accent for
  selection in completed runs, etc.)** — collides with the `✓` glyph and
  flattens the meaning of green. Rejected; one role per color.

## Tests

Unit (`tests/unit/hosts/two-pane/steps-view/steps-view.test.tsx`):

- Selected row renders the name with `color="cyan"` and `bold`; unselected
  rows do not.
- Selection cursor renders with `color="cyan"`; the space placeholder for
  unselected rows has no color prop.
- Glyph color matches status: green for completed, red for failed, yellow
  for running, dim for pending.
- The two hairlines render (one above and one below the steps grid) when
  `state.steps.length > 0`.
- When `state.steps.length === 0`, the empty-state `(no steps yet)` text
  renders WITHOUT the surrounding hairlines (no empty box).
- Banner renders above the upper hairline, not inside the bordered block.
- `EndOfRunSummary` status label is green for `completed`, red for
  `failed` and `crashed`.

Existing snapshot / output-text assertions should be audited: any test
that asserts the exact joined row string will need to be relaxed to assert
on the React tree (props on `<Text>`) instead of the flat string.

No integration or e2e changes — this is pure rendering polish.

## Open questions for ce-plan

- **Hairline implementation shape.** Ink supports `borderTop` / `borderBottom`
  on a `<Box>` but the precedence rules under flex column layout are worth
  a quick spike before committing. The fallback is a `<Text dimColor>` line
  of `─` characters sized to `process.stdout.columns`; works but slightly
  uglier and not resize-reactive without an extra hook.
- **`stepGlyph` shape change.** Extend the existing helper to return
  `{ char, color }` vs. add a sibling `glyphColor()` — pick one based on
  how many other call sites consume `stepGlyph` today. (Quick grep at plan
  time.)
- **`NO_COLOR` posture.** Ink already no-ops `color=` when `NO_COLOR=1`;
  confirm the bold prop also degrades, and confirm the hairlines (which
  are box-drawing characters, not ANSI) survive without color.

## Success criteria

- Side-by-side before/after screenshots show clear hierarchy improvement
  and unmistakable selection state.
- `bun run check` green.
- A user landing on the post-run view can name the selected step within
  one second without moving the cursor.
- No regression in narrow terminals (< 70 cols) — same rows visible, same
  columns dropped per `adaptive-columns.ts`.
