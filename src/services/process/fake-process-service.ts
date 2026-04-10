import type { ProcessService, SpawnHandle, SpawnOptions } from './process-service.ts'

export interface FakeResponse {
  readonly stdout?: readonly string[]
  readonly stderr?: readonly string[]
  readonly exit: number
}

export class FakeProcessService implements ProcessService {
  when(_argv: readonly string[]): { respondWith(response: FakeResponse): void } {
    throw new Error('not implemented')
  }

  spawn(_opts: SpawnOptions): SpawnHandle {
    throw new Error('not implemented')
  }
}
