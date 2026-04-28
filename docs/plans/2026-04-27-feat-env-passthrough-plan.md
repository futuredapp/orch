---
title: "feat: Replace env allowlists with passthrough across runners and tmux"
type: feat
date: 2026-04-27
brainstorm: docs/brainstorms/2026-04-27-env-passthrough-brainstorm.md
---

# feat: Replace env allowlists with passthrough across runners and tmux

## Context

`orch` filters the environment in five independent places before subprocess
launch — `CLAUDE_ENV_ALLOWLIST`, `CODEX_ENV_ALLOWLIST`, the tmux server's
`PATH/HOME/LANG`-only env (`buildTmuxEnv`), `TmuxHost.runInteractive`'s silent
drop of `spawn.env`, and a sketched-but-unimplemented "default-deny" contract
in the Phase 2 plan. Layered together they break the experience the user
expects: running `claude` from their shell logs in fine, but running `orch`
from the same shell shows "Please run /login" because `ANTHROPIC_API_KEY`,
keychain-bootstrap vars (`SECURITYSESSIONID`, `__CFBundleIdentifier`),
`SHELL`, `USER`, project tooling shims (`nvm`, `rbenv`, `NODE_EXTRA_CA_CERTS`,
loader vars) and most of `process.env` never reach the subprocess.

Threat model is wrong for the deployment context: `orch` is a developer's
local tool, not a CI runner. The user's shell secrets are the user's own
secrets — `orch` is not the trust boundary.

**New contract:** every process `orch` launches sees the same environment the
`orch` process saw. Workflow authors override individual keys via `ctx.env`.
Runners may inject a small set of mode-specific extras (today: only
`FORCE_COLOR=3` for Claude interactive mode in tmux). Nothing is stripped;
nothing is unoverridable.

Full reasoning lives in
[`docs/brainstorms/2026-04-27-env-passthrough-brainstorm.md`](../brainstorms/2026-04-27-env-passthrough-brainstorm.md).

## Acceptance criteria

- [ ] Running `orch` from a shell with `ANTHROPIC_API_KEY` exported produces a
  logged-in Claude session (no "Please run /login"). *(Manual; not yet
  exercised — will verify post-merge.)*
- [ ] Running interactive Claude under `orch` on macOS uses the user's existing
  OAuth keychain credentials (i.e. keychain-bootstrap vars reach the agent).
  *(Manual; not yet exercised — will verify post-merge.)*
- [ ] Setting `NODE_OPTIONS=--inspect` or `LD_PRELOAD=...` in the user's shell
  flows to the spawned agent. *(Manual; not yet exercised.)*
- [x] Setting `FOO=bar` via `ctx.env` overrides the same key from the user's
  shell on the spawned agent. *(Unit-tested via fixture; no real
  workflow path exists until YAML → `ctx.env` wiring lands in a follow-up
  PR — see "Out of scope".)*
- [x] Interactive mode still renders Claude/Ink colors correctly
  (`FORCE_COLOR=3` extra preserved for Claude in interactive mode).
- [x] `bun run check` is green: lint, typecheck, unit, mocked integration.

## Final precedence rule (single source of truth)

For every spawned process, the runner builds env via a shared helper:

```ts
mergeEnv(processEnv, extras, ctxEnv)
```

- `processEnv` = the orch process's `process.env` (passed via injection so
  tests can stub it). `undefined` values are filtered.
- `extras` = optional record of runner/mode-specific overrides applied
  *between* `processEnv` and `ctxEnv`. Today the only entry is
  `{ FORCE_COLOR: '3' }` for Claude interactive mode; Codex passes `{}`.
- `ctxEnv` = `BuildCommandCtx.env` from the workflow author. Wins last by
  design — the workflow file is the user's adjustment surface, including
  the ability to disable runner extras (e.g. set `FORCE_COLOR=0`).

