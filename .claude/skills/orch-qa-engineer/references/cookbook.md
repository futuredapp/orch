# QA Cookbook — worked scenarios

Exact commands and the pane output you should expect. All commands run from the
repo root with `--cwd examples`. These transcripts are real (captured from a live
run), so treat the expected output as ground truth.

## Scenario A — Verify a subworkflow launches (the canonical case)

Goal: confirm that finishing a parent step enters a subworkflow whose steps
appear nested in the left pane.

### 1. Launch detached (background shell)

```
cd examples && bun ../src/cli/main.ts run predictable-sub --mode=two-pane --no-attach
```

Run this in a **background** process so it stays alive while you drive it. Then:

```
bun examples/qa/qa.ts info --wait --cwd examples
```

Expected: JSON with `runId`, `socket` (`orch-<runId>`), `runDir`, and
`panes: { left, right }`.

### 2. Observe the starting state

```
bun examples/qa/qa.ts shot both --cwd examples
bun examples/qa/qa.ts awaiting --cwd examples      # → triage
bun examples/qa/qa.ts steps --cwd examples
```

Expected left pane: one step, `triage`, interactive/active. Say so out loud
before acting.

### 3. Drive the parent step that triggers the subworkflow

```
bun examples/qa/qa.ts send triage line "decision: go deep" --cwd examples
bun examples/qa/qa.ts send triage finish --cwd examples
```

### 4. Confirm the subworkflow launched

```
bun examples/qa/qa.ts awaiting --cwd examples      # → deep-dive>investigate, triage
bun examples/qa/qa.ts shot left --cwd examples
bun examples/qa/qa.ts steps --json --cwd examples
```

Expected left pane:

```
  triage  ✓
  ▼ deep-dive  …
▌ │ investigate  ⟳
```

Expected `steps --json` highlights: `hasSubworkflow: true`, an entry
`{name: "deep-dive", status: "subworkflow-enter"}`, and
`{name: "investigate", status: "interactive", depth: 1, active: true}`. **That
nested, depth-1 `investigate` under the `▼ deep-dive` boundary is the pass
signal** — the subworkflow visibly launched.

### 5. Drive the nested steps (addressed by namespaced key)

```
bun examples/qa/qa.ts send "deep-dive>investigate" line "found root cause" --cwd examples
bun examples/qa/qa.ts send "deep-dive>investigate" finish --cwd examples
bun examples/qa/qa.ts wait-ready "deep-dive>summarize" --cwd examples
bun examples/qa/qa.ts send "deep-dive>summarize" finish --cwd examples
bun examples/qa/qa.ts wait-ready report --cwd examples   # back in the parent
bun examples/qa/qa.ts send report finish --cwd examples
```

The run's stderr log should end with `Workflow "predictable-sub" completed.`

### 6. Tear down + verdict

```
bun examples/qa/qa.ts down --cwd examples
pgrep -fl 'scripted-fake/' | grep -v pgrep || echo "0 leaked — clean"
```

Then write the verdict report (screenshots are under
`<runDir>/qa-screenshots/`).

## Scenario B — Smoke-test a simple linear run (`predictable-tui`)

Three interactive steps (`plan → execute → report`), no subworkflow. Good for a
quick "does the steps list advance and do panes echo input" check.

```
cd examples && bun ../src/cli/main.ts run predictable-tui --mode=two-pane --no-attach
bun examples/qa/qa.ts info --wait --cwd examples
bun examples/qa/qa.ts shot both --cwd examples
bun examples/qa/qa.ts send plan line "draft: two passes" --cwd examples
bun examples/qa/qa.ts send plan finish --cwd examples
bun examples/qa/qa.ts wait-ready execute --cwd examples
bun examples/qa/qa.ts steps --cwd examples          # plan ✓, execute ⟳ ← active
# …drive execute, report the same way…
bun examples/qa/qa.ts down --cwd examples
```

## Scenario C — Simulate a human typing / debug a TUI interaction

Use the raw channel to exercise input and the steps-view keymap.

```
# Type into the right (agent) pane's Ink input and confirm it echoes:
bun examples/qa/qa.ts keys right "typed-by-hand" --cwd examples
bun examples/qa/qa.ts shot right --cwd examples     # expect: ❯ typed-by-hand

# Click the left pane, then scroll its steps view:
bun examples/qa/qa.ts focus left --cwd examples
bun examples/qa/qa.ts keys left "Down" "Down" "PageDown" --cwd examples
bun examples/qa/qa.ts shot left --raw --cwd examples  # --raw keeps color/glyphs
```

Named keys (`Enter`, `Up`, `Down`, `Left`, `Right`, `Escape`, `Tab`, `BTab`,
`BSpace`, `Space`, `PageUp`, `PageDown`, `Home`, `End`) are sent as real
keystrokes; anything else is sent literally.

## Color / visual checkpoints

When a checkpoint is about color or layout (spinner is yellow, failure is red,
active row is highlighted, a banner's color, general "does this look right"),
`shot` it and **Read the PNG** — it renders color the text capture can't show:

```
bun examples/qa/qa.ts shot both --cwd examples
# → writes 00N-left.png, 00N-right.png, 00N-both.png (stacked) under qa-screenshots/
# then Read the .png you care about; e.g. the stacked overview:
#   Read <runDir>/qa-screenshots/00N-both.png
```

`shot` always writes the `.txt` (cheap structural read) and, when `freeze` is
installed, the `.ansi` source and the `.png`. Cite the `.png` in your verdict for
color/layout findings and the `.txt` for structural ones.

## Tips

- **Quote keys containing `>`** in the shell: `send "deep-dive>investigate" …`.
- After any step finishes, `awaiting` tells you what's drivable next — cheaper
  and more reliable than guessing keys.
- If a `send` times out waiting for an ack, the step probably isn't ready yet —
  `wait-ready <step>` first, or re-check `awaiting`.
- Screenshots auto-increment (`001-`, `002-`, …) per run, so they form an ordered
  filmstrip you can cite in the report.
