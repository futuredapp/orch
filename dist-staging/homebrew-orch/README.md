# homebrew-orch

Homebrew tap for [**orch**](https://github.com/futuredapp/orch) — a code-first orchestrator for chaining coding-agent CLIs (Claude Code, Codex) into deterministic, resumable workflows.

## Install

```bash
brew tap futuredapp/orch
brew install orch
orch --help
```

The repository **must** be named `homebrew-orch` so the short `brew tap futuredapp/orch` form resolves (`brew` expands `<owner>/<name>` to `github.com/<owner>/homebrew-<name>`).

This installs a standalone binary — no Bun, Node, or TypeScript toolchain required. Upgrade with `brew upgrade orch`.

## How this tap is maintained

`Formula/orch.rb` is updated automatically by the orch release pipeline: when a `v*` tag is pushed to `futuredapp/orch`, the release workflow builds the per-platform binaries, publishes them as GitHub Release assets, recomputes their SHA256 from the released bytes, and runs `scripts/bump-formula.ts` to rewrite the formula's `url`, `sha256`, and `version` fields, then commits the result here.

Do not hand-edit the `url`/`sha256`/`version` fields — they are managed by that automation. See the orch repo's `docs/release-setup-guide.md` for the operator runbook (including cold-start and partial-failure recovery).
