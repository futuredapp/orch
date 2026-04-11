# hello-file

Minimal end-to-end demo of the orch pipeline: one workflow step that tells the real `claude` CLI to create `hello.txt` in a sandbox directory.

## Run

```sh
bun run examples/hello-file/index.ts
```

Requires `claude` on `PATH`. After the run, `sandbox/hello.txt` should contain `Hello World` and `state/<runId>/state.json` should have `status: "completed"`.

## Resume / memoization

Re-run with the same `runId` to see the workflow return the cached result without spawning Claude again:

```sh
bun run examples/hello-file/index.ts --run-id=<id-from-previous-run>
```

`sandbox/` and `state/` are disposable — delete either at any time.
