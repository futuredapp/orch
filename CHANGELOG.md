# Changelog

## [0.1.1] - 2026-06-10

The first release that makes the Homebrew binary's two-pane TUI actually work.
On a standalone `bun build --compile` install, launching `orch run` crashed the
left (steps) pane with `Unknown command: /$bunfs/root/steps-view-runner.tsx` —
the binary has a single entrypoint, so re-spawning a child pane as a script
path was read as a CLI command. The launchers now re-enter through recognized
internal subcommands, and a new binary smoke-test layer catches this whole
class of binary-only bug that the `bun`-run suite structurally cannot see.
Rounding out the release: the Codex runner's version preflight moves onto
`ProcessService`, and the real-tmux integration suite is gated off PR CI behind
a single capability check.

### Fixes

- Fix the compiled (Homebrew) binary crashing the two-pane TUI on launch. The
  steps-view left pane and the `ask()` prompt are now launched by re-invoking
  the binary through internal `__steps-view` / `__ask` subcommands instead of
  handing it an embedded `/$bunfs/` script path, which a single-entrypoint
  binary cannot exec. A shared `embedded-child` argv builder keeps the launcher
  and dispatcher tied to one subcommand constant so the contract can't drift.
- Guard the embedded runner modules so they no longer self-execute at import
  time inside the binary, where doing so hijacked `--help`, `runs`, and every
  other command at startup.
- The Codex runner's version preflight check now runs through `ProcessService`
  instead of calling out directly, keeping all subprocess access on one seam.

### Features

- Add a binary smoke-test layer (`bun run test:binary-smoke`, wired into
  `check:release`) that builds the real `--compile` artifact and asserts the
  launch contract headlessly, plus a `bun run orch:binary` helper that builds
  and runs the binary exactly as a Homebrew user gets it.

### Documentation

- Document the Homebrew 5.1+ `brew trust` requirement for third-party taps in
  the README and getting-started guide.
- Capture the compiled-binary launch contract and binary smoke-testing
  learnings under `docs/solutions/`, and add the `orch-docs-updater` skill.

### Chores

- Gate the heavy two-pane host and rendering integration levels off PR CI and
  route all host-level skip predicates through a single `canRunRealTmux` check.
- Configure git identity and build a modern tmux in CI so the real integration
  levels can run.
- Document the PR-CI real-tmux gate and the runner environment-gap findings in
  the testing strategy.

[0.1.1]: https://github.com/futuredapp/orch/releases/tag/v0.1.1

## [0.1.0] - 2026-06-10

First public release of **orch** — a code-first TypeScript orchestrator for
chaining coding-agent CLIs (Claude Code, Codex with another customization options)
into deterministic, resumable workflows. This release makes
orch installable with no Bun or TypeScript toolchain on the user's machine: a
standalone, self-contained binary ships per platform, installable via a
Homebrew tap (`brew tap futuredapp/orch && brew install orch`) or as a direct
download from the GitHub Release, with `SHA256SUMS` for integrity verification.
The documentation site goes live on GitHub Pages alongside the release.

### Changes

- initial orch release with installation via Homebrew and workflow customization options

[0.1.0]: https://github.com/futuredapp/orch/releases/tag/v0.1.0
