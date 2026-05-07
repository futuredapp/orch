---
date: 2026-05-05
topic: steps-tui
status: brainstorm — ready for /workflows:plan
---

# Steps TUI — a navigable, history-aware view of an orch run

## What We're Building

A rich Ink-rendered **steps navigator** that becomes the user-facing view of a
running (or finished) orch workflow. The TUI is a single shared component that
plugs into both rich hosts:

- **`two-pane`** — replaces today's text-painted left status pane. The right
  pane keeps doing what it does (interactive agent, transcript stream).
- **`single-pane`** (the slot reserved in [`docs/plans/2026-04-18-feat-orch-reframe-step-views-run-modes-plan.md`](../plans/2026-04-18-feat-orch-reframe-step-views-run-modes-plan.md)) — fills the foreground; yields focus to a takeover when an interactive step or other foreground UI needs the screen.

It doesn't replace `plain`. It doesn't add a fourth host. It's the rich view
layer that makes the existing rich hosts useful *to humans*, not just to a
piping pipe.

The motivating jobs (in priority order):

1. **Live driver's seat.** Watch the active step. See cost/time/tokens roll
   forward. Notice when something's stuck.
2. **History browser.** Scroll back through every step that's already run in
   *this* run, read its transcript, see how it ended.
3. **Resume/attach launcher.** Press `r` on a finished interactive step to
   relaunch it (`claude --resume`, `codex resume <thread>`); the relaunched
   session takes over the right pane. **The live step keeps running.**

A cross-run picker (`tmux ls`-style for `.orch/state/<runId>`) is *not* in
scope; deferred until we've used v1 enough to know whether it's worth it.

## Why This Approach

**Reuses Ink, which is already coming for `ask()` (Phase 18).** No new
runtime dep, no new rendering primitive in the codebase. The same render
loop, the same testing library (`ink-testing-library`), the same lifecycle
discipline (`render → waitUntilExit → unmount`). Single-pane host gets to
exist without first having to import a TUI library.

**One Ink component, two host integrations.** The `<StepsView>` component
reads from a stream of state events (essentially what `state.json` and the
per-step NDJSON already produce). In two-pane it renders into the left pane;
in single-pane it renders into the whole screen with foreground/background
slots. Hosts compose the component; the component doesn't know its host.

**No cleverness about the live process.** The right-pane content is a
*display*, not a *process*. Live agents stream their NDJSON to disk; the TUI
swaps what's rendered, never what's running. Resume launches a *new*
subprocess; live keeps going. This was the user's explicit non-negotiable
during brainstorm.

**Intentional navigation, not autoplay.** Arrow keys move the selection
cursor and update a small preview/footer; the right pane only changes on
`Enter`. Avoids the "scroll-by-mistake-and-lose-your-place" problem you get
with autoplay-on-cursor designs (lazygit, k9s landed on the same default).
`f` snaps focus back to live.

## Key Decisions

- **Component lives at `src/hosts/_shared/steps-view/`.** Both
  `TmuxHost` and the new `SinglePaneHost` import it. Following the same shape
  as `src/runners/_shared/` for code shared across runner adapters.

- **Two-pane integration: TUI replaces the left pane painter.** Today
  `src/hosts/two-pane/` paints text via tmux send-keys / write to a logfile;
  v1 of the TUI runs an Ink renderer in the left pane (Ink child process,
  same model as `ink-runner.ts` from Phase 18b). Right pane is unchanged
  except for the swap mechanism (see below).

- **Single-pane integration: TUI is the foreground.** The `SinglePaneHost`
  is mostly "render the `<StepsView>` until a takeover claims the screen."
  Takeover semantics (interactive step, `ask()`, validator-failure prompt)
  match the existing two-pane right-pane takeover contract — the host yields
  focus, the takeover renders, the host resumes.

- **Right-pane swap mechanism (two-pane).** A second tmux window. Window 0
  hosts the live agent (current behavior). When the user hits `Enter` or `r`
  on a past step, orch creates window 1, renders the transcript replay (or
  spawns the resumed session), and switches the client to window 1. `f`
  switches back to window 0. Cleaner than swapping pane contents in place,
  and tmux-native. Live process is in window 0 the whole time, untouched.

