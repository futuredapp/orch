---
date: 2026-04-23
topic: two-pane-auto-attach
status: shipped
tags: [reframe, planning, tmux, host]
category: process-lifecycle
module: hosts/two-pane
symptoms:
  - two-pane mode shows plain-mode output
  - tmux session created but user not attached
  - short workflows tear down the session before the user can attach
---

# Two-pane auto-attach, and how a requirement went missing

## Symptom

Running `bunx orch run <workflow> --mode=two-pane` created a tmux session
and printed the familiar `[orch tmux] attach with: tmux -L orch-<runId> attach -t orch`
hint, but never put the user inside it. Workflows shorter than ~10s
completed and killed the session before the user could open a second
terminal. The experience was indistinguishable from `--mode=plain`.

## Root cause (the code part)

`TmuxHost` and the CLI's `run` / `resume` handlers had no method to spawn
`tmux attach-session` themselves. The orch-reframe plan moved every piece
of the old `examples/two-pane-demo.ts` into Phase D — *except* the demo's
final `Bun.spawn(['tmux', '-L', SOCKET, 'attach-session', …])` call. The
plan's closest-adjacent line was "teardown prints the attach + kill hints,"
silently substituting a hint for the actual attach.

## Root cause (the planning part)

This is the interesting one. The reframe plan has a method called
`Host.attach(view, pane)` on its Host interface. It's the *programmatic*
hook for attaching a view to a pane (e.g. "draw the status view on the
left pane"). It has nothing to do with attaching the user's terminal to
a tmux session.

Every reviewer who grepped the plan for "attach" — the natural thing to
do when verifying a feature about attaching — saw `attach` everywhere,
assumed it was covered, and moved on. The naming collision ate the gap.

Two indirect signals in the brainstorm had already specified auto-attach
as the implicit default:

1. **DX review decision #3** (brainstorm L126–129): "Orch owns nothing.
   Exit = tmux session kill / window close." You can only close a window
   you're attached to.
2. **The stories file** L94–105: renders the two-pane ASCII as the *first*
   frame after `$ orch run compound`. That only works with immediate
   auto-attach.

Neither signal survived translation because the plan reviewer was
implicitly convinced by `Host.attach(...)` that attach was implemented.

## Fix

Added `attachForeground(): Promise<void>` as a new, non-colliding method
on the `Host` port:

- **TmuxHost** spawns `tmux -L <socket> attach-session -t <session>` via
  `ProcessService.spawnForeground` with inherited stdio; resolves when
  the client exits.
- **PlainHost** returns a resolved promise (no-op).

The CLI races `host.attachForeground()` against the workflow promise with
`Promise.race`. Whichever settles first drives shutdown:

- Workflow finishes → teardown kills session → attach exits → CLI exits.
- User detaches (`Ctrl-b d`) → attach exits → CLI prints "detached; run
  continues" → waits for workflow → exits with its code.

Escape hatches:

- **`--no-attach`** flag keeps today's hint-only behavior (CI, screenshot
  scripts, multi-window users).
- **Nested tmux** (`$TMUX` non-empty) errors at host creation with three
  concrete escape options. `attach-session` from inside nested tmux
  routes the client to the outer server and is never what the user meant.
- **No TTY + `--mode=two-pane`** without `--no-attach` exits 2 with
  "requires a TTY; add --no-attach for headless."

## Lesson for plan reviewers

**When a requirement disappears during plan translation, the first place
to look is naming.** A name that's reused for two conceptually-different
things (here: programmatic `attach(view, pane)` vs. terminal
`attach-session`) creates a search-blindspot that grep won't surface. Even
a careful reviewer ends up reading *past* the gap.

Mitigations:

1. **Watch for homonyms.** When a port introduces a method name that
   also exists as a CLI verb in the adjacent dependency (here: tmux),
   add a one-liner in the port comment distinguishing the two. The
   follow-up plan picked `attachForeground` specifically to avoid the
   collision.
2. **Cross-check stories against deliverables.** If a story's opening
   frame assumes a behavior (user is inside the tmux UI *immediately*),
   the plan's deliverables must name a mechanism that produces it.
   "Prints the attach hint" is not a mechanism that produces "user is
   attached."
3. **Brainstorm-to-plan transitions that delete a whole example file**
   should be audited line-by-line before the example is git-deleted.
   The deleted `examples/two-pane-demo.ts`'s step 9 was the only place
   the mechanism existed, and its deletion happened in a commit unrelated
   to the reframe landing.

## References

- Plan: [`docs/plans/2026-04-23-feat-two-pane-auto-attach-plan.md`](../plans/2026-04-23-feat-two-pane-auto-attach-plan.md)
- Reframe plan follow-up note: [`docs/plans/2026-04-18-feat-orch-reframe-step-views-run-modes-plan.md`](../plans/2026-04-18-feat-orch-reframe-step-views-run-modes-plan.md) §Phase D
- Stories footnote: [`docs/brainstorms/2026-04-16-orch-reframe-brainstorm_storeis.md`](../brainstorms/2026-04-16-orch-reframe-brainstorm_storeis.md) (auto-attach precondition)
- Deleted demo: `git show 1d45c4b:examples/two-pane-demo.ts` (step 9)
