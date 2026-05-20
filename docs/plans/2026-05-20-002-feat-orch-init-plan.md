---
date: 2026-05-20
status: active
type: feat
topic: orch-init
origin: docs/brainstorms/2026-05-20-feat-orch-init-requirements.md
---

# `orch init` and `orch new` — Scaffold orch into Another Project

## Summary

Add two CLI commands — `orch init` and `orch new <workflow-name>` — that let a developer drop orch into any local Bun/TypeScript project via `bun link` and start authoring workflows immediately. `orch init` creates a self-contained `.orch/` directory containing a workflow manifest (`orch.config.ts`), a runnable `hello.ts` workflow, a `steps.ts` step library, and an empty `state/` directory; it also appends `.orch/state/` to `.gitignore`. `orch new <name>` scaffolds additional workflow files on demand and appends them to the manifest.

Both commands are self-contained — they do not load `orch.config.ts`, do not pick a run host, and bypass the `[orch] mode=...` banner that other commands print before dispatch.

---

## Problem Frame

Today orch only works inside its own repository. There is no documented layout for a host project, no scaffolding command, and no install story. A developer who wants to use orch in another local project has to copy boilerplate from this repo, invent file layouts, and figure out import paths — friction high enough that orch effectively can't leave its own repo (see origin: `docs/brainstorms/2026-05-20-feat-orch-init-requirements.md`).

This work makes "`bun link orch` → `orch init` → `orch run hello`" a five-minute happy path in any fresh Bun project.

---

## Requirements Traceability

Actors and flows are carried verbatim from the origin document:

- **A1**: Host-project developer who has `bun link`-ed orch and wants to author and run workflows.
- **F1**: First-time init in a clean project → U5.
- **F2**: Re-init over an existing `.orch/` (two-prompt opt-in) → U6.
- **F3**: Scaffold a new workflow with `orch new` → U7.

Requirements map to implementation units:

| Req | Topic | Units |
|-----|-------|-------|
| R1 | `bun link` install path | U10 (docs) |
| R2 | Refuse to run inside orch source repo | U3, U5, U7 |
| R3 | Clean-project directory structure | U4, U5 |
| R4 | Scaffolded `hello.ts` writes `hello.txt` via Claude | U4 |
| R5 | Scaffolded `steps.ts` shape | U4 |
| R6 | `.gitignore` append `.orch/state/` (idempotent) | U4, U5 |
| R7 | Existing-`.orch/` first prompt + decline path | U2, U6 |
| R8 | Second prompt: keep vs. don't-keep user workflows | U2, U6 |
| R9 | Non-interactive refusal when `.orch/` exists | U6 |
| R10 | `orch new` requires `.orch/` | U7 |
| R11 | Kebab-case name validation | U7 |
| R12 | `orch new` does not overwrite | U7 |
| R13 | "Next step" hint on success | U5, U7 |
| R14 | Follow existing CLI command pattern | U1 |

Acceptance examples map to test scenarios:

| AE | Covers | Scenario lives in |
|----|--------|-------------------|
| AE1 | R7 — decline replace, exit 0, no changes | U6 |
| AE2 | R7, R8 — keep mode preserves user workflows + state | U6 |
| AE3 | R8 — don't-keep mode wipes and re-inits | U6 |
| AE4 | R9 — non-interactive refusal with existing `.orch/` | U6 |
| AE5 | R4 — `orch run hello` produces `hello.txt` | U8 (preflight) + manual smoke |
| AE6 | R11 — invalid names rejected | U7 |
| AE7 | R12 — existing workflow file not overwritten | U7 |

---

## Scope Boundaries

Carried verbatim from origin:

- **Not in scope: npm publishing.** Install is `bun link` only. Publishing is a separate later effort.
- **Not in scope: agent CLI detection.** Init assumes Claude Code is installed; no probe.
- **Not in scope: multiple starter templates.** Exactly one template (hello-world). No `--template` flag.
- **Not in scope: cross-package-manager support.** Bun only.
- **Not in scope: post-init verification.** No `orch doctor`, no smoke-test inside `init`.
- **Not in scope: scaffolding individual *steps*.** `orch new` only creates workflow files.

### Reinterpreted from origin

- **"No config file" → no runtime `.orch/config.ts`.** The origin doc excluded "a config file" from scope. After research, `loadWorkflow` requires `orch.config.ts` (a workflow-name → file manifest) to resolve workflow names. Without it, `orch run hello` would fail right after `orch init` — breaking the origin's success criterion. The exclusion is therefore interpreted to mean **no runtime `.orch/config.ts`** (an orchestrator-behavior config, which truly isn't needed in this iteration); the **workflow manifest** `.orch/orch.config.ts` is mechanically required and is scaffolded by `init` and appended-to by `orch new`. See Key Technical Decisions.

### Deferred to Follow-Up Work

- Convention-based workflow discovery (`.orch/workflows/<name>.ts` resolved without a manifest entry). Considered as an alternative; would let `orch new` skip touching the manifest. Deferred because the manifest is already required by `loadWorkflow`, and a single source of truth simplifies the first iteration.
- npm publish story: rename package, un-private, version, build/no-build choice, README polish.
- `orch doctor` — preflight runner detection and remediation hints.

(A runtime `.orch/config.ts` for orchestrator behavior is already excluded by origin scope above; not re-listed here.)

---

## Key Technical Decisions

