import { expect, it } from 'bun:test'
import { FakeProcessService } from '../../src/services/process/fake-process-service.ts'
import { paneId, RealTmuxService, socketName } from '../../src/services/tmux/index.ts'
import { RecordingProcessService } from '../_support/recording-process-service.ts'

// `tmux-argv` is a CATEGORY, not a `scenario()`: it is a plain unit test of
// `RealTmuxService` argv against a fake process service. It runs at unit speed
// and boots no tmux. This tracer proves the category works end-to-end and that
// the adapter passes metacharacters literally (via `-l`) with no shell
// interpretation — the exact escaping risk this category exists to guard.

it('send-keys passes a metacharacter payload literally via -l (no shell interpretation)', async () => {
  const socket = socketName('orch-argv-tracer')
  const target = paneId('%0')
  const payload = '$(rm -rf /)'

  const fake = new FakeProcessService()
  // Correctness backstop: an exact-argv match. A wrong flag would not match and
  // `spawn()` would throw — so this catches argv regressions even without the
  // positive assertions below.
  const expectedArgv = ['tmux', '-L', socket, 'send-keys', '-t', target, '-l', payload]
  fake.when(expectedArgv).respondWith({ exitCode: 0 })
  const recording = new RecordingProcessService(fake)
  const tmux = new RealTmuxService({ processService: recording })

  await tmux.sendKeys({ socket, target, keys: [payload] })

  const argv = recording.lastSpawnArgv()
  expect(argv).toContain('-l') // literal mode — tmux treats keys verbatim
  expect(argv).toContain(payload) // the metacharacters survive unescaped
  expect(argv).toEqual(expectedArgv)
})
