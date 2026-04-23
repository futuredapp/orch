---
date: 2026-04-17
topic: orch-reframe user stories
source: 2026-04-16-orch-reframe-brainstorm.md
revised: 2026-04-17 (DX review — ten decisions folded in)
---

# User stories — "if I run this script, here is what I see"

Seven small scripts, each with the script, the relevant `orch.config.ts`
slice, and ASCII snapshots of the terminal at each meaningful moment.

Stories are split into two groups:

- **v1 stories** — ship with the reframe. Two view kinds (`interactive`,
  `transcript`), two panes (`left`, `right`), three run modes (`plain`,
  `single-pane`, `two-pane`). Happy path + failure path + three-mode proof.
- **v2+ stories** — show where the v1 seams lead. Sidecars, approval gates,
  files views, tmux hotkey-swapped global sidecars, split-pane parallel. Not
  built in v1, but every v1 decision preserves the door.

Scripts use today's `run(name, opts)` API (kept as-is after the DX review —
`step.define()` was dropped as unneeded ceremony). Orch owns zero keystrokes
in v1; tmux and the agent PTY own their respective domains.

---

# Part I — v1 stories (what ships with the reframe)

Recap of the v1 surface:

- **Run modes:** `plain` (CI, no panes), `single-pane` (one terminal, no tmux,
  full-screen TUI via alt screen), `two-pane` (tmux, fixed `left` + `right`,
  always shown).
- **Panes in v1:** exactly two, named `left` and `right`.
- **View kinds in v1:** `interactive`, `transcript`. Agent ships a default;
  step may override. A separate `silent: true` field opts a step out entirely.
- **Orch keystrokes in v1:** zero. Agents own their PTY, tmux owns pane
  navigation, orch just paints. Exit via tmux session kill; resume via CLI.
- **Interactive "done" signal:** the agent's PTY exits. No orch-level advance
  keystroke, no timeout. Users cancel via the agent's native kill (Ctrl+C+C
  for Claude Code / Codex).
- **Failure handling:** inline error in transcript + halt + non-zero exit +
  `orch resume` / `orch logs` hints. Continue-on-error is v2.
- **Parallel in two-pane:** compact rollup only (no per-branch transcripts).
  Full parallel UX ships in `plain` / `single-pane`; split-pane in v2.
- **Heartbeat:** `idle` clock alongside `elapsed`; resets on any runner event.
- **`plain` output:** `--format=text` (default, human) or `--format=json`
  (JSONL for CI). First-run banner suppressed under JSON.
- **Observability default:** autonomous steps always render a readable
  transcript *somewhere* — never silent by accident.

---

## Story 1 — "Hello, compound" (plan → implement → review, two-pane)

The canonical autonomous chain. Three steps, all `transcript`, nothing
interactive. This is what people type first.

**`orch.config.ts`**

```ts
export default {
  // v1: the only knob is which mode to default to when autodetect can't decide.
  // Panes are fixed `left` + `right` — not user-configurable yet.
  defaultMode: 'two-pane',
}
```

**`workflows/compound.ts`**

```ts
export default workflow('compound', async (run, args) => {
  const plan   = await run('plan',   { agent: claude(), prompt: args.task })
  const impl   = await run('build',  { agent: codex(),  prompt: plan.value })
  const review = await run('review', { agent: claude(), prompt: impl.value })
  return review.value
})
```

**Invocation**

```
$ orch run compound "add a /health endpoint"
[orch] mode=two-pane (auto: TTY + tmux) · --mode=plain|single-pane to override
```

The first-run banner prints on every run (suppressed under `--format=json`).
It makes the three-mode mental model discoverable with zero config.

### Moment A — step 1 running

