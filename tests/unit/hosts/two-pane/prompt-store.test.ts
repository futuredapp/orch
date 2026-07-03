// Unit coverage for the always-on per-step prompt store (R8 / U5). Real
// filesystem under a tmpdir — the store's whole job is to write a file rooted
// in `stateDir` (NOT in the logger's logsDir), so the file path it produces is
// the behaviour under test. No tmux, no logger.
//
// Triage: each test would fail if the store wrote to the wrong root, escaped or
// re-encoded the prompt body, or silently dropped a write — so it passes the
// "would this still pass if the behaviour were wrong?" gate.

import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { stepName } from '../../../../src/core/types.ts'
import {
  createPromptStore,
  promptStorePathFor,
  readPersistedPrompt,
} from '../../../../src/hosts/two-pane/prompt-store.ts'
import { path as toPath } from '../../../../src/services/types.ts'

const ESC = '\x1b'

describe('prompt-store — always-on per-step prompt sink', () => {
  it('writes the prompt to agents/<step>/prompt.txt rooted in stateDir, not logsDir', async () => {
    const dir = await mkdtemp('/tmp/orch-prompt-store-')

    const store = createPromptStore(toPath(dir))
    await store.write(stepName('plan'), 'assemble me')

    const written = await readFile(`${dir}/agents/plan/prompt.txt`, 'utf8')
    expect(written).toBe('assemble me')
    // The path helper agrees with where the bytes actually landed.
    expect(promptStorePathFor(toPath(dir), stepName('plan'))).toBe(
      toPath(`${dir}/agents/plan/prompt.txt`),
    )

    await rm(dir, { recursive: true, force: true })
  })

  it('persists the RAW prompt verbatim — control bytes are neither escaped nor stripped at store time', async () => {
    const dir = await mkdtemp('/tmp/orch-prompt-store-')
    const raw = `do the thing ${ESC}[2J with café / 日本語 / 🎉`

    const store = createPromptStore(toPath(dir))
    await store.write(stepName('plan'), raw)

    // Escaping/marking is a DISPLAY concern (prompt-preamble.ts); the store
    // keeps the body verbatim so a future display change is not a migration.
    const persisted = await readPersistedPrompt(toPath(dir), stepName('plan'))
    expect(persisted).toBe(raw)

    await rm(dir, { recursive: true, force: true })
  })

  it('overwrites a prior write for the same step (idempotent per step, like the tee)', async () => {
    const dir = await mkdtemp('/tmp/orch-prompt-store-')

    const store = createPromptStore(toPath(dir))
    await store.write(stepName('plan'), 'first attempt')
    await store.write(stepName('plan'), 'retried attempt')

    expect(await readPersistedPrompt(toPath(dir), stepName('plan'))).toBe('retried attempt')

    await rm(dir, { recursive: true, force: true })
  })

  it('reads back null for a step that was never persisted', async () => {
    const dir = await mkdtemp('/tmp/orch-prompt-store-')

    expect(await readPersistedPrompt(toPath(dir), stepName('never-ran'))).toBeNull()

    await rm(dir, { recursive: true, force: true })
  })
})
