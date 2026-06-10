# Observation-guarantee tests assert structural absence, not behavior

**Source:** CE M4 (MEDIUM) and CE M7 (MEDIUM). Verified against the code.
**Status:** Not a fix in this pass — needs a reword-vs-gate decision about what the guarantee actually is.

## What the issue is

The "pure open" guarantees (AT-15/16/17) are verified against null/spy edges in a way that proves the
*implementation shape* rather than the *behavior*, and AT-17 in particular overstates what holds in
production.

## Where it is

- **AT-17 (no new run logs).** `tests/integration/cli/commands/open-finished.test.ts` injects a null/spy
  logger and asserts `appends === [] && writes === []`. Because the logger is null, nothing reaches disk
  regardless of intent, and `logs/` is never compared before/after. In production the host factory wires a
  real `FileSessionLogger`, and `src/hosts/two-pane/tmux-host.ts` appends host-lifecycle entries
  (`host-created`/`tmux-session-created`/`pane-created` and teardown counterparts) to `logs/lifecycle.ndjson`
  + `logs/timeline.ndjson`. So a real `openFinished` pure open is **not** byte-for-byte log-silent — host
  bookkeeping still writes. The defensible guarantee is the narrower "the *orchestration layer* writes no
  `run:resumed`/`run.meta.json`/execution logs," not "no logs at all." (AT-14's `state.json` check **is**
  asserted byte-for-byte against the real file — only the `logs/` half is weak.)
- **AT-15/16 (no lifecycle events / no cmux side effects).** The tests assert `logger.appends === []` and
  `fps.cmuxCalls() === []`. Because `openFinished` structurally installs **no** cmux host, an empty
  `cmuxCalls()` is near-tautological — it asserts "no cmux subprocess was spawned," not "no pill was
  cleared/changed / no notification fired." Correct for today's design, but brittle to the `argv[0] === 'cmux'`
  convention and it wouldn't catch a regression that cleared the pill without spawning `cmux`.

## Why it matters

The status table marks these `✅` against assertions that would survive real regressions: a real
`FileSessionLogger` that touched `logs/` during a pure open, or a pill cleared by a non-subprocess path,
would both still pass. The guarantee that actually holds is narrower than the table implies.

## Why it is recorded here, not fixed

Resolving it requires a decision the contract owner should make, not a mechanical patch:
- **(a)** Reword AT-17's claim to "no execution/resume logs" and document that host-lifecycle bookkeeping
  still appends; or
- **(b)** If true byte-for-byte log-silence is the intended contract, gate the host construction/teardown
  lifecycle appends behind a `readOnly`/`pureOpen` flag.

Either way, at minimum add one assertion using a real `FileSessionLogger` + `readdir(logs/)` and a
before/after byte comparison that distinguishes "no execution logs" from "no logs at all." For AT-15/16,
strengthen the comments to state *why* the structural absence suffices (no cmux host is constructed), and if
a fake cmux surface that records pill transitions exists, prefer asserting zero pill transitions over zero
subprocesses.

## Suggested next step

Pick (a) or (b) with the feature owner, then update `open-finished.test.ts` and the AT-17 status row
accordingly, and add the `logs/`-diff assertion that makes the real guarantee observable.
