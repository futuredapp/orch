---
date: 2026-04-16
topic: orch-reframe
---

# Re-framing orch — step-declared views + managed pane layout

## What We're Building

A **re-framing** of `orch`, not a rewrite. The existing core (runner adapters, workflow DSL, state/resume, validators, Claude + Codex runners) stays. The mental model around **observability and interactivity** changes so that a workflow reads like:

> *"Here's the planner agent. Here's the reviewer agent. Here's the splitter agent. Each one runs, and while it runs you see it on the right; the left shows progress."*

Concretely, every step declares **how it wants to be shown**, and orch owns a small **pane layout** that drops that view into the correct place. The `--tmux` / `--observe` flags stop being feature branches that fork the architecture; they become *host choices* ("where do views render") with a shared view model underneath.

**v1 has two view kinds:**

1. **`interactive`** — a real PTY for a human-driven session (Claude/Codex/other).
2. **`transcript`** — a readable stream of parsed runner events (tool calls, assistant text, results) — *not* the raw-JSON dump observe mode emits today.

`files`, `exec`, `approval`, `summary`, and custom views are deferred to v2. The view-kind slot is an open union, so adding them later is additive.

**v1 has three run modes:**

1. **`plain`** — no tmux, no panes. One-line-per-event output prefixed by step name (`[plan] claude> …`). CI-native. `interactive` steps error with a clear message if stdin is not a TTY.
2. **`single-pane`** — one terminal, no tmux. `interactive` takes the foreground; `transcript` streams in line-prefixed form when the pane is free. For users who want the new view model without the multiplexer.
3. **`two-pane`** — tmux-hosted, **fixed left + right panes, always shown**. Left = status / summary by default. Right = active step's view by default (transcript for autonomous, interactive for interactive). Each agent ships a default view; each step may override. This is the default when a TTY and tmux are both present.

Mode resolution: `--mode=plain|single|two-pane` > `CI` env var > TTY + tmux → `two-pane` > TTY only → `single-pane` > no TTY → `plain`.

**Sidecar views are v2, not v1.** v1's "every step occupies one pane" keeps the shape simple, and a future `sidecar: {...}` field on a step is additive — no breaking change.

Distribution: global CLI (`bun install -g orch`), per-project `orch.config.ts` that declares the few bits users can override. Workflows are still plain TS modules.

## Why This Approach

**Today's Phase 13 tmux shape drifted:**

- Observation is a *fixed* right pane that dumps `runnerEvent:JSON` — user-unreadable.
- Interactive steps refuse to run under tmux (`workflow.ts:249`) — the `compound` example explicitly documents the conflict.
- No per-step notion of "show this step like *this*." Everything is either the single observer (autonomous) or foreground-takeover (interactive).
- Parallel branches share one observe pane; no multi-pane layout exists.
- `two-pane-demo.ts` and `multi-task-demo.ts` prove the target UX works (right pane hosts an interactive `claude`; left pane draws observer; `respawn-pane` swaps tasks between steps) — but those demos bypass orch entirely. orch should *be* the thing doing that.

**Why step-declared views + managed layout beats the alternatives:**

- **vs. "just lift the ban and prettify observe"** — unblocks today's pain but leaves the same fixed model; doesn't deliver "I want the right pane to be swappable between lazygit and agent state," doesn't solve parallel multi-pane, and keeps the autonomous/interactive fork in the codebase.
- **vs. "fully declarative config file only"** — over-designed for now; most workflows want `orch run compound "prompt"` to just work with defaults. Config is for overrides, not required ceremony.

The step-level view is where the decision *belongs*: the step's author knows what's interesting to watch while the step runs. The layout is where the operator's decision *belongs*: "this machine / project shows 2 panes, named X and Y."

## Key Decisions (v1)

