---
status: done
priority: p1
issue_id: "003"
tags: [code-review, security]
dependencies: []
---

# ctx.extraArgs and ClaudeOptions.flags allow CLI flag injection

## Problem Statement

`src/runners/claude/claude-runner.ts:165-166` — `...ctx.extraArgs` and `...(flags ?? [])` are spread directly into the command argv with no validation. While `Bun.spawn` uses an argv array (preventing shell injection), an attacker can inject dangerous Claude CLI flags like `--allowedTools`, `--mcp-config`, or `--dangerously-skip-permissions`.

**Why it matters:** A compromised upstream step can escalate the agent's permissions by injecting `extraArgs: ['--dangerously-skip-permissions']`.

## Findings

- Flagged by: Security Sentinel (P1-3, P3-1)
- Line 165: `...(flags ?? [])` — author-controlled, lower risk
- Line 166: `...ctx.extraArgs` — potentially untrusted input, higher risk

## Proposed Solutions

### Option A: Denylist dangerous flags (Recommended)
- Reject `--allowedTools`, `--mcp-config`, `--dangerously-skip-permissions`, `--permission-prompt-tool`, `--settings` from both flags and extraArgs
- **Effort:** Small
- **Risk:** Low — denylist may need updates as Claude CLI evolves

### Option B: Allowlist permitted flags
- Only permit known-safe flags
- **Effort:** Medium — requires maintaining a comprehensive list
- **Risk:** May block legitimate use cases

## Acceptance Criteria

- [ ] `extraArgs: ['--dangerously-skip-permissions']` throws or is filtered
- [ ] `flags: ['--mcp-config', '/tmp/evil.json']` throws or is filtered
- [ ] Legitimate flags like `['--max-turns', '5']` still work

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-04-11 | Created from code review | |
| 2026-04-11 | G3: added CLAUDE_FLAG_DENYLIST with prefix-match guard in buildCommand | Denies --dangerously-skip-permissions, --settings, --mcp-config |
| 2026-04-14 | Policy change: removed --dangerously-skip-permissions from the denylist so sandboxed workflows (see `examples/compound`) can opt into unattended runs. --settings and --mcp-config stay denied as genuine config-injection vectors. | Permission bypass is now surfaced as a normal flag, not a secret denylist. |
