---
date: 2026-05-05
topic: tmux-strict-appliance-mode
---

# Tmux Strict Appliance Mode (Two-Pane)

## What We're Building

A locked-down tmux configuration for the two-pane host so that user mouse and keyboard interactions can never derail an in-flight orch run. The current session inherits tmux's full default key bindings and `mouse on` semantics; the visible bug is that mouse-wheel scrolling on the right pane enters copy-mode, freezes the visible output, and produces stray `tmux send-keys failed (exit 1): not in a mode` errors mid-transcript.

The reframe matters: in this app, tmux is **not the product** — it is the renderer / PTY host. Two-pane should be an appliance the user attaches to, not a tmux session they live inside. Hidden tmux state is a category of bug we should structurally eliminate, not document around.

The change replaces inherited defaults with an explicit allowlist (drag-to-resize, click-to-focus, keyboard pane switch, native terminal text selection). To make the loss of "scroll up to see history" land cleanly, the same change adds first-class log commands (`orch logs --latest --follow`, `orch logs <runId> --step <name>`) and points the startup banner at them.

## Why This Approach

The seams already make this small. Sessions are created with `tmux -f /dev/null` (`src/services/tmux/real-tmux-service.ts:79`), so no user `~/.tmux.conf` is in play — every binding inside the orch session is set by `initOrchSession` (`src/services/tmux/session-init.ts:43`). Today that helper sets `remain-on-exit on`, `mouse on`, and the `pane-died` hook. Adding a flush-then-allowlist phase in the same place is a focused diff with a clear reverse.

