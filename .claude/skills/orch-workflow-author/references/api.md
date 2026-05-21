# orch public API reference

Every symbol below is exported from `src/core/index.ts` or `src/runners/index.ts`. Never reach past these barrels.

## `workflow(name, fn)`

Declares the workflow. The function receives `(run, args)` — `args.prompt` is the optional string the user passes on the CLI.

```ts
export default workflow('feature-build', async (run, args) => {
  if (args.prompt === undefined || args.prompt.trim() === '') {
    throw new Error('feature-build requires a prompt')
  }
  // …
})
```

The returned object has `.execute(deps)` and `.resume(deps)` — but the CLI does that wiring; you never call them by hand in a workflow file.

## `step.define(name, config)`

Defines a reusable agent step. The name is the memoization key — make it stable.

**Autonomous form** (default, supports `returns:` and `validate:`):

```ts
const PLAN = step.define('plan', {
  agent: claude({ bare: false, flags: ['--permission-mode', 'bypassPermissions'] }),
  prompt: 'Read docs/sessions/<slug>/brainstorm.md and produce a phased plan…',
  returns: schema(z.object({ phases: z.number().int().min(1).max(30) })),  // optional
  // validate: fileProduced('docs/plans/*.md'),                            // optional
  // mode: 'autonomous',                                                   // default
  // view: 'transcript',                                                   // 'transcript' | 'silent' (rare)
  // pane: 'right',                                                        // 'left' | 'right'
  // silent: true,                                                         // suppress host pane output
})
```

**Interactive form** (`mode: 'interactive'`, no `returns:` allowed):

```ts
const BRAINSTORM = step.define('brainstorm', {
  mode: 'interactive',
  agent: claude({ bare: false, flags: ['--dangerously-skip-permissions', '--name', 'brainstorm'] }),
  prompt: '/workflows:brainstorm  ' + userPrompt,
})
```

Interactive returns `InteractiveResult = { exitCode, durationMs, sessionId }` — the human drove the session, the workflow waits.

**Reserved name prefixes are forbidden** (`commit:`, `worktree:`, `ask:`, `command:`). Use the matching factory instead.

## `await run(STEP, overrides?)`

Invokes a step. Returns its typed value (or `InteractiveResult` for interactive steps, or `void` if no `returns:`).

Overrides:

- `as: 'phase-3'` — override the memoization key (mandatory inside loops or repeated calls).
- `prompt: '…'` — replace the step's default prompt entirely.
- `extraPrompt: '…'` — appended to the default prompt with a blank-line separator.
- `extraContext: { … }` — JSON-stringified and appended (use for structured context like `{ phaseIndex: 2, planPath: '…' }`).
- `mode: 'interactive' | 'autonomous'` — override the step's declared mode (the type narrows the return shape).

```ts
await run(WORK, { as: `work-${phase.name}`, extraContext: { phase } })
```

## `ask({ name, question, fields, buttons, defaultWhenNoninteractive })`

Typed user-input step. Returns a discriminated `AskResult`:
- `{ cancelled: true, fields: Partial<{…}> }` — user pressed Esc.
- `{ cancelled: false, button: B } & { […fields…]: string }` — user submitted.

```ts
const CONFIRM = ask({
  name: 'continue',
  question: 'Continue this iteration?',
  fields: { notes: { placeholder: 'extra instructions (optional)' } },
  buttons: ['continue', 'retry', 'abort'],
  defaultWhenNoninteractive: { button: 'continue' },
})

const r = await run(CONFIRM)
if (r.cancelled) { /* esc */ }
else if (r.button === 'retry') { /* notes is r.notes */ }
```

Every `ask()` that should survive `--noninteractive` runs must declare `defaultWhenNoninteractive`. Missing field values zero-fill to `''`.

## `command(name, opts)` + `tail(text, n)`

Shell step. Streams stdout/stderr to the host pane live, returns `{ exitCode, stdout, stderr, durationMs }`. Use `tail` to trim noisy output before feeding it into a downstream agent's prompt.

```ts
const TESTS = command('tests', { argv: ['bun', 'test'], onFailure: 'continue' })
const r = await run(TESTS)
if (r.exitCode !== 0) {
  await run(FIX, { extraContext: { failing: tail(r.stdout, 200) } })
}
```

`onFailure` is required (no default):
- `'halt'` — throws `StepError` on non-zero exit.
- `'continue'` — returns the result; you decide what to do.

Optional: `cwd?: Path`, `env?: Record<string, string>` (layered over `process.env`), `pane?: 'left' | 'right'` (default `'right'`), `silent?: boolean`.

## `commit(message)`

`git add . && git commit -m <message>`, as a memoized step. Returns `{ sha }` if anything was staged, `null` if the tree was clean.

```ts
await run(commit('feat(auth): extract token service'))
```

**Security note:** `git add .` stages everything. If an agent step might create `.env` or `*.pem`, sanitize first.

## `createWorktree(branch, opts)`

Materializes a `git worktree` and (with `enter: true`) switches the workflow's cwd into it for all subsequent `run()` calls.