- **Resume needs a runner-level hook.** Add an optional
  `resumeCommand(ctx, sessionId): { argv, env }` to the `Runner` interface.
  ClaudeRunner: `claude --resume <session-id>`. CodexRunner: `codex resume <thread-id>`.
  Runners that don't implement it can't be resumed; pressing `r` shows
  "this runner doesn't support resume." Session ID is captured during the
  original step from runner events (`session-started` / `thread-id`) and
  persisted alongside the existing `StepEntry`.

- **Past interactive steps render as captured transcripts.** `pipe-pane-capture.ts`
  already writes the interactive pane's bytes to disk in two-pane mode. The
  TUI's transcript view replays that file (raw bytes, ANSI preserved).
  Read-only — no replay seeking in v1, just "scroll up/down."

- **`parallel(...)` branches: indented children.** Top row is the parallel
  group ("`parallel: research` ⟳"); branches indented one level
  (`├─ research-claude ⟳`, `└─ research-codex ✓`). Live ones animate. All
  visible at once — no tabs. Memoization keys (`as: 'research-claude'`)
  drive the labels.

- **Keybinds.** Inside the TUI:
  - `↑/↓` — move selection
  - `Enter` — swap right pane to selected step's transcript / state
  - `f` — follow live (snap back to active step + window 0)
  - `r` — resume selected step (if runner supports it)
  - `?` — help overlay
  - Host-level keys (`^B d` detach, `^B q` graceful stop) stay tmux-bound,
    same precedent as the `ask()` brainstorm.

- **State source is `.orch/state/<runId>/`, not in-memory.** The TUI tails
  `state.json` plus per-step NDJSON files. This means `orch status <runId>`
  could open the same TUI against a finished run with zero new mechanism —
  good optionality for the deferred cross-run picker.

- **Plain mode is unchanged.** No TUI in plain. The status events still
  print as `[orch] step:start …` / `[orch] step:complete …` lines. Plain is
  for CI, log ingestion, headless. The TUI's audience is humans on a TTY.

## What it looks like — two-pane with the new TUI on the left

Mid-run, during the `work-auth` step of the §5 example from getting-started.
Same right pane as today (interactive agent stream). New left pane is an Ink
renderer of `<StepsView>`:

```
┌─ orch · feature-build · r-2026-04-29-143052-7k ──────┬─ work-auth · claude --bare -p · alive 0:42 ────────────┐
│                                                       │                                                          │
│   brainstorm           ✓   3m12s   $0.42   12k       │  system: loaded skill workflows:work                     │
│   plan                 ✓   1m47s   $0.88   28k       │  system: allowed tools Bash, Read, Edit, Write           │
│ ▌ work-auth            ⟳   0m42s   $0.12    6k       │                                                          │
│   parallel: review     ⟳   0m12s    —      —         │  > I'll implement the auth token service…                │
│   ├─ review-security   ⟳   0m12s   $0.04    1k       │                                                          │
│   ├─ review-performance ⟳  0m12s   $0.05    1k       │  ◇ Read(src/auth/index.ts) → 23 lines                    │
│   └─ review-design     ⟳   0m12s   $0.03    1k       │  ◇ Edit(src/auth/token.ts)                              │
│   commit feat(auth)    ○                             │    + export class TokenService { … }                     │
│   work-api             ○                             │                                                          │
│   work-ui              ○                             │  (streaming…)                                            │
│                                                       │                                                          │
│  ─── totals ───                                       │                                                          │
│   elapsed   5m41s · cost $1.42 · tok 46k/81k          │                                                          │
│                                                       │                                                          │
│  ─── keys ───                                         │                                                          │
│   ↑/↓ select   ⏎ open    f follow   r resume   ? help │                                                          │
│   ^B d detach  ^B q stop                              │                                                          │
└───────────────────────────────────────────────────────┴──────────────────────────────────────────────────────────┘
 [status] feature-build · r-2026-04-29-143052-7k · 3/9 work-auth · $1.42 · 5m41s · ↑/↓ to browse, ⏎ to open
```

`▌` (left bar) marks the **selection cursor**. Selection follows the live
step by default; arrow keys move it freely. While you're browsing past steps
the right pane keeps showing the live one — `Enter` is what swaps it.

