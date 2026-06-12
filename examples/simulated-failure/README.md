# simulated-failure (dev-only)

A headless workflow that ends in the **failed** state on purpose, so you can see
what a failed run looks like end-to-end — the run status, the step transcript's
`terminal/error` line, and the non-zero exit — without a real agent CLI.

> **Dev-only.** `scriptedFake` is deliberately absent from the public barrels and
> the package is `private`, so a published consumer cannot import it. This
> example deep-imports it from `src/runners/scripted-fake/index.ts`. Do not add
> this workflow to any shipped config.

## What it shows

One **autonomous** step (`crash`) backed by the predictable fake. Its behavior
comes from a JSON script the runner reads via the `ORCH_LIFECYCLE_SCRIPT` env
var — the bundled [`script.json`](./script.json) scripts it as `instant-fail`:

```jsonc
{
  "steps": {
    "crash": {
      "kind": "instant-fail",
      "message": "simulated failure: upstream API returned 400",
      "exitCode": 1
    }
  }
}
```

`instant-fail` emits a `terminal/error` event and exits non-zero. The executor
turns that into a `StepError`, and the run lands `failed` (the graceful
step-failure status, **not** `crashed`, which is reserved for orchestrator bugs).

## Run it

The script path is **required** — the headless fake refuses to start without it:

```bash
ORCH_LIFECYCLE_SCRIPT=examples/simulated-failure/script.json \
  bunx orch run simulated-failure
```

Then inspect the failed state:

```bash
cat .orch/state/<runId>/state.json | jq .status                 # "failed"
cat .orch/state/<runId>/logs/agents/crash/raw_output.ndjson     # the terminal/error line
```

## Variations

- Change `message` / `exitCode` in `script.json` to model a different failure.
- For an **interactive** (two-pane TUI) version where you trigger the failure
  live — by typing `fail` into a pane or running the driver with `--fail` — see
  [`examples/predictable-tui`](../predictable-tui/README.md).
