---
date: 2026-04-28
status: ready-for-planning
topic: Autonomous-step transcript rendering — make non-interactive runs legible
---

# Autonomous-step transcript rendering

## What's broken today

When an autonomous step runs (no TTY, agent is just spawned), the right pane in `--mode=two-pane` and the stream in `--mode=plain --format=text` are unreadable:

```
[solve-riddle] · system
[solve-riddle] · rate_limit_event
[solve-riddle] · user
[solve-riddle] · user
[solve-riddle] · user
```

Root cause is in `src/hosts/plain/transcript-text.ts:35-48`:

- The switch matches top-level types `assistant` / `tool_use` / `tool_result`.
- Claude Code emits top-level types `system`, `assistant`, `user`, `rate_limit_event`. The interesting bits — `tool_use`, `tool_result`, `text`, `thinking` — live **nested** inside `payload.message.content[]`.
- Everything therefore falls through to `default → '· <type>'`, rendering only the type name.
- `renderAssistant` reads `payload.text` but the real shape is `payload.message.content[<i>].text`.
- `terminal/turn-complete` is suppressed (`return null`), so the final answer + cost + duration + token usage **never appears**, even though it's in the data.

The persisted transcript at `examples/.orch/state/<runId>/steps/<step>.transcript.ndjson` has all the data we need; we just don't render it.

## What we're building

A useful live activity stream for autonomous steps, plus a completion summary block. Same renderer feeds both `--mode=plain --format=text` and the right pane in `--mode=two-pane`. Runner-aware: each runner adapter owns the knowledge of its own event shape.

### Scope