- **Three run modes, not N.** `plain`, `single-pane`, `two-pane`. `--mode` flag + env/TTY autodetect. This is the user's primary mental model — "how much surface am I working on?" — and it's stable; layouts evolve underneath it. Why: simpler to learn, simpler to document, and GitHub Actions / piped runs become first-class (`orch run … --mode=plain`).
- **Two fixed panes in v1: `left` and `right`.** No custom names, no split trees, no sidecars. Defaults: `left` = status/summary, `right` = active step's view. Each agent ships a default view and pane binding; each step may override with `pane: 'left' | 'right'`. Why: user explicitly asked for left/right only; keeps the shape where every growth direction is additive.
- **Step declares its view; agent supplies the default.** `step.define(name, { view?: 'interactive' | 'transcript', pane?: 'left' | 'right', ... })`. Omitted `view` resolves to the agent's default (`claude` and `codex` each expose one), omitted `pane` resolves to `right`. Why: authors pick *what* is watchable; orch picks *where*; swapping runners doesn't rewrite the workflow.
- **Observability is default, not opt-in.** In `two-pane`, every autonomous step paints a readable transcript somewhere. In `single-pane`, non-interactive steps stream line-prefixed to the shared pane. Silencing a step requires an explicit `view: 'silent'` opt-out (reserved name, lands with v1). Why: "I kicked off an agent and I can't see it" is the class of pain this reframe exists to kill.
- **Interactive always gets a real PTY.** Never blocked. In `two-pane` → spawned in the target pane via `respawn-pane` (like the demos). In `single-pane` → foreground takeover. In `plain` → error with a clear message ("this step is interactive; use `--mode=single-pane` or `two-pane`"). Parallel interactive branches need as many panes as branches; v1 supports at most one at a time (two-pane has one non-status pane).
- **Readable transcript by default.** `onEvent` no longer ships raw JSON to a pane. A `TranscriptRenderer` consumes `RunnerEvent`s and emits line-oriented readable output. Why: this is the #1 readability complaint.
- **Host-agnostic view model.** The same `view:` declarations render on any of the three modes. A workflow runs on a dev laptop with tmux, on a CI box with nothing, on a teammate's machine without tmux — all unchanged. Why: one source of truth.
- **Global CLI + per-project config, discovered upward.** `orch` binary is global; walks up from `cwd` to find `orch.config.ts`. Why: user's chosen distribution shape.
- **Sidecars, custom views, and runtime pane manipulation deferred.** Real asks, but belong to v2 after the view model is stable. v1's API is designed so each of these is **additive**, not a breaking change. See next section.

## Forward-compatibility for TeamMax (v2+)

The v1 surface is deliberately a **subset** of a richer model designed for power users. Nothing in v1 forecloses on any of these, and each landed from lightweight research into how neighbouring ecosystems do it:

- **Custom view plugins — `~/.orch/views/*.ts` + `.orch/views/*.ts`.** Mirror the Claude Code subagent pattern: frontmatter-declared TS/MD files in a well-known folder, resolved by priority (CLI flag > project > user > plugin). A user drops `~/.orch/views/cost-dashboard.ts` exporting a `View` implementation and references it as `view: 'cost-dashboard'`. Project views get committed and travel with the repo; user views travel with the user. v1 ships the `View` interface as an internal seam with only built-ins wired up; v2 exposes the registry.

- **Layout as data, additive growth.** v1's two fixed panes are a degenerate case of a layout tree. v2's `orch.config.ts` can grow to a nested `{ split: 'h' | 'v', children: [...] }` form **without breaking the flat v1 shape** (orch accepts both). tmux preset layouts (`main-vertical`, `tiled`, etc.) become named templates; custom layouts are just data the layout manager reads. Left/right stays a valid short-hand forever.

- **Global sidecars with user-bound tmux hotkeys.** The "I hit `prefix + L` and the right pane swaps from transcript to `lazygit`; `prefix + T` swaps to `watch bun test`; `prefix + B` restores the step's view" flow maps directly onto tmux primitives:
  - `tmux bind-key` for the hotkey.
  - `tmux display-menu` / `display-popup` for interactive picks.
  - `respawn-pane -k` to replace the pane's process in place.
  - A per-pane **view stack** so "restore" pops back to the step's active view.
  
  v2 shape: `orch.config.ts` declares `globalSidecars: [{ name: 'git', command: ['lazygit'], key: 'L' }, …]`. On session start orch binds the tmux keys; each key invokes an `orch` subcommand (`orch sidecar swap right git`) that talks to the running workflow via a local IPC socket. The socket is v2's hard prerequisite — v1 doesn't need one, so don't add it yet.

- **Host adapters beyond tmux.** Only `two-pane` needs a multiplexer; a `Host` port abstracts it. v1 = tmux only. v2 = `wezterm`, `zellij`, `kitty` (all of which have their own multiplex/pane primitives). `plain` and `single-pane` remain host-free.

- **Sidecar views on steps.** Once global sidecars exist, per-step sidecars (`sidecar: { kind, command, pane }`) fall out: the step owns a second pane for its lifetime, the view stack swaps it back when the step exits. Same mechanism, step-scoped.

- **Pane roles beyond `left`/`right`.** `top`, `bottom`, `focus`, `status` — all additive. v1 code paths treat pane names as strings against a known set; widening the set is a data change, not a code refactor.

**Rule of thumb:** *Anything a power user wants to customise must be expressible without editing orch internals.* v1 keeps surfaces small; v2 opens registries and hook points on the same underlying model.

