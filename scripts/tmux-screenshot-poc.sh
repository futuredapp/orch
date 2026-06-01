#!/usr/bin/env bash
#
# tmux-screenshot-poc.sh — Proof of concept for "screenshotting" a hidden tmux pane.
#
# Goal: validate the building block for stale-session detection.
#   1. Launch a coding agent (codex / claude) in a DETACHED (hidden) tmux pane.
#   2. Wait N seconds for its TUI to render.
#   3. Capture the pane and save it three ways:
#        - <ts>.txt   plain text (ANSI stripped)          -> cheapest LLM input
#        - <ts>.ansi  text WITH SGR color escape codes    -> feeds the PNG renderer
#        - <ts>.png   rendered image via `freeze`          -> vision-model input
#
# Why this works: `tmux capture-pane` returns the ALREADY-EMULATED grid. tmux is the
# terminal emulator, so it has already resolved every cursor-movement / alternate-screen
# sequence. The `-e` flag re-emits only SGR color codes around that clean grid. That is
# exactly the input `freeze` handles well — none of the "cursor codes corrupt the image"
# problems that hit you when piping a program's RAW byte stream into a renderer.
#
# Usage:
#   scripts/tmux-screenshot-poc.sh [agent-command] [wait-seconds] [text-to-send]
#
# Examples:
#   scripts/tmux-screenshot-poc.sh                       # codex, 15s   (defaults)
#   scripts/tmux-screenshot-poc.sh claude 20             # claude, 20s
#   scripts/tmux-screenshot-poc.sh "htop" 5              # any TUI, for a quick smoke test
#   scripts/tmux-screenshot-poc.sh codex 15 "2"          # then type "2" + Enter (skip update)
#   scripts/tmux-screenshot-poc.sh claude 18 "what is 2+2? reply in one word"
#   SEND="hello" SEND_ENTER=0 scripts/tmux-screenshot-poc.sh claude   # type without submitting
#
# When text-to-send is given the script captures TWICE — once before the input
# (pane-<ts>-before.*) and once after (pane-<ts>-after.*) — so you can see the
# transition the simulated keystrokes caused.
#
set -euo pipefail

# --- config -----------------------------------------------------------------
AGENT_CMD="${1:-codex}"
WAIT_SECS="${2:-15}"

# Simulated user input (optional). 3rd positional arg OR the SEND env var.
#   SEND="text"        type this into the pane after the first capture
#   SEND_ENTER=1       (default) press Enter after typing; 0 = type only, don't submit
#   SEND_WAIT=8        seconds to wait after sending before the second capture
#   SEND_KEY_DELAY=0.3 pause between typing the text and pressing Enter (lets the TUI register it)
SEND="${3:-${SEND:-}}"
SEND_ENTER="${SEND_ENTER:-1}"
SEND_WAIT="${SEND_WAIT:-8}"
SEND_KEY_DELAY="${SEND_KEY_DELAY:-0.3}"

# Analysis: feed the capture to an LLM and classify the pane state.
#   ANALYZE=1  (default) run both text + image analysis
#   ANALYZE=0           capture only, no LLM calls
#   ANALYZER=claude     which CLI judges the capture (uses its -p print mode)
ANALYZE="${ANALYZE:-1}"
ANALYZER="${ANALYZER:-claude}"

# Isolated tmux socket so we never touch the user's real tmux server.
SOCKET="orch-shot"
SESSION="poc-$$"

# Pane geometry. Fidelity depends on this matching what the TUI thinks it has.
COLS="${COLS:-200}"
ROWS="${ROWS:-50}"

OUT_DIR="${OUT_DIR:-$(pwd)/tmp/screenshots}"
TS="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$OUT_DIR"

# --- preflight --------------------------------------------------------------
command -v tmux >/dev/null   || { echo "ERROR: tmux not found" >&2; exit 1; }
HAVE_FREEZE=1
command -v freeze >/dev/null || { echo "WARN: 'freeze' not found — will skip PNG render (text capture still runs)." >&2; HAVE_FREEZE=0; }

cleanup() {
  tmux -L "$SOCKET" kill-session -t "$SESSION" 2>/dev/null || true
}
trap cleanup EXIT

ANALYZE_PROMPT='You are a monitor watching a coding-agent terminal pane (Claude Code or Codex CLI).
Classify the CURRENT state as exactly one of: working, waiting_for_input, error, idle.
Respond as one line of compact JSON only: {"state":"...","reason":"...","suggested_action":"..."}'

