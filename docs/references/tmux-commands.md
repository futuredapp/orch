# Tmux Command Reference for TmuxService

Every `TmuxService` method maps to one or more tmux CLI commands. This document specifies the exact flags, their purpose, and gotchas. All commands target a dedicated socket (`-L orch`) and suppress user config (`-f /dev/null`).

## Socket isolation (`-L`)

Every command includes `-L <socket>`:
- **Production:** `-L orch`
- **Tests:** `-L orch-test-<id>` (unique per test for parallel execution)

Sockets are at `$TMPDIR/tmux-$UID/<socket>`. Each `-L` name creates a fully independent tmux server. Concurrent tests on different sockets never interfere.

## Config suppression (`-f /dev/null`)

Pass `-f /dev/null` on `new-session` to prevent loading `~/.tmux.conf`. Essential for predictable behavior in production and tests.

---

## Commands

### new-session (createSession)

```
tmux -L <socket> -f /dev/null new-session -d -s <name> -x <width> -y <height> -P -F '#{pane_id}' [command]
```

| Flag | Purpose |
|---|---|
| `-d` | Detached — do not attach. **Always use in programmatic mode.** |
| `-s <name>` | Session name for targeting. Use `orch-<runId>`. |
| `-x <w>` / `-y <h>` | Initial window size. Only effective with `-d`. |
| `-P -F '#{pane_id}'` | Print the initial pane's ID (e.g., `%0`) to stdout. |
| `[command]` | Shell command for the initial pane. Goes at end. |

### split-window (splitPane)

```
tmux -L <socket> split-window [-h] [-d] -t <target> [-l <N>%] -P -F '#{pane_id}' [command]
```

| Flag | Purpose |
|---|---|
| `-h` | Horizontal split = side-by-side panes (vertical divider). Omit for stacked. |
| `-d` | Don't change active pane. |
| `-t <target>` | Pane to split. |
| `-l <N>%` | New pane size as percentage. |
| `-P -F '#{pane_id}'` | Print new pane's ID to stdout. |

**Terminology warning:** `-h` (horizontal) creates panes *side by side*, `-v` creates them *stacked*. Counter-intuitive.

### send-keys (sendKeys)

```
tmux -L <socket> send-keys -t <target> -l '<text>'
tmux -L <socket> send-keys -t <target> Enter
```

| Flag | Purpose |
|---|---|
| `-t <target>` | Target pane (PaneId or session:window.pane). |
| `-l` | Literal mode — no key name interpretation. **Always use for user text.** |
| `Enter` / `C-m` | Key name for Enter (sent WITHOUT `-l`). |

**Pattern:** Send text with `-l`, then send Enter separately without `-l`.

### capture-pane (capturePane)

```
tmux -L <socket> capture-pane -t <target> -p [-S - -E -]
```

| Flag | Purpose |
|---|---|
| `-p` | Print to stdout (not tmux paste buffer). **Always use.** |
| `-S -` | From start of scrollback history. |
| `-E -` | To end of visible area. |

Returns clean text — no ANSI escapes. Use for assertions.

### wait-for (waitFor / signalChannel)

```
tmux -L <socket> wait-for <channel>       # blocks until signaled
tmux -L <socket> wait-for -S <channel>    # signals (unblocks waiters)
tmux -L <socket> wait-for -L <channel>    # mutex lock
tmux -L <socket> wait-for -U <channel>    # mutex unlock
```

Channel names are arbitrary strings, scoped to the socket. This is the synchronization primitive — **never use `sleep()` when `wait-for` is available.**

### set-option (setOption)

```
tmux -L <socket> set-option [-g|-w|-p] -t <target> <option> <value>
```

| Scope flag | Meaning |
|---|---|
| (none) | Session option |
| `-g` | Global default |
| `-w` | Window option |
| `-p` | Pane option |

**Key options:**
- `remain-on-exit on` — pane stays after process exits (becomes "dead"). Required for `pane-died` hook.
- `remain-on-exit failed` — stays only if exit code != 0.

