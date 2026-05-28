# Chain two agents

> **What you'll learn:** how to run a Codex step and a Claude step in sequence, handing work from one to the other through a shared file.

orch treats `claude()` and `codex()` as interchangeable runners — a step doesn't care which CLI backs it. So mixing agents in one workflow is just two `step.define` calls with different `agent:` values. This recipe walks through the [`codex-and-claude` example](/examples): Codex drafts a sentence, Claude expands it.

## Define one step per agent

Each step names its runner. They share work through a file on disk — Codex writes `note.txt`, Claude reads and extends it.

```ts
// .orch/workflows/codex-and-claude.ts
import { workflow, step, claude, codex } from 'orch'
import { fileProduced } from 'orch'

const NOTE_FILE = 'note.txt'

const DRAFT = step.define('draft', {
  agent: codex({ sandbox: 'workspace-write' }),
  prompt:
    `Write a single plain sentence stating an interesting topic and save it to ./${NOTE_FILE}. ` +
    'Write only the sentence — no title, no preamble, no code fences.',
  validate: [fileProduced(NOTE_FILE)],
})

const EXPAND = step.define('expand', {
  agent: claude(),
  prompt:
    `Read ./${NOTE_FILE} and append a short paragraph (3-4 sentences) expanding on that ` +
    'sentence. Keep the original first line intact; add the paragraph below it.',
  validate: [fileProduced(NOTE_FILE)],
})

export default workflow('codex-and-claude', async (run) => {
  await run(DRAFT)
  await run(EXPAND)
})
```

`sandbox: 'workspace-write'` lets Codex write into the workflow cwd without prompting — see the [Codex runner reference](/reference/runners#codex). The `fileProduced` [validator](/guides/validators) makes each step fail loudly if the file never appears, so a silent miss in `DRAFT` doesn't quietly feed an empty file to `EXPAND`.

## Passing work between steps

The two clean ways to hand data from one agent to the next:

- **A shared file** (above). Best for prose, code, or anything large — the agent reads and writes it directly with its own tools. This is the default for code work.
- **`extraContext`** — a JSON value serialized into the next step's prompt. Best for small, structured handoffs you compute in the workflow:

```ts
const { topic } = await run(PICK_TOPIC)            // a typed step result
await run(EXPAND, { extraContext: { topic } })     // appended to the prompt as JSON
```

Use a file when the agent owns the artifact; use `extraContext` when the *workflow* owns a small value the next step needs.

## Autonomous vs interactive

Both steps above are autonomous — orch streams each agent's output and waits for it to finish. That's the right default for an unattended pipeline.

When you want to *watch or drive* an agent, set `mode: 'interactive'` to spawn its real TUI in a pane. To keep an unattended pipeline from stalling on an interactive step, add `autoStop: true` so orch closes the pane when the agent finishes its turn:

```ts
const DRAFT = step.define('draft', {
  agent: codex({ sandbox: 'workspace-write' }),
  mode: 'interactive',
  autoStop: true,
  prompt: `Write a topic sentence to ./${NOTE_FILE}.`,
  validate: [fileProduced(NOTE_FILE)],
})
```

This is the "interactive UI, autonomous behavior" pattern — you can watch and scroll the agent, but the run advances on its own. `autoStop` requires a runner that supports it (`claude()` and `codex()` both do) and works only in [two-pane mode](/guide/3-core-concepts#run-modes). See [Interactive steps](/guides/interactive-steps) for the full picture.

## Where to go next

- [Interactive steps](/guides/interactive-steps) — drive an agent's TUI and prompt the human.
- [Validators](/guides/validators) — assert each step produced what it promised.
- [Runners reference](/reference/runners) — every `claude()` and `codex()` option.
