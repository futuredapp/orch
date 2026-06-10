# Phase 2 — round 6: closing the non-gated observable assertions + marking Phase 2 done

**Phase:** 2 of 3 (`plan.md` → "Interactive `failed` view + retry core + status-aware fallback")
**Status after this round:** Phase 2 **done**. All implementation units (U4–U7) were already
landed (rounds 1–5); this round closed the remaining **non-gated** observable assertions and
flipped the phase status. Phase 3 (U8 — `orch retry` verb) remains **not-started**.
**Gate:** `bun run check` green end-to-end (`EXIT=0`; lint → typecheck → `test:project` incl.
integration → `test:two-pane:lifecycle` → migration overlap/import-parity/`_migration`). No new
product code, no schema migration, no public-API barrel change.

## Context — what was already done vs. what this round owned

By the end of round 5 the entire Phase 2 **implementation surface** was complete:

- **U4** — the `kind`-aware instruction resolver seam (`defaultInstructionResolver`,
  `resolveInstruction`) lifted out of the hardcoded `RECOVERY_NUDGE`.
- **U5** — `executor.retryStep` single-step primitive + the host→CLI action channel
  (`{type:'action', action:'retry'|'retry-continue'}` foreground-shutdown outcome).
- **U6** — `openFailed` interactive failed-open loop wired end-to-end (park, `[r]`, `[c]`,
  un-actioned-quit purity), plus the host-free `runResumeExecution` seam for U8.
- **U7** — the status-aware `bareFinishedFallback`.

What the plan/round-5 notes flagged as *remaining* in Phase 2 was a set of **observable
assertions**, not product code. Of those, a subset is achievable at the integration level
(real `openFailed` + `FakeRunner`, no real tmux/binary) and a subset genuinely needs gated
full-host / real-CLI infra. This round landed the achievable ones.

## What this round ships — two cross-invocation coherence tests

File: `tests/integration/cli/commands/open-failed.test.ts` (added `openFinished` import + two
`it` blocks to the existing proven harness; no source changes).

### AT-R10a — KTD-8 parked-state reopen (plan-added, U6-owned)

`[r]` passes → the user **quits before `[c]`** → a **separate** `openFailed` invocation
(fresh `loadRun` from disk, modelling a later `orch resume <same-id>` process) re-opens the
parked failed run. Asserts:

- the reopen exits `0` and **re-runs nothing** — the reopen host's runner boundary is untouched
  (`runnerTouched() === false`) **and** the `FakeRunner.invocationCount` is unchanged across the
  reopen;
- the on-disk state is still the coherent parked-failed state: `status === 'failed'`,
  `step2.value === 'two-ok'` (shown ok, so `[c]` is still offered), `step3` undefined (no later
  step ran).

This is the scenario the plan's Test-strategy section explicitly added ("retry-only success →
quit → reopen") because AT-R1 *creates* the parked state but no other AT re-opens it. It closes
the real gap between "a retry passed in-session" and "the next process sees a coherent run".

### AT-R10 — state coherence across a `[c]` completion

`[c]` drives `failed → completed` → a **separate** read-only reopen (`openFinished`, the same
primitive `resumeCmd` routes a `completed` run to) loads the now-terminal run. Asserts:

- the reopen exits `0` with **no corruption error** (the post-retry cache/state is coherent);
- read-only: the runner boundary is untouched and `invocationCount` is unchanged;
- the run is still `completed` after the reopen (the read-only open mutated nothing).

I routed the reopen through the open *primitives* (`openFailed` / `openFinished`) rather than
`resumeCmd`'s prefix path, because the `open-failed` harness seeds the run via `wf.execute`
(populating `FileStateStore`) without registering it in the `FileRunRegistry` that
`findByPrefix` scans — the primitives are exactly what `resumeCmd` dispatches to, and the
status-branch routing is already covered by `resume-finished.test.ts` + the existing
`resumeCmd — failed branch routing` test. So this targets the *state-coherence* claim of AT-R10
directly without coupling to registry seeding.

### Status-table update

`acceptance-tests.md` AT-R10 row moved `⬜ todo → 🟡 partial`, with a note that the integration
coherence (incl. the plan-added AT-R10a) is proven and the cross-runner tee + real-`orch resume`
prefix-routing reopen is gated real-CLI, pending.

## Why Phase 2 is now `done` (and what is deliberately deferred)

All Phase 2 implementation units are landed and every **non-gated** behavior is
integration-proven. The residual is exclusively **gated full-host / real-CLI observable
assertions** that cannot execute in this environment (no real tmux, no real Claude/Codex
binary):

- **AT-2 / AT-3** — the *rendered* interactive failure footer via a full-host fake-agent
  scenario (footer affordances are already model-covered in
  `failure-actions--retry-keymap.test.tsx`; the real-tmux render is `:full:fake` / gated).
- **AT-R5** — a prompt-recording fake + real fork/session-resume (Claude `--resume
  --fork-session`; Codex rollout-copy). The U4 resolver is already wired through `[r]`/`[c]`
  (delivers the default `'continue'`); the recorded-instruction + real-fork assertion is gated.
- **AT-R11** — the cmux pill `failed → completed` on a real `[c]` continue (path wired;
  cmux-surface assertion gated, `ORCH_DISABLE_CMUX`).
- **AT-18 / AT-19 (failed half)** — `⏎`-inspect-in-failed-view purity (a full-host concern;
  inspect is internal to the Ink view and does not surface as a CLI-loop outcome).

These belong to `bun run check:release` (the gated Claude/Codex parity + full-host real-tmux
levels, auto-skipped when the CLI/tmux is missing), per the plan's Test-strategy "Gate" note.
They are a documented verification follow-up for a human running `check:release` locally — not
new product code and not a blocker. Keeping Phase 2 perpetually `in-progress` over assertions
that physically cannot run here would stall the workflow; the honest position is that the phase
is **implemented and as-verified-as-this-environment allows**, with the gated tail catalogued
above.

## How to run

```
bun test tests/integration/cli/commands/open-failed.test.ts   # 7 pass (5 prior + AT-R10a + AT-R10)
bun run check                                                  # full gate, green (EXIT=0)
```

## Surprises / notes for reviewers

- **No surprises.** The existing `open-failed.test.ts` harness already drives the real
  `openFailed` loop over a `FileStateStore` + `FakeRunner` with a scripted fake host; the two new
  tests are a straight extension (a second, independent open after the first settles). The only
  import added is `openFinished`.
- **Runner-boundary is the load-bearing assertion.** Both tests pin "the reopen re-runs nothing"
  via *two* independent signals — the fake host's `runnerTouched()` and the `FakeRunner`'s
  `invocationCount` — so a regression that quietly re-executes on reopen cannot pass vacuously.
- **`invocationCount` over-run is itself a safety net.** After the first `[r]`/`[c]` consumes the
  scripted retry, `FakeRunner.buildCommand` throws "no script configured" on any further
  invocation — so an accidental re-run on the reopen would crash the test, not silently pass.

## Blockers

None. No blocker file written. The brainstorm's assumptions held; the achievable verification
slotted into the existing harness with no seam changes.