```
┌─ left · status ────────────────┬─ right · plan (transcript) ───────────────┐
│                                │                                           │
│  ● plan       running  0:12    │ claude> Let me map the surface area.      │
│  ○ build      pending          │ ▸ tool: read_file(src/server/routes.ts)   │
│  ○ review     pending          │ ▸ tool: grep("health", src/)              │
│                                │                                           │
│  runId r-2026-04-17-k3f9       │ claude> I'll add a GET /health returning  │
│  cost  $0.03 · 4.1k tokens     │         200 and a JSON body with status,  │
│  elapsed 0:12                  │         uptime, and version.              │
│       idle    0:03             │                                           │
│                                │                                           │
└────────────────────────────────┴───────────────────────────────────────────┘
```

Left = status loop (the old status pane repurposed as `left`'s default view).
The `idle` line increments while no runner event has arrived; any event
resets it to `0:00`. That's how users tell "thinking" from "wedged" at a
glance — no spinner needed.

Right = readable transcript: tool calls summarized, assistant prose inline. No
raw `runnerEvent:{...}` lines — this is the #1 win over today's observe pane.

### Moment B — step 2 starting, right pane swaps view

```
┌─ left · status ────────────────┬─ right · build (transcript) ──────────────┐
│                                │                                           │
│  ✓ plan       done     0:31    │ codex> Applying plan from previous step.  │
│  ● build      running  0:04    │ ▸ tool: write_file(src/server/health.ts)  │
│  ○ review     pending          │ ▸ tool: edit(src/server/routes.ts)        │
│                                │                                           │
│  runId r-2026-04-17-k3f9       │ codex> Added handler + registered route.  │
│  cost  $0.08 · 11.2k tokens    │         Running tests next.               │
│  elapsed 0:35                  │                                           │
│       idle    0:01             │                                           │
│                                │                                           │
└────────────────────────────────┴───────────────────────────────────────────┘
```

The right pane re-renders as step 2 takes the slot; left ticks a checkmark and
opens `build`. No pane moved, no split changed — same two-pane frame all the way through.

### Moment C — all done, right pane now shows final step's transcript

```
┌─ left · status ────────────────┬─ right · review (transcript, final) ──────┐
│                                │                                           │
│  ✓ plan       done     0:31    │ claude> Checked plan vs. implementation.  │
│  ✓ build      done     1:52    │ claude> Verdict: ship.                    │
│  ✓ review     done     0:44    │                                           │
│                                │ Files touched:                            │
│  runId r-2026-04-17-k3f9       │   src/server/health.ts     (new, 14)      │
│  cost  $0.24 · 38.6k tokens    │   src/server/routes.ts     (+2)           │
│  elapsed 3:07                  │   tests/health.test.ts     (new, 22)      │
│                                │                                           │
│                                │ Tests green. No lint issues.              │
└────────────────────────────────┴───────────────────────────────────────────┘
```

The right pane stays on the final step's transcript; left's status rolls up
totals. Orch owns zero hotkeys — exit via the tmux session (`prefix+&` /
close window); resume via CLI (`orch resume r-2026-04-17-k3f9`). Durable
state is the point, not an in-TUI menu.

> *Future direction (v2):* post-step auto-swap to a rendered `summary` view
> and an `approval` gate view are designed for; see Part II.

---

## Story 1.5 — "A step fails" (failure path, two-pane)

Same `compound` workflow as Story 1. Step 2 fails because a path doesn't
exist. This is the most-reached-for UX after the happy path — v1 owns it.

**Invocation (same as Story 1)**

```
$ orch run compound "refactor the health endpoint"
[orch] mode=two-pane (auto: TTY + tmux) · --mode=plain|single-pane to override
```

### Moment A — build step fails mid-run

```
┌─ left · status ────────────────┬─ right · build (failed) ──────────────────┐
│                                │ codex> Applying plan from previous step.  │
│  ✓ plan       done     0:31    │ ▸ tool: write_file(src/server/health.ts)  │
│  ✗ build      failed   0:18    │ ▸ tool: edit(src/server/routes.ts)        │
│  · review     skipped          │                                           │
│                                │ ✗ error: ENOENT src/server/routes.ts      │
│  runId r-2026-04-17-k3f9       │   at codex-runner:exec (codex/exec.ts:142)│
│  cost  $0.11 · 14.8k tokens    │   at workflow.execute  (workflow.ts:89)   │
│  elapsed 0:49  · exit 1        │                                           │
│                                │ orch resume r-2026-04-17-k3f9  # retry    │
│                                │ orch logs   r-2026-04-17-k3f9  # full log │
└────────────────────────────────┴───────────────────────────────────────────┘
```

What the decisions buy us:

- **Inline, not modal.** The error renders where the user was already
  looking — no popup, no focus steal, no extra view kind in v1.
- **Left pane freezes the picture.** `✗ build failed`, `· review skipped`,
  `exit 1`. The whole state is visible at a glance.
- **Resume hints in the pane, not in a hotkey.** Copy-pasteable commands
  reinforce that resume is a durable CLI surface, not ephemeral UI.
- **Continue-on-error is explicitly v2.** Simpler v1 semantics: any failed
  step halts the run. Workflows that want branching error handling wait.

---

## Story 2 — "Same workflow, three modes" (host-agnostic proof)

The exact same `workflows/compound.ts` from Story 1, invoked three different
ways. Proves a workflow file never forks on host.

### Mode 1: `plain` — CI / piped / GitHub Actions

**Invocation**

```
$ orch run compound "add /health" --mode=plain
```

**Output (stdout only, no tmux, no panes)**

```
[orch] run compound  r-2026-04-17-k3f9
[orch] plan          start
[plan] claude> Let me map the surface area.
[plan] tool read_file src/server/routes.ts
[plan] tool grep "health" src/
[plan] claude> I'll add GET /health returning 200 + JSON.
[orch] plan          done   31s  $0.03
[orch] build         start
[build] codex> Applying plan.
[build] tool write_file src/server/health.ts
[build] tool edit src/server/routes.ts
[orch] build         done   1m52s  $0.14
[orch] review        start
[review] claude> Verdict: ship.
[orch] review        done   44s  $0.07
[orch] run compound  ok     3m07s  $0.24
```

`[orch]` = what the `left` pane would have said. `[stepname]` = what the
`right` pane transcript would have said. Same view declarations, different
render target.

**Same run, `--format=json` for CI log ingestion**

```
$ orch run compound "add /health" --mode=plain --format=json
{"ts":"2026-04-17T12:00:01Z","run":"r-k3f9","ev":"run.start","workflow":"compound"}
{"ts":"2026-04-17T12:00:01Z","run":"r-k3f9","ev":"step.start","step":"plan"}
{"ts":"2026-04-17T12:00:04Z","run":"r-k3f9","ev":"assistant","step":"plan","text":"Let me map the surface area."}
{"ts":"2026-04-17T12:00:05Z","run":"r-k3f9","ev":"tool","step":"plan","name":"read_file","args":{"path":"src/server/routes.ts"}}
{"ts":"2026-04-17T12:00:32Z","run":"r-k3f9","ev":"step.end","step":"plan","ms":31000,"cost":0.03,"tokens":4100}
...
{"ts":"2026-04-17T12:03:08Z","run":"r-k3f9","ev":"run.end","ok":true,"ms":187000,"cost":0.24}
```

One JSON object per line (JSONL). Essential for piping into Loki, Datadog,
or a local log file. The first-run banner is suppressed under
`--format=json` so the stream stays clean for parsers.

### Mode 2: `single-pane` — laptop without tmux

**Invocation**

```
$ orch run compound "add /health" --mode=single-pane
```

**Output (full-screen takeover of the current terminal, TUI-style)**

```
┌─ orch · compound · build (transcript) ──────────────────────────────────────┐
│ status: ✓ plan  ● build  ○ review       runId r-2026-04-17-k3f9            │
│ elapsed 0:35  ·  cost $0.08  ·  11.2k tokens                                │
├─────────────────────────────────────────────────────────────────────────────┤
│ codex> Applying plan from previous step.                                    │
│ ▸ tool: write_file(src/server/health.ts)                                    │
│ ▸ tool: edit(src/server/routes.ts)                                          │
│                                                                             │
│ codex> Added handler + registered route. Running tests next.                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

Single pane shows the active step's view; status is condensed into a header
strip. If a step were `interactive`, this whole frame becomes a real PTY.

**Alt screen + restore.** Single-pane uses the terminal's alt screen (like
`lazygit`, `htop`, `k9s`). On exit — clean, error, or Ctrl+C — orch restores
the user's scrollback and prints a one-line run summary to stdout. The
user's shell session is exactly where they left it.

### Mode 3: `two-pane` — exactly Story 1

Full left + right layout (see Story 1 moments A–C).

**What this proves:** the workflow file didn't change. The step definitions
didn't change. Only the `--mode` flag changed, and orch chose the right
renderer for the host.

---

## Story 3 — "Two agents, one verdict" (parallel in two-pane)

Fan out Claude and Codex on the same brief; reviewer picks. Three logical
steps, two panes. In v1 the parallel step shows a **compact status rollup
only** — no per-branch transcripts inside two-pane. Full transcripts are
available in `plain` and `single-pane`, or via `orch logs <runId>`. The
split-pane-per-branch experience ships in v2 with the layout-tree work.

**`workflows/duel.ts`**

```ts
export default workflow('duel', async (run, args) => {
  const plan = await run('plan', { agent: claude(), prompt: args.task })

  const [a, b] = await run.parallel([
    { name: 'claude-impl', agent: claude(), prompt: plan.value },
    { name: 'codex-impl',  agent: codex(),  prompt: plan.value },
  ])

  const verdict = await run('review', {
    agent:  claude(),
    view:   'interactive',        // I want to be in the loop on the pick
    prompt: `Choose between:\nA: ${a.value}\nB: ${b.value}`,
  })
  return verdict.value
})
```

### Moment A — parallel step, compact rollup in the right pane (v1)

```
┌─ left · status ────────────────┬─ right · parallel (2 branches) ───────────┐
│                                │                                           │
│  ✓ plan           0:28         │ [A] claude-impl   running  0:41           │
│  ● parallel       0:41         │     ▸ 6 tool calls · 2.1k tokens · $0.07  │
│    ├─ claude-impl running      │     idle 0:02                             │
│    └─ codex-impl  running      │                                           │
│  ○ review         pending      │ [B] codex-impl    running  0:37           │
│                                │     ▸ 4 tool calls · 1.8k tokens · $0.05  │
│  cost  $0.14 · 22k tokens      │     idle 0:09                             │
│  elapsed 1:09                  │                                           │
│       idle    0:02             │ (full transcripts: --mode=plain,          │
│                                │  --mode=single-pane, or `orch logs`)      │
└────────────────────────────────┴───────────────────────────────────────────┘
```

**Why compact, not focused-tail?** Focused tail would need orch to own `tab`
(focus) and `s` (split) keystrokes — but we decided orch owns zero keystrokes
in v1. Doing it properly needs the v2 layout tree and tmux `split-window`.
Until then, the compact rollup is honest: each branch's state, activity, and
cost are visible; full output is one CLI command away.

### Moment B — review step, interactive takes the right pane

```
┌─ left · status ────────────────┬─ right · review (interactive) ────────────┐
│                                │                                           │
│  ✓ plan           0:28         │ ● Claude Code                             │
│  ✓ parallel       2:03         │                                           │
│    ├─ claude-impl done         │ Candidate A (claude) — signed cookie      │
│    └─ codex-impl  done         │   handler, 48 LoC, 2 tests                │
│  ● review         running      │                                           │
│                                │ Candidate B (codex) — same handler,       │
│  cost  $0.51 · 79k tokens      │   38 LoC, 3 tests, shares token util      │
│  elapsed 2:44                  │                                           │
│       idle    0:01             │ > I'll take B. Want me to delete A's      │
│                                │   branch state?                           │
│                                │ [y/n] _                                   │
└────────────────────────────────┴───────────────────────────────────────────┘
```

Interactive wins the pane because autonomous output is reviewable later from
state; interactive can't be. The PTY is real — colors, keystrokes, the works.
The `[y/n]` prompt is the agent's own, not orch's.

> *Future direction (v2):* tmux auto-splits the right pane into N for
> parallel branches and merges back on completion — see Part II for the
> mechanism.

---

# Part II — v2+ stories (future direction, not v1)

The stories below use features the v1 seams were explicitly shaped to
accept later: step sidecars, custom view kinds (`files`, `approval`, `exec`),
and global sidecars with tmux-bound hotkeys. **None ship in v1.** They're
included here so the v1 decisions can be sanity-checked against the shape
they'll grow into.

---

## Story 4 — "Drive + lazygit" (global sidecars + tmux hotkeys) · v2

Power user: right pane starts on the step's transcript, but I want to pop
`lazygit` into it with a keystroke, stage a hunk, and pop back.

**`orch.config.ts` (v2 shape)**

```ts
export default {
  defaultMode: 'two-pane',
  globalSidecars: [
    { name: 'git',   command: ['lazygit'],       key: 'L' },
    { name: 'tests', command: ['watch', 'bun', 'test'], key: 'T' },
    { name: 'plan',  command: ['bat', 'docs/plan.md'],  key: 'P' },
  ],
  // v2: adding `top` / `bottom` / custom names is additive. Left/right stays valid.
}
```

On startup orch binds tmux keys via `tmux bind-key -T prefix L run-shell
'orch sidecar swap right git'`. The bound subcommand talks to the running
workflow over a local Unix socket (`$XDG_RUNTIME_DIR/orch/<runId>.sock`).

### Moment A — agent running, default right pane view

```
┌─ left · status ────────────────┬─ right · pair (interactive) ──────────────┐
│                                │                                           │
│  ● pair       running  1:04    │ ● Claude Code                             │
│                                │                                           │
│  [prefix + L] lazygit          │ > I'll start by mapping every call site   │
│  [prefix + T] bun test watch   │   of `verifyJwt`. Can I run tests after?  │
│  [prefix + P] plan             │                                           │
│  [prefix + B] back             │ [y/n] yes                                 │
│                                │ ▸ running: bun test auth                  │
│                                │                                           │
└────────────────────────────────┴───────────────────────────────────────────┘
```

Left pane shows the registered sidecar menu alongside status (cheap discovery).

### Moment B — `prefix + L` pressed, right pane hot-swaps to lazygit

```
┌─ left · status ────────────────┬─ right · sidecar · lazygit ───────────────┐
│                                │                                           │
│  ● pair       running  1:22    │ Unstaged Changes                          │
│                                │  M src/auth/session.ts                    │
│  ← right swapped to `lazygit`  │  M src/auth/middleware.ts                 │
│    step view preserved         │  ? tests/auth/cookie.test.ts              │
│                                │                                           │
│  [prefix + B] back to step     │ Staged Changes                            │
│                                │  (empty)                                  │
│                                │                                           │
└────────────────────────────────┴───────────────────────────────────────────┘
```

Mechanically: `tmux respawn-pane -k -t right 'lazygit'` + orch pushes the
step's view onto a per-pane stack. `prefix + B` pops the stack and
`respawn-pane`s back into the live step transcript — no state lost, the step
kept running throughout.

---

## Story 5 — "Approve before implementing" (approval view kind) · v2

A proposed `approval` view kind: an autonomous step produces a plan; orch
pauses with a rendered diff; I press y/n; the next step runs (or doesn't).

**`workflows/gated.ts`**

```ts
export default workflow('gated', async (run, args) => {
  const plan = await run('plan', { agent: claude(), prompt: args.task })

  await run('approve-plan', {
    view:   { kind: 'approval', pane: 'right', body: plan.value },
    prompt: 'Proceed with this plan?',
  })

  const impl = await run('build', { agent: codex(), prompt: plan.value })
  return impl.value
})
```

### Moment A — approval pause

```
┌─ left · status ────────────────┬─ right · approve-plan ────────────────────┐
│                                │                                           │
│  ✓ plan       done     0:44    │ ## Plan for "rework rate-limiter"         │
│  ⏸ approve    waiting          │                                           │
│  ○ build      pending          │ 1. Extract sliding-window algorithm into  │
│                                │    src/rate/window.ts                     │
│  cost  $0.09 · 14k tokens      │ 2. Replace global map with per-route      │
│  elapsed 0:44                  │    LRU (capped at 10k).                   │
│                                │ 3. Keep public API; only internals move.  │
│  [y] approve  [n] abort        │ 4. Add 6 unit tests.                      │
│  [e] edit prompt and replan    │                                           │
│                                │ Est. diff size: +220 / -90 LoC.           │
│                                │                                           │
└────────────────────────────────┴───────────────────────────────────────────┘
```

A first-class step kind rather than a clever trick: orch halts, renders `body`
as markdown, listens for one keystroke. `[e]` re-opens `plan` with an edited
prompt. Fits naturally onto v1's view interface — that's why v1 ships the
interface as an internal seam.

---

## Story 6 — "Watch the docs change" (sidecar + files view) · v2

A doc-editor agent rewrites a handful of files. A **per-step sidecar**
attached to the `left` pane shows a live list + diffstat as it happens.

**`workflows/docs.ts`**

```ts
export default workflow('docs', async (run, args) => {
  await run('refresh', {
    agent:   claude(),
    prompt:  args.task,
    view:    { kind: 'transcript', pane: 'right' },
    sidecar: { kind: 'files', pane: 'left', glob: 'docs/**/*.md' },
  })
})
```

### Moment A — mid-step

```
┌─ left · sidecar · files ───────┬─ right · refresh (transcript) ────────────┐
│                                │                                           │
│ docs/**/*.md                   │ claude> Updating getting-started to       │
│                                │         match the 2.4 CLI surface.        │
│  M README.md          +3 -1    │                                           │
│  M docs/getting-started.md     │ ▸ tool: edit(docs/getting-started.md)     │
│                       +41 -22  │ ▸ tool: edit(docs/cli-reference.md)       │
│  M docs/cli-reference.md       │                                           │
│                       +8  -8   │ claude> Regenerating flag table from      │
│  ? docs/recipes/resume.md      │         src/cli/flags.ts.                 │
│                       new 34   │                                           │
│                                │                                           │
│  Σ  3 modified, 1 new   +86 -31│                                           │
└────────────────────────────────┴───────────────────────────────────────────┘
```

The left pane's default view (status) is preempted by the step's `sidecar`
for the step's lifetime, then restored. Mechanically identical to Story 4's
global-sidecar swap, but scoped to a single step.

---

## What each story proves about the reframe

| Story                     | Scope | Proves                                                                      |
|---------------------------|-------|-----------------------------------------------------------------------------|
| 1 compound                | v1    | `transcript` default, fixed left/right layout, observability-by-default, idle clock, first-run banner |
| 1.5 a step fails          | v1    | Inline error + halt + `orch resume` / `orch logs` hints — zero new view kinds |
| 2 three modes             | v1    | Same workflow degrades cleanly across `plain` (+ JSONL), `single-pane` (alt screen), `two-pane` |
| 3 duel                    | v1    | Compact parallel rollup in two-pane; interactive wins the non-status pane; zero orch hotkeys |
| 4 drive + lazygit         | v2    | Global sidecars via tmux `bind-key` + `respawn-pane` + per-pane view stack  |
| 5 approval                | v2    | New view kind slotting onto the v1 `View` interface — additive, no refactor |
| 6 files sidecar           | v2    | Per-step sidecars reuse the global-sidecar pane-stack mechanism             |

The line between v1 and v2 is drawn exactly where the code changes get
load-bearing: v1 stops before anything needs a plugin registry, an IPC
socket, or a pane-view stack. Everything above that line is designed to
arrive without a breaking change.
