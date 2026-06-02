---
date: 2026-06-02
status: requirements
area: tests/setup, src/hosts/two-pane
related-issue: docs/issues/2026-06-01-two-pane-tmux-server-vanishes-resume-hard-fails-under-cmux.md
---

# Per-owner tmux socket cleanup — stop the test sweep from killing live servers

## Problem

`tests/setup/cleanup-stale-tmux.ts` runs as a `bunfig.toml` test preload and
reaps every tmux socket under `/tmp/tmux-<uid>/` (and `/private/tmp/...`) whose
name starts with `orch-` and whose mtime is older than 5 minutes, via
`tmux -L <name> kill-server`.

That filter is too broad. Real workflow servers are named `orch-r-<runId>`
(`createTmuxHost` derives `socketName('orch-' + runId)`, `src/hosts/two-pane/tmux-host.ts:419`),
so they share the `orch-` prefix the sweep matches. All tmux sockets — prod and
test — live in the same shared `/tmp/tmux-<uid>/` directory, so a `bun test`
process scanning that directory sees every server on the host regardless of who
created it.

The reported incident (see related issue): a production `execute-plan` workflow
lost its `orch-r-2026-06-01-151213-4s` server ~5 min 14 s after it started —
matching the sweep's 5-minute cutoff almost exactly. The most likely cause is a
`bun test` invocation in the repo running the preload, finding the live (now
>5 min old) production socket, and killing it.

There is a second, independent failure mode (concurrent `orch resume`/teardown
on a shared `orch-r-<runId>` server). **It is explicitly out of scope here** —
see Non-goals.

### Why this is hard to narrow

Two facts make a naive fix wrong:

1. **The integration harness creates prod-shaped sockets.** `tests/helpers/real-tmux/fixture.ts`
   builds its socket as `orch-${runId}` from a real `generateRunId(...)`, so a
   *leaked integration-test server* looks exactly like production: `orch-r-2026-…`.
   A "denylist `orch-r-*`" would protect prod but stop reaping these leaked
   test servers — reintroducing the suite flakiness the cleanup exists to fix
   (leaked puppet daemons pile up and ~8×-slow the suite).

2. **The cleanup has two jobs that pull apart.** It must (a) reap orphans left
   by *previously crashed* runs, while (b) never killing a socket a *currently
   running* parallel run owns. The discriminator between "crashed orphan" and
   "live parallel run" is **whether the owning process is still alive** — not a
   name or an age. A bare per-run id cannot answer that; "only reap my own id"
   means nobody ever reaps a crashed run's leak.

## Goal

Make the test cleanup sweep **structurally incapable of touching a production
tmux server**, and **deterministically safe against parallel test runs**, while
still reaping leaked servers from crashed test runs.

Three concrete outcomes:

- A `bun test` process can never name an `orch-r-<runId>` (production) socket as
  a reap target.
- Two parallel `bun test` invocations never reap each other's *live* sockets.
- A crashed/interrupted test run's leaked sockets are still reaped (no
  regression of the existing suite-flakiness fix).

## Approach (chosen)

Two coupled changes — a reserved, pid-stamped namespace for test sockets, and a
liveness-gated sweep.

### 1. Reserved, pid-stamped namespace for every test-created socket

All sockets created during a test run carry a reserved prefix and an embedded
owner pid:

```
orch-test-<pid>-<nonce>
```

- `orch-test-` is the reserved prefix. Production runs are always `orch-r-<runId>`
  (runId starts with `r-`), so `orch-test-` can never collide with a prod socket.
- `<pid>` is the owning test process id. `<nonce>` keeps names unique within one
  process and guards against pid reuse.
- `allocateSocketName` (`tests/helpers/real-tmux/socket.ts`) already produces
  `orch-${tag}-${pid}-${nonce}` — the pid is already there; this is a prefix
  alignment, not a new mechanism.

Naming note: use `-test-`, not `-it-`. The only hard constraints are the socket
grammar `/^[a-z0-9-]+$/` and that the first segment after `orch-` must never be
`r` (the prod run-id segment). `-test-` is clearer than the `-it-` jargon.

### 2. Liveness-gated sweep (replaces the age heuristic)

`cleanup-stale-tmux.ts` reaps a socket **iff**:

1. its name starts with `orch-test-` (never matches prod `orch-r-*`), **and**
2. its embedded `<pid>` is dead — `process.kill(pid, 0)` throws `ESRCH`.

| Socket | Prefix match | Owner pid | Reaped? |
|---|---|---|---|
| Prod `orch-r-<id>` | no | — | never (prefix) |
| Live parallel test `orch-test-<pid2>-…` | yes | alive | no (liveness) |
| Crashed test leak `orch-test-<pid1>-…` | yes | dead | yes ✓ |