`mergeEnv` filters `undefined` from `processEnv` at the boundary (TypeScript
strict + `noUncheckedIndexedAccess`), so the result is
`Record<string, string>` with no `undefined` values. The same `for-of`
filter pattern is reused at the tmux server `#run` site for consistency.

`extras` is intentionally **not** a parameter on `Runner.buildCommand` —
that would be `{}` for every runner except Claude-interactive. The
abstraction has one user; inline it.

## Scope

### In scope

- Drop both runner allowlists (Claude, Codex).
- Replace `buildTmuxEnv` PATH/HOME/LANG filter with `process.env` passthrough
  (server-inheritance is the load-bearing macOS keychain fix).
- Add optional `env` field to `RespawnPaneOptions`; emit `-e KEY=VAL` flags
  in `respawn-pane`.
- Plumb `spawn.env` through `TmuxHost.runInteractive`'s two `respawnPane`
  calls (currently silently dropped).
- Mark Phase 2/5/9/13 plan docs as superseded (one-line pointer, no
  rewrite). Update the runner-author skill to reflect the new contract.
  Reframe `docs/solutions/interactive-mode-colors.md` from "allowlist
  addition" to "extras passed through `mergeEnv`".
- Add a one-paragraph env policy to `CLAUDE.md` under "How to add a new
  runner".
- Add secret-handling note to `docs/logging.md` (envKeys logging is unchanged
  but the explanation needs context under passthrough).
- Rewrite/delete affected unit + mocked-integration tests; add
  passthrough-asserting tests for both runners and the tmux service.

### Out of scope (explicit)

- Wiring `BuildCommandCtx.env` from a workflow YAML field. Today
  `src/core/workflow.ts:670–676` and `:395–402` hardcode `env: {}`. The type
  surface stays; runners will merge an empty object correctly. A follow-up PR
  can add YAML support.
- Modifying `GitService`'s explicit env dict (Phase 6 plan, line 17). That
  envelope is internal to the validator's git subprocess — orthogonal to the
  runner/host env policy.
- The `pipe-pane-capture.ts` work-in-progress changes already on this branch.

## Critical files to modify

### Code

| Path | Lines | Change |
|---|---|---|
| `src/runners/_shared/merge-env.ts` (new) | new file | Export `mergeEnv(processEnv, extras, ctxEnv): Record<string, string>`. Filters `undefined` from `processEnv`, then spreads `extras`, then `ctxEnv`. ~10 LOC. Single barrel re-export from `src/runners/index.ts` if needed by external callers; otherwise file-local to `src/runners/`. |
| `src/runners/claude/claude-runner.ts` | 78–119, 268 | Delete `CLAUDE_ENV_ALLOWLIST` and `buildClaudeEnv`. At the env construction site call `mergeEnv(processEnv, mode === 'interactive' ? { FORCE_COLOR: '3' } : {}, ctxEnv)`. |
| `src/runners/codex/codex-runner.ts` | 49–96, 257/291 | Delete both allowlists, the `OPENAI_BASE_URL` exclusion, and `buildCodexEnv`. At the env construction sites call `mergeEnv(processEnv, {}, ctxEnv)`. |
| `src/services/tmux/tmux-service.ts` | 187–199 | Add optional `readonly env?: Readonly<Record<string, string>>` to `RespawnPaneOptions`. |
| `src/services/tmux/real-tmux-service.ts` | 38–42, 278, 298 | Delete `buildTmuxEnv`; at the tmux server `#run` site, build a passthrough record with the same `for-of` filter pattern used in `mergeEnv`. In `respawnPane`, emit one `-e KEY=VAL` per entry of `opts.env`; throw if any key contains `=` or newline (corrupts argv). |
| `src/services/tmux/fake-tmux-service.ts` | (`respawnPane` recorder, ~line 165) | No code change — already records `opts` as-is; the optional `env` field flows through automatically. Verify in tests. |
| `src/hosts/two-pane/tmux-host.ts` | 351–393 | In both `respawnPane` calls inside `runInteractive`, pass `env: spawn.env` through to options. |
| `src/runners/execute.ts` | 31–98 | **No code change** — Phase-2 "default-deny" was never implemented; `runRunner` already passes `cmd.env` verbatim. Doc-only fix. |
| `src/hosts/plain/plain-host.ts` | 111–125 | **No change** — already passes `spawn.env` through `spawnForeground` correctly. |
| `src/services/process/bun-process-service.ts` | 14–54, 56–84 | **No change** — already forwards `opts.env` verbatim. |
| `src/core/workflow.ts` | 395–402, 670–676 | **No change** — `env: {}` literal stays. Runners merge it correctly under the new precedence rule. (Wiring YAML → `ctx.env` is a follow-up.) |

