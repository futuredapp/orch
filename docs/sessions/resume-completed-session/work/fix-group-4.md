# Fix Group 4 — Barrel-rule violation, missing public type, misleading/misplaced comments

**Status:** done · all five sub-items landed · `bun run check` green.

Group 4 is pure hygiene (no behavior change except L4, which is copy-only). Each item below was
re-verified against the current working tree before editing — the plan was written against an older
shape of `open-finished.ts` (then ~440 lines, now 95), but every finding still applied.

## What I changed

- **M1 — barrel-rule violation (CLAUDE.md rule 7).** `WorkflowDeps` is exported from
  `src/core/index.ts`, but two CLI commands imported it from the internal file. Moved it into the
  existing `../../core/index.ts` import in both `src/cli/commands/open-failed.ts` and
  `src/cli/commands/resume-execution.ts`, deleting the `import type { WorkflowDeps } from
  '../../core/workflow.ts'` line in each.
- **L1 — public return type missing from the barrel.** `retryStep` is on the barrel-exported
  `WorkflowExecutor` interface, but its result type `RetryStepResult` was not re-exported. Added it
  to the `export type { … } from './workflow.ts'` block in `src/core/index.ts`.
- **M2 — wrong file in a doc-comment.** `src/hosts/host-registry.ts` said `enableFailureActions` is
  "Set only by the CLI re-entry `failed` open (`open-finished`)". It is set at
  `src/cli/commands/open-failed.ts:170`, never in `open-finished.ts`. Changed `(open-finished)` →
  `(open-failed)`.
- **L6 — dangling comment in `open-finished.ts`.** The "raw (un-instrumented) process service…"
  comment sat above `const resumeRegistry = …`, ~13 lines from the `processService:
  deps.processService` line it explains. Moved it directly onto that line inside the
  `hostFactory({…})` call.
- **L4 — misleading no-TTY refusal copy.** `src/cli/commands/resume.ts` refused with "requires a
  two-pane terminal (no TTY / tmux unavailable)" even when a real TTY exists but `--mode=plain` was
  passed. Reworded to surface the actual resolved mode and that plain mode is a trigger:
  `requires two-pane mode (got mode=${opts.mode}; e.g. --mode=plain / no TTY / tmux unavailable)`.
  Exit code is unchanged (`CONFIG_ERROR`), so AT-6/AT-20 still hold.

## Tests

Per the plan, M1/L1/M2/L6 are caught by `bun run check` (typecheck + lint) — no new test. For L4 I
grepped `tests/` for the refusal substring and found **no** test asserting the old copy, so no
assertion needed updating; the integration suites that exercise the no-TTY path
(`resume-finished.test.ts`, `open-failed.test.ts`) assert on `EXIT.CONFIG_ERROR`, not the message
string, and still pass with the new copy.

## Verification

- `bun run typecheck` — clean (proves M1/L1 barrel moves resolve).
- `bun run lint` — clean (697 files).
- Targeted: `resume-finished.test.ts`, `open-failed.test.ts`, `open-finished.test.ts` — 19 pass.
- Full gate: `bun run check` — green (unit + two-pane fast + screen + full-host fake + lifecycle +
  migration/overlap/import-parity all pass).

## Issues hit

None blocking. The only wrinkle was that the plan's line references for `open-finished.ts` (L6 at
~441) were stale after an intervening refactor shrank the file; I located the comment by content
rather than line number and the fix was unchanged in substance.

## Remaining groups

Groups 5 (reliability edge cases — L2/L3) and 6 (test rigor — H1/H2) are still `not-started`.
