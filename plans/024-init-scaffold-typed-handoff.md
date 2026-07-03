# Plan 024: Make `orch init` scaffold a typed two-step handoff

> **Executor instructions**: Follow step by step; run every verification command.
> Stop and report on any STOP condition. Update the plan 024 row in
> `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 0265592..HEAD -- src/cli/commands/init-templates.ts`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (if plan 021 lands first, use `permissions: 'bypass'` in the
  scaffold; otherwise keep the existing flags)
- **Category**: dx / onboarding
- **Planned at**: commit `0265592`, 2026-07-02

## Why this matters

`orch init` scaffolds a single, untyped, fire-and-forget step. The whole reason to
use orch is "typed data handoffs between steps," yet the first workflow a newcomer
sees demonstrates none of it — no `returns:`/`schema`, no passing one step's typed
output into the next. New authors must leave the generated project and hunt through
`examples/` to find the real pattern. A scaffold that models a typed two-step
handoff teaches the happy path at first contact.

## Current state

`src/cli/commands/init-templates.ts` — the scaffold is one untyped step:

```ts
export const STEPS_TEMPLATE = `import { claude, step } from 'orch'
// ...
export const HELLO = step.define('write-hello', {
  agent: claude({
    bare: false,
    flags: ['--permission-mode', 'bypassPermissions'],
  }),
  prompt:
    'Create a file at ./hello.txt containing exactly the text "hello from orch" ...',
})
`

export const HELLO_WORKFLOW_TEMPLATE = `import { workflow } from 'orch'
import { HELLO } from '../steps.ts'

export default workflow('hello', async (run) => {
  await run(HELLO)
})
`
```

Templates are exported string constants (not files) — see the file header comment
(`init-templates.ts:1-3`). Tests: `tests/unit/cli/commands/init-templates.test.ts`
and `tests/integration/cli/commands/init*.test.ts`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `bun run typecheck` | exit 0 |
| Init tests | `bun test tests/unit/cli/commands/init-templates.test.ts tests/integration/cli/commands/init.test.ts` | all pass |
| Full gate | `bun run check` | exit 0 |

## Scope

**In scope:**
- `src/cli/commands/init-templates.ts` — expand `STEPS_TEMPLATE` and
  `HELLO_WORKFLOW_TEMPLATE` to a typed two-step handoff.
- `tests/unit/cli/commands/init-templates.test.ts` (and any init test asserting
  template content) — update expectations.

**Out of scope (do NOT touch):**
- `newWorkflowTemplate` (the `orch new` skeleton) — leave it minimal; optionally
  update its comment to point at the richer `steps.ts` example.
- The `CONFIG_TEMPLATE` (unless plan 025/scaffold consistency requires it — it does
  not here).
- The scaffolder logic in `src/cli/commands/init.ts` / `scaffold.ts`.

## Steps

### Step 1: Design the two-step scaffold

Produce a scaffold that:
1. Step 1 (`SUMMARIZE` or similar): an autonomous `claude()` step with a `returns:`
   Zod schema producing a small typed object, e.g. `{ topic: string, factCount:
   number }`, from a simple prompt (e.g. "pick a topic and 3 facts, return them as
   JSON matching the schema"). Import `schema` and `z` from `'orch'`.
2. Step 2 (`WRITE_FILE`): consumes step 1's typed result and writes a file. Because
   the prompt needs step-1 data at runtime, use a per-call `prompt:` or `vars:`
   override at the `run()` site (see the existing guide
   `docs/public/guide/4-writing-a-workflow.md` for the canonical shape) so the
   handoff is visible.

Keep it runnable end-to-end with the same permission handling the current scaffold
uses (or `permissions: 'bypass'` if plan 021 landed). Keep prompts short and
deterministic-ish. Add brief comments naming what each part demonstrates
(typed output, handoff) and a pointer comment to
`docs/public/guide/4-writing-a-workflow.md`.

### Step 2: Write the templates

Rewrite `STEPS_TEMPLATE` to define both steps (with the `import { claude, schema, z,
step } from 'orch'` line, since it now uses `schema`/`z`). Rewrite
`HELLO_WORKFLOW_TEMPLATE` so the workflow body captures step 1's typed result and
feeds it into step 2, e.g.:

```ts
export default workflow('hello', async (run) => {
  const summary = await run(SUMMARIZE)          // typed result
  await run(WRITE_FILE, { vars: { topic: summary.topic } })
})
```

Ensure the generated TypeScript is valid (matching quotes, imports, no unused
symbols). The templates are strings — escape backticks/`${}` as the file already
does.

**Verify**: `bun run typecheck` → exit 0 (the template strings compile as part of
the module; but they are strings, so also do Step 3 to prove the GENERATED code
compiles).

### Step 3: Prove the generated project compiles

The strongest check: the init tests scaffold into a temp dir and (in the e2e/int
tests) may typecheck or load the generated workflow. Update those tests'
expected-content assertions to match the new templates. If an integration test
actually loads/dry-runs the scaffolded workflow, ensure the new templates load
without error (a `dry-run` peek should succeed structurally even without a real CLI).

If no test compiles the generated code, add a unit assertion that the templates
contain the key teaching markers: `returns:`, `schema(`, `run(SUMMARIZE)`, and the
handoff into the second step. This locks the scaffold's intent.

**Verify**: `bun test tests/unit/cli/commands/init-templates.test.ts tests/integration/cli/commands/init.test.ts`
→ all pass; then `bun run check` → exit 0.

## Test plan

- Update template-content assertions in `init-templates.test.ts` to the new strings.
- Add/keep a check that the scaffold demonstrates typed output + handoff (markers
  above).
- If an init integration test scaffolds + loads, confirm the new workflow loads.
- Pattern to copy: the existing init template tests.
- Verification: the init test files → all pass.

## Done criteria

ALL must hold:

- [ ] `STEPS_TEMPLATE` defines two steps, one with a `returns:` schema.
- [ ] `HELLO_WORKFLOW_TEMPLATE` passes step 1's typed result into step 2.
- [ ] The generated code is valid TypeScript (imports match usage; no unused
      symbols).
- [ ] Init tests updated and passing.
- [ ] `bun run check` exits 0.
- [ ] Only in-scope files modified.
- [ ] `plans/README.md` row 024 updated.

## STOP conditions

Stop and report if:

- An init integration test actually RUNS the scaffolded workflow against a real CLI
  (it would need auth) — do not make the scaffold depend on network/auth in a way
  that breaks CI; keep the demo minimal and, if needed, keep the runnable default a
  no-network prompt. Report if you can't.
- The generated two-step code cannot be made to typecheck as a standalone workflow —
  report the type error; the handoff shape may need adjusting to match the real
  `run()`/`vars` API in `docs/public/guide/4-writing-a-workflow.md`.

## Suggested executor toolkit

- Read `docs/public/guide/4-writing-a-workflow.md` and
  `docs/public/guides/typed-returns.md` for the canonical typed-handoff shape before
  writing the templates — copy that shape so the scaffold matches the docs.

## Maintenance notes

- Keep the scaffold in lockstep with the "writing a workflow" guide — if the guide's
  canonical example changes, update this template.
- Reviewer: run `orch init` in a scratch dir and confirm the generated project
  typechecks and reads as a teaching example, not just that tests pass.
