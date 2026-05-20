---
date: 2026-05-20
campaign: tier-5 lifecycle first batch
plan: docs/plans/2026-05-20-001-feat-two-pane-behavioral-test-dsl-plan.md
---

# Tier 5 lifecycle campaign — first-batch findings (2026-05-20)

## Executive summary

The first batch of human-authored Tier 5 cells (U7 + U8 smoke + U9 §2.1 acceptance + U10 signal/Ctrl-C/stdin) is in. **All 11 cells run green** under `bun test tests/integration/lifecycle/`. Across them:

- **Origin §1 bug-class hypothesis is partially confirmed.** The "pressing `q` during a running step does not tear orch down" pathology (§2.1) reproduces deterministically with `ScriptedFakeRunner` — both silent-hold and visibly-emitting variants — and the captured contract-violation snapshot is committed under `__snapshots__/pane-q-during-run.last.json` as the durable bug ticket.
- **The Ctrl-C-in-attached-TTY pathology (origin §2 S4) reproduces, regardless of repetition count** (1 / 2 / 3 keystrokes). The snapshot is `__snapshots__/attach-tty-ctrl-c.last.json`. This is a distinct symptom from §2.1 — the gesture is `\x03` to orch's stdin, not `q` in the pane.
- **SIGINT / SIGTERM / SIGHUP / double-SIGINT all tear orch down cleanly.** The §6.5 contract is satisfied; these are confirmed-OK behaviors that should NOT regress.
- **stdin-EOF preserves the weak `close-stdin` contract** (escapes balanced). Orch v1 has no handler for stdin-EOF on a piped child; the contract documents observed behavior rather than asserting full teardown.
- **The §6.5 contract is internally consistent.** Every signal-path scenario shares the same matcher set (`cleanly()` + `doesNotExist()` + `balancedEscapes()` + `noOrphanChildren()`); the only weaker row is `close-stdin`, which is intentional.

The §2.1 reproduction snapshot is the explicit handoff to the next planning round.

## Cell roster

The cells in this campaign and their outcomes:

| File | Scenario | Predicted | Outcome | Notes |
|---|---|---|---|---|
| `click-to-focus-across-divider-smoke.real.test.ts` | n/a (smoke) | PASS | **PASS** | U8 smoke — `clickOnPane` works on `--no-attach` sessions via `select-pane` fallback |
| `sigint-to-orch-during-mid-step.real.test.ts` | `signal-sigint` | PASS | **PASS** | Single SIGINT — handler at `execute-with-attach.ts:64-78` works |
| `q-during-fake-mid-step.real.test.ts` | `pane-q-during-run` | FAIL-BUG | **PASS via `expectInvariantViolation`** | §2.1 silent-hold — bug confirmed |
| `q-during-emitting-fake-mid-step.real.test.ts` | `pane-q-during-run` | FAIL-BUG | **PASS via `expectInvariantViolation`** | §2.1 emitting — bug confirmed with visible right-pane output |
| `ctrl-c-once-in-attached-during-mid-step.real.test.ts` | `attach-tty-ctrl-c` | FAIL-BUG | **PASS via `expectInvariantViolation`** | `\x03` to orch's stdin — bug confirmed |
| `ctrl-c-twice-in-attached-during-mid-step.real.test.ts` | `attach-tty-ctrl-c` | FAIL-BUG | **PASS via `expectInvariantViolation`** | User-reported reproduction — bug confirmed |
| `ctrl-c-thrice-in-attached-during-mid-step.real.test.ts` | `attach-tty-ctrl-c` | FAIL-BUG | **PASS via `expectInvariantViolation`** | "No matter how many" defensive anchor — bug confirmed |
| `sigterm-to-orch-during-mid-step.real.test.ts` | `signal-sigterm` | PASS | **PASS** | Confirmed-OK contract row |
| `sighup-to-orch-during-mid-step.real.test.ts` | `signal-sighup` | PASS | **PASS** | Confirmed-OK — covers "I closed my terminal" recovery path |
| `close-stdin-during-mid-step.real.test.ts` | `close-stdin` | unknown | **PASS** | Weak contract holds — orch keeps running but escapes stay balanced |
| `double-sigint-to-orch-during-mid-step.real.test.ts` | `signal-sigint` | FAIL-BUG | **PASS (prediction wrong)** | Empirical: redundant SIGINT is a harmless no-op; cell flipped from `expectInvariantViolation` to direct contract assertion mid-campaign |

