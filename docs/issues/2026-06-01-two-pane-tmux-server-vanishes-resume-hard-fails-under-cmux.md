---
date: 2026-06-01
status: open
area: src/hosts/two-pane
severity: high
confidence: failure mechanism confirmed; leading causes are test stale-tmux cleanup and possible concurrent orch teardown
repro-run: .orch/state/r-2026-06-01-151213-4s/ (in kridla-dabing-ai--feat--extra_prompt, NOT this repo)
---

# Two-pane tmux server disappears during orch workflow

## Summary

An `execute-plan` workflow running in `two-pane` mode lost its per-run tmux
server while the workflow was active. The user was running the workflow from a
cmux terminal surface, but cmux is no longer the only or leading explanation.

The strongest current hypotheses are:

1. **The test stale-tmux cleanup killed the live workflow server.**
   `tests/setup/cleanup-stale-tmux.ts` is wired through `bunfig.toml` as a Bun
   test preload and kills every `/private/tmp/tmux-<uid>/orch-*` socket older
   than five minutes. It does not distinguish test sockets from real workflow
   sockets such as `orch-r-2026-06-01-151213-4s`.
2. **A concurrent orch process or resume path tore down the same per-run server.**
   `host.teardown()` explicitly runs `tmux -L <socket> kill-server`. If two
   processes own the same run/socket, one can remove the server while the other
   is still using it.

cmux remains relevant as an execution environment and restore/lifecycle factor,
but local evidence does not prove that cmux killed the detached tmux daemon.

## User-visible failure

The user ran:

```sh
bunx orch resume r-2026-06-01-151213-4s
```

The TUI/attach path failed with:

```text
[server exited]
[orch tmux] attach exited with code 1
[orch tui] TmuxCommandError: tmux send-keys failed (exit 1): error connecting to
  /private/tmp/tmux-501/orch-r-2026-06-01-151213-4s (No such file or directory)
[orch] tmux server is no longer reachable - workflow cannot continue in background.
Workflow "execute-plan" failed: tmux server is no longer reachable
```

Working directory:

```text
/Users/martinsumera/projects/futured/kridla-dabing-ai--feat--extra_prompt
```

Run state:

```text
.orch/state/r-2026-06-01-151213-4s/
```

## Confirmed facts

1. **The run was inside cmux.**
   `logs/run.meta.json#envKeys` contains `CMUX_SOCKET`,
   `CMUX_SOCKET_PATH`, `CMUX_PANEL_ID`, `CMUX_SURFACE_ID`, `CMUX_TAB_ID`,
   `CMUX_WORKSPACE_ID`, and related variables.

2. **The per-run tmux socket disappeared.**
   The observed tmux error is `No such file or directory` for:

   ```text
   /private/tmp/tmux-501/orch-r-2026-06-01-151213-4s
   ```

3. **orch creates per-run sockets from the run id.**
   `createTmuxHost()` derives `socketName(\`orch-${opts.runId}\`)`, so this
   run uses `tmux -L orch-r-2026-06-01-151213-4s`.

4. **The tmux appliance is configured not to self-delete just because it is empty
   or unattached.**
   The generated tmux config sets `exit-empty off` and
   `destroy-unattached off`.

5. **Current `resume` does recreate the tmux server.**
   The earlier issue note said resume had no recreate fallback. That is not
   correct for current code. `resume.ts` calls the host factory with the
   original run id, and `createTmuxHost()` calls `initOrchSession()`, which
   creates a fresh `tmux -L orch-<runId>` server if it is missing.

6. **The logs show repeated create-then-vanish behavior.**
   Later resume attempts log `tmux-session-created` successfully, then fail
   minutes later with `tmuxReachabilityProbeFailed: true` and the same missing
   socket path.

7. **A live recreated server later had `PPID=1` and its own process group.**
   That weakens the theory that cmux simply killed a direct child process tree.

8. **The test cleanup matches real workflow sockets.**
   `tests/setup/cleanup-stale-tmux.ts` uses prefix `orch-` and age threshold
   `5 * 60 * 1000`, then runs:

   ```text
   tmux -L <name> kill-server
   ```

   It is wired as a Bun test preload in `bunfig.toml`.

## Timeline notes

- Original run starts at `2026-06-01T13:12:13.665Z`.
- First missing-socket failure appears around `2026-06-01T13:17:28Z`, about
  5 minutes and 14 seconds after the run/server was created.
- Later resume attempts successfully create a new tmux server and then lose it
  again.
- Reboot is not supported by local evidence: `last reboot` showed the last boot
  on `2026-05-25`, not `2026-06-01`.

The first failure timing is highly suspicious because it lines up with the
stale cleanup's five-minute cutoff.

## Leading hypothesis 1: stale tmux test cleanup kills live workflow sockets

**Theory:** while the workflow is running, some process starts `bun test` in
this repo. Bun preloads `tests/setup/cleanup-stale-tmux.ts`. That preload scans
`/tmp/tmux-501` and `/private/tmp/tmux-501`, finds
`orch-r-2026-06-01-151213-4s` older than five minutes, runs
`tmux -L orch-r-2026-06-01-151213-4s kill-server`, and removes the socket.