### Tests

| Path | Action |
|---|---|
| `tests/unit/runners/_shared/merge-env.test.ts` (new) | ADD: passes through arbitrary keys (`LD_PRELOAD`, `NODE_OPTIONS`); filters `undefined` values; `extras` override `processEnv` on conflict; `ctxEnv` overrides `extras` on conflict; `ctxEnv` overrides `processEnv` on conflict; empty `extras` and `ctxEnv` produce a clean passthrough; result has no `undefined` values. The contract is tested **once**, here. |
| `tests/unit/runners/claude/build-command.test.ts` | DELETE the 7 allowlist tests (DATABASE_URL exclusion; HOME/PATH allowlist; ANTHROPIC_*/CLAUDE_* prefix; TERM/COLORTERM; IS_SANDBOX; allowlist-vs-ctxEnv precedence; processEnv-vs-ctxEnv precedence — now covered by `merge-env.test.ts`). KEEP the 2 high-value Claude-specific tests (FORCE_COLOR=3 in interactive, no FORCE_COLOR in autonomous). ADD: "ctx.env can override interactive FORCE_COLOR" (one assertion that the integration through `mergeEnv` works as documented). |
| `tests/unit/runners/codex/build-command.test.ts` | DELETE the 7 allowlist + filter tests (DATABASE_URL, STRIPE_SECRET_KEY, CODEX/OPENAI prefix, OPENAI_BASE_URL exclusion, HOME/PATH allowlist, ctxEnv-LD_PRELOAD filter, no-undefined). KEEP the test-process-isolation setup. No new tests — Codex has no extras; the contract is fully covered by `merge-env.test.ts`. |
| `tests/unit/services/tmux/tmux-service.test.ts` | KEEP `respawnPane` argv recording + `killRunning` shape tests. ADD: "respawnPane emits -e KEY=VAL for each env entry"; "respawnPane omits -e when env is undefined or empty"; "respawnPane throws when an env key contains '=' or newline". |
| `tests/unit/hosts/tmux-host.test.ts` | REWRITE "Respawns right pane with runner argv, then restores cat on exit" to assert two new properties: runner respawn includes `env: spawn.env`; placeholder restore respawn explicitly omits `env` (the `cat` placeholder needs no environment). The asymmetry is the design — the test should teach it. |
| `tests/integration/services/tmux/tmux-real.integration.test.ts` (already modified on branch) | ADD: "Tmux server inherits full process.env" (verify a non-allowlist key like `ANTHROPIC_API_KEY` reaches a pane process). |
| `tests/integration/hosts/two-pane-interactive.test.ts` | KEEP shape assertion. Optionally extend to verify `env` plumbing end-to-end via FakeTmuxService capture. |

### Docs

