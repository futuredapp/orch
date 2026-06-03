# Built-in workflows reference

> **What you'll learn:** the exact set of packaged `orch::` workflows, how the `orch::` name resolves, and the rules governing their input and behavior.

orch ships a fixed set of **built-in** workflows that run without a `.orch/workflows/` file or an `orch.config.ts` entry. They are invoked by an `orch::` prefix and run in place from orch's own source — read-only, never copied into your project. For the narrative walkthrough, see the [Built-in workflows guide](/guides/built-in-workflows).

## Variants

| Name | Runner | Posture |
| --- | --- | --- |
| `orch::work-cc` | [`claude`](/reference/runners#claude) | `bare: false`, `--dangerously-skip-permissions` — implements unattended without per-action prompts. |
| `orch::work-codex` | [`codex`](/reference/runners#codex) | `sandbox: 'full-auto'` — workspace write with auto-approval (Codex's unattended-write posture; there is no skip-permissions flag). |

Both are the same phased-build pipeline parameterized by runner; only the bound agent differs.

## Invocation

```bash
orch run orch::work-cc <plan-file-or-description>
orch run orch::work-codex <plan-file-or-description>
```

- The `orch::` prefix bypasses your `orch.config.ts` `workflows` map entirely and resolves the name against orch's source tree. A name **without** the prefix resolves through your config exactly as before.
- An unknown built-in name (e.g. `orch::nope`) errors and lists the available built-ins.
- A `.orch/` must exist in the project (run [`orch init`](/reference/cli)); a missing one surfaces the same config error as any other run.

## Input resolution

The single positional argument becomes the plan text:

| Argument | Treated as |
| --- | --- |
| Path to an existing, readable file | The file's contents (the plan). |
| Anything else (inline text, missing path, a directory) | The argument string itself (an inline description). |

Relative paths resolve against the run's working directory (the active worktree if one is entered, otherwise the project directory). An empty or missing argument is a usage error before any agent runs.

## Behavior

1. **Decide phases** — an interactive `autoStop` agent step decides a **1–4 phase** breakdown (biased toward fewer; >4 is allowed for exceptional complexity but warned, never truncated) and writes it to `.orch/phased-build-phases.md`.
2. **Parse + validate** — orch reads that artifact back and parses it into an ordered phase list. The run **halts with a clear error** if the artifact is empty or has no well-formed phase (each phase requires a non-empty title; a description is optional). The artifact is emptied before the decide step, so a decide that writes nothing halts here instead of reusing a previous run's phases.
3. **Implement loop** — one interactive `autoStop` step per phase implements that phase only. Each phase records a status sentinel; a missing or non-success status **halts the run before the next phase**.

## Constraints

- **Implement-only.** No commits and no project validation (tests/typecheck) are ever run — you own both.
- **Read-only / run-in-place.** There is no eject or edit step; to customize, author your own workflow ([Writing a workflow](/guide/4-writing-a-workflow)).
- **Every agent step is interactive + `autoStop`.** There is no autonomous agent step; runs complete with no per-phase keystrokes.

## Where to go next

- [Built-in workflows guide](/guides/built-in-workflows) — the walkthrough with examples.
- [CLI reference](/reference/cli) — `orch run` and every other command.
- [Runners](/reference/runners) — the `claude` and `codex` options the variants bind.
