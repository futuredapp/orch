---
date: 2026-05-27
topic: real-tmux-suite-flakiness
status: shipped
---

# Real-tmux test flakiness — leaked puppet daemons, not slow tests

## Symptom

The full `bun run test` suite reported a rotating cast of failures — 6 one
run, a *different* 6 the next — almost entirely in real-tmux Tier 1 / Tier 5
behavioral tests. The failures looked like timing flakes:

```
(fail) Tier 5 behavioral — step glyph flips on complete … [20131.89ms]
(fail) Tier 1 — view-mode footer reflects the current mode … [7690.93ms]
  ^ this test timed out after 5000ms.
(fail) AskApp > renders the question … [6081.12ms]   ← not even a tmux test
```

Every one of them **passed in isolation**, and passed again on re-run. The
tell that this was not "a few slow tests" was the wall clock: the full suite
took **≈590–640s**. A clean run of the exact same suite takes **≈78s**. An
8× slowdown, and unrelated pure-Ink unit tests (`AskApp`) were timing out
too — so the *machine*, not the tests, was degraded.

## Root cause

Leaked **`src/runners/scripted-fake/__entry.ts` puppet processes**.

Behavioral tests spawn a real `orch` subprocess and drive it with the
scripted-fake runner. The blocking puppet scripts (`puppet`,
`emit-then-hang`, `wait-for-file`) are designed to run until the parent
kills them by signal. But the harness tears orch down with **SIGKILL**, which
is uncatchable — orch dies without reaping its children. A puppet blocked in
its poll loop then reparents to init and **polls forever**.

~16 puppets leak per full run. They survive the run, each burning 0–3% CPU,
and accumulate across runs (devs run the suite repeatedly). After a handful
of runs there are dozens-to-hundreds of orphaned `bun` daemons starving the
CPU — which is exactly what stretches the suite to 640s and pushes real-tmux
timing budgets past their timeouts. The flakiness was a *secondary* effect of
a process leak.

Two traps cost time while diagnosing this:

- **`pkill`-ing the `bun test` runner makes it worse.** It bypasses
  `afterEach` teardown and orphans every in-flight puppet *and* its tmux
  server at once. (This is how a stray 689-daemon pileup appeared mid-debug.)
- **A 10-core `yes` load is too harsh a stress proxy.** Pinning every core at
  100% starves tmux's own server/socket *creation* and induces init-races
  (`bind-key … No such file`) that never occur under the real suite's
  partial, bursty contention. The faithful oracle is `bun run test` on a
  clean machine.

## Fix

Make the puppet self-reap when its parent is gone —
`src/runners/scripted-fake/__entry.ts`:

```ts
const SPAWN_PARENT_PID = process.ppid

function parentExited(): boolean {
  try {
    process.kill(SPAWN_PARENT_PID, 0) // signal 0 = liveness probe, sends nothing
    return false
  } catch {
    return true // ESRCH — orch is gone
  }
}
```

Each blocking loop checks `parentExited()` once per tick and `return 0`s when
it fires. Result: lifecycle run leaves **0 orphans** (was 16); full
`bun run check` leaves 0 puppets / 0 bun-orphans and runs in ~78s.

**Gotcha that broke the first attempt:** Bun caches `process.ppid` at startup.
After reparenting to init it still reports orch's original pid, so comparing
`process.ppid` never detects orphaning. You must probe the *original parent's*
liveness (`kill(pid, 0)`), not re-read `ppid`. PID-reuse is a theoretical
false-negative but irrelevant here — the puppet should die within one tick of
orch's death.

Defense-in-depth (so legitimate transient contention can't flake these
either): real-tmux tests now use two shared budgets from
`tests/helpers/real-tmux/fixture.ts` instead of ad-hoc 5s/10s magic numbers —
`REAL_TMUX_TEST_TIMEOUT_MS` (30s, the `it()` ceiling) and
`REAL_TMUX_ASSERT_TIMEOUT_MS` (15s, internal poll budget). Polling assertions
return on first match, so a larger budget costs nothing on the fast path. The
header-duplicate test also moved from a fixed `sleep(300)` + one-shot capture
to a poll-until-settled, which cleanly separates "transient repaint lag"
(settles) from the real regression it guards (permanent breadcrumb stacking,
never settles).

## Lesson

When tests "flake on timing" but pass in isolation, check the **wall clock and
the process table before touching budgets**. An N× whole-suite slowdown plus
unrelated tests failing means a poisoned environment, not flaky assertions.

```sh
pgrep -fl scripted-fake/__entry.ts                       # leaked puppets
ps -Ao pid,ppid,comm | awk '$3=="bun" && $2==1'          # orphaned bun daemons (PPID 1)
pkill -9 -f scripted-fake/__entry.ts                     # reap, then re-run clean
```

Any test harness that SIGKILLs a process which spawns long-lived children
needs those children to self-reap (parent-liveness probe) or to be killed as a
process group — SIGKILL cannot clean up after itself.

## References

- `src/runners/scripted-fake/__entry.ts` — `parentExited()` and the three
  blocking loops.
- `tests/helpers/real-tmux/fixture.ts` — `REAL_TMUX_TEST_TIMEOUT_MS`,
  `REAL_TMUX_ASSERT_TIMEOUT_MS`.
- `tests/helpers/behavioral-dsl/internal/subprocess.ts` — `killSubprocess`
  (SIGTERM → 1s → SIGKILL) and `reapTmuxServer`.
