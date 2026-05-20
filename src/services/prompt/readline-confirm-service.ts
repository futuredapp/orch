import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import { type ConfirmService, confirmSuffix, parseYesNo } from './confirm-service.ts'

/**
 * Real readline-backed `ConfirmService`. Writes the prompt to stderr (keeps
 * stdout clean for piping in the surrounding command) and reads a single
 * line from stdin. Unrecognised input re-prompts up to MAX_RETRIES times
 * before giving up and returning the default with a warning.
 *
 * I/O streams are injectable so unit tests can exercise the parser without
 * touching the real terminal.
 */
export interface ReadlineConfirmServiceDeps {
  readonly input?: NodeJS.ReadableStream
  readonly output?: NodeJS.WritableStream
}

const MAX_RETRIES = 3

export class ReadlineConfirmService implements ConfirmService {
  readonly #input: NodeJS.ReadableStream
  readonly #output: NodeJS.WritableStream

  constructor(deps: ReadlineConfirmServiceDeps = {}) {
    this.#input = deps.input ?? process.stdin
    this.#output = deps.output ?? process.stderr
  }

  async confirm(question: string, defaultAnswer: boolean): Promise<boolean> {
    const rl = createInterface({ input: this.#input, output: this.#output })
    try {
      const suffix = confirmSuffix(defaultAnswer)
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const line = await ask(rl, `${question} ${suffix} `)
        const parsed = parseYesNo(line, defaultAnswer)
        if (parsed !== undefined) return parsed
        this.#output.write(`Please answer "y" or "n".\n`)
      }
      this.#output.write(`No valid answer after ${MAX_RETRIES} attempts; using default.\n`)
      return defaultAnswer
    } finally {
      rl.close()
    }
  }
}

function ask(rl: ReadlineInterface, q: string): Promise<string> {
  return new Promise((resolve) => rl.question(q, resolve))
}
