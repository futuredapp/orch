# orch release setup guide (operator runbook)

This is the **Stage B** runbook: every step that needs GitHub remote access, a
credential, local `brew`, or an irreversible flip. The implementing agent has
already landed all in-repo code, scripts, CI workflows, and the staged tap files
(Stage A). Your job is to execute the ordered steps below to take `orch` public
and cut the first release.

> **Placeholder.** This guide assumes the GitHub org/account is **`futuredapp`**
> — it is baked into the committed formula URLs, README, CI, and docs `base`. If
> you publish under a different account, search-replace `futuredapp` across the
> repo (`README.md`, `dist-staging/homebrew-orch/Formula/orch.rb`,
> `docs/public/.vitepress/config.mts`, `scripts/bump-formula.ts`,
> `.github/workflows/release.yml`, `CHANGELOG.md`) **before** starting.

Prerequisites on your machine: `gh` (authenticated: `gh auth status`), `git`,
`bun`, `brew`, and a secret scanner (`gitleaks` or `trufflehog`).

Two gates in this sequence are non-negotiable and called out in bold where they
occur:

- **B10 — the full-history secret scan must be clean** before, and only before,
- **B11 — making the repo public**, which is **irreversible**.

---

## Part 1 — One-time setup (B0 → B13)

Do these in order. Do not reorder: the remote must exist before anything is
pushed, protections and the secret/PAT must exist before the repo is public, and
the public flip must precede the brew validation and the first tag.

### B0 — Create the `orch` repo and push `main`

**Access:** GitHub repo-admin + git push. **Source:** baseline assumption of this
guide — every step from B4 on operates on `origin` and a remote `main`.

Right now the project is a **local-only** git repository. Everything downstream
assumes a GitHub repo at **`futuredapp/orch`** with `origin` pointing at it and
the `main` branch already pushed (the formula URLs, CI workflows, README, and
docs `base` are all hard-coded to this slug — see the placeholder note above).

Create the repo **private**. The public flip is deliberately deferred to **B11**,
*after* the blocking full-history secret scan (**B10**). Creating it public now
would skip that irreversible gate — do not do it.

Run from your local `orch` checkout:

```bash
# 1. Create the PRIVATE repo and wire it as 'origin' (no push yet).
gh repo create futuredapp/orch --private --source=. --remote=origin
#    Already have an 'origin' from an earlier attempt? Repoint it instead:
#    git remote set-url origin https://github.com/futuredapp/orch.git

# 2. Push the release branch. Branch protection (B5) and the public flip (B11)
#    both operate on 'main', so it must exist on the remote first.
git checkout main
git push -u origin main
```

Leave `develop` for **B4** — it pushes `develop` and flips the default branch.
Your checkout already has a local `develop`, so at B4 skip the
`git checkout -b develop` and run only its `git push -u origin develop` +
`gh repo edit` lines. The repo stays **private** through B10; do not change its
visibility until B11.

**Verify:** `gh repo view futuredapp/orch --json visibility,defaultBranchRef`
shows `"private"` with `main`; `git remote -v` shows `origin` →
`github.com/futuredapp/orch`.

### B1 — Name-availability check (do this before creating the tap)

**Access:** local `brew`, `npm`, web. **Source:** R3b.

A name conflict can invalidate everything downstream, so check before creating
anything public.

```bash
brew search orch                       # must not collide with a core formula named exactly "orch"
npm view orch version 2>/dev/null && echo "TAKEN on npm" || echo "free on npm"
```

Also do a quick trademark sanity check (web search for "orch" software
trademarks). If `orch` is claimed in Homebrew **core**, you cannot use the short
`brew install orch` without a tap prefix — surface this before proceeding.

**Verify:** no core-formula collision; npm name free (npm is deferred but the
name still matters); no blocking trademark.

### B2 — Create the `homebrew-orch` tap repo

**Access:** GitHub repo-admin. **Source:** U12 / R8.

The repo name **must** be exactly `homebrew-orch` so the short
`brew tap futuredapp/orch` form resolves. It holds only the formula (no
secrets), so create it public.

```bash
gh repo create futuredapp/homebrew-orch \
  --public \
  --description "Homebrew tap for orch"
```

**Verify:** `gh repo view futuredapp/homebrew-orch` succeeds.

