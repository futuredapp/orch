---
date: 2026-04-30
topic: tui-ask-step
status: brainstorm — ready for /workflows:plan
---

# TUI `ask()` step — interactive user input as a first-class workflow step

## What We're Building

A new built-in step factory, `ask({ question, fields, buttons })`, that pauses
a workflow and renders a centered prompt with text inputs and labeled buttons.
The author gets back a typed discriminated union —
`{ cancelled: true } | { cancelled: false; button: B; ...fields }`. The step
is host-aware: in `two-pane` mode it takes over the right pane (same way an
interactive Claude step does today); in the planned `single-pane` host it
draws as a foreground takeover; in `plain` mode it falls back to a
readline-equivalent — exactly mirroring how interactive steps are already
routed.

This unlocks the **loop-with-feedback** pattern that motivated the brainstorm:
after every iteration of `brainstorm → plan → work → review`, ask the human
*"continue / retry / abort, with optional notes"* and feed the answer into
the next iteration's prompt.

## Why This Approach

**Library: Ink (`vadimdemedes/ink` v7).** Two parallel research agents
independently recommended it over OpenTUI. Three reasons that matter here:

1. **Battle-tested in the same role.** Claude Code itself ships Ink. Wrangler,
   Copilot CLI, Prisma, Shopify CLI all do too. v7 stable, ESM-only, ~3.5M
   weekly downloads, zero native dependencies — `bun run check` stays portable.
2. **The 30-line pattern works out of the box.** `ink-text-input` +
   `ink-select-input` (used as a button row) gives us the entire v1 with no
   hand-rolled focus management. OpenTUI has no Button primitive — we'd build
   it ourselves on top of a 0.2.x lib with a Zig native dep.
3. **Clean handoff back to streaming output.** `render() → waitUntilExit() →
   unmount()` is the documented pattern; raw mode is restored before the next
   step takes the pane back.

OpenTUI revisited if/when we outgrow Ink for a full multi-pane dashboard.

**Step shape: built-in factory, not a generic `tuiStep(render)`.** Workflow
authors write three lines and get a typed answer; we don't expose React
components in the public API for v1. A generic escape hatch can come later
without breaking `ask()`.

## Key Decisions

- **`ask()` is its own step factory**, returned by `run()` like any other
  step. It memoizes by `as:` name; on resume the cached answer returns
  instantly. The author never re-prompts the user after a crash — except
  when the answer wasn't recorded (see resume contract).

- **Const generics for type-safe returns.** Buttons declared `as const`
  collapse to a string literal union; fields keyed by name yield a
  property-accurate object. No `any`, no casts. (The mechanism — `satisfies`,
  conditional types, etc. — belongs in the plan.)

- **v1 field set: text inputs + buttons + Esc/Ctrl-C cancel.** Single-line
  text via `ink-text-input`. Defaults, required-validation, multi-line,
  select, slider — all deferred.

- **Cancel is a discriminated flag, not a button name.** Result is
  `{ cancelled: true } | { cancelled: false; button: B }`. Authors can label
  a button `'cancel'` without collision. TS narrows naturally on the
  `cancelled` check. Partially-typed field values are preserved as
  `Partial<Fields>` on cancel — most workflows ignore them, but the data is
  there. Cancel is always available; no opt-out (trapping the user is bad UX).

- **`--interactive` (default) vs `--noninteractive` — new run-level axis.**
  In `interactive`, prompts render normally. In `noninteractive`, each ask
  resolves from `defaultWhenNoninteractive` declared on the factory; missing
  default → throw at the call site (not at run start) with a message naming
  the step. Detached two-pane runs are still *interactive* (deferred, not
  noninteractive). Resume inherits the original mode unless overridden.

- **`ask()` inside `parallel()` throws `AskParallelError` at the call site.**
  Mirrors the existing `InteractiveParallelError` (`src/core/workflow.ts:321`).
  Same fix advice — hoist out of the parallel block — plus the noninteractive
  escape. No concurrency-1 special case. Generalizes to: every step that
  needs exclusive UI/stdin is sequential by construction.

- **Resume contract.** Answers are written atomically (temp + rename) before
  `ask()` resolves. On resume: recorded answer → return cached; no recorded
  answer → run the step normally per current mode (interactive re-prompts;
  noninteractive uses default or throws). Half-typed input is never persisted.
  If the cached answer no longer matches the current step definition (button
  removed, field renamed), discard cache and re-prompt; log a one-liner so
  the resume isn't silent.