| Path | Change |
|---|---|
| `CLAUDE.md` | Add ~3 lines under "How to add a new runner": runners build env via `mergeEnv(process.env, extras, ctx.env)`. No filtering, no allowlisting. Extras are runner/mode-specific (e.g. `FORCE_COLOR=3` for Claude interactive); `ctx.env` always wins. |
| `docs/plans/implementation-phases.md` | Replace the six allowlist mentions (lines 144, 149, 240, 242, 246, 286) with one short pointer: "Env policy: passthrough — see [2026-04-27 env passthrough plan](2026-04-27-feat-env-passthrough-plan.md)." |
| `docs/plans/2026-04-09-feat-phase-2-runner-port-plan.md` | Add at the top of finding #8 (line 40): "**Superseded by [2026-04-27 env passthrough plan](2026-04-27-feat-env-passthrough-plan.md).** The original 'default-deny env contract' was never implemented; the new contract is passthrough." Don't rewrite the body — the archaeology is correct. |
| `docs/plans/2026-04-11-feat-phase-5-claude-runner-plan.md` | Add same superseded pointer at the top of the env-handling section (line 105). Don't rewrite. |
| `docs/plans/2026-04-12-feat-phase-9-codex-runner-plan.md` | Add same superseded pointer at the top of the env-handling section (line 371). Don't rewrite. |
| `docs/plans/2026-04-13-feat-phase-13-interactive-steps-tmux-plan.md` | Add same superseded pointer near the env discussion (line 18). Don't rewrite. |
| `docs/solutions/interactive-mode-colors.md` | Reframe lines 40–46: `TERM`/`COLORTERM` now flow via passthrough automatically; `FORCE_COLOR=3` is the only env adjustment the runner makes for interactive mode. |
| `docs/logging.md` | Add note near `envKeys` logging (around lines 69–71): under passthrough, the user's full env keys appear in `spawns.ndjson` (keys only, no values) — be aware when sharing logs. |
| `.claude/skills/runner-author/SKILL.md` | Add explicit teaching: "Environment: build with `mergeEnv(processEnv, extras, ctxEnv)` from `src/runners/_shared/merge-env.ts`. Passthrough by default; extras are runner/mode-specific (e.g. `FORCE_COLOR=3` for Claude interactive); `ctx.env` always wins on conflict." |

**Out of repo (flag in PR description, not in this plan):** `~/.claude/skills/runner-author/SKILL.md` (global) needs the same edit if the user has one. The PR description should ask the user to apply it manually after merge — outside the review surface.

## Implementation phases

Tests ship in the same phase as the code they cover (per project rules in
`CLAUDE.md` and the `testing-strategy` skill). `bun run check` must be
green at the end of each phase.

### Phase 1 — Tmux env plumbing

Goal: tmux can carry per-pane env, and the tmux server inherits the orch
process's full env.

1. **Add `env?` to `RespawnPaneOptions`** in
   `src/services/tmux/tmux-service.ts:187–199`:
   `readonly env?: Readonly<Record<string, string>>`.
2. **Implement in `real-tmux-service.ts:respawnPane`**: for each entry of
   `opts.env`, append `-e`, `${k}=${v}` to the tmux argv before the `--`
   separator. Skip when `env` is undefined/empty. **Throw** if any key
   contains `=` or newline (would corrupt the `-e KEY=VAL` argv) — clear
   message naming the offending key.
3. **Delete `buildTmuxEnv`** (`real-tmux-service.ts:38–42`). At the
   `#run` call site (line 298), build a passthrough record with the same
   `for-of` filter pattern that lives in `mergeEnv`:
   ```ts
   const serverEnv: Record<string, string> = {}
   for (const [k, v] of Object.entries(process.env)) {
     if (v !== undefined) serverEnv[k] = v
   }
   ```
4. **Plumb `spawn.env` through `TmuxHost.runInteractive`**
   (`tmux-host.ts:351–393`): both `respawnPane` calls for the runner
   receive `env: spawn.env` in their options. The placeholder restore
   call deliberately omits `env` — the `cat` placeholder needs nothing.
5. **`FakeTmuxService.respawnPane` records `opts` already** — no code
   change needed; verify in tests.
