# review-round3-builds: read-only review of e1f6909, a07740f, ee5493a, a38ad83

Read-only review pass over the four round-3 commits on `feat/round-2-improvement-plans`.
No source/test/plan files touched. Only this diary is written.

## TL;DR verdicts

| Commit | Plan | Verdict |
|--------|------|---------|
| ee5493a duplicate step-name guard | 020 | **OK** (deviation is sound — see below; stop re-litigating it) |
| e1f6909 codex auth/billing tests | 016 | **OK** |
| a07740f logs runId prefix | 018 | **OK** |
| a38ad83 bare Zod in returns | 023 | **OK** |

No NEEDS-FIX. No STOP condition hit. Nothing to hand to a fix task.

## PRIMARY: plan-020 `kind === 'agent'` gate — VALIDATED as correct

The implementer narrowed the plan's literal `if (prior.step !== attempted.step)` to
`if (prior.step !== attempted.step && step.config.kind === 'agent')`
(`src/core/workflow.ts:1935`). I confirmed every load-bearing claim:

1. **`kind: 'agent'` has exactly one producer.** `grep "kind: 'agent'" src/core/` →
   only `src/core/step.ts:315` (inside `defineStep`). No factory (worktree/ask/command)
   ever mints `kind: 'agent'`.
2. **`step.define` rejects the factory prefixes.** `RESERVED_PREFIXES = ['commit:',
   'worktree:', 'ask:', 'command:']` (`step.ts:166`) and `defineStep` throws on any name
   with those prefixes (`step.ts:282-287`). So an agent key can **never** alias a factory
   key, and the prior owner of an agent key is necessarily an agent step. The gate cannot
   suppress a genuine agent-vs-agent duplicate.
3. **The throw only fires for genuinely-distinct step objects sharing a name.**
   `assertNoExecutionCollision` is called from exactly one site (`workflow.ts:1989`) with
   `executionOwner` (from `keyOwnersThisExecution`) as `prior` and `attemptedOwner` as
   `attempted`. Both are in-execution owners that carry `step`, so `prior.step` is always
   defined. Same object re-invoked (loop without `as:`) → `prior.step === attempted.step`
   → no throw (matches plan intent, explicitly out of scope).
4. **Resume/cache replay can never trigger it.** `cachedOwner` (`workflow.ts:1997-2000`)
   is built from persisted state, carries **no** `step` field, and is only ever used with
   `StepNameCollisionError` (the subPath check at `:2001-2003`). It never reaches
   `assertNoExecutionCollision`. So `DuplicateStepNameError` cannot fire on the replay path.
5. **The deviation rationale is real.** The worktree factory's own cache-hit guard exists:
   `onCacheHit` throws "Two different branches sanitized to the same step name" at
   `step.ts:458-462`. The literal guard would have pre-empted that better error and broken
   the two `worktree-executor-cache.test.ts` tests (intended by-name factory idempotency,
   not a bug). Gating on `kind === 'agent'` preserves that path intact.

**Conclusion on the gate: sound. The next round should stop re-litigating it.** It is the
precise realization of plan 020's intent (catch the `step.define` copy-paste footgun)
without weakening the error anywhere it should fire. It is neither of the two buckets the
plan's Step 4 offered ("relied on the bug" / "same-object false positive") — it is a third,
legitimate case (content-addressed factory idempotency with its own value guard), and
narrowing to agent kind is the correct handling.

### Residual gap (item 2): acceptable, NOT a defect

Two `command(...)`/`ask(...)` calls with the same name but different args still silently
alias to the first result — the agent gate excludes them. I judge this **acceptable as
pre-existing behavior scoped out of plan 020**, not a NEEDS-FIX:
- Plan 020's "Why this matters" and scope target the `step.define` copy-paste case only;
  it never mentions command/ask.
- These factories are content-addressed and have their own `onCacheHit` value guards; a
  full arg-equivalence guard for them is a separate design decision (the implementer's
  diary flags it as a possible follow-up, which is the right place for it).
