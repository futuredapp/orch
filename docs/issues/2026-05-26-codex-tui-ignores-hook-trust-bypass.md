---
date: 2026-05-26
status: mitigated
area: src/runners/codex
severity: low
blocked-on: upstream Codex release (PR #24317) — only for the bypass *flag*; the prompt itself is sidestepped
---

# Codex interactive TUI ignores `--dangerously-bypass-hook-trust` (auto-stop hook prompt)

## Resolution (2026-05-27) — orch-side, independent of the upstream flag

`prepareCodexAutoStop` no longer mints a fresh temp `CODEX_HOME` per run. It now
reuses one **stable** home, `<realCodexHome>-orch` (e.g. `~/.codex-orch`), with a
**no-op `cleanup`** so it persists. Because Codex keys per-hook trust by source
path under `config.toml`'s `[hooks.state]`, stable paths mean **the trust prompt
appears once, then is remembered** — no longer every launch. This does not depend
on PR #24317; the `--dangerously-bypass-hook-trust` flag stays wired so the first
run is also silent once a fixed Codex release ships.

The **"loading hooks from both hooks.json and config.toml"** warning is also gone:
orch's signal-only Stop hook is now written **only** into `hooks.json` (a single
representation), with the user's own `hooks.json` folded into the same file rather
than symlinked. `config.toml` carries no inline hook block — only
`check_for_update_on_startup = false` and `[features] hooks = true`, written
**once** so Codex's accumulated `[hooks.state]` is never clobbered (delete the orch
home to refresh inherited config). See `tests/unit/runners/codex/codex-auto-stop.test.ts`.

## Symptom

Running an **interactive Codex step with `autoStop: true`** still shows the TUI
hook-trust review screen on startup:

```
Stop hooks
2 hooks need review before they can run.

[!] Hook 1 · new   (Source: hooks.json → /Users/.../.local/bin/plannotator)
[!] Hook 2 · new   (Source: config.toml → tmux -L "$ORCH_SOCKET" wait-for -S "$ORCH_STOP_CHANNEL")

Press t to trust; esc to go back
```

…even though `buildInteractiveArgv` correctly appends
`--dangerously-bypass-hook-trust` whenever `ctx.autoStop === true`
(`src/runners/codex/codex-runner.ts`, the `BYPASS_HOOK_TRUST_FLAG` push). The
flag is present in the spawned argv and exists in the installed CLI.

## Root cause — upstream Codex bug, not orch

`--dangerously-bypass-hook-trust` was introduced in Codex **v0.131.0**
(PR #21768) but only honored on the `exec`/headless path. The **interactive
TUI startup hook-review** screen was a separate code path that never consulted
the bypass override. So for the window **v0.131.0 – v0.133.0**, the flag is a
no-op in the TUI.

Fixed upstream by **PR #24317 "Respect hook trust bypass during TUI startup"**
(merged 2026-05-25): *"startup hook review now skips the prompt only when hook
trust bypass is actually safe for that launch."* As of 2026-05-26 this fix has
**not shipped in a tagged release**. The repro machine runs `codex-cli 0.133.0`.

Note from that PR: **resume** paths intentionally keep the prompt (re-attached
threads can't receive the bypass override); the bypass only applies to fresh
`start`/`resume`/`fork`.

## Why both hooks show as "new"

1. Per-hook trust is **keyed by source path**, not stored in `~/.codex/config.toml`
   (which only holds `[projects.*] trust_level` and `[features] hooks = true`).
   `prepareCodexAutoStop` builds a fresh temp `CODEX_HOME` each run
   (`fs.tempDir('orch-codex')`), so every hook lives at a brand-new path → all
   appear "new", including the user's already-trusted `plannotator` hook.
2. The `"loading hooks from both hooks.json and config.toml; prefer a single
   representation for this layer"` warning comes from orch symlinking the real
   `hooks.json` into the temp home **and** writing the Stop hook into
   `config.toml` — two hook representations at the same user layer.

## Why the managed-hook route was rejected (spike, 2026-05-26)

Managed hooks (`system` / `mdm` / `requirements.toml` sources) **are**
auto-trusted and skip the prompt. But registering one is incompatible with
orch's design:

- Codex reads them only from hardcoded **root-owned system paths**
  (`/etc/codex/requirements.toml` on Unix; macOS MDM domain `com.openai.codex`).
- There is **no env-var redirect** analogous to `CODEX_HOME`; Codex even strips
  `CODEX_`-prefixed vars from `.env`.
- Writing there is **global** (affects every Codex invocation) and requires
  root — the opposite of the throwaway-`CODEX_HOME` per-run isolation
  `prepareCodexAutoStop` is built on.

## Fix when ready

The orch-side wiring is already correct. Once a Codex release containing
PR #24317 ships:

1. Bump `MIN_CODEX_VERSION` in `src/runners/codex/codex-runner.ts` to that
   release. The existing `--dangerously-bypass-hook-trust` push then Just Works
   with **no argv changes**.
2. (Optional, independent) Fold the user's `hooks.json` into the single
   `config.toml` orch writes instead of symlinking it, to kill the
   "loading hooks from both" warning.

Interim option if we want to guard before the fix lands: emit a clear warning
when an interactive `autoStop` step runs on a Codex version in the broken
0.131–0.133 range, instead of letting the user hit a silent, confusing prompt.

## References

- PR #24317 (fix): https://github.com/openai/codex/pull/24317
- PR #21768 (flag introduced, v0.131.0): https://github.com/openai/codex/pull/21768
- Hooks docs: https://developers.openai.com/codex/hooks
- Managed config docs: https://developers.openai.com/codex/enterprise/managed-configuration
