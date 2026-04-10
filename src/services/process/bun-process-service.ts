import type { ProcessService, SpawnHandle, SpawnOptions } from './process-service.ts'

export class BunProcessService implements ProcessService {
  spawn(_opts: SpawnOptions): SpawnHandle {
    throw new Error('not implemented')
  }
}
