# ask-demo

The smallest possible demo of the `ask()` step. **No Claude required** — every
step is a pure prompt, so this is the fastest way to try out the new TUI input
primitive.

## What it shows

Three back-to-back asks covering the full v1 surface:

1. **`ask:start`** — single button (`begin`). Confirms the simplest shape works.
2. **`ask:profile`** — two text fields (`name`, `color`) plus two buttons
   (`save`, `skip`). Demonstrates Tab-cycling between fields and buttons.
3. **`ask:confirm`** — multi-button (`yes` / `no` / `maybe`) with a free-form
   `notes` field.

Each step's typed result is `console.log`-ed so you can see the discriminated
union in action.

## Running it

> **Run from `examples/`.** `orch` walks up from `cwd` looking for the nearest
> `orch.config.ts`. The repo-root `orch.config.ts` only registers `new-feature`,
> so you'll get "Unknown workflow" if you launch from the project root. From
> `examples/` (or any subdir of it) the local config — which registers
> `ask-demo` — wins.
>
> ```sh
> cd examples
> ```

### Plain (readline) — easiest

```sh
bunx orch run ask-demo
```

You'll see numbered prompts in your terminal. Pick a button by typing its
number and hitting Enter; empty input picks button #1. Ctrl-D cancels.

### Two-pane Ink renderer — fanciest (needs tmux)

```sh
bunx orch run ask-demo --mode=two-pane
```

The right pane takes over for each ask: the question, any text inputs, and a
row of labeled buttons. **Tab / Shift-Tab** cycles focus, **Enter** submits
the focused button, **Esc** or **Ctrl-C** cancels.

### Autonomous (no human)

```sh
bunx orch run ask-demo --noninteractive
```

Every ask resolves to its `defaultWhenNoninteractive` (begin → skip → yes) and
the workflow runs end-to-end without prompting.

## Cancel & resume

Cancelling at any prompt returns `{ cancelled: true, fields: <whatever-you-typed> }`
and the workflow exits cleanly via the `cancelled` branch.

A cancelled ask **is** cached — `bunx orch resume <runId>` replays the cancel
without re-prompting. To re-prompt instead, edit
`.orch/state/<runId>/state.json` and remove the offending `ask:*` entry, then
resume.

## Known issue this demo surfaces

The `AskResult<F, B>` TS type spreads field values at the top level
(`result.notes`), but the runtime executor returns them nested under a `fields`
property (`result.fields.notes`). The mocked integration tests assert the
nested runtime shape, so the type and runtime are currently misaligned. This
demo accesses fields via the runtime shape with a small `as` cast to keep TS
happy — see the comment in `index.ts`. `examples/feature-loop/index.ts` reads
`answer.notes` (the typed shape) and would crash on the same boundary if you
selected `retry`.