## What it looks like — past interactive step replayed

After hitting `Enter` on `brainstorm` (a finished interactive step). Left
pane unchanged; tmux client switched to window 1; right pane shows the
captured transcript. `f` flips back to window 0 + the live step.

```
┌─ orch · feature-build · r-2026-04-29-143052-7k ──────┬─ brainstorm · captured · read-only ─────────────────────┐
│                                                       │                                                          │
│ ▌ brainstorm           ✓   3m12s   $0.42   12k       │  > /skill brainstorming                                  │
│   plan                 ✓   1m47s   $0.88   28k       │  ✓ loaded brainstorming skill                            │
│   work-auth            ⟳   1m08s   $0.21   12k       │                                                          │
│   parallel: review     ⟳   0m38s    —      —         │  > Let's explore the auth refactor.                      │
│   ├─ review-security   ⟳   0m38s   $0.09    3k       │  > What are the trade-offs between JWT and sessions?     │
│   ├─ review-performance ⟳  0m38s   $0.11    3k       │                                                          │
│   └─ review-design     ✓   0m21s   $0.07    2k       │  assistant: Three angles to consider…                    │
│   commit feat(auth)    ○                             │    1. Stateless JWT: simple to scale, hard to revoke.    │
│   work-api             ○                             │    2. Server sessions: easy revocation, harder to scale. │
│   work-ui              ○                             │    3. Hybrid: JWT for read paths, sessions for writes.   │
│                                                       │                                                          │
│  ─── viewing ───                                      │  (3 more pages — PgUp/PgDn to scroll)                    │
│   brainstorm (read-only replay)                       │                                                          │
│                                                       │                                                          │
│  ─── keys ───                                         │                                                          │
│   ↑/↓ select   ⏎ open   f follow   r resume          │                                                          │
│   PgUp/PgDn scroll transcript                         │                                                          │
└───────────────────────────────────────────────────────┴──────────────────────────────────────────────────────────┘
 [status] viewing brainstorm (replay) · live step work-auth still running · press f to follow
```

The status footer is the affordance that makes "live keeps running" obvious.
Without that line, users will assume browsing has paused the run — and they
will be wrong.

## What it looks like — single-pane host (the deferred slot, now filled)

Same component, full screen. Steps list takes the left third; the right
two-thirds is the active step's view (live or selected).

```
 orch · feature-build · r-2026-04-29-143052-7k                                              ↑/↓ ⏎ f r ?

  brainstorm           ✓   3m12s   $0.42        │  work-auth · claude --bare -p · alive 1:14
  plan                 ✓   1m47s   $0.88        │
▌ work-auth            ⟳   1m14s   $0.31        │  > Adding TokenService with rotation support.
  parallel: review     ⟳   0m44s    —           │
  ├─ review-security   ⟳   0m44s   $0.11        │  ◇ Edit(src/auth/token.ts)
  ├─ review-performance ⟳  0m44s   $0.13        │    + export class TokenService {
  └─ review-design     ✓   0m21s   $0.07        │    +   constructor(private clock: Clock) {}
  commit feat(auth)    ○                        │    +   issue(userId): SignedToken { … }
  work-api             ○                        │
  work-ui              ○                        │  ◇ Bash(pnpm test -- auth/token)
                                                 │    PASS  src/auth/token.test.ts (3 tests, 412ms)
  ─── totals ───                                 │
   elapsed   6m22s                               │  (streaming…)
   cost      $1.92 · tok 51k/89k                 │
                                                 │
                                                 │
 work-auth · 6m22s · $1.92 · ↑/↓ browse · ⏎ open · f follow · r resume · ? help
```

When an interactive `ask()` or interactive Claude step takes the foreground,
the entire frame yields and the takeover renders full-screen — same
discipline as two-pane's right-pane takeover today.

## Architecture sketch (for the planner to expand)

- **`src/hosts/_shared/steps-view/`** — Ink components.
  - `<StepsView>` (top-level), `<StepRow>`, `<ParallelGroup>`, `<TranscriptReplay>`,
    `<HelpOverlay>`.
  - State source: a `StepsViewModel` that tails `state.json` + per-step
    NDJSON. No imports from `src/runners/`, no imports from concrete hosts —
    pure read-side projection of the on-disk state.

