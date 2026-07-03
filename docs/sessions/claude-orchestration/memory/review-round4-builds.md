# review-round4: builds 008 and 024

Read-only review of the two build commits that landed after the last review pass:
`f9eeebe` (plan 008 — status surfaces failure) and `22c32fe` (plan 024 — init
scaffolds a typed handoff). No source/tests/plans touched; only this diary written.

## TL;DR verdict

| Commit | Plan | Verdict | Notes |
|--------|------|---------|-------|
| `f9eeebe` | 008 — status shows failed step + reason | **OK** | All acceptance criteria met. |
| `22c32fe` | 024 — init scaffolds typed two-step handoff | **OK** | All acceptance criteria met. |

No NEEDS-FIX items. Both are clean.

## What I verified (commands run, all this branch)

- `bun test tests/integration/cli/commands/status.test.ts` → **9 pass / 0 fail** (6 pre-existing + 3 new).
- `bun test tests/unit/cli/commands/init-templates.test.ts tests/integration/cli/commands/init.test.ts` → **27 pass / 0 fail**.
- `bun run typecheck` → **exit 0** (`tsc --noEmit`).
- Did NOT run bare `bun test`, `bun run check`, or any mutating git command (per constraints).

## Plan 008 (`f9eeebe`) — judged against acceptance notes

- **Failure section naming step + best-effort reason from lifecycle.ndjson**: yes.
  `printFailureSection` reads `<runDir>/logs/lifecycle.ndjson`, finds the LAST
  `step:failed` record, prints `Failed step:` / `Reason:` / `Details:` (`status.ts`
  ~85-110). Confirmed the failing step is not in `state.json` — read only from the
  lifecycle log, correct.
- **Zero-step failed/crashed runs handled**: yes. The old `stepEntries.length === 0`
  early `return EXIT.OK` was restructured to `if/else`, so failed/crashed runs always
  reach the failure section. The existing "crashed run with zero steps" test now also
  emits `Failed step: (unknown — see logs)` (visible in the test output) and still
  passes on exit code.
- **Robust reason extraction (string / message-object / fallback)**: yes.
  `extractReason` returns a non-empty string verbatim, else an object's string
  `message`, else `(see transcript)`. NDJSON parse is per-line try/catch, skips
  blank/truncated lines, never throws — matches the plan's "tolerate killed mid-write"
  reviewer note.
- **File footprint**: only `src/cli/commands/status.ts` + its integration test (plus
  the build diary). `workflow.ts` and `state-store.ts` untouched — plan 008's forbidden
  files respected.
- **Nice-to-have honored**: `// TODO: prefer persisted errorClass once plan 010 lands`
  left at the reason assignment, as the plan's maintenance note asked.
- Minor, not a defect: plan step 3.4 said point at the `logs/` directory for the
  unknown case; the code prints the exact `.../logs/lifecycle.ndjson` file path
  instead — strictly more useful.

## Plan 024 (`22c32fe`) — judged against acceptance notes

- **Typed two-step handoff**: yes. `STEPS_TEMPLATE` defines `SUMMARIZE`
  (`returns: z.object({ topic: z.string(), factCount: z.number().int() })`, bare
  plan-023 form, no `schema(...)` wrapper) and `WRITE_SUMMARY`. `HELLO_WORKFLOW_TEMPLATE`
  does `const summary = await run(SUMMARIZE)` then
  `run(WRITE_SUMMARY, { extraPrompt: ...summary.topic...summary.factCount... })` — the
  typed result visibly flows into step 2.
- **Imports `{ claude, step, z }`**: yes (no `schema` import, correct for the bare form).
- **`permissions: 'bypass'` (plan-021 form)**: yes, on both steps.
- **Generated code typechecks standalone**: judged OK. I could not render scratch files
  (read-only task), so I confirmed the underlying API instead:
  - `z` is re-exported from the barrel (`src/index.ts:11`).
  - `AutonomousStepInput.returns` accepts a bare `ZodType` (`src/core/step.ts:212`), so
    `returns: z.object(...)` types the result.
  - `extraPrompt` is a real `run()` override for agent steps (`src/core/workflow.ts:142,531`).
  The builder additionally reports rendering both templates to a scratch project and
  running `bun run typecheck` → exit 0, then removing it. Consistent with the above.
- **File footprint**: `src/cli/commands/init-templates.ts` + its two test files (plus
  diary). `newWorkflowTemplate` change is comment-only (allowed); `CONFIG_TEMPLATE`
  untouched.

## Deferred / gotchas noted (not my task to fix)

- Both build diaries flag that `docs/public/guide/4-writing-a-workflow.md` and
  `docs/public/guides/typed-returns.md` still show the OLD `returns: schema(...)` wrapper
  form, while the 024 scaffold now uses the bare `z.object(...)` form. A later docs task
  should migrate the guides to the bare form to keep the scaffold in lockstep (build-023
  already flagged the same migration).
- `plans/README.md` rows 008/024 are intentionally not updated by these workers (the
  workflow owns commits); status-row reconciliation is out of scope here.