### B3 — Push the staged tap files

**Access:** git push. **Source:** U12 (B3).

The agent authored the tap files under `dist-staging/homebrew-orch/`. Push them
to the new repo's `main`. The formula ships with **placeholder**
`version "0.0.0"` and all-zero `sha256`s on purpose — they are filled by the
release pipeline's bump, never by hand.

```bash
tmp="$(mktemp -d)"
cp -R dist-staging/homebrew-orch/. "$tmp/"
git -C "$tmp" init -b main
git -C "$tmp" add .
git -C "$tmp" commit -m "feat: seed orch formula"
git -C "$tmp" remote add origin https://github.com/futuredapp/homebrew-orch.git
git -C "$tmp" push -u origin main
```

**Verify:** `Formula/orch.rb` and `README.md` are visible at
`https://github.com/futuredapp/homebrew-orch`.

### B4 — Create `develop` and make it the default branch

**Access:** GitHub repo-admin. **Source:** U13 step 2 / R3.

Run from the `orch` repo checkout. Contributors PR into `develop`; `main` is the
release branch.

```bash
git checkout -b develop
git push -u origin develop
gh repo edit futuredapp/orch --default-branch develop
```

**Verify:** `gh repo view futuredapp/orch --json defaultBranchRef` shows
`develop`.

### B5 — Branch protection on `main`

**Access:** GitHub repo-admin. **Source:** U13 step 3 / R3.

Require the PR gate's `check` job (the job name in `.github/workflows/pr.yml`),
allow no direct pushes, and block force-push/deletion.

```bash
gh api -X PUT repos/futuredapp/orch/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["check"] },
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 1 },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

**Verify:** a direct `git push origin main` is rejected; a PR cannot merge until
`check` is green.

### B6 — Tag protection for `v*`

**Access:** GitHub repo-admin. **Source:** U13 step 3 / R3a.

Restrict who can create/delete `v*` tags so a stray or malicious tag can't fire
the release pipeline.

```bash
gh api -X POST repos/futuredapp/orch/tags/protection -f pattern='v*'
```

**Verify:** `gh api repos/futuredapp/orch/tags/protection` lists the `v*` rule.
(`main` force-push/delete is already blocked by B5.)

### B7 — Create the fine-grained PAT for the tap

**Access:** GitHub account settings (web — `gh` cannot mint fine-grained PATs).
**Source:** U13 step 4 / R14, R-2.

1. Go to **Settings → Developer settings → Fine-grained tokens → Generate new
   token**.
2. **Resource owner:** `futuredapp`. **Repository access:** Only select
   repositories → **`homebrew-orch`** only.
3. **Permissions:** Repository permissions → **Contents: Read and write**.
   Nothing else.
4. **Expiration:** maximum **1 year**. Record a rotation reminder.
5. Generate and copy the token (you will not see it again).

**Verify:** the token grants Contents:R+W on `homebrew-orch` only — no access to
`orch` or any other repo.

### B8 — Store the PAT as the `HOMEBREW_TAP_TOKEN` secret

**Access:** GitHub repo secrets. **Source:** U13 step 4.

```bash
gh secret set HOMEBREW_TAP_TOKEN --repo futuredapp/orch
# paste the PAT from B7 when prompted
```

The release workflow references this secret **only at step scope** in the
`bump-formula` job (never job-wide). Treat any CI log that prints the token as
cause for immediate rotation.

**Verify:** `gh secret list --repo futuredapp/orch` shows `HOMEBREW_TAP_TOKEN`.

### B9 — Enable GitHub Pages (source = GitHub Actions)

**Access:** GitHub repo-admin. **Source:** U13 step 5 / R15.

```bash
gh api -X POST repos/futuredapp/orch/pages -f build_type=workflow
```

(If it already exists: `gh api -X PUT repos/futuredapp/orch/pages -f build_type=workflow`.)
Web equivalent: **Settings → Pages → Build and deployment → Source: GitHub
Actions.**

Then **pin the `github-pages` environment to deploy from `main`.** Enabling Pages
auto-creates the `github-pages` environment with a deployment-branch policy
seeded from the **default branch (`develop`)** — but `docs.yml` deploys on push
to **`main`**, so a push to `main` is rejected with *"Branch main is not allowed
to deploy to github-pages"* until the policy allows it. Add `main` and drop the
stale `develop` entry:

```bash
# Allow main; then list, find the develop policy id, and delete it.
gh api -X POST repos/futuredapp/orch/environments/github-pages/deployment-branch-policies \
  -f name=main -f type=branch
