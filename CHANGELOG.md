# Changelog

## [1.2.3] - 2026-06-12

A redesigned two-pane TUI plus two behaviour changes from feedback. The steps
pane gets a visual overhaul and full keyboard navigation, text is now
selectable for copy/paste, and bare mode is no longer the default.

### Features

- Redesign the steps-view left pane: live header with a `▶ LIVE` pill,
  progress line, full-row selection highlight, an overflow scrollbar, and a
  two-zone footer.
- Add keyboard navigation across the two-pane TUI — Tab switches pane focus
  (cyan active border), and the `ask()` form is fully keyboard-driven.
- Make pane text selectable so output can be copied and pasted.

### Changes

- Bare mode is no longer the default; opt in explicitly when you want it.

### Chores

- Internal refactor and test cleanup: split the steps-view components, extract
  a pure keymap, and replace fixed-sleep test patterns with poll-until-condition.

[1.2.3]: https://github.com/futuredapp/orch/releases/tag/v1.2.3

## [0.1.2] - 2026-06-10

A release-pipeline fix plus automatic docs deployment. The `v0.1.1` tag build
failed in the `check` job even though the matching develop→main PR was green:
the release workflow's `check` job was a hand-copied near-duplicate of the PR
gate that had silently drifted — it never built modern tmux, configured a git
identity, or set `ORCH_DISABLE_REAL_TMUX`, so the real-tmux and real-git
integration levels that pass on PRs failed on the tag (`tmux split-window …
size missing` on the ubuntu-24.04 stock tmux 3.4 regression, and an "Author
identity unknown" commit failure). The PR and release gates are now a single
reusable workflow that cannot diverge again.

### Features

- Deploy the VitePress docs site automatically after a release publishes. The
  standalone docs workflow is folded into a `deploy-docs` job gated on the
  release `publish` step, so the live site is only ever updated for a version
  that actually shipped — never on a bare push to `main`.

### Fixes

- Unify the PR and release check gates into one reusable
  `.github/workflows/check.yml` (`workflow_call`) that both `pr.yml` and
  `release.yml` invoke. The release gate now inherits the modern-tmux build,
  git-identity configuration, and `ORCH_DISABLE_REAL_TMUX` accommodations the PR
  gate already had, fixing the tag-only `check` failure.

### Chores

- Split the docs dead-link build and commit-message lint into their own `docs`
  and `commitlint` PR jobs. Branch protection now requires the `check / check`,
  `docs`, and `commitlint` contexts (see the release setup guide, B5).

[0.1.2]: https://github.com/futuredapp/orch/releases/tag/v0.1.2

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
