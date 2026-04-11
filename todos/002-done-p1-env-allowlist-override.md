---
status: done
priority: p1
issue_id: "002"
tags: [code-review, security]
dependencies: []
---

# ctx.env overrides env allowlist + process.env hidden dependency

## Problem Statement

`src/runners/claude/claude-runner.ts:77-89` — `buildClaudeEnv` carefully constructs an allowlisted environment, then `{ ...base, ...ctxEnv }` spreads user-supplied context env on top. A caller can inject arbitrary environment variables (e.g., `LD_PRELOAD`, `NODE_OPTIONS`) into the subprocess. Additionally, the function reads `process.env` directly, creating a hidden ambient dependency that makes testing non-deterministic.

**Why it matters:** A compromised upstream step (or malicious workflow author) setting `NODE_OPTIONS=--require=/tmp/evil.js` would cause the spawned Claude CLI to load arbitrary code.

## Findings

- Flagged by: Security Sentinel (P1-2), Architecture Strategist (P2), TypeScript Reviewer (P2-8)
- Line 88: `return { ...base, ...ctxEnv }` — ctxEnv overrides the allowlist
- Lines 80-85: `process.env` read directly inside the runner adapter

## Proposed Solutions

### Option A: Validate ctxEnv keys against allowlist (Recommended)
- Filter `ctxEnv` to only keys in allowlist or `ANTHROPIC_`/`CLAUDE_` prefixes
- Log/warn on rejected keys
- Accept `hostEnv` parameter (default `process.env`) for testability
- **Effort:** Small
- **Risk:** Low

### Option B: Merge ctxEnv first, then allowlist-filter the result
- Reverse the merge order so allowlist always wins
- **Effort:** Small
- **Risk:** May break legitimate ANTHROPIC_ overrides from ctx

## Acceptance Criteria

- [ ] `buildClaudeEnv({ NODE_OPTIONS: 'evil' })` does NOT include NODE_OPTIONS in result
- [ ] `buildClaudeEnv({ ANTHROPIC_API_KEY: 'sk-...' })` DOES include the key
- [ ] `buildClaudeEnv` accepts optional `hostEnv` parameter for testing
- [ ] No direct `process.env` access inside runner adapter

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-04-11 | Created from code review | 3 agents flagged independently |
| 2026-04-11 | G3: flipped spread order so allowlist wins; injected processEnv for testability | Same-turn-complete non-zero exit was actually the twin #019 finding |