```ts
await run(createWorktree('feat/auth', {
  enter: true,
  from: 'main',                              // optional; default 'HEAD'
  target: 'sibling',                         // optional; or a relative/absolute path
  postCreate: ['cp $ORIGIN/.env .', 'bun install'],   // sugar: each line via /bin/sh -c
  // postCreate: async ({ origin, target, exec }) => { … },    // callback form
}))
await run(IMPLEMENT)              // runs inside the worktree
await run(commit('feat: done'))   // commits inside the worktree
```

Returns `{ path, branch, fromRef }`. Strict policy: throws if the branch or target already exists. Inside `parallel()`, only the homogeneous form (`parallel(items, fn)`) supports `enter: true`.

## `parallel(...)`

Two forms — both settle every branch before throwing `ParallelError`.

**Heterogeneous** (tuple type preserved):

```ts
const [a, b] = await parallel([
  run(RESEARCH_A),
  run(RESEARCH_B),
])
```

**Homogeneous** (mapped array, optional concurrency cap):

```ts
const reviews = await parallel(
  ['security', 'performance', 'design'],
  (lens) => run(REVIEW, { as: `review-${lens}`, prompt: `Review focusing on ${lens}` }),
  { concurrency: 2 },
)
```

**Trap:** don't `parallel(...)` work that has ordering constraints. Use a plain `for` loop. `parallel` is only for genuinely independent branches.

## `schema(zodType)`

Wraps a Zod schema into the shape `step.define({ returns: … })` expects. The runner is invoked with `--json-schema` (Claude) / `--output-schema` (Codex) and the value is Zod-validated before `run()` returns.

```ts
import { z } from 'zod'

const SLUG_SCHEMA = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9-]*$/, 'lowercase kebab-case'),
})

const SLUG = step.define('slug', {
  agent: claude({ model: 'claude-haiku-4-5-20251001', bare: false }),
  prompt: 'Return a 2-4 word kebab-case slug for this idea.',
  returns: schema(SLUG_SCHEMA),
})

const { slug } = await run(SLUG)   // typed
```

Cannot be combined with `mode: 'interactive'` — schema output requires `-p` autonomous mode.

## `claude(opts)` — the Claude Code runner

```ts
claude({
  model: 'claude-opus-4-7',               // optional; defaults to whatever `claude` picks
  maxTurns: 12,                            // optional
  bare: false,                             // false = use subscription auth + plugins + skills (recommended)
  flags: ['--permission-mode', 'bypassPermissions', '--name', 'work-auth'],
})
```

Denied flags (will throw): `--settings`, `--mcp-config`. `--dangerously-skip-permissions` is allowed but requires `IS_SANDBOX=1` in the env to be honored — set `process.env.IS_SANDBOX = '1'` at the top of the workflow when you rely on it.

Useful flag patterns:
- `['--permission-mode', 'bypassPermissions']` — autonomous file-write workflows.
- `['--dangerously-skip-permissions', '--name', sessionName]` — sandboxed, named session (good for `two-pane`).

## `codex(opts)` — the Codex runner

```ts
codex({
  model: 'gpt-5-codex',                    // optional
  sandbox: 'workspace-write',              // 'read-only' | 'workspace-write' | 'danger-full-access'
  flags: [],
})
```

Denied flags: `--dangerously-bypass-approvals-and-sandbox`, `--yolo`, `--config`, `--sandbox`, `-c`, `--approval-mode` (use the typed `sandbox` option instead).

Structured output (`returns:`) requires `codex exec`, which the runner auto-selects for autonomous steps. Interactive Codex doesn't support `returns:`.

## Errors you might catch

All exported from `src/core/index.ts`:

- `StepError` — runner exited non-zero or returned a terminal `error` event.
- `ValidationError` — a `validate:` validator failed.
- `SchemaValidationError` — runner output failed Zod parse.
- `AskNoDefaultError` — `--noninteractive` hit an `ask()` with no `defaultWhenNoninteractive`.
- `AskParallelError` / `InteractiveParallelError` — `ask()` or interactive step inside `parallel()`.
- `RunnerCapabilityError` — interactive on a runner that doesn't support it.
- `ResumeError` / `RunNotFoundError` — `orch resume` errors.
- `ParallelError` — at least one parallel branch failed; `.settled` carries every result.
- `PostCreateExecError` — sugar `postCreate` line exited non-zero.

Usually you let these propagate; the executor surfaces them via the host. Catch only when you have a real recovery path (e.g. a `command()` you expect might fail).

## Validators (`validate:`)

Per-step post-exit assertions. Built-ins (re-exported from `src/validators/index.ts`):

- `fileProduced(glob)` — at least one file matching the glob exists after the step.
- `gitDiffCreated()` — non-empty diff since the step started.
- `gitCommitCreated()` — HEAD moved.
- `check(fn)` — inline one-off.
- `defineValidator(name, fn)` — reusable named validator.

```ts
import { fileProduced, gitDiffCreated, check } from '../../src/validators/index.ts'

validate: [
  fileProduced('docs/plans/*.md'),
  check((ctx) => ctx.returns.phases.length > 0 || 'plan has no phases'),
],
```

Validators run after the agent exits. Failure throws `ValidationError`; the run becomes resumable.