- Nothing about the current commit is *wrong*; it just doesn't extend coverage there.

## SECONDARY spot-checks

### 016 (e1f6909) — OK
`tests/unit/runners/codex/recovery.test.ts` adds 2 auth + 2 billing + 1 negative case.
Categories assert against live `classify-error.ts`: auth regex
`/unauthorized|invalid api key|not logged in|authentication/` → `auth`/`transient:false`
(`:77-78`); billing regex `/\b(?:quota|billing)\b/` → `billing`/`transient:false`
(`:82-83`). Negative case `"cannot read /home/user/billingReport.json"` — `\bbilling\b`
fails because `billingReport` has no trailing word boundary, and `quota` is absent, so it
is not billing; the test correctly asserts only `not.toBe('billing')` (robust — doesn't
over-pin the fallthrough). Word-boundary guard is exercised. Test-only; no `src/` touched.

### 018 (a07740f) — OK
`src/cli/commands/logs.ts` `resolveRunId` now calls `deps.registry.findByPrefix(idArg)` and
mirrors `status.ts` byte-for-byte: 0 matches → `No run found matching "<id>"` + `CONFIG_ERROR`
(`status.ts:34`), >1 → `Ambiguous run ID prefix "<id>" matches N runs: <list>` + `CONFIG_ERROR`
(`status.ts:39`). No `!`/`as`: logs.ts uses an explicit `if (match === undefined)` guard then
re-parses through `parseRunId` to restore the branded `RunId` (avoids status.ts's `as RunId`
cast — a strict improvement, and status.ts was correctly left untouched). `--latest` and
empty-idArg paths untouched.

### 023 (a38ad83) — OK
`normalizeReturns` (`src/core/step.ts:~332`) duck-types correctly: `undefined → undefined`;
string `jsonSchema` → already a wrapper, return as-is (a `SchemaWrapper` carries the string
`jsonSchema`, so it's matched first); `safeParse` function → bare Zod, wrap via `schema(...)`
(which runs `assertNonEmptyJsonSchema`). Stored `config.returns` stays a `SchemaWrapper` (the
executor reads `.jsonSchema`/`.zodSchema`). `AutonomousStepInput<T>` omits+re-declares
`returns` as `SchemaWrapper<T> | ZodType<T,...>`. `Step<T>` inference held — pinned by a
compile-time `Expect<Equal<typeof BARE, Step<{n:number}>>>` assertion that passes typecheck.
The `returns !== undefined` spread guard keeps an absent `returns` absent (preserves
`onCacheHit`'s `config.returns === undefined` keying).

## What I verified (commands run — all read-only, path-scoped)

- `bun test tests/unit/core/run-step-once-collision.test.ts tests/unit/core/worktree-executor-cache.test.ts` → **13 pass / 0 fail**.
- `bun test tests/unit/runners/codex/recovery.test.ts tests/unit/cli/logs-command.test.ts tests/unit/core/step.test.ts` → **73 pass / 0 fail**.
- Static confirmation via grep: single `kind: 'agent'` producer; reserved-prefix rejection; single call site of `assertNoExecutionCollision`; `cachedOwner` carries no `step`; classify-error regexes; status.ts wording.

Did NOT run `bun run check`, bare `bun test`, or any git command. Wrote no source/test/plan file.

## Left for later / notes for the master

- All four `plans/README.md` rows (016/018/020/023) are still unchanged — every worker
  correctly deferred that per operator rules. The master/workflow owns those row updates.
- 023 deferred: docs reconciliation (`docs/public/reference/api.md` `step.define` signature)
  and example migration to the bare `returns: z.object(...)` form — separate follow-up.
- 020 possible follow-up (not owed): extend an arg-equivalence guard to command/ask
  factories. Explicitly out of scope for plan 020; only if a future plan calls for it.
- Full-gate `bun run check` across all four footprints is still an operator gate item —
  each worker only ran path-scoped suites + typecheck. Recommend one consolidated
  `bun run check` before the final PR.
