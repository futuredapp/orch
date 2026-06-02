---
title: "Screenshotting & text extraction from a hidden tmux pane (real-run findings)"
type: findings
status: validated
date: 2026-06-01
session: error-handling
artifact: scripts/tmux-screenshot-poc.sh
related:
  - src/services/tmux/real-tmux-service.ts
  - tests/helpers/real-tmux/pane-handle.ts
  - tests/helpers/real-tmux/ansi.ts
---

# Screenshotting & text extraction from a hidden tmux pane

> **One-line result:** capturing a detached/hidden interactive tmux pane as both **text** and a **PNG**, then classifying its state with an LLM, works end-to-end on macOS — validated against live `codex` and `claude` sessions. The plumbing is solid; the only open work is the *classification taxonomy* and the *staleness trigger*.

## Why we looked into this

Goal: detect that a coding-agent session (Claude Code / Codex) has gone **stale or stuck** when no error hook fires — Codex in particular does not fire an error hook on some blocked states. The intended loop:

```
if stale_for_more_than(pane, 10min):
    capture(pane)                       # text and/or screenshot
    verdict = analyze(capture)          # LLM classifies the state
    if verdict.is_error or verdict.is_waiting_for_input:
        send_keys(pane, "<remediation>")  # e.g. "try again", or dismiss a prompt
```

This session validated the two hard parts: **can we capture a hidden interactive pane**, and **can an LLM reliably tell us what state it's in**.

## The key technical insight

A tmux pane is **text, not pixels**. "Screenshot" therefore splits into two paths:

1. **Text capture** — `tmux capture-pane -p` (ANSI stripped) or `-p -e` (with SGR color codes). Trivial, cheap, and often the better LLM input.
2. **PNG render** — feed the captured ANSI to a terminal-text→image renderer.

External research warned that renderers like `freeze`/`termshot`/`textimg` only parse SGR color codes and **drop cursor-movement sequences**, so they corrupt fullscreen TUIs that use the alternate screen buffer. **That concern does not apply to our path**, and this is the crux:

> `tmux capture-pane -e` returns the **already-emulated grid**. tmux *is* the terminal emulator — it has already resolved every cursor move / alternate-screen / erase sequence and hands back clean lines with only SGR color codes wrapped around them.

So piping `capture-pane` output into `freeze` is clean. The heavyweight `pyte`/Pillow terminal-emulation pipeline is only needed when you feed a program's **raw byte stream** to a renderer — which we never do. This collapses the design to:

```
detached tmux session  →  tmux capture-pane -ep  →  freeze  →  .png
```

A second consequence, equally important for the use case:

> tmux keeps a **live virtual terminal for every pane and renders it server-side whether or not a client is attached.**

That is why capture works on a *detached* (hidden) session with `attached clients=0`. A background monitor screenshots an interactive agent identically to one a human is actively watching; multiple clients can read the same server-side grid.

## Environment (as found)

| Tool | Status |
|------|--------|
| `tmux` | 3.6a ✅ |
| `node` / `bun` | v22.7.0 / 1.3.8 ✅ |
| `claude` | installed ✅ (used as the analysis LLM via `claude -p`) |
| `codex` | installed ✅ |
| `freeze` (charmbracelet) | **not present initially** — installed via `brew install charmbracelet/tap/freeze` (v0.2.2, ~14 MB single Go binary, fully headless, no display server) |
| `aha` / `termshot` / `imagemagick` / `wkhtmltoimage` / `playwright` | not installed (not needed) |

No native ANSI→PNG tool ships with macOS; `freeze` is the lowest-dependency option and the only install required.

## What was built

`scripts/tmux-screenshot-poc.sh` — a standalone proof of concept:

1. Launches an agent (`codex` / `claude` / any TUI) in a **detached** tmux session on an isolated socket (`-L orch-shot`), with explicit geometry (default 200×50).
2. Waits N seconds for the TUI to paint.
3. Reports `pane_dead` and `attached clients` (the hidden-interactive indicator).
4. Captures three artifacts: `.txt` (ANSI stripped), `.ansi` (with SGR color), `.png` (freeze render).
5. Runs **two independent detections** via `claude -p`:
   - **text** — pipes the `.txt` capture straight to the model (~5 s).
   - **image** — points the model at the `.png` via its `Read` tool with `--allowedTools Read` (~10 s; no permission prompt).
