# build-008: `orch status` surfaces the failed step and reason

## What I did

Implemented plan 008. `orch status <failed-id>` now prints a Failure section for
`failed`/`crashed` runs that names the failing step and its best-effort reason,
read from `<runDir>/logs/lifecycle.ndjson` (the failing step is NOT in
`state.json` — only succeeded steps are persisted).

Touched only the two in-scope files:
- `src/cli/commands/status.ts` — added `printFailureSection` + a
  `readLastStepFailure` NDJSON reader, `isRecord`/`isStepFailedRecord` guards, and
  `extractReason` (all kept inside status.ts — no existing helper in
  `src/cli/commands/` reads lifecycle.ndjson).
- `tests/integration/cli/commands/status.test.ts` — added a `captureStdout`
  helper and the 3 new cases.

## Drift check

`git diff --stat 0265592..HEAD` showed `src/core/workflow.ts` and
`src/state/state-store.ts` changed (status.ts did NOT). I compared the plan's
"Current state" excerpts against live code:
- `step:failed` type in workflow.ts still has `stepName: StepName` + `error: unknown`
  (workflow.ts:219-225) — matches the excerpt exactly.
- `StepEntry` in state-store.ts still has NO `status`/`error` field (the drift only
  added session-capture fields like `sessionId`, `runnerName`, `sessionIdCaptureError`).
The plan's core premise (reason lives only in lifecycle.ndjson) holds → no real
mismatch, proceeded. No STOP conditions hit.

## Key decisions

- **Run-dir derivation**: used `deps.stateStore.runDir(rid)` (public accessor,
  `<basePath>/<runId>`) rather than reconstructing `${deps.statePath}/${rid}` as
  logs.ts does. Same result, single source of truth for the layout. Read via
  `deps.fsService.readFile` (throws on missing → caught → treated as absent),
  matching how logs.ts reads sidecars. No new fs seam invented.
- **Zero-step failed runs**: the old code `return EXIT.OK` early when
  `stepEntries.length === 0`, which would have skipped the failure section.
  Restructured to `if/else` so failed/crashed runs ALWAYS reach the failure
  section (the existing "crashed run with zero steps" test now also emits it;
  that test only asserts the exit code, still passes).
- **NDJSON parse**: line-by-line, skip blank/unparseable lines (per-line
  try/catch) so a truncated final line from a killed run never throws. Keeps the
  LAST `step:failed` record.
- **Reason extraction**: string → verbatim; object with string `message` → that;
  else `(see transcript)`. Added `// TODO: prefer persisted errorClass once plan
  010 lands` right above the assignment.
- **Details pointer**: always printed. With a known step:
  `orch logs <fullRunId> --step <name>` + the lifecycle path. Unknown step:
  `Failed step: (unknown — see logs)`, `orch logs <fullRunId>` + the lifecycle
  path.
- **Test glyph**: `GLYPH_COMPLETED = glyphs(process.stdout.isTTY ?? false).completed`
  mirrors status.ts's module-level TTY resolution (glyph is `✓` on TTY, `+`
  otherwise) so the completed-run assertion is robust in both environments.

## Verified

- `bun run typecheck` → exit 0 (clean, `tsc --noEmit`).
- `bun test tests/integration/cli/commands/status.test.ts` → 9 pass / 0 fail
  (6 pre-existing + 3 new). Did NOT run bare `bun test`, `bun run check`, or any
  git command (per constraints).

## Left for later / gotchas

- Reason is still best-effort: Error objects JSON-serialize their `message` to a
  non-enumerable field, so `error: {}` on the wire → `(see transcript)`. Plans
  009/010 persist a structured `errorClass`; the TODO marks where to prefer it.
- No `plans/README.md` update (out of scope for this worker; the workflow commits).