11 cells total, 11 green. No flakes, no FAIL-HARNESS, no FAIL-DSL.

## PASS

Confirmed-OK contract rows — these are the behaviors that must NOT regress.

- **`signal-sigint`** — `sigint-to-orch-during-mid-step.real.test.ts`. Orch exits with code 130 / signal=SIGINT, tmux session is torn down, escapes balanced, no orphan children. See also U7's docblock for the known finding that the SIGINT handler does NOT flush `state.json` status='cancelled' (the contract intentionally does not assert on `hasStatus`).
- **`signal-sigterm`** — `sigterm-to-orch-during-mid-step.real.test.ts`. Same shape as SIGINT, exit code 143.
- **`signal-sighup`** — `sighup-to-orch-during-mid-step.real.test.ts`. Same shape. Exercises the "user closed the terminal window" recovery path.
- **`signal-sigint` (double-fire)** — `double-sigint-to-orch-during-mid-step.real.test.ts`. A second SIGINT during teardown is a no-op; the first one's handler completes the clean exit.
- **click-to-focus smoke** — `click-to-focus-across-divider-smoke.real.test.ts`. The harness's `clickOnPane` action moves focus across the divider in `--no-attach` sessions via the `select-pane` fallback.

## FAIL-BUG

Cells that confirm an orch-side bug. Each PASSES via `expectInvariantViolation` — the captured snapshot is the bug evidence. **Fixing the bug forces deletion of these cells**, not assertion inversion.

### §2.1 — `q` during a running step does not tear orch down

- `q-during-fake-mid-step.real.test.ts` (silent-hold variant)
- `q-during-emitting-fake-mid-step.real.test.ts` (visibly-active step variant)
- Snapshot: [`__snapshots__/pane-q-during-run.last.json`](../../tests/integration/lifecycle/__snapshots__/pane-q-during-run.last.json)
- Contract row violated: `pane-q-during-run` (`cleanly()` + `doesNotExist()` + `hasStatus("cancelled")`)
- Reproducible signature from the snapshot:
  - `orchAlive: true, orchExit: null` (orch never exited)
  - `tmuxSessionExists: true, tmuxServerExists: true` (session still up)
  - `stateStatus: "running"` (not cancelled)
  - The `q` keystroke is visible as a literal `q` character at the start of `leftPaneText` — Ink's input layer received the byte but the steps view did not act on it. **This is the smoking gun** — `src/hosts/two-pane/.../steps-view.tsx` likely has no `q → exit` handler wired.

### S4 — Ctrl-C in attached TTY does not tear orch down

