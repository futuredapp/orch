---
date: 2026-06-16
status: brainstorm
topic: Distribute orch's own agent skills to consumer repos and keep each installed skill version-coupled to the orch the developer is actually running — with a self-checking skill that surfaces update instructions only when stale
relates-to: .claude/skills/, src/cli/main.ts, src/cli/commands/, src/observability/orch-version.ts, install.sh
audited: 2026-06-16 — orch's version plumbing verified in src/observability/orch-version.ts (cached package.json read, '0.0.0' fallback) and confirmed unexposed on the CLI (no `version`/`--version` in src/cli/main.ts dispatch). Existing skill layout verified under .claude/skills/ (plain `name`/`description` frontmatter; orch-rebase/scripts/*.sh confirms skills may bundle and run shell scripts). vercel-labs/skills behaviour read from its source on `main`: src/skill-lock.ts (`.skill-lock.json`, `skillFolderHash` = GitHub tree SHA, `ref`, schema v3), src/update.ts (drift = remote tree SHA vs stored hash, network-based), and the documented `add/update/list/find/remove/init/use` commands. Claude Code SKILL.md mechanics (`!`cmd`` injection runs at load, can't suppress the body; unknown frontmatter keys unspecified; `disableSkillShellExecution`; `!` respects Bash perms and fails silently off-PATH) confirmed against code.claude.com/docs/en/skills.md.
---

# Skill distribution & version coupling — Brainstorm

## TL;DR

orch has a set of skills worth shipping to the people who *use* orch (e.g. `orch-workflow-author`), but today they only live in this repo's `.claude/skills/` and never reach a consumer. We want consumers to install them, and — critically — to keep each installed skill **matched to the orch version they're running**, with a warning when it drifts.

The design splits cleanly into **transport** (not ours) and **coupling** (ours, tiny):

