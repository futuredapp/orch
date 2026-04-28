---
date: 2026-04-27
topic: env-passthrough
---

# Environment passthrough for orch-launched processes

## What We're Building

Stop curating the environment when orch launches a coding-agent CLI. Today
the env is filtered in five places — `CLAUDE_ENV_ALLOWLIST`,
`CODEX_ENV_ALLOWLIST`, the tmux server's `PATH/HOME/LANG`-only env,
`TmuxHost.runInteractive`'s silent drop of `spawn.env`, and the
"default-deny" contract sketched for `runRunner` in the Phase 2 plan. Each
layer was added independently for security or layout-determinism reasons,
and together they produce the wrong UX: a user runs `claude` from their
shell and gets a logged-in Claude session; the same user runs orch from the
same shell and gets "Please run /login" — because `ANTHROPIC_API_KEY`,
keychain-bootstrap vars, `SHELL`, `USER`, and most of `process.env` never
reach the Claude subprocess.

The new contract: **every process orch launches sees the same environment
the orch process saw, period.** Workflow authors can override individual
keys via `ctx.env` (their overrides win on conflict). Runners may add a
small number of project-specific keys on top (e.g. `FORCE_COLOR=3` for
Claude interactive mode in tmux). Nothing is stripped.

## Why This Approach

**Threat model is wrong for the deployment context.** The original
allowlists treated Claude as an untrusted agent that might `printenv` and
exfiltrate `DATABASE_URL`. Phase 5 plan, line 128: *"Claude CLI is an AI
agent that can run printenv; forwarding DATABASE_URL, STRIPE_SECRET_KEY
etc. is a secret leak."* That model fits a CI runner; orch is a developer's
local tool. The user explicitly wants "the same experience as a normal
Claude code run" — which means the user's env, full stop. Secrets in the
user's shell env are *the user's own secrets*; orch is not the trust
boundary.

**Strip-by-default has hidden costs beyond auth.** Project tooling that
the agent might invoke from inside the pane (`nvm`, `rbenv`, `kscript`,
homebrew shims, custom proxies, `NODE_EXTRA_CA_CERTS` from the user's
shell, etc.) all silently break under the allowlist. The user surfaced one
case (Claude login); the same root cause produces a long tail of "works
in my shell, breaks under orch" surprises.

**One uniform rule beats five clever ones.** The current code has five
overlapping env-filter layers, each with a slightly different rationale.
Replacing all five with "passthrough + per-step override" is fewer lines,
fewer mental models, and matches what a developer expects from "this is a
wrapper around `claude`".

## Key Decisions

- **Pure passthrough as the base.** No allowlist, no blocklist, no
  loader-injection scrub. The user's shell env is the spawned process's
  env. Rationale: orch is a dev tool, the user owns their own machine and
  their own env.
- **`ctx.env` overrides win.** Precedence is `{ ...processEnv, ...ctxEnv }`.
  Workflow authors get the explicit override surface; the user's shell
  is the default. Rationale: matches the user's "user may adjust this run
  as he wishes" principle — the workflow file *is* the user's adjustment
  surface.
- **Runner-specific carve-outs are additive, not replacing.** Claude's
  `FORCE_COLOR=3` for interactive mode stays — it's added on top of
  passthrough, not used to filter the rest. Rationale: prevents the
  black-and-white-Ink regression in `docs/solutions/interactive-mode-colors.md`
  while honoring the passthrough principle.
- **Tmux server inherits full `process.env`.** Drop `buildTmuxEnv()`'s
  `PATH/HOME/LANG`-only filter. Every pane process inherits the server's
  env, so this is the load-bearing change for the tmux interactive path.
  Rationale: server-inheritance is the only way to get keychain-bootstrap
  vars (`SECURITYSESSIONID`, `__CFBundleIdentifier`, …) to the agent on
  macOS, which is what makes the OAuth keychain auth work.
- **Per-process env via `respawn-pane -e KEY=VAL`.** Add an optional
  `env` field to `RespawnPaneOptions` so runner-specific carve-outs
  (`FORCE_COLOR`) and workflow overrides (`ctx.env`) can override the
  inherited server env on a per-spawn basis. Rationale: the server env
  is the bulk; `-e` flags are the precise overrides.
- **Drop both `CLAUDE_ENV_ALLOWLIST` and `CODEX_ENV_ALLOWLIST`.** Same
  treatment for both runners in one pass. Rationale: the inconsistency is
  exactly the bug — make the rule uniform across all CLIs orch wraps.
- **Loader-injection vars are not stripped.** `LD_PRELOAD`, `DYLD_*`,
  `NODE_OPTIONS` flow through. Rationale: if the user has them set, they
  almost certainly want them (e.g. `NODE_OPTIONS=--inspect` for debugging
  the Claude CLI itself). Stripping them would itself be a stripping
  policy, which is what we're abolishing.

## Open Questions

These belong in the implementation plan, not here:

- Existing unit tests assert on the allowlist (`build-command.test.ts`,
  Codex equivalent, and a handful of integration tests). Are they
  rewritten to assert "process.env passes through and ctx.env overrides",
  or deleted as no-longer-meaningful?
- The Phase 2 plan's "default-deny env contract" in `runRunner` (loader
  scrub of `LD_PRELOAD`, `DYLD_*`, `NODE_OPTIONS`, etc.) — was this ever
  implemented? If yes, it gets removed under the same principle. If no,
  the plan doc should be updated to reflect the new contract.
- The runner-author skill (`/Users/martinsumera/.claude/skills/runner-author`
  in the global config, plus any in-repo equivalent) currently teaches
  new-runner authors to define an env allowlist. Update that to
  "passthrough + project-specific carve-outs."
- CLAUDE.md mentions env stripping in passing; should be reviewed for
  consistency with the new rule.
- `TMUX` / `TMUX_PANE` in the outer env: the existing `assertNoNestedTmux`
  guard already errors fast when orch is launched from inside tmux. So
  letting `TMUX` flow through the server env is safe in practice — the
  guard fires before the server is ever created.
- Is there any test or downstream consumer that relies on
  `respawnPane`'s capture shape in `FakeTmuxService`? Adding `env` to the
  capture changes the shape.

## Next Steps

→ `/workflows:plan` for the implementation details — file-by-file changes,
test rewrites, doc updates, verification steps.
