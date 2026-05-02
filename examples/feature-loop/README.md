# feature-loop

The minimal example for the `ask()` step's **loop-with-feedback** pattern: each
iteration runs `brainstorm → plan → work → review` autonomous Claude steps,
then pauses on an `ask()` prompt asking the human whether to **continue**,
**retry** (with optional notes fed in as `extraPrompt`), or **abort**.

## What it shows

1. `ask()` as a typed step that returns a discriminated union — `cancelled`
   narrows the result so the `else` branch knows the typed `button` and
   `notes`.
2. Per-iteration `as:` overrides (`ask-0`, `ask-1`, …) so each loop turn gets
   its own cache slot and resume replays each ask exactly where it stopped.
3. `extraPrompt` plumbing — the `notes` field from the ask becomes the next
   `WORK` step's extra context when the user picks `retry`.
4. The `defaultWhenNoninteractive` escape hatch — the same workflow runs
   end-to-end under `--noninteractive` with no human in the loop.

## Running it

### Interactive (plain mode, default)

```sh
bunx orch run feature-loop "add a CSV exporter to the report module"
```

After each iteration the readline prompter prints:

```
[ask-0] Continue this iteration? (retry re-runs work with your notes; abort exits)
[ask-0] notes (extra instructions for next loop (optional)):
[ask-0] choose: (1) continue  (2) retry  (3) abort  [1]:
```

Type the number, press Enter. Empty input picks `continue`. Out-of-range
input re-prompts up to 5 times before cancelling. Ctrl-D cancels immediately.

### Interactive (two-pane mode, Ink renderer)

```sh
bunx orch run feature-loop --mode=two-pane "add a CSV exporter"
```

The right pane takes over for each ask: a centered box with the question, a
text input for `notes`, and three labeled buttons. Tab / Shift-Tab cycles
focus across input and buttons; Enter on a focused button submits; Esc or
Ctrl-C cancels.

### Autonomous (no human, no interactive)

```sh
bunx orch run feature-loop --noninteractive "add a CSV exporter"
```

Every `ask-${i}` resolves to the declared default
(`{ cancelled: false, button: 'continue', notes: '' }`) and the loop runs
all five iterations end-to-end. Equivalent: `ORCH_NONINTERACTIVE=1 bunx orch run feature-loop ...`.

If you remove `defaultWhenNoninteractive` from the `ask()` config and re-run
with `--noninteractive`, the workflow throws `AskNoDefaultError` at the first
ask. The error body synthesizes a paste-ready default from the actual config
(button list + field keys), so the fix is mechanical.

## Resuming

```sh
bunx orch resume r-2026-05-01-...
```

Cached asks (including cancellations) replay deterministically — the human
isn't re-prompted for an answer they already gave. Cache-stale detection:
if you change the buttons list or rename a field key between runs, the
specific affected ask is invalidated and re-prompts; siblings still replay.

To replay an accidental cancel as a fresh prompt, edit
`.orch/state/<runId>/state.json` and remove the offending step entry, then
resume. (Documented in `docs/getting-started.md` under "Recovering from an
accidental cancel.")

## Where the files land

The four agent steps write into `<sandbox>/feature/`:

```
feature/
├── brainstorm.md   # rewritten each iteration
├── plan.md
├── work-notes.md   # appended each iteration; replaced on retry
└── review.md
```

Sandbox path is whatever `cwd` the host hands the workflow — under `orch run`
that's the run's working tree (a worktree if `--worktree` is set, otherwise
`process.cwd()`).