6. **Tests** (in this phase):
   - `tmux-service.test.ts`: ADD three new shape tests (`-e` emission,
     omission, key validation throw).
   - `tmux-host.test.ts`: REWRITE the runner-respawn test to assert both
     the runner respawn carries `env: spawn.env` AND the placeholder
     restore explicitly omits `env`.
   - `tmux-real.integration.test.ts`: ADD "Tmux server inherits full
     process.env" (e.g. `ANTHROPIC_API_KEY` reaches a pane process).

### Phase 2 — Drop runner allowlists, extract `mergeEnv`

Goal: replace the two allowlists with a single shared helper.

1. **Create `src/runners/_shared/merge-env.ts`**:
   ```ts
   export function mergeEnv(
     processEnv: Readonly<Record<string, string | undefined>>,
     extras: Readonly<Record<string, string>>,
     ctxEnv: Readonly<Record<string, string>>,
   ): Record<string, string> {
     const env: Record<string, string> = {}
     for (const [k, v] of Object.entries(processEnv)) {
       if (v !== undefined) env[k] = v
     }
     for (const [k, v] of Object.entries(extras)) env[k] = v
     for (const [k, v] of Object.entries(ctxEnv)) env[k] = v
     return env
   }
   ```
2. **Claude** (`claude-runner.ts`): delete `CLAUDE_ENV_ALLOWLIST`
   (78–99) and `buildClaudeEnv` (103–119). At the env construction site
   (~line 268), call:
   ```ts
   const env = mergeEnv(
     processEnv,
     mode === 'interactive' ? { FORCE_COLOR: '3' } : {},
     ctxEnv,
   )
   ```
3. **Codex** (`codex-runner.ts`): delete both allowlists, the
   `OPENAI_BASE_URL` exclusion, and `buildCodexEnv` (49–96). At the env
   construction sites (~lines 257/291), call
   `mergeEnv(processEnv, {}, ctxEnv)`.
4. **Tests** (in this phase):
   - `merge-env.test.ts` (new): the contract — passthrough, undefined
     filtering, three layers of override precedence. The full inventory
     is in the Tests table above.
   - `claude/build-command.test.ts`: DELETE the 7 allowlist tests; KEEP
     the 2 Claude-specific FORCE_COLOR tests; ADD one integration check
     that `ctx.env` overrides the interactive `FORCE_COLOR` extra.
   - `codex/build-command.test.ts`: DELETE the 7 allowlist + filter
     tests; no new tests (the contract is fully covered by
     `merge-env.test.ts`).
5. **`runRunner` (`src/runners/execute.ts`) is doc-only** — the Phase 2
   plan's "default-deny + loader scrub" was never implemented. No code
   change.
6. Run `bun run check` — must be fully green before Phase 3.

### Phase 3 — Docs

Apply the doc edits above. No code touched.

## Existing utilities to reuse

- `ProcessService.spawn` and `spawnForeground` already accept arbitrary `env`
  records and forward them verbatim (`bun-process-service.ts:24, 66`). No
  service changes needed.
- `PlainHost.runInteractive` already passes `spawn.env` correctly
  (`plain-host.ts:120`). The fix is to bring `TmuxHost` to parity, not to
  invent a new mechanism.
- `assertNoNestedTmux` (existing) protects against passing `TMUX` /
  `TMUX_PANE` into the tmux server: it errors before the server is created
  if orch was launched from inside tmux. This means `TMUX` passthrough is
  safe in practice; no special-case stripping needed.

## Verification

End-to-end:

1. `bun run check` — lint + typecheck + unit + mocked integration green.
2. `bun run test:integration` (or whichever target runs the real-tmux
   integration tests) — confirm new "server inherits process.env" test
   passes.
3. **Manual macOS keychain test:** with the host shell already logged into
   Claude (OAuth via the standard CLI), run a workflow that opens an
   interactive Claude pane via `orch`. The pane should NOT prompt
   "/login" — it should reuse the keychain credentials.
