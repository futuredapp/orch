# Plan 006: Spike — can orch move to Zod v4 (and drop `zod-to-json-schema`)?

> **Executor instructions**: This is an INVESTIGATION plan. Its deliverable is
> a findings report, not lasting code changes. All experimental edits
> (dependency bump, scratch scripts, `schema.ts` swap) are temporary and must
> be fully reverted before finishing — only the findings file remains. Follow
> the steps, answer every question in the report template, and STOP at the
> listed conditions. When done, write the report and update the status row
> for this plan in `plans/README.md` — unless a reviewer dispatched you and
> told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 832a56d..HEAD -- package.json src/core/schema.ts`
> If either changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it
> as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M (spike; the migration itself, if green-lit, is L and gets its own plan)
- **Risk**: LOW (no lasting production changes — all experimental edits reverted)
- **Depends on**: none
- **Category**: migration (investigate)
- **Planned at**: commit `832a56d`, 2026-06-11

## Why this matters

orch pins `zod@^3.23.8` and `zod-to-json-schema@^3.25.2`
(`package.json:60-61`). Zod v4 has been out since 2025 and the v3↔v4 split
already bites orch users in production: when a *host project* uses Zod v4
while orch bundles v3, `zodToJsonSchema()` silently emits an empty schema and
the Claude CLI fails mid-run with an opaque API 400. orch currently defends
with a runtime guard and an error message telling users to downgrade or
import `z` from orch:

```typescript
// src/core/schema.ts:38-45 (the documented hazard)
// Why this exists: when the input Zod schema comes from a major version
// `zod-to-json-schema` doesn't understand (Zod v4 in the host project while
// orch is on v3 is the field-reported case), the converter silently returns
// only `{"$schema": "..."}`. Without this guard we would stringify `{}` and
// hand it to the runner; Claude CLI would then fail mid-run with an opaque
// `tools.<n>.custom.input_schema.type: Field required` 400 from the API.
```

Moving orch itself to v4 — and ideally to Zod v4's **native**
`z.toJSONSchema()`, eliminating the `zod-to-json-schema` dependency — would
remove this hazard class for the growing majority of hosts on v4 (while
inverting it for v3 hosts; the spike must weigh that). This spike answers
go/no-go with evidence before anyone commits to a multi-day migration.

## Current state

- `package.json` dependencies: `zod: ^3.23.8` (lockfile resolves 3.25.76),
  `zod-to-json-schema: ^3.25.2`.
- 16 files import `from 'zod'` (verified by grep on 2026-06-11):
  `src/index.ts`, `src/core/worktree.ts`, `src/core/types.ts`,
  `src/core/schema.ts`, `src/core/command.ts`, `src/config/index.ts`,
  `src/cli/commands/init.ts`, `src/cli/commands/scaffold.ts`,
  `src/runners/types.ts`, `src/state/state-store.ts`,
  `src/runners/scripted-fake/types.ts`, `src/runners/codex/codex-runner.ts`,
  `src/runners/claude/claude-runner.ts`,
  `src/hosts/two-pane/steps-view/start-steps-view.ts`,
  `src/hosts/two-pane/steps-view/tui-overlay.ts`,
  `src/hosts/two-pane/steps-view/steps-view-runner.tsx`.
- `src/core/schema.ts` is the only `zod-to-json-schema` consumer (verify with
  `grep -rn "zod-to-json-schema" src/`), and it re-exports `z` as orch's
  public API surface (`import { z } from 'orch'` is the documented pattern
  for user workflows — see the error message at `src/core/schema.ts:58-62`).
- The repo gate: `bun run check`. Fast loops:
  `bun run test:unit`, `bun run typecheck`.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Try the bump (temporary) | `bun add zod@^4` | resolves or errors |
| Typecheck | `bun run typecheck` | error inventory |
| Unit tier | `bun run test:unit` | pass/fail inventory |
| Schema-focused tests | `grep -rln "schema(" tests/unit tests/integration --include="*.test.ts"` then `bun test <those paths>` | pass/fail |
| Revert all edits | `git restore package.json bun.lock src/ && bun install` | `git status` shows only `plans/` changes; zod v3 restored |

## Scope

**In scope**:
- Temporary, uncommitted experimental edits (`package.json`/`bun.lock` bump,
  `src/core/schema.ts` swap, scratch scripts) — ALL reverted in Step 5.
- `plans/006-zod-v4-spike-findings.md` (create — the only lasting change).

**Out of scope** (hard rules):
- NOTHING from the experiment persists: when this plan finishes, the only
  change visible in `git status` is under `plans/`.
- Do not publish anything anywhere.

## Steps

### Step 1: Establish facts about the dependency matrix

Record:
- `bun pm ls | grep -i zod` — exact installed versions today.
- The installed `zod-to-json-schema`'s declared `peerDependencies` (read
  `node_modules/zod-to-json-schema/package.json`). Planning-time signal said
  it may claim `^3.25.28 || ^4` — verify, don't trust.
- Latest zod v4 version available: `bun pm view zod versions | tail -5`
  (or `npm view zod version` if available).

**Verify**: all three facts recorded with exact version strings.

### Step 2: Attempt the bump and inventory the breakage

`bun add zod@^4`, then run `bun run typecheck` and capture EVERY error,
grouped by file. Pay specific attention to:
- `ZodTypeDef` (used somewhere in orch's types per the audit — grep
  `grep -rn "ZodTypeDef" src/`): v4 restructured internal def types.
- `z.ZodType` generic arity changes.
- `.safeParse` / `ZodError` shape uses (`src/core/schema.ts:70-74` references
  `ZodError`).
- Whether `zod-to-json-schema` still typechecks and — more importantly —
  still emits a NON-empty schema at runtime with a v4 `z.object`. Write a
  10-line scratch script (temporary; deleted in Step 5) that calls orch's
  `schema()` on `z.object({ name: z.string() })` and prints the `jsonSchema`
  string; the
  guard at `src/core/schema.ts:46` throws on the empty-schema failure mode,
  so "does `schema()` throw?" is the test.

Then run `bun run test:unit` and the schema-focused test paths; record
failures.

**Verify**: a written inventory exists — error count by file, plus the
scratch-script outcome.

### Step 3: Evaluate the native-JSON-Schema path

Still with the experimental v4 bump in place, check whether Zod v4's built-in
`z.toJSONSchema(schema)` can replace `zodToJsonSchema(...)` inside
`src/core/schema.ts` (a temporary edit, reverted in Step 5):
- Swap the call in `schema.ts`, adapt the `$schema`-stripping logic
  (`src/core/schema.ts:25-28`) if v4's output differs, rerun the scratch
  script and the schema-focused tests.
- Note any output-shape differences (key ordering, `additionalProperties`
  defaults, `$ref` usage) — downstream this string goes to
  `claude --json-schema` → Anthropic API `input_schema`, which requires at
  minimum a `type` key (see `NON_EMPTY_SCHEMA_KEYS`,
  `src/core/schema.ts:36`).

**Verify**: a yes/no on "native path works", with the diff of `schema.ts`
needed and the test outcomes.

### Step 4: Assess the host-mismatch inversion

Answer in writing: after orch→v4, what happens to a host project still on
Zod v3 whose workflow does `import { z } from 'zod'` (the documented
anti-pattern)? Construct the scenario if cheap (a temp project with zod v3 and
a workflow importing it), or reason from the guard's mechanics: does
`assertNonEmptyJsonSchema` still catch it, and does the error message at
`src/core/schema.ts:50-63` need rewording (it currently tells users to
*downgrade to v3* — after migration it must say the opposite)?

**Verify**: the question is answered with either an experiment result or an
explicit "reasoned, not tested" label.

### Step 5: Write the findings report and revert the experiment

Create `plans/006-zod-v4-spike-findings.md` with:

1. **Verdict**: GO / NO-GO / GO-WITH-CONDITIONS for the migration.
2. The dependency-matrix facts (Step 1).
3. Breakage inventory (Step 2) — typecheck errors by file, test failures.
4. Native `z.toJSONSchema` feasibility (Step 3) and whether
   `zod-to-json-schema` can be dropped.
5. Host-mismatch analysis (Step 4), including the `schema.ts` error-message
   rewrite needed.
6. A step list for the real migration plan (if GO), with the file list and
   estimated effort.
7. Anything that surprised you.

Then revert every experimental edit: delete the scratch script,
`git restore package.json bun.lock src/`, and `bun install` to restore the
v3 dependency tree.

**Verify**: findings file exists; `git status` shows only the new findings
file and the README row update; `bun pm ls | grep -i "zod@"` shows zod 3.x
again; `bun run typecheck` exits 0.

## Test plan

Not applicable — investigation only. The "tests" are Step 2/3's empirical
runs against the temporary dependency bump.

## Done criteria

- [ ] `plans/006-zod-v4-spike-findings.md` exists and answers all 7 sections
- [ ] Verdict is explicit (GO / NO-GO / GO-WITH-CONDITIONS)
- [ ] All experimental edits reverted: `git status` shows changes only under
      `plans/`; `bun pm ls` shows zod 3.x; `bun run typecheck` exits 0
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `bun add zod@^4` fails at the resolver level (peer conflict that `bun`
  refuses) — record the exact error as the finding; that alone may be the
  NO-GO answer.
- The typecheck error count exceeds ~100 — stop enumerating, sample the top
  patterns, and report; full enumeration is the migration plan's job.
- You find yourself fixing more than `src/core/schema.ts` to make the
  scratch script run — the spike measures cost, it doesn't pay it.

## Maintenance notes

- If the verdict is GO, the follow-up migration plan must include: the
  `schema.ts:50-63` error-message rewrite (it currently instructs users to
  align on v3), a CHANGELOG entry flagging the host-compat change, and a docs
  sweep of `docs/public/` for any `zod@^3` advice.
- If NO-GO, record the blocking reason in `plans/README.md` under "Findings
  considered and rejected" so the question isn't re-opened without new
  information (e.g. a zod-to-json-schema release).
