---
date: 2026-06-02
status: completed
type: fix
area: tests/setup, tests/helpers/real-tmux, tests/helpers/behavioral-dsl, src/hosts/two-pane
origin: docs/brainstorms/2026-06-02-fix-per-owner-tmux-socket-cleanup-requirements.md
related-issue: docs/issues/2026-06-01-two-pane-tmux-server-vanishes-resume-hard-fails-under-cmux.md
---

# fix: Per-owner tmux socket cleanup — stop the test sweep from killing live servers

## Summary

The `bun test` preload `tests/setup/cleanup-stale-tmux.ts` reaps every tmux socket
matching `orch-*` older than 5 minutes. Production workflow servers are named
`orch-r-<runId>` and share that `orch-` prefix, so a test run on the same host can
(and did — see related issue) kill a live production server ~5 minutes after it
started.

This plan makes the sweep **structurally incapable of naming a production socket**
and **deterministically safe against parallel test runs**, while still reaping leaked
servers from crashed test runs. Two coupled changes from the origin doc:

1. **Reserved, pid-stamped namespace** for every test-created socket:
   `orch-test-<pid>-<nonce>`. `orch-test-` can never collide with prod `orch-r-…`.
2. **Liveness-gated sweep** replacing the age heuristic: reap **iff** the name starts
   with `orch-test-` **and** the embedded `<pid>` is dead (`process.kill(pid, 0)` throws
   `ESRCH`). The 5-minute age window is dropped entirely.