- **Scaffold a workflow manifest at `.orch/orch.config.ts`.** Smallest behavior change vs. teaching `loadConfig` to convention-discover. The manifest is inspectable, version-controlled, and already supported by `findConfigPath` (`src/config/index.ts:80`). `orch new` appends to the `workflows` map. The brainstorm's "no config" decision is interpreted as "no runtime config" — see Scope Boundaries reinterpretation.
- **Both commands bypass mode resolution and the `[orch] mode=...` banner.** `init` and `new` don't run workflows and don't depend on the host registry. Refactor `main()` so commands can opt out of `resolveMode()` + `buildBanner()`. Keeps init output focused on what was scaffolded.
- **Add a focused `ConfirmService` port; do not reuse `PromptService`.** `PromptService.ask()` is heavyweight — it carries `StepName`, a `Host`, and a `fields[]/buttons[]` model designed for `ask()` workflow steps. A yes/no confirmation has none of that context. A new minimal port `ConfirmService.confirm(question, default)` with `ReadlineConfirmService` (real) and `FakeConfirmService` (test) keeps the seam clean and CLAUDE.md-aligned.
- **Self-detection guard checks `process.cwd()`, not `import.meta.dir`.** `bun link` symlinks orch into the host project; `import.meta.dir` resolves into the orch source tree, but `process.cwd()` resolves to where the user invoked `orch`. Guard at exactly `cwd` (not a walk): read `<cwd>/package.json`, check `name === "orch"`, AND check `<cwd>/src/cli/main.ts` exists.
- **Non-interactive resolution reuses the existing `--noninteractive` flag and `ORCH_NONINTERACTIVE=1` env var.** Already parsed into `opts.interactivity` (`src/cli/main.ts:225-237`). R9 refusal triggers when `opts.interactivity === 'noninteractive'` OR `process.stdin.isTTY` is falsy. No new flag.
- **All filesystem writes go through `deps.fsService` (the existing `FsService` port).** Tests inject `FakeFsService` per CLAUDE.md rule #3. Path construction uses the `path()` smart constructor; no raw strings cross the seam.
- **Templates are exported string constants in a single file (`init-templates.ts`).** Plain string constants — not template files on disk. Keeps the scaffolder self-contained, easy to test exact contents, and avoids the question of how to bundle template assets through `bun link`.
- **`orch new` only edits the workflows map in `.orch/orch.config.ts` via simple text insertion.** Reading + parsing + re-serializing an arbitrary user-edited TypeScript file is out of scope; instead, the scaffolded `orch.config.ts` has a stable, predictable shape and `orch new` inserts a new line into the `workflows: { ... }` block via regex + string concat. If the user has edited the file in a way that breaks the regex, `orch new` errors with a clear message asking them to add the entry manually.

---

## High-Level Technical Design

*This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Command dispatch shape (after the refactor)

```
main()
  ├── parseArgv(argv)
  ├── if command in CONFIG_FREE_COMMANDS (init, new):
  │     deps = createDeps(cwd)
  │     opts = makeMinimalOpts(parsed)            // no mode, no host
  │     code = handler(deps, positional, args, opts)  // no hostFactory, no banner
  │     exit(code)
  └── else:
        deps = createDeps(cwd)
        resolution = await resolveMode(...)        // existing behavior
        write banner unless json
        opts = full CliOpts
        hostFactory = pickHostFactory(...)
        code = handler(deps, positional, args, opts, hostFactory)
        exit(code)
```

### Init clean-project flow (F1)

```
initCmd(deps, _, _, opts):
  1. assertNotInsideOrchRepo(deps, deps.cwd) → exit 2 on hit
  2. orchDir = <cwd>/.orch
     if fsService.exists(orchDir): → re-init branch (F2, see below)
  3. write file tree:
        .orch/orch.config.ts      (manifest with { hello: 'workflows/hello.ts' })
        .orch/workflows/hello.ts  (single-step workflow)
        .orch/steps.ts            (HELLO step + import surface)
        .orch/state/              (empty dir)
  4. appendGitignoreLine(<cwd>/.gitignore, '.orch/state/')
  5. write "next step" hint to stdout
  6. return EXIT.OK
```

### Re-init flow (F2)

```
reinit branch:
  1. if opts.interactivity === 'noninteractive' OR !stdin.isTTY: → exit 2 with R9 message
  2. confirm("`.orch/` already exists. Replace it?", default=false)
        → false: exit 0, no changes
        → true: continue
  3. confirm("Keep your existing user workflows?", default=true)
        → true (keep): preserve .orch/state/ + .orch/workflows/*.ts (except hello.ts),
                       rewrite .orch/workflows/hello.ts + .orch/steps.ts + .orch/orch.config.ts
                       (manifest reset to { hello: 'workflows/hello.ts' } + entries for preserved workflows)
        → false (don't keep): fsService.remove(.orch/), then F1 from step 3
  4. write "next step" hint, exit OK
```

### `orch new <name>` flow (F3)

```
newCmd(deps, name, _, opts):
  1. validate name against ^[a-z][a-z0-9-]*$ → exit 2 on miss
  2. assertOrchDirExists(deps, deps.cwd) → exit 2 with "Run `orch init` first."
  3. workflowPath = .orch/workflows/<name>.ts
     if fsService.exists(workflowPath): → exit 2 (R12)
  4. write workflow file (blank skeleton)
  5. append manifest entry to .orch/orch.config.ts via regex-insert
  6. print hint, exit OK
```

---

## Output Structure

Files added/modified by this plan, repo-relative:

```
src/
├── cli/
│   ├── main.ts                                    (modify: add init/new to COMMANDS, gate banner)
│   └── commands/
│       ├── init.ts                                (new)
│       ├── new.ts                                 (new)
│       ├── init-templates.ts                      (new: scaffolded file content)
│       ├── scaffold.ts                            (new: shared write helpers)
│       └── detect-self.ts                         (new: orch-source-repo guard)
└── services/
    └── prompt/
        ├── confirm-service.ts                     (new: ConfirmService port)
        ├── readline-confirm-service.ts            (new: real impl)
        ├── fake-confirm-service.ts                (new: test impl)
        └── index.ts                               (modify: barrel re-exports)
src/cli/deps.ts                                    (modify: add confirmService to CliDeps)

tests/
├── unit/
│   ├── cli/
│   │   ├── detect-self.test.ts                    (new)
│   │   └── commands/
│   │       ├── init-templates.test.ts             (new: template content sanity)
│   │       └── scaffold.test.ts                   (new: scaffold helpers)
│   └── services/
│       └── prompt/
│           └── confirm-service.test.ts            (new: ReadlineConfirmService TTY + answer parsing)
└── integration/
    └── cli/
        └── commands/
            ├── init.test.ts                       (new: F1 + F2 handler-level)
            ├── new.test.ts                        (new: F3 handler-level)
            └── init-e2e.test.ts                   (new: subprocess smoke)

docs/
├── getting-started.md                             (modify: update §3 layout, §"orch init" section, §15 CLI cheat sheet)
└── ...

README.md                                          (modify: add `bun link orch` install path)
```

