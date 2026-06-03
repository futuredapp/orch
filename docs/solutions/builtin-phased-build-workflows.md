---
date: 2026-06-03
topic: builtin-phased-build-workflows
status: shipped
problem_type: architecture_pattern
component: tooling
tags:
  - workflows
  - built-ins
  - phased-build
  - interactive-autostop
  - file-sentinel
  - resolve-builtin
---

# Built-in workflows: source-anchored resolution + file-sentinel control flow

> Captured from `feat/default-workflows` (commits `250911f`–`72e854e`). The
> branch added the first packaged workflows — `orch::work-cc` and
> `orch::work-codex` — plus the shared phased-build pipeline that drives both.
> The design clusters around two non-obvious constraints: orch has **no dist
> build**, and **interactive autoStop steps always exit 0**. Everything below
> follows from those two facts.

## Context

`orch run <name>` previously resolved only user-authored workflows (cwd / config
dir). We wanted packaged workflows shipped *with* orch that any host project can
invoke. Two realities shaped the implementation:

1. **No dist build.** orch runs from source (`bin: ./src/cli/main.ts`) and is
   installed by symlinking its source tree into a host project. There is no
   compiled output directory to anchor against.
2. **Interactive autoStop steps return `exitCode 0` unconditionally.** The pane
   closes on turn-complete; the exit code carries no success/failure signal. So
   an agent's outcome cannot be read from its exit code — the pipeline needs
   another channel.

## Guidance

### 1. Anchor built-in paths to the source dir, never the cwd

Route built-ins through an `orch::` prefix and resolve the module path against
orch's own source tree using `fileURLToPath(import.meta.url)`:

```ts
// src/workflows/resolve-builtin.ts
const sourceDir = nodePath.dirname(fileURLToPath(import.meta.url))
return path(nodePath.join(sourceDir, relative))
```

This is the load-bearing decision. Resolving against the user's cwd or config
dir would work run-from-source but break the installed/symlinked case, because
the built-in modules live next to orch's code, not the host's. A registry maps
bare name → relative module path; adding a built-in is one registry entry plus
its entry module.

### 2. Guard the lookup with `Object.hasOwn`, not a bare index

```ts
const relative = Object.hasOwn(BUILTIN_MODULE_PATHS, bare)
  ? BUILTIN_MODULE_PATHS[bare]
  : undefined
```

A bare `map[bare]` lets inherited prototype keys — `orch::constructor`,
`orch::__proto__`, `orch::toString` — resolve to a function/object and produce a
raw `TypeError` from `path.join`. `Object.hasOwn` funnels them into the clean
"unknown built-in" error branch instead.

### 3. One parameterized factory, N runner bindings

`buildPhasedWorkflow(name, runner)` holds *all* phase logic. The entry modules
are thin: they only pin a name and a runner.

```ts
// work-cc/index.ts — work-codex differs ONLY in the bound runner
export default buildPhasedWorkflow(
  'work-cc',
  claude({ bare: false, flags: ['--dangerously-skip-permissions'] }),
)
```

Any change to phase behaviour lands once and both variants inherit it. The
`--dangerously-skip-permissions` posture is required so the interactive autoStop
loop can write files unattended without per-action approval prompts.

### 4. Use a truncate-before / read-after file sentinel for autoStop outcomes

Because exit codes are always 0, the agent communicates outcome by **writing a
file**, and the pipeline reads it back. The critical guard is **truncating the
file *before* the step**, so a non-writing agent yields an empty read (→ halt)
rather than a stale read from a prior run (→ silent corruption).

This pattern appears twice:

- **Decide artifact.** `rm -f` the phases artifact → run decide step → `cat` it
  back → `parsePhases` halts on empty/malformed. Without the pre-truncate, a
  decide that writes nothing would `cat` a previous run's leftover phases.