**References consulted:**
- Claude Code [subagents docs](https://code.claude.com/docs/en/sub-agents) — folder-backed, frontmatter-declared, priority-resolved registry. Battle-tested shape.
- tmux [`display-menu` / `display-popup`](https://man7.org/linux/man-pages/man1/tmux.1.html) + [`respawn-pane`](https://tao-of-tmux.readthedocs.io/en/latest/manuscript/10-scripting.html) — the primitives a global-sidecar feature actually needs.
- [Pi](https://addyosmani.com/blog/code-agent-orchestra/) (Mario Zechner) — minimal core, opt-in TS extensions. Validates "start small, grow via plugins."
- [awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents) — proof that a community view/agent registry gets rich fast when the registration format is stable.

## Open Questions

- **`single-pane` mode semantics.** When an autonomous step runs while the pane is free, does it print to stdout above the shell prompt, or take full-screen? When an interactive step is mid-session and a parallel autonomous step completes, does its output spill in (bad), queue (good), or write to a tail file the user can `less` afterwards?
- **Interactive step "done" detection.** The current foreground model uses the child process's exit. In a tmux pane the agent may persist after the logical step completes; we'd need the user to confirm (a keystroke? a watcher? an explicit end prompt?) or a step-configured completion marker. Current lean: explicit keystroke (`enter` to advance, `esc` to abort); agent-exit continues to be the auto-advance path.
- **Resume semantics with tmux state.** Panes are ephemeral; state is durable. On `orch resume`, the layout is **re-initialized fresh** (working hypothesis): the prior session's interactive context lives in the agent's own state, not in the pane. Confirm on the first resume edge case.
- **Migration path from today's code.** Phase 13's status-loop + observe-pane wiring is already landed and tested. Mapping: status-loop → `left` pane's default view; observe → `right` pane's default `transcript` view; the `tmuxActive` refusal for interactive → deleted. Land the rename + rewire as a single refactor, keep `--observe` as a deprecated alias for `--mode=two-pane` for one release.
- **TeamMax IPC surface (v2 prereq).** For hotkey-driven sidecar swaps, orch needs a local endpoint the tmux-bound subcommand can hit. Unix domain socket under `$XDG_RUNTIME_DIR/orch/<runId>.sock`? HTTP on localhost? Auth model when multiple runs are concurrent? Not needed in v1 — call it out so v1 doesn't paint us into a corner.
- **View plugin location convention (v2).** `.orch/views/*.ts` for project, `~/.orch/views/*.ts` for user (Claude Code shape), or npm packages named `orch-view-*`? Both? v1 doesn't ship the registry, but the internal `View` interface should already have the shape plugins will satisfy.

## Decisions from DX review (2026-04-17)

Ten follow-up decisions that promote Open Questions to Key Decisions and add a
few new surfaces. These **supersede** any conflicting wording earlier in the
document. The stories file (`…_storeis.md`) needs a refresh to match — tracked
below.

### Resolved (were Open Questions)

1. **Interactive "done" detection.** The step ends when the agent's PTY exits.
   No timeout. No orch-level advance keystroke. Users cancel via the agent's
   native kill (double Ctrl+C for Claude Code / Codex). Idle sessions (hours)
   are fine — orch just waits. This eliminates the earlier "explicit keystroke
   vs agent-exit" fork and keeps orch out of the keystroke business.

2. **`single-pane` semantics.** Full-screen TUI via the alt screen (like
   lazygit / htop / k9s). Restores terminal scrollback on exit; prints a run
   summary afterwards. Interactive steps are a natural PTY takeover within the
   same alt screen. Rules out the ambiguous "stream above the shell prompt"
   variant.

### New key decisions

3. **Zero orch-level hotkeys in v1.** Agents own their panes (PTY). Tmux owns
   pane navigation via its prefix. Orch owns nothing. Exit = tmux session
   kill / window close. Resume = CLI (`orch resume <runId>`), not in-TUI.
   Drops the `[q]`, `[r]`, `[tab]`, `[s]`, `[y/n]` hints from Stories 1 & 3.

4. **Parallel in two-pane is a compact rollup only.** v1 shows each branch's
   status (running/done, tool-call count, token usage) in the right pane —
   **no per-branch transcripts**. Full parallel transcripts render correctly
   in `plain` and `single-pane` (one stream, prefixed lines). Tmux split-pane
   for parallel branches moves to v2, landing with the layout-tree work.
   Story 3 downgrades accordingly.

5. **Failure UX: inline + halt.** When a step fails, the error renders inline
   in that step's transcript pane (red, with traceback). Left pane marks the
   step `✗ failed`, skips downstream steps, and freezes at that point. Run
   exits non-zero. Footer prints `orch resume <runId>` and `orch logs <runId>`
   hints. No modal, no overlay. Continue-on-error is a v2 concern.

6. **Heartbeat = idle clock.** When no runner event has arrived in the
   current step, a second timer (`idle 0:14`) appears alongside `elapsed` and
   increments every second. Any event resets it to `0:00`. No spinner
   animation, no redraw loop. Distinguishes "agent thinking" from "agent
   wedged" for free.

7. **`plain` mode ships with `--format=text|json`.** Default is `text` (the
   human `[orch]` / `[stepname]` prefix format). `--format=json` emits one
   JSON object per line (`ts`, `run`, `ev`, `step`, payload). Essential for CI
   ingestion, Datadog / Loki piping, and downstream tooling. Trivial to
   implement — orch already has the event stream internally.

8. **First-run banner.** On every run, print a one-line header showing the
   resolved mode and override flags. Example:
   `[orch] mode=single-pane (auto: TTY, no tmux) · --mode=plain|two-pane to override`.
   Suppressed under `--format=json`. Makes the three-mode mental model
   discoverable on day one without prompting or extra config.

9. **`silent: true` is a separate field, not a `view: 'silent'` magic string.**
   View kinds stay focused on "how to render"; silence is its own concern.
   Typos fail loudly, autocomplete works, union types stay clean.

10. **Keep today's `run(name, opts)` — no `step.define()` ceremony.** The
    brainstorm (and stories) showed `run(step.define('plan', {...}))`. YAGNI —
    no stated benefit vs. `run('plan', {...})` in v1. Can revisit if/when we
    need to pass steps as data, dry-run plan a workflow without executing, or
    serialize step definitions. Keeps workflows terse:

    ```ts
    export default workflow('compound', async (run, args) => {
      const plan   = await run('plan',   { agent: claude(), prompt: args.task })
      const impl   = await run('build',  { agent: codex(),  prompt: plan.value })
      const review = await run('review', { agent: claude(), prompt: impl.value })
      return review.value
    })
    ```

### Stories file needs updating

The companion `…_storeis.md` predates these decisions. Required edits before
planning:

- **Story 1 / Moment C:** drop `[q] quit  [r] resume` hotkeys.
- **Story 1:** add the first-run banner above the first frame; add `idle` line
  to status pane.
- **Story 1.5 (new):** "A step fails" — show the failure frame from decision 5.
- **Story 2 / Mode 1 (plain):** add `--format=json` example emitting JSONL.
- **Story 2 / Mode 2 (single-pane):** confirm full-screen takeover wording.
- **Story 3:** downgrade to "compact rollup in two-pane"; note that the
  split-pane-per-branch experience ships in v2.
- **All stories:** replace `run(step.define('name', {...}))` with
  `run('name', {...})`.

### Still open (pushed to v2 or early implementation)

- Resume semantics with tmux state — working hypothesis (fresh layout on
  resume) unchanged, confirm on first real resume test.
- Migration path from Phase 13 wiring — mapping unchanged from the original
  section.
- v2: TeamMax IPC surface, view plugin location convention.

---

## Next Steps

→ `/workflows:plan` to turn this into a phased implementation plan. Suggested phase shape (v1 = phases 1–5; v2 = phases 6+):

1. **Run-mode scaffolding + `plain` mode.** Define the `RunMode` discriminant (`plain | single-pane | two-pane`) and its autodetect. Implement `plain` end-to-end as a line-prefixing renderer of `RunnerEvent`s — ships CI-native on day one, no tmux, no multiplexer.
2. **View abstraction + `transcript` + `interactive`.** Two view kinds, period. Internal `StepView` interface, agent default views, `step.define({ view?, pane? })`. `transcript` renders as line prefixes in `plain`; `interactive` errors in `plain` with a clear message. Zero tmux code yet.
3. **`single-pane` mode.** One-terminal host. `interactive` takes the foreground; `transcript` streams inline line-prefixed when the pane is free. No tmux dependency, so it's the graceful fallback on any TTY.
4. **`two-pane` mode: left + right.** Introduce the `Host` port with a tmux implementation. Fixed `left` (default status/summary) + `right` (default: active step's view). Per-step `pane` override. Migrate Phase 13's status-loop → `left`; migrate observe → `right` transcript. Delete the `tmuxActive` interactive refusal.
5. **Plugin seam (stub) + `orch.config.ts`.** Land `View` and `Host` as real interfaces with only built-ins registered; land config discovery (upward walk, `--config` override). No user-facing plugin registry yet, but the shape is correct so v2 is additive.
6. **(v2)** Sidecars (step-scoped + global), custom view plugins via `.orch/views/`, layout trees, tmux hotkey bindings (`display-menu` + `bind-key` + `respawn-pane`), local IPC socket, `files` / `exec` / `approval` / `summary` view kinds, non-tmux host adapters (wezterm/zellij/kitty).
