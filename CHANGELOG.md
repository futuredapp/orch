# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each release opens with a short prose summary of the most notable changes,
followed by `### Features` / `### Fixes` / `### Chores` groupings derived from
the conventional-commit type of each landed change (`feat` → Features, `fix` →
Fixes, `chore` → Chores). The `orch::generate-changelog` workflow reproduces
this structure from `git log`; see `workflows/generate-changelog/`.

## [0.1.0] - 2026-XX-XX

First public release of **orch** — a code-first TypeScript orchestrator for
chaining coding-agent CLIs (Claude Code, Codex, and anything wrapped as a
`Runner` adapter) into deterministic, resumable workflows. This release makes
orch installable with no Bun or TypeScript toolchain on the user's machine: a
standalone, self-contained binary ships per platform, installable via a
Homebrew tap (`brew tap futuredapp/orch && brew install orch`) or as a direct
download from the GitHub Release, with `SHA256SUMS` for integrity verification.
The documentation site goes live on GitHub Pages alongside the release.

### Features

- Standalone, self-contained binaries (`bun build --compile`) for
  `darwin-arm64`, `darwin-x64`, and `linux-x64` — no Bun required at runtime.
  User TypeScript workflows are dynamically imported and their bare `'orch'`
  imports resolve against the embedded API.
- Homebrew install path via the `futuredapp/homebrew-orch` tap, selecting the
  correct per-platform binary.
- Direct binary download path with a published `SHA256SUMS` asset for integrity
  verification before install.
- Published documentation site (VitePress) on GitHub Pages.
- `orch::generate-changelog` workflow that drafts this changelog from the commit
  history since the last version tag.

### Fixes

- The compiled binary embeds the built-in workflows (`orch::work-cc`,
  `orch::work-codex`) so they resolve and run with no Bun on `PATH`.

### Chores

- MIT license, public README, semantic versioning starting at `0.1.0`, and
  conventional-commit enforcement on pull requests.

[0.1.0]: https://github.com/futuredapp/orch/releases/tag/v0.1.0