# capture_and_analyze <label>
#   Captures the pane to pane-<ts>[-<label>].{txt,ansi,png}, renders the PNG, and runs
#   both the text and image LLM detections. Pass an empty label for a single-shot run.
capture_and_analyze() {
  local label="$1" suffix=""
  [ -n "$label" ] && suffix="-$label"
  local txt="$OUT_DIR/pane-$TS$suffix.txt"
  local ansi="$OUT_DIR/pane-$TS$suffix.ansi"
  local png="$OUT_DIR/pane-$TS$suffix.png"

  echo "==> Capturing pane${label:+ [$label]} -> $txt"
  tmux -L "$SOCKET" capture-pane -p    -t "$SESSION" > "$txt"   # ANSI stripped
  tmux -L "$SOCKET" capture-pane -p -e -t "$SESSION" > "$ansi"  # with SGR colors
  echo "    text capture: $(wc -l < "$txt" | tr -d ' ') lines, $(wc -c < "$txt" | tr -d ' ') bytes"

  if [ "$HAVE_FREEZE" = "1" ]; then
    if freeze "$ansi" --output "$png" 2>/tmp/freeze.err; then
      echo "    PNG written: $(wc -c < "$png" | tr -d ' ') bytes -> $png"
    else
      echo "    freeze failed:" >&2; cat /tmp/freeze.err >&2
    fi
  fi

  if [ "$ANALYZE" = "1" ] && command -v "$ANALYZER" >/dev/null; then
    echo "==> [text] analysis via '$ANALYZER -p'"
    echo "    $("$ANALYZER" -p "$ANALYZE_PROMPT" < "$txt" 2>/dev/null || echo '{"error":"text analysis call failed"}')"
    if [ "$HAVE_FREEZE" = "1" ] && [ -s "$png" ]; then
      echo "==> [image] analysis via '$ANALYZER -p' + Read tool"
      echo "    $("$ANALYZER" -p "Read the image at $png. $ANALYZE_PROMPT" --allowedTools "Read" 2>/dev/null || echo '{"error":"image analysis call failed"}')"
    fi
  elif [ "$ANALYZE" = "1" ]; then
    echo "WARN: analyzer '$ANALYZER' not found — skipping LLM analysis." >&2
  fi
}

# send_input <text>
#   Simulates a user typing <text> into the pane, then (by default) pressing Enter.
#   Uses `send-keys -l` so the text is sent LITERALLY — tmux won't interpret words like
#   "Enter" or punctuation as key names. The Enter key is a separate send-keys call.
send_input() {
  local text="$1"
  echo
  if [ "$SEND_ENTER" = "1" ]; then
    echo "==> Simulating user input: typing $(printf '%q' "$text") then pressing Enter"
  else
    echo "==> Simulating user input: typing $(printf '%q' "$text") (no Enter)"
  fi
  tmux -L "$SOCKET" send-keys -t "$SESSION" -l -- "$text"
  if [ "$SEND_ENTER" = "1" ]; then
    sleep "$SEND_KEY_DELAY"   # give the TUI a beat to register the text before submitting
    tmux -L "$SOCKET" send-keys -t "$SESSION" Enter
  fi
}

# --- 1. launch agent in a detached pane -------------------------------------
echo "==> Launching '$AGENT_CMD' in detached tmux session '$SESSION' (${COLS}x${ROWS}) on socket '$SOCKET'"
tmux -L "$SOCKET" new-session -d -s "$SESSION" -x "$COLS" -y "$ROWS" "$AGENT_CMD"

# Confirm the pane is alive.
if ! tmux -L "$SOCKET" has-session -t "$SESSION" 2>/dev/null; then
  echo "ERROR: session failed to start" >&2
  exit 1
fi

# --- 2. wait for the TUI to render ------------------------------------------
echo "==> Waiting ${WAIT_SECS}s for the TUI to paint..."
sleep "$WAIT_SECS"

# Did the process exit early? (e.g. crashed, or needs login)
PANE_DEAD="$(tmux -L "$SOCKET" list-panes -t "$SESSION" -F '#{pane_dead}' 2>/dev/null | head -1 || echo '?')"
echo "==> pane_dead=$PANE_DEAD  (1 = the launched command already exited)"

# Interactive-mode proof: this session runs the FULL interactive TUI (codex/claude with
# no args). Report how many clients are attached — 0 means it is completely hidden, yet
# capture still works because tmux renders every pane's virtual terminal server-side
# whether or not anyone is watching it.
CLIENTS="$(tmux -L "$SOCKET" list-clients -t "$SESSION" 2>/dev/null | wc -l | tr -d ' ')"
echo "==> attached clients=$CLIENTS  (0 = fully hidden interactive session; capture still works)"

# --- 3. capture (+ optionally simulate input, then re-capture) --------------
if [ -n "$SEND" ]; then
  # Two-shot: snapshot the state, type the input, wait, snapshot again.
  capture_and_analyze "before"
  send_input "$SEND"
  echo "==> Waiting ${SEND_WAIT}s for the TUI to react to the input..."
  sleep "$SEND_WAIT"
  capture_and_analyze "after"
else
  # Single-shot: just capture what's on screen now.
  capture_and_analyze ""
fi

echo
echo "Done. Artifacts in: $OUT_DIR"
ls -la "$OUT_DIR"/pane-"$TS"*.* 2>/dev/null || true