- **`src/hosts/two-pane/tmux-host.ts`** — left pane stops being painted by
  `status-pane.ts`-style send-keys; instead the host spawns an Ink child
  process targeting the left pane and pipes events to it (same pattern as
  the `ink-runner.ts` from Phase 18b).

- **`src/hosts/single-pane/`** — new directory. The C-slot from the
  reframe plan, now filled. Owns full-screen Ink lifecycle and the
  takeover/yield handshake.

- **`Runner` interface (`src/runners/runner.ts`)** — gains an optional
  `resumeCommand(ctx, sessionId): { argv, env } | null`. ClaudeRunner and
  CodexRunner both implement; FakeRunner gets a scriptable variant.

- **`StepEntry` schema** — adds optional `sessionId?: string` (captured
  from runner events). Schema bump (v5 if reframe E hasn't landed; v6 if it
  has). Lazy capture only when the runner reports one — no breaking change
  for runners that don't.

- **PromptService / ProcessService boundaries unchanged.** This is a view
  layer; it doesn't spawn subprocesses (except for the resume window, which
  goes through the existing `ProcessService` like any other runner spawn).

## Resolved Questions

- **Q: Should we be able to click steps?**
  A: No mouse for v1. Arrow keys + Enter is enough and avoids raw-mode
  surprises. Revisit if the cross-run picker lands and the surface area
  grows.

- **Q: How do we show interactive steps' history when the session is gone?**
  A: Replay the captured pane bytes from `pipe-pane-capture.ts`. Already on
  disk for two-pane mode today.

- **Q: How does resume work without killing the live step?**
  A: Tmux windows. Live in window 0; resume opens window 1 and switches the
  client. Live process is unaffected because the process is independent of
  the visible window.

- **Q: Codex vs Claude resume parity.**
  A: Both supported via the new `Runner.resumeCommand` hook; runners that
  can't resume just don't implement it, and the TUI shows a one-liner
  refusal.

- **Q: Selection behavior when the live step advances.**
  A: **Sticky once moved.** Selection follows the active step by default;
  the moment the user presses an arrow, selection sits where they put it
  until they hit `f` to snap back to live. Matches the "watch live but
  occasionally browse" use case.

- **Q: Sequencing vs Phase 18 (`ask()`).**
  A: **Ship Phase 18 first, then single-pane.** 18a/18b deliver plain +
  Ink-for-two-pane (`ask()` only). The Steps TUI work then builds on the
  Ink primitives: phase one delivers `<StepsView>` + the two-pane left-pane
  integration; phase two adds the single-pane host + resume launcher. Lower
  risk than coupling them.

- **Q: Schema bump for `sessionId?`.**
  A: **Piggyback on reframe Phase E's v4→v5 rewrite.** One migration, one
  schema generation. Couples this brainstorm's delivery to reframe E's
  timeline — acceptable, since the Steps TUI itself depends on the run-mode
  reframe landing.

## Open Questions (for the plan)

1. **Where does `<TranscriptReplay>` get its bytes for autonomous steps?**
   Two candidates: the runner's per-step NDJSON (already exists, via Phase
   13c), or a `pipe-pane-capture` for the right pane (today only the
   interactive left/right pane is captured). Probably the NDJSON for
   autonomous and `pipe-pane-capture` for interactive — but the planner
   should confirm there's no third source we're missing.

2. **Two windows in two-pane mode — does this break detach/reattach?**
   Tmux preserves windows the same way it preserves panes, so probably not,
   but worth a one-pane verification before committing to the design.
   Fallback: a single window with a swap-pane-content approach.

3. **`.orch/state/` polling cadence.** Tail-based or poll-based? Poll is
   simpler but jittery; `fs.watch` is precise but flaky on macOS. The plan
   should pick and motivate.

## Next Steps

→ `/workflows:plan` — file structure for `src/hosts/_shared/steps-view/`
and `src/hosts/single-pane/`, the `StepsViewModel` event projection,
`Runner.resumeCommand` interface change, schema bump shape, two-window
mechanism in `TmuxHost`, Ink component test strategy
(`ink-testing-library`), and the phase split. Likely two PR-sized phases:
(a) shared component + two-pane integration; (b) single-pane host +
resume launcher.
