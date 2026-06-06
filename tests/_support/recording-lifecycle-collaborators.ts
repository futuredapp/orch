// ---------------------------------------------------------------------------
// Recording fakes for LifecycleChoreographer unit tests.
// ---------------------------------------------------------------------------
//
// The choreographer drives two collaborators — a `RightPaneController` and a
// `PerStepTee`. Its payload is the *ordering* of calls across both (e.g.
// "unregisterSource BEFORE tee.close"), so both fakes push into one shared,
// ordered `calls` log. This is the repo's first recording
// `FakeRightPaneController`; it is deliberately reusable by future right-pane
// tests.

import type { PerStepTee } from '../../src/hosts/plain/per-step-tee.ts'
import type { RightPaneController } from '../../src/hosts/two-pane/pane-map/index.ts'

type RegisterArgs = Parameters<RightPaneController['registerSource']>
type UnregisterArgs = Parameters<RightPaneController['unregisterSource']>
type BannerArg = Parameters<RightPaneController['emitBanner']>[0]

/** One recorded collaborator call. `on` names the collaborator; `method` the
 *  call; `label` is `"<on>.<method>"` for terse sequence assertions. */
export type RecordedCall =
  | {
      readonly on: 'tee'
      readonly method: 'open'
      readonly label: 'tee.open'
      readonly step: string
    }
  | {
      readonly on: 'tee'
      readonly method: 'write'
      readonly label: 'tee.write'
      readonly step: string
      readonly payload: string
    }
  | {
      readonly on: 'tee'
      readonly method: 'close'
      readonly label: 'tee.close'
      readonly step: string
    }
  | {
      readonly on: 'controller'
      readonly method: 'registerSource'
      readonly label: 'controller.registerSource'
      readonly key: RegisterArgs[0]
      readonly spec: RegisterArgs[1]
    }
  | {
      readonly on: 'controller'
      readonly method: 'unregisterSource'
      readonly label: 'controller.unregisterSource'
      readonly key: UnregisterArgs[0]
      readonly options: UnregisterArgs[1]
    }
  | {
      readonly on: 'controller'
      readonly method: 'emitBanner'
      readonly label: 'controller.emitBanner'
      readonly banner: BannerArg
    }

/**
 * Decide whether a given controller call should reject. `method` is the call
 * name, `callCount` is the 1-based count of calls to that method so far
 * (including this one). Return an error to reject with, or `undefined` to let
 * the call resolve.
 */
export type RejectionPlan = (method: string, callCount: number) => unknown | undefined

export interface RecordingCollaborators {
  readonly calls: RecordedCall[]
  /** `calls` reduced to the ordered `label` sequence — handy for assertions. */
  labels(): string[]
  readonly controller: RightPaneController
  readonly tee: PerStepTee
}

export function createRecordingCollaborators(
  opts: { readonly reject?: RejectionPlan } = {},
): RecordingCollaborators {
  const calls: RecordedCall[] = []
  const counts = new Map<string, number>()

  const maybeReject = (method: string): Promise<void> => {
    const next = (counts.get(method) ?? 0) + 1
    counts.set(method, next)
    const err = opts.reject?.(method, next)
    return err !== undefined ? Promise.reject(err) : Promise.resolve()
  }

  const tee: PerStepTee = {
    open(step): void {
      calls.push({ on: 'tee', method: 'open', label: 'tee.open', step })
    },
    write(step, ansi): void {
      calls.push({ on: 'tee', method: 'write', label: 'tee.write', step, payload: ansi })
    },
    close(step): void {
      calls.push({ on: 'tee', method: 'close', label: 'tee.close', step })
    },
    async drain(): Promise<void> {
      /* no-op */
    },
  }

  const controller: RightPaneController = {
    onIntent(): void {
      /* unused by the choreographer */
    },
    async registerSource(key, spec): Promise<void> {
      calls.push({
        on: 'controller',
        method: 'registerSource',
        label: 'controller.registerSource',
        key,
        spec,
      })
      await maybeReject('registerSource')
    },
    async showSource(): Promise<void> {
      /* unused */
    },
    async unregisterSource(key, options): Promise<void> {
      calls.push({
        on: 'controller',
        method: 'unregisterSource',
        label: 'controller.unregisterSource',
        key,
        options,
      })
      await maybeReject('unregisterSource')
    },
    async followLive(): Promise<void> {
      /* unused */
    },
    getPaneId(): undefined {
      return undefined
    },
    async emitBanner(banner): Promise<void> {
      calls.push({ on: 'controller', method: 'emitBanner', label: 'controller.emitBanner', banner })
      await maybeReject('emitBanner')
    },
    async setViewMode(): Promise<void> {
      /* unused */
    },
    async stop(): Promise<void> {
      /* unused */
    },
    async teardownSessions(): Promise<void> {
      /* unused */
    },
  }

  return {
    calls,
    labels: () => calls.map((c) => c.label),
    controller,
    tee,
  }
}
