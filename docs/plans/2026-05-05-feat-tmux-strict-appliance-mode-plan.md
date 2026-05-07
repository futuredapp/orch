---
title: "Tmux Strict Appliance Mode (Two-Pane)"
type: feat
status: active
date: 2026-05-05
brainstorm: docs/brainstorms/2026-05-05-tmux-strict-sandbox-brainstorm.md
deepened: 2026-05-05
---

# Tmux Strict Appliance Mode (Two-Pane)

## Enhancement Summary

**Deepened on:** 2026-05-05 with 12 parallel research/review agents (architecture, simplicity, security, performance, kieran-typescript, pattern-recognition, spec-flow, bug-reproduction, best-practices, framework-docs, phase-implementer, testing-strategy).

### Show-stopper corrections folded in
1. **`history-limit 0` does NOT apply retroactively to existing panes.** Empirically verified on tmux 3.6a + the `tmux/tmux#4705` upstream issue. The plan's earlier "set globally then re-assert via `setWindowOption`" was wrong — neither call shrinks the initial pane's already-allocated grid. Fix: set `history-limit` *before* `new-session` via the `-f` config-file path, OR `clear-history -t <pane>` after the option is applied. AD-4 and Phase 2 are rewritten accordingly.
2. **Partial-line bug in `--follow`.** The earlier sketch advanced `offset` past unconsumed bytes after `split('\n')`, silently corrupting any event larger than one syscall's atomic-write boundary (~4 KB on Linux, ~512 B on macOS). Phase 3b now carries a `pendingPartial` buffer; only `\n`-terminated lines are emitted. Cited `nxadm/tail#25` as prior art.
3. **`WheelUpPane` default-binding quote is stale.** Actual tmux 3.6a binding is `if-shell -F "#{||:#{alternate_on},#{pane_in_mode},#{mouse_any_flag}}" { send-keys -M } { copy-mode -e }` — three-flag OR, not the single-flag form quoted earlier. Problem Statement and brainstorm citation updated. **This also UNDERMINES the user-reported symptom on alt-screen agents** (Claude Code, Codex), so a Phase 0 reproduction step is added.
4. **`not in a mode` mechanism explanation was wrong but the fix still works.** The error originates from `cmd-send-keys.c` when `send-keys -X` runs outside copy-mode; default 3.6a *root* bindings never invoke `send-keys -X`. The error path is `copy-mode` / `copy-mode-vi` table bindings — wiping those tables removes every default callsite. Problem Statement now states this correctly.
5. **`capture-pane -p` test design was broken.** Bare `-p` returns the visible viewport only (~24 lines on an 80×24 pane), independent of scrollback. Replaced with `display-message -p '#{history_size}'` assert `=== 0` — direct, exact, no slack constant.

### High-impact corrections folded in
6. **Type surface tightened.** Dropped `UnbindKeyOptions.all: true` (literal-only field), dropped `BindKeyOptions.noPrefix` (folded into `KeyTable | 'root-no-prefix'`), made `SetWindowOptionOptions` a discriminated union of `{ scope: 'global' }` / `{ scope: 'target' }` (illegal states unrepresentable), and made the `latest` vs explicit `runId` selection a `RunSelector` discriminated union. Removed two `!` non-null assertions banned by CLAUDE.md rule 6.
7. **`setWindowOption` removed entirely.** `history-limit` is a *session* option in tmux 3.6; the apparent need for `set-window-option` was an artifact of the (also-wrong) retroactivity assumption. Once `history-limit` is set before `new-session`, only `setOption` is needed. AC line 635's "no new public API beyond these three" tightens to **two**: `unbindKey`, `bindKey`.
8. **Phase boundaries restructured.** Merged the seam-only Phase 1 into Phase 2 (per project precedent — Phase 19 didn't split prerequisites). Split Phase 3 into Phase 3a (`--latest` + `--step`) and Phase 3b (`--follow` + banner + FsService). Folded Phase 4 docs into the phases that ship the user-facing change. Kept Phase 5 manual checklist but moved it into the final PR description, not its own phase.
9. **Tail mechanics: rotation handling, bounded reads, status decoupling.** Detect `stat().size < offset` and reset to 0 with a "file rotated" log. Cap each tick's read at 1 MB. Poll `state.json` every 1 s, file-tail every 100 ms (10× decoupled).
10. **`isTerminal(status)` predicate** — `--follow` now exits cleanly on `completed`, `failed`, AND `cancelled`. Tests added for each.
11. **Test relocation + gating.** `tests/integration/cli/logs-command.test.ts` → `tests/unit/cli/logs-command.test.ts` (it's a unit test by the skill's definition). Real-tmux tests gated on `Bun.which('tmux') && process.env.RUN_REAL_TMUX === '1'` per skill.
12. **Security hardening.** `BindKeyOptions.command` becomes a tagged union of the four allowlist shapes (no caller can ever pass an arbitrary tmux command-language string). `RealTmuxService` inserts `--` before `target` in argv. `state.json`'s `transcriptPath` Zod schema gets a regex (`^logs/agents/[a-zA-Z0-9_-]+/events\.ndjson$`). `FsService.readFileFrom` takes `(baseDir, relativePath)` with a containment check.
13. **UX gaps closed.** `--follow` emits `Waiting for run <rid> to start…` when state.json doesn't exist yet; emits `Resolved --latest to <rid> …` on entry; `--step <name>` under `--follow` polls `state.steps` until match or terminal status. Banner adds a tmux `status-right` persistent hint surviving `unbind-key -a`. Terminal-specific modifier matrix (Apple Terminal/iTerm2 = Option, Ghostty/Alacritty/Linux = Shift) added to docs. Wheel events bind to `display-message -d 2000 'scrollback disabled — orch logs --latest --follow'` instead of being unbound — discoverability without copy-mode entry.

### What's still in scope
- Strict allowlist on `root` table, all four tables wiped, `prefix None` (unchanged).
- `orch logs --latest [--follow] [--step <name>]` (re-scoped to two phases).
- Documentation updates (folded into the phases shipping the change).

### What got dropped from scope
- `RunRegistry.latest()` "sugar" helper (use `listRuns().at(-1)`).
- Prefix matching for `--step` is **deferred** to v2 — exact match only in v1 (simpler, can add when asked).
- Generic `FsService.readFileFrom` — replaced with the more conservative `FsService.tailFile(baseDir, relativePath, opts): AsyncIterable<string>` that internalizes the loop.

---

## Overview

Lock down the two-pane host's tmux configuration to an explicit four-item allowlist (drag-to-resize, click-to-focus, `M-Left/Right` pane switch, native terminal text selection). Wipe the prefix table, all `root` bindings, and both copy-mode tables; set `prefix None`; pin `history-limit 0` *before* `new-session`. Replace the lost "scroll up to see history" affordance with first-class `orch logs --latest [--follow]` and `orch logs <runId> --step <name>` CLI commands, plus a wheel-binding that displays `scrollback disabled — orch logs --latest --follow` (discoverable, can't enter copy-mode), and a tmux `status-right` line that persists the same hint. Update `docs/getting-started.md` with the appliance mental model: orch owns the terminal until the run completes.