- **Transport — delegated to [`vercel-labs/skills`](https://github.com/vercel-labs/skills).** Ship skills from a top-level `skills/` directory *inside the orch repo*, so they're git-tagged in lockstep with every orch release. Consumers install with `npx skills add futured/orch/skills/<name>@v<orchVersion> --copy`, pinned to an **immutable tag**.
- **Coupling — a small custom layer.** `vercel skills` only knows "is my copy the latest content on its ref?" It has *no concept of* "does this skill match my orch version" — which is our whole requirement. So each shipped skill carries a sidecar `orch-compat.json`, and a one-line self-check at the top of `SKILL.md` injects a bundled `check.sh` that prints **update instructions only when the skill is stale for the installed orch**, and nothing when it's fresh.

New orch surface is small: `orch version` (expose the existing `orchVersion()`) and `orch skills check` (the version comparison + exit code). Everything fragile (semver compare, JSON parsing) lives in TypeScript; the bundled shell script is a dumb shim; the markdown never branches.

## Why build this

**The skills are trapped in the orch repo.** `.claude/skills/orch-workflow-author/` is genuinely useful to anyone authoring orch workflows in their own project — but there's no path for it to get there, and no way to keep it current. A developer on orch `1.2.3` who hand-copied a skill months ago has no signal that it now assumes features their orch lacks (or, the reverse, that a newer, better skill exists).

**"Up to date" has two different meanings, and only one of them matters to us.** `vercel skills` tracks *content drift on a git ref* (folder hash). What we actually care about is *compatibility with the installed orch*. A skill is "wrong" not because the repo moved on, but because it no longer matches the orch the developer runs. That coupling is the thing we have to build; the transport we can borrow.

**The nag must be high-signal.** A warning that fires on every command, about skills you're not using, gets ignored. The right moment to say "this skill is stale" is *when the skill is actually invoked* — and only then. That points at a self-check inside the skill, not a global orch nag.

## What `vercel-labs/skills` actually does (read from source, not the README)

The README is deliberately light on the mechanism; these are from the code on `main`:

- **Transport is git, not npm.** `npx skills add <owner>/<repo>[/subpath][@ref]` — GitHub shorthand, full URL, GitLab, any git URL, or local path. Subpaths and `@ref` (branch/tag) supported. No npm-package source.
- **Installs into `.claude/skills/`** (project, default, committed) or `~/.claude/skills/` with `-g`. **Symlink by default**, `--copy` for environments without symlinks.
- **Lockfile = `.skill-lock.json`** (global at `~/.agents/` or `$XDG_STATE_HOME/skills/`, plus a project-local lock). Each entry: `source`, `sourceUrl`, **`ref`** (branch/tag), `skillPath`, **`skillFolderHash`** (the GitHub tree SHA of the skill folder), timestamps. Schema v3.
- **Drift detection = folder content hash, over the network.** `npx skills update` fetches the remote tree SHA for the tracked `ref` and compares it to the stored `skillFolderHash`. Not semver, not a git commit.
- Commands: `add`, `update`, `list`/`ls`, `find`, `remove`/`rm`, `init`, `use`.

**The gap we fill:** `vercel skills` answers *"is my copy the latest published skill on its ref?"* It has **no concept of "does this skill match the orch version I'm running?"** That second question is the entire point of this work.

## What orch provides today (the starting point)

- **`orchVersion()`** in `src/observability/orch-version.ts` — cached `package.json` read, walks up from the module dir, falls back to `'0.0.0'`, never throws. Already used for run metadata.
- **It is not exposed on the CLI.** `src/cli/main.ts` dispatch has no `version` / `--version` command. Adding one is trivial.
- **Skills can already bundle and run shell scripts** — `.claude/skills/orch-rebase/scripts/*.sh` is the precedent. So a self-checking skill is mechanically supported.
- **`install.sh`** is a checkout/worktree bootstrapper (links the self-bin), *not* a skill installer — out of scope here.

## Claude Code SKILL.md mechanics that shaped the design

Confirmed against the official skills docs:

- **`` !`cmd` `` injection works in `SKILL.md`** — it runs at *load time* and the output is spliced into the prompt as plain text. **But it cannot conditionally suppress the rest of the body.** So the conditional logic can't live in the markdown; it has to live in whatever the `!` line runs.
- **Unknown frontmatter keys are unspecified behaviour** (the docs neither guarantee nor forbid them). → We put compat data in a **sidecar file**, not in frontmatter.
- **`disableSkillShellExecution`** (user/project/managed setting) can turn off `!` injection; the command runs at *every* load (latency — keep it to one); it **respects `Bash(...)` permissions**; and it **fails silently if the binary isn't on PATH**. → The self-check must be **advisory and degrade gracefully** — never block, stay silent when it can't determine an answer.

## The architecture

```
AUTHOR (orch repo)                     TRANSPORT (vercel skills)          CONSUMER (.claude/skills/)
skills/orch-workflow-author/           npx skills add \                   orch-workflow-author/
  SKILL.md                              futured/orch/skills/X@v1.2.3        SKILL.md
  check.sh                              --copy                              check.sh
  orch-compat.json {min,builtFor}  ──tagged with each orch release──▶      orch-compat.json
  update_instructions.md                                                   update_instructions.md
                                                                           ▲
orch CLI (new, tiny):                                                      │ Step-0 self-check
  orch version             ─────────────── !`bash .../check.sh` ───────────┘ (offline, advisory)
  orch skills check [--dir] reads orch version + sidecar; exit 0 = ok, nonzero = stale
```

**Responsibility split, end to end:**

| Concern | Owner |
|---|---|
| Install / copy transport | `vercel skills` (`npx skills add …@vX --copy`) |
| The if/else and the message | `check.sh` + `update_instructions.md`, bundled in each skill |
| The actual version comparison | `orch skills check` + `orch version` (new, small, TypeScript) |
| Per-skill compat data | `orch-compat.json`, bundled, stamped at release |

## The self-check, concretely

The key correction that makes this clean: **`SKILL.md` cannot branch, but the injected script can.** So `SKILL.md` has a single injection line whose output is either empty (fresh) or the full update instructions (stale). All the if/else lives in one bundled script.

**`SKILL.md`** — one line at the very top, no logic:

```markdown
---
name: orch-workflow-author
description: ...
---
!`bash .claude/skills/orch-workflow-author/check.sh`

# orch workflow author
...rest of the skill, unchanged...
```

The `!` runs at project-root cwd, so it needs the full path. Its output is spliced in before the body — empty when fresh, so the skill just reads normally.

**`check.sh`** — the *only* place the if/else lives:

```bash
#!/usr/bin/env bash
# Prints update instructions iff this skill is stale for the installed orch.
# Silent + exit 0 on fresh, missing orch, or any error — advisory, never blocks.
set -uo pipefail
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if orch skills check --dir "$dir" --quiet 2>/dev/null \
   || bunx orch skills check --dir "$dir" --quiet 2>/dev/null; then
  exit 0                       # version ok → print nothing
fi

cat "$dir/update_instructions.md"   # stale → print the update instructions
```

**`orch-compat.json`** — sidecar, stamped at release:

```json
{ "minOrch": "1.2.0", "builtForOrch": "1.2.3" }
```

**`update_instructions.md`** — printed *only when stale*, so it can be blunt:

```markdown
⚠️ This skill (built for orch 1.2.3) is older than your installed orch.
Re-pin it before continuing:

    npx skills add futured/orch/skills/orch-workflow-author@v<your-orch-version> --copy
```

**`orch skills check` contract** (the only real logic, in robust TS — not bash):

- `--dir <path>` → reads `<path>/orch-compat.json`, compares `minOrch`/`builtForOrch` against `orchVersion()`.
- `--quiet` → exit `0` = compatible, nonzero = stale. No output.
- Can't determine (no sidecar, orch missing, parse error) → exit `0` (stay silent — advisory).
- Without `--quiet` → human-readable verdict + remediation (runnable by a person or CI).

## The three flows

1. **Release.** Skills live in-repo under `skills/`, tagged in lockstep with orch (`v1.2.3` tags already exist). The release step stamps `builtForOrch` into each sidecar so it always matches the tag being cut.
2. **Install.** `npx skills add futured/orch/skills/<name>@v1.2.3 --copy`. Pinned to an **immutable tag** and copied (most consumers run the Homebrew binary, not a clone, so symlinking a clone isn't an option).
3. **Self-check.** On every invocation, `SKILL.md`'s one `!` line runs `check.sh`, which asks `orch skills check` "am I current for this orch?" — printing `update_instructions.md` only when the answer is no.

## The one correctness consequence of pinning to immutable tags

Because we pin `@v1.2.3` (a frozen tag), its folder hash never drifts — so **`npx skills update` is a no-op for us**. That's fine, and actually cleaner: `vercel skills`' drift model doesn't fit version-pinning, so **our `orch skills check` replaces it**. The remediation it prints is therefore *re-pin*, not *update*:

```
npx skills add futured/orch/skills/<name>@v<newOrch> --copy
```

We use `vercel skills` purely as the copy-from-a-tag transport; the orch-version coupling is entirely ours.

## What we'd actually build (small)

- **`orch version` / `--version`** — wrap the existing `orchVersion()`; `--format json` → `{ version }`. Trivial.
- **`orch skills check [<name>] [--dir <path>] [--quiet] [--format json]`** — the comparison + remediation helper. The only real new logic, and it's small.
- **A `skills/` source tree** (distributable skills, distinct from `.claude/skills/` dev skills) + a release step that stamps `builtForOrch` into each sidecar.
- **Per skill:** `orch-compat.json` + `check.sh` + `update_instructions.md` + the one-line `!` self-check at the top of `SKILL.md`.

## Open items (not blockers)

- **`skills/` vs `.claude/skills/` duplication.** Distributable skills and orch's own dev skills overlap (e.g. `orch-workflow-author`). Decide whether `skills/` is the source of truth that `.claude/skills/` symlinks to, or they're maintained separately. Leaning: `skills/` is canonical; `.claude/skills/` symlinks the shared ones.
- **`minOrch` vs `builtForOrch` severity.** Suggest two levels: **warn/block-ish** only when `orch < minOrch` (genuine incompatibility), and **info** when `orch != builtForOrch` (a newer skill exists but yours still works). Keeps noise down. `--quiet` exit code would key off the `minOrch` floor; the printed message can mention the `builtForOrch` info.
- **Bash-permission friction.** The `!` check needs `Bash(orch skills check *)` (and/or `Bash(bunx orch …)`) allowed, or consumers get a permission prompt at skill load. Ship a recommended `.claude/settings.json` allowlist snippet in the install docs.
- **PATH: binary vs bunx.** Homebrew users have `orch` on PATH; source/bunx users may not. `check.sh` already falls back `orch … || bunx orch … || true`; confirm that's sufficient in practice.
- **Compiled-binary distribution of `skills/`.** orch ships as a Homebrew binary. The *skills themselves* are delivered via `vercel skills` pulling from the git tag (not from the binary), so the binary doesn't need to embed them — but `orch skills check` must work from the binary (it only needs `orch version` + reading a sidecar path passed via `--dir`, both fine in a compiled build).
- **`disableSkillShellExecution`.** If a consumer org disables skill shell execution, the self-check silently no-ops. Acceptable (advisory by design), but worth a one-line note in the docs so it's understood, not surprising.

## Why this is the right shape

- **Borrow the boring part.** Install/copy/list/remove transport is solved by `vercel skills`; we don't reinvent it.
- **Own the part that's actually ours.** Version *coupling to orch* is the unique requirement, and it's a sidecar file plus a ~one-screen TS command.
- **High-signal, never-blocking.** The warning fires only when a skill is used and only when it's actually stale; it degrades to silence whenever it can't be sure.
- **Fragility stays in TypeScript.** Semver comparison and JSON parsing live in `orch skills check`; the bundled shell script is a dumb shim; `SKILL.md` never branches.
