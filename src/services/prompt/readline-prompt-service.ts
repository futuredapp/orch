import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import type { PromptCtx, PromptResult, PromptService, PromptSpec } from './prompt-service.ts'

/**
 * Plain-mode prompt adapter — labeled prompt lines on stdout, one line per
 * field on stdin, then a numbered button choice. Out-of-range choice
 * re-prompts with "invalid choice; pick 1-N" up to MAX_RETRIES times before
 * cancelling (EOF-loop guard).
 *
 * Cancel in plain: type Ctrl-D (EOF) — `rl.question` rejects, the executor's
 * catch path fires, and the workflow can react. (Not pretty, but plain is
 * the fallback path; humans running interactively will be in two-pane.)
 *
 * I/O streams are injectable for tests; defaults are `process.stdin` /
 * `process.stdout`.
 */
export interface ReadlinePromptServiceDeps {
  readonly input?: NodeJS.ReadableStream
  readonly output?: NodeJS.WritableStream
}

const MAX_RETRIES = 5

export class ReadlinePromptService implements PromptService {
  readonly #input: NodeJS.ReadableStream
  readonly #output: NodeJS.WritableStream

  constructor(deps: ReadlinePromptServiceDeps = {}) {
    this.#input = deps.input ?? process.stdin
    this.#output = deps.output ?? process.stdout
  }

  async ask(spec: PromptSpec, ctx: PromptCtx): Promise<PromptResult> {
    const rl = createInterface({ input: this.#input, output: this.#output })
    try {
      this.#write(`[${ctx.stepName}] ${spec.question}\n`)
      const fields = await collectFieldValues(rl, ctx.stepName as string, spec)
      const button = await pickButton(rl, this.#output, ctx.stepName as string, spec.buttons)
      if (button === undefined) return { cancelled: true, fields }
      return { cancelled: false, button, fields }
    } finally {
      rl.close()
    }
  }

  #write(line: string): void {
    this.#output.write(line)
  }
}

async function collectFieldValues(
  rl: ReadlineInterface,
  stepName: string,
  spec: PromptSpec,
): Promise<Record<string, string>> {
  const fields: Record<string, string> = {}
  for (const f of spec.fields) {
    const placeholder = f.placeholder ? ` (${f.placeholder})` : ''
    fields[f.name] = await ask(rl, `[${stepName}] ${f.name}${placeholder}: `)
  }
  return fields
}

/**
 * Reads a button choice. Empty input picks `buttons[0]`. Out-of-range
 * re-prompts with "invalid choice; pick 1-N" up to MAX_RETRIES times. After
 * exhausting retries, returns `undefined` (cancel) — guards against EOF
 * loops if stdin closes.
 */
async function pickButton(
  rl: ReadlineInterface,
  output: NodeJS.WritableStream,
  stepName: string,
  buttons: ReadonlyArray<string>,
): Promise<string | undefined> {
  const labels = buttons.map((b, i) => `(${i + 1}) ${b}`).join('  ')
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const choice = await ask(rl, `[${stepName}] choose: ${labels}  [1]: `)
    if (choice.trim() === '') {
      const first = buttons[0]
      if (first === undefined) return undefined
      return first
    }
    const idx = Number.parseInt(choice, 10) - 1
    const button = buttons[idx]
    if (button !== undefined) return button
    output.write(`[${stepName}] invalid choice "${choice}"; pick 1-${buttons.length}\n`)
  }
  return undefined
}

function ask(rl: ReadlineInterface, q: string): Promise<string> {
  return new Promise((resolve) => rl.question(q, resolve))
}
