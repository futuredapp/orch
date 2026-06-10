# Homebrew formula for orch — the code-first coding-agent orchestrator.
#
# This is a FORMULA, not a cask: the per-platform binaries are unsigned, but a
# tap formula does not receive the `com.apple.quarantine` attribute, so it
# installs and runs clean on macOS with no Apple Developer certificate.
#
# The url/sha256/version fields below are rewritten by scripts/bump-formula.ts
# in the orch repo (run by the release workflow's bump-formula job). The seed
# values (version 0.0.0, all-zero sha256) are deliberate placeholders — they are
# filled by the cold-start bump, never edited by hand. The block layout (one
# nested on_arm/on_intel block per platform, each with its own url + sha256
# keyed by the orch-<os>-<arch> asset name in the url) is the contract that
# bump-formula's anchored replacements depend on; keep it in sync with that
# script.
class Orch < Formula
  desc "Code-first orchestrator for chaining coding-agent CLIs (Claude Code, Codex)"
  homepage "https://github.com/futuredapp/orch"
  version "0.0.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/futuredapp/orch/releases/download/v0.0.0/orch-darwin-arm64"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
    on_intel do
      url "https://github.com/futuredapp/orch/releases/download/v0.0.0/orch-darwin-x64"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/futuredapp/orch/releases/download/v0.0.0/orch-linux-x64"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
  end

  def install
    # Binaries ship raw (not tarballs); the downloaded file is named after its
    # asset (orch-<os>-<arch>). Install whichever one was fetched as `orch`.
    bin.install Dir["orch-*"].first => "orch"
  end

  test do
    assert_match "orch", shell_output("#{bin}/orch --help")
  end
end