### set-hook (setHook)

```
tmux -L <socket> set-hook [-g] [-t <target>] <hook-name> 'run-shell "<command>"'
```

| Hook | When | Condition |
|---|---|---|
| `pane-died` | Process exits | Only with `remain-on-exit on` |
| `pane-exited` | Process exits | Only with `remain-on-exit off` |
| `after-split-window` | After split | Always |

**`pane-died` and `pane-exited` are mutually exclusive** based on `remain-on-exit`.

**Race condition:** Set hooks BEFORE spawning the pane. A fast-exiting command can die before hook registration.

**Format variables in hooks:** `#{hook_pane}` resolves to the pane that triggered the event. May be numeric only (e.g., `1`) rather than `%1` — test your naming scheme.

### display-message (displayMessage)

```
tmux -L <socket> display-message -p -t <target> '<format>'
```

Prints format variables to stdout. Key variables:

| Variable | Type | Description |
|---|---|---|
| `#{pane_id}` | string | Unique ID (`%0`, `%1`, ...) |
| `#{pane_dead}` | 0/1 | 1 if process exited (with remain-on-exit) |
| `#{pane_dead_status}` | number | Exit code of dead process |
| `#{pane_pid}` | number | PID of pane's process |
| `#{pane_dead_signal}` | string | Kill signal (empty if normal exit) |
| `#{session_name}` | string | Session name |

### pipe-pane (pipePane)

```
tmux -L <socket> pipe-pane -O -t <target> '<command>'   # start
tmux -L <socket> pipe-pane -t <target>                   # stop
```

| Flag | Purpose |
|---|---|
| `-O` | Connect pane output to command stdin |
| `-I` | Connect command stdout to pane input |

One pipe per pane. New pipe closes old one. Output includes raw ANSI escapes — use `capture-pane` for clean text.

### has-session (hasSession)

```
tmux -L <socket> has-session -t <name>
```

Exit 0 = exists, exit 1 = not found. Use for idempotent session creation. Check liveness via this command, NOT socket file existence.

### kill-pane / kill-session / kill-server

```
tmux -L <socket> kill-pane -t <target>
tmux -L <socket> kill-session -t <name>
tmux -L <socket> kill-server
```

`kill-server` is nuclear — destroys everything on the socket. Use in test `afterEach` for guaranteed cleanup.

### list-panes (listPanes)

```
tmux -L <socket> list-panes -t <session> -F '#{pane_id} #{pane_index} #{pane_dead}'
```

Custom format string. Returns one line per pane.

---

## Target syntax

`<session>:<window>.<pane>` — e.g., `orch-abc:0.1` targets window 0, pane 1. Shorthand `orch-abc.1` works with one window.

**Pane IDs** (`%N`) are globally unique within the server and more reliable than indexes.

## Pane exit detection pattern

The canonical sequence for detecting when a pane's process exits:

```bash
# 1. Keep dead panes for inspection
tmux -L orch set-option -g remain-on-exit on

# 2. Hook: signal wait-for channel on pane death (SET BEFORE SPAWN)
tmux -L orch set-hook -g pane-died \
  "run-shell 'tmux -L orch wait-for -S pane-exit-#{hook_pane}'"

# 3. Spawn pane with agent command
tmux -L orch split-window -h -t session -P -F '#{pane_id}' 'claude ...'
# → returns e.g. %1

# 4. Block until pane dies
tmux -L orch wait-for pane-exit-%1

# 5. Read exit code
tmux -L orch display-message -t %1 -p '#{pane_dead_status}'
# → returns e.g. "0"
```

## Testing pattern

```bash
# Unique socket per test
SOCKET="orch-test-$(uuidgen)"

# Setup
tmux -L $SOCKET -f /dev/null new-session -d -s test -x 120 -y 40

# ... test operations ...

# Cleanup (afterEach — always runs, even on failure)
tmux -L $SOCKET kill-server 2>/dev/null || true
```

**No sleep.** Use `wait-for` for synchronization. Use `capture-pane -p` for content assertions.
