---
date: 2026-05-25
topic: interactive-auto-stop-research
kind: research-reference
---

# Research Reference — Making Interactive Agent Sessions Auto-Terminate (Claude Code & Codex)

Durable reference for the [interactive auto-stop brainstorm](2026-05-25-feat-interactive-auto-stop-brainstorm.md) and the broader "interactive UI, autonomous behavior" goal. Consolidates eight research streams (Claude Code permissions/tools, Claude hooks/lifecycle, Codex approvals/sandbox, Codex notify/lifecycle, tmux automation prior art, sandboxing + long-run failure modes, plus two narrow follow-ups on per-run hook injection) and an orch architecture map. Read this before planning — it answers most of the deferred-to-planning questions.

**Verification baseline:** Claude Code docs at `code.claude.com` (≈ v2.1.14x era, May 2026); Codex CLI `0.133.0` (binary + `developers.openai.com/codex` + repo source). Items that could not be confirmed against docs/source are marked **[unverified]**. Year is 2026.

---

## 0. The one constraint that shapes everything

**An interactive agent session cannot terminate itself.** Both CLIs, when run as their interactive TUI, return to an idle prompt after finishing a turn and wait for human input.

- Claude Code: a hook **cannot** exit the session. Requested upstream and **closed "not planned" twice** — [#27244](https://github.com/anthropics/claude-code/issues/27244) (hook exit code for termination), [#35280](https://github.com/anthropics/claude-code/issues/35280) (auto-close after completion). `continue:false` stops the *agent loop* but leaves the interactive REPL idling. Prompt-level "terminate now" instructions don't exit either.
- Codex: interactive `codex` does not auto-exit and has no `/detach` ([#23132](https://github.com/openai/codex/issues/23132)). Only `codex exec` (headless) auto-exits.

**Therefore the design is: hook = completion *signal* → orch performs the *termination* externally** (it owns the tmux pane). This is non-negotiable and is the spine of the auto-stop feature.

The clean exit primitives that *do* work, for reference:
- Claude headless `claude -p "…"` runs to completion and exits on its own (the documented autonomous pattern).
- `Ctrl-D` (EOF) on stdin is the documented interactive exit ("Exit Claude Code session — EOF signal"); `Ctrl-C` twice also exits when idle.
- Codex `codex exec` auto-exits with a meaningful exit code.

---

## 1. Claude Code — making interactive runs non-blocking

### 1.1 Permission modes (`--permission-mode`)

Accepts `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`. Works in interactive and `-p`.

| Mode | Runs without asking | Autonomy verdict |
|---|---|---|
| `default` | reads only | useless unattended |
| `acceptEdits` | reads, edits, common fs Bash in cwd | still prompts for arbitrary Bash/network |
| `plan` | reads only | won't edit |
| `auto` | everything, with a background safety classifier | **best "safe" autonomous** but pauses → prompts after 3 consecutive / 20 total classifier blocks; needs Anthropic API + Sonnet 4.6 / Opus 4.6 / Opus 4.7 |
| `dontAsk` | only pre-approved + read-only Bash | fully non-interactive; auto-**denies** anything unlisted (honors deny rules) |
| `bypassPermissions` | everything | no prompts except `rm -rf /` / `rm -rf ~` circuit breaker; **skips the permission layer entirely so `permissions.deny` is NOT honored** |

- `--dangerously-skip-permissions` is documented as **equivalent to `--permission-mode bypassPermissions`**.
- Root/sudo refusal: both refuse to start as root unless inside a recognized sandbox. Undocumented escape hatches `IS_SANDBOX=1` / `CLAUDE_CODE_BUBBLEWRAP=1` exist **[unverified, community-sourced]**; the supported path is the dev container (runs as non-root). orch already sets `process.env.IS_SANDBOX = '1'` in `workflows/new-feature/index.ts`.
- Pre-entry confirmation for dangerous mode can be suppressed with `permissions.skipDangerousModePermissionPrompt: true` (must be in user/managed settings, ignored in project settings).
- Evaluation order: **deny → ask → allow, first match wins**; rules merge across scopes (managed > CLI > local > project > user); a deny anywhere cannot be overridden.

orch state: `--dangerously-skip-permissions` and `--permission-mode` are **already off the Claude denylist** (`src/runners/claude/claude-runner.ts`); templates use `--permission-mode bypassPermissions` and `--dangerously-skip-permissions`. So "no permission prompts" is already solved via runner flags.

### 1.2 The `AskUserQuestion` tool

- Exact tool name is **`AskUserQuestion`** (no permission gate; the model chooses to call it).
- Disable by removing from context: `--disallowedTools AskUserQuestion` (a **bare tool name removes the tool from the model's context** entirely), or `permissions.deny: ["AskUserQuestion"]`.
- `auto` mode does **not** reliably suppress it (it was fixed to stop suppressing it when relied upon) — explicitly disallow it.
- Pair with `--append-system-prompt "No human is available. Never ask questions; on ambiguity pick the best option, note the assumption, and proceed."` — removing the tool stops the modal, but the model can still stall by emitting a question as text. There's also a built-in "Proactive" output style for stronger autonomous behavior.

### 1.3 Other interactive blocking points (suppress for unattended runs)

- **First-run trust / onboarding**: keys live in `~/.claude.json` per project — `hasTrustDialogAccepted`, `hasCompletedProjectOnboarding`, `hasClaudeMdExternalIncludesApproved`, newer `hasTrustDialogHooksAccepted`. Set via `claude config set …` or write directly. Known persistence bugs ([#36403](https://github.com/anthropics/claude-code/issues/36403), [#5572](https://github.com/anthropics/claude-code/issues/5572)); robust mitigation is a SessionStart hook / wrapper that writes them before launch. **[names community-verified, not in settings schema]**
- **API-key approval** (when `ANTHROPIC_API_KEY` set): prompted once. Avoid via OAuth token `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`).
- **MCP approval**: `enableAllProjectMcpServers: true`, or `enabledMcpjsonServers: [...]`, or `--strict-mcp-config --mcp-config <file>`.
- No turn/budget cap exists for interactive: `--max-turns`, `--max-budget-usd`, `--output-format`, `--input-format` are **print-mode only**. An orchestrator must impose its own limits externally.

Useful env for unattended interactive: `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_AUTOUPDATER=1`, `BASH_DEFAULT_TIMEOUT_MS`/`BASH_MAX_TIMEOUT_MS`, `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` (cleaner pane capture).

### 1.4 Hooks reference (the events that matter)

Full 2026 event set is large; the relevant ones:

- **`Stop`** — fires when the agent finishes responding at the end of a turn. stdin JSON includes `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, and the loop-guard `stop_hook_active`. No matcher (fires on every turn completion). Can force continuation via `decision:"block"` + `reason` or exit code 2; can halt via `continue:false`. **Fires identically in interactive and headless** — the difference is only what happens after (headless exits, interactive idles).
- **`StopFailure`** — fires when a turn ends due to an **API error** (rate_limit, auth, billing, server_error, max_output_tokens). Covers the abnormal-termination class where `Stop` does not fire.
- **`SessionEnd`** — fires when the session actually terminates; `exit_reason` ∈ `clear|resume|logout|prompt_input_exit|bypass_permissions_disabled|other`. Observability only, no decision control. `prompt_input_exit` is the expected reason after EOF/`Ctrl-D` **[unverified that EOF maps to it vs `other`]**.
- **`Notification`** — matchers include `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`. `idle_prompt` = agent gone idle awaiting input.
- `SubagentStop`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `PreCompact`/`PostCompact`, `Elicitation` — see docs.

**Exit-code semantics:** `0` success (stdout parsed as JSON if present); `2` blocking error (stderr fed to Claude; for `Stop` *prevents stopping*); other = non-blocking. **There is no exit code that terminates the session.**

`stop_hook_active` loop guard: a `Stop` hook that returns `decision:"block"` forces continuation; always check `stop_hook_active` first and return success when true, or you get an infinite loop (real incident: [#55754](https://github.com/anthropics/claude-code/issues/55754), ~50-min loop burning the token cap). The `{"continue":true}` footgun re-triggers Stop hooks — to let Claude stop, omit `continue` and don't block. For auto-stop we are **not** blocking; our hook just signals and exits 0.

### 1.5 Per-run Stop-hook injection (the orch-relevant mechanics)

**Inline one-liner works — no script file needed.** A `command`-type hook is a shell string (`sh -c`), so pipes/redirects/env-expansion/globs work. Examples:

```json
{ "type": "command", "command": "tmux -S \"$ORCH_SOCKET\" wait-for -S \"$ORCH_CHANNEL\"" }
{ "type": "command", "command": "printf done > \"$ORCH_DONE_FILE\"" }
```

- No documented length cap on the command (the 10k cap is on hook *output*). Default per-hook timeout is 60s; a fire-and-forget signal returns instantly. `tmux wait-for -S` *signals* a channel and returns immediately (does not block).
- **`--settings` merges per-key and hooks merge across all settings sources** ("identical hook commands are auto-deduplicated"); the user's own Stop hooks still fire. But `--settings` is on **orch's Claude denylist**.
- **Injection without `--settings`:** write a project-scope settings file into the run cwd. Best choice: **`.claude/settings.local.json`** containing only the auto-stop hooks — conventionally the per-user, gitignored local-override file, least likely to collide with a committed `settings.json`. Hooks merge, so nothing is clobbered. No `CLAUDE_*` env var can inject hooks (none exists). `--setting-sources user,project,local` only *restricts* which sources load.
- **Env inheritance confirmed:** hooks "run in the current directory with Claude Code's environment," so vars orch puts on the `claude` process (`ORCH_SOCKET`, `ORCH_CHANNEL`, `ORCH_DONE_FILE` via `mergeEnv`) reach the inline hook.
- **Write the settings file BEFORE launch**, not into a running session — a mid-session hook-config change can trigger a review prompt **[exact current-version behavior unverified]**. Clean up the file after if the cwd is reused. Directory must be trusted for hooks to run; enterprise `allowManagedHooksOnly` would suppress injected hooks **[check once]**.

Recommended file at `<run-cwd>/.claude/settings.local.json`:

```json
{
  "hooks": {
    "Stop":        [{ "hooks": [{ "type": "command", "command": "tmux -S \"$ORCH_SOCKET\" wait-for -S \"$ORCH_CHANNEL\"" }] }],
    "StopFailure": [{ "hooks": [{ "type": "command", "command": "tmux -S \"$ORCH_SOCKET\" wait-for -S \"$ORCH_CHANNEL\"" }] }]
  }
}
```

(Swap the command for `printf done > "$ORCH_DONE_FILE"` for the file-sentinel transport — slightly more robust because the sentinel survives if orch isn't yet blocked on `wait-for`.)

### 1.6 The reliability hole — bug #29881

[#29881](https://github.com/anthropics/claude-code/issues/29881) (**closed, not planned**): when the agent stops silently after a tool result with **exit code 1** and no final assistant text, **`Stop` does NOT fire** — and the reporter observed **no `idle_prompt` Notification** either; only `PostToolUse`/`SubagentStop` fired. No hook combination reliably covers this path.

| Event | Fires on #29881 silent stop? |
|---|---|
| `Stop` | No (the bug) |
| `StopFailure` | Likely No (it's not an API error) **[unverified for exact trace]** — but covers rate-limit/billing/auth stops |
| `Notification` `idle_prompt` | Reporter said No **[unverified across versions]** |
| `SessionEnd` | No (session didn't end; it's idling) |
| `SubagentStop` | Fires for subagent turns only, not the top-level silent stop |

**Conclusion: hooks alone cannot be the sole completion detector.** The signal-only auto-stop (current scope) accepts this hang. The robust fix is an **external idle watchdog** owned by orch (poll `tmux capture-pane`, detect the stable `❯` prompt with no spinner / no "esc to interrupt", or output quiescence for N seconds, then terminate). Hook = fast path; watchdog = guaranteed path. This is the deferred next step.

### 1.7 Transcripts

JSONL at `~/.claude/projects/<slugified-path>/<session-uuid>.jsonl`, appended per event (so prior turns survive a mid-turn kill). Path is provided to hooks as `transcript_path`. Clean exit (EOF / `-p` finish) runs `SessionEnd`; SIGKILL bypasses it. Don't set `--no-session-persistence` / `CLAUDE_CODE_SKIP_PROMPT_HISTORY` if you want history. **[full fsync-on-unclean-kill unverified.]**

---

## 2. Codex CLI — making interactive runs non-blocking

### 2.1 Approval × sandbox

`--ask-for-approval`/`-a` (config `approval_policy`): `untrusted`, `on-failure` (**deprecated**), `on-request`, `never`. Use **`never`** for unattended (failures return to the model instead of prompting).

`--sandbox`/`-s` (config `sandbox_mode`): `read-only`, `workspace-write` (network **off** by default), `danger-full-access`.

| Intent | Flags | Blocks on human? |
|---|---|---|
| Unattended write, no net | `-s workspace-write -a never` | No (in-workspace) |
| Unattended write + net | `-s workspace-write -a never -c sandbox_workspace_write.network_access=true` | No |
| Full autonomy | `--dangerously-bypass-approvals-and-sandbox` (`--yolo`) | No (nothing gated) |

- `--full-auto` is **deprecated and rejected by 0.133.0** — don't use it. (Note: orch's `CodexOptions.sandbox` still has a `'full-auto'` value mapping at `src/runners/codex/codex-runner.ts`; verify against installed Codex.)
- **Granular `approval_policy`** is the belt-and-suspenders form that stops *all* prompt categories (MCP elicitations, the model's `request_permissions` tool, execpolicy `rules`, `skill_approval`, `sandbox_approval`) — needed because plain `-a never` covers command approvals but **[unverified whether it alone suppresses MCP elicitations / request_permissions in 0.133.0]**:
  ```toml
  approval_policy = { granular = { sandbox_approval = false, rules = false, mcp_elicitations = false, request_permissions = false, skill_approval = false } }
  ```
- Sandbox impl: macOS Seatbelt (`sandbox-exec`); Linux `bwrap` + seccomp (legacy Landlock flag remains). **Known bug: `network_access=true` silently ignored under macOS Seatbelt** ([#10390](https://github.com/openai/codex/issues/10390)).
- orch denylists `--dangerously-bypass-approvals-and-sandbox`, `--yolo`, `--config`, `--sandbox`, `-c`, `--approval-mode` (`src/runners/codex/codex-runner.ts`); callers go through the structured `sandbox` option.

### 2.2 `notify` — the completion signal

- Config key `notify`, an `array<string>`. The configured argv is spawned with **the event JSON appended as the final argv element**. Inline one-liner works:
  ```toml
  notify = ["bash", "-lc", "tmux -S \"$ORCH_SOCKET\" wait-for -S \"$ORCH_CHANNEL\""]
  ```
  Footgun: with `bash -lc "script"`, the appended JSON lands in `$0` (not `$1`). Harmless if the script ignores it; to read it, append a dummy arg0: `["bash","-lc","<script using $1>","codex-notify"]`.
- **Only event emitted: `agent-turn-complete`** (internally `AfterAgent`). Fires in the interactive TUI at the end of each turn, including turns where a sandboxed command failed (turn-complete = assistant yielded, not commands succeeded). Payload fields (kebab-case): `type`, `thread-id`, `turn-id`, `cwd`, `client`, `input-messages`, `last-assistant-message`.
- **Scope gaps (not reliability bugs):** `notify` does **not** fire for `approval-requested` or plan-mode "waiting" states ([#11808](https://github.com/openai/codex/issues/11808), [#19921](https://github.com/openai/codex/issues/19921)). Since auto-stop bypasses approvals, this is fine. No known Codex analog to Claude #29881 **[unverified that zero edge cases exist]**.
- **Env inheritance confirmed:** the notify child inherits the full `codex` process env (source: `legacy_notify.rs` builds the command with no `env_clear`).

### 2.3 notify vs Codex hooks

Codex 0.133.0 has a full hooks lifecycle (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop`) in `config.toml` via `[[hooks.<Event>]]`, receiving JSON on **stdin**. **But hooks require persisted trust** (`trusted_hash`, `--dangerously-bypass-hook-trust`): a freshly generated per-run config's hooks are untrusted and silently skipped unless you pass the dangerous bypass flag. **Recommendation: use `notify`, not hooks** — `notify` has no trust gate and is exactly "ping on turn complete."

### 2.4 Per-run `notify` injection without touching the user's config

- **Project-local `.codex/config.toml` is a dead end:** `notify` is on the **ignored-keys list** for project-local config, and project config needs trust. Don't use it.
- **`-c notify=[...]`** works but is denylisted (correctly).
- **Recommended: redirect `CODEX_HOME` to a per-run temp dir** that symlinks the real `~/.codex` (inheriting auth + all settings) **except** `config.toml`, which is a copy with one appended `notify` line:

```bash
REAL_CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
RUN_CODEX_HOME="$(mktemp -d "${TMPDIR:-/tmp}/orch-codex.XXXXXX")"
for entry in "$REAL_CODEX_HOME"/* "$REAL_CODEX_HOME"/.[!.]*; do
  [ -e "$entry" ] || continue
  ln -s "$entry" "$RUN_CODEX_HOME/$(basename "$entry")"
done
rm -f "$RUN_CODEX_HOME/config.toml"
cp "$REAL_CODEX_HOME/config.toml" "$RUN_CODEX_HOME/config.toml" 2>/dev/null || :
cat >> "$RUN_CODEX_HOME/config.toml" <<'TOML'

# --- orch per-run injection (do not edit) ---
notify = ["bash", "-lc", "tmux -S \"$ORCH_SOCKET\" wait-for -S \"$ORCH_CHANNEL\""]
TOML

CODEX_HOME="$RUN_CODEX_HOME" codex   # inside tmux, ORCH_SOCKET/ORCH_CHANNEL exported
```

Why: never touches the real `config.toml`; `auth.json` is symlinked so ChatGPT-login *and* API-key auth work; all other user settings inherited; uses only the `CODEX_HOME` env var (no denylisted flag); `notify` honored because the temp home counts as user-level config. Cleanup `rm -rf "$RUN_CODEX_HOME"` removes only symlinks. Alternative: `--profile-v2 <name>` "Layer `$CODEX_HOME/<name>.config.toml` on top of base user config" — cleaner pure-overlay, but **[unverified for the interactive TUI in 0.133.0]**.

---

## 3. Driving & terminating TUIs via tmux (prior art)

orch already owns the pane, so these are the externally-driven termination/detection primitives.

### 3.1 Primitives

| Primitive | Purpose | Reliability |
|---|---|---|
| `tmux send-keys -t pane -l -- "text"` | inject literal text (`-l` critical) | reliable |
| `tmux send-keys -t pane Enter` / `C-c` / `C-d` | keystrokes | reliable; one `C-c` may not be enough |
| `tmux capture-pane -p -J -t pane -S -200` | poll last N lines (`-J` joins wraps) | reliable |
| `tmux pipe-pane -o 'cat >> log'` | stream pane to file | works; can't start from a detached session — set at creation (orch does this under `--debug`) |
| `tmux wait-for -S <chan>` / `wait-for <chan>` | signal / await a channel | reliable; **orch's existing primitive** |
| `tmux display -t pane '#{pane_dead}'` / `'#{pane_dead_status}'` | exit detection + code | needs `remain-on-exit on` at creation |

### 3.2 Completion detection (all imperfect)

- **Shell-prompt regex** (`❯`/`$`/`%`/`#`) — good for Claude/Aider; false-positives when the agent prints prompt-like text.
- **Output-stabilization / hash polling** — coarse idle detection; **cannot distinguish "done" from "blocked waiting for input"**.
- **Sentinel string** the agent is told to print — reliable if the agent obeys; can be printed early or never.
- **Transcript file watching** (`inotifywait`/`fswatch`) — detects turn activity, not "truly done."
- **Lifecycle hook (`Stop` / `notify`)** — the clean signal; subject to §1.6 gaps.
- **`codex exec --json` + process exit** — the only *deterministic* completion signal, but headless-only.

### 3.3 Clean termination

| Signal | Behavior | Notes |
|---|---|---|
| `SIGINT` (C-c) | interrupts turn; second exits | one may not exit |
| `SIGTERM` | handler + cleanup runs | preferred for clean exit |
| `SIGKILL` | **no cleanup**, state left behind | last resort |
| `SIGHUP` | exits on terminal close | `tmux kill-pane` sends SIGHUP to the process group |

Clean sequence for a tmux-hosted TUI: send `/exit` (or `C-u` then `C-d`) at an idle prompt → check `#{pane_dead}` → escalate `kill -TERM -<pane_pid>` (process group) → `tmux kill-pane`. Caveats: Codex `/exit` takes ~10s ([#14223](https://github.com/openai/codex/issues/14223)); typing `/exit` while text is highlighted causes key-injection issues ([#9638](https://github.com/openai/codex/issues/9638)) — only send at a confirmed idle prompt. Claude's `TaskStop` currently sends SIGKILL without a SIGTERM grace ([#37127](https://github.com/anthropics/claude-code/issues/37127)) — prefer EOF/SIGTERM yourself for clean transcripts. Both CLIs write JSONL per-turn, so a mid-turn kill truncates only the current turn.

### 3.4 Launch with an initial prompt

Both accept a **bare positional prompt** that starts work immediately: `claude "task"`, `codex "task"`, `codex exec "task"`, `echo "task" | codex exec -`. Codex/Claude have **no `--prompt` flag**. send-keys-after-launch is fragile (race on TUI readiness — gate with a `wait-for-text` poll for `❯`).

Existing tools worth studying: claude-squad, agent-of-empires, codex-yolo (auto-approver daemon, two-tier prompt regex), claude-agent-farm (heartbeat monitoring, adaptive idle timeout), Codex `remote-control` (v0.130+, official external message injection — more reliable than send-keys for text).

---

## 4. Sandboxing & long-run failure modes (for the deferred autonomy work)

Not needed for signal-only auto-stop, but directly relevant to running unattended for hours.

### 4.1 Sandboxing

- **OS-level:** macOS Seatbelt (`sandbox-exec`); Linux Landlock + seccomp + bubblewrap. Both CLIs use these natively. **Claude's default read policy allows the whole filesystem** including `~/.aws`, `~/.ssh` — must add `denyRead`. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` strips cloud/Anthropic creds from subprocess env by default.
- **Container/VM:** Docker/devcontainers (Claude ships a first-party devcontainer; shared kernel = container escape is host escape), gVisor (20–50% I/O overhead — notable for compile/`npm install`), Firecracker microVMs (strongest isolation, ~125ms boot, persistent disk for multi-hour workspaces).
- **Network egress:** built-in proxies are **hostname-based, no TLS inspection** → domain-fronting / SOCKS5 injection bypasses. Two patched CVEs: `allowedDomains: []` disabled the proxy entirely (CVE-2025-66479, ~130 versions); SOCKS5 null-byte injection. **Do not trust the built-in proxy as a hard boundary** — add an external default-deny egress firewall (iron-proxy / Squid) outside the sandbox, plus iptables rules blocking metadata IPs (`169.254.169.254`).

### 4.2 Failure modes an orchestrator must handle

- **Context exhaustion / compaction:** API auto-compaction at a token threshold; set `pause_after_compaction: true` to get a `stop_reason:"compaction"` signal; instruct "no tool calls during summary" to avoid the `content:null` failure. Hard stop requires `/clear`.
- **Rate / overload:** `429 rate_limit_error` (honor `retry-after`), `529 overloaded_error` (no retry-after). **Claude Code halts on 529 with no auto-retry** ([#60577](https://github.com/anthropics/claude-code/issues/60577)) — the highest-impact long-run failure. Orchestrator should watch pane output for `529`/`rate_limit_error` and backoff-retry with a circuit breaker.
- **Auth expiry:** Claude OAuth tokens expire ~60 min; `/login` does NOT recover an active session ([#12447](https://github.com/anthropics/claude-code/issues/12447), [#15007](https://github.com/anthropics/claude-code/issues/15007)) — **use API keys for unattended runs**. Codex refreshes OAuth in active sessions but has silent refresh-failure cases ([#5678](https://github.com/openai/codex/issues/5678)).
- **Stuck agent:** infinite tool loops, hung subprocess, waiting on never-coming input. Need **two monitors** — liveness (process alive?) and progress (new output within N min?). Watchdog: poll last-output timestamp; on stall send soft interrupt, then SIGTERM, then restart; hash last-N-lines to detect output loops. (This is the same watchdog that closes the §1.6 hang.)
- **Runaway spend:** a documented session burned 1.67B tokens / 5h. Track `usage` per response; hard ceiling + turn cap + per-request `max_tokens`; enforce via a proxy that returns 429 at budget; velocity circuit breaker.
- **Checkpointing:** the **orchestrator** owns recovery state, not the agent. Instruct git commits / `PROGRESS.md` per logical unit; verify `git log` advanced; replay the last prompt into a fresh session on crash. Design prompts idempotent.

---

## 5. orch architecture map (where auto-stop plugs in)

Baseline: TypeScript strict + `noUncheckedIndexedAccess`, Bun ≥ 1.2, `ink`/`react` TUI, `Bun.spawn` behind `ProcessService` (**no node-pty anywhere — tmux owns all PTYs**).

### 5.1 Two existing axes

- `StepMode = 'interactive' | 'autonomous'` (`src/core/types.ts:12`) — per-step.
- `RunMode = 'plain' | 'single-pane' | 'two-pane'` (`src/core/run-mode.ts`) — per-run, picks the host.

Auto-stop is a **flag on the interactive step**, not a new `StepMode` literal.

### 5.2 Runner interface (`src/runners/types.ts:95-148`)

Four methods: `buildCommand(ctx) → {argv, env}` (`:110`), `parseEvents` (`:111`), `extractStructuredOutput` (`:112`), `toTranscriptLines` (`:121`). Optional `resumeCommand`, `captureSessionId`. Concrete: `claude()` (`src/runners/claude/claude-runner.ts:214`), `codex()` (`src/runners/codex/codex-runner.ts:270`). Mode branch is inside `buildCommand` keyed off `RunnerContext.mode` (`types.ts:17`): Claude `buildInteractiveArgv` (`:174-187`) vs `buildAutonomousArgv` (`:189-208`); Codex (`:216-235` / `:237-264`). Interactive Claude passes **no** unattended flags unless the caller adds them via `flags`. Denylists: Claude `['--settings','--mcp-config']` (`:80-85`); Codex blocks `-c`/`--config`/`--sandbox`/`--approval-mode`/`--yolo`/`--dangerously-bypass-approvals-and-sandbox` (`:62-69`).

**Auto-stop adds a small capability here** — register the per-run stop hook (write `.claude/settings.local.json` / set up temp `CODEX_HOME`) + declare the env vars. Open design: new optional Runner method vs fold into `buildCommand` when `ctx.autoStop`.

### 5.3 tmux host & session lifecycle (`src/hosts/two-pane/tmux-host.ts`)

Interactive steps go through `host.runInteractive(...)` (`workflow.ts:487-492` → `tmux-host.ts:910-1185`), NOT `execute.ts:runInteractive`. Topology: one visible `orch` session per run (socket `orch-<runId>`, `:272`); left pane = steps-view Ink daemon, right pane = swap target; hidden source panes in per-source sessions `orch-src-<key>` (`source-session.ts`). The interactive spawn registers a `{kind:'pty', argv, env, cwd}` source, swaps it visible, then **waits on `pane-exit-<hiddenPaneId>` with NO timeout** (`:1102-1105`) — `WaitForOptions.timeoutMs` exists (`tmux-service.ts:216-221`) but is deliberately unused so a human can pause forever. On resolve, orch returns **`exitCode: 0` unconditionally** (`:1184`) — tmux's `pane-died` hook doesn't surface the child code.

**Auto-stop changes here:** race the `pane-exit` wait against a new `stop-<sourceKey>` channel; on the stop signal, drive a clean pane termination (then kill-fallback). The host owns the socket + channel and injects `ORCH_SOCKET`/`ORCH_STOP_CHANNEL` into the spawn env after the runner builds the command.

`ProcessService` (`src/services/process/`) uses `Bun.spawn`; `kill` defaults SIGTERM. **Interactive PTY is tmux's, not ProcessService's** — completion/kill must go through tmux.

### 5.4 Hooks/config injection today

orch **never** writes a Claude `settings.json`/hooks or Codex config today. Permission bypass is flag-only. Phase 14 (not started) *plans* a `PreToolUse`/`Stop` hook via `--settings` for escalation — but `--settings` is currently denied. So auto-stop's injection (`.claude/settings.local.json` in cwd; temp `CODEX_HOME`) is **new wiring** and works *around* the denylist rather than relaxing it.

### 5.5 State / logging

`runId = r-YYYY-MM-DD-HHMMSS-xx`, under `<cwd>/.orch/state/<runId>/`. Interactive steps emit **only `session.json`** (`docs/logging.md:53-54`) — no event/transcript capture (tmux owns the bytes). Pane-map lifecycle events land in `lifecycle.ndjson` — the natural place to add auto-stop telemetry (R12). `runInteractiveStep` throws `StepError` on non-zero exit (`workflow.ts:521-524`), but since the host always returns 0, interactive steps effectively always "succeed."

### 5.6 Env-merge — CLAUDE.md drift

`mergeEnv(processEnv, extras, ctxEnv)` (lowest→highest precedence) is at **`src/services/process/merge-env.ts`**, re-exported via `src/services/index.ts` — **NOT** `src/runners/_shared/merge-env.ts` as CLAUDE.md (and the runner-author skill) state. There is no `src/runners/_shared/` directory. `extras` is inlined per-runner (`{FORCE_COLOR:'3'}` in interactive). Fix the doc drift when touching this.

### 5.7 Relevant prior docs

- `docs/brainstorms/2026-04-28-autonomous-transcript-rendering-brainstorm.md` — scopes interactive steps *out* ("the pane is attached to the agent's TUI and looks fine"); auto-stop blurs that line.
- `docs/plans/implementation-phases.md` — active frontier is the step-views/run-modes reframe + Codex parity + Phase 18 `ask()` step (the *inverse* of "no questions") + Phase 14/15 escalation (closest existing design to human-in-loop vs autonomous; contemplates the `--settings` hook injection).
- `docs/testing-strategy.md` — four-tier two-pane model; auto-stop tests should be Tier 1 (real-tmux + FakeRunner) or Tier 2 (Ink projection). Triage rule applies.

---

## 6. Recommended design (synthesis)

For **signal-only auto-stop** (current scope):

1. Author writes `mode:'interactive', autoStop:true` on the step.
2. Runner registers a per-run inline stop hook: Claude → `.claude/settings.local.json` (Stop + StopFailure) in cwd; Codex → temp `CODEX_HOME` with appended `notify`. The hook command is `tmux -S "$ORCH_SOCKET" wait-for -S "$ORCH_STOP_CHANNEL"`.
3. tmux host allocates the channel, injects `ORCH_SOCKET`/`ORCH_STOP_CHANNEL` into the spawn env, races `pane-exit-<id>` against `stop-<key>`.
4. On stop signal, host terminates the pane (clean `/exit`/EOF, then SIGTERM, then `kill-pane` with a bounded timeout), cleans up the injected config, returns.
5. Emit auto-stop lifecycle events into `lifecycle.ndjson`.

**Known residual:** Claude #29881 silent-stop hangs (no watchdog yet). **Next step:** add an orch-owned idle watchdog (capture-pane quiescence / prompt detection) as the guaranteed-termination backstop, and — separately — real exit-code capture for interactive steps.

---

## 7. Source index

**Claude Code:** [CLI reference](https://code.claude.com/docs/en/cli-reference) · [Permission modes](https://code.claude.com/docs/en/permission-modes) · [Permissions](https://code.claude.com/docs/en/permissions) · [Settings](https://code.claude.com/docs/en/settings) · [Tools reference](https://code.claude.com/docs/en/tools-reference) · [Hooks](https://code.claude.com/docs/en/hooks) · [Hooks guide](https://code.claude.com/docs/en/hooks-guide) · [Env vars](https://code.claude.com/docs/en/env-vars) · [Authentication](https://code.claude.com/docs/en/authentication) · [Headless](https://code.claude.com/docs/en/headless) · [Sandboxing](https://code.claude.com/docs/en/sandboxing) · [Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)

**Claude issues:** [#27244](https://github.com/anthropics/claude-code/issues/27244) · [#35280](https://github.com/anthropics/claude-code/issues/35280) · [#29881](https://github.com/anthropics/claude-code/issues/29881) · [#55754](https://github.com/anthropics/claude-code/issues/55754) · [#36403](https://github.com/anthropics/claude-code/issues/36403) · [#5572](https://github.com/anthropics/claude-code/issues/5572) · [#37127](https://github.com/anthropics/claude-code/issues/37127) · [#60577](https://github.com/anthropics/claude-code/issues/60577) · [#12447](https://github.com/anthropics/claude-code/issues/12447) · [#15007](https://github.com/anthropics/claude-code/issues/15007) · [#33049](https://github.com/anthropics/claude-code/issues/33049)

**Codex:** [CLI reference](https://developers.openai.com/codex/cli/reference) · [Features](https://developers.openai.com/codex/cli/features) · [Approvals & security](https://developers.openai.com/codex/agent-approvals-security) · [Sandboxing](https://developers.openai.com/codex/concepts/sandboxing) · [Config basics](https://developers.openai.com/codex/config-basic) · [Advanced config (notify, profiles)](https://developers.openai.com/codex/config-advanced) · [Config reference](https://developers.openai.com/codex/config-reference) · [Non-interactive (exec)](https://developers.openai.com/codex/noninteractive) · [Auth](https://developers.openai.com/codex/auth) · [Hooks](https://developers.openai.com/codex/hooks) · source `codex-rs/hooks/src/legacy_notify.rs` @ `rust-v0.133.0`

**Codex issues:** [#23132](https://github.com/openai/codex/issues/23132) · [#4005](https://github.com/openai/codex/issues/4005) · [#5678](https://github.com/openai/codex/issues/5678) · [#10390](https://github.com/openai/codex/issues/10390) · [#11808](https://github.com/openai/codex/issues/11808) · [#19921](https://github.com/openai/codex/issues/19921) · [#14223](https://github.com/openai/codex/issues/14223) · [#9638](https://github.com/openai/codex/issues/9638)

**tmux / orchestration prior art:** [tmux as agent runtime (DEV)](https://dev.to/battyterm/how-tmux-became-the-runtime-for-ai-agent-teams-gmi) · [agent-stuff tmux SKILL](https://github.com/mitsuhiko/agent-stuff/blob/main/skills/tmux/SKILL.md) · [codex-yolo](https://github.com/codex-yolo/codex-yolo) · [claude_code_agent_farm](https://github.com/Dicklesworthstone/claude_code_agent_farm) · [agent-of-empires](https://github.com/njbrake/agent-of-empires) · [Running Claude Code overnight](https://medium.com/@evekhm/running-claude-code-autonomously-overnight-what-breaks-and-how-to-fix-it-3bee3bd958b5)

**Sandboxing / failure modes:** [Anthropic: Claude Code sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing) · [Sandbox bypass writeup](https://www.penligent.ai/hackinglabs/claude-code-sandbox-bypass/) · [Firecracker vs Docker](https://nextkicklabs.substack.com/p/firecracker-vs-docker-security-tradeoffs) · [Long-running agents (Osmani)](https://addyo.substack.com/p/long-running-agents) · [iron-proxy](https://github.com/ironsh/iron-proxy)

---

## 8. Unverified items to smoke-test during planning

1. Whether Claude `StopFailure` fires on the exact #29881 silent-stop trace (likely not).
2. Whether writing `.claude/settings.local.json` into a fresh cwd triggers a trust/hook-review prompt in the target version (write-before-launch mitigates).
3. Whether enterprise `allowManagedHooksOnly` is set in the target environment (would suppress injected hooks).
4. Codex: whether `-a never` alone suppresses MCP-elicitation / `request_permissions` prompts, or the granular form is required.
5. Codex `--profile-v2` layering for the interactive TUI in 0.133.0 (alternative to copy-config.toml).
6. Whether `tmux wait-for -S` from the hook reliably reaches orch when orch is mid-setup (the file-sentinel fallback covers the race).
7. EOF/`Ctrl-D` on an idle interactive REPL → clean transcript flush + `SessionEnd exit_reason: prompt_input_exit`.
8. orch's `CodexOptions.sandbox: 'full-auto'` mapping vs Codex 0.133.0's deprecation/rejection of `--full-auto`.