4. **Manual API-key test:** `export ANTHROPIC_API_KEY=...` then run an
   autonomous orch step that invokes Claude. The agent should not prompt
   for login.
5. **Manual loader-var test:** `export NODE_OPTIONS=--inspect-brk=0` and run
   the Claude runner under `orch`. Confirm Node enters debug mode in the
   subprocess (smoke for "loader vars flow through").
6. **`ctx.env` override is unit-tested only.** AC #4 ("`ctx.env` overrides
   `process.env`") is verified by `merge-env.test.ts` and the Claude
   `ctx.env` overrides interactive `FORCE_COLOR` test. There is no real
   workflow path until YAML → `ctx.env` wiring lands; manual end-to-end
   override testing is out of scope for this PR.
7. **Color regression check:** run an interactive Claude step under tmux
   and visually confirm Ink colors render — guards against the
   `FORCE_COLOR=3` extra regressing during the refactor.

## Risks and mitigations

- **Risk:** Logs (`spawns.ndjson` `envKeys` field) suddenly contain many
  more keys, and reviewers worry about secrets.
  **Mitigation:** We log keys only, not values. Add a sentence in
  `docs/logging.md` clarifying the contract under passthrough.
- **Risk:** A test that depended on the absence of an env field (e.g.
  "asserts `env` does not contain `DATABASE_URL`") was added precisely as
  a security check.
  **Mitigation:** Such tests are exactly the ones to delete — the
  invariant they encoded is the bug. The brainstorm explicitly justifies
  this.
- **Risk:** `BuildCommandCtx.env` is hardcoded `{}` everywhere today, so
  the override path is exercised only by tests, not by real workflows.
  **Mitigation:** Acknowledged in scope. Wiring YAML → `ctx.env` is a
  follow-up PR; the type stays so this PR doesn't lock out the future
  change.
- **Risk:** Loader vars (`LD_PRELOAD`, `DYLD_*`) flowing into the agent
  process could in theory be set maliciously by a parent process orch
  inherited from.
  **Mitigation:** Out of threat model — orch is a dev tool. If the
  parent shell is compromised, env stripping is not the right defense.
- **Risk:** Deleting `buildTmuxEnv` lets the tmux server inherit more
  than `PATH/HOME/LANG` — including `PWD` and any session vars. `PWD`
  is harmless (tmux sets pane cwd explicitly); `TMUX`/`TMUX_PANE` are
  the dangerous ones if orch was started from inside a tmux session.
  **Mitigation:** `assertNoNestedTmux` (existing guard) errors before
  the server is created when `TMUX` is set in `process.env`. The
  guard remains load-bearing under the new contract — call this out in
  the integration test as a comment so future authors don't weaken it.
- **Risk:** Passthrough re-introduces a behavior the old allowlist was
  silently fixing. The most concrete case: Codex's `OPENAI_BASE_URL`
  exclusion (codex-runner.ts:65) was added to prevent a redirected
  base URL from reaching the agent.
  **Mitigation:** Reviewed in the brainstorm and judged out of threat
  model — orch is a dev tool, not a CI runner. Rollback is a one-diff
  revert. Once YAML → `ctx.env` wiring lands, a workflow author can
  override per-step if needed.

## Decision log

- **D1: Precedence is `mergeEnv(processEnv, extras, ctxEnv)` — three
  layers, applied in order.** `extras` is a positional slot for
  runner/mode-specific overrides applied between `processEnv` and
  `ctxEnv`. Today the only entry is `{ FORCE_COLOR: '3' }` for Claude
  interactive; Codex passes `{}`. `ctxEnv` wins last by design — the
  workflow file is the user's adjustment surface, including the ability
  to disable runner extras (e.g. set `FORCE_COLOR=0` for monochrome).
