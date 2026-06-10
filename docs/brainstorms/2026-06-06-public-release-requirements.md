---
date: 2026-06-06
topic: orch-public-release
---

# orch Public Release

## Summary

Package `orch` for public distribution: publish the repository with standard open-source hygiene (MIT license, protected branches, rewritten README), build compiled standalone binaries per platform, ship via a Homebrew tap and GitHub Releases, deploy docs to GitHub Pages, and add a changelog workflow that dogfoods `orch` itself to generate release notes.

---

## Spike Findings (2026-06-06) — binary packaging gate is GREEN

The prerequisite spike for all binary work (R5–R10) has been run and **passed**: a `bun build --compile` standalone binary, with **no Bun and no `node_modules` on `PATH`**, scaffolds (`orch init`), dynamically imports the user's `orch.config.ts` → workflow → `../steps.ts` chain, resolves their bare `'orch'` imports, and runs a workflow to completion. The clean `brew install orch` → standalone-binary path is viable — **no Bun prerequisite, no `bunx` wrapper** (Path A, not the fallback). Full write-up: [`docs/issues/2026-06-06-spike-compile-dynamic-import.md`](../issues/2026-06-06-spike-compile-dynamic-import.md).

The spike surfaced **two build-side snags** that a naive `bun build --compile src/cli/main.ts` hits; both are fixed in the artifact the maintainer ships (neither pushes work onto the user):

1. **Bare `'orch'` doesn't resolve in a binary.** User workflows are imported at runtime from disk and do `import { workflow } from 'orch'`; a brew binary has no `node_modules/orch`. **Fix:** a runtime `Bun.plugin` resolver mapping `'orch'` → the embedded public API, registered in a new compiled-binary entrypoint `src/cli/bin.ts` (with `main()` now `export`ed from `main.ts`; the `bunx orch` / `bun link` dev path is unchanged).
2. **ink pulls in `react-devtools-core`, which `--compile` can't bundle.** Bun eagerly resolves ink's dev-only dynamic import; `--external` and `--define DEV=false` don't fix it. **Fix:** a build-time stub plugin, which requires building via the `Bun.build` JS API (`scripts/build-binary.ts`), not the `bun build --compile` CLI.

Artifacts produced (ready to fold into implementation): `scripts/build-binary.ts` (per-platform compile, takes `--target`/`--outfile`), `src/cli/bin.ts`, `scripts/spike/run-spike.sh` (end-to-end gate), `tests/e2e/compile-binary-dynamic-import.spike.test.ts` (`RUN_SPIKE=1`-gated, off the `bun run check` gate).

**Open carry-over:** only the host target (`darwin-arm64`) was compiled; `darwin-x64` and `linux-x64` must still be built and smoke-tested on their native OS in CI before R5–R10 sign-off. Binary size ≈ 59 MB (embedded runtime). The resolver embeds orch's **public** API only — workflows that deep-import dev-only modules (e.g. `scriptedFake`) won't run from a shipped binary.

---

## Problem Frame

`orch` is currently private and only usable by developers who clone the repository and run it via `bun link` or `bunx orch`. There is no install path for people who want to use it as a general CLI tool outside a TypeScript project, and no public documentation site. To grow adoption beyond the immediate development circle, the project needs a clean install story (`brew install orch`), standard open-source repository hygiene, and documentation that explains what it does and how to start — all without requiring users to know anything about Bun or TypeScript tooling.

---

## Actors

- A1. **End user**: a developer using `orch` to orchestrate coding-agent CLIs in any language project. No Bun or TypeScript knowledge required.
- A2. **Maintainer**: the project owner who cuts releases, generates release notes, and manages the tap formula.
- A3. **GitHub Actions CI**: automated pipelines that build binaries, deploy docs, and bump the Homebrew formula on each release.

---

## Key Flows

- F1. **End user installs orch**
  - **Trigger:** A developer wants to install `orch` on their machine.
  - **Actors:** A1
  - **Steps:** `brew tap <maintainer>/orch` → `brew install orch` → verify with `orch --help`
  - **Outcome:** `orch` is available system-wide; the user never needed to install Bun.
  - **Covered by:** R5, R6, R7, R8, R9, R10

- F2. **Maintainer cuts a release**
  - **Trigger:** A2 is ready to ship a new version.
  - **Actors:** A2, A3
  - **Steps:** Run the changelog orch workflow to generate release notes → verify `CHANGELOG.md` contains an entry for the version being released → merge `develop` into `main` → push a `v*` tag → A3 builds platform binaries and creates a GitHub Release → A3 auto-bumps the formula in `homebrew-orch`
  - **Outcome:** New version available via `brew upgrade orch` and as a direct binary download; `CHANGELOG.md` updated.
  - **Covered by:** R15, R14, R16, R17, R18, R19

