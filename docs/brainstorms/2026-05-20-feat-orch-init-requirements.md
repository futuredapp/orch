---
date: 2026-05-20
topic: orch-init
---

# `orch init` — Scaffold orch into Another Project

## Summary

Add two CLI commands — `orch init` and `orch new <workflow-name>` — that let a developer drop orch into any local TypeScript/Bun project (via `bun link`) and start authoring workflows immediately. `orch init` creates a self-contained `.orch/` directory with a minimal runnable hello-world; `orch new` scaffolds additional workflow files on demand.

---

## Problem Frame

Today orch only works inside its own repository. The workflows, the steps, and the CLI all live together in `claude-orchestration/`, and the only `.orch/` directory in existence is this repo's own runtime-state directory.

A developer who wants to *use* orch in one of their other local projects has no path forward. There is no documented layout for a host project, no scaffolding command, and no install story — they would have to manually create directories, copy boilerplate from this repo's source, and figure out import paths to a tool that isn't even published. The friction is high enough that orch effectively can't leave its own repo.

The friction is felt every time the developer thinks "I'd like to use orch for this other thing" and decides it isn't worth the setup. Orch's value compounds with the number of projects it can drive, but right now that number is one.

---

## Actors

- A1. **Host-project developer**: a person who has `bun link`-ed orch into a project and wants to author and run workflows. Same person who would also edit the workflow files.

---

## Key Flows

- F1. **First-time init in a clean project**
  - **Trigger:** Developer runs `orch init` in a project root that has no `.orch/` directory.
  - **Actors:** A1
  - **Steps:**
    1. orch verifies it is not running inside its own source repo (refuses if so).
    2. Creates `.orch/` with `workflows/hello.ts`, `steps.ts`, and an empty `state/` directory.
    3. Appends `.orch/state/` to the project's `.gitignore` (creates one if missing).
    4. Prints a "next steps" message: how to run the example (`orch run hello`) and how to add more workflows (`orch new <name>`).
  - **Outcome:** A runnable hello-world workflow exists; `orch run hello` writes `hello.txt` to the project root.
  - **Covered by:** R1, R2, R3, R4, R5, R6

- F2. **Re-init over an existing `.orch/`**
  - **Trigger:** Developer runs `orch init` in a project that already has `.orch/`.
  - **Actors:** A1
  - **Steps:**
    1. orch detects existing `.orch/` and prompts: "`.orch/` already exists. Replace it? [y/N]".
    2. If no → exits without changes.
    3. If yes → second prompt: "Keep your existing user workflows? [Y/n]".
    4. If "keep" → preserves `state/` and any workflow file other than `hello.ts`; rewrites only the originally-scaffolded files (`hello.ts`, `steps.ts`).
    5. If "don't keep" → deletes `.orch/` entirely and re-runs the first-time init flow.
  - **Outcome:** Either no change, a partial replace preserving user work, or a clean re-init.
  - **Covered by:** R7, R8, R9, AE1, AE2, AE3

- F3. **Scaffold a new workflow**
  - **Trigger:** Developer runs `orch new <name>` after init.
  - **Actors:** A1
  - **Steps:**
    1. orch verifies `.orch/` exists (errors with "run `orch init` first" if not).
    2. Validates `<name>` is a safe kebab-case identifier and `<name>.ts` does not already exist.
    3. Creates `.orch/workflows/<name>.ts` containing a blank workflow skeleton importing from orch and from `../steps.ts`.
    4. Prints "Created .orch/workflows/<name>.ts — run it with `orch run <name>`".
  - **Outcome:** A new workflow file is ready for the developer to fill in.
  - **Covered by:** R10, R11, R12

---

## Requirements

**Distribution and install**
- R1. orch is consumable in any local project via `bun link`. Setup steps documented in the project README: run `bun link` once inside `claude-orchestration/`, then `bun link orch` inside the host project. After that, `orch <command>` works in the host project. No npm publish step is required.
- R2. `orch init` and `orch new` refuse to run inside the orch source repo itself (detected by presence of the orch repo's own marker — e.g., this repo's `package.json` containing `"name": "orch"` AND a `src/cli/main.ts`). This prevents accidentally nesting `.orch/` inside the orch source tree during development.

