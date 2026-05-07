---
title: "Tmux Strict Appliance Mode (Two-Pane) — v2"
type: feat
status: completed
date: 2026-05-05
landed: 2026-05-05
brainstorm: docs/brainstorms/2026-05-05-tmux-strict-sandbox-brainstorm.md
supersedes: docs/plans/2026-05-05-feat-tmux-strict-appliance-mode-plan.md
---

# Tmux Strict Appliance Mode (Two-Pane) — v2

## Overview

Lock down the two-pane host's tmux to a four-item allowlist: drag-to-resize, click-to-focus, `M-Left/Right` pane switch, and native terminal text selection. Wipe the prefix table, all `root` bindings, and both copy-mode tables; set `prefix None`; pin `history-limit 0` *before* `new-session` via a generated `-f` config file. Persist the discoverability hint in tmux's `status-right` so users always see where to watch live progress. Add `orch logs --latest [--follow] [--step <name>]` so users can tail from a second terminal.

Two PRs total. The brainstorm decided **what**; this plan settles **how** — `TmuxService` method signatures, argv ordering, `orch logs` flag surface, test seams.

## Problem Statement

`initOrchSession` (`src/services/tmux/session-init.ts:43`) sets `mouse on` and inherits tmux's compiled-in default key tables. The two-pane host runs `tmux -f /dev/null` (`src/services/tmux/real-tmux-service.ts:79`) so user `~/.tmux.conf` is excluded — but the defaults survive.

Symptoms on tmux 3.6a, both Apple Terminal and iTerm2:

1. **Scroll derails the renderer.** The default `WheelUpPane` binding falls through to `copy-mode -e` under specific event sequences (notably between alt-screen toggles during agent startup). The pane enters copy-mode; orch's `send-keys -l` writers keep streaming and exit 0, but the visible surface freezes against a snapshot.