The flaky 5-minute age window is **dropped**; reaping becomes deterministic.

**pid-reuse edge:** if a dead run's pid was recycled by an unrelated live
process, the sweep reads "alive" and skips that one orphan — a harmless *missed*
cleanup, never a wrongful kill (the sweep only ever kills when the pid is dead).
The `<nonce>` and an optional "is this actually a tmux server" check shrink this
to near-zero. Optionally keep a generous age fallback (e.g. 30 min) as
belt-and-suspenders; default recommendation is no age fallback.

### Production-code seam required

The integration fixture currently gets `orch-${runId}` only because
`createTmuxHost` derives its socket internally (`tmux-host.ts:419`). To route
every test socket through the `orch-test-<pid>-<nonce>` namespace,
`createTmuxHost` needs an **optional explicit socket** input (or socket prefix)
that the fixture supplies via `allocateSocketName`.

- Production callers pass nothing → behavior is unchanged (`orch-r-<runId>`).
- The fixture allocates a prefixed, pid-stamped socket and passes it in.

This is the only production-facing change; the prefix value, the liveness
helper, and dropping the age constant all live in test code. Exact shape of the
override (param name, prefix-vs-full-socket) is a planning decision.

## Why not the alternatives

- **Denylist prod grammar (`skip ^orch-r-…`) in the cleanup, leave names alone.**
  Smallest diff, zero prod-code change — but the integration harness *is*
  `orch-r-…`, so it stops reaping leaked test servers and regresses the
  suite-flakiness fix. Rejected (the trap).
- **Ownership registry / marker files, name-agnostic.** Harness records every
  socket it boots; sweep reaps only registered-and-orphaned entries. Cleaner
  invariant but more moving parts than a test preload warrants, and crash-leaked
  entries still need a liveness/age fallback — circling back to the same
  mechanism. Over-built for the problem.
- **Scope-id + age fallback ("reap my own id aggressively, others by age").**
  Still reaps a legitimately long-running (>threshold) parallel run's sockets;
  only shrinks the window rather than closing it. pid-liveness is strictly
  better.

## Success criteria

- Running `bun test` in the repo while an unrelated live `orch-r-*` two-pane
  workflow is active never kills that workflow's server (reproduces the incident
  scenario; must pass).
- Two parallel `bun test` invocations, each booting real-tmux fixtures, never
  reap each other's *live* sockets — even if a fixture runs longer than the old
  5-minute window.
- A socket left behind by a killed (SIGKILL) test process is reaped by the next
  `bun test` preload.
- No bare `orch-` / `orch-r-` socket is ever created by test code (audit: all
  test socket creation flows through the reserved prefix).
- `bun run check` green.

## Non-goals

- **Hypothesis 2 — concurrent `orch resume`/teardown on a shared `orch-r-<runId>`
  server.** That socket is shared by design (derived from runId); two owners can
  legitimately land on it and one's `kill-server` removes the other's. Needs
  per-run ownership/locking, not a namespace change. Separate effort.
- **cmux detection / defaulting to `plain` under cmux.** Tracked in the issue's
  prevention ideas; not part of this fix.
- **tmux lifecycle telemetry** (pid/ppid/pgid/inode logging). Useful but
  orthogonal.

## Open questions / assumptions

- **Age fallback:** assume the 5-minute age threshold is removed entirely and
  reaping is pure pid-liveness. If a belt-and-suspenders fallback is wanted, a
  generous (~30 min) one is cheap. Decide in planning.
- **Override shape on `createTmuxHost`:** explicit `socket: SocketName` vs a
  `socketPrefix` knob vs an env-driven prefix read by both fixture and host.
  Planning decision; the requirement is only that test code can force the
  reserved namespace without changing production behavior.
- **pid-reuse hardening:** whether to add an "is this socket actually a live
  tmux server / does the nonce still match" probe before trusting a "pid alive"
  read. Low priority given the edge errs safe (missed cleanup, not wrongful
  kill).

## Affected code (for planning)

- `tests/setup/cleanup-stale-tmux.ts` — prefix narrowing + liveness gate, drop age.
- `tests/helpers/real-tmux/socket.ts` — `orch-test-<pid>-<nonce>` prefix.
- `tests/helpers/real-tmux/fixture.ts` — allocate via the prefixed helper, pass
  socket into `createTmuxHost`.
- `src/hosts/two-pane/tmux-host.ts` (~line 419) — optional explicit socket input.
- Any test asserting on socket names (`orch-${runId}` expectations).
</content>
</invoke>
