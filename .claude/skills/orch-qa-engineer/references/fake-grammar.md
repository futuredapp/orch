# The predictable-fake grammar

`scriptedFake({ stepName, interactive?, interactiveUi? })` is a deterministic
stand-in for `claude()` / `codex()`. For QA you almost always want the
**interactive puppet** path (what the bundled examples and the template use) —
the rest of the grammar exists for headless lifecycle tests and is summarized
here so you recognize it.

## Two shapes of fake

- **Interactive** (`interactive: true, interactiveUi: 'ink'`): a live PTY pane
  rendered with Ink. Takes input from two channels that render identically — a
  human typing, and the QA control file. This is what `qa send` / `qa keys`
  drive. No script file needed; the entry has exactly one behavior (live puppet).
- **Headless** (`interactive` omitted): reads a JSON script from the
  `ORCH_LIFECYCLE_SCRIPT` env var and dispatches a `StepScript`. Used by
  integration tests, not by interactive QA.

## StepScript kinds (headless only)

A script file is `{ steps: { "<stepName>": StepScript } }`. The kinds:

| kind | behavior |
| --- | --- |
| `instant-ok` | emit optional `events`, exit 0 (optionally return `structuredOutput`) |
| `instant-fail` | emit `message`, exit with `exitCode` (default 1) |
| `wait-for-file` | poll `gatePath` until it exists, then emit + exit 0 |
| `emit-then-hang` | emit `events`, then block until the parent kills it |
| `puppet` | read NDJSON commands from a control file and dispatch them |

## Puppet commands (the QA vocabulary)

For interactive QA the toolkit only writes the two cross-mode commands (via
`qa send`), and `qa` handles the ack handshake for you:

| command | effect | `qa` wrapper |
| --- | --- | --- |
| `{ "cmd": "type_and_send", "text": "…" }` | emit one line into the pane | `qa send <step> line "…"` |
| `{ "cmd": "finish", "code": 0 }` | finish the step with an exit code | `qa send <step> finish [code]` |

Legacy headless-only commands also exist (`emit`, `write-file`, `run-shell`,
`complete`, `fail`, `wait`) — you won't need them for screen-level QA.

## Addressing (how `qa` finds the right control file)

Each step's control file lives under `<runDir>/test-control/<encodedKey>.ndjson`,
keyed by the step's logical key (`ORCH_STEP_KEY`). The key is the `as:` name for
parent steps and a namespaced `sub>step` for subworkflow steps. `qa awaiting`
decodes the on-disk filenames so you never have to construct keys by hand. Each
command gets a numbered `.ack`; `qa send` blocks on it, which is why driving is
race-free.

## Why this is the right tool for QA

Because the fake is deterministic and crosses the real process boundary, a QA run
exercises the genuine executor, two-pane host, steps-view projector, and
subworkflow lifecycle — everything except the model — with zero token cost and
perfectly repeatable output. That's what makes screenshots assertable.