- **D2: Filter `undefined` during the `processEnv` spread, once, in
  `mergeEnv`.** TypeScript strict + `noUncheckedIndexedAccess` types
  `process.env.X` as `string | undefined`. The same `for-of` filter
  pattern is reused at the tmux server `#run` site for consistency
  (avoid the `Object.fromEntries` + type-predicate dance).
- **D3: Delete `buildTmuxEnv` rather than turn it into an identity
  helper.** YAGNI — one fewer indirection. If the day comes when we
  need a pre-spawn env transform for the tmux server, we add it then.
- **D4: `BuildCommandCtx.env` stays hardcoded as `{}` in workflow.ts
  for now.** Wiring it from YAML is a separate, additive change.
  Keeping the type intact preserves the override seam. Acceptance
  criterion #4 is therefore unit-tested only — flagged explicitly in
  the AC text.
- **D5: `runRunner` (`src/runners/execute.ts`) is doc-only.** The
  Phase 2 plan's "default-deny + loader scrub" was never implemented;
  the refactor reconciles the doc with the code rather than touching
  code that doesn't exist.
- **D6: `OPENAI_BASE_URL` exclusion is deleted, not preserved.** The
  exclusion existed to prevent a redirected `OPENAI_BASE_URL` from
  reaching Codex. Under the new threat model (orch is a dev tool; the
  user's shell is not the trust boundary) this is out of scope. Once
  YAML → `ctx.env` wiring lands, a workflow can scrub it per-step if
  ever needed.
- **D7: `respawnPane` validates env keys at the seam.** Keys
  containing `=` or newline would corrupt the `-e KEY=VAL` argv. Throw
  with a clear message rather than relying on tmux's own error. Values
  pass through verbatim — tmux handles them. This is cheap insurance
  for the day `ctx.env` flows from YAML and key contents become user
  input.
- **D8: `extras` is inlined at the call site, not added as a parameter
  on `Runner.buildCommand`.** Today the only entry is one var in one
  runner in one mode. A `runnerExtras: Record<string, string>` field
  on the interface would be `{}` for every runner except
  Claude-interactive — abstraction with one user. Inline it.
- **D9: Old phase plans are marked superseded, not rewritten.** The
  archaeology is correct; rewriting would lose the historical
  reasoning. A one-line "Superseded by [2026-04-27]" pointer at the
  top of the env-handling section in each old plan is enough. The
  `docs/plans/2026-04-27-feat-env-passthrough-plan.md` file is the
  single source of truth from now on.
- **D10: The global `~/.claude/skills/runner-author/SKILL.md` edit is
  out of scope for this PR.** That file lives outside the repo,
  cannot be reviewed, and should not be touched by a project PR.
  Flag it in the PR description as a manual follow-up for the user.

## References

- Brainstorm: [`docs/brainstorms/2026-04-27-env-passthrough-brainstorm.md`](../brainstorms/2026-04-27-env-passthrough-brainstorm.md)
- Phase 2 plan (env contract sketch): [`docs/plans/2026-04-09-feat-phase-2-runner-port-plan.md`](2026-04-09-feat-phase-2-runner-port-plan.md), finding #8 (line 40)
- Phase 5 plan (Claude runner allowlist): [`docs/plans/2026-04-11-feat-phase-5-claude-runner-plan.md`](2026-04-11-feat-phase-5-claude-runner-plan.md), lines 105–129
- Phase 9 plan (Codex runner allowlist): [`docs/plans/2026-04-12-feat-phase-9-codex-runner-plan.md`](2026-04-12-feat-phase-9-codex-runner-plan.md), lines 371–416
- Phase 13 plan (tmux interactive): [`docs/plans/2026-04-13-feat-phase-13-interactive-steps-tmux-plan.md`](2026-04-13-feat-phase-13-interactive-steps-tmux-plan.md), lines 18/125/186
- Existing solution doc: [`docs/solutions/interactive-mode-colors.md`](../solutions/interactive-mode-colors.md)
- CLAUDE.md project rules: [`CLAUDE.md`](../../CLAUDE.md)