**`orch init` — clean project**
- R3. When run in a project without `.orch/`, `orch init` creates the following structure:
  ```
  .orch/
  ├── workflows/
  │   └── hello.ts
  ├── steps.ts
  └── state/
  ```
- R4. The scaffolded `hello.ts` defines a single-step workflow that, when run, instructs a coding agent (default: Claude Code) to create a file named `hello.txt` containing the text "hello from orch" in the project root.
- R5. The scaffolded `steps.ts` exports the step used by `hello.ts` and is structured so the developer can add more reusable step definitions alongside it.
- R6. `orch init` appends `.orch/state/` (and only that line, idempotently) to the project's `.gitignore`. If `.gitignore` does not exist, it is created with that single line. Other `.orch/` contents — `workflows/`, `steps.ts` — are intentionally meant to be committed.

**`orch init` — existing `.orch/`**
- R7. When `.orch/` already exists, `orch init` interactively prompts: "`.orch/` already exists. Replace it? [y/N]". Default is no. If the user declines, `orch init` exits with code 0 and no changes.
- R8. If the user confirms the first prompt, `orch init` then asks: "Keep your existing user workflows? [Y/n]". Default is yes.
  - "Keep" mode preserves `.orch/state/` and any file under `.orch/workflows/` other than `hello.ts`. It overwrites only the originally-scaffolded files: `.orch/workflows/hello.ts` and `.orch/steps.ts`.
  - "Don't keep" mode deletes `.orch/` entirely and recreates it as if running a first-time init.
- R9. In a non-TTY / non-interactive environment (CI, piped stdin, `--noninteractive` flag), `orch init` refuses to touch an existing `.orch/` and exits with a non-zero code and a clear error message instructing the user to remove `.orch/` manually or run interactively. No destructive default behavior.

**`orch new <name>`**
- R10. `orch new <name>` requires an existing `.orch/`. If none exists, it errors with a clear message: "No .orch/ found. Run `orch init` first."
- R11. `<name>` must match `^[a-z][a-z0-9-]*$` (kebab-case, lowercase ASCII, must start with a letter). Invalid names produce a clear validation error and exit non-zero.
- R12. If `.orch/workflows/<name>.ts` already exists, `orch new` refuses to overwrite and exits non-zero with the conflicting path in the message. No prompt — this command is non-destructive by design.

**General CLI ergonomics**
- R13. Both `orch init` and `orch new` print a one-line "next step" hint on success so the developer knows what to do immediately after.
- R14. Both commands follow the project's existing CLI command pattern (live alongside `run.ts`, `resume.ts`, etc., wired in `src/cli/main.ts`).

---

## Acceptance Examples

- AE1. **Covers R7.** Given `.orch/` already exists with `workflows/hello.ts`, `workflows/my-real-workflow.ts`, and `state/2026-05-15-001/`, when the developer runs `orch init` interactively and answers "n" to the replace prompt, then nothing on disk changes and the command exits 0.

- AE2. **Covers R7, R8.** Given the same state as AE1, when the developer answers "y" to replace and "y" (default) to "keep existing user workflows", then `.orch/state/` and `.orch/workflows/my-real-workflow.ts` are preserved unchanged, and `.orch/workflows/hello.ts` and `.orch/steps.ts` are rewritten to their scaffolded versions.

- AE3. **Covers R8.** Given the same state as AE1, when the developer answers "y" to replace and "n" to "keep existing user workflows", then the entire `.orch/` directory is deleted and recreated as a fresh init — `my-real-workflow.ts` and prior run state are gone.

- AE4. **Covers R9.** Given `.orch/` already exists and the developer runs `orch init` with stdin piped from `/dev/null` (or `--noninteractive`), then orch exits non-zero with an error message and makes no changes.

- AE5. **Covers R4.** Given a freshly initialized project, when the developer runs `orch run hello`, then a `hello.txt` file appears at the project root containing the text "hello from orch".

