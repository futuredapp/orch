# orch

A code-first TypeScript orchestrator for chaining coding-agent CLIs — Claude Code, Codex, and anything else wrapped as a `Runner` adapter — through deterministic, resumable workflows.

You write the workflow as a plain async function; `orch` handles process lifecycle, typed data handoffs between steps, tmux observability, human-in-the-loop escalation, artifact validation, and crash-resume via name-keyed memoization.

> **Status: Phase 0 scaffold only.** The workflow DSL, runners, validators, CLI, and tmux layer are not yet implemented. See [`docs/plans/implementation-phases.md`](docs/plans/implementation-phases.md) for the phased roadmap.

## Prerequisites

- [Bun](https://bun.com) ≥ 1.2
- `jq` (for the Claude Code hook script)
- `tmux` (for observability, added in a later phase)
- `claude` CLI (for real Claude runs, added in Phase 5)
- `codex` CLI ≥ 0.118.0 (for real Codex runs, added in Phase 9)

## Quick start

```bash
bun install
bun run check     # lint + typecheck + tests
```

### Install in another project

`orch` is consumed in host projects via `bun link`:

```bash
# One-time, from this repo:
cd claude-orchestration
bun link

# Then in any host project:
cd ~/your-project
bun link orch
orch init                 # scaffolds .orch/ with a hello-world workflow
orch run hello            # runs the scaffolded workflow

# Add more workflows on demand:
orch new my-feature
```

`orch init` writes `.orch/orch.config.ts`, `.orch/steps.ts`,
`.orch/workflows/hello.ts`, and an empty `.orch/state/` directory, and
appends `.orch/state/` to `.gitignore`. Re-running `orch init` over an
existing `.orch/` prompts before touching anything.

Individual gates:

```bash
bun run lint        # biome check
bun run lint:fix    # biome check --write
bun run format      # biome format --write
bun run typecheck   # tsc --noEmit
bun run test        # bun test (unit + mocked integration)
bun run test:unit   # unit tests only
bun run test:int    # integration tests only
bun run test:e2e    # full e2e (real CLIs, env-gated)
```

Real-CLI integration and e2e tests are opt-in via env vars:

```bash
RUN_REAL_CLAUDE=1 bun run test:int
RUN_REAL_CODEX=1  bun run test:int
RUN_REAL_E2E=1    bun run test:e2e
```

## Documentation

User-facing documentation lives under [`docs/public/`](docs/public/) and is published as a VitePress site — guide pages, how-to recipes, an API/CLI/config reference, and an indexed tour of [`examples/`](examples/). Build it locally:

```bash
bun run docs:dev      # local dev server with hot reload
bun run docs:build    # production build — fails on any dead internal link
bun run docs:preview  # serve the built site
```

`bun run docs:build` is the docs correctness gate (dead-link detection). When editing or adding pages, load the **`doc-writer`** skill — it codifies the conventions (one concept per page, runnable examples with imports shown, reference signatures quoted from `src/`).

Internal documentation (not published):

- [`docs/plans/implementation-phases.md`](docs/plans/implementation-phases.md) — the phased roadmap (Phase 0 → Phase 16).
- [`docs/brainstorms/2026-04-08-claude-orchestrator-brainstorm.md`](docs/brainstorms/2026-04-08-claude-orchestrator-brainstorm.md) — the original design brainstorm with audited CLI recipes and architectural decisions.
- [`docs/getting-started.md`](docs/getting-started.md) — older walkthrough of the planned API (decision review, superseded by `docs/public/`).
- [`CLAUDE.md`](CLAUDE.md) — non-negotiable project rules.

## Contributing

Before writing code, load the relevant skill from `.claude/skills/`:

- **`phase-implementer`** — how to pick up and land a phase from the plan.
- **`testing-strategy`** — three-layer testing (unit / integration / e2e) and the "mock only at the edge" rule.
- **`runner-author`** — how to add a new `Runner` adapter for a new CLI.
- **`doc-writer`** — how to maintain the user docs under `docs/public/`.

Every PR must pass `bun run check` before landing.

## License

Unlicensed while in early development.