The brainstorm decided **what** (strict allowlist, no surgical disable, no user knob, no smart wheel forwarding); this plan settles **how** — `TmuxService` method signatures, argv ordering, `orch logs` flag surface, test seams, banner copy.

## Problem Statement

Today `initOrchSession` (`src/services/tmux/session-init.ts:43`) sets `mouse on` and inherits tmux's full default key-binding tables. The two-pane host is created with `tmux -f /dev/null` (`src/services/tmux/real-tmux-service.ts:79`), so user `~/.tmux.conf` is excluded — but tmux's compiled-in defaults survive.

Concrete symptoms (tmux 3.6a, both Apple Terminal and iTerm2):

1. **Scrolling derails the renderer.** Mouse-wheel on the right pane fires the default `WheelUpPane` binding which in tmux 3.6a is:

   ```
   bind -n WheelUpPane if-shell -F "#{||:#{alternate_on},#{pane_in_mode},#{mouse_any_flag}}" { send-keys -M } { copy-mode -e }
   ```

   Under the alternate screen (Claude Code, Codex), the `#{||:…}` short-circuit sends `-M` and does NOT enter copy-mode. **But** during agent startup, between alt-screen toggles, or under a non-alt-screen step, the binding falls through to `copy-mode -e`. The pane enters copy-mode; orch's `send-keys -l` writers (status loop, transcript fan-out) keep streaming and continue to exit 0, but the visible surface is frozen against a snapshot. *(Source: tmux/tmux source `key-bindings.c@3.6a`, empirically verified.)*