gh api repos/futuredapp/orch/environments/github-pages/deployment-branch-policies   # note the develop id
gh api -X DELETE repos/futuredapp/orch/environments/github-pages/deployment-branch-policies/<develop-id>
```

Web equivalent: **Settings → Environments → github-pages → Deployment branches →
add `main`, remove `develop`.**

**Verify:** Settings → Pages shows source "GitHub Actions"; the
`github-pages` environment's deployment-branch policy lists **`main`** (and not
`develop`) —
`gh api repos/futuredapp/orch/environments/github-pages/deployment-branch-policies`.
The site goes live after the first push to `main` (B13).

### B10 — Full-history secret scan **(BLOCKING GATE)**

**Access:** local. **Source:** U13 step 6 / R-5.

Scan the **entire history**, not just the working tree — once the repo is public
(B11), any credential ever committed (even in a deleted file) is permanently
exposed.

```bash
gitleaks detect --source . --log-opts="--all"
# or:
trufflehog git file://. --only-verified
```

**This must come back clean before B11.** Document any intentional
false-positive explicitly. **Do not proceed to B11 with an unresolved finding.**

**Verify:** scanner exits clean (no unresolved secrets in any commit).

### B11 — Make the repo public **(IRREVERSIBLE)**

**Access:** GitHub repo-admin. **Source:** U13 step 7 / R1.

Only after B10 is clean and `LICENSE` (MIT) + `README.md` are committed.

```bash
gh repo edit futuredapp/orch --visibility public --accept-visibility-change-consequences
```

**Verify:** `gh repo view futuredapp/orch --json visibility` shows `public`;
GitHub recognises the MIT license in the repo sidebar.

### B12 — Cold-start: validate the formula against a test pre-release

**Access:** local `bun`/`brew` + a GitHub pre-release. **Source:** U12 (Stage B).

This resolves the chicken-and-egg (the automated bump needs both the tap repo
**and** a Release to exist) by proving the formula installs from real release
bytes before the first real tag.

```bash
# 0. Point ORCH at your local orch checkout. Every path below derives from it,
#    so you never have to hand-edit a placeholder. (The literal "/path/to/orch"
#    is NOT a real path — set this once instead.)
ORCH=/path/to/your/orch/checkout   # e.g. ~/projects/orch

# 1. Build all three binaries locally.
bun run build:binary --target bun-darwin-arm64 --outfile dist/orch-darwin-arm64
bun run build:binary --target bun-darwin-x64   --outfile dist/orch-darwin-x64
bun run build:binary --target bun-linux-x64    --outfile dist/orch-linux-x64
( cd dist && shasum -a 256 orch-darwin-arm64 orch-darwin-x64 orch-linux-x64 > SHA256SUMS )

# 2. Publish a throwaway pre-release with those assets.
gh release create v0.0.1-test --prerelease --title v0.0.1-test \
  --notes "cold-start formula validation" \
  dist/orch-darwin-arm64 dist/orch-darwin-x64 dist/orch-linux-x64 dist/SHA256SUMS

# 3. Hand-bump a LOCAL copy of the formula against that pre-release.
#    Keep the bump on ONE line — a stray newline before a backslash ends the
#    command early and the shell reads "--formula …" as its own command.
#    The bump writes a relative path (Formula/orch.rb), so it must run from
#    inside the tap clone — the `cd "$_"` lands you there.
git clone https://github.com/futuredapp/homebrew-orch "$(mktemp -d)/tap" && cd "$_"
bun "$ORCH/scripts/bump-formula.ts" --version 0.0.1-test --dist "$ORCH/dist" --formula Formula/orch.rb

#    Confirm the bump took: version is 0.0.1-test and the sha256s are non-zero.
grep -E 'version|sha256' Formula/orch.rb