6. **Simulates user input** (added in a second pass): with a `SEND` text it captures `*-before.*`, types the text with `send-keys -l` (literal — tmux won't misread punctuation/key-names), pauses `SEND_KEY_DELAY`, presses Enter (`SEND_ENTER=0` to skip), waits `SEND_WAIT`, then captures `*-after.*`. Both snapshots get the full text+image analysis.

Usage:

```bash
./scripts/tmux-screenshot-poc.sh                       # codex, 15s, capture+analyze
./scripts/tmux-screenshot-poc.sh claude 20             # claude, 20s
./scripts/tmux-screenshot-poc.sh codex 15 "2"          # then type "2" + Enter (skip update)
./scripts/tmux-screenshot-poc.sh claude 18 "what is 2+2? reply in one word"
SEND="hello" SEND_ENTER=0 ./scripts/tmux-screenshot-poc.sh claude   # type without submitting
ANALYZE=0 ./scripts/tmux-screenshot-poc.sh codex       # capture only, no LLM calls
```

## Real-run results

All runs used a **fully hidden** session (`attached clients=0`).

### Capture + render fidelity

- `top` (smoke test): pixel-perfect, fully legible PNG with colors.
- `codex`: rendered its live *"Update available! 0.133.0 → 0.135.0 … Press enter to continue"* prompt, and (after input) its main composer with box-drawing borders, model line, and status bar — all SGR colors and Unicode box characters survived.
- `claude`: rendered the interactive composer (header, placeholder suggestion, git/status line) at 200-col width.

### Detection accuracy (text vs image)

| Run | Screen | text verdict | image verdict |
|-----|--------|--------------|---------------|
| `codex` | update prompt | `waiting_for_input` ✅ | `waiting_for_input` ✅ |
| `codex` after `2`+Enter | main composer | `idle` | `idle` |
| `claude` | idle composer | `waiting_for_input` ⚠️ | `idle` |

Both detectors returned well-formed JSON (`{state, reason, suggested_action}`) and agreed on the clear cases. The `codex` update prompt is the exact target scenario — silently blocked, no error hook — and both detectors caught it and suggested "send 2 / Enter."

### Input simulation (before → after)

`codex 15 "2"` drove the full loop on a live hidden session: detected `waiting_for_input` at the update gate → typed `2` + Enter via `send-keys` → re-captured and detected `idle` at the composer. This is the `detect → send-keys → re-detect` remediation loop, demonstrated against a real interactive TUI.

## Findings & caveats (carry into productization)

1. **Classification taxonomy is the real work, not the plumbing.** The `claude` idle screen split the verdicts (`waiting_for_input` vs `idle`). For remediation this distinction is load-bearing:
   - `idle` / `done` = legitimately finished, waiting for a human → **do not poke it.**
   - `waiting_for_input` on a prompt/dialog/menu = blocked, needs a keypress → **send keys.**
   - `error` = something broke → **send "try again".**
   A detector that conflates `idle` and blocked will spam sessions that are quietly done. The classifier prompt must force this three-way split explicitly.

2. **Placeholder/ghost text fools the classifier.** In the `codex` after-shot the model read the ghosted composer suggestion (*"Explain this codebase"*) as *"text typed but not submitted."* Tell the classifier to **ignore placeholder/suggestion hints** and key off concrete signals: a visible menu / `> 1.` / "Press enter", an error string, a real cursor in entered text, or a spinner that has not moved between two captures.

3. **Lead with text, escalate to image.** Text analysis is ~2× faster and far cheaper, and matched the image verdict on the clear cases. Use the PNG only when the text capture is ambiguous (heavy box-drawing layout, spinners, color-encoded state). A cheap-then-expensive ladder.

4. **Staleness = diff two captures.** "No change in `capture-pane` output for 10 min ⇒ stale" is the trigger. It's a thin layer over the existing `capturePane` plumbing — no new subprocess work.

5. **PNG size scales with pane geometry.** freeze renders the full pane: a sparse 200×50 screen ≈ 380 KB; a dense one (e.g. `top`) ≈ 7 MB. For production, match geometry to the agent's real pane or pass freeze `--scale` / `--font.size` to keep files small.

6. **Operational gotcha:** do **not** pipe `capture-pane` into `head` under `set -e` — SIGPIPE aborts the script. The POC avoids this; remember it when wiring the poller.

## How this maps onto the existing codebase

The repo already has the hard parts behind the `ProcessService` / `RealTmuxService` seam — no new subprocess plumbing is needed:

- `src/services/tmux/real-tmux-service.ts` — `capturePane({ socket, target, escapeCodes, joinWrapped })` already wraps `tmux capture-pane` with the `-e` / `-J` flags. A `screenshotPane()` is `capturePane(escapeCodes: true)` piped to `freeze` (the only new dependency, behind a `ProcessService` call).
- `tests/helpers/real-tmux/pane-handle.ts` — already polls `capture()` on a 50 ms loop with timeout; a "no diff for N minutes ⇒ stale" check sits directly on top.
- `tests/helpers/real-tmux/ansi.ts` — existing `stripAnsi()` for the text path.

## Suggested next steps

1. Add `screenshotPane()` to `RealTmuxService` (capture → freeze via `ProcessService`), with a fake in the test harness.
2. Add a staleness poller: diff successive captures; trigger on no-change ≥ threshold.
3. Build the state classifier with the explicit **idle-done vs blocked-on-input vs error** taxonomy and the placeholder-ignoring rules above.
4. Wire remediation via the existing `send-keys` path.

All landed behind `bun run check`, with the three-layer testing strategy (fakes at the `*Service` edge only).
