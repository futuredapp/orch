// Negative + positive TYPE tests for the scenario surface (D11/K6).
//
// These are compiled by `tsc --noEmit` (because `tests-new` is in the tsconfig
// `include`) but NOT executed by `bun test` (`*.test-d.ts` does not match the
// runner glob). Each `@ts-expect-error` must suppress a REAL error or tsc fails
// with "unused @ts-expect-error directive" — that is what makes these tests bite.
//
// The crux is the `<const D>` capture in `scenario()`: the body's `app` is typed
// to ONLY the surface shared by every listed driver. Remove the capture and
// every rejection below would wrongly compile.

import type { Equal, Expect } from '@orch/test/type-assertions.ts'
import { scenario, type SharedApp } from '../index.ts'

// The shared surface of a model+screen scenario is exactly the common keys —
// `resize` (screen-only) is absent. This is the positive proof behind the
// `resize` rejection below.
export type _SharedModelScreenKeys = Expect<
  Equal<keyof SharedApp<['model', 'screen']>, 'teardown' | 'launch' | 'leftPane'>
>

// A single-driver model scenario is exactly ModelApp.
export type _SharedModelIsModelApp = Expect<
  Equal<keyof SharedApp<['model']>, 'teardown' | 'launch' | 'leftPane'>
>

// Never invoked — present only so tsc typechecks the bodies. Exported so the
// unused-symbol pass stays quiet.
export async function _scenarioTypeTests(): Promise<void> {
  // --- accepted: a model scenario uses only the leftPane surface ------------
  scenario({ name: 'ok', drivers: ['model'], feature: 'f', oldTestRefs: [] }, async (app) => {
    await app.launch({ steps: ['plan'] })
    await app.leftPane.assertQuitHintVisible()
    await app.leftPane.assertStepSelected('plan')
  })

  // --- rejected: model has no rightPane ------------------------------------
  scenario({ name: 'no-right', drivers: ['model'], feature: 'f', oldTestRefs: [] }, async (app) => {
    // @ts-expect-error ModelApp has no `rightPane`
    await app.rightPane.assertShowsContent('x')
  })

  // --- rejected: model has no press (no real keystrokes) -------------------
  scenario({ name: 'no-press', drivers: ['model'], feature: 'f', oldTestRefs: [] }, async (app) => {
    // @ts-expect-error ModelApp has no `press`
    await app.press('left', 'f')
  })

  // --- rejected: model has no complete (full-host only) --------------------
  scenario({ name: 'no-complete', drivers: ['model'], feature: 'f', oldTestRefs: [] }, async (app) => {
    // @ts-expect-error ModelApp has no `complete`
    await app.complete('plan')
  })

  // --- rejected: resize is not shared by model+screen ----------------------
  scenario(
    { name: 'no-resize', drivers: ['model', 'screen'], feature: 'f', oldTestRefs: [] },
    async (app) => {
      // @ts-expect-error `resize` is screen-only; not in the model∩screen surface
      await app.resize(80, 24)
    },
  )

  // --- accepted: screen-only scenario can resize ---------------------------
  scenario({ name: 'resize-ok', drivers: ['screen'], feature: 'f', oldTestRefs: [] }, async (app) => {
    await app.resize(80, 24)
    await app.leftPane.assertQuitHintVisible()
  })

  // --- accepted: lifecycle-only scenario can press/signal ------------------
  scenario({ name: 'press-ok', drivers: ['lifecycle'], feature: 'f', oldTestRefs: [] }, async (app) => {
    await app.press('left', 'q')
    await app.signal('SIGINT')
    await app.system.exitedNormally()
  })
}