- F3. **Docs deploy**
  - **Trigger:** Push to `main`.
  - **Actors:** A3
  - **Steps:** CI detects the push → runs `bun run docs:build` → deploys output to GitHub Pages
  - **Outcome:** Public docs site updated at `https://<maintainer>.github.io/orch`.
  - **Covered by:** R15

---

## Requirements

**Repository hygiene**

- R1. The repository is made public on GitHub.
- R2. A `LICENSE` file with the MIT license text is committed to the repository root.
- R3. `main` is the stable branch (protected: no direct push, merges only); `develop` is the integration branch and default target for pull requests.
- R3a. `v*` tags may only be pushed by the designated maintainer; force-push and deletion are blocked on both `main` and all `v*` tags.
- R3b. Before publishing `v0.1.0`, a pre-release check verifies that `orch` is not already claimed in Homebrew core, the npm registry, or any conflicting trademark that would block distribution under the name.

**README**

- R4. The README is rewritten for a public audience covering: what `orch` is and does, installation instructions (brew), usage examples showing common `orch` invocations, a link to the docs site, a local development and testing guide, and a direct binary download path for Linux (download binary from GitHub Releases, place on `PATH`).

**Packaging and distribution**

- R5. `bun build --compile` produces self-contained platform binaries for: macOS arm64, macOS x64, and Linux x64.
- R6. Each GitHub Release includes the platform binaries as downloadable assets with consistent, platform-identifiable names.
- R7. TypeScript workflow files in `.orch/workflows/` continue to work correctly when `orch` is installed from Homebrew — the compiled binary's embedded Bun runtime handles dynamic TypeScript imports without the user needing to install Bun separately.

**Homebrew tap**

- R8. A separate `homebrew-orch` GitHub repository is created to host the Homebrew formula.
- R9. Users can install via: `brew tap <maintainer>/orch` followed by `brew install orch`.
- R10. The Homebrew formula selects and downloads the correct platform binary from the GitHub Release based on the user's OS and CPU architecture.

**GitHub Actions pipelines**

- R11. A **PR workflow** triggers on every pull request opened or updated (targeting `develop` or `main`): runs the full test suite (`bun run check` — lint, typecheck, unit tests, and mocked integration tests) and `bun run docs:build` to catch dead documentation links; enforces conventional commits via commitlint (`@commitlint/config-conventional`). Real CLI runs (`RUN_REAL_CLAUDE`, `RUN_REAL_CODEX`, `RUN_REAL_E2E`) are never enabled in CI. The PR cannot be merged until this workflow passes. Declares `permissions: contents: read`.
- R11a. All third-party GitHub Actions used across all workflows are pinned to their full commit SHA rather than a mutable tag or branch name.
- R13. A **release workflow** triggers on `v*` tags pushed to `main`: verifies `CHANGELOG.md` contains an entry for the tag version, runs `bun run check`, then builds platform binaries (macOS arm64, macOS x64, Linux x64), computes SHA256 checksums from the uploaded assets, and attaches both the binaries and a checksums file to a GitHub Release. Declares `permissions: contents: write`.
- R14. After the release workflow succeeds, an automated step pushes a formula update to `homebrew-orch` with the new binary download URLs and SHA256 checksums computed from the uploaded GitHub Release assets. The CI credential for this push is a fine-grained GitHub personal access token scoped to the `homebrew-orch` repository only.
- R15. A **docs pipeline** triggers on every push to `main`: runs `bun run docs:build` and deploys the output to GitHub Pages. Declares `permissions: pages: write, id-token: write`.

**Changelog and versioning**

- R16. A `CHANGELOG.md` file is committed to the repository root.
- R17. An orch workflow reads git commits (conventional commits format: `feat:`, `fix:`, `chore:`, etc.) for a specified commit range and generates or updates `CHANGELOG.md` entries for a given release; the maintainer runs this workflow manually before cutting a release tag. The `v0.1.0` changelog entry is a prose summary of the most notable features, not a commit-by-commit list.
- R18. The project uses semantic versioning; the initial public release is `v0.1.0`.
- R19. The `package.json` version field tracks the current version and must match the release tag; `private: true` is removed before the first public release. A `v*` tag on `main` triggers the release pipeline.

---

## Acceptance Examples

- AE1. **Covers R7, R9, R10.** Given a fresh macOS arm64 machine with Homebrew installed but no Bun: when the user runs `brew tap <maintainer>/orch && brew install orch` and then invokes `orch run hello` against a TypeScript workflow file, the workflow executes successfully and `orch` never prompts the user to install Bun.

- AE2. **Covers R13, R14.** Given the maintainer pushes tag `v0.2.0` to `main`: when the release pipeline completes, the GitHub Release for `v0.2.0` includes one binary asset per platform, and `homebrew-orch` has a new commit updating the formula's download URL and SHA256 for each platform.

