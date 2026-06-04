---
name: testing-strategy
description: Three-layer testing strategy for the orch project. Use when writing any test in this repo. Enforces "mock only at the edge" rule — fakes go in via *Service ports, never via mock.module on internal modules.
---

# Testing Strategy

## The one rule

Mocks appear in exactly ONE place: at the boundary where the system meets something it doesn't own — a subprocess, git, the filesystem, tmux, or the clock. Those boundaries are `*Service` interfaces in `src/services/`. Tests inject a `Fake*Service` via constructor or parameter.

**Never use `mock.module()`, `jest.mock()`, or `vi.mock()` inside tests under `src/core/`, `src/state/`, `src/validators/`, or `src/runners/`.** If you feel the urge to mock an internal module, the architecture is wrong — fix the seam before writing the test.

## Three layers

| Layer | Uses real... | Uses fake... | Goal | Where |
|---|---|---|---|---|
| **Unit** | The module under test | Every port it touches | Prove one unit's logic; tight feedback | `tests/unit/**` |
| **Integration** | Several real modules, real fs/git | The outermost boundary only (process OR git — one at a time) | Prove modules compose; catch seam bugs | `tests/integration/**` |
| **E2E** | Everything, including real `claude`/`codex` | Nothing (env-gated) | Prove the whole thing works end-to-end | `tests/e2e/**` |

## Each runner is tested TWICE

Every `Runner` adapter (Claude, Codex, Aider, ...) needs BOTH:

1. **Mocked integration test** — `tests/integration/<name>-runner-mocked-process.test.ts`. Passes a `FakeProcessService` pre-scripted from a NDJSON fixture under `tests/fixtures/<name>/`. Runs on every `bun test`. Asserts: command shape, stream parsing, structured output extraction, exit detection.
2. **Real integration test** — `tests/integration/<name>-runner-real.integration.test.ts`. Spawns the actual CLI. Skipped automatically if `<name> --version` isn't on `$PATH`. Opt-in via `RUN_REAL_<NAME>=1`.

Same pattern for the full compound e2e flow: a `.mocked.test.ts` that runs always, plus an `.e2e.test.ts` gated by `RUN_REAL_E2E=1`.

## A good test reads like prose

```ts
// tests/unit/core/workflow-memoization.test.ts
import { describe, it, expect } from 'bun:test'
import { buildTestRun } from '@orch/test/build-test-run'
import { step } from '@orch/core/step'

describe('workflow memoization', () => {
  it('runs a step once and returns the cached value on the next invocation', async () => {
    // Arrange
    const run = buildTestRun()
    const PING = step.define('ping', { agent: run.fakeRunner({ returns: 'pong' }) })

    // Act
    const first = await run.exec(async (r) => await r(PING))
    const second = await run.exec(async (r) => await r(PING))

    // Assert
    expect(first).toBe('pong')
    expect(second).toBe('pong')
    expect(run.fakeRunner.invocationCount('ping')).toBe(1)
  })
})
```

Principles this demonstrates:

- **Name is a full sentence** — a human can understand the behavior without opening the code.
- **`buildTestRun()` hides plumbing, not intent** — one call wires every fake service.
- **Arrange-Act-Assert with blank lines** — no comments needed to explain what the code does.
- **Only fakes at boundaries** — no internal mocking anywhere.
- **Final assertion proves the behavior named in the title** — `invocationCount('ping') === 1` directly matches "runs a step once".

## Decision tree — which layer does this test belong in?

1. Testing pure logic that never touches I/O? → **Unit** with fake ports.
2. Testing that two or more real modules compose correctly? → **Integration (mocked edges)**.
3. Testing a `Runner` adapter against a real CLI? → Write TWO tests: mocked (always runs) + real (env-gated auto-skip).
4. Testing the full `brainstorm → plan → work → review` flow? → **E2E**, both `.mocked.test.ts` (always) and `.e2e.test.ts` (env-gated).

## Anti-patterns (these fail review)

- **Mocking `StateStore`, `Workflow`, or validators** — they're pure; use them directly.
- **Mocking `fs.readFile` or `child_process.spawn` directly** — inject `FsService` or `ProcessService` instead.
- **Shared `beforeEach` mutating module-level state** — each test builds its own world from scratch.
- **Asserting implementation details** ("called method X with args Y") when a behavioral assertion exists.
- **Test files over 300 lines** — split by scenario (one `describe` per file is fine).
- **Skipping a test layer because "the next one covers it"** — it doesn't; each layer proves a different thing.
- **Test name that isn't a sentence** — "test 1", "handles error", "works" all fail this rule.

## Helpers you should use

- `buildTestRun()` from `@orch/test/build-test-run` — wires fake services into a ready-to-use Workflow.
- `tempGitRepo()` from `@orch/test/temp-git-repo` — spins up a throwaway real git repo for integration tests.
- `assertMemoized()` from `@orch/test/assert-memoized` — custom matcher: did this step re-run or hit cache?

If a helper doesn't exist yet, create it in `tests/helpers/` rather than inlining setup into the test.

## Fakes and screen-level QA

Two agent doubles stand in for real `claude`/`codex`. Pick by whether the test drives the agent from inside or outside the orch process:

- **`FakeRunner`** (`src/runners/fake/`, public barrel) — in-process, script fixed at construction. The default for unit, mocked-integration, and the two-pane Tier 1/2 tests.
- **`scriptedFake`** (`src/runners/scripted-fake/`, dev-only deep import) — a subprocess fake an external driver advances step-by-step over a `.ready` → NDJSON → `.ack` control file. Only for Tier 5 lifecycle tests and the QA skill. It is *not* a flakiness remedy — for a known script `FakeRunner` is already deterministic and faster.

For **explicit** requests to QA / manually verify / smoke-test / reproduce two-pane TUI behavior on screen — or to reproduce a rendering/lifecycle bug — defer to the **`orch-qa-engineer`** skill, which drives `scriptedFake` end-to-end and produces a screenshot verdict report. It is not part of `bun run check` and does not replace tiered coverage. This skill stays focused on the three-layer "mock only at the edge" rule. Full tier model and the fake comparison: [`docs/testing-strategy.md`](../../../docs/testing-strategy.md).
