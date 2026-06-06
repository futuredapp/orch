// ---------------------------------------------------------------------------
// scenario(meta, body) — write a behaviour once, run it at every listed driver.
// ---------------------------------------------------------------------------
//
// A scenario is a plain `async (app) => { ... }`. It lists the drivers it runs
// on; `scenario()` expands to ONE real `it()` per driver, each gated/timed/torn
// down by that driver. The scenario file never mentions `canRunRealTmux`,
// timeouts, or `afterEach`.
//
// The `<const D>` capture (below) is what makes the typed-DSL real: it pins the
// literal driver tuple at the call site, so the `body`'s `app` parameter is
// typed to ONLY the surface shared by every listed driver. A `['model']`
// scenario cannot call `app.rightPane`; a `['model','screen']` scenario cannot
// call `app.resize`. These are compile errors (proven in `scenario.test-d.ts`),
// caught only because `tests-new/` is in the tsconfig `include` (D11).
//
// `scenario()` calls `it()` at module-eval time, so a file registers tests on
// import (CLAUDE.md rule 8 is deliberately scoped: this is the DSL's one
// registration point). The expansion is kept in the pure `expandScenario`
// helper so it is unit-testable and so the future overlap report has a stable
// shape to reason about without importing scenario files.

import { it } from 'bun:test'
import type {
  AppBase,
  DriverName,
  FullHostApp,
  LifecycleApp,
  ModelApp,
  ScreenApp,
} from './app-surfaces.ts'
import { DRIVERS } from './drivers/registry.ts'

// AppFor distributes over the driver union: `AppFor<'model' | 'screen'>` is
// `ModelApp | ScreenApp`, whose `keyof` is the COMMON keys only — that is what
// `SharedApp` relies on. (Do NOT collapse to `ModelApp & ScreenApp` via a
// UnionToIntersection helper: an intersection's key set is the UNION of keys,
// so `resize` would wrongly compile on a `['model','screen']` scenario.)
export type AppFor<D extends DriverName> = D extends 'model'
  ? ModelApp
  : D extends 'screen'
    ? ScreenApp
    : D extends `full-host:${string}`
      ? FullHostApp
      : D extends 'lifecycle'
        ? LifecycleApp
        : never

// The capabilities common to EVERY listed driver. `keyof AppFor<D[number]>`
// over the union of app surfaces yields only the shared keys; this mapped type
// is the whole trick.
export type SharedApp<D extends readonly DriverName[]> = {
  [K in keyof AppFor<D[number]>]: AppFor<D[number]>[K]
}

export interface ScenarioMeta<D extends readonly DriverName[]> {
  readonly name: string
  /** The literal tuple is captured by `<const D>`; see `scenario` below. */
  readonly drivers: D
  /** Stable feature prefix, e.g. `'follow-live'`. */
  readonly feature: string
  readonly risk?: string
  /** Ties a `model` test to its `screen` contract twin (overlap report). */
  readonly overlapGroup?: string
  /** Migration accounting — REQUIRED per case (D15). `[]` for born-new tests. */
  readonly oldTestRefs: readonly string[]
  readonly regressionRef?: string
  /** Opt-in to the heavier scriptedFake live-driven full-host submode (U2+). */
  readonly liveDriven?: boolean
}

/** One expanded `it()` a scenario would register — pure, for unit testing. */
export interface ScenarioCase {
  readonly label: string
  readonly driverName: DriverName
  readonly skip: boolean
}

/**
 * Pure expansion: map a scenario's `meta` to the cases it will register, with
 * each case's gate decided by its driver's `skip()` capability predicate.
 * No tests are registered and no driver is built by calling this.
 */
export function expandScenario<D extends readonly DriverName[]>(
  meta: ScenarioMeta<D>,
): readonly ScenarioCase[] {
  return meta.drivers.map((driverName) => ({
    label: `${meta.name} [${driverName}]`,
    driverName,
    skip: DRIVERS[driverName].skip(),
  }))
}

function registerCase<D extends readonly DriverName[]>(
  testCase: ScenarioCase,
  body: (app: SharedApp<D>) => Promise<void>,
  meta: ScenarioMeta<D>,
): void {
  const driver = DRIVERS[testCase.driverName]
  it.skipIf(testCase.skip)(
    testCase.label,
    async () => {
      const app: AppBase = await driver.build(meta)
      try {
        await body(app as unknown as SharedApp<D>)
      } finally {
        await app.teardown()
      }
    },
    driver.timeout,
  )
}

export function scenario<const D extends readonly DriverName[]>(
  meta: ScenarioMeta<D>,
  body: (app: SharedApp<D>) => Promise<void>,
): void {
  for (const testCase of expandScenario(meta)) {
    registerCase(testCase, body, meta)
  }
}