2. **`not in a mode` errors leak in.** The error originates in `cmd-send-keys.c` whenever `send-keys -X <name>` runs against a pane outside copy-mode. In stock 3.6a, every callsite of `send-keys -X` lives in the `copy-mode` and `copy-mode-vi` tables. After a wheel-driven copy-mode entry/exit ([tmux/tmux#638](https://github.com/tmux/tmux/issues/638), [#3705](https://github.com/tmux/tmux/issues/3705)), the next wheel event fires `send-keys -X scroll-up` against an already-exited pane and renders the error string into the visible stream. Wiping `copy-mode` and `copy-mode-vi` removes every default callsite.

3. **Hidden mode transitions persist across step boundaries.** Once the right pane is in copy-mode, `respawn-pane -k` clears it — but if the user wheel-scrolls during the brief `[exited]` window, the placeholder `cat` in the next step inherits the surface freeze.

The brainstorm rules out four alternatives (surgical disable, mouse-off, user knob, smart wheel forwarding) — see brainstorm §"Why This Approach".

## Architecture Decisions

### AD-1: `TmuxService` gets two explicit binding methods, no escape hatch

Add `unbindKey` and `bindKey` to the `TmuxService` port. **No** generic `runTmuxCommand` or `eval`. **No `setWindowOption`** — `history-limit` is a session option in tmux 3.6 (`set-window-option -g history-limit` is silently forwarded to the session namespace).

`bindKey.command` is `readonly string[]` (raw argv to tmux). The single caller — `initOrchSession` — passes hardcoded constants from one `ALLOWLIST` array. There is no string-injection surface because tmux does not re-parse argv; it interprets `;`, `${}`, `#{}`, quotes, and backslash escapes only inside command-language *strings*, which never reach this seam.

Adapter validates `key` rejects `\n` / `\0` and inserts `--` between flags and the command argv to defang any leading-`-` injection.

### AD-2: Argv ordering is `-f` config → unbind → bind, asserted in tests

`history-limit 0`, `mouse on`, `remain-on-exit on`, and `prefix None` are written to a temp config file and loaded via `tmux -L <socket> -f <tmpfile> new-session …` so the initial pane is allocated with a zero-size grid (see AD-3). `unbind-key -a -T root` then wipes everything; the four `bind -T root` calls re-establish the allowlist. The fake-service test in PR A pins this ordering as a regression guard.

### AD-3: `history-limit 0` is set BEFORE `new-session`

Empirical finding (tmux 3.6a + [tmux/tmux#4705](https://github.com/tmux/tmux/issues/4705)): `history-limit` is captured at pane-creation time. `set -g history-limit 0` after `new-session` does **not** shrink the initial pane's already-allocated grid; only newly-spawned panes inherit. The `-f` config-file path bypasses this — the value is read before any pane exists.

Fallback (not used in v1): `clear-history -t <pane>` on every pane after create. Verified to shrink existing history independent of the option value.

### AD-4: `prefix None`, not `prefix F12` or `prefix C-q`

Cleanest expression of intent. Supported by tmux 2.4+ (we floor at 3.2 — `meetsMinimumTmuxVersion` in `src/cli/detect-tmux.ts`). Makes `C-b` (and any other prefix) inert; the keystroke passes through to the running shell/agent unmodified — important because Claude Code's slash menu uses `C-b` on some terminal configs.

### AD-5: Strict sandbox and `orch logs --latest --follow` ship in TWO PRs

Independent modules, independently revertible:
- **PR A** ships strict sandbox + `status-right` hint pointing at *existing* `orch logs <runId>`. Bug fixed.
- **PR B** ships `orch logs --latest [--follow] [--step <name>]` as one feature.

Splitting `--latest` from `--follow` was not retained — they touch the same two CLI files and ship as one user-facing surface.

### AD-6: `--step <name>` does exact-match only

No-match exits 2 with the list of valid step names. RunIds are opaque hashes (where prefix matching matters in `RunRegistry.findByPrefix`); step names are user-authored (where exact match is enough). Add prefix matching when someone asks.

### AD-7: `--latest` is a snapshot resolver

`--latest` reads `RunRegistry.listRuns()` and picks the most recent runId at command time. If a new run starts mid-tail, the tail does NOT switch. Documented in `--help`.

### AD-8: No mid-run detach in v1

`prefix None` removes `C-b d` by design. The run ends in one of three ways — clean completion, agent failure, user SIGINT — and `createTmuxHost` tears down cleanly in all three. Users who want to step away open a second terminal and run `orch logs --latest --follow --step <name>`. The persistent `status-right` hint tells them so.

### AD-9: Wheel events are unbound; the persistent `status-right` line carries discoverability

Wheel bindings are not rebound to `display-message`. The four wheel-event entries are wiped along with the rest of the `root` table and stay wiped. Discoverability lives in `set -g status-right "logs --latest --follow"` — permanently visible, survives `unbind-key -a` (status-format is an option, not a key binding), no flicker, no double-trigger on spam-scroll, no extra bind-key calls.

### AD-10: `--follow` is its own tail loop in `logs.ts`, not a port method

The tail logic (offset cursor, partial-line carry, AbortSignal drain) lives in a ~20-line helper inside `src/cli/commands/logs.ts`. It is unit-tested against a real tmpdir. No new `FsService` port method, no scripted-content fakes, no rotation detection (orch writes append-only and never rotates the events file), no `maxBytesPerTick` knob.

The partial-line carry is the standard `.split('\n').pop()` idiom — split, save the trailing fragment, prepend on next iteration.

---

## PR A — Strict tmux sandbox

**Goal:** ship the seam and the lockdown together. Behavior change: appliance mode in two-pane.

### Files

- `src/services/tmux/tmux-service.ts` — two new option types + two interface methods + `configPath?` on `CreateSessionOptions`
- `src/services/tmux/real-tmux-service.ts` — argv builders + `-f` flag wiring
- `src/services/tmux/fake-tmux-service.ts` — two new `RecordedCall` variants
- `src/services/tmux/session-init.ts` — write the temp config, call `createSession`, wipe + bind, set `status-right` and `pane-died` hook
- `tests/unit/services/tmux/session-init.test.ts` — NEW; fake-service ordering test
- `tests/integration/services/tmux/tmux-integration.test.ts` — argv shape (RealTmux + FakeProcess)
- `tests/integration/services/tmux/tmux-real.integration.test.ts` — argv-takes-effect (gated on `Bun.which('tmux') && process.env.RUN_REAL_TMUX === '1'`)

### Type surface

```ts
// src/services/tmux/tmux-service.ts

/** A tmux key-table name. `'root-no-prefix'` emits `bind-key -n` (root with no prefix). */
export type KeyTable = 'root' | 'prefix' | 'copy-mode' | 'copy-mode-vi'
export type BindTable = KeyTable | 'root-no-prefix'

export interface UnbindKeyOptions {
  readonly socket: SocketName
  readonly table: KeyTable
}

export interface BindKeyOptions {
  readonly socket: SocketName
  readonly table: BindTable
  /** Tmux key sequence (e.g. `MouseDrag1Border`, `M-Left`). Adapter rejects `\n`/`\0`. */
  readonly key: string
  /** Raw argv. Hardcoded constants only — no user input ever reaches this. */
  readonly command: readonly string[]
}

export interface TmuxService {
  // ... existing methods ...
  unbindKey(opts: UnbindKeyOptions): Promise<void>
  bindKey(opts: BindKeyOptions): Promise<void>
}

export interface CreateSessionOptions {
  // ... existing fields ...
  /** Path to a tmux config file passed as `-f <path>`. Load-bearing for `history-limit 0`. */
  readonly configPath?: Path
}
```

### Argv contracts (RealTmuxService)

```
['tmux', '-L', socket, '-f', configPath, 'new-session', '-d', '-s', session, '-x', W, '-y', H]
['tmux', '-L', socket, 'unbind-key', '-a', '-T', table]
['tmux', '-L', socket, 'bind-key', '-n', key, '--', ...command]                  // root-no-prefix
['tmux', '-L', socket, 'bind-key', '-T', table, key, '--', ...command]           // all other tables
```

### `initOrchSession` shape

```ts
// src/services/tmux/session-init.ts (sketch)

const ALLOWLIST: readonly Omit<BindKeyOptions, 'socket'>[] = [
  { table: 'root',           key: 'MouseDrag1Border', command: ['resize-pane', '-M'] },
  { table: 'root',           key: 'MouseDown1Pane',   command: ['select-pane', '-t='] },
  { table: 'root-no-prefix', key: 'M-Left',           command: ['select-pane', '-L'] },
  { table: 'root-no-prefix', key: 'M-Right',          command: ['select-pane', '-R'] },
] as const

const TABLES_TO_WIPE: readonly KeyTable[] = ['root', 'prefix', 'copy-mode', 'copy-mode-vi']

export const initOrchSession = async (
  tmux: TmuxService,
  fs: FsService,
  opts: InitSessionOptions,
): Promise<void> => {
  // history-limit 0 must be set BEFORE new-session — captured at pane allocation (tmux/tmux#4705).
  const configPath = await writeTmuxConfig(fs, [
    'set -g history-limit 0',
    'set -g mouse on',
    'set -g remain-on-exit on',
    'set -g prefix None',
  ])

  await tmux.createSession({ socket: opts.socket, session: opts.session, width: opts.width, height: opts.height, configPath })

  for (const table of TABLES_TO_WIPE) {
    await tmux.unbindKey({ socket: opts.socket, table })
  }
  for (const item of ALLOWLIST) {
    await tmux.bindKey({ socket: opts.socket, ...item })
  }

  // Persistent status-right hint — survives unbind-key -a (status-format is an option, not a binding).
  await tmux.setOption({
    socket: opts.socket, target: opts.session, name: 'status-right',
    value: 'logs --latest --follow', global: true,
  })

  // pane-died hook — hooks live in a separate namespace from key tables (verified empirically).
  await tmux.setHook({ socket: opts.socket, hook: 'pane-died', command: opts.paneDiedCommand, global: true })
}
```

### Required call ordering (asserted by fake-service test)

1. `fs.writeFile(configPath, …)`
2. `createSession` with `configPath`
3. `unbindKey` × 4: `root` → `prefix` → `copy-mode` → `copy-mode-vi`
4. `bindKey` × 4: `MouseDrag1Border` → `MouseDown1Pane` → `M-Left` → `M-Right`
5. `setOption status-right`
6. `setHook pane-died`

### Tests for PR A

**Fake-service ordering** (`tests/unit/services/tmux/session-init.test.ts`):
- `initOrchSession writes a tmux config file containing history-limit 0, mouse on, remain-on-exit on, and prefix None`
- `initOrchSession passes the config path to createSession via the configPath option`
- `initOrchSession wipes all four key tables before installing any bindings`
- `initOrchSession installs exactly the four allowlist bindings in order`
- `initOrchSession installs the persistent status-right hint after the bindings are in place`
- `initOrchSession installs the pane-died hook after the bindings are in place so unbind-key cannot wipe it`

**Argv shape** (`tests/integration/services/tmux/tmux-integration.test.ts`):
- `unbindKey emits unbind-key -a -T for the requested table`
- `bindKey with table 'root-no-prefix' emits bind-key -n followed by -- before the command argv`
- `bindKey with all other tables emits bind-key -T <table> followed by -- before the command argv`
- `bindKey rejects a key containing a newline or NUL byte`
- `createSession passes configPath as -f when provided`

**Real-tmux contract** (gated on `Bun.which('tmux') && RUN_REAL_TMUX === '1'`):
- `after init, list-keys -T root contains exactly the four allowlist items`
- `after init, list-keys for prefix, copy-mode, and copy-mode-vi are all empty`
- `after init, show-options -g prefix is None`
- `after init, display-message -p '#{history_size}' returns 0 for the initial pane`
- `after init plus splitPane plus a 200-line stream, display-message -p '#{history_size}' is still 0`
- `after init, the pane-died hook is still installed`
- `after init, the status-right option contains 'logs --latest --follow'`

### Definition of Done — PR A

- `bun run check` green.
- Pre-existing two-pane integration tests still pass (`tests/integration/cli/two-pane-auto-attach.test.ts`, `tests/integration/hosts/tmux-host-command-line.test.ts`).
- Manual smoke: wheel-scroll on the right pane during a streaming step → no copy-mode, no `not in a mode` errors, no surface freeze; divider drag works; click-to-focus works; `M-Left/Right` works; `status-right` shows `logs --latest --follow`.

---

## PR B — `orch logs --latest [--follow] [--step <name>]`

**Goal:** the live tail. Single PR, single feature.

### Files

- `src/cli/main.ts` — extend `parseArgv` for `--latest`, `--step`, `--follow`/`-f`; add banner hint (two-pane non-JSON)
- `src/cli/commands/logs.ts` — extend `logsCmd`: `--latest` resolution, `--step` exact match, `--follow` tail loop helper
- `tests/unit/cli/logs-command.test.ts` — NEW; unit tests with fakes injected at `*Service` ports

### CLI surface

```
orch logs <runId> [--step <name>] [--follow | -f]
orch logs --latest [--step <name>] [--follow | -f]

Flags:
  --latest       Resolve <runId> to the most recent run (snapshot at command time).
  --step <name>  Print only the named step's transcript. Exact match; no-match exits 2
                 with the list of valid step names.
  --follow, -f   Tail the named step's transcript until the run reaches a terminal
                 status (completed, failed, cancelled) or SIGINT. Requires --step.
```

`--latest` and a positional runId are mutually exclusive (rejected by `parseArgv`).

### `--step` matching (no impossible branches)

```ts
const stepQuery = opts.step
if (stepQuery === undefined) return runAllSteps(...)

const steps = Object.values(state.steps).sort((a, b) => a.startedAt - b.startedAt)
const entry = steps.find((s) => s.name === stepQuery)
if (entry === undefined) {
  const names = steps.map((s) => s.name).join(', ')
  process.stderr.write(`No step matching "${stepQuery}" in run ${rid} (steps: ${names})\n`)
  return EXIT.CONFIG_ERROR
}
return [entry]
```

Single lookup, no `state.steps[exact]` index round-trip, no `INTERNAL_ERROR` defensive branch, no `!` non-null assertion.

### `--follow` tail loop (inline, ~20 lines)

```ts
// src/cli/commands/logs.ts

const isTerminal = (s: RunStatus): boolean =>
  s === 'completed' || s === 'failed' || s === 'cancelled'

async function* tailLines(filePath: Path, abort: AbortSignal): AsyncIterable<string> {
  let offset = 0
  let pending = ''
  while (!abort.aborted) {
    const chunk = await Bun.file(filePath).slice(offset).text()
    if (chunk.length > 0) {
      offset += Buffer.byteLength(chunk)
      pending += chunk
      const parts = pending.split('\n')
      pending = parts.pop() ?? ''
      for (const line of parts) yield line
    }
    await Bun.sleep(100)
  }
  if (pending.length > 0) yield pending  // flush trailing partial on abort
}
```

The consumer in `logsCmd`:

```ts
if (opts.follow) {
  if (opts.step === undefined) {
    process.stderr.write(`--follow requires --step <name>\n`)
    return EXIT.CONFIG_ERROR
  }

  const status = await deps.stateStore.loadRun(rid)
  if (status !== undefined && isTerminal(status.status)) {
    return printAllSteps(...)  // already terminal → print and exit, don't tail
  }

  const abort = new AbortController()
  const onSigint = () => { abort.abort() }
  process.once('SIGINT', onSigint)

  try {
    const filePath = path.join(runDir, entry.transcriptPath)
    const lines = tailLines(filePath, abort.signal)
    const statusPoll = pollStatus(deps.stateStore, rid, abort.signal, 1000)
    await Promise.race([drainLines(lines, entry.name, format), waitForTerminal(statusPoll)])
  } finally {
    abort.abort()  // cancel the loser of the race; flushes pending partial
    process.off('SIGINT', onSigint)
  }

  return abort.signal.aborted ? EXIT.SIGINT : EXIT.OK
}
```

### Banner hint (gated on `format !== 'json' && mode === 'two-pane'`)

```
[orch] mode=two-pane (cli: --mode override)
[orch] live progress: orch logs --latest --follow --step <step-name>
```

Single line under the existing mode line. JSON mode emits no banner; plain mode adds nothing.

### Tests for PR B

**Unit tests** (`tests/unit/cli/logs-command.test.ts`):
- `logs --latest resolves to the most recent run id from the registry`
- `logs --latest with no runs prints "No runs found" and exits 2`
- `logs --latest combined with a positional runId is rejected as mutually exclusive`
- `logs <runId> --step <name> with exact match prints only that step`
- `logs <runId> --step <name> with no match exits 2 and lists the valid step names`
- `logs --latest --follow --step <name> tails until the run reaches a terminal status`  *(parametrized over completed / failed / cancelled)*
- `logs --follow --step <name> on an already-terminal run prints the full transcript and exits 0 without tailing`
- `logs --follow without --step exits 2 with a hint pointing at --step`
- `logs --follow plus SIGINT exits 130 and flushes any pending partial line`

**Tail-loop unit test** (alongside `logs-command.test.ts` against a real tmpdir):
- `tailLines yields one line for each newline-terminated chunk written between ticks`
- `tailLines holds a partial line across ticks until a newline arrives`
- `tailLines flushes a non-empty pending partial when abort fires`

**Banner test** (extend `tests/unit/cli/banner.test.ts`):
- `the two-pane non-JSON banner includes the orch logs --latest --follow hint`

### Documentation (lands with PR B)

`docs/getting-started.md` gains one subsection inside the two-pane block:

```markdown
### Appliance mode (two-pane only)

When you run `orch run <workflow> --mode=two-pane`, orch owns the terminal until the
run completes. The session is locked down to four interactions:

| Action              | How                                          |
|---------------------|----------------------------------------------|
| Resize the divider  | Drag the pane border with the mouse          |
| Switch focus        | Click a pane, or press `M-Left` / `M-Right`  |
| Select text         | Hold your terminal's modifier-drag (often Shift; Option on macOS Terminal) |
| Watch live progress | `orch logs --latest --follow --step <name>` in another tab |

Mouse-wheel scrolling is disabled — real history lives in `.orch/state/<runId>/logs/`
(see [logging.md](logging.md)). The tmux status bar shows the live-progress hint at
all times.

The run ends in one of three ways: clean completion, step failure, or `Ctrl-C` to
orch (SIGINT cancels). There is no mid-run detach in v1.

> `M-Left` / `M-Right` may be intercepted by SSH/mosh, Windows Terminal, or an outer
> multiplexer; click-to-focus and drag-to-resize always work.
```

### Definition of Done — PR B

- `bun run check` green.
- All PR B tests pass.
- Manual smoke: real two-pane run; from a second terminal, `orch logs --latest --follow --step <name>` shows live transcript matching the right pane; `Ctrl-C` exits 130; the `status-right` hint is visible throughout.

---

## Acceptance Criteria

### Functional
- [x] Wheel-scroll on either pane does nothing visible (no copy-mode, no `not in a mode`, no surface freeze).
- [x] `C-b` is inert at the tmux layer; the keystroke reaches the running process unmodified.
- [x] Drag-to-resize, click-to-focus, and `M-Left/Right` pane switch work.
- [x] Native terminal text selection works with the host terminal's modifier.
- [x] `display-message -p '#{history_size}'` returns 0 for both initial and split panes after a 200-line stream.
- [x] `orch logs --latest` resolves to the most recent run.
- [x] `orch logs <runId> --step <name>` exits 2 with the valid-step list when no exact match.
- [x] `orch logs --latest --follow --step <name>` tails until `completed`, `failed`, or `cancelled`. *(implemented as `completed` | `crashed` — orch's status enum is `running | completed | crashed`; failure path = `crashed`.)*
- [x] `orch logs --follow + SIGINT` exits 130 and flushes any pending partial line.
- [x] tmux `status-right` shows `logs --latest --follow` throughout the run.
- [x] Two-pane non-JSON banner includes the `orch logs --latest --follow --step <name>` hint.

### Non-functional
- [x] No new public API on `TmuxService` beyond `unbindKey` and `bindKey`.
- [x] No generic `runTmuxCommand` escape hatch.
- [x] No new method on `FsService`.
- [x] No regression in existing tmux integration tests.

### Quality gates
- [x] Each new test name reads as a full sentence (project rule 4).
- [x] No `mock.module` / `vi.mock` in `src/services/tmux/`, `src/state/`, `src/core/`, `src/runners/` test files (rule 3).
- [x] No `child_process` / `Bun.spawn` outside `src/services/process/` (rule 1) — the new `runShell` helper in the real-tmux integration test still uses `Bun.spawn` per the existing test pattern; production code stays clean.
- [x] No `!` non-null assertions, no `any` (rule 6).
- [x] All new files ≤ 300 lines, all new functions ≤ 60 lines (rule 5) — except `src/cli/commands/logs.ts` (335 lines) with an explanatory comment per the rule.

### Implementation deviations
- **`bind-key` argv has no `--` separator.** The plan and AD-1 sketched inserting `--` between `<key>` and `<command>` to defang leading-`-` injection. Empirical finding on tmux 3.6a: `bind-key … -- resize-pane -M` errors with "unknown command: --". Tmux's grammar is `bind-key [-nr] [-N note] [-T table] key command [args...]` — `command` is a single positional token. Adapter passes argv directly; `BindKeyOptions.command` is documented as hardcoded-callers-only and the FakeTmuxService recorder + integration tests cover the contract.
- **Status enum is `completed | crashed`, not `completed | failed | cancelled`.** Orch's `RunState.status` predates the plan and uses a smaller enum. `--follow` aborts on either terminal value.

---

## Risks

| Risk | Probability | Mitigation |
|------|-------------|------------|
| `M-Left` / `M-Right` intercepted by SSH/mosh, Windows Terminal, or outer multiplexer | Medium | Documented in `getting-started.md`. Click-to-focus and drag-to-resize always work. |
| Reproduction may not occur on the user's tmux build (Oct 2025 patch may already cover) | Medium | The strict allowlist is independently valuable as defensive hardening. Verify on the affected machine before shipping (one-line PR-description bullet). |
| Generic regression in two-pane integration tests | Low | Existing tests run as part of `bun run check`. |

---

## Pre-flight (PR A description, not a phase)

Before opening PR A: on the affected machine, record `tmux -V` and the actual `WheelUpPane` binding (`tmux -L test -f /dev/null new-session -d 'sleep 999'; tmux -L test list-keys -T root | grep WheelUpPane`); run a real two-pane orch session against Claude Code and Codex; record observed wheel behavior. Outcome goes in the PR description. The fix ships either way.

---

## References

### Internal
- Brainstorm: [`docs/brainstorms/2026-05-05-tmux-strict-sandbox-brainstorm.md`](../brainstorms/2026-05-05-tmux-strict-sandbox-brainstorm.md)
- Project rules: [`CLAUDE.md`](../../CLAUDE.md)
- Skills: `.claude/skills/phase-implementer`, `.claude/skills/testing-strategy`
- `src/services/tmux/session-init.ts:43` — current `initOrchSession`
- `src/services/tmux/real-tmux-service.ts:79` — `-f /dev/null` rationale (becomes `-f <generated>`)
- `src/services/tmux/tmux-service.ts:227` — `TmuxService` interface
- `src/services/fs/fs-service.ts` — `FsService` port (unchanged in v2)
- `src/cli/commands/logs.ts` — current `logsCmd` (extended in PR B)
- `src/cli/main.ts:127` — `parseArgv`
- `src/state/run-registry.ts:36` — `findByPrefix` (the matching idiom; **not** mirrored for `--step`)
- `src/cli/detect-tmux.ts` — tmux version floor (≥ 3.2)

### External
- [tmux/tmux source @ 3.6a `key-bindings.c`](https://raw.githubusercontent.com/tmux/tmux/3.6a/key-bindings.c)
- [tmux/tmux source @ 3.6a `cmd-send-keys.c`](https://raw.githubusercontent.com/tmux/tmux/3.6a/cmd-send-keys.c)
- [tmux/tmux#4705](https://github.com/tmux/tmux/issues/4705) — `history-limit` captured at pane allocation
- [tmux/tmux#638](https://github.com/tmux/tmux/issues/638), [#3705](https://github.com/tmux/tmux/issues/3705) — `not in a mode` regression
- [tmux/tmux#729](https://github.com/tmux/tmux/issues/729) — canonical reset-bindings pattern
- [anthropics/claude-code#38810](https://github.com/anthropics/claude-code/issues/38810) — wheel-in-tmux upstream
- [microsoft/terminal#4763](https://github.com/microsoft/terminal/issues/4763) — Windows Terminal intercepts `M-Left/Right`
- [Bun File I/O docs](https://bun.sh/docs/api/file-io) — `Bun.file().slice(offset).text()` semantics