- `ctrl-c-once-in-attached-during-mid-step.real.test.ts`
- `ctrl-c-twice-in-attached-during-mid-step.real.test.ts` (the user's reported reproduction)
- `ctrl-c-thrice-in-attached-during-mid-step.real.test.ts` (defensive anchor)
- Snapshot: [`__snapshots__/attach-tty-ctrl-c.last.json`](../../tests/integration/lifecycle/__snapshots__/attach-tty-ctrl-c.last.json)
- Contract row violated: `attach-tty-ctrl-c` (`cleanly()` + `doesNotExist()` + `balancedEscapes()` + `noOrphanChildren()`)
- Reproducible signature:
  - `\x03` bytes written to orch's piped stdin do not propagate as SIGINT (the controlling-TTY kernel translation only happens for a real TTY). The Ink layer reads them as raw bytes.
  - Orch keeps running mid-step regardless of repetition count.
  - **Distinct from §2.1** — the §2.1 cell exercises a `q` keystroke server-side via `tmux send-keys -t <pane> -l q`; this cell exercises a `\x03` byte over the orch subprocess's stdin pipe. Two different input vectors; same underlying behavior gap (no input handler routes them to teardown).

## FAIL-EXPECTATION

None. The §6.5 contract holds for every PASS cell. No row needs editing based on first-batch evidence.

## FAIL-HARNESS

None. Notable harness fixes landed during the campaign — they are recorded here so future runs can avoid the same traps:

- **External tmux probe pane cache was stale across `swap-pane`.** The probe's `resolvePanes` memoized the visible pane ids at first lookup; once the two-pane host swapped a hidden file-tail pane into the visible right slot (`live:<step>` source registration), the cache pointed at a no-longer-visible pane id and every subsequent right-pane assertion captured against an empty hidden pane. Fixed by dropping the cache and resolving fresh per call. See `tests/helpers/behavioral-dsl/internal/external-tmux-probe.ts:107`. Without this fix, the `q-during-emitting-fake-mid-step` cell could never see the runner's emitted text in the right pane.
- **`expectInvariantViolation` had inverted polling semantics.** The initial implementation returned success on the first snapshot with a non-empty violation list and only threw if the budget elapsed with all-empty lists. That defeats the deletion-gate semantics (Risk R-D) — a fixed orch mid-teardown would briefly show violations and the cell would still pass. Corrected to: throw immediately on any empty-violations snapshot during the budget, return success only if violations persist for the full budget. See `tests/helpers/behavioral-dsl/assertions.ts:167`.

## FAIL-DSL

None. Every gesture and matcher needed by the first-batch cells is in the v1 DSL barrel.

## Contract revisions

None proposed. The §6.5 contract was internally consistent across this first batch — no PASS cells violated their row and no FAIL-BUG row required loosening to match observed behavior. The only weak row (`close-stdin`) was already documented as intentionally weak.

## DSL gaps

None surfaced in this batch. Future campaign sweeps may find gaps — file them here when they appear.

## Next planning round inputs

The next planning round (bug-fix planning) should consume:

1. **`__snapshots__/pane-q-during-run.last.json`** — the §2.1 contract-violation evidence. The fix needs to make `q` (and likely `Ctrl-C` in the same handler — see below) tear orch down cleanly. The fix is almost certainly in the Ink steps-view input handler (`src/hosts/two-pane/.../steps-view.tsx`) — the visible "▶ live · ⏎ view step · q quit · ? help" footer string suggests intent to support `q`, but the handler is missing or non-functional.

2. **`__snapshots__/attach-tty-ctrl-c.last.json`** — the Ctrl-C-in-attached-TTY evidence. The fix likely involves routing the stdin `\x03` byte through the same exit path as the future `q` handler.

3. **The two bugs may share a fix.** Both gestures should converge on `host.teardown() → process.exit(EXIT.SIGINT)`. The §6.5 contract rows for `pane-q-during-run` and `attach-tty-ctrl-c` are nearly identical (the former also asserts `hasStatus("cancelled")`, which the current SIGINT handler doesn't satisfy — see U7 docblock).

4. **The U7 docblock finding** (SIGINT handler does NOT persist `state.json` status='cancelled') is its own follow-up. The contract intentionally does not assert on this today; if the next bug-fix round wants to lift `pane-q-during-run` to require `hasStatus("cancelled")`, the SIGINT handler must also be fixed in tandem.

## Campaign-sweep follow-up

Per plan §U11, the **sub-agent orchestrated campaign sweep** (origin §11 step 9 — orchestrator + parallel sub-agents producing additional cells across the full §7 matrix) is a follow-up activity using the tooling delivered in this plan. It is intentionally NOT executed here. The first-batch cells in this doc are the human-authored evidence; the sweep is the next layer.

## How to refresh the snapshots

```sh
LIFECYCLE_SNAPSHOT_DIR=tests/integration/lifecycle/__snapshots__ \
  bun test tests/integration/lifecycle/
```

The env var is the explicit refresh switch — default invocations are pure (no on-disk side effects). Refreshed snapshots replace the existing files in place; commit the diff to update the bug-evidence ticket.