**Scope correction over the origin doc:** the origin doc's affected-code list covered
only the in-process Tier 1 fixture. Research found a second, larger population — the
**34 Tier 5 behavioral-dsl tests** that spawn the real `orch` CLI as a subprocess. That
subprocess boots a prod-shaped `orch-r-<runId>` socket via `host-registry` →
`createTmuxHost`, which both evades the new reaper and violates the origin's own success
criterion *"all test socket creation flows through the reserved prefix."* Tier 5 is
therefore **brought into scope** here via a narrow, test-only env bridge (see
[Key Technical Decisions](#key-technical-decisions), KTD-3).

---

## Problem Frame

Two facts (carried from origin) make a naive fix wrong:

1. **The integration harness creates prod-shaped sockets.** Both Tier 1
   (`tests/helpers/real-tmux/fixture.ts` → `orch-${runId}`) and Tier 5
   (`tests/helpers/behavioral-dsl/internal/subprocess.ts` → the real CLI's
   `orch-${runId}`) currently produce names indistinguishable from production. A
   "denylist `orch-r-*`" would protect prod but stop reaping leaked *test* servers —
   reintroducing the suite flakiness the cleanup exists to fix.
2. **The cleanup has two jobs that pull apart.** Reap orphans from *crashed* runs, but
   never kill a socket a *currently running* parallel run owns. The only honest
   discriminator is **whether the owning process is still alive** — not a name, not an
   age. That requires the owner pid embedded in the socket name.

The fix resolves both by (a) putting all test sockets in a reserved namespace prod can
never enter, and (b) gating reap on embedded-pid liveness.

---

## Goal & Success Criteria

Carried verbatim from origin (`see origin`):

- Running `bun test` while an unrelated live `orch-r-*` two-pane workflow is active
  never kills that workflow's server (the incident repro — must pass).
- Two parallel `bun test` invocations, each booting real-tmux fixtures, never reap each
  other's *live* sockets — even if a fixture runs longer than the old 5-minute window.
- A socket left behind by a SIGKILL'd test process is reaped by the next `bun test`
  preload.
- No bare `orch-` / `orch-r-` socket is ever created by test code (audit: **all** test
  socket creation — Tier 1 **and** Tier 5 — flows through the reserved prefix).
- `bun run check` green.

---

## Key Technical Decisions

- **KTD-1 — Socket grammar: `orch-test-<pid>-<nonce>`, pid is the first segment after
  the reserved prefix.** The sweep parses pid by stripping `orch-test-` and taking the
  first `-`-delimited segment, so parsing is trivial and unambiguous regardless of any
  future debug tag. `<pid>` is decimal digits, `<nonce>` is crypto hex — both satisfy
  the `SocketName` grammar `/^[a-z0-9-]+$/`. Production `orch-r-<runId>` always has `r`
  as its first segment (`RUN_ID_PATTERN = /^r-…/`, `src/state/run-id.ts:8`), so the
  `orch-test-` prefix **structurally** never matches a prod socket. *(see origin:
  Approach §1)*

- **KTD-2 — In-process seam: explicit optional `socket?: SocketName` on
  `createTmuxHost`.** Production callers pass nothing → `socketName(\`orch-${runId}\`)`
  unchanged. The Tier 1 fixture passes its allocated `orch-test-…` socket. Chosen over a
  `socketPrefix` knob or a primary env mechanism: smallest diff, type-safe, no implicit
  global coupling. *(resolves origin open question "Override shape on createTmuxHost";
  user-confirmed during planning)*

- **KTD-3 — Out-of-process seam (Tier 5): a narrow test-only env bridge that populates
  the same `socket` param.** The real `orch` CLI cannot receive a TypeScript param, so
  the Tier 5 launcher passes `ORCH_TMUX_SOCKET=orch-test-<pid>-<nonce>` in the spawned
  process's env; `host-registry`'s two-pane factory reads it once and threads it into
  `createTmuxHost`'s `socket` param. **Env unset → production behavior is byte-for-byte
  unchanged** (`orch-r-<runId>`). This is not the *primary* mechanism (KTD-2 is); it is
  the only injection channel into a subprocess, and it sets the same explicit param. The
  alternative — scoping Tier 5 out — was rejected because it would violate the "all test
  socket creation flows through the reserved prefix" success criterion and leave
  SIGKILL'd Tier 5 leaks unreapable.

- **KTD-4 — Pure pid-liveness, no age fallback.** `STALE_AGE_MS` is removed entirely;
  reaping is deterministic. The pid-reuse edge (a dead run's pid recycled by an unrelated
  live process) errs **safe** — the sweep reads "alive" and skips that one orphan
  (harmless *missed* cleanup, never a wrongful kill). `<nonce>` shrinks this to near-zero.
  *(resolves origin open question "Age fallback"; user-confirmed during planning)* No
  tmux-server probe is added (origin "pid-reuse hardening" open question) — the edge
  already errs safe and a probe is not worth the moving parts.

- **KTD-5 — Reaper is extracted into an importable, dependency-injectable module with
  no top-level call.** `tests/setup/cleanup-stale-tmux.ts` stays the thin
  side-effecting preload (`await reapStaleTestSockets()`); the logic moves to a sibling
  module exporting a pure function. This is what makes the headline behavioral tests
  (U6) possible without triggering a real sweep on import, and keeps the preload's
  import-time side effect (a deliberate, documented exception to the project's
  no-import-side-effects rule) confined to one 3-line file.

---

## High-Level Technical Design

*This illustrates the intended approach and is directional guidance for review, not
implementation specification. The implementing agent should treat it as context, not
code to reproduce.*

Reaper decision (the core invariant):

```
reap(socketName) iff:
    socketName startsWith 'orch-test-'        # prefix gate — never matches orch-r-…
    AND pidOf(socketName) is dead             # process.kill(pid, 0) throws ESRCH

pidOf('orch-test-<pid>-<nonce>') = parseInt(firstSegmentAfter('orch-test-'))
```

Two seams, one param. Both routes converge on `createTmuxHost`'s `socket` param:

```
Tier 1 (in-process)        fixture.allocateSocketName() ──► createTmuxHost({ socket })
Tier 5 (subprocess)        launcher sets env ORCH_TMUX_SOCKET ─► host-registry reads ─►
                                                                 createTmuxHost({ socket })
Production (CLI)           env unset, no param ───────────────► socketName(`orch-${runId}`)
```

Reap truth table (carried from origin):

| Socket | `orch-test-` prefix | Owner pid | Reaped? |
|---|---|---|---|
| Prod `orch-r-<id>` | no | — | **never** (prefix gate) |
| Live parallel test `orch-test-<pid2>-…` | yes | alive | no (liveness) |
| Crashed test leak `orch-test-<pid1>-…` | yes | dead | **yes ✓** |

---

## Implementation Units

Dependency graph:

```
U1 (namespace + pid parse)
 ├─► U2 (createTmuxHost socket param)
 │     ├─► U3 (Tier 1 fixture + mountTmuxHost)
 │     └─► U4 (Tier 5 env bridge + launcher)
 ├─► U5 (liveness-gated reaper extraction)
 │     └─► U6 (behavioral cleanup tests)  ◄── also exercises U3/U4 sockets
 └─► U7 (assertion fixups + audit guard + docs)
```

---

### U1. Reserved `orch-test-<pid>-<nonce>` namespace + pid-parse helper

**Goal:** Move `allocateSocketName` to the reserved `orch-test-` prefix with the pid as
the first segment, and export a `pidFromTestSocket(name)` helper the sweep (U5) will use.

**Requirements:** Success criterion "no bare `orch-`/`orch-r-` socket is created by test
code"; foundation for KTD-1.

**Dependencies:** none.

**Files:**
- `tests/helpers/real-tmux/socket.ts` — change the produced name; add `pidFromTestSocket`.
- `tests/unit/hosts/two-pane/real-tmux-harness/socket-allocation.test.ts` — update grammar
  expectations (currently asserts `^orch-t-\d+-[0-9a-f]+$`).

**Approach:**
- `allocateSocketName()` returns `socketName(\`orch-test-${process.pid}-${nonce}\`)`. Drop
  the free-form `tag` *prefix* position; if a debug tag is still wanted it must sit
  **after** the pid so `pidFromTestSocket` stays positional (KTD-1). Simplest acceptable
  shape — no tag — is fine; the origin doc treats the tag as optional.
- Add `export function pidFromTestSocket(name: string): number | undefined` — returns the
  parsed pid when `name` starts with `orch-test-` and the first following segment is all
  digits; `undefined` otherwise. This is the single source of truth for parsing, shared
  by U5's sweep and U6's tests.
- `RESERVED_TEST_PREFIX = 'orch-test-'` exported as a named constant so U5 and U7 import
  it rather than re-literalize the string.

**Patterns to follow:** existing `allocateSocketName` structure and `socketName` smart
constructor (`src/services/tmux/tmux-service.ts:49`).

**Test scenarios:**
- Happy path: `allocateSocketName()` matches `/^orch-test-\d+-[0-9a-f]+$/` and embeds
  `process.pid` as the first segment after `orch-test-`.
- Uniqueness: two successive calls differ (nonce).
- Covers success criterion: the result never starts with `orch-r-` and is never the bare
  `orch-` form.
- `pidFromTestSocket('orch-test-12345-ab12cd')` → `12345`.
- `pidFromTestSocket('orch-r-2026-06-01-151213-4s')` → `undefined` (prod-shaped, prefix
  miss).
- `pidFromTestSocket('orch-test-notapid-xx')` → `undefined` (non-numeric pid segment).
- Round-trip: `pidFromTestSocket(allocateSocketName())` === `process.pid`.

---

### U2. Optional explicit `socket` on `createTmuxHost`

**Goal:** Let a caller supply the socket instead of deriving `orch-${runId}` internally,
with production behavior unchanged when omitted.

**Requirements:** KTD-2; enables U3 and U4.

**Dependencies:** U1 (uses `SocketName`; not strictly required but lands the seam the
fixture targets).

**Files:**
- `src/hosts/two-pane/tmux-host.ts` — add `readonly socket?: SocketName` to
  `TmuxHostOptions` (~line 289); change line 419 to
  `const socket = opts.socket ?? socketName(\`orch-${opts.runId}\`)`.
- `tests/unit/hosts/tmux-host.test.ts` — add coverage for both branches.

**Approach:**
- Single resolution point at line 419. **Audit that every downstream consumer reads the
  resolved local `socket`** — `initOrchSession({ socket })` (422), `buildPaneDiedCommand(socket)`
  (427), `listPanes` (442), and the teardown / process-exit backstop. The only literal
  `orch-${runId}` derivation in the file is line 419 (verified: line 791 is an unrelated
  log filename `orch-stdio.log`); no other site reconstructs the socket from runId.
- Document the param: "Explicit socket override. Production omits it →
  `orch-${runId}`. The real-tmux harness passes a reserved `orch-test-…` socket so the
  stale-socket preload can never name a prod server."

**Patterns to follow:** the existing `opts.tmux ?? new RealTmuxService(...)` and
`opts.fs ?? new BunFsService()` optional-with-default style already in `createTmuxHost`.

**Test scenarios:**
- Happy path (omitted): `createTmuxHost` without `socket` uses `orch-${runId}` — assert
  via the `FakeTmuxService` recorded `createSession`/`listPanes` socket argument
  (existing tests at `tmux-host.test.ts:118` already inspect setup calls — extend them).
- Happy path (provided): passing `socket: socketName('orch-test-99-abcd')` makes every
  recorded tmux call target that socket, and `buildPaneDiedCommand` embeds it.
- Edge: `pane-died` hook command references the **provided** socket, not `orch-${runId}`
  (guards the backstop-uses-wrong-socket regression).
- Integration scenario: `runId` and `socket` may now diverge — assert the host still
  functions (session setup + pane split) when `socket` ≠ `orch-${runId}`.

---

### U3. Route the Tier 1 fixture + `mountTmuxHost` through the reserved socket

**Goal:** Decouple the fixture's socket from `runId`; allocate `orch-test-…` and pass it
into `createTmuxHost`.

**Requirements:** Tier 1 half of "all test socket creation flows through the reserved
prefix."

**Dependencies:** U1, U2.

**Files:**
- `tests/helpers/real-tmux/fixture.ts` — replace `socket = socketName(\`orch-${runId}\`)`
  (line 187) with `socket = allocateSocketName()`; update the `RealTmuxFixture.socket`
  doc comment (line 123, "Always `socketName('orch-' + runId)`") and the
  `CreateRealTmuxFixtureOptions.runId` comment (line 105) that claims runId "Determines
  the tmux socket name".
- `tests/helpers/real-tmux/workflow-driver.ts` — in `mountTmuxHost`, pass
  `socket: fixture.socket` into the `createTmuxHost({...})` call (line 114).
- `tests/helpers/real-tmux/README.md` — fix the "Allocates a fresh tmux socket
  (`orch-${runId}` so `createTmuxHost` lands on it)" description.

**Approach:**
- `runId` stays meaningful (state base `<stateBase>/<runId>`, logger, session naming);
  only the **socket** decouples. The fixture's existing `socketFilePaths(socket)` reaper
  (line 249) already keys off the `socket` value, so it follows automatically.
- `mountTmuxHost` already references `fixture.socket` everywhere it talks to tmux
  (lines 139, 151) — those become correct for free once the fixture holds the
  `orch-test-…` socket and `createTmuxHost` is told to use it.

**Patterns to follow:** the existing `LIVE_SOCKETS` registry + signal-handler reaping in
`fixture.ts` (lines 75–100) — unchanged, just now holds reserved-prefix names.

**Test scenarios:**
- Happy path: a mounted Tier 1 fixture's `socket` matches `/^orch-test-\d+-/` and the
  booted tmux server is reachable on that socket (`listPanes` returns ≥2 panes).
- Covers success criterion: `fixture.socket` is never `orch-r-…` and never the bare
  `orch-` form across a representative fixture boot.
- Integration scenario: `mountTmuxHost` + `createTmuxHost` land on the **same** server
  when `socket` ≠ `orch-${runId}` (a left-pane + right-pane resolve succeeds — proves the
  param actually threaded through, not just that two servers happened to boot).
- Idempotent teardown still removes the reserved-prefix socket file (extend the existing
  dispose test in `socket-allocation.test.ts`).

---

### U4. Tier 5 env bridge — make the spawned `orch` CLI honor a test socket

**Goal:** Route the 34 subprocess-based behavioral-dsl tests through the reserved
namespace so their crashed leaks are reapable and they stop creating prod-shaped sockets.

**Requirements:** Tier 5 half of "all test socket creation flows through the reserved
prefix"; KTD-3.

**Dependencies:** U1, U2.

**Files:**
- `src/cli/main.ts` (~line 350, where `createHostRegistry()` / `tmuxOverrides` are built)
  **or** `src/hosts/host-registry.ts` two-pane factory (line 131) — read
  `process.env.ORCH_TMUX_SOCKET` once and, when set and non-empty, pass
  `socket: socketName(env)` into `createTmuxHost`. Place the read at host-build time
  inside a function (not module top-level) to honor "no side effects at import".
- `tests/helpers/behavioral-dsl/internal/subprocess.ts` — allocate
  `const socket = allocateSocketName()` **before** spawn; add `ORCH_TMUX_SOCKET: socket`
  to the spawned env; set `socketToReap = socket` directly (replacing the
  `runId`-derived `orch-${runId}` at line 203) and drop the now-unused runId→socket
  derivation. Teardown's `reapTmuxServer(socketToReap)` (line 182) then reaps the reserved
  socket.
- `tests/helpers/behavioral-dsl/internal/lifecycle-handle.ts` — update the `socket` field
  doc comment (lines 36, 51) that says the socket is "derived from `'orch-' + runId`".

**Approach:**
- The env var is the bridge into a process that cannot take a TS param (KTD-3). It is
  read in exactly one place and defaults to off; a developer running the real CLI never
  sets it.
- `allocateSocketName()` runs in the **test/launcher** process, so the embedded `<pid>`
  is the launcher's pid — which is the process whose liveness the sweep checks. Confirm
  this is the intended owner: if the launcher dies (SIGKILL), its pid goes dead and the
  leak becomes reapable. ✔ (The spawned `orch` child is a different pid, but the sweep
  keys off the *embedded* pid = launcher, which is the durable owner the test controls.)
- Guard: validate the env value through the `socketName` smart constructor so a malformed
  override fails loudly rather than producing an out-of-grammar socket.

**Patterns to follow:** existing env passthrough conventions
(`src/services/process/merge-env.ts`); the existing `reapTmuxServer` teardown in
`subprocess.ts` (lines 171–205).

**Test scenarios:**
- Happy path (unit, host-registry): with `ORCH_TMUX_SOCKET` set, the two-pane factory
  passes that socket into `createTmuxHost` (assert via injected/fake host factory or the
  recorded `createTmuxHost` arg).
- Production default: with `ORCH_TMUX_SOCKET` unset/empty, no `socket` is passed →
  `orch-${runId}` derivation (regression guard that prod behavior is untouched).
- Edge: a malformed `ORCH_TMUX_SOCKET` (e.g. `orch_BAD`) throws at `socketName(...)`
  rather than booting an out-of-grammar server.
- Integration scenario (real, Tier 5): a launched `orch` run reports a `socket` of the
  form `/^orch-test-\d+-/` and that server is reachable; teardown reaps it and leaves no
  socket file. *(One representative behavioral-dsl test is enough; the other 33 inherit
  the launcher change.)*
- Covers success criterion: the launched run's socket is never `orch-r-…`.

---

### U5. Liveness-gated reaper — extract `reapStaleTestSockets`, drop the age window

**Goal:** Replace the broad age-based sweep with a prefix-gated, pid-liveness sweep
living in an importable, injectable module; keep the preload a thin shim.

**Requirements:** the central behavior; KTD-4, KTD-5; success criteria for parallel-run
safety, crashed-leak reaping, and prod-socket immunity.

**Dependencies:** U1 (prefix constant + `pidFromTestSocket`).

**Files:**
- `tests/setup/reap-test-sockets.ts` *(new)* — exported `reapStaleTestSockets(opts?)`
  with **no** top-level invocation. Seams injected via `opts` with real defaults:
  `dirs?` (candidate socket dirs), `isPidAlive?` (default `process.kill(pid, 0)` →
  `false` on `ESRCH`, `true` otherwise / on `EPERM`), `killServer?` (default
  `Bun.spawn(['tmux','-L',name,'kill-server'])`), `removeFile?` (default `rm`).
- `tests/setup/cleanup-stale-tmux.ts` — collapse to the import + `await
  reapStaleTestSockets()` shim; rewrite the header comment (no more "older than 5
  minutes"; document the prefix + liveness gate and the deliberate import-time side
  effect). Move `candidateSocketDirs` into the new module (or share it).
- `tests/setup/reap-test-sockets.test.ts` *(new, unit-level seam tests)* — see scenarios.
  *(End-to-end real-tmux behavior lives in U6.)*

**Approach:**
- Reap predicate per entry: `name.startsWith(RESERVED_TEST_PREFIX)` **and**
  `pidFromTestSocket(name)` is defined **and** `!isPidAlive(pid)`. Delete `STALE_AGE_MS`,
  `cutoff`, and every `stat`/`mtime` branch.
- `isPidAlive`: `process.kill(pid, 0)` throws `ESRCH` when dead (→ not alive) and `EPERM`
  when alive-but-not-ours (→ alive, err safe per KTD-4). Treat any non-`ESRCH` as alive.
- After a confirmed-dead match: `killServer(name)` then `removeFile` the socket path
  (preserve the existing "tmux died but left its socket" cleanup).
- Keep `candidateSocketDirs` (the `/tmp` vs `/private/tmp` vs `$TMUX_TMPDIR` fan-out) —
  it is correct and shared with `fixture.ts`.

**Patterns to follow:** current `cleanup-stale-tmux.ts` control flow (readdir → filter →
kill → rm); the DI-by-optional-params style used across the `*Service` constructors.

**Execution note:** characterization-first — the reaper currently has **zero** test
coverage. Land U5's seam tests (and U6's behavioral tests) against the extracted function
before/with the rewrite so the new predicate is pinned, not assumed.

**Test scenarios (seam-level, fake injected `isPidAlive`/`killServer`):**
- Reaps a dir entry `orch-test-<pid>-<nonce>` whose injected `isPidAlive(pid)` → `false`
  (asserts `killServer` called with that name + `removeFile` called).
- Skips `orch-test-<pid>-<nonce>` whose `isPidAlive(pid)` → `true` (parallel live run) —
  `killServer` **not** called.
- Skips `orch-r-2026-06-01-151213-4s` regardless of liveness — prefix gate (the incident
  socket; `killServer` never called).
- Skips a bare `orch-something` (non-`test` first segment).
- Skips an `orch-test-` entry with a non-numeric pid segment (`pidFromTestSocket` →
  `undefined`).
- `EPERM` from `process.kill` is treated as alive (errs safe) — entry skipped.
- A `killServer` that exits non-zero (server already gone) still triggers `removeFile`
  (idempotent reap of a stale socket file).
- No age input anywhere: an entry with `isPidAlive`→`false` is reaped even if it were
  "new"; an entry with `isPidAlive`→`true` is kept even if it were "old". (Encodes that
  the age window is gone.)
- Missing/unreadable dir is skipped without throwing (mirrors current `readdir` catch).

---

### U6. Behavioral cleanup tests with real tmux — the headline verification

**Goal:** Prove, against **real** tmux servers, that the sweep performs cleanup correctly
and exactly satisfies each success criterion. This is the unit the request foregrounds —
"high-level behavioral tests which make sure cleanup is performed correctly."

**Requirements:** every success criterion, end-to-end.

**Dependencies:** U1, U5 (and exercises U3/U4 socket shapes).

**Files:**
- `tests/integration/tests-setup/cleanup-reaper.real.integration.test.ts` *(new)* —
  Tier 1 style: `describe.skipIf(!canRunRealTmux())`, `REAL_TMUX_TEST_TIMEOUT_MS`
  per `it`, real `RealTmuxService` / `Bun.spawn` tmux boots, guaranteed teardown of every
  socket the test boots (in `afterEach`, independent of the assertion outcome).

**Approach — how to manufacture each pid state, behaviorally:**
- **Dead pid:** spawn a trivial process (`Bun.spawn(['true'])`), `await proc.exited`,
  capture `proc.pid`. That pid is now guaranteed dead. Boot a real tmux server on
  `orch-test-<deadpid>-<nonce>`, run `reapStaleTestSockets()`, assert the server is gone
  (`tmux -L <name> has-session` / `list-sessions` fails) **and** the socket file is
  removed.
- **Live pid:** use `process.pid` (the test runner — guaranteed alive). Boot
  `orch-test-<process.pid>-<nonce>`, run the reaper, assert the server **survives**.
- **Prod-shaped (incident repro):** boot `orch-r-<a-real-generateRunId>`; run the reaper;
  assert it **survives** (prefix gate). Mirrors the production `execute-plan` server the
  incident killed.
- **SIGKILL leak:** boot a fixture server, `process.kill(ownerPid, 'SIGKILL')`-style
  simulate by using a dead pid in the name (as above) — assert next reaper pass collects
  it.
- **Parallel-run safety:** boot two servers, one `orch-test-<deadpid>-…` and one
  `orch-test-<process.pid>-…`; a single reaper pass kills only the dead-pid one and
  leaves the live one running.
- **pid-reuse errs safe:** boot `orch-test-<process.pid>-<nonce>` (pid alive, unrelated
  to any "run") and assert the reaper leaves it — documents "missed cleanup, never
  wrongful kill."

**Patterns to follow:** the real-tmux Tier 1 tests under
`tests/integration/hosts/two-pane/tier-1/` (skip predicate, timeout constant, real
service composition, deterministic teardown). Reuse `allocateSocketName` /
`pidFromTestSocket` from U1 rather than re-literalizing names.

**Test scenarios (each a behavioral `it`, asserting the live server's actual presence/absence):**
- Covers success criterion: dead-pid `orch-test-…` server is reaped (server gone + file
  gone).
- Covers success criterion: live-pid `orch-test-…` server survives a reaper pass.
- Covers success criterion (incident repro): a live `orch-r-<runId>` server survives a
  reaper pass run while it is active — the exact scenario that killed production.
- Covers success criterion: a server whose owner pid is dead (SIGKILL stand-in) is reaped
  on the next pass.
- Covers success criterion: parallel safety — mixed dead/live sockets, only dead reaped.
- pid-reuse edge: alive-but-unrelated pid → skipped (errs safe).
- Age independence: no test in this file manipulates or relies on mtime; reap outcomes
  are determined solely by pid liveness.

**Verification:** `bun test tests/integration/tests-setup/cleanup-reaper.real.integration.test.ts`
passes locally with `tmux` on PATH; the file self-skips where `canRunRealTmux()` is false;
no orphan `orch-test-…` or `orch-r-…` servers remain after the run (`tmux ls` clean).

---

### U7. Assertion fixups, audit guard, and docs

**Goal:** Update remaining tests that assert the old socket shape, add a guard that
encodes the "no bare prod-shaped test socket" success criterion, and reconcile docs.

**Requirements:** the audit success criterion; suite stays green.

**Dependencies:** U1, U3, U4.

**Files:**
- Any test asserting `orch-${runId}` / `orch-t-` socket expectations — sweep with
  `grep -rn "orch-\\\${runId}\|orch-t-\|toMatch(/\^orch-" tests/` and update to the
  reserved shape (notably `tests/unit/.../socket-allocation.test.ts` from U1, and any
  snapshot/behavioral-dsl assertions surfaced by the grep).
- `tests/setup/reap-test-sockets.test.ts` *(or a small dedicated guard test)* — an audit
  test asserting `allocateSocketName()` and a representative mounted fixture never yield a
  name matching `/^orch-(r-|[^t])/` and never the bare `orch-` form.
- `tests/helpers/real-tmux/README.md` — already touched in U3; ensure the socket-naming
  section reflects the reserved namespace end-to-end.

**Approach:** mechanical. The grep is the worklist; each hit either moves to the reserved
shape or asserts the new `pidFromTestSocket` contract. No production docs under
`docs/public/` are affected (this is test infrastructure; the public API barrels are
unchanged — `createTmuxHost`'s new optional param is internal-only and not re-exported as
a documented surface).

**Test scenarios:**
- Audit guard: `allocateSocketName()` result fails `/^orch-r-/` and fails the bare-`orch-`
  shape, and passes `/^orch-test-/`.
- Updated assertions compile and pass under `bun run check`.
- `Test expectation: none — docs/README edits are non-behavioral.` (for the README hunk)

---

## Scope Boundaries

### In scope (corrects origin)
- Tier 1 in-process sockets **and** Tier 5 subprocess sockets both routed through
  `orch-test-…` (origin listed only Tier 1; the success criterion demands both).
- The single production-facing seam (`createTmuxHost` optional `socket`) plus its narrow
  env bridge for the subprocess case.

### Deferred for later (carried from origin Non-goals)
- **Hypothesis 2 — concurrent `orch resume`/teardown on a shared `orch-r-<runId>`
  server.** Shared-by-design socket; needs per-run ownership/locking, not a namespace
  change. Separate effort. *(see origin: Non-goals)*
- **cmux detection / defaulting to `plain` under cmux.** Tracked in the related issue's
  prevention ideas. *(see origin)*
- **tmux lifecycle telemetry** (pid/ppid/pgid/inode logging). Orthogonal. *(see origin)*

### Explicitly not done
- No tmux-server "is this socket actually live" probe (KTD-4 — the pid-reuse edge already
  errs safe).
- No age fallback knob (KTD-4 — pure pid-liveness).

---

## Risks & Mitigations

- **Tier 5 owner-pid semantics.** The embedded pid is the *launcher's* pid, not the
  spawned `orch` child's. Mitigation: that is the correct owner — it's the process the
  test controls and whose death should make the leak reapable; U4's integration scenario
  asserts the real launched run lands on an `orch-test-…` socket and is reaped on
  teardown.
- **A missed internal socket derivation in `tmux-host.ts`.** If any code path other than
  line 419 reconstructs `orch-${runId}`, the override leaks. Mitigation: U2's explicit
  audit + the `pane-died` edge test; the grep already shows line 419 is the only
  derivation (791 is an unrelated log filename).
- **Import-time side effect of the preload.** Extracting the function (KTD-5) confines
  the deliberate no-import-side-effects exception to the 3-line shim, so importing the
  reaper for tests is safe; U6/U5 import the function module, never the shim.
- **Env bridge widening production surface.** Mitigated by reading `ORCH_TMUX_SOCKET` in
  exactly one place, validating through `socketName`, and defaulting to byte-for-byte
  unchanged prod behavior when unset (U4 regression scenario).

---

## Verification

- `bun run check` green (lint + typecheck + unit + mocked-integration).
- The new behavioral suite (U6) passes locally with `tmux` present and self-skips
  without it.
- Manual incident repro (optional, documents the fix): boot a real two-pane workflow
  (`orch-r-…`), run `bun test` in the repo, confirm the workflow server survives.
- Audit grep: no test path produces a bare `orch-` / `orch-r-` socket (U7 guard).