The per-unit `**Files:**` sections below remain authoritative for what each unit creates or modifies.

---

## Implementation Units

### U1. Wire `init` and `new` into CLI dispatch; gate the mode banner

**Goal:** Add command stubs to `src/cli/main.ts` so `orch init` and `orch new` resolve to handlers, and refactor `main()` so config-free commands skip mode resolution and the `[orch] mode=...` banner.

**Requirements:** R14 (follow existing CLI pattern).

**Dependencies:** none.

**Files:**
- `src/cli/main.ts` (modify)
- `src/cli/commands/init.ts` (new, stub returning `EXIT.OK`)
- `src/cli/commands/new.ts` (new, stub returning `EXIT.OK`)
- `tests/integration/cli/main-dispatch.test.ts` (new or extend existing)

**Approach:**
- Add `init` and `new` to the `COMMANDS` table via `commandWithoutHost(...)`.
- Update `HELP` (`src/cli/main.ts:110-135`) to list both commands with one-line descriptions. Disambiguate `init` from `git init` / `npm init` in the description (e.g., "Scaffold a fresh `.orch/` in this project").
- Introduce a `CONFIG_FREE_COMMANDS = new Set(['init', 'new'])` constant near `COMMANDS`.
- In `main()`, after handler lookup and `createDeps(...)`, branch:
  - If `parsed.command` is in `CONFIG_FREE_COMMANDS`: build a minimal `CliOpts` (carrying only `format`, `debug`, `interactivity` — leave `mode: undefined`, `noAttach: false`, others defaulted), skip `resolveMode`, skip the banner block at lines 435-439, and dispatch with a placeholder `HostFactory` that throws on first call (sanity check — these commands must not touch it).
  - Otherwise: existing behavior.
- The placeholder `HostFactory` is preferable to optional-typing `hostFactory` across every handler signature. It's a small inline arrow function in `main.ts` that throws "init/new must not use HostFactory" if invoked; if a future bug makes init reach for it, the throw is loud rather than silent.
- Stub handlers return `EXIT.OK` so U2-U7 can flesh out behavior without breaking dispatch tests.

**Patterns to follow:**
- `src/cli/main.ts:355-371` for the `COMMANDS` table.
- `src/cli/commands/runs.ts:10-24` for the no-host command handler signature.

**Test scenarios:**
- `orch init` (stub) exits 0 and does not print the `[orch] mode=...` banner to stderr.
- `orch new foo` (stub) exits 0 and does not print the `[orch] mode=...` banner.
- `orch run hello` still prints the banner (regression guard).
- `orch --help` lists both `init` and `new` with one-line descriptions.
- `orch init --mode=two-pane` does not crash on tmux probe even when tmux is absent (banner-skipping should bypass `resolveMode` entirely).
- Unknown command after the refactor still exits 2 with `Unknown command:` (regression guard).

**Verification:** Stub commands are wired and discoverable via `--help`; banner suppression confirmed; existing dispatch behavior intact.

---

### U2. Add `ConfirmService` port with real and fake implementations

**Goal:** Introduce a minimal CLI-yes/no port so `orch init`'s two prompts have a testable seam.

**Requirements:** R7 (replace prompt), R8 (keep-workflows prompt).

**Dependencies:** none (orthogonal to U1).

**Files:**
- `src/services/prompt/confirm-service.ts` (new — port interface)
- `src/services/prompt/readline-confirm-service.ts` (new — wraps `node:readline`)
- `src/services/prompt/fake-confirm-service.ts` (new — scripted responses + recorded calls)
- `src/services/prompt/index.ts` (modify — re-export)
- `src/cli/deps.ts` (modify — add `confirmService: ConfirmService` to `CliDeps`; wire `ReadlineConfirmService` in `createDeps`)
- `tests/unit/services/prompt/confirm-service.test.ts` (new)

**Approach:**
- Define the port:
  ```
  ConfirmService { confirm(question: string, defaultAnswer: boolean): Promise<boolean> }
  ```