**On the failure mode (corrected).** `send-keys -l` (literal text writes — what orch's transcript fan-out and status-loop use) exits 0 even when the target pane is in copy-mode; the bytes simply don't show because the visible surface is frozen. The `not in a mode` error fires from `send-keys -X` invoked outside copy-mode, which is exactly what tmux's *default* mouse/copy-mode bindings emit when the user wheel-scrolls into and back out of copy-mode ([tmux/tmux#638](https://github.com/tmux/tmux/issues/638)). So the user-visible symptom is two-headed: tmux's default bindings produce hidden mode transitions and emit `not in a mode` into the visible stream, while orch's writers keep streaming successfully into a pane whose surface is frozen or misleading. Killing the offending default bindings fixes both.

Three lines of upstream evidence make the strict-allowlist shape the right one:

1. The `not in a mode` regression is recognized upstream and unfixed ([tmux/tmux#638](https://github.com/tmux/tmux/issues/638), [#3705](https://github.com/tmux/tmux/issues/3705)).
2. **No vendor (Anthropic, OpenAI, Aider, Cursor, …) ships a tmux config for embedding their CLI as a programmatic substrate.** The neighboring tools that drive tmux (`codex-yolo`, TmuxAI, claude-code-tools) use it as a user shell, not as an appliance. We are establishing the convention; it should be conservative.
3. `set -g history-limit 0` removes the data copy-mode would scroll over. Our real history lives in `.orch/state/<runId>/logs/` (per `docs/logging.md`) — unbounded, greppable, durable. tmux's bounded buffer is strictly worse for our use case.

Alternatives considered and rejected:
- **Surgical disable** (rebind only `WheelUpPane`/`WheelDownPane`): smaller diff, but leaves prefix-table and copy-mode-table bindings live. Future tmux releases or default-binding changes could reintroduce the same class of bug.
- **Disable mouse entirely**: loses drag-to-resize, which the user explicitly wants to keep.
- **User config knob** (`tmux: { copyMode: 'enabled' }` in `orch.config.ts`): no caller has asked for it, and re-enabling wheel-into-copy-mode reintroduces the bug. Defer until someone asks.
- **Smart wheel forwarding** (`if -F "#{mouse_any_flag}" "send-keys -M" ""`): elegant in principle. But Claude Code's wheel handling inside tmux is broken upstream ([anthropics/claude-code#38810](https://github.com/anthropics/claude-code/issues/38810)) and Codex's wheel only works inside its own `Ctrl+T` pager. The complexity buys us nothing today; revisit if/when both fix wheel-in-tmux.

## Key Decisions

### Tmux configuration

- **Strict allowlist, not surgical disable.** Wipe every key binding in `prefix`, `root`, `copy-mode`, and `copy-mode-vi` tables (`unbind-key -a -T <table>`), then re-bind only the four interactions on the allowlist. Set `prefix None` so `C-b` is inert.
- **The allowlist is exactly four items:**
  1. **Drag pane border to resize** — `bind -T root MouseDrag1Border resize-pane -M`.
  2. **Click pane to focus** — `bind -T root MouseDown1Pane select-pane -t=`.
  3. **Keyboard pane switch** — `bind -n M-Left select-pane -L` and `bind -n M-Right select-pane -R`. One pair only (we have two panes; one direction concept). `M-Left/Right` chosen to avoid collisions with bash readline word-jump (`M-f`/`M-b`), Claude Code's documented Option shortcuts, and Codex's bindings.
  4. **Native terminal text selection** — preserved by not touching the host terminal's behavior. Users hold Shift (or Option on macOS) to bypass tmux mouse capture and use their terminal's own selection. No tmux config required; flagged here so the implementation explicitly verifies it still works.
- **Wheel events are nuked, not forwarded.** `unbind -T root WheelUpPane`, `WheelDownPane`, `WheelUpStatus`, `WheelDownStatus`. Wheel does nothing in any pane, in any process state.
- **`history-limit 0` as belt-and-suspenders.** Even if a future change re-introduces a path into copy-mode, there is nothing to render. Real history is in `.orch/state/<runId>/logs/`.
- **Preserve the agent-friendly defaults we already rely on.** `default-terminal "tmux-256color"`, `terminal-features 'xterm*:extkeys'`, `extended-keys on`, `allow-passthrough on` — these remain (Anthropic's recommended set for Claude Code in tmux). The `pane-died` hook lives in a separate namespace from key bindings; `unbind-key -a` does not affect hooks.

### Detach story

- **orch owns the terminal until the run completes.** With `prefix None`, the default `C-b d` detach goes away by design. The run ends in one of three ways — clean completion, agent failure, user SIGINT to orch — and orch tears down cleanly in all three. No mid-run detach, no `orch attach <runId>` re-entry surface in v1. This is what "appliance" means and is explicit, not an accidental side effect of nuking the prefix.
- **Document this in `docs/getting-started.md`.** The mental model "you don't `C-b d` out of orch; you let it finish or interrupt" is the load-bearing user-facing change.

### Replacement scrollback affordance

- **First-class `orch logs` commands ship in the same change.** The strict sandbox removes scroll-to-history; we replace it with a fast, obvious alternative.
  - `orch logs --latest --follow` — `tail -F` on the latest run's per-step transcript. Default for "I just want to see what's happening."
  - `orch logs <runId> --step <name>` — print a specific step's transcript. Default no-follow.
  - `orch logs --latest` (no `--follow`) — print the latest run's full transcript and exit.
- **Banner update.** The startup banner gets a one-line hint pointing at `orch logs --latest --follow` (and the on-disk path for power users).
- **Detailed surface (flags, output format, exit codes) lives in the plan.** This brainstorm captures only that the commands exist and their headline shape.

### TmuxService API

- **Make the binding surface first-class.** Add explicit `unbindKey`, `bindKey`, and `setWindowOption` methods to `TmuxService`. No generic "run arbitrary tmux command" escape hatch — that abstraction leak is exactly what we'd be cleaning up if it existed.
- **Argv ordering and option semantics live in the plan.** This brainstorm captures only the shape: typed options for tables, key sequences, target pane/window, and global flag.

### Tests

- **Two layers, both required.**
  - **Fake-service tests** prove command shape and ordering — that `mouse on` is set before mouse bindings, that all four `unbind-key -a -T <table>` calls are issued, that prefix is set to `None`, that the four allowlist binds happen.
  - **Real-tmux integration tests** prove the configuration takes effect: `list-keys -T root` shows wheel bindings absent and only the four allowlist items present, `MouseDrag1Border` is bound to `resize-pane -M`, `prefix` is `None`, `pane-died` hook still fires (existing two-pane integration tests cover this), and **actual `capture-pane` output for both initial and split panes shows zero scrollback** — `show-options` alone is insufficient because the initial (left) pane exists before post-create options run and may inherit a non-zero buffer.

## Resolved Questions

- ~~**How strict should the default sandbox be?**~~ → Strict allowlist. Wipe all four tables, set `prefix None`, re-bind only the four allowlist items.
- ~~**What's in the allowlist?**~~ → Drag-to-resize, click-to-focus, keyboard pane switch (`M-Left/Right`), native text selection (Shift/Option-drag, untouched).
- ~~**Wheel: nuke or forward?**~~ → Nuke. Revisit if upstream agents fix wheel-in-tmux.
- ~~**Scrollback escape hatch in tmux?**~~ → None. Replaced by `orch logs` commands.
- ~~**`prefix None` vs `prefix F12`?**~~ → `None`. Cleanest expression of intent; supported by tmux 3.1+, comfortably below our floor.
- ~~**Banner/hint copy.**~~ → Add a one-liner pointing at `orch logs --latest --follow`.
- ~~**Test coverage.**~~ → Both layers: fake-service for command shape; real-tmux for `list-keys`, captured history, pane-died, drag/click bindings.
- ~~**Detach story.**~~ → orch owns the terminal until completion. No mid-run detach in v1.
- ~~**`orch logs` UX in scope?**~~ → Yes, ships with this change.
- ~~**Codex `--no-alt-screen` in scope?**~~ → No. Split out — needs `RunMode` (or host kind) threaded into `RunnerContext`, which is a Runner-port change with broader implications. Will be its own brainstorm.

## Open Questions

These are plan-detail, captured so they aren't lost in the planning step:

- **Exact ordering of `mouse on` and `unbind-key -a -T root`.** `mouse on` must be set before mouse bindings; `unbind-key -a -T root` wipes them; the four `bind -T root` calls re-establish what we want. Order in the implementation: option → unbind → bind. Verify against tmux 3.3+ on a quick smoke test.
- **`TmuxService` API shape.** Method signatures (`bindKey({ socket, table, key, command, root? })` etc.), argument validation (no shell metacharacters in `command`), error mapping. Sketch in planning.
- **`history-limit 0` verification surface.** What's the cheapest way to assert "left pane has zero scrollback after init"? Options: `capture-pane -p` and assert empty after a known no-op, or `display-message -p '#{history_size}'`. Decide in planning.
- **`orch logs` command details.** Argv shape, default formatting (color on TTY only), `--step` matching (exact name? prefix? regex?), behavior when no runs exist, how `--latest` handles concurrent in-flight runs. Full spec in planning.
- **Banner copy exact wording.** "for live progress: `orch logs --latest --follow`" vs longer hints. Plan picks; brainstorm only commits to *some* hint existing.
- **Keyboard pane switch on Windows.** `M-Left/Right` is intercepted by Windows Terminal / Tabby upstream of tmux ([microsoft/terminal#4763](https://github.com/microsoft/terminal/issues/4763)). orch is currently macOS/Linux-focused, but worth a `docs/getting-started.md` note.

## Follow-ups (Out of Scope)

- **Codex `--no-alt-screen` for two-pane mode.** Threading `RunMode` (or host kind) through `RunnerContext` so `CodexRunner` can opt into `--no-alt-screen` only under two-pane is its own design decision — it changes the Runner port surface. Track in a separate brainstorm. PR [openai/codex#8555](https://github.com/openai/codex/pull/8555) is the upstream reference.
- **Mid-run detach + `orch attach <runId>` re-entry.** If users ask for the ability to step away and rejoin, design that as a deliberate feature (one explicit binding, a re-attach CLI, a detach-aware lifecycle). Not v1.
- **Smart wheel forwarding.** Revisit if/when Claude Code and Codex ship usable wheel-in-tmux behavior; until then, the no-op binding is correct.

## Example Behavior

Before (today):
```
User scrolls on right pane → tmux's default WheelUpPane binding fires send-keys -X
                              → enters copy-mode, freezes visible output
User presses Space          → enters selection mode (still in copy-mode)
User presses any letter     → triggers some copy-mode command (jump-to-forward, …)
Default bindings emit `not in a mode` errors into the visible stream
orch's send-keys -l writes  → still exit 0, bytes buffered, surface frozen
```

After:
```
User scrolls on right pane  → wheel binding is gone → nothing happens, output keeps streaming
User presses C-b            → prefix is None → C-b reaches the running shell/agent unmodified
User drags the divider      → resize-pane fires → panes resize
User clicks the left pane   → select-pane fires → focus moves to left pane
User presses M-Right        → focus moves to right pane
User wants live progress    → `orch logs --latest --follow` in another tab
User wants past output      → `orch logs <runId> --step <name>`
```

## Sources

- [anthropics/claude-code#38810](https://github.com/anthropics/claude-code/issues/38810) — wheel-in-tmux broken upstream
- [openai/codex#8555](https://github.com/openai/codex/pull/8555) — `--no-alt-screen` flag (referenced for the follow-up brainstorm)
- [tmux/tmux#638](https://github.com/tmux/tmux/issues/638) — `not in a mode` regression (default mouse bindings emit `send-keys -X` outside copy-mode)
- [tmux/tmux#3705](https://github.com/tmux/tmux/issues/3705) — disable copy-mode-on-wheel under alt-screen
- [tmux/tmux#729](https://github.com/tmux/tmux/issues/729) — canonical reset-bindings pattern
- [Anthropic terminal-config](https://code.claude.com/docs/en/terminal-config) — `extended-keys`, `allow-passthrough`, `terminal-features`
- `src/services/tmux/session-init.ts:43` — current `initOrchSession` (where the allowlist lands)
- `src/services/tmux/real-tmux-service.ts:79` — `-f /dev/null` (why we own the binding table)
- Local probes against tmux 3.6a — `send-keys -l` exits 0 in copy-mode; `not in a mode` is a `send-keys -X` failure
