// A test-side `ProcessService` that records every spawned argv and delegates to
// an inner service (usually a `FakeProcessService`). It exists so `tmux-argv`
// tests can make a readable POSITIVE assertion (`argv` contains `-l`) instead of
// only the exact-match `when([...]).respondWith()` correctness backstop. This is
// test infrastructure only — it makes no `src/services` change (K3).

import type {
  ForegroundHandle,
  ProcessService,
  SpawnHandle,
  SpawnOptions,
} from '../../src/services/process/process-service.ts'

export class RecordingProcessService implements ProcessService {
  readonly spawns: SpawnOptions[] = []
  readonly foregroundSpawns: SpawnOptions[] = []

  constructor(private readonly inner: ProcessService) {}

  spawn(opts: SpawnOptions): SpawnHandle {
    this.spawns.push(opts)
    return this.inner.spawn(opts)
  }

  spawnForeground(opts: SpawnOptions): ForegroundHandle {
    this.foregroundSpawns.push(opts)
    return this.inner.spawnForeground(opts)
  }

  /** The argv of the most recent `spawn()` call. Throws if none yet. */
  lastSpawnArgv(): readonly string[] {
    const last = this.spawns[this.spawns.length - 1]
    if (last === undefined) {
      throw new Error('RecordingProcessService: no spawn recorded yet')
    }
    return last.argv
  }
}