- **Per-phase status.** `rm -f .orch/phase-N-status` → run implement step →
  `cat` it. The agent's final instruction is to write `ok` or `blocked:
  <reason>`. A missing / non-`ok` sentinel — **not** the exit code — halts the
  loop before the next phase, "rather than compounding the failure."

```ts
const truncate = command('truncate-phases', { argv: ['rm', '-f', ARTIFACT_PATH], onFailure: 'halt' })
await run(truncate)
await run(decide)                       // interactive + autoStop → exitCode 0
const artifact = await run(readBack)    // cat ARTIFACT_PATH, onFailure: 'continue'
return parsePhases(artifact.stdout)     // throws on empty → run halts
```

### 5. Keep the emit format and the parser in one module

The delimiter (`=== PHASE ===`) and artifact path are exported constants in
`decide-prompt.ts`, consumed by *both* `buildDecidePrompt` (what the agent is
told to write) and `parsePhases` (what the read-back parses). Co-locating them
means the prompt format and the parser cannot drift apart.

### 6. Resolve a dual-meaning argument with `cat -- <arg>` and warn on ambiguity

The workflow arg is *either* a plan-file path *or* an inline description.
Folding detect + load into one cached, resumable `command` step:

```ts
const cat = command('resolve-input', { argv: ['cat', '--', promptArg], onFailure: 'continue' })
```

The `--` ends option parsing, so a flag-shaped arg (e.g. `-n`) is treated as a
filename, never as a `cat` option that would silently read stdin and yield an
empty plan. On non-zero exit, treat the arg as inline text — but if it *looks
like a path* (`includes('/')`), warn, since the likelier cause is an
unreadable file than a genuine inline description.

## Why This Matters

- **The sentinel pattern is the only correct way to gate an interactive
  autoStop loop.** Reaching for `result.exitCode` here is a silent bug: it is
  always 0, so every phase would "succeed" and the loop would charge ahead even
  when the agent reported `blocked`. The truncate-before half is equally
  load-bearing — skip it and you read stale state, which is worse than reading
  nothing because it looks valid.
- **Source-anchoring is invisible until orch is installed elsewhere.** It passes
  every run-from-source test and only breaks in the symlinked host case, which
  is exactly the case the feature exists to serve.
- **The factory keeps runner variants honest.** A bug fixed in the phase loop
  can't regress on one runner and not the other, because there is only one loop.

## When to Apply

- Adding another built-in (`orch::<name>`) → one `BUILTIN_MODULE_PATHS` entry +
  a thin entry module binding `buildPhasedWorkflow` (or a new factory) to a
  runner. Do not anchor new resolvers to cwd.
- Any time an **interactive / autoStop** step must signal an outcome to the
  pipeline → write-file + truncate-before + read-after. Never branch on the exit
  code of an autoStop step.
- Any prompt that asks an agent to emit a machine-parsed format → put the format
  tokens (delimiters, paths) in one module shared by the prompt builder and the
  parser.

## Related decisions worth remembering

- **Implement-only phases.** The per-phase prompt explicitly forbids committing
  and running project validation: orch cannot know the host's test/verify
  commands, so the user owns commits and verification.
- **Soft cap, never truncate.** `parsePhases` warns when >4 phases are emitted
  but returns *all* of them — a cap that silently dropped phases would quietly
  lose work.
- **Fixed `.orch/`-relative artifact path** is safe only for sequential
  single-user runs (combined with truncate-before). Run-scoped pathing for
  concurrent same-cwd runs is deferred.

## Pointers

- `src/workflows/resolve-builtin.ts` — `orch::` resolver, source anchoring, hasOwn guard
- `src/workflows/registry.ts` — built-in name → module path map
- `src/workflows/phased-build/pipeline.ts` — the factory + the two sentinel loops
- `src/workflows/phased-build/decide-prompt.ts` — shared delimiter/path + decide prompt
- `src/workflows/phased-build/parse-phases.ts` — deterministic read-back + soft cap
- `src/workflows/{work-cc,work-codex}/index.ts` — thin runner bindings
