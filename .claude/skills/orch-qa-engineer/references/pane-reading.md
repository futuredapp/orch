# Reading the panes

`qa steps` parses the left pane for you, but you should be able to read a raw
`shot left` too — the parser is best-effort, and a raw capture never lies.

## Layout of a `shot left`

```
orch · <workflow> · <runId>            ← header (chrome)
──────────────────────────────────────  ← separator (chrome)
  triage  ✓                            ← completed step
  ▼ deep-dive  …                       ← subworkflow boundary (enter)
▌ │ investigate  ⟳                     ← nested sub-step, selected (▌), active
──────────────────────────────────────  ← separator (chrome)
▶ live · ⏎ view step · q quit · ? help  ← footer keymap (chrome)
```

Header / separators / footer are **chrome** — `qa steps` filters them out.

## Status glyphs (`src/observability/status-pane.ts#stepGlyphView`)

| Glyph | Status | Meaning |
| --- | --- | --- |
| `·` | pending | not started |
| `◐` | running | autonomous step executing |
| `⟳` | interactive | interactive (puppet) step awaiting input — the fakes use this |
| `✓` | completed | finished OK |
| `✗` | failed | finished non-zero |
| `↺` | cached | resumed from cache |
| `▼` | subworkflow-enter | a `runWorkflow(...)` boundary row |

## Row anatomy

- **Step rows** render the glyph **last**, in its own 2-space-separated column:
  `name  ✓`. That 2-space gap is what distinguishes a status `·` from the
  middots in the header/footer.
- **Subworkflow boundary rows** render the glyph **first** with a single space:
  `▼ deep-dive`. The boundary's `✓`/`✗` on exit mirror its child's outcome.
- **Nesting** uses a `│`/`├`/`└` tree prefix. Each branch marker is one depth
  level — `qa steps` reports it as `depth` (parent steps are `depth: 0`, steps
  one subworkflow deep are `depth: 1`).
- **`▌`** in the gutter marks the cursor/selected row (keyboard navigation
  target), independent of run state.

## What "subworkflow launched" looks like

A `▼ <name>` boundary row appears, and the sub's steps render **indented under
it with a `│` prefix at `depth ≥ 1`**. `qa steps --json` surfaces this as
`hasSubworkflow: true` plus a `subworkflow-enter` entry. That is the assertion
for the canonical subworkflow scenario.

## Colors (read the PNG)

The glyphs above carry color the text capture drops: `◐` running is **yellow**,
`✓` completed is **green**, `✗` failed is **red**, pending/cached are **dim**, and
the active row + its `▌` cursor render **cyan/highlighted**. To verify any of
that — or a banner color, or general visual correctness — `qa shot` and **Read
the `.png`** (a `freeze`-rendered, color-accurate image). The text/`qa steps`
path tells you *which* steps and states exist; the PNG tells you whether they
*look* right.

## When the parser and the raw capture disagree

Trust the raw capture. The parser keys entirely on the glyph vocabulary and the
column/tree conventions above; an unusual row (a brand-new step kind, a very
narrow pane that reflows, a banner overlay) can slip past it. If `qa steps` looks
wrong, `shot left --raw` and read it yourself — and consider whether the
steps-view rendering changed (in which case update `examples/qa/steps.ts`).