- AE6. **Covers R11.** When the developer runs `orch new My_Workflow` or `orch new 1st-flow`, then orch exits non-zero with a name-validation error and does not create any file.

- AE7. **Covers R12.** Given `.orch/workflows/build.ts` already exists, when the developer runs `orch new build`, then orch exits non-zero and the existing file is unchanged.

---

## Success Criteria

- The developer can go from `bun link orch` in a fresh project to a successful `orch run hello` (producing `hello.txt`) in under five minutes, without consulting source code.
- A second project on the same machine can be initialized independently; the two `.orch/` directories do not interfere with each other.
- Re-running `orch init` is never destructive without an explicit interactive confirmation.
- A downstream implementer (or `ce-plan`) can read this document and produce a working implementation without needing to invent the replace-flow semantics, the scaffolded file shape, or the non-interactive behavior.

---

## Scope Boundaries

- **Not in scope: npm publishing.** `bunx orch init` is explicitly out — install is `bun link` only. Publishing is a separate later effort, not part of this work.
- **Not in scope: agent CLI detection.** Init assumes Claude Code is installed; it does not check, prompt, or configure runners. If Claude is missing, the hello workflow fails at run time with whatever error the runner emits.
- **Not in scope: multiple starter templates.** Exactly one template (the hello-world). No `--template` flag, no template registry.
- **Not in scope: cross-package-manager support.** Bun only. npm/pnpm/yarn host projects are not a target.
- **Not in scope: post-init verification.** No `orch doctor`, no smoke-test step inside `init`.
- **Not in scope: a config file.** No `.orch/config.ts` in this iteration. If runtime configuration is needed later, it can be added without changing init's scaffolded surface.
- **Not in scope: scaffolding individual *steps***. `orch new` only creates workflow files; the developer edits `steps.ts` by hand.

---

## Key Decisions

- **Workflows live inside `.orch/`, not at project root.** Chosen for self-containment: a single directory holds everything orch-related, easy to gitignore-or-commit as a unit, no collision with the host project's own source. Departs from the layout sketched in `docs/getting-started.md` — that doc was a "decision review, not built yet" draft and is overridden by this decision.
- **`bun link` only; no npm publish.** Keeps the work narrow and unblocks the developer's immediate need (use orch in their own local projects). npm publishing is a real, separate effort (rename, un-private, version, build, docs) and conflating it with init would balloon scope.
- **Replace flow is a two-prompt opt-in.** A single "destroy everything?" prompt would lose user workflow files unnecessarily; silently merging would be confusing. Two prompts give the user the choice they actually want — protect work, or start clean — without a complex 3-way menu.
- **Init scaffolds a hello-world that uses a real runner, not a no-op.** The hello workflow doubles as a smoke test that the developer's Claude Code install actually works, surfacing setup problems immediately rather than at first real use.
- **`orch new` does not overwrite.** Keeps that command non-destructive and prompt-free, so it's safe to script. The destructive prompts live only in `init`.
- **Non-interactive behavior is "refuse, don't default."** CI and piped contexts can't safely answer the replace prompt, and silently choosing either branch could destroy work or block a fresh setup. Explicit error with remediation is the only safe default.

---

## Dependencies / Assumptions

- **Bun is installed in the host project.** Orch ships as a Bun TypeScript project; host projects need a Bun toolchain.
- **Claude Code CLI is installed and authenticated on the developer's machine.** The hello workflow targets `ClaudeRunner` by default; if Claude isn't available, `orch run hello` will fail. Detection and remediation are explicitly out of scope.
- **`bun link` is available.** The install story depends on Bun's link command; no other registry is used.
- **Host project has a writable working directory.** Standard filesystem assumption; init writes to `.gitignore` and creates files.
- **The `Workflow` and `step.define` primitives importable from orch's barrel are stable enough that the scaffolded files won't immediately break on orch updates.** This isn't guaranteed today (orch is pre-1.0); breakage is acceptable for now since the same developer maintains both sides.
