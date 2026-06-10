# orch

A code-first TypeScript orchestrator for chaining coding-agent CLIs — Claude Code, Codex, and anything else wrapped as a `Runner` adapter — through deterministic, resumable workflows.

You write the workflow as a plain async function; `orch` handles process lifecycle, typed data handoffs between steps, tmux observability, human-in-the-loop escalation, artifact validation, and crash-resume via name-keyed memoization.

## Install

### Homebrew (macOS & Linux) — recommended

```bash
brew tap futuredapp/orch
brew install orch
orch --help
```

This installs a standalone binary. **No Bun, Node, or TypeScript toolchain is required** — the runtime is embedded in the binary, and your TypeScript workflows are imported and run directly.

Upgrade later with `brew upgrade orch`.

### Direct binary download (Linux & macOS)

Each [GitHub Release](https://github.com/futuredapp/orch/releases/latest) publishes a binary per platform plus a `SHA256SUMS` file:

- `orch-darwin-arm64` — macOS, Apple Silicon
- `orch-darwin-x64` — macOS, Intel
- `orch-linux-x64` — Linux, x86-64

Download the asset for your platform and the `SHA256SUMS`, then **verify integrity before doing anything else** with the file:

```bash
# Linux
sha256sum --ignore-missing -c SHA256SUMS
# macOS
shasum -a 256 --ignore-missing -c SHA256SUMS
```

Only once the checksum line prints `OK`, make it executable and put it on your `PATH`:

```bash
chmod +x orch-linux-x64
mv orch-linux-x64 /usr/local/bin/orch
orch --help
```

On **macOS**, a directly downloaded binary is quarantined by Gatekeeper (the binary is unsigned). After — and only after — the checksum has matched, clear the quarantine attribute:

```bash
xattr -d com.apple.quarantine ./orch-darwin-arm64
```

This bypasses macOS's origin/tamper check, so it must come *after* you have verified the `SHA256SUMS` checksum, never before. Homebrew installs are unaffected by this (a tap **formula** does not get the quarantine attribute).

## Usage

```bash
orch init                 # scaffold .orch/ with a hello-world workflow
orch run hello            # run the scaffolded workflow
orch new my-feature       # create a new workflow under .orch/workflows/
orch run my-feature       # run it
orch runs                 # list recent runs
orch logs --latest        # stream the most recent run's transcript
```

`orch init` writes `.orch/orch.config.ts`, `.orch/steps.ts`, `.orch/workflows/hello.ts`, and an empty `.orch/state/` directory, and appends `.orch/state/` to `.gitignore`. Re-running `orch init` over an existing `.orch/` prompts before touching anything.

A minimal workflow is a plain async function that runs steps and passes typed data between them:

```ts
// .orch/workflows/my-feature.ts
import { workflow } from 'orch'
import { WRITE_NOTES } from '../steps.ts'

export default workflow('my-feature', async (run) => {
  const result = await run(WRITE_NOTES)
  console.log(`step exited with ${result.exitCode}`)
})
```

Running real Claude Code or Codex steps requires the corresponding CLI (`claude`, `codex`) on your `PATH`; deterministic `command` steps need nothing extra.

## Documentation

Full documentation — guide, how-to recipes, an API/CLI/config reference, and an indexed tour of [`examples/`](examples/) — is published at:

**<https://futuredapp.github.io/orch/>**

## Local development & testing

Contributing to orch itself (not just using it) needs the source toolchain.

### Prerequisites

- [Bun](https://bun.com) ≥ 1.2
- `jq` (for the Claude Code hook script)
- `tmux` (for two-pane observability)
- `claude` CLI (for real Claude runs)
- `codex` CLI ≥ 0.118.0 (for real Codex runs)

### From a clone

```bash
bun install
bun run check     # the gate: lint + typecheck + all tests (except real-agent)
```

Individual gates:

```bash
bun run lint              # biome check
bun run lint:fix          # biome check --write
bun run format            # biome format --write
bun run typecheck         # tsc --noEmit
bun run check             # lint + typecheck + all tests (except real-agent)
bun run check:release     # everything, incl. gated real-CLI levels (which claude codex first)

bun run test:two-pane:fast    # tight two-pane loop: model + tmux-argv (ms, no tmux) — the default
bun run test:two-pane:tmux    # screen + full-host on real tmux (bounded concurrency)
bun run test:two-pane:lifecycle  # process behaviour, serial
bun run test                  # the whole project (legacy tree + new tree + two-pane)
```

Selection is **by path only** — never run bare `bun test` (it ignores the concurrency ceiling; a preload warns you). Real-CLI levels are opt-in via env vars:

```bash
RUN_REAL_CLAUDE=1   bun run test:int
RUN_REAL_CODEX=1    bun run test:int
RUN_REAL_E2E=1      bun run test:e2e:real
RUN_REAL_TMUX_E2E=1 bun run test:two-pane:full:real
```

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) — the PR gate runs `commitlint` over the PR's commit range. Build the docs site locally with `bun run docs:dev` (hot reload) or `bun run docs:build` (production build; fails on any dead internal link). Before writing code, load the relevant skill from `.claude/skills/` (`phase-implementer`, `testing-strategy`, `runner-author`, `doc-writer`). Every PR must pass `bun run check` before landing.

## License

[MIT](LICENSE) © futuredapp