- `ReadlineConfirmService` uses `readline.createInterface({ input: process.stdin, output: process.stderr })`, writes the prompt with a `[Y/n]` or `[y/N]` suffix (matching the origin's exact wording), reads one line, parses with a small `parseYesNo(input, defaultAnswer)` helper.
- Parsing rules: empty input → default. Case-insensitive: `y`/`yes` → true; `n`/`no` → false. Anything else → re-prompt up to 3 times, then return the default with a warning written to stderr.
- `FakeConfirmService` accepts a scripted answer queue and records the questions asked. Tests assert on both the recorded questions and the answers returned. Mirror the API shape of `FakePromptService` (`src/services/prompt/fake-prompt-service.ts:12-40`) for consistency.
- Add `confirmService` to `CliDeps` interface and to `createDeps`. Default to a real `ReadlineConfirmService` instance.

**Patterns to follow:**
- `src/services/prompt/readline-prompt-service.ts` for the readline wrapping idiom (TTY handling, cleanup on cancel).
- `src/services/prompt/fake-prompt-service.ts` for the scripted-fake shape.
- `src/services/types.ts` re-export idiom from the module barrel.

**Test scenarios:**
- `parseYesNo('', true)` returns `true`; `parseYesNo('', false)` returns `false`.
- `parseYesNo('Y', false)` returns `true`; `parseYesNo('N', true)` returns `false`.
- `parseYesNo('yes', false)` returns `true`; `parseYesNo('no', true)` returns `false`.
- `parseYesNo('maybe', false)` after 3 retries (mocked input source) returns the default and writes a warning to stderr.
- `ReadlineConfirmService.confirm` writes the question + suffix to stderr (not stdout — keeps stdout clean for piping).
- `FakeConfirmService.confirm` returns scripted answers in FIFO order and records each call's question.
- `FakeConfirmService` throws a clear error if the script is exhausted (no scripted answer for the next call).

**Verification:** Port compiles, real impl works in a TTY harness, fake works in unit tests.

---

### U3. Self-detection helper — "are we inside the orch source repo?"

**Goal:** Implement the R2 guard. Detects running inside the orch source tree by checking `<cwd>/package.json` `name === "orch"` AND `<cwd>/src/cli/main.ts` exists.

**Requirements:** R2.

**Dependencies:** none.

**Files:**
- `src/cli/commands/detect-self.ts` (new)
- `tests/unit/cli/detect-self.test.ts` (new)

**Approach:**
- Export `isInsideOrchSourceRepo(deps: { fsService: FsService; readJson: (p: Path) => Promise<unknown> }, cwd: Path): Promise<boolean>`.
- Read `<cwd>/package.json` via `fsService.readFile` + `JSON.parse`. Catch + return `false` on any error (missing file, malformed JSON, non-object).
- Check `name === 'orch'` AND `fsService.exists(<cwd>/src/cli/main.ts)` returns `true`.
- Do not walk up the directory tree — the requirement applies at exactly `cwd`. If a user runs `orch init` from `claude-orchestration/sub/dir/`, the guard does not trip there. This is intentional: the requirement is "refuse at the orch source repo root", not "refuse anywhere under it". The follow-up message points the user to the right place.

**Patterns to follow:**
- `src/observability/orch-version.ts:26-44` for the package.json read + JSON.parse + error handling pattern (do not copy the walk-up loop — this check is single-level).
- `src/services/fs/bun-fs-service.ts` for the `FsService` surface.

**Test scenarios:**
- Returns `true` when `<cwd>/package.json` has `name: "orch"` AND `<cwd>/src/cli/main.ts` exists.
- Returns `false` when `<cwd>/package.json` has a different name.
- Returns `false` when `<cwd>/package.json` exists with `name: "orch"` but `src/cli/main.ts` is absent (incomplete repo).
- Returns `false` when `<cwd>/package.json` is missing entirely.
- Returns `false` when `<cwd>/package.json` exists but is malformed JSON.
- Returns `false` when `<cwd>/package.json` is valid JSON but the top-level value isn't an object.
- Returns `false` when invoked from a subdirectory of the orch source repo (only the literal cwd is checked).

**Verification:** Unit tests pass with `FakeFsService`.

---

### U4. Scaffold templates and shared writer helpers

**Goal:** Centralize the file contents that `init` writes (the templates) and the shared file-writing primitives (`writeTemplateFile`, `ensureGitignoreLine`, `writeWorkflowsDir`). Pure functions over `FsService` — no command logic.

**Requirements:** R3, R4, R5, R6.

**Dependencies:** none.

**Files:**
- `src/cli/commands/init-templates.ts` (new — string constants + helpers)
- `src/cli/commands/scaffold.ts` (new — writer functions)
- `tests/unit/cli/commands/init-templates.test.ts` (new)
- `tests/unit/cli/commands/scaffold.test.ts` (new)

**Approach:**
- `init-templates.ts` exports four string constants and one helper:
  - `HELLO_WORKFLOW_TEMPLATE` — content of `.orch/workflows/hello.ts`. Single-step workflow that imports `workflow` from `'orch'` and the `HELLO` step from `../steps.ts`. Default-exports `workflow('hello', async (run) => { await run(HELLO) })`. Mirrors the shape `loadWorkflow` requires (`src/cli/commands/load-workflow.ts:20-22`).
  - `STEPS_TEMPLATE` — content of `.orch/steps.ts`. Imports `step`, `claude` from `'orch'`. Defines `export const HELLO = step.define('write-hello', { agent: claude({ bare: false, flags: ['--permission-mode', 'bypassPermissions'] }), prompt: 'Create a file at ./hello.txt containing exactly the text "hello from orch" (no trailing newline, no code fences, no extra explanation).' })`. Includes a one-line comment hinting "add more reusable steps below".
  - `CONFIG_TEMPLATE` — content of `.orch/orch.config.ts`. `import { defineConfig } from 'orch'; export const config = defineConfig({ workflows: { hello: 'workflows/hello.ts' } })`. Uses `export const config` (the preferred form; `loadConfig` accepts both but the biome rule on `src/**` discourages default exports — staying consistent in scaffolded files is good hygiene).
  - `newWorkflowTemplate(name: string)` — returns the blank skeleton for `orch new`. Imports `workflow` from `'orch'`; default-exports `workflow(name, async (run) => { /* TODO: add steps */ })`. The `name` is interpolated only into the first argument of `workflow(...)`; the file path is the kebab-case `<name>.ts`.
- `scaffold.ts` exports:
  - `writeOrchTree(fsService, orchDir: Path): Promise<void>` — creates `workflows/` and `state/` dirs, writes `hello.ts`, `steps.ts`, and `orch.config.ts`.
  - `ensureGitignoreLine(fsService, gitignorePath: Path, line: string): Promise<void>` — idempotent. If the file does not exist, create with that single line + newline. If it exists, read, split by `\n`, check whether any trimmed line equals `line`, append with a leading separator (`\n` only if the file does not already end with `\n` and is non-empty) followed by `${line}\n`.
  - `removeOrchTree(fsService, orchDir: Path): Promise<void>` — thin wrapper around `fsService.remove(orchDir)` with a sanity check that `orchDir` ends with `/.orch`.
  - `preservingReinitFiles(fsService, orchDir: Path): Promise<{ preservedWorkflows: ReadonlyArray<Path> }>` — for F2 keep mode, reads `<orchDir>/workflows/`, returns paths of all `.ts` files other than `hello.ts`. State is preserved by *not deleting* `<orchDir>/state/`.
  - `appendWorkflowToManifest(fsService, configPath: Path, name: string, relPath: string): Promise<void>` — reads `.orch/orch.config.ts`, locates the `workflows: { ... }` block via a small regex (`/workflows:\s*\{([\s\S]*?)\}/`), inserts a new entry `<name>: '<relPath>'` while preserving formatting, writes back. If the regex doesn't match, throw with a clear "your config has been edited in a way `orch new` can't safely modify — add the entry manually" message.

**Patterns to follow:**
- `src/services/types.ts` `path()` for all path construction (no raw strings cross the seam).
- `examples/hello-file/index.ts:47-55` for the `claude()` configuration used in the HELLO step.
- The `defineConfig` shape at `src/config/index.ts:26-28`.

**Technical design — template shapes:**

`.orch/orch.config.ts`:
```
import { defineConfig } from 'orch'

export const config = defineConfig({
  workflows: {
    hello: 'workflows/hello.ts',
  },
})
```

`.orch/steps.ts`:
```
import { claude, step } from 'orch'

// Add more reusable step definitions below.
export const HELLO = step.define('write-hello', {
  agent: claude({
    bare: false,
    flags: ['--permission-mode', 'bypassPermissions'],
  }),
  prompt:
    'Create a file at ./hello.txt containing exactly the text "hello from orch" ' +
    '(no trailing newline, no code fences, no extra explanation).',
})
```

`.orch/workflows/hello.ts`:
```
import { workflow } from 'orch'
import { HELLO } from '../steps.ts'

export default workflow('hello', async (run) => {
  await run(HELLO)
})
```

`.orch/workflows/<name>.ts` (from `orch new <name>`):
```
import { workflow } from 'orch'

export default workflow('<name>', async (_run) => {
  // TODO: add steps. See `.orch/steps.ts` for the HELLO example.
})
```

*Above sketches are directional guidance for review, not implementation specification.*

**Test scenarios:**

`init-templates.ts`:
- All four templates parse as valid TypeScript when run through `Bun.Transpiler` or `new Function`-equivalent check. (Sanity check that we haven't shipped a syntax error.)
- `HELLO_WORKFLOW_TEMPLATE` imports `workflow` from `'orch'` (string match) and exports `default workflow(...)`.
- `STEPS_TEMPLATE` imports `claude, step` from `'orch'` and exports `HELLO`.
- `CONFIG_TEMPLATE` exports `config` (matching the `loadConfig` preference at `src/config/index.ts:133-135`).
- `newWorkflowTemplate('my-workflow')` interpolates the name into the `workflow('my-workflow', ...)` call and into nothing else.
- `newWorkflowTemplate("Bad'Name")` — never called in practice (name is validated upstream) but verify the template doesn't blow up: the test exists to lock down that no shell-style escaping is needed.

`scaffold.ts`:
- `writeOrchTree` creates `workflows/`, `state/`, `hello.ts`, `steps.ts`, `orch.config.ts` in the right places via `FakeFsService`.
- `writeOrchTree` does not create or modify files outside `<orchDir>`.
- `ensureGitignoreLine` creates a missing `.gitignore` with the single line + trailing newline.
- `ensureGitignoreLine` is idempotent: running twice with the same line produces the same file content.
- `ensureGitignoreLine` does not duplicate an existing matching line (whitespace-trimmed match).
- `ensureGitignoreLine` appends without disturbing existing lines (preserves trailing newlines, doesn't split CRLF mid-line — assume LF for first iteration, document the limitation).
- `ensureGitignoreLine` on a file ending without a trailing newline inserts `\n.orch/state/\n`.
- `removeOrchTree` sanity-rejects a path that does not end with `/.orch`.
- `preservingReinitFiles` returns paths of every `.ts` under `workflows/` except `hello.ts`. Returns empty array when only `hello.ts` exists.
- `preservingReinitFiles` returns empty array when `workflows/` doesn't exist (degenerate case).
- `appendWorkflowToManifest` adds an entry to the workflows map between the braces, preserving the rest of the file.
- `appendWorkflowToManifest` throws a clear error when the workflows-block regex does not match (e.g., the user replaced `workflows` with a function call or moved it into a different shape).

**Verification:** Unit tests confirm pure-function correctness. No real filesystem touched.

---

### U5. `orch init` — clean-project flow (F1)

**Goal:** Implement the F1 path: `.orch/` does not exist → scaffold the full tree, append to `.gitignore`, print the "next step" hint.

**Requirements:** R1 (indirectly), R2 (guard), R3, R4, R5, R6, R13.

**Dependencies:** U1, U3, U4.

**Files:**
- `src/cli/commands/init.ts` (extend stub from U1)
- `tests/integration/cli/commands/init.test.ts` (new — covers F1; F2 added in U6)

**Approach:**
- Handler reads `deps.cwd`, calls `isInsideOrchSourceRepo` (U3) — exit 2 with R2 message on hit.
- Checks `fsService.exists(<cwd>/.orch)`. If it exists, defer to U6 logic (separate function `reinitFlow` invoked here). For U5, the test fixtures use a clean tmpdir so the existence check returns false.
- Calls `writeOrchTree(fsService, <cwd>/.orch)` (U4).
- Calls `ensureGitignoreLine(fsService, <cwd>/.gitignore, '.orch/state/')` (U4).
- Writes hint to stdout: a short multi-line block explaining:
  - "Created `.orch/` with a hello-world workflow."
  - "Run it with: `orch run hello`"
  - "Add more workflows with: `orch new <name>`"
- Returns `EXIT.OK`.
- The hint format is "concise success blob" — three short lines, no boxes, no colors (the project's existing CLI hints don't use either).

**Patterns to follow:**
- `src/cli/commands/runs.ts:10-24` for the handler signature.
- `src/cli/commands/dry-run.ts` for the "compose helper calls + print hint" structure.

**Test scenarios** (handler-level via `FakeFsService` + manually constructed `CliDeps`, following the pattern at `tests/integration/cli/commands/runs.test.ts:25-41`):

- **F1 happy path:** With no `.orch/` and no `.gitignore` in cwd, `initCmd` exits 0, creates `.orch/workflows/hello.ts`, `.orch/steps.ts`, `.orch/orch.config.ts`, and `.gitignore` containing exactly `.orch/state/\n`.
- **F1 with existing `.gitignore`:** Cwd has a `.gitignore` containing `node_modules\n`. After `initCmd`, the file contains `node_modules\n.orch/state/\n` (preserves existing lines, appends new line with leading newline if needed).
- **F1 with existing `.gitignore` already mentioning the line:** Idempotent — running `initCmd` does not add a duplicate.
- **R2 guard — orch source repo:** Cwd contains `package.json` with `"name": "orch"` AND `src/cli/main.ts`. `initCmd` exits 2 with a message naming the orch source-repo refusal. No files are written.
- **R2 guard — package.json with different name:** Cwd has `package.json` with `"name": "host-project"`. Init proceeds normally.
- **Covers AE5 (prep):** After `initCmd`, the scaffolded `.orch/orch.config.ts` content includes `workflows: { hello: 'workflows/hello.ts' }` (the manifest entry that makes `orch run hello` resolvable). End-to-end "`orch run hello` produces `hello.txt`" is covered by U8 (preflight) + manual smoke (we don't run Claude in CI).
- **Hint text:** Exit-0 path writes a "next steps" hint to stdout containing the strings `orch run hello` and `orch new`.
- **`FakeConfirmService` is not invoked** during the clean-project F1 path (no prompts).

**Verification:** Integration tests pass against `FakeFsService` + tmpdir wherever the test needs real FS (e.g., for the `Bun.Transpiler` parse check on the written files).

---

### U6. `orch init` — re-init flow (F2)

**Goal:** Implement the two-prompt opt-in replace flow when `.orch/` already exists, plus the non-interactive refusal.

**Requirements:** R7, R8, R9.

**Dependencies:** U1, U2, U3, U4, U5.

**Files:**
- `src/cli/commands/init.ts` (extend with `reinitFlow` function)
- `tests/integration/cli/commands/init.test.ts` (extend)

**Approach:**
- Branch entered from U5's existence check when `<cwd>/.orch` exists.
- Step 1 — non-interactive refusal (R9):
  - If `opts.interactivity === 'noninteractive'` OR `process.stdin.isTTY !== true`, write a clear error to stderr explaining that `.orch/` already exists and the user must either run interactively or remove `.orch/` manually. Exit 2. No prompts, no destructive default.
- Step 2 — first prompt (R7):
  - `confirmService.confirm("\`.orch/\` already exists. Replace it?", false)`.
  - On `false`: write a brief "no changes made" message to stdout, exit 0.
  - On `true`: proceed.
- Step 3 — second prompt (R8):
  - `confirmService.confirm("Keep your existing user workflows?", true)`.
  - On `true` (keep): enumerate workflows via `preservingReinitFiles` (U4), rewrite `.orch/workflows/hello.ts` + `.orch/steps.ts` + `.orch/orch.config.ts`. The new manifest contains `{ hello: 'workflows/hello.ts', ...preservedWorkflowEntries }` so preserved workflows remain runnable. `.orch/state/` is left untouched.
  - On `false` (don't keep): `removeOrchTree(fsService, .orch)`, then run U5's writeOrchTree + ensureGitignoreLine flow.
- Step 4 — write the hint and exit OK.

**TTY detection note:** Use `process.stdin.isTTY` rather than `process.stdout.isTTY` — readline reads from stdin, so piped stdin is the case that breaks confirmation. Mirrors precedent at `src/cli/main.ts:266`.

**Patterns to follow:**
- `src/services/prompt/readline-prompt-service.ts` for TTY handling caveats.
- The `--noninteractive` precedent in `src/cli/main.ts:225-237`.

**Test scenarios** (all via `FakeFsService` + `FakeConfirmService`):

- **AE1 (R7):** `.orch/` exists with `workflows/hello.ts`, `workflows/my-real-workflow.ts`, `state/r-2026-05-15-abc/`. ConfirmService scripted to answer `false` to the first prompt. After `initCmd`: exits 0, on-disk state is byte-identical (verified via `FakeFsService` snapshot comparison), second prompt is *not* asked (recorded calls show only one).
- **AE2 (R7, R8):** Same starting state as AE1. ConfirmService scripted `true, true`. After `initCmd`: exit 0; `.orch/state/r-2026-05-15-abc/` and `.orch/workflows/my-real-workflow.ts` are unchanged; `.orch/workflows/hello.ts` and `.orch/steps.ts` match the freshly-scaffolded templates; `.orch/orch.config.ts` contains entries for both `hello` and `my-real-workflow`.
- **AE3 (R8):** Same starting state as AE1. ConfirmService scripted `true, false`. After `initCmd`: exit 0; `.orch/` is entirely re-scaffolded as a fresh init; `my-real-workflow.ts` and `r-2026-05-15-abc/` are gone; only `hello.ts`, `steps.ts`, `orch.config.ts`, and empty `state/` remain.
- **AE4 (R9):** `.orch/` exists. `opts.interactivity === 'noninteractive'`. After `initCmd`: exits 2, no prompts asked (ConfirmService recorded calls is empty), no files mutated, stderr contains a remediation message naming the path.
- **R9 via piped stdin:** `.orch/` exists, `opts.interactivity === 'interactive'`, `process.stdin.isTTY` is falsy (simulated by passing a `streamsLikeFake` to the handler or by gating on a injected flag — see implementation note below). Same outcome as AE4.
- **R2 guard still fires in re-init context:** In the orch source repo with `.orch/` present, the guard fires before any prompt. Exit 2, no prompts asked.
- **Decline keeps `.gitignore` untouched:** Pre-existing `.gitignore` is not modified when the user declines (or replies "no") on the first prompt.

**Implementation note for TTY testability:** `process.stdin.isTTY` is hard to fake without process-level mocking, which CLAUDE.md rule #3 bans. Two options:
- (a) Read TTY-ness inside `ReadlineConfirmService.confirm` and have it throw a typed `NoTtyError` that `initCmd` catches and converts to the R9 exit path.
- (b) Inject the TTY flag into `CliDeps` (e.g., `deps.isStdinTty: boolean`) so tests can flip it.

Option (a) keeps the seam clean and the test setup simpler — the fake `ConfirmService` throws `NoTtyError` to simulate the piped-stdin case. Prefer (a) unless implementation reveals a reason to switch.

**Verification:** Integration tests pass against the fakes.

---

### U7. `orch new <name>` — scaffold a new workflow file (F3)

**Goal:** Implement the `orch new <name>` command. Validates the name, requires an existing `.orch/`, refuses to overwrite, creates the workflow file, appends to the manifest, prints a hint.

**Requirements:** R10, R11, R12, R13.

**Dependencies:** U1, U3, U4.

**Files:**
- `src/cli/commands/new.ts` (extend stub from U1)
- `tests/integration/cli/commands/new.test.ts` (new)

**Approach:**
- Handler reads `positional` (the workflow name).
- Empty name → exit 2 with a usage hint pointing at the existing HELP block.
- R2 guard: `isInsideOrchSourceRepo` → exit 2.
- R11 validation: regex `^[a-z][a-z0-9-]*$`. Mismatch → exit 2 with a clear "Invalid workflow name '\<name\>'. Must be lowercase kebab-case (starts with a letter, ASCII letters, digits, hyphens)."
- R10 precondition: `fsService.exists(<cwd>/.orch)` → if false, exit 2 with "No .orch/ found. Run `orch init` first."
- R12 non-overwrite: build `workflowPath = <cwd>/.orch/workflows/<name>.ts`. If `fsService.exists(workflowPath)`, exit 2 with the full path and "refusing to overwrite".
- Write the new workflow file using `newWorkflowTemplate(name)` (U4).
- Append manifest entry via `appendWorkflowToManifest(fsService, <cwd>/.orch/orch.config.ts, name, 'workflows/<name>.ts')` (U4). If the manifest write fails (regex mismatch), the workflow file has already been written. The error message tells the user the file was created but they need to add the manifest entry manually. (Alternative: write to a temp file and only commit both on success — over-engineering for this iteration.)
- Print hint: "Created `.orch/workflows/<name>.ts` — run it with `orch run <name>`".
- Exit OK.

**Patterns to follow:**
- `src/cli/commands/run.ts:93-96` for "missing positional" handling.
- `src/cli/commands/status.ts:25-28` for short, focused error messages on argument validation.

**Test scenarios** (handler-level via `FakeFsService`):

- **F3 happy path:** With `.orch/` already initialized (via `writeOrchTree` in test setup), `newCmd` with positional `my-feature` exits 0, creates `.orch/workflows/my-feature.ts`, appends `my-feature: 'workflows/my-feature.ts'` to the manifest's workflows map.
- **Hint output:** Stdout contains `orch run my-feature` and the file path.
- **R10 — no `.orch/`:** Cwd is empty. `newCmd` with positional `foo` exits 2 with "No .orch/ found" in stderr. No files created.
- **R11 AE6 — uppercase name:** `newCmd` with positional `My_Workflow` exits 2 with a validation error mentioning kebab-case. No files created.
- **R11 AE6 — leading digit:** `newCmd` with positional `1st-flow` exits 2 with a validation error. No files created.
- **R11 — empty name:** `newCmd` with positional `''` exits 2 with a usage hint.
- **R11 — name with `/`:** `newCmd` with `foo/bar` exits 2 (regex rejects).
- **R11 — name with `..`:** `newCmd` with `../escape` exits 2 (regex rejects; double-checked because path traversal would be the worst-case failure).
- **R12 AE7 — file already exists:** `.orch/workflows/build.ts` exists. `newCmd build` exits 2 with the conflicting path in stderr. The existing file is byte-identical (not touched).
- **Manifest update — workflows added in order:** `newCmd alpha`, then `newCmd beta`. Final manifest workflows map contains entries for `hello`, `alpha`, `beta`.
- **Manifest regex mismatch:** Replace the manifest content with a non-matching shape (e.g., `defineConfig({ workflows: makeWorkflows() })`). `newCmd foo` writes the workflow file but exits 2 with a clear "config has been edited" message after the failed manifest update. (Edge case worth covering because the workflow file is created but the manifest isn't — the user-facing message must make this state recoverable.)
- **R2 guard fires:** In the orch source repo, `newCmd` exits 2 before doing anything.
- **No mode banner printed** (regression for U1's gating).

**Verification:** Integration tests pass against `FakeFsService`.

---

### U8. End-to-end subprocess smoke test

**Goal:** Run `orch init` and `orch new` as real subprocesses against a tmpdir, asserting on observable side effects (exit code, file contents on disk). One or two tests, not a full suite — the heavy coverage lives at the handler level (U5-U7). This test catches issues that only show up through the full `Bun.argv` → `parseArgv` → dispatch → handler path.

**Requirements:** R14 (full CLI pipeline works), R3, R6.

**Dependencies:** U1, U5, U7.

**Files:**
- `tests/integration/cli/commands/init-e2e.test.ts` (new)

**Approach:**
- Reuse the `Bun.spawn(['bun', 'run', ENTRY, ...argv], { cwd: tmpDir, env: ... })` recipe from `tests/integration/cli/unknown-flag.test.ts:10-33`.
- Test 1: `orch init` in a fresh tmpdir. Assert exit 0, `.orch/workflows/hello.ts` exists on disk, `.orch/orch.config.ts` exists on disk, `.gitignore` contains `.orch/state/`.
- Test 2: After test-1's `init`, run `orch new my-feature`. Assert exit 0, `.orch/workflows/my-feature.ts` exists. Read the manifest and confirm it now lists both `hello` and `my-feature`.
- Optionally test 3: After test-1's `init`, run `orch dry-run hello`. Assert that `dry-run` finds and resolves the `hello` workflow without error. This is the strongest evidence we can collect in CI for AE5 without spawning Claude.
- Do **not** test `orch run hello` in this file — it would require a real Claude CLI in CI, which is env-gated everywhere else.
- Each test uses its own tmpdir and cleans up in `finally`.

**Test scenarios:**

- `orch init` in a fresh tmpdir exits 0; `.orch/workflows/hello.ts`, `.orch/steps.ts`, `.orch/orch.config.ts` all exist on disk; `.gitignore` exists and contains `.orch/state/`. Covers F1 end-to-end.
- After `init`, `orch new my-feature` exits 0; `.orch/workflows/my-feature.ts` exists; `.orch/orch.config.ts` lists both `hello` and `my-feature`. Covers F3 end-to-end.
- (Optional) After `init`, `orch dry-run hello --mode=plain` exits 0 and resolves the `hello` workflow. Covers AE5 to the limit possible in CI.
- `orch init` invoked under the orch source repo (cwd = repo root) exits 2 with the R2 refusal message in stderr. Belt-and-suspenders for U3.

**Verification:** Tests run with `bun test` (no env gate); `.orch/` is created in a tmpdir, not the host project.

---

### U9. Documentation updates — `docs/getting-started.md` and `README.md`

**Goal:** Bring docs in line with the implemented behavior. The origin doc explicitly notes that `docs/getting-started.md` is overridden by this work; align it.

**Requirements:** R1 (`bun link` install path documented).

**Dependencies:** U5, U7 (so docs match shipped behavior).

**Files:**
- `docs/getting-started.md` (modify)
- `README.md` (modify)

**Approach:**
- `README.md`: Add an "Install in another project" subsection under "Quick start" with the `bun link` flow:
  - `cd claude-orchestration && bun link` (one-time)
  - `cd ~/your-project && bun link orch`
  - `orch init`
  - `orch run hello`
- `docs/getting-started.md` §3 (Project layout): replace the `.orchestrator/` / root-level `orchestration.ts` sketch with the actual `.orch/` layout. List the four scaffolded files (`orch.config.ts`, `workflows/hello.ts`, `steps.ts`, `state/`) and note that `state/` is gitignored while the rest is committed.
- `docs/getting-started.md`: remove or rewrite the "There's no `orch init`" passage. Replace with a short pointer to the new commands.
- `docs/getting-started.md` §15 (CLI cheat sheet): add `orch init` and `orch new <name>` rows with one-line descriptions.
- Keep the rest of `getting-started.md` (which is still aspirational) untouched in this PR.

**Patterns to follow:**
- `README.md`'s existing Quick-start subsection style (terse fenced-block command snippets, no prose padding).

**Test scenarios:**

Test expectation: none -- documentation-only changes. Reviewer-validated.

**Verification:** Manual review during PR. The Quick-start snippet should be copy-pasteable.

---

## System-Wide Impact

- **`src/cli/main.ts`** gains a small branch in `main()` to skip mode resolution for `init` and `new`. Risk: existing commands' banner output changes (regression). U1 covers this with explicit "still prints banner for `run`" test.
- **`src/cli/deps.ts`** gains a new field (`confirmService`). Existing `createDeps` call sites in tests construct `CliDeps` manually — those tests (e.g., `tests/integration/cli/commands/runs.test.ts:25-41`) need to be updated to include the new field. Best done by giving `FakeConfirmService` a sensible default (e.g., always answers `false`) and updating each affected test file. This is the largest cross-cutting impact in the plan.
- **`src/services/prompt/index.ts`** gains three new exports. Low risk — additive.
- **`README.md`** and **`docs/getting-started.md`** updates affect anyone onboarding to orch. Worth a careful review pass.
- **No runtime impact on existing workflows.** `orch run`, `orch resume`, `orch logs`, etc. are untouched. The host registry, runners, validators, and state store see no changes.
- **`bun link` setup is a documented manual step**, not automated. No CI signal yet that `bun link orch` works from a clean host project — that's a manual smoke item before merging.

---

## Risks

- **`orch run hello` fails after `init` if Claude is missing/unauthenticated.** This is explicitly out of scope per the origin (no agent CLI detection). Mitigation: the "next steps" hint mentions running `orch run hello` and points the user to expect Claude. Acceptable risk for v1.
- **`orch new` manifest insertion is regex-based.** If the user edits `.orch/orch.config.ts` into a non-matching shape, `orch new` fails after creating the workflow file, leaving the user in a half-state. Mitigation: error message names the path and what to add manually. Acceptable because the scaffolded shape is stable and most users won't edit the manifest.
- **`FakeFsService` doesn't simulate `process.stdin.isTTY`.** R9 testing depends on either Option (a) (typed `NoTtyError` thrown by `ReadlineConfirmService`) or Option (b) (injected TTY flag). U6's implementation note specifies the choice; the test plan assumes (a).
- **Cross-cutting `CliDeps` change touches several test files.** Updating each one to construct the new field is mechanical but easy to miss. U2 verification includes "all CLI command tests still pass after the field is added" as a regression item.
- **Templates import from `'orch'`.** This only works in a `bun link`-ed host project. If a user tries to run the scaffolded files standalone (e.g., `bun run .orch/workflows/hello.ts` after deleting the link), they'll get module-not-found. Out of scope to handle, but worth a one-line note in the hint or README if it surfaces during dogfooding.
- **`init` writes nothing transactionally.** Partial failure (e.g., `writeFile` throws halfway through `writeOrchTree`) leaves the filesystem in a half-state. Mitigation: documented but not handled in v1 — `init` is idempotent on retry for the happy path, and re-running over the half-state goes through F2 (replace prompt). If this becomes a real problem, write to a temp dir + rename in a follow-up.
- **`docs/getting-started.md` is a large file with multiple unrelated aspirations.** U9 should touch only the sections that conflict with shipped behavior. Reviewer should confirm no out-of-scope edits.

---

## Verification

A reasonable implementer can show this plan is done when:

- `bun run check` is green (lint + typecheck + unit + mocked integration).
- `orch --help` lists `init` and `new`.
- In a fresh tmpdir: `bun run src/cli/main.ts init` exits 0 and creates the documented file tree; `bun run src/cli/main.ts new my-flow` exits 0 and creates the documented workflow file + manifest entry.
- The full handler-level test suite for `init` and `new` covers F1, F2 (all three AE branches), F3 (all AE branches), R2, R9, R10-R12.
- A manual smoke pass: `bun link` orch into a separate project, run `orch init`, run `orch run hello`, see `hello.txt` appear. Documented as a pre-merge checklist item, not a CI gate.
- `README.md` and `docs/getting-started.md` no longer contradict the shipped behavior.