- **Wall-clock elapsed; cost/tokens recorded as `—`.** Ask steps record real
  elapsed time from "awaiting input" sentinel to result write. No idle-time
  exclusion — interactive Claude steps don't subtract think-time either, same
  rule. The sentinel doubles as observability: a future `orch status` can
  show "ask-2 awaiting human, idle 2h12m" with no new mechanism.

- **No new host in v1.** The step renders inside whichever host is active.
  The deferred `single-pane` host stays deferred; `ask()` will compose
  naturally when it lands.

## Architecture & contracts

- **`PromptService` port** under `src/services/prompt/`. Three implementations:
  `InkPromptService` (two-pane and future single-pane), `ReadlinePromptService`
  (plain), `FakePromptService` (unit tests; constructor takes a name-keyed
  map of scripted answers; throws on unexpected keys). The host wires the
  appropriate real impl; `ask()` itself is host-agnostic. Same
  edge-only-mocking pattern as `ProcessService` / `GitService` / `TmuxService`.

- **Tmux owns detach/reattach in two-pane.** Pending asks survive any number
  of detach/reattach cycles — tmux preserves the pane buffer; Ink keeps
  running in the suspended pane. No new orch code; the contract is "ask
  blocks until answered or cancelled; bound the wait via `--noninteractive` +
  default." Plain mode has no detach concept; standard unix process control
  applies.

- **Host keybinds are tmux-prefix bindings, not bare-key listeners.**
  `[d]/[s]/[q]` are bound at the tmux session via `bind-key`, so `^B d`
  detaches regardless of which pane is focused or what Ink is doing. Bare
  keys would collide with the user typing into the prompt; tmux prefix is
  the disambiguation. Orch owns its session's prefix (default `^B`), not
  inherited from `~/.tmux.conf`. Mockups should show `^B d`, not `[d]`.

- **Trust zone.** Ask field values are persisted verbatim under
  `.orch/state/<runId>/` — both in the resume state file and in the per-step
  log. Same trust zone as every other step's output; same as runner stdout.
  **Ask is not for secrets; orch is not a secrets manager.** Authors and
  users are responsible for not piping passwords through `text()` fields.

- **`validate:` is forbidden on `ask()` at the type level.** Same precedent
  as "interactive steps cannot have `returns:`" (`src/core/step.ts:151`).
  Ask has no transcript and no diff to validate against; the factory's input
  type doesn't include a `validate` slot, so authors get a TS error at
  compile time.

## What it looks like — workflow code

```ts
// steps.ts
import { step, claude, ask, text } from '@you/orch'

export const ASK_CONTINUE = ask({
  name: 'ask-continue',
  question: 'Continue this iteration?',
  fields: { notes: text({ placeholder: 'extra instructions for next loop' }) },
  buttons: ['continue', 'retry', 'abort'] as const,
  defaultWhenNoninteractive: { button: 'continue' },
})
```

```ts
// orchestration.ts
import { workflow, commit } from '@you/orch'
import { BRAINSTORM, PLAN, WORK, REVIEW, ASK_CONTINUE } from './steps'

export default workflow('feature-loop', async (run) => {
  for (let i = 0; i < 5; i++) {
    await run(BRAINSTORM, { as: `brainstorm-${i}` })
    await run(PLAN,       { as: `plan-${i}` })
    await run(WORK,       { as: `work-${i}` })
    await run(REVIEW,     { as: `review-${i}` })

    const answer = await run(ASK_CONTINUE, { as: `ask-${i}` })

    if (answer.cancelled) break
    //   ↑ TS narrows: answer.button undefined here; answer.notes is Partial.

    if (answer.button === 'abort') break
    if (answer.button === 'retry') {
      await run(WORK, { as: `retry-${i}`, extraPrompt: answer.notes })
    }
    // 'continue' falls through to next iteration.
  }
})
```

For autonomous runs: `orch run feature-loop --noninteractive`. Each `ask-${i}`
resolves to `{ cancelled: false, button: 'continue', notes: '' }` from the
declared default and the loop runs end-to-end without human input.

## What it looks like — the right pane

Mid-loop, after `review-2` finishes, `ask-2` takes over the right pane:

```
┌─ orch: feature-loop ── r-2026-04-30-093422-x9 ──────┬─ ask-2 ── awaiting input ───────────────────────────────┐
│                                                      │                                                          │
│  ● brainstorm-2          ✓   2m 11s   $0.31    9k   │                                                          │
│  ● plan-2                ✓   1m 04s   $0.62   18k   │                                                          │
│  ● work-2                ✓   6m 47s   $1.84   71k   │      ╭──────────────────────────────────────────╮        │
│  ● review-2              ✓   2m 02s   $0.44   14k   │      │                                          │        │
│  ● ask-2                 ↯   0m 08s    —      —    │      │   Continue this iteration?               │        │
│    └ awaiting input                                  │      │                                          │        │
│  ○ brainstorm-3                                      │      │   notes:                                 │        │
│  ○ plan-3                                            │      │   ┌────────────────────────────────────┐ │        │
│  ○ work-3                                            │      │   │ extra instructions for next loop_  │ │        │
│  ○ review-3                                          │      │   └────────────────────────────────────┘ │        │
│  ○ ask-3                                             │      │                                          │        │
│                                                      │      │     [ continue ]   ▌ retry ▐   [ abort ] │        │
│  ─── totals ───                                      │      │                                          │        │
│   elapsed   23m 12s                                  │      │     tab/⇧tab move · enter pick · esc cancel │     │
│   cost      $5.84                                    │      │                                          │        │
│                                                      │      ╰──────────────────────────────────────────╯        │
│  ─── keys ───                                        │                                                          │
│   ^B d detach   ^B s status   ^B q graceful stop     │                                                          │
└──────────────────────────────────────────────────────┴──────────────────────────────────────────────────────────┘
 [status]  run r-2026-04-30-093422-x9 · ask-2 · awaiting human · esc to cancel
```

Glyph reuse: `↯` (already meaning "suspended, waiting for human") covers
`ask` cleanly — same icon as today's escalation rows. The `^B` prefix
notation in the keys row reflects that host shortcuts are tmux-bound (see
Architecture § Host keybinds).

## What it looks like — single-pane host (future)

Same component, full-screen alt-screen takeover:

```
                  ╭──────────────────────────────────────────────╮
                  │                                              │
                  │   Continue this iteration?                   │
                  │                                              │
                  │   notes:                                     │
                  │   ┌────────────────────────────────────────┐ │
                  │   │ skip review next time, just commit_    │ │
                  │   └────────────────────────────────────────┘ │
                  │                                              │
                  │       [ continue ]   ▌ retry ▐   [ abort ]   │
                  │                                              │
                  │       tab/⇧tab move · enter pick · esc cancel│
                  │                                              │
                  ╰──────────────────────────────────────────────╯

 orch · feature-loop · ask-2 · iter 2/5 · $5.84 · 23m12s
```

## What it looks like — plain mode

Interactive (`orch run --interactive`, the default), readline-style:

```
[orch] step:start ask-2
[ask-2] Continue this iteration?
[ask-2] notes (enter to skip): skip review next time, just commit
[ask-2] choose: (1) continue  (2) retry  (3) abort  [1]: 2
[orch] step:done ask-2 → { cancelled: false, button: 'retry', notes: 'skip review next time, just commit' }
```

Noninteractive with default declared (`orch run --noninteractive`):

```
[orch] step:start ask-2
[orch] step:done ask-2 → { cancelled: false, button: 'continue', notes: '' }   (defaultWhenNoninteractive)
```

Noninteractive with no default declared:

```
[orch] step:start ask-2
[orch] step:fail  ask-2 — ask "ask-continue" has no defaultWhenNoninteractive and run is in noninteractive mode
```

## Open Questions (for the plan)

1. **Where do `text()` and `ask()` live?** New `src/core/ask.ts`, or a
   subfolder `src/core/prompts/`? The latter scales when we add `select()`,
   `multiText()`, etc.
2. **Ink dependency footprint.** Adding `ink`, `ink-text-input`,
   `ink-select-input`, `react`, `react-reconciler` ≈ 1.2MB of node_modules.
   Acceptable, but worth confirming we want runtime deps (not just dev).
3. **Right-pane takeover hook.** Today interactive Claude steps use
   `tmux respawn-pane -k`; the Ink renderer needs the same hook with a
   different command. Shared abstraction in `src/hosts/two-pane/` or per-step
   decision?
4. **`forceReask: true` per-step override.** Should an author be able to
   force re-prompting on resume, ignoring the cache? Probably yes (e.g.
   "always confirm before deploy"), but defer until requested.
5. **Built-in idle timeout.** Deferred for v1; current contract is
   "interactive waits forever, noninteractive uses default-or-throws."
   Revisit if user evidence shows workflow-level `Promise.race` is too
   clumsy. A future run-level `--max-idle` guardrail (not ask-specific) may
   subsume this entirely.

## Next Steps

→ `/workflows:plan` — implementation phases, file structure, type mechanics
for the const-generic returns and discriminated cancel union, host
integration points, `PromptService` port wiring, test strategy (Ink ships a
first-class `ink-testing-library`; `FakePromptService` covers unit tests for
workflow code that calls `ask()`).