- AE3. **Covers R11.** Given a PR is opened with a failing unit test: when the PR workflow runs, it fails and GitHub marks the PR as not mergeable until the test is fixed. `RUN_REAL_CLAUDE`, `RUN_REAL_CODEX`, and `RUN_REAL_E2E` are never set — only `bun run check` runs.

- AE4. **Covers R16, R17.** Given the maintainer runs the changelog orch workflow with the full commit range before tagging `v0.1.0`: the workflow produces a `CHANGELOG.md` entry that groups changes by type (`feat`, `fix`, `chore`) and opens with a short prose summary of the most notable features; the maintainer can publish the entry with at most minor editing.

---

## Success Criteria

- A developer with no TypeScript or Bun experience can install `orch` and run their first workflow using only the README and `brew`.
- The release pipeline is fully automated: pushing a `v*` tag is the only manual step required to ship binaries and update the Homebrew formula.
- The docs site is live at the GitHub Pages URL immediately after the first push to `main`.
- The changelog workflow produces output the maintainer can publish with at most minor editing.

---

## Scope Boundaries

- npm / `bun add -g orch` distribution channel — deferred, not part of this release
- homebrew-core official formula — requires broader adoption; deferred
- Linux package managers (apt, yum, pacman) — not in scope
- Windows support — not in scope
- Changes to orchestration logic, runner behavior, or workflow DSL — strictly out of scope; this release covers packaging and distribution only
- Automated changelog commits on every CI run — the changelog workflow is maintainer-invoked before a release, not a continuous CI step

---

## Key Decisions

- **Standalone binary over Bun-as-prerequisite:** `bun build --compile` embeds the Bun runtime so users never need Bun installed. The embedded runtime retains the ability to dynamically import user TypeScript workflow files, preserving the TS workflow authoring experience without any extra user setup. **Verified by the spike** (see Spike Findings) — but the binary requires two additions over a bare CLI compile: a compiled-binary entrypoint (`src/cli/bin.ts`) that registers a runtime resolver for the bare `'orch'` specifier, and a `Bun.build`-API build script (`scripts/build-binary.ts`) that stubs ink's `react-devtools-core` import.
- **Separate `homebrew-orch` repo:** Keeps release-bump commits (CI updating SHA256/URLs) out of the main repo's history. The short `brew tap <maintainer>/orch` command also requires the tap repo be named `homebrew-orch`.
- **`develop` as the integration branch:** Protects `main` from direct pushes while maintaining a clean release path. PRs target `develop`; releases are cut by merging `develop` → `main` and tagging.
- **Conventional commits as changelog input:** The orch changelog workflow needs machine-readable commit messages. Conventional commits (`feat:`, `fix:`, etc.) is the minimal convention that makes structured parsing tractable.
- **Changelog workflow dogfoods orch:** The changelog generator is itself an orch workflow — a real usage example shipped with the project and used by the maintainer at release time.

---

## Dependencies / Assumptions

- ~~`bun build --compile` supports dynamic `import()` of external TypeScript files from the filesystem at runtime via the embedded Bun runtime. This must be verified via a runnable test script confirming the behavior before R5–R10 are implemented; the spike is the prerequisite gate for all binary packaging work.~~ **VERIFIED (2026-06-06)** — see Spike Findings above and [`docs/issues/2026-06-06-spike-compile-dynamic-import.md`](../issues/2026-06-06-spike-compile-dynamic-import.md). Gate is GREEN; two build-side fixes captured as artifacts.
- Conventional commits discipline is adopted for all commits going forward to give the changelog workflow structured input.
- GitHub Pages is enabled for the public repository (free for public repos on GitHub).
- The maintainer has access to create the `homebrew-orch` repository under the same GitHub account or organization as the main `orch` repo.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R13, R14][Technical] ~~What tooling builds cross-platform binaries in CI — a custom GitHub Actions matrix or an existing release orchestration tool?~~ **Resolved by the spike:** `scripts/build-binary.ts` already takes `--target`/`--outfile`, so a GitHub Actions matrix calling it with `bun-darwin-arm64` / `bun-darwin-x64` / `bun-linux-x64` is the path — no GoReleaser equivalent needed. **Still open:** only `darwin-arm64` was actually compiled on this host; each target must be built and smoke-tested on its native OS runner in CI before R5–R10 sign-off (cross-compiled binaries should be run, not assumed).
- [Affects R17][Technical] Does the changelog orch workflow call a Claude runner to summarize and group commits, or does it do structured parsing only? Determines how the workflow is authored and which runners it depends on.
- [Affects R10][Needs research] Does the Homebrew formula use `on_arm` / `on_intel` DSL blocks or a single URL with runtime arch detection to select the right binary? Verify against current Homebrew formula authoring conventions before writing the formula.