- **In scope:** rendering of autonomous-step events to the human-readable text stream.
- **Out of scope:** interactive steps (the tmux pane is attached directly to the agent's TUI and looks fine), JSON format (`--format=json` is for machines), and the `events.ndjson` / `transcript.ndjson` files on disk (they keep raw shape — analytics-friendly).

## Target output

### Live stream (full verbosity — includes thinking + system init)

```
[solve-riddle] · system: model=claude-opus-4-7[1m], 47 tools, 6 mcp servers
[solve-riddle] ○ thinking
[solve-riddle] ▸ Read(/…/riddle.txt)
[solve-riddle] ◂ "I open at dusk and close at dawn,"
[solve-riddle] ○ thinking
[solve-riddle] ▸ Write(/…/solution.txt)
[solve-riddle] ✗ File has not been read yet. Read it first before writing to it.
[solve-riddle] ▸ Bash: ls /…/solution.txt 2>&1 || echo "does not exist"
[solve-riddle] ◂ /…/solution.txt
[solve-riddle] ▸ Read(/…/solution.txt)
[solve-riddle] ◂ "a lamp"
[solve-riddle] ▸ Write(/…/solution.txt)
[solve-riddle] ◂ updated
[solve-riddle] assistant> Wrote `the night sky` to solution.txt — silver coins = stars, hoarded between dusk and dawn, taken back by morning.
```

Glyph legend: `·` system note · `○` thinking · `▸` tool call · `◂` tool result · `✗` tool error · `assistant>` model text.

### Completion summary (multi-line block, on `terminal/turn-complete`)

```
[solve-riddle] ── done ──
[solve-riddle]   result      Wrote `the night sky` to solution.txt — silver coins = stars…
[solve-riddle]   duration    22.2s (api 22.1s)
[solve-riddle]   turns       6
[solve-riddle]   cost        $0.2742
[solve-riddle]   tokens      in 11 · out 781 · cache read 143k · cache write 29k
[solve-riddle]   permissions 0 denials
[solve-riddle]   session     70eed246-054b-…
```

On `terminal/error`, the same block prints with `── failed ──` and a `message` row instead of `result`.

## Why this approach

**Runner-aware rendering, not generic best-effort.** Matches CLAUDE.md rule 2 ("Runners are adapters"): each runner already owns its parser; it should also own its formatter. Claude knows the `payload.message.content[]` shape, Codex knows its `turn.*` shape, future runners (Aider, Amp, Ollama) plug in their own. The host stays generic and dumb.

**Same renderer for plain + two-pane.** Single source of truth keeps line shape stable across modes. CI logs and tmux right pane look identical, which is good for muscle memory and grep-ability.

**Live + summary, not just one.** Live stream tells you what's happening *now* (debugging, sanity-checking long runs); summary block tells you what the run cost (auditing, retros). Both come for free from data we already capture.

## Key decisions

1. **Runner formatter on the adapter.** Add an optional method to the `Runner` interface — e.g. `formatEvent(event: RunnerEvent): TranscriptLine | TranscriptLine[] | null`. Host calls `runner.formatEvent(event)` if present, otherwise falls back to today's generic best-effort. New runners are forward-compatible.
2. **`TranscriptLine` is structured, not pre-rendered.** Shape like `{ glyph: '▸' | '◂' | '✗' | '○' | '·' | 'text', label?: string, body: string }`. The host owns final ANSI/columns/wrapping. Lets us add color or different glyphs in two-pane vs plain without per-runner duplication.
3. **`turn-complete` is no longer suppressed.** It produces the multi-line summary block. (`turn-complete` for *interactive* steps stays suppressed because the tmux pane already shows everything.)
4. **`thinking` shows as a marker line, not content.** Real Claude payloads have `thinking: ""` with only a `signature` (encrypted/redacted by the API). We render `○ thinking` as a presence indicator, not as text.
5. **Glyph set is ASCII + a few Unicode arrows.** No emoji. Matches existing `assistant>` / `▸` / `◂` style and survives `tmux capture-pane` and copy-paste cleanly.
6. **System init is one-line summary, not full dump.** `· system: model=…, N tools, M mcp servers` is enough; the full payload stays in `transcript.ndjson` for debugging.
7. **No changes to `events.ndjson` / `transcript.ndjson` shape.** Those stay raw for analytics. Rendering is a presentation concern only.

## Why not alternatives

- **"Centralized switch with structural detection in transcript-text.ts"** — works but couples host to runner-specific shapes (Claude vs Codex). Doesn't scale to runner #3.
- **"Normalize at parse time inside each runner"** — emit pre-cooked `tool-call` / `tool-result` info events with a shared schema. Cleanest end state, but a much bigger surgery: changes the persisted event schema, breaks downstream consumers, and we don't have those consumers yet (YAGNI). Worth revisiting later if a third runner forces the issue.
- **"JSON-only for plain mode"** — punts the problem instead of solving it. Plain text is what humans see when they `tail -f` a CI log; we should make it good.
- **"Compact spinner + last-action line"** — pretty for a TTY but loses history; unworkable for CI logs.

## Resolved questions

1. **Formatter file layout.** Split into `src/runners/claude/format-event.ts` and `src/runners/codex/format-event.ts`. Keeps `claude-runner.ts` under the 300-line cap and cleanly separates parse vs render concerns.
2. **Plumbing.** Executor passes the runner along to the host: `host.onRunnerEvent(event, step, runner)`. Host pulls `runner.formatEvent` per call. Stateless, no setup/teardown dance.
3. **Colorization.** Auto: colorize on TTY (two-pane right pane), plain on non-TTY (pipes, CI logs). Standard CLI convention.
4. **Truncation policy.** Per-tool rules:
   - Bash: command up to 120 chars.
   - Read / Write / Edit: middle-ellipsis on `file_path` (`/…/solution.txt`).
   - Generic / unknown tools: `JSON.stringify` truncated at 80 chars (today's default).
5. **Test fixtures.** Use real captured NDJSON from `examples/.orch/state/r-2026-04-28-oiyrjv/` (and a re-capture when the Claude CLI shape changes). Snapshot the rendered output. Best regression coverage available; covers the empty-thinking signature, the mid-run tool error, and the `is_error` recovery path for free.

## Open questions for planning

None — ready for `/workflows:plan`.