2. **`not in a mode` errors leak into the visible stream.** The error string itself is emitted from `cmd-send-keys.c` whenever `send-keys -X <name>` runs against a pane not currently in any mode. In stock 3.6a, every callsite of `send-keys -X` lives in the `copy-mode` and `copy-mode-vi` key tables. When the user wheel-scrolls into and back out of copy-mode under specific event sequences ([tmux/tmux#638](https://github.com/tmux/tmux/issues/638), [#3705](https://github.com/tmux/tmux/issues/3705)), the next wheel event fires `send-keys -X scroll-up` against a pane that has already exited copy-mode — and the error string is rendered into the pane the user is watching. Wiping `copy-mode` and `copy-mode-vi` tables removes every default callsite, eliminating the error class.

3. **Hidden mode transitions persist across step boundaries.** Once the right pane is in copy-mode, the next `respawn-pane -k` clears it — but if the user wheel-scrolls during the brief `[exited]` window, the placeholder `cat` in the next step inherits the surface freeze. *(UNCERTAIN — no upstream issue; verified by Phase 5 manual smoke.)*

The brainstorm rules out four alternatives (surgical disable, mouse-off, user config knob, smart wheel forwarding) — see brainstorm §"Why This Approach". This plan implements the chosen path: strict allowlist + `orch logs` replacement + wheel display-message hint.

## Architecture Decisions

### AD-1: `TmuxService` gets two explicit binding methods, no escape hatch

Add `unbindKey` and `bindKey` to the `TmuxService` port. **No** generic `runTmuxCommand` or `eval` method. **No `setWindowOption`** — `history-limit` is a session option in tmux 3.6 (verified empirically; `set-window-option -g history-limit` is silently forwarded to the session namespace). Each method takes a typed-options bag mirroring the existing `setOption`, `setHook` shape. See §"Phase 1+2" for signatures.

`bindKey.command` is a **tagged union** (not a raw string). The four allowlist commands are the only legal shapes. This eliminates the latent risk that future callers pass attacker-controlled tmux command-language fragments — tmux's internal command parser interprets `;`, `${}`, `#{}`, quotes, and backslash escapes.

### AD-2: Argv ordering is `-f` config → option → unbind → bind, asserted in tests

`mouse on` MUST be set before any mouse binding. `unbind-key -a -T root` wipes everything in the root table; the four `bind -T root` calls then re-establish the allowlist. **`history-limit 0` is now passed to `new-session` via a generated `-f` config file** so the initial pane is allocated with a zero-size grid (see AD-4). The fake-service test in §"Phase 1+2" pins this ordering as a regression guard.

### AD-3: `prefix None`, not `prefix F12` or `prefix C-q`

Cleanest expression of intent. Supported by tmux 2.4+ (we floor at 3.2 — `meetsMinimumTmuxVersion` in `src/cli/detect-tmux.ts`). `None` is case-insensitive (`None` / `none` / `NONE` all valid). Makes `C-b` (and any other prefix) inert. The user's `C-b` keystrokes pass through to the running shell/agent unmodified — important because Claude Code's slash menu uses `C-b` on some terminal configs.

### AD-4: `history-limit 0` is set BEFORE `new-session` via a generated `-f` config file

Empirical finding (tmux 3.6a + [tmux/tmux#4705](https://github.com/tmux/tmux/issues/4705)): `history-limit` is captured at pane-creation time. `set -g history-limit 0` after `new-session` does **not** shrink the initial pane's already-allocated grid; only newly-spawned panes inherit. The earlier plan's `setWindowOption` workaround was incorrect.

The fix: write a temporary `-f` config file containing `set -g history-limit 0\nset -g mouse on\nset -g remain-on-exit on\nset -g prefix None\n` and pass it as `tmux -L <socket> -f <tmpfile> new-session …`. The initial pane is allocated with `history-limit 0`. The split pane (right) inherits at split time, also with `history-limit 0`. Post-create, `unbind-key`, `bind-key`, `set-hook` calls follow normally.

If config-file generation feels heavy, a fallback is acceptable: after `new-session`, immediately `clear-history -t <pane>` on every pane. `clear-history` *does* shrink an existing pane's history (verified empirically), independent of the option value.

### AD-5: Strict sandbox and `orch logs --follow` ship in TWO PRs, not one

Reverse of the original AD-5 (kept the number for cross-reference). Architecture review flagged that the two changes are independent: the strict sandbox touches `src/services/tmux/` only; `orch logs --follow` touches `src/cli/commands/logs.ts` and `src/services/fs/`. Independently revertible.

- **PR 1** ships strict sandbox + minimal banner pointing at *existing* `orch logs <runId>`. Bug fixed. Smaller regression window.
- **PR 2** ships `orch logs --latest` + `--step <name>`.
- **PR 3** ships `orch logs --follow` + the persistent `status-right` hint + the docs sweep.

The brainstorm's "removing scroll-without-replacement is worse" concern is satisfied by PR 1 still pointing at existing logs commands; users without `--latest`/`--follow` can `orch logs <runId>` from another terminal. (See Phase plan below for concrete file lists.)

### AD-6: `--step <name>` does exact-match only in v1

Earlier plan included exact-then-prefix matching mirrored from `RunRegistry.findByPrefix`. Simplicity reviewer correctly noted runIds are opaque hashes (where prefix matching is essential) but step names are user-authored (where exact match is enough). YAGNI: ship exact match. No-match → exit 2 with the list of valid step names. Add prefix matching when someone asks.

### AD-7: `--latest` resolves at command time, not runId-resolution time

`--latest` reads `RunRegistry.listRuns()` and picks the most recent run id. If `--latest` is combined with `--follow` and a new run starts mid-tail, the tail does NOT switch — `--latest` is a snapshot resolver, not a live pointer. **`--follow` prints `Resolved --latest to <rid> (workflow=<wf>, started=<t>)` to stderr on entry** so the user can see which run they're tailing.

### AD-8: No mid-run detach, no `orch attach <runId>` in v1

`prefix None` removes the `C-b d` detach binding by design. The run ends in one of three ways — clean completion, agent failure, user SIGINT to orch — and `createTmuxHost` tears down cleanly in all three. This is documented as the appliance contract; users who want to step away use a second terminal with `orch logs --latest --follow`.

### AD-9: Wheel events bind to a `display-message` hint, not unbound

The brainstorm called for wheel events to be "nuked." Best-practices reviewer recommended a discoverable feedback path instead. The four wheel bindings (`WheelUpPane`, `WheelDownPane`, `WheelUpStatus`, `WheelDownStatus`) get bound to:

```
display-message -d 2000 'scrollback disabled — orch logs --latest --follow'
```

This shows for 2000ms in the tmux status line on every wheel event. Costs nothing, can't enter copy-mode (`display-message` is mode-neutral), gives the user one obvious next step.

### AD-10: `status-right` persists the hint across the run

A single startup banner is the weakest discoverability affordance per the lazygit/k9s/vim discoverability literature. The plan adds:

```
set -g status-right "logs --latest --follow #(date +%H:%M)"
```

This survives `unbind-key -a` (status-format is an option, not a key binding) and is visible at all times in the right corner of the tmux status bar. Costs zero risk; gives the user a permanent reminder.

### AD-11: `FsService.tailFile` is the seam, not `readFileFrom`

Architecture + simplicity reviewers converged: a low-level `readFileFrom(path, offset)` exposes too many implementation details (cursor management, partial-line handling) to the CLI. The cleaner seam is:

```ts
tailFile(
  baseDir: Path,
  relativePath: string,
  opts: { abort: AbortSignal; pollMs?: number; maxBytesPerTick?: number },
): AsyncIterable<string>  // yields complete lines only; flushes pending on abort
```

The implementation owns the loop, the offset cursor, the `pendingPartial` buffer, the rotation detection (`stat().size < offset` → reset to 0 + log "file rotated"), and the bounded read (default 1 MB/tick). The CLI consumes lines and decides when to terminate based on its independent status poll.

This also makes path-traversal containment explicit: `tailFile` resolves `relativePath` against `baseDir` and rejects any resolved path that escapes the base.

---

## Phase 1+2 (combined) — `TmuxService` API + Strict allowlist in `initOrchSession`

**Goal:** ship the seam and its first caller in a single mergeable PR. The behavior change is the strict appliance lockdown.

### Files

- `src/services/tmux/tmux-service.ts` — two new option types + two interface methods + tagged-union `BindCommand`
- `src/services/tmux/real-tmux-service.ts` — argv-builder methods + `-f` config-file support
- `src/services/tmux/fake-tmux-service.ts` — two new `RecordedCall` variants + recorder methods
- `src/services/tmux/session-init.ts` — extend `initOrchSession`; adopt `-f` config-file path
- `tests/integration/services/tmux/tmux-integration.test.ts` — argv shape (RealTmux + FakeProcess)
- `tests/integration/services/tmux/tmux-real.integration.test.ts` — argv-takes-effect (real tmux server, gated on `Bun.which('tmux') && process.env.RUN_REAL_TMUX === '1'`)
- `tests/unit/services/tmux/session-init.test.ts` — NEW; fake-service ordering test

### Type surface

```ts
// src/services/tmux/tmux-service.ts

/** A tmux key-table name. Restricted to the four 3.6a-default tables. */
export type KeyTable = 'root' | 'prefix' | 'copy-mode' | 'copy-mode-vi'

/**
 * The four allowlisted tmux commands. Tagged union — no raw command strings
 * leak into argv. Keeps `bindKey.command` immune to tmux's internal command
 * parser (which interprets `;`, `${}`, `#{}`, quotes, backslash escapes).
 */
export type BindCommand =
  | { readonly kind: 'resize-pane'; readonly mode: '-M' }
  | { readonly kind: 'select-pane'; readonly direction: '-L' | '-R' | '-U' | '-D' | '-t=' }
  | { readonly kind: 'display-message'; readonly text: string; readonly displayMs: number }

export interface UnbindKeyOptions {
  readonly socket: SocketName
  readonly table: KeyTable
  // No `all: true` — the method always emits `-a -T <table>`.
}

export interface BindKeyOptions {
  readonly socket: SocketName
  /**
   * Where to bind. `'root-no-prefix'` emits `bind-key -n` (idiomatic for
   * default-table bindings without a prefix). All other values emit
   * `bind-key -T <table>`. Encoded in the type so `table === 'root' && noPrefix === true`
   * is impossible to misuse.
   */
  readonly table: KeyTable | 'root-no-prefix'
  /**
   * Key sequence as tmux interprets it (e.g. `MouseDrag1Border`, `M-Left`,
   * `MouseDown1Pane`, `WheelUpPane`). Adapter MUST reject sequences containing
   * newline or NUL.
   */
  readonly key: string
  readonly command: BindCommand
}

export interface TmuxService {
  // ... existing methods ...

  /** `tmux -L <socket> unbind-key -a -T <table>`. */
  unbindKey(opts: UnbindKeyOptions): Promise<void>

  /**
   * `tmux -L <socket> bind-key [-n | -T <table>] <key> -- <command...>`.
   * `--` separates flags from command argv to defang any leading-`-` injection.
   * `command` is converted to argv internally per its tagged-union shape.
   */
  bindKey(opts: BindKeyOptions): Promise<void>
}

export interface CreateSessionOptions {
  // ... existing fields ...
  /**
   * Path to a tmux config file passed as `-f <path>`. When set, tmux reads
   * options from this file at startup — load-bearing for `history-limit 0`,
   * which is only honored if applied before pane allocation (tmux/tmux#4705).
   */
  readonly configPath?: Path
}
```

### Argv contracts (RealTmuxService)

```ts
// new-session with config
['tmux', '-L', socket, '-f', configPath, 'new-session', '-d', '-s', session, '-x', String(width), '-y', String(height)]

// unbindKey
['tmux', '-L', socket, 'unbind-key', '-a', '-T', table]

// bindKey, table === 'root-no-prefix'
['tmux', '-L', socket, 'bind-key', '-n', key, '--', ...commandToArgv(command)]

// bindKey, all other tables
['tmux', '-L', socket, 'bind-key', '-T', table, key, '--', ...commandToArgv(command)]
```

`commandToArgv`:

```ts
const commandToArgv = (cmd: BindCommand): readonly string[] => {
  switch (cmd.kind) {
    case 'resize-pane':     return ['resize-pane', cmd.mode]
    case 'select-pane':     return ['select-pane', cmd.direction]
    case 'display-message': return ['display-message', '-d', String(cmd.displayMs), cmd.text]
  }
}
```

### Adapter validation

```ts
// real-tmux-service.ts (excerpt)
async bindKey(opts: BindKeyOptions): Promise<void> {
  if (/[\n\0]/.test(opts.key)) {
    throw new Error(`bindKey: key ${JSON.stringify(opts.key)} contains newline or NUL`)
  }
  // command is a tagged union — no string-injection surface.
  // ... build argv, run, throw TmuxCommandError on non-zero ...
}
```

### `FakeTmuxService` additions

```ts
export type RecordedCall =
  | // ... existing variants ...
  | { readonly method: 'unbindKey'; readonly opts: UnbindKeyOptions }
  | { readonly method: 'bindKey'; readonly opts: BindKeyOptions }

async unbindKey(opts: UnbindKeyOptions): Promise<void> { this.#calls.push({ method: 'unbindKey', opts }) }
async bindKey(opts: BindKeyOptions): Promise<void>     { this.#calls.push({ method: 'bindKey', opts }) }
```

### `initOrchSession` shape after the change

```ts
// src/services/tmux/session-init.ts (sketch)

const ALLOWLIST: readonly Omit<BindKeyOptions, 'socket'>[] = [
  // 1. Drag pane border to resize
  { table: 'root',           key: 'MouseDrag1Border', command: { kind: 'resize-pane', mode: '-M' } },
  // 2. Click pane to focus
  { table: 'root',           key: 'MouseDown1Pane',   command: { kind: 'select-pane', direction: '-t=' } },
  // 3. Keyboard pane switch
  { table: 'root-no-prefix', key: 'M-Left',           command: { kind: 'select-pane', direction: '-L' } },
  { table: 'root-no-prefix', key: 'M-Right',          command: { kind: 'select-pane', direction: '-R' } },
  // 4. Native text selection — preserved by NOT touching the host terminal.
  //    Modifier varies by terminal: Apple Terminal / iTerm2 = Option, Ghostty
  //    / Alacritty / Linux = Shift. Documented in docs/getting-started.md.
  // 5. Wheel hint — discoverable feedback for the disabled scroll affordance.
  { table: 'root', key: 'WheelUpPane',     command: { kind: 'display-message', text: 'scrollback disabled — orch logs --latest --follow', displayMs: 2000 } },
  { table: 'root', key: 'WheelDownPane',   command: { kind: 'display-message', text: 'scrollback disabled — orch logs --latest --follow', displayMs: 2000 } },
  { table: 'root', key: 'WheelUpStatus',   command: { kind: 'display-message', text: 'scrollback disabled — orch logs --latest --follow', displayMs: 2000 } },
  { table: 'root', key: 'WheelDownStatus', command: { kind: 'display-message', text: 'scrollback disabled — orch logs --latest --follow', displayMs: 2000 } },
] as const

const TABLES_TO_WIPE: readonly KeyTable[] = ['root', 'prefix', 'copy-mode', 'copy-mode-vi']

export const initOrchSession = async (
  tmux: TmuxService,
  fs: FsService,
  opts: InitSessionOptions,
): Promise<void> => {
  // history-limit 0 must be set BEFORE new-session — tmux/tmux#4705 captures
  // the value at pane allocation. `mouse on` is also pre-set so MouseDrag1Border
  // takes effect on the initial pane.
  const configPath = await writeTmuxConfig(fs, [
    'set -g history-limit 0',
    'set -g mouse on',
    'set -g remain-on-exit on',
    'set -g prefix None',
  ])

  await tmux.createSession({
    socket: opts.socket,
    session: opts.session,
    width: opts.width,
    height: opts.height,
    configPath,
  })

  // Strict appliance mode — wipe, then re-bind the allowlist + wheel hint.
  for (const table of TABLES_TO_WIPE) {
    await tmux.unbindKey({ socket: opts.socket, table })
  }
  for (const item of ALLOWLIST) {
    await tmux.bindKey({ socket: opts.socket, ...item })
  }

  // Persistent status-right hint — survives `unbind-key -a` (status-format is
  // an option, not a key binding).
  await tmux.setOption({
    socket: opts.socket, target: opts.session, name: 'status-right',
    value: 'logs --latest --follow', global: true,
  })

  // pane-died hook — unaffected by `unbind-key -a` (hooks live in a separate
  // namespace from key tables — verified empirically + tmux source).
  await tmux.setHook({
    socket: opts.socket, hook: 'pane-died',
    command: opts.paneDiedCommand, global: true,
  })
}
```

### Required call ordering

Asserted by the fake-service test:

1. `fs.writeFile(configPath, …)` (the `-f` payload)
2. `createSession` with `configPath`
3. `unbindKey root` → `unbindKey prefix` → `unbindKey copy-mode` → `unbindKey copy-mode-vi`
4. `bindKey MouseDrag1Border` → `MouseDown1Pane` → `M-Left` → `M-Right` → 4× wheel hints
5. `setOption status-right`
6. `setHook pane-died`

### Tests for Phase 1+2

**Fake-service unit test** (`tests/unit/services/tmux/session-init.test.ts`):

- `initOrchSession writes a tmux config file containing history-limit 0, mouse on, remain-on-exit on, and prefix None`
- `initOrchSession passes the config path to createSession via the configPath option`
- `initOrchSession wipes all four key tables with unbind-key -a before installing any bindings`
- `initOrchSession installs exactly the four allowlist bindings followed by four wheel-display-message bindings`
- `initOrchSession installs the persistent status-right hint after the bindings are in place`
- `initOrchSession installs the pane-died hook after the bindings are in place so unbind-key cannot wipe it`

**Fake + RealTmuxService argv test** (`tests/integration/services/tmux/tmux-integration.test.ts`):

- `unbindKey emits unbind-key -a -T for the requested table`
- `bindKey with table 'root-no-prefix' emits bind-key -n followed by -- before the command argv`
- `bindKey with table 'copy-mode' emits bind-key -T copy-mode followed by -- before the command argv`
- `bindKey rejects a key containing a newline character`
- `bindKey rejects a key containing a NUL byte`
- `bindKey converts the resize-pane tagged command to ['resize-pane', '-M']`
- `bindKey converts the display-message tagged command with text and displayMs into the correct argv`
- `createSession passes the configPath argument as -f when provided`

**Real-tmux integration test** (env-gated on `Bun.which('tmux') && process.env.RUN_REAL_TMUX === '1'`):

- `after init, list-keys -T root contains exactly the four allowlist items plus the four wheel hints`
- `after init, list-keys -T prefix is empty`
- `after init, list-keys -T copy-mode is empty`
- `after init, list-keys -T copy-mode-vi is empty`
- `after init, show-options -g prefix is None`
- `after init, display-message -p '#{history_size}' returns 0 for the initial pane`
- `after init + splitPane, display-message -p '#{history_size}' returns 0 for the new pane`
- `after init + splitPane, after streaming 200 lines, display-message -p '#{history_size}' is still 0`
- `after init, set-hook -g pane-died is still installed`
- `MouseDrag1Border is bound to resize-pane -M`
- `M-Left is bound to select-pane -L on the root table`
- `WheelUpPane is bound to display-message — not unbound`
- `set -g status-right after init contains 'logs --latest --follow'`

### Definition of Done — Phase 1+2

- `bun run check` green.
- `TmuxService` interface compiles in 3 places (port, real adapter, fake adapter).
- All Phase 1+2 tests pass; pre-existing two-pane integration tests (`tests/integration/cli/two-pane-auto-attach.test.ts`, `tests/integration/hosts/tmux-host-command-line.test.ts`) still pass.
- Manual smoke (Phase 5 checklist subset): wheel-scroll on the right pane shows the hint and does not enter copy-mode; the divider can still be dragged; clicking switches focus; `M-Left/Right` switches focus; status line shows `logs --latest --follow`.

---

## Phase 3a — `orch logs --latest [--step <name>]`

**Goal:** the resolver. No tail/follow yet — keeps the diff small and the behavior reversible.

### Files

- `src/cli/main.ts` — extend `parseArgv` for `--latest`, `--step` flags
- `src/cli/commands/logs.ts` — extend `logsCmd` (resolver path)
- `src/state/run-registry.ts` — confirm `listRuns()` returns chronological order (no helper added)
- `src/state/state-store.ts` — tighten `transcriptPath` Zod schema:
  ```ts
  transcriptPath: z.string().regex(/^logs\/agents\/[a-zA-Z0-9_-]+\/events\.ndjson$/).optional()
  ```
- `tests/unit/cli/logs-command.test.ts` — NEW (note: **unit** path, fakes injected at `*Service` ports per testing-strategy skill)

### CLI surface

```
orch logs <runId> [--step <name>]
orch logs --latest [--step <name>]

Flags:
  --latest             Resolve <runId> to the most recent run.
  --step <name>        Print only the named step's transcript. Exact match
                       only in v1; no-match exits 2 with the list of valid
                       step names.
```

### Internal `RunSelector` shape

```ts
type RunSelector = { kind: 'latest' } | { kind: 'explicit'; runId: RunId }
```

`parseArgv` parses to the union (mutually exclusive at type level). Downstream `logsCmd` switches on `selector.kind` once; no per-call `latest && runId` checks scattered around.

### `--step <name>` matching (exact only in v1)

```ts
const stepQuery = opts.step
if (stepQuery === undefined) return runAllSteps(...)

const stepNames = Object.values(state.steps)
  .sort((a, b) => a.startedAt - b.startedAt)
  .map((s) => s.name)
const exact = stepNames.find((n) => n === stepQuery)
if (exact === undefined) {
  process.stderr.write(`No step matching "${stepQuery}" in run ${rid} (steps: ${stepNames.join(', ')})\n`)
  return EXIT.CONFIG_ERROR
}
const entry = state.steps[exact]
if (entry === undefined) {
  // Should be impossible — exact came from stepNames. Defensive log.
  return EXIT.INTERNAL_ERROR
}
return [entry]
```

No `!` non-null assertions (CLAUDE.md rule 6). The `if (entry === undefined)` branch satisfies `noUncheckedIndexedAccess: true`.

### Tests for Phase 3a

**Unit test** (`tests/unit/cli/logs-command.test.ts`):

- `logs --latest resolves to the most recent run id from the registry`
- `logs --latest with no runs prints "No runs found" and exits 2`
- `logs --latest and a positional runId are rejected as mutually exclusive`
- `logs <runId> --step <name> with exact match prints only that step`
- `logs <runId> --step <name> with no match exits 2 and lists the valid step names`
- `logs <runId> --step prints the step's transcript without the all-steps banner`
- `logs --latest --step <name> resolves the runId then prints that step`
- `state.json with a transcriptPath outside logs/agents/ is rejected by the Zod schema (path-traversal guard)`

### Definition of Done — Phase 3a

- `bun run check` green.
- All Phase 3a tests pass.
- Manual smoke: `orch logs --latest` prints the most recent run's transcript.

---

## Phase 3b — `orch logs --follow` + banner + persistent hint

**Goal:** the live tail. Adds `FsService.tailFile`, the banner hint, and the run-status decoupling. This is the riskier of the two — isolating it in its own PR keeps the bisect surface small.

### Files

- `src/cli/main.ts` — extend `parseArgv` for `--follow` / `-f`; add banner hint
- `src/cli/commands/logs.ts` — extend `logsCmd` for `--follow`
- `src/services/fs/fs-service.ts` — add `tailFile(baseDir, relativePath, opts): AsyncIterable<string>`
- `src/services/fs/bun-fs-service.ts` — `Bun.file().slice(offset).text()` polling impl
- `src/services/fs/fake-fs-service.ts` — scripted-content recorder
- `tests/unit/cli/logs-command.test.ts` — extend
- `tests/unit/services/fs/tail-file.test.ts` — NEW; fake-clock unit test for the tail loop
- `tests/integration/services/fs/tail-file-real.test.ts` — NEW; real-fs gated test (env: `RUN_REAL_FS=1`)

### CLI surface (delta)

```
orch logs --latest [--step <name>] [--follow | -f]
orch logs <runId> --step <name> [--follow | -f]

Flag:
  --follow, -f   Tail the named step's transcript until the run terminates
                 (status transitions out of "running") or SIGINT.
                 Requires --step in v1; multi-step follow is deferred.
```

### `tailFile` contract

```ts
// src/services/fs/fs-service.ts

export interface TailFileOptions {
  readonly abort: AbortSignal
  /** Default 100 ms. */
  readonly pollMs?: number
  /** Default 1 MB. Bounds memory if writer bursts. */
  readonly maxBytesPerTick?: number
}

/**
 * Yields complete lines (trailing `\n` stripped) from the file at
 * `path.join(baseDir, relativePath)`. Internalizes:
 * - the offset cursor
 * - the pending-partial-line buffer (partial lines NEVER emit; held until
 *   completion via `\n` or terminal flush)
 * - bounded reads (each tick reads at most `maxBytesPerTick`)
 * - rotation/truncation detection (size < offset → reset to 0, log)
 * - waiting for the file to appear (yields nothing until first byte)
 *
 * Path-traversal containment: `relativePath` is resolved against `baseDir`;
 * any resolved path that escapes `baseDir` throws synchronously.
 *
 * Termination: when `abort` fires, drains the pending-partial buffer (emits
 * if non-empty) and returns.
 */
tailFile(baseDir: Path, relativePath: string, opts: TailFileOptions): AsyncIterable<string>
```

### `--follow` consumer in `logsCmd`

```ts
const status = await deps.stateStore.loadRun(rid)
if (status !== undefined && isTerminal(status.status)) {
  // Already terminal — print whole transcript and exit, don't tail.
  return printAllSteps(...)
}

const abort = new AbortController()
process.on('SIGINT', () => { abort.abort() })

// Status poll runs at 1 s — terminal transitions are rare events.
const statusPoll = pollStatus(deps.stateStore, rid, abort.signal, 1000)

// Lines come from the tail seam.
const lines = deps.fsService.tailFile(runDir, step.transcriptPath, {
  abort: abort.signal, pollMs: 100, maxBytesPerTick: 1 << 20,
})

await Promise.race([
  drainLines(lines, step.name, format),
  waitForTerminal(statusPoll, abort),
])
return abort.signal.aborted ? EXIT.SIGINT : EXIT.OK
```

`isTerminal(status: RunStatus): boolean` returns true for `'completed' | 'failed' | 'cancelled'`. **Tests cover all three** — earlier plan only covered `completed`.

### Banner update (gated on `format !== 'json' && mode === 'two-pane'`)

```
[orch] mode=two-pane (cli: --mode override)
[orch] live progress: orch logs --latest --follow --step <step-name>
[orch] (also visible in tmux status bar)
```

The third line acknowledges AD-10's persistent `status-right` hint. Plain mode adds nothing; JSON mode emits no banner.

### `--step <name>` not yet started under `--follow`

When `--follow` is set and `--step` matches no current entry but `state.json` shows the run is still `running`, poll `state.steps` (not just file bytes) until either the step appears or the run terminates. Emit `Waiting for step "<name>" in run <rid>…` to stderr on first tick. (Without `--follow`, exit 2 immediately as in Phase 3a.)

### `--follow` waiting-for-run UX

When `state.json` doesn't exist yet (run hasn't written first event):

- First tick: emit `Waiting for run <rid> to start…` to stderr.
- Continue polling.
- On first byte appearing: emit `Resolved --latest to <rid> (workflow=<wf>, started=<t>)` if `--latest`, else just start streaming.

### Tests for Phase 3b

**Unit test** (`tests/unit/cli/logs-command.test.ts` extension):

- `logs --latest --follow --step <name> tails the running run's per-step sidecar until status transitions to completed`
- `logs --latest --follow --step <name> exits cleanly when status transitions to failed`
- `logs --latest --follow --step <name> exits cleanly when status transitions to cancelled`
- `logs --follow --step <name> on an already-terminal run prints the full transcript and exits 0 without tailing`
- `logs --follow without --step exits 2 with a hint pointing at --step`
- `logs --follow + SIGINT exits 130 and flushes the pending-partial buffer if non-empty`
- `logs --follow with --step matching no current entry prints "Waiting for step …" while the run is still running`
- `logs --latest --follow prints the resolved runId to stderr on entry`

**Tail-loop unit test** (`tests/unit/services/fs/tail-file.test.ts`, fake-clock):

- `tailFile yields one line for each newline-terminated chunk written between ticks`
- `tailFile holds a partial line across ticks until a newline arrives`
- `tailFile flushes a non-empty pending partial when abort fires`
- `tailFile resets the offset to 0 and logs a "file rotated" message when stat reports size < offset`
- `tailFile caps each tick's read at maxBytesPerTick and resumes on the next tick`
- `tailFile waits for the file to appear and yields nothing until the first byte`
- `tailFile rejects a relativePath that escapes baseDir (path-traversal guard)`

**Real-fs integration test** (env-gated `RUN_REAL_FS=1`, `tests/integration/services/fs/tail-file-real.test.ts`):

- `tailFile sees an event written by an external process and yields it within pollMs * 2`
- `tailFile resumes correctly after a logrotate-style rename + new-file replacement`

**Banner test** (extend `tests/unit/cli/banner.test.ts`):

- `the two-pane banner includes the orch logs --latest --follow hint`
- `the plain banner does not include the hint`
- `the two-pane banner with --format=json is empty`

### Definition of Done — Phase 3b

- `bun run check` green.
- All Phase 3b tests pass.
- Manual smoke: real two-pane run; from a second terminal, `orch logs --latest --follow --step <name>` shows live transcript that matches the right pane; `Ctrl-C` exits 130; the persistent `status-right` hint is visible.

---

## Phase 0 (pre-Phase 1+2) — Verify reproduction

**Goal:** confirm the reported symptoms reproduce on the user's actual `tmux -V` before building the fix. The bug-validator agent flagged that tmux 3.6a's three-flag short-circuit `#{||:#{alternate_on},#{pane_in_mode},#{mouse_any_flag}}` may already prevent copy-mode entry under alt-screen agents — and Claude Code/Codex both use the alt-screen.

### Steps

1. On the affected machine: `tmux -V` (record exact version + patch).
2. `tmux -L test -f /dev/null new-session -d 'sleep 999'` then `tmux -L test list-keys -T root | grep WheelUpPane` — record the actual binding.
3. Run a real two-pane orch session against a Claude Code agent and a Codex agent. Wheel-scroll. Record observed behavior:
   - Does it enter copy-mode? (visible: `[1/N] [type 'q' to exit]` style indicator)
   - Are `not in a mode` errors emitted?
   - Is the right-pane surface frozen?
4. Repeat with `--mode=plain` (no tmux) — confirm no symptoms.

### Expected outcomes

- **If symptoms reproduce on alt-screen:** the user's tmux is older than 3.6a-with-Oct-2025-patch, OR the agent is leaving alt-screen mid-run. Either way, the strict allowlist still fixes it.
- **If symptoms DON'T reproduce:** the bug is already fixed upstream and we're shipping defensive hardening, not a fix. Plan still ships (the hardening is independently valuable), but the brainstorm Problem Statement should be reframed.

### Definition of Done — Phase 0

- A short note appended to the plan/brainstorm with the observed `tmux -V`, the actual `WheelUpPane` binding, and the reproduction outcome.

---

## Phase 4 — Documentation

**Folded into Phase 1+2 and Phase 3b PRs** rather than a standalone phase. (Per phase-implementer skill: docs land with the code that motivates them.)

### `docs/getting-started.md` addition (lands with Phase 1+2)

A new subsection inside the §"Two-pane mode" block:

```markdown
### Appliance mode (two-pane only)

When you run `orch run <workflow> --mode=two-pane`, orch owns the terminal
until the run completes. The session is locked down to four interactions:

| Action                          | How                                                |
|---------------------------------|----------------------------------------------------|
| Resize the divider              | Drag the pane border with the mouse                |
| Switch focus                    | Click a pane, or press `M-Left` / `M-Right`        |
| Select text                     | Hold a modifier (see terminal matrix) and drag     |
| Watch live progress elsewhere   | `orch logs --latest --follow --step <name>` in another tab |

#### Text-selection modifier matrix

| Terminal           | Modifier              |
|--------------------|-----------------------|
| Apple Terminal     | Option                |
| iTerm2             | Option (or Cmd-drag)  |
| Ghostty            | Shift                 |
| Alacritty          | Shift                 |
| WezTerm            | Shift                 |
| Linux GNOME / xterm/ kitty | Shift         |

Mouse-wheel scrolling shows a 2-second hint pointing at `orch logs` instead
of entering copy-mode. Real history lives in `.orch/state/<runId>/logs/` and
is durable across runs (see [logging.md](logging.md)).

The run ends in one of three ways:
- Clean completion → orch detaches, your shell returns.
- Step failure → orch prints a summary and exits non-zero.
- `Ctrl-C` to orch → SIGINT cancels the run.

There is no mid-run detach in v1. If you want to step away, use a second
terminal and `orch logs --latest --follow --step <name>`.

> **SSH / mosh note:** `M-Left` / `M-Right` may be intercepted by mosh or an
> outer screen/tmux session. Click-to-focus and drag-to-resize work over SSH;
> `M-Left/Right` may not.
>
> **Windows note:** `M-Left` / `M-Right` are intercepted by Windows Terminal
> and Tabby upstream of tmux ([microsoft/terminal#4763](https://github.com/microsoft/terminal/issues/4763)).
> Click-to-focus and drag-to-resize still work; keyboard pane switching may not.
```

### `docs/logging.md` addition (lands with Phase 3b)

Add near the top of "Where it lives":

```markdown
For a live tail of the most recent run:

    orch logs --latest --follow --step <step-name>

The on-disk path is `<cwd>/.orch/state/<runId>/logs/agents/<step>/events.ndjson`.
```

### `docs/plans/implementation-phases.md`

Mark this plan as landed once Phase 1+2, Phase 3a, and Phase 3b have all merged.

---

## Phase 5 — Manual verification (PR description, not a phase)

Moved to the final PR's description per phase-implementer skill. The checklist below covers the combined behavior:

- [ ] `bun run examples/<demo>` in two-pane mode; wheel-scroll on the right pane during a streaming step → status line shows `scrollback disabled — orch logs --latest --follow`, no copy-mode, no `not in a mode` errors, no surface freeze.
- [ ] During the same run, drag the divider → resizes.
- [ ] Click left pane → focus moves; click right → moves back.
- [ ] `M-Left` / `M-Right` → focus toggles.
- [ ] Hold the right modifier (per matrix), drag → terminal text selection works.
- [ ] In a second terminal during the run: `orch logs --latest --follow --step <name>` shows live events that match the right pane.
- [ ] Cancel mid-run with `Ctrl-C` → exit code 130, panes torn down, terminal restored.
- [ ] After completion: `orch logs --latest --step <name>` prints that step's transcript.
- [ ] `orch logs --latest --step <bogus>` exits 2 with the list of valid step names.
- [ ] After a workflow that writes a 200-line burst inside one event payload (single NDJSON line > 4 KB), `--follow` prints the line atomically (no split rendering).
- [ ] Status line shows `logs --latest --follow` throughout the run.
- [ ] Smoke on Ghostty + WezTerm in addition to Apple Terminal + iTerm2 (note Shift vs Option modifier).
- [ ] Smoke on iTerm2 with Cmd-click on a URL — confirm URL opens (i.e., `MouseDown1Pane` doesn't swallow Cmd-click).

### Cleanup

- Update `src/services/tmux/session-init.ts:23` JSDoc to mention `prefix None`, the four-item allowlist, the wheel hint, the persistent status-right, and `history-limit 0` via `-f` config.
- If a nested-tmux error message in `src/cli/two-pane-attach.ts` recommends `C-b d` as an escape — update to point at `orch logs --latest --follow` instead.

---

## Acceptance Criteria

### Functional

- [ ] Wheel-scroll on either pane shows a 2-second hint and does not enter copy-mode, emit `not in a mode`, or freeze the surface.
- [ ] `C-b` is inert at the tmux layer; the keystroke reaches the running process unmodified.
- [ ] Drag-to-resize, click-to-focus, and `M-Left/Right` pane switch all work.
- [ ] Native terminal text selection works with the per-terminal modifier (Option on Apple Terminal/iTerm2, Shift elsewhere).
- [ ] `history-limit 0` is in effect for both initial and split panes (verified via `display-message -p '#{history_size}' === 0` after a 200-line stream).
- [ ] `orch logs --latest` resolves to the most recent run.
- [ ] `orch logs <runId> --step <name>` exits 2 with valid-step list when no exact match.
- [ ] `orch logs --latest --follow --step <name>` tails until the run reaches `completed`, `failed`, or `cancelled`.
- [ ] `orch logs --follow + SIGINT` exits 130 and flushes any pending partial line.
- [ ] Two-pane banner includes the `orch logs --latest --follow --step <name>` hint and references the status-bar persistence.
- [ ] tmux `status-right` shows `logs --latest --follow` throughout the run.

### Non-functional

- [ ] No new public API on `TmuxService` beyond `unbindKey` and `bindKey` (down from three).
- [ ] No generic `runTmuxCommand` escape hatch.
- [ ] `bindKey.command` is a tagged union — no raw command-language strings reach tmux's parser.
- [ ] No regressions in existing tmux integration tests.
- [ ] `bun run check` green.

### Quality gates

- [ ] Each new test name reads as a full sentence (project rule 4).
- [ ] No `mock.module` / `vi.mock` / `jest.mock` in `src/services/tmux/`, `src/state/`, `src/core/`, `src/runners/` test files (project rule 3).
- [ ] No `child_process` / `Bun.spawn` outside `src/services/process/` (project rule 1).
- [ ] No `!` non-null assertions, no `any` (project rule 6).
- [ ] All new files ≤ 300 lines, all new functions ≤ 60 lines.
- [ ] `--follow` partial-line bug regression test green (the `pendingPartial` carry test).
- [ ] `transcriptPath` Zod regex regression test green.

---

## Dependencies & Risks

| Risk | Probability | Mitigation |
|------|-------------|------------|
| `unbind-key -a -T <table>` syntax differs across tmux versions | None | Floored at tmux ≥ 3.2; `-a -T` shipped in 2.4. Phase 1+2 real-tmux test pins the contract. Empirically verified on 3.6a. |
| `prefix None` rejected on tmux < 3.1 | None | Floored at tmux ≥ 3.2. Verified case-insensitive on 3.6a. |
| `history-limit 0` doesn't apply to existing panes | **Resolved** | AD-4 sets it via `-f` config before `new-session`. Phase 1+2 `display-message #{history_size}` test verifies. |
| `M-Left` / `M-Right` collide with bash readline word-jump | Low | `readline` reads from stdin; tmux intercepts at the pane layer before bytes reach the shell. `M-f` / `M-b` are the readline jumps; `M-Left/Right` are arrow-key sequences (`\e[1;3D` / `\e[1;3C`) that bash readline does NOT bind by default. |
| `M-Left` / `M-Right` intercepted by SSH / mosh / outer multiplexer | Medium | Documented in `getting-started.md`. Click-to-focus + drag-to-resize unaffected. |
| `--follow` partial-line corruption on writes > syscall atomicity boundary | **Resolved** | `tailFile` carries `pendingPartial`; only emits on `\n`. Tests (`tail-file.test.ts`) cover. |
| `--follow` + concurrent runs picks the wrong run | Low | AD-7: `--latest` is a snapshot resolver. Resolved-runId stderr line gives user visibility. |
| `pane-died` hook accidentally wiped by `unbind-key -a` | None | Hooks live in a separate namespace. Verified empirically + Phase 1+2 real-tmux test. |
| `FsService.tailFile` rotation handling | Low | `stat().size < offset` → reset to 0 + log "file rotated". Real-fs gated test covers. |
| `bindKey.command` future caller passes attacker-controlled tmux command | **Resolved** | Tagged-union type — no raw string reaches argv. The four shapes are the only legal ones. |
| `transcriptPath` path traversal on read | **Resolved** | Zod regex on `state.json` schema; `tailFile` resolves under `baseDir` and rejects escapes. |
| New banner line breaks JSON-mode parsers | None | Hint gated on `format !== 'json'`. |
| Reproduction may not occur on alt-screen agents in tmux 3.6a | Medium | Phase 0 verifies before building. The fix is independently valuable as defensive hardening even if the bug is upstream-fixed. |

---

## Resolved Brainstorm Open Questions

These were called out as "captured so they aren't lost" — answers below.

- **Ordering of `mouse on` and `unbind-key -a -T root`** → option (via `-f` config before new-session) → unbind → bind, asserted in fake-service test (AD-2, Phase 1+2).
- **`TmuxService` API shape** → two explicit methods, no escape hatch, tagged-union command (AD-1, Phase 1+2). Validation: reject newline/NUL in `key`; tagged union eliminates command-string parser hazard.
- **`history-limit 0` verification surface** → `display-message -p '#{history_size}'` assertion `=== 0` after a 200-line stream (Phase 1+2 real-tmux test). `capture-pane -p` was wrong — returned viewport only.
- **`orch logs` flag/output details** → AD-6, AD-7, Phases 3a/3b. Exact match only (no prefix in v1), snapshot `--latest`, `--follow + --step` only in v1.
- **Banner copy** → `[orch] live progress: orch logs --latest --follow --step <step-name>` plus persistent `status-right` (AD-10), two-pane only, non-JSON only.
- **Windows note for `M-Left/Right`** → Phase 4 docs (folded into Phase 1+2 PR).
- **Wheel handling under alt-screen** → Phase 0 verifies; AD-9 binds wheel events to a discoverable `display-message` instead of leaving them unbound.

---

## References

### Internal

- Brainstorm: [`docs/brainstorms/2026-05-05-tmux-strict-sandbox-brainstorm.md`](../brainstorms/2026-05-05-tmux-strict-sandbox-brainstorm.md)
- Project rules: [`CLAUDE.md`](../../CLAUDE.md)
- Skills: `.claude/skills/phase-implementer`, `.claude/skills/testing-strategy`
- Prior learning (same module): [`docs/solutions/two-pane-auto-attach.md`](../solutions/two-pane-auto-attach.md) — naming-collision lesson; this plan avoids it (no `attach`-named anything).
- `src/services/tmux/session-init.ts:43` — current `initOrchSession`
- `src/services/tmux/real-tmux-service.ts:79` — `-f /dev/null` rationale (now becomes `-f <generated>` for the strict path)
- `src/services/tmux/tmux-service.ts:227` — `TmuxService` interface
- `src/services/tmux/fake-tmux-service.ts:39` — `RecordedCall` discriminated union
- `src/services/fs/fs-service.ts` — `FsService` port (gains `tailFile` in Phase 3b)
- `src/cli/commands/logs.ts` — current `logsCmd` (extended in Phases 3a/3b)
- `src/cli/main.ts:127` — `parseArgv`
- `src/state/run-registry.ts:36` — `findByPrefix` (the matching idiom; **not** mirrored for `--step` in v1)
- `src/state/state-store.ts` — `transcriptPath` Zod schema (tightened in Phase 3a)
- `src/cli/detect-tmux.ts` — tmux version floor

### External — verified

- [tmux/tmux source @ 3.6a `key-bindings.c`](https://raw.githubusercontent.com/tmux/tmux/3.6a/key-bindings.c) — actual `WheelUpPane` default
- [tmux/tmux source @ 3.6a `cmd-send-keys.c`](https://raw.githubusercontent.com/tmux/tmux/3.6a/cmd-send-keys.c) — origin of `not in a mode` error
- [tmux/tmux#4705](https://github.com/tmux/tmux/issues/4705) — `history-limit` is captured at pane-creation time
- [tmux/tmux#638](https://github.com/tmux/tmux/issues/638) — `not in a mode` regression
- [tmux/tmux#3705](https://github.com/tmux/tmux/issues/3705) — disable copy-mode-on-wheel under alt-screen (the Oct 2025 fix that may already cover the user's case)
- [tmux/tmux#729](https://github.com/tmux/tmux/issues/729) — canonical reset-bindings pattern
- [anthropics/claude-code#38810](https://github.com/anthropics/claude-code/issues/38810) — wheel-in-tmux broken upstream
- [openai/codex#8555](https://github.com/openai/codex/pull/8555) — `--no-alt-screen` (deferred follow-up)
- [microsoft/terminal#4763](https://github.com/microsoft/terminal/issues/4763) — Windows Terminal intercepts `M-Left/Right`
- [Bun File I/O docs](https://bun.sh/docs/api/file-io) — `Bun.file().slice(offset).text()` semantics
- [GNU `tail(1)` manual](https://www.gnu.org/software/coreutils/manual/html_node/tail-invocation.html) — `tail -F --retry` semantics that `tailFile` mirrors
- [nxadm/tail#25](https://github.com/nxadm/tail/issues/25) — partial-line bugs are #1 reported defect; `pendingPartial` carry is the standard fix
- [git rev-parse](https://git-scm.com/docs/git-rev-parse) — exact-then-prefix matching prior art (deferred to v2 here)
- [samoshkin tmux toggle gist](https://gist.github.com/samoshkin/05e65f7f1c9b55d3fc7690b59d678734) — `prefix None` appliance pattern
- [Anthropic terminal-config](https://code.claude.com/docs/en/terminal-config) — `extended-keys`, `allow-passthrough`, `terminal-features`

### Empirical (this machine, 2026-05-05)

- tmux 3.6a `list-keys -T root | grep WheelUpPane` confirms three-flag short-circuit
- `display-message -p '#{history_size}'` returns 0 after `set -g history-limit 0` only on newly-created panes
- `capture-pane -p` returns viewport only (~24 lines on 80×24); `-p -S -` needed for full scrollback
- `Bun.file().slice(offset).text()` is lazy; `offset > size` returns `""`
- Node `util.parseArgs` supports `short: 'f'` aliases (Bun 1.3.8)