**Why this fits:**

- The cleanup prefix is broad: `orch-*`.
- The real workflow socket also starts with `orch-`.
- The age threshold is five minutes.
- The first death happened just over five minutes after creation.
- The observed failure is exactly what `kill-server` would produce: the server
  exits and the socket disappears.

**Prediction if true:**

- Running `bun test` in this repo while an unrelated `orch-r-*` tmux server is
  older than five minutes will kill that server.
- Changing the cleanup to only match test-owned prefixes should stop this class
  of failure.
- Adding logging to the cleanup would show it selecting
  `orch-r-2026-06-01-151213-4s` immediately before the workflow loses tmux.

**How to confirm safely:**

1. Start a disposable `tmux -L orch-r-debug-cleanup-test ...` server.
2. Wait until its socket is older than five minutes.
3. Run a minimal `bun test` command in this repo.
4. Check whether the disposable server is killed.

Do not run this against a real active workflow.

## Leading hypothesis 2: concurrent orch owner tears down the same run socket

**Theory:** two orch processes target the same run id/socket. One process sees a
quit, signal, mapped error, normal completion, or attach-lost path and calls
`host.teardown()`. Teardown kills the visible session and then explicitly calls
`killServer()`, removing the tmux server for the other process.

**Why this fits:**

- The socket name is deterministic by run id, so concurrent resumes share the
  same `tmux -L orch-r-...` server.
- `executeWithAttach()` tears down on several paths, including signal handling,
  foreground quit, caught errors, and final completion.
- `host.teardown()` explicitly runs `tmux -L <socket> kill-server`.
- The run had repeated resume attempts, increasing the chance of overlapping
  owners or stale processes.

**What weakens it:**

- In the observed lifecycle log, teardown failure records appear after the
  reachability probe already reports the socket missing.
- That means the logged teardown in that process was likely a consequence, not
  the first cause.

**Prediction if true:**

- Two concurrent `orch resume r-...` processes can reproduce the server
  disappearing for one owner when the other exits or tears down.
- Adding per-run ownership/lock metadata should prevent the disappearance.
- Logs with process id / host owner id would show a different orch process
  initiating `tmux-server-teardown-start`.

## cmux hypothesis: relevant but not proven primary cause

cmux is still part of the incident:

- The run inherited `CMUX_*` variables.
- The orch nested-tmux guard only checks `$TMUX`, so it does not treat cmux as
  a nested terminal/multiplexer environment.
- A Claude Code `SessionEnd` hook under cmux appeared in one agent stderr log.
- cmux later detected the surface as a tmux attach command:

  ```text
  tmux -L orch-r-2026-06-01-151213-4s attach -t orch
  ```

But the evidence does not prove cmux killed the detached tmux daemon. A later
server for the same run had `PPID=1`, so ordinary direct child reaping is not a
complete explanation.

cmux should be treated as a risk factor and compatibility concern, not the
confirmed root cause.

## Prevention ideas

1. **Narrow stale-tmux cleanup.**
   Test cleanup should only reap sockets it can prove are test-owned. Do not
   match all `orch-*`.

2. **Add per-run tmux ownership metadata.**
   Record owner pid, socket, created time, and run id. Teardown should avoid
   killing a server owned by another active process unless ownership is proven.

3. **Add a run-level lock for `resume`.**
   Prevent two `orch resume <same-run>` processes from owning the same tmux
   host concurrently.

4. **Add tmux lifecycle telemetry.**
   Log tmux daemon pid, ppid, pgid, socket path, socket mtime/inode, and host
   owner process id at creation and before teardown.

5. **Detect cmux explicitly.**
   If `CMUX_SOCKET_PATH`, `CMUX_PANEL_ID`, or `CMUX_WORKSPACE_ID` are present,
   warn or default to `plain` unless `two-pane` was explicitly requested.

6. **Improve diagnostics.**
   When a missing socket is detected, report the likely external causes:
   stale cleanup, concurrent resume/teardown, explicit `kill-server`, cmux
   surface lifecycle, or OS/tmp cleanup.

## Immediate workaround

For important work until the root cause is fixed:

```sh
bunx orch resume r-2026-06-01-151213-4s --mode=plain
```

Also avoid running `bun test` in this repo while long-running `orch-r-*`
two-pane workflows are active.

## References

- Repro state:
  `.orch/state/r-2026-06-01-151213-4s/` in
  `kridla-dabing-ai--feat--extra_prompt`
- Socket naming:
  `src/hosts/two-pane/tmux-host.ts`
- Tmux config:
  `src/services/tmux/session-init.ts`
- Resume host creation:
  `src/cli/commands/resume.ts`
- Attach/teardown handling:
  `src/cli/commands/execute-with-attach.ts`
- Explicit server teardown:
  `src/hosts/two-pane/tmux-host.ts`
- Test cleanup:
  `tests/setup/cleanup-stale-tmux.ts`
- Bun preload wiring:
  `bunfig.toml`
