# riddle-solver

Two-step demo of the orch pipeline. Chains two real `claude` CLI invocations: the first invents a short riddle and writes it to `riddle_<suffix>.txt`, the second reads that file, solves the riddle, and writes its answer to `solution_<suffix>.txt`. Both steps run in the same sandbox `cwd`, so step 2 reads what step 1 wrote without any inter-step data passing.

## Run

```sh
bun run examples/riddle-solver/index.ts
```

Requires `claude` on `PATH`. After the run, `sandbox/` should contain both `riddle_<suffix>.txt` and `solution_<suffix>.txt`, and `state/<runId>/state.json` should report `status: "completed"` for both steps.

## Resume / memoization

Re-run with the same `runId` to see both steps return cached results without spawning Claude again:

```sh
bun run examples/riddle-solver/index.ts --run-id=<id-from-previous-run>
```

The shared filename `<suffix>` is derived from the `runId` (with the leading `r-` stripped), so a resume always references the exact files step 1 wrote on the original run — even if you delete step 2's state and let it re-execute against the original riddle.

`sandbox/` and `state/` are disposable — delete either at any time.
