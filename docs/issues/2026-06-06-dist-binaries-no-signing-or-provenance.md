---
date: 2026-06-06
status: open
area: distribution, release pipeline
type: security
recommendation: consider
dependency-category: external
---

# Distributed binaries have no code signing or SLSA provenance

## Problem

The current release requirements (R6, R10, R13) specify platform binaries attached to GitHub Releases and a Homebrew formula that downloads them by URL, but contain no requirement for:

- **Code signing** — binaries distributed to macOS users will trigger Gatekeeper warnings unless signed with an Apple Developer ID certificate and notarized. Linux users have no equivalent gate, but signed binaries enable GPG-based package manager verification.
- **SLSA provenance** — no requirement to generate or attach a provenance attestation (e.g., via `slsa-github-generator`) that lets downstream consumers verify the binary was built from the declared source commit and not tampered with in transit.
- **Checksums surfaced to users** — SHA256 checksums are computed (R13, R14) for the Homebrew formula but the requirements do not specify a user-facing checksums file (e.g., `SHA256SUMS`) attached to the release as a named asset that end users downloading directly can verify against.

## Impact

- macOS arm64/x64 users who install via direct download rather than Homebrew will see a Gatekeeper "Apple cannot verify this app" dialog. Homebrew itself strips quarantine attributes, so Homebrew installs are unaffected — but the Linux direct-download path (added via R4) has no equivalent trust signal.
- Without provenance, a compromise of the CI pipeline or GitHub Release assets is undetectable by consumers.
- The SHA256 checksums computed in R13 are used only internally for the Homebrew formula update step; users who download binaries directly have no integrity signal.

## Why deferred

Code signing requires an active Apple Developer Program membership (~$99/year) and certificate management infrastructure that is disproportionate overhead for a v0.1.0 launch. SLSA provenance generation is low-friction (one GitHub Actions step) but adds supply-chain context that may not be a priority at initial release. These are best addressed in a post-v0.1.0 hardening pass rather than blocking the initial distribution work.

## Suggested follow-up actions

1. **Checksums file** (low effort, high value): attach a `SHA256SUMS.txt` file to each GitHub Release listing the checksum for each binary asset — users and downstream tools can verify downloads without trusting the Homebrew formula path.
2. **SLSA provenance** (low effort): add `slsa-github-generator` as a post-release step in the release workflow to generate and attach a provenance attestation.
3. **macOS signing** (higher effort): obtain an Apple Developer ID certificate and integrate `codesign` + `notarytool` into the release workflow before promoting `orch` to a wider macOS audience.
