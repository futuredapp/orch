---
date: 2026-04-14
topic: workflow-cli-args
---

# Workflow CLI Args (initial prompt pass-through)

## What We're Building

A way to pass arguments — primarily an initial prompt — from the command line into a workflow, so the first interactive Claude step can open with the prompt already typed in. Instead of:

```
$ orch run brainstorm
<wait for Claude TUI to boot>
<type prompt>
```

The user types it in one go:

```
$ orch run brainstorm "think hard about X and brainstorm it"
```

The workflow author decides how to use that prompt — typically by splicing it into a step's prompt template:

```ts
workflow('brainstorm', async (run, args) => {
  const BRAINSTORM = step.define('brainstorm', {
    agent: claude(),
    mode: 'interactive',
    prompt: `Think hard about this and brainstorm the idea:\n\n${args.prompt ?? ''}`,
  })
  await run(BRAINSTORM)
})
```

## Why This Approach

The runner-level plumbing is **already in place**. `ClaudeRunner.buildCommand` in interactive mode passes the prompt as a positional after `--` to the `claude` CLI, which pre-fills the TUI. `RunOverrides.prompt` and `assemblePrompt()` already exist. What's missing is only two seams:

1. **CLI parsing** — `src/cli/main.ts` (`parseArgv` / `runCmd`) ignores everything after the workflow name.
2. **Workflow function signature** — `workflow(name, fn)` gives `fn` only `run`; there's no way for the workflow to see CLI args.

We bridge those two. The runner, execution, and interactive-mode code stay untouched.

## Key Decisions

- **CLI shape: positional preferred, `--prompt` flag as alias.** `orch run <wf> "text"` is the fastest path; `orch run <wf> --prompt "text"` is the explicit form. Both resolve to the same `args.prompt`.
- **Args delivered as a second parameter to the workflow callback.** `workflow(name, async (run, args) => ...)`. Typed, discoverable from the function signature, and extensible (can add `args.topic`, `args.scope` later without breaking callers).
- **Workflow author owns the splice.** The CLI prompt does **not** auto-override any step's `prompt`. Workflows reference `args.prompt` wherever they want (template interpolation, conditional branching, skipping steps). This is more flexible than the existing `RunOverrides.prompt` override.
- **`args.prompt` is `string | undefined`.** If the user omits the prompt, the workflow gets `undefined` and chooses how to handle it (default, error, skip step).
- **Only the first interactive step "benefits" by convention.** Nothing forces this — it's just how workflows will typically use the value. No special first-step detection logic in the core.
- **Initial scope: one reserved key, `prompt`.** Don't generalize to arbitrary named args yet. YAGNI — add `--key=value` parsing later if a real use case appears.

## Open Questions (for /workflows:plan)

- Should `examples/riddle-solver` and `examples/hello-file` be updated to demo the new signature, or left on the old one-param form (keep backward compat)?
- Backward compatibility for `workflow(name, async (run) => ...)` — TypeScript overloads so the second param is optional without breaking existing callers?
- Does `orch dry-run` accept the prompt arg too, and if so, does it just echo what would be passed?
- Where does the arg-parsing live — extend the existing `parseArgv` in `src/cli/main.ts`, or factor a small helper? (Probably the former; it's already `Node.util.parseArgs`-based.)
- How is the prompt surfaced in run state / logs? Redact, truncate, or store as-is for resume?

## Next Steps

→ `/workflows:plan` for implementation details (CLI parser changes, `workflow()` signature overload, tests, docs update).
