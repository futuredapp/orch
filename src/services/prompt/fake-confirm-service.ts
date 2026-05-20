import type { ConfirmService } from './confirm-service.ts'

interface RecordedCall {
  readonly question: string
  readonly defaultAnswer: boolean
}

/**
 * Test double for `ConfirmService`. Scripted answers are returned in FIFO
 * order; every call is recorded so tests can assert on which prompts were
 * actually shown and in what order.
 *
 * Mirrors the recorded-calls shape of `FakePromptService.recorded()` so the
 * two seams feel symmetric in tests.
 */
export class FakeConfirmService implements ConfirmService {
  readonly #answers: boolean[]
  readonly #calls: RecordedCall[] = []

  constructor(answers: ReadonlyArray<boolean> = []) {
    this.#answers = [...answers]
  }

  async confirm(question: string, defaultAnswer: boolean): Promise<boolean> {
    this.#calls.push({ question, defaultAnswer })
    if (this.#answers.length === 0) {
      throw new Error(
        `FakeConfirmService: unscripted confirm for question ${JSON.stringify(question)}. ` +
          `Pre-populate the answer queue when constructing the fake.`,
      )
    }
    return this.#answers.shift() as boolean
  }

  recorded(): ReadonlyArray<RecordedCall> {
    return this.#calls
  }
}