# 4. Validate the formula installs the binary from the released bytes.
#    Current Homebrew REFUSES to install a formula from a loose file path
#    ("Homebrew requires formulae to be in a tap"), so stage the bumped formula
#    in a throwaway local tap and install it by qualified name.
brew tap-new futuredapp/orch --no-git
cp Formula/orch.rb "$(brew --repository futuredapp/orch)/Formula/orch.rb"
brew install futuredapp/orch/orch
orch --help
brew audit --new --formula futuredapp/orch/orch
```

Do **not** push this test bump to the tap's `main` — leave it at the placeholder
skeleton. The real `v0.1.0` release (B13) re-bumps it automatically. Clean up
when done: `brew uninstall orch`, `brew untap futuredapp/orch`, and (optionally)
`gh release delete v0.0.1-test`.

**Verify (AE1):** on macOS arm64 with no Bun, `brew install --formula …` yields a
working `orch`; `brew audit` is clean. Repeat the install on a Linux x64 box to
exercise the `on_linux` block if available.

### B13 — Cut the first release (v0.1.0)

**Access:** git push + tag. **Source:** U13 step 8 / R18.

Sequence the docs deploy and the release pipeline — don't fire them on one push.

```bash
# 1. Finalise the CHANGELOG: set the real date and prose for 0.1.0, then confirm
#    it passes the same gate release.yml runs.
$EDITOR CHANGELOG.md
bun scripts/changelog-section.ts --version 0.1.0      # must print "... ok"

# 2. Merge develop → main via PR (branch protection requires the green check).
gh pr create --base main --head develop --title "release: v0.1.0" --fill
#   ...merge once the check is green...

# 3. Confirm docs.yml deployed and Pages is live BEFORE tagging.
#    Open https://futuredapp.github.io/orch/ — assets must load under /orch/.

# 4. Now push the tag — release.yml runs on its own.
git checkout main && git pull
git tag v0.1.0
git push origin v0.1.0
```

**Verify (AE2):** the `Release v0.1.0` page shows `orch-darwin-arm64`,
`orch-darwin-x64`, `orch-linux-x64`, and `SHA256SUMS`; `homebrew-orch` has a new
`orch v0.1.0` commit with the three real `sha256`s. End-to-end:

```bash
brew tap futuredapp/orch
brew trust futuredapp/orch   # Homebrew 5.1+ refuses untrusted third-party taps
brew install orch
orch --help
```

---

## Part 2 — Cutting a release (recurring)

The steady-state procedure once Part 1 is done.

1. **Draft the changelog** with the dogfooded workflow (run from a repo
   checkout; it launches a fully autonomous, unrestricted Claude session — see
   its docstring):

   ```bash
   bunx orch run generate-changelog                  # since the last v* tag
   bunx orch run generate-changelog "v0.1.0..HEAD as v0.2.0"   # explicit scope
   ```

2. **Finalise** `CHANGELOG.md` (tighten the prose, set the date) and confirm the
   gate passes:

   ```bash
   bun scripts/changelog-section.ts --version 0.2.0   # must print "... ok"
   ```

3. **Merge `develop` → `main`** via PR; confirm `docs.yml` deploys (Pages stays
   live).

4. **Tag and push:**

   ```bash
   git checkout main && git pull
   git tag v0.2.0 && git push origin v0.2.0
   ```

5. **Watch `release.yml`** (Actions tab). On success: three binaries +
   `SHA256SUMS` on the Release, and a fresh bump commit in `homebrew-orch`.
   `brew upgrade orch` now serves the new version.

### Partial-failure recovery

The realistic failure mode is **publish succeeding (Release + assets live) but
`bump-formula` failing** (PAT expired, tap push rejected, transient 5xx). The
Release page shows the new version while `brew upgrade` stays stuck on the old
one.

- **Detection:** a Release exists for the tag, but the tap formula's `version`
  lags — `brew info futuredapp/orch/orch` (or the `version` line in
  `homebrew-orch/Formula/orch.rb`) is behind the Release.
- **Recovery:** re-run the **`bump-formula` job alone** (Actions → the release
  run → *Re-run failed jobs*). It re-downloads the binaries from the published
  Release, recomputes the checksums, and is idempotent — safe to re-run any
  number of times. If the PAT expired, rotate it (repeat B7/B8) before re-running.

> The `bump-formula` job deliberately sources its checksums from the **published
> Release bytes** (not the build artifacts), so re-running it always matches what
> users actually download, and a tampered intermediate artifact can never poison
> the formula.
