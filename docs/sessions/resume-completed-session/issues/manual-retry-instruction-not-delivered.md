# Manual retry/continue does not deliver the retry instruction on the first re-run

**Source:** Codex Finding 1 (HIGH) and CE M6 (independently). Verified against the code.
**Status:** Not a fix in this pass — scope. Matches the documented 🟡-partial AT-R5 status.

## What the issue is

The acceptance contract (brainstorm **D7**, **AT-R5**) requires that when the user triggers `[r]`, `[c]`,
or `orch retry`, the retried agent is **told it is retrying/continuing** using the configured/default
instruction source, and — where the runner supports it — the **prior failed session is resumed/forked** so
the agent knows a previous attempt failed.

As built, the first manual re-run of the failed step uses the **original step prompt** and a **fresh
session**. The instruction is only ever applied if that first re-attempt *itself* fails and the autonomous
recovery loop engages.

## Where it is

- `deps.instructionResolver` is read at exactly one site in `src/`:
  `src/core/workflow.ts:1518` (inside `buildRecoveryCommand`), reachable only from the autonomous recovery
  loop (`runForkAttempt` → `runRecoveryLoop`), which runs only after a terminal first-attempt failure.
- The first re-run builds its prompt from the original config, with no resolver:
  - `src/core/workflow.ts:1206` (`produceAgentStep` — `assemblePrompt(config.prompt, …)`, into
    `runnerCtx.prompt`)
  - `src/core/workflow.ts:784` (`produceInteractiveStep` — same)
- The first re-attempt mints a fresh session id rather than forking the failed one:
  `src/core/workflow.ts:1233` / `:783`. Fork/resume (`forkResumeCommand` + `checkpointSessionId`) lives only
  in `buildRecoveryCommand` (`:1519-1537`).
- Both instruction kinds currently resolve to the same string: `src/core/recovery/instructions.ts:22,37,49`
  (`DEFAULT_RECOVERY_INSTRUCTION = 'continue'`; `defaultInstructionResolver` passes no `configured`).
- Every CLI caller wires only the default resolver: `src/cli/commands/open-failed.ts:87`,
  `src/cli/commands/retry.ts:99`.

## Why it matters

This is the central behavioral promise of the failed-retry feature (D7) and the explicit subject of AT-R5.
Today the resolver is threaded through `WorkflowDeps` but is **inert on the first manual re-attempt** — so a
reviewer reading "the resolver is wired through `[r]`/`[c]`" could mistake it for "delivered to the agent,"
when in the common (first-attempt-succeeds) case the agent receives no retry nudge and no session fork.

## Why it is recorded here, not fixed

`acceptance-tests.md` already marks **AT-R5 🟡 partial** ("the U4 `instructionResolver` is wired … (default
delivers `'continue'`); a prompt-recording assertion + real-runner fork/session-resume is gated real-CLI,
pending"), and `plan.md` (KTD-4, U4/U6, the "Scope note on the typed-override") frames instruction *delivery*
as in-scope while deferring the config/override schema to the sibling feature. Fixing this properly is
net-new executor work (thread explicit manual-retry context — `kind: 'retry' | 'continue'` + prior
step/session metadata — into the first re-run, prefer `forkResumeCommand`/`resumeCommand`, define a
prompt-composition fallback for runners without resume support). That is a scope-sized change, not a
correctness patch, so it stays out of the fix-plan to avoid silently expanding the agreed contract.

## Suggested next step

Treat this as the headline follow-up for the failed-retry feature. When picked up:
1. Thread `kind` + prior-failed-step/session metadata into the executor so the **first** re-driven failed
   step builds its command from the configured instruction (not the original prompt).
2. Prefer the runner fork/resume primitive (`forkResumeCommand` / `resumeCommand` + the prior session id);
   define a prompt-append fallback for runners without resume support so AT-R5 is testable everywhere.
3. Use `kind: 'retry'` for `[r]` and `kind: 'continue'` for `[c]` / `orch retry`; do **not** route both
   through the autonomous recovery-only `buildRecoveryCommand`.
4. Add prompt/command-recording tests for `[r]`, `[c]`, and `orch retry` that fail if the retried runner
   sees only the original step prompt — then flip AT-R5 from 🟡 to ✅.
