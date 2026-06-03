# Built-in workflows

> **What you'll learn:** how to run orch's packaged `orch::` workflows — a phased build driven by Claude or Codex — without authoring or registering a workflow of your own.

Every workflow you've seen so far lives in your project: you write it under `.orch/workflows/` and register it in `orch.config.ts`. orch also ships a small fixed set of **built-in** workflows you can run straight away, with no file to write and no config entry. They run in place from orch's own source — you cannot edit them, and nothing is copied into your project.

There are two today, and they do the same thing with a different agent:

- **`orch::work-cc`** — drives the build with [Claude Code](/reference/runners#claude).
- **`orch::work-codex`** — drives the build with [Codex](/reference/runners#codex).

## Run one

Built-ins use an `orch::` prefix on the name. Everything else about `orch run` is unchanged — pass your input as the inline prompt:

```bash
# Point it at a plan file…
orch run orch::work-cc docs/plans/add-csv-export.md

# …or describe the work inline.
orch run orch::work-codex "add a CSV exporter to the report module"
```

The argument is resolved one of two ways:

- If it names an **existing file**, that file's contents become the plan.
- Otherwise the argument **is** the plan — a short inline description.

You still need a `.orch/` in the project (run [`orch init`](/reference/cli) once) — built-ins reuse it for run state and [mode resolution](/guide/5-running-workflows#choosing-how-it-renders), exactly like any other run.

## What it does

Both variants run the same three-stage phased build:

1. **Decide the phases.** An [interactive, auto-stopping](/guides/interactive-steps#keep-an-interactive-step-from-stalling-a-pipeline) agent step reads your plan, decides a breakdown of **1–4 phases** (biased toward fewer), and writes it to `.orch/phased-build-phases.md`. The pane closes on its own when the agent finishes — no keystroke from you.
2. **Read the phases back.** orch parses that file into an ordered phase list. If the agent wrote nothing parseable, the run **halts** here with a clear error rather than guessing.
3. **Implement each phase.** One interactive, auto-stopping step per phase implements *that phase only*. After each phase the agent records a status; if it reports anything other than success, the run **halts before the next phase** instead of compounding a broken phase.

The whole run is unattended: once you start it, no per-phase keystrokes are needed. If a phase cut looks wrong, stop the run (Ctrl-C) and start over with a sharper plan.

## What it deliberately doesn't do

Built-ins implement; **you** own the rest:

- **No commits.** The agent never runs `git commit` — review and commit the work yourself.
- **No tests or validation.** orch can't know your project's test or typecheck commands, so a phase never runs them. Verify between or after phases as you see fit.
- **No editing the built-in.** There is no "eject" step this iteration; `orch::` workflows are read-only and run from orch's source.

## Choosing a variant

Pick the agent you want at the wheel — `orch::work-cc` for Claude, `orch::work-codex` for Codex. The phase logic is identical; only the runner differs. If you want a fully custom pipeline (your own steps, commits, gates), author a workflow instead — start with [Writing a workflow](/guide/4-writing-a-workflow).

## Where to go next

- [Built-ins reference](/reference/built-ins) — the exact variants, input rules, and behavior.
- [Running workflows](/guide/5-running-workflows) — modes, resume, and inspecting a run.
- [Interactive steps](/guides/interactive-steps) — the `autoStop` mechanism the built-ins are built on.
