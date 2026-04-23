---
date: 2026-04-17
topic: agent-runner-redesign
---

# Agent runner redesign — `cli()` primitive + `.override()`

## What We're Building

A cleaner split of today's `Runner` abstraction into **two layers plus a composition operator**, without rewriting the existing Claude and Codex adapters.

1. **`cli()` primitive** — a brand-new ~80-LOC `Runner` factory that launches any CLI with argv + env. No NDJSON parsing. In autonomous mode it emits a synthetic terminal event on exit (exit 0 → `turn-complete`, non-zero → `error`) and captures stdout as the structured output. Works in interactive mode via the existing `runInteractive` path. Enough to wrap a lint script, a slugifier, a documentation generator, or `claude` itself as a pass-through.
2. **Specialized wrappers** — `claude()` and `codex()` stay exactly as they are today. Their env allowlists, flag denylists, Zod schemas, version preflight, and argv builders continue to ship battle-tested behavior. They live alongside `cli()`, not on top of it.
3. **`.override()`** — a uniform composition method attached by `defineRunner()` to every runner (cli, claude, codex, and user-defined). Re-invokes the factory with merged options. Flags/args append by default; an explicit `flags: { replace: [...] }` form fully replaces. Env shallow-merges with derived winning. Start with agents as plain TS values (workflows import from a `agents.ts` module); leave a seam for `orch.config.ts` to name them later without breaking callers.

What this unlocks concretely: `examples/compound/index.ts`'s hand-rolled `claudeFor(sessionName)` helper collapses into `baseClaude.override({ flags: ['--name', sessionName] })`. Writing an aider or amp adapter becomes a ~30-line file instead of a ~300-line one.

## Why This Approach

**Add-alongside, not refactor.** `claude()` and `codex()` together encode a lot of hard-won knowledge — the "success + is_error" Claude edge case, the Codex 0.118.0 version preflight, two distinct env allowlists, two flag denylists, structured-output extraction shaped to each CLI's event model. Rewriting those on a shared `cli()` base (Approach 2 in the brainstorm) risks subtle regressions for little near-term gain. The add-alongside path delivers everything the user asked for — the bare primitive, the override operator, the "just `cli('claude')` runs claude" story — while touching zero lines of code that parse NDJSON from a real CLI.

**Why two layers beats one.** Today every new runner means rewriting four methods from scratch. A bare `cli()` lets 90% of potential adapters (anything that returns its answer on stdout) be written in ~30 lines, and lets the existing smart adapters stay smart where it matters.

**Why `.override()` beats ad-hoc factories.** Today callers write their own merge helpers (`claudeFor`). That pattern is duplicated across every workflow and makes global defaults impossible. `.override()` centralizes the merge rules, makes derived agents inspectable, and scales to the future named-agent registry without rework.

## Key Decisions

- **Two-layer shape, both live in `src/runners/`.** `cli/cli-runner.ts` is new. `claude/` and `codex/` stay untouched. The `Runner` port in `types.ts` is unchanged in shape; `defineRunner()` gains the `.override()` attachment.
- **Bare `cli()` captures stdout as structured output.** Success on exit 0 returns stdout as a string; non-zero exits become terminal `error` events. This makes `cli()` genuinely useful for autonomous steps (slugify, linters, tool scripts) — not interactive-only.
- **`.override()` appends flags/args by default; explicit replace via structured form.** Env shallow-merges with derived winning. Append is the common case ("I want my base plus one more flag"); explicit `{ replace: [...] }` covers the rare case without surprising anyone.
- **Agents are plain TS values first; named-in-config later.** Workflows import from a shared module (e.g. `workflows/agents.ts`). `orch.config.ts` agent registration is deliberately deferred to a later phase — this lets us validate override ergonomics in isolation and avoids coupling this change to the in-flight reframe.
- **`defineRunner()` is the seam for `.override()`.** Every runner created via `defineRunner()` (including user-defined ones) gets `.override()` for free. Internal detail: `defineRunner()` stashes the original factory + opts and exposes `.override(next)` that re-invokes the factory with merged opts. Keeps overrides inspectable and idempotent.
- **Flag denylists survive overrides.** A derived agent cannot weaken its parent's denylist — the denylist is a property of the wrapper (`claude()` / `codex()`), not of the options bag. `base.override({ flags: ['--mcp-config', 'evil.json'] })` still throws.

## Open Questions

- **Does `cli()` gain a pluggable event parser later, or do specialized runners stay the only way to get NDJSON?** Likely the former (an optional `parseEvents` on `cli()`'s option bag), but not in v1 — want to see one real user-authored adapter first.
- **`.override()` return type — does TypeScript preserve the concrete factory type (`ReturnType<typeof claude>`) through the override?** Yes in principle via generics on `defineRunner`; worth nailing in the plan so IDE autocomplete keeps working after two chained overrides.
- **Does the compound example get migrated in the same PR, or in a follow-up?** Migrating it is the best end-to-end proof the ergonomics work, but couples this PR to a behavioral example test. Probably same PR; decide in plan.
- **What about multi-arg overrides like model + maxTurns?** Today those are first-class `ClaudeOptions` keys, not `flags`. The merge rules above cover `flags`/`args`/`env`; we should spell out that named options like `model` simply overwrite (last-write-wins) because "append a model" is meaningless.
- **Naming — `.override()` vs `.extend()` vs `.with()`?** `override` matches the user's own phrasing but implies "replace"; `extend` matches the append-default behavior better. Small bikeshed for the plan.
- **Bare `cli()` interactive vs autonomous mode inference.** Does `cli({ command: 'claude' })` used in an autonomous step produce useful output? For `claude` specifically, no — without `-p` it opens a TUI. Do we detect this, warn, or trust the caller? Probably trust + document.

## Next Steps

→ `/workflows:plan` to turn this into a phased implementation plan. Suggested shape:

1. **`cli()` primitive + unit tests** — argv/env assembly, stdout-capture structured output, exit-code terminal events. No change to claude/codex.
2. **`.override()` on `defineRunner()`** — merge rules (append flags, replace via `{replace}`, env shallow-merge), type-preserving factory plumbing, denylist preservation tests. Attached to all existing runners automatically.
3. **Migrate `examples/compound/` to use `.override()`** — end-to-end proof; `claudeFor` helper deleted; integration test updated.
4. **(Deferred) Named agents in `orch.config.ts`** — couples to the reframe's config work; not in scope here.
