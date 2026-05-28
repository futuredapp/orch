# Page template

Copy this shape for any new page under `docs/public/`.

## Guide / how-to page

```md
# <Page title — what the page is about>

> **What you'll learn:** <one sentence naming the concrete takeaway>.

<One short paragraph of orientation: what this is and why it matters. No
preamble like "In this guide we will".>

## <First concept>

<Explain it. Then show a complete, runnable example.>

​```ts
import { workflow, step, claude } from 'orch'

const STEP = step.define('example', {
  agent: claude(),
  prompt: 'Do the thing.',
})

export default workflow('demo', async (run) => {
  await run(STEP)
})
​```

## <Next concept — builds on the previous one>

...

## Where to go next

- [Related page](/section/page) — one line on why.
- [Another page](/section/page) — one line on why.
```

## Reference page

```md
# <Subject>

<One sentence on what this page covers and where the symbols are imported from.>

## <symbol>

​```ts
// Signature copied verbatim from src/ — not paraphrased.
function symbol(arg: ArgType): ReturnType
​```

<What it does, in two or three sentences. Then a runnable example.>

| Field | Type | Notes |
| --- | --- | --- |
| ... | ... | ... |

## Where to go next

- [Related reference](/reference/page).
```

## VitePress callouts

Use these for asides — they render as colored boxes:

```md
::: tip
Helpful aside.
:::

::: warning
A footgun the reader must know about.
:::

::: info Stub — not yet written
Use for placeholder pages. State what the page will cover and link to the
closest existing page.
:::
```

## Code groups (tabbed blocks)

For showing the same thing two ways (e.g. Claude vs Codex):

```md
::: code-group
​```ts [claude]
const STEP = step.define('s', { agent: claude() })
​```

​```ts [codex]
const STEP = step.define('s', { agent: codex() })
​```
:::
```
