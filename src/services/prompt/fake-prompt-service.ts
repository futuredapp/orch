import type { StepName } from '../../core/types.ts'
import type { PromptCtx, PromptResult, PromptService, PromptSpec } from './prompt-service.ts'

/**
 * Test double for `PromptService` — name-keyed scripted responses, follows
 * the `FakeProcessService.when().respondWith()` pattern.
 *
 * `recorded()` returns the calls in arrival order so tests can assert that
 * resume from cache did NOT call the prompt service (the headline contract
 * for ask-step memoization).
 */
export class FakePromptService implements PromptService {
  readonly #scripts = new Map<string, PromptResult>()
  readonly #calls: Array<{ stepName: StepName; spec: PromptSpec }> = []

  when(stepName: string): { respondWith(r: PromptResult): FakePromptService } {
    return {
      respondWith: (r) => {
        this.#scripts.set(stepName, r)
        return this
      },
    }
  }

  async ask(spec: PromptSpec, ctx: PromptCtx): Promise<PromptResult> {
    this.#calls.push({ stepName: ctx.stepName, spec })
    const scripted = this.#scripts.get(ctx.stepName as string)
    if (scripted === undefined) {
      throw new Error(
        `FakePromptService: unscripted ask for step "${ctx.stepName}". ` +
          `Configure via .when("${ctx.stepName}").respondWith({...}).`,
      )
    }
    return scripted
  }

  recorded(): ReadonlyArray<{ stepName: StepName; spec: PromptSpec }> {
    return this.#calls
  }
}
