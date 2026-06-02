# API Error Surfacing in Claude Code and Codex

> Research note — how an orchestrator that drives Claude Code and the OpenAI Codex
> CLI as subprocesses can **programmatically detect API errors** (transient
> overload/rate-limit retries and terminal failures) in both interactive and
> non-interactive modes.
>
> Status: research findings, 2026-06-01. Source-grounded against official docs and
> the `openai/codex` Rust source. Flagged items are version-dependent — re-verify
> against the pinned CLI version you ship against.

## Motivation

This investigation started from a real failed run in `examples/.orch/`:

- **Run:** `r-2026-05-29-102541-rm` — workflow `file-prompts-demo`, `status: "failed"`,
  autonomous (non-interactive) run.
- **Where the error landed:**
  `examples/.orch/state/r-2026-05-29-102541-rm/logs/agents/research/raw_output.ndjson`
- **What it contained:** repeated `api_retry` events from Claude Code's stream-json
  output:

  ```json
  {"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":612.5,"error_status":529,"error":"rate_limit","session_id":"8814f9ea-...","uuid":"..."}
  {"type":"system","subtype":"api_retry","attempt":2,"max_retries":10,"retry_delay_ms":1189.5,"error_status":529,"error":"rate_limit",...}
  ...
  ```

  HTTP **529 "Overloaded"**, retried with exponential backoff (612ms → 1.2s → 2.5s →
  5s → 9.2s …) up to `max_retries: 10`, after which the run ended `failed`.

That answered "how does a 529 surface in a **non-interactive Claude Code** run." This
note generalizes to the other three quadrants: interactive Claude Code, and both
modes of Codex — so the `Runner` adapters can surface a consistent error signal to
the core regardless of agent/mode.

## TL;DR — detection matrix

| Mode | Transient retry signal | Terminal-failure signal |
|---|---|---|
| **Claude Code — non-interactive** (`claude -p`, stream-json) | `api_retry` system events (per attempt) ✅ | transcript record with `isApiErrorMessage: true` |
| **Claude Code — interactive** (TUI) | ❌ none (no hook) — scrape transcript/status text | **`StopFailure` hook** with typed `error` ✅ |
| **Codex — non-interactive** (`codex exec --json`) | `{"type":"error",...}` line (string-match; lossy) | `{"type":"turn.failed",...}` + **exit code 1** ✅ |
| **Codex — interactive** (TUI) | ❌ none (no hook) — scrape PTY / `codex-tui.log` | ❌ no hook — scrape PTY / `codex-tui.log` |

Two structural takeaways:

1. **Claude Code interactive gives you a real hook (`StopFailure`); Codex interactive
   gives you nothing programmatic.** For Codex, prefer driving `codex exec --json` +
   exit code over scraping an interactive PTY.
2. For **both** tools, *transient* 529/overload retries are only cleanly observable in
   **non-interactive** stream output. Interactive mode only reliably gives you the
   *terminal* outcome (and only Claude Code surfaces even that via a hook).

A note on terminology: **OpenAI/Codex uses HTTP 503 + `error.code: "server_is_overloaded"`,
not literally 529.** The literal string "529" does not appear in Codex source. The
Codex analog of Anthropic's 529 is `CodexErr::ServerOverloaded` /
`CodexErrorInfo::ServerOverloaded`.

---

## Claude Code

### Non-interactive (`claude -p`, stream-json)

This is the path we already observe in `.orch` logs.

- **Transient retries:** one `api_retry` system event per attempt:

  ```json
  {"type":"system","subtype":"api_retry","attempt":N,"max_retries":10,"retry_delay_ms":<float>,"error_status":529,"error":"rate_limit","session_id":"...","uuid":"..."}
  ```

  - Retry count controlled by `CLAUDE_CODE_MAX_RETRIES` (default 10), exponential backoff.
  - `error_status` carries the HTTP code (e.g. `529`); `error` is the category
    (`rate_limit`, etc.).

- **Terminal failure:** written into the transcript as a synthetic assistant record:

  ```json
  {"type":"assistant","message":{"model":"<synthetic>","role":"assistant","usage":{...all zeros...},"content":[{"type":"text","text":"API Error: ..."}]},"error":"rate_limit","isApiErrorMessage":true}
  ```

  Distinguishing marks: `isApiErrorMessage: true`, `model: "<synthetic>"` (or blank),
  all-zero `usage`.

### Interactive (TUI) — via hooks

- **Dedicated hook: `StopFailure`.** Fires *instead of* `Stop` when a turn ends due to
  an API error (after the internal retry loop is exhausted). stdin payload:

  ```json
  {
    "session_id": "abc123",
    "transcript_path": ".../<sessionId>.jsonl",
    "cwd": "/...",
    "hook_event_name": "StopFailure",
    "error": "server_error",
    "error_details": "...",
    "last_assistant_message": "API Error: Repeated 529 Overloaded errors..."
  }
  ```

  - `error` is a typed enum, usable as a hook matcher:
    `rate_limit`, `authentication_failed`, `oauth_org_not_allowed`, `billing_error`,
    `invalid_request`, `model_not_found`, **`server_error`**, `max_output_tokens`,
    `unknown`.
  - **HTTP 529 → `error: "server_error"`** (529/5xx are server-side). There is no
    dedicated `overloaded`/`529` enum value — confirm against `error_details` /
    `last_assistant_message` content. *(Flagged: the docs group 529 under "Server
    errors"; the exact enum mapping is inferred, not verbatim.)*
  - For `StopFailure`, `last_assistant_message` holds the **error string itself** (not
    conversational text). Observe-only: output and exit code are ignored.

- **Transient retries are NOT surfaced to any hook.** Claude Code retries internally
  (`Retrying in Ns · attempt x/y` in the spinner) entirely below the hook surface.
  There is no `OnApiRetry`-style hook (open feature request).

- **Hooks that do NOT carry API-error info:** `Notification` (its `notification_type`
  values are only `permission_prompt`, `idle_prompt`, `auth_success`,
  `elicitation_dialog`, `elicitation_complete`, `elicitation_response`), `Stop`,
  `SubagentStop` (`stop_hook_active` is a continuation-loop flag, not a success/fail
  signal), and `SessionEnd` (its `reason` enum — `clear`, `resume`, `logout`,
  `prompt_input_exit`, `bypass_permissions_disabled`, `other` — has no error reason).

- **Fallback detection for retries (no hook available):**
  - Tail the `transcript_path` JSONL for `isApiErrorMessage: true` records. *(Caveat:
    some crash/subagent failure shapes write no error record at all.)*
  - Scrape the `Retrying in Ns · attempt x/y` status text from the PTY.
  - Lower `CLAUDE_CODE_MAX_RETRIES` so failures terminalize and fire `StopFailure`
    sooner. `API_TIMEOUT_MS` tunes per-request timeout.

**Recommended for the orchestrator (CC interactive):** register a `StopFailure` hook
(no matcher, or matcher `server_error|rate_limit|...`) that writes
`{error, error_details, last_assistant_message, session_id}` to a file/socket the
orchestrator watches. That is the closest interactive equivalent of the non-interactive
terminal-error signal. Transient retries remain hook-invisible.

### Claude Code sources

- Hooks reference (event list, `StopFailure`/`Notification` schemas, matcher enums):
  https://code.claude.com/docs/en/hooks
- Error reference (529/429/5xx strings, automatic retries, `CLAUDE_CODE_MAX_RETRIES`,
  `API_TIMEOUT_MS`): https://code.claude.com/docs/en/errors
- `Notification` does not fire on rate limits: https://github.com/anthropics/claude-code/issues/34817
- No hook for upstream 5xx/network/rate-limit failures: https://github.com/anthropics/claude-code/issues/48650
- `OnApiRetry` proposal (confirms retries are hook-invisible): https://github.com/anthropics/claude-code/issues/46959
- Captured transcript `isApiErrorMessage` records: https://github.com/anthropics/claude-code/issues/40584,
  https://github.com/anthropics/claude-code/issues/62146
- Raw HTTP 529 `overloaded_error`: https://platform.claude.com/docs/en/api/errors

---

## Codex (Rust CLI)

### Internal error model (shared across modes)

Codex maps HTTP statuses to a typed error enum in `codex-rs/core/src/api_bridge.rs`
(`map_api_error`):

- **429** → if body `type == "usage_limit_reached"` → `UsageLimitReached` (carries
  `plan_type`, `resets_at`, rate-limit headers); if `usage_not_included` →
  `UsageNotIncluded`; otherwise → `RetryLimit` / `ResponseTooManyFailedAttempts`.
- **503** with body `error.code ∈ {"server_is_overloaded","slow_down"}` →
  **`ServerOverloaded`** (the 529/overloaded analog).
- **500** → `InternalServerError`. **400** → `BadRequest`/`InvalidRequest`. Other →
  `UnexpectedStatus`.

The structured classifier `CodexErrorInfo` (snake_case in core protocol, camelCase in
the app-server v2 protocol) carries the category and, for several variants, the raw
`http_status_code`:

```
ContextWindowExceeded, UsageLimitExceeded, ServerOverloaded, CyberPolicy,
HttpConnectionFailed { http_status_code }, ResponseStreamConnectionFailed { http_status_code },
InternalServerError, Unauthorized, BadRequest, SandboxError,
ResponseStreamDisconnected { http_status_code }, ResponseTooManyFailedAttempts { http_status_code },
ActiveTurnNotSteerable { turn_kind }, ThreadRollbackFailed, Other
```

Two event variants in the internal `EventMsg` protocol distinguish transient vs terminal:

- `StreamError(StreamErrorEvent { message, codex_error_info, additional_details })` —
  "stream experienced an error/disconnect and the system is handling it (e.g. retrying
  with backoff)." Transient.
- `Error(ErrorEvent { message, codex_error_info })` — terminal for the turn.

The app-server layer (`bespoke_event_handling.rs`) collapses both into one
`ErrorNotification` with a **`will_retry` bool**: `StreamError → will_retry: true`,
`Error → will_retry: false`. This boolean is the cleanest terminal-vs-transient signal —
but it exists only on the **app-server / SDK** surface, not on `codex exec --json`.

### Retry / backoff behavior

- Two layers: transport-level retries (`request_max_retries`, default **4**) and a
  turn-level stream-reconnect loop (`stream_max_retries`, default **5**).
- Backoff (`codex-rs/core/src/util.rs`): `200ms · 2^(attempt-1) · jitter(0.9–1.1)`
  → ~200ms, 400ms, 800ms, 1.6s, 3.2s. A server-supplied "try again in Ns" delay is
  preferred when present. Backoff cadence is not configurable (issue #16164).
- **Retryable** errors: `Stream`, `Timeout`, `UnexpectedStatus`, `ConnectionFailed`,
  `InternalServerError`, etc. **NOT retryable** (fail fast): `UsageLimitReached`,
  `ServerOverloaded`, `QuotaExceeded`, `RetryLimit`, `ContextWindowExceeded`. So an
  overload/usage-limit surfaces terminally rather than spinning in the retry loop.
- **Gotcha (issue #3026, by design):** for the built-in `openai` provider,
  `request_max_retries` / `stream_max_retries` / `stream_idle_timeout_ms` from config
  are **ignored** (hard-set to defaults). They only apply to custom providers.

### Non-interactive (`codex exec --json`) — the clean orchestration surface

- JSONL on stdout, one event per line (`codex-rs/exec/src/exec_events.rs`). stdout is
  pure JSONL in `--json` mode; everything else (logs, retry chatter) goes to stderr.
- `ThreadEvent` types: `thread.started`, `turn.started`, `turn.completed`,
  `turn.failed`, `item.started/updated/completed`, `error`.
- **Error events on this surface:**
  - `{"type":"error","message":"..."}` — emitted for **both** transient retries
    *and* fatal stream errors. **Lossy: no status code, no typed category** — only a
    `message` string. (`will_retry` and `codex_error_info` are dropped at this layer.)
  - `{"type":"turn.failed","error":{"message":"..."}}` — the authoritative terminal
    signal.
- **Classification requires string-matching `message`** on this surface, e.g.:
  - `"Reconnecting... N/M"` / `"stream error: ...; retrying N/5 in ..."` → transient (continue).
  - `"exceeded retry limit, last status: 429 Too Many Requests"` → rate-limit terminal.
  - `"at capacity"` / `"high demand"` → overloaded / 5xx.
  - `"Usage limit reached"` / `"You're out of credits"` → usage limit.
- **Exit code is the most reliable bit:** `1` on terminal failure (`will_retry: false`
  or turn `Failed`/`Interrupted`); `0` if a retried error eventually succeeds. Appears
  to be binary 0/1 (no per-class codes).
- **For structured classification** (429 vs 503-overload vs usage-limit), use the
  `codex app-server` protocol / `@openai/codex-sdk`, which preserves `codexErrorInfo`,
  `httpStatusCode`, and `will_retry`. `exec --json` does not expose these.

### Interactive (TUI) — no hook covers API errors

- The external `notify` program fires **exactly one** event, `agent-turn-complete`,
  and **only on success** — the error path `break`s before invoking it. Its payload:

  ```json
  {"type":"agent-turn-complete","thread-id":"...","turn-id":"...","cwd":"...","client":"codex-tui","input-messages":[...],"last-assistant-message":"..."}
  ```

  *(Flagged: `notify` is officially slated for deprecation in favor of the newer
  `[hooks]` system.)*
- The newer `[hooks]` system (`PreToolUse`, `PermissionRequest`, `PostToolUse`,
  `PreCompact`, `PostCompact`, `SessionStart`, `UserPromptSubmit`, `SubagentStart`,
  `SubagentStop`, `Stop`) **also has no API-error / rate-limit / retry event.** The
  closest, `Stop`, carries no error classification and runs on the turn's success path.
- The TUI **does not exit** on an API error — it renders an error cell and accepts the
  next prompt. So exit code is not a TUI signal.
- **Session JSONL is unreliable for error detection in TUI mode.** Per
  `codex-rs/core/src/rollout/policy.rs`: `StreamError` (retries) is **never persisted**;
  `Error` (terminal) is persisted **only in `Extended` mode**, which the TUI hard-codes
  to `false`. Unlike Claude Code's transcript, you cannot trust the Codex rollout file
  for errors. (What *is* reliably there: `SessionMeta`, `ResponseItem`s, `TokenCount`
  with a `RateLimitSnapshot` — useful for proximity-to-limit, not for failures.)
- **Fallback detection (interactive):**
  - PTY/stderr text scraping: `Reconnecting... N/M`, `stream error: ...; retrying N/5
    in ...`, `exceeded retry limit, last status: 429 Too Many Requests`,
    `Usage limit reached`, `Selected model is at capacity`,
    `We're currently experiencing high demand`.
  - Tail `~/.codex/log/codex-tui.log` — the retry path logs
    `warn!("stream disconnected - retrying turn (n/max in ...)")`. Cleaner than PTY
    scraping; depends on `RUST_LOG` capturing `warn`. *(Caveat issue #2248: on very
    fast exit the log appender may not flush the last lines.)*

### Rollout / session files and logs

- Rollout JSONL: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`
  (`CODEX_HOME` defaults to `~/.codex`). Lines are `RolloutItem` records
  (`SessionMeta`, `TurnContext`, `ResponseItem`, `EventMsg`, `Compacted`). `--ephemeral`
  disables writing it. Persistence policy filters out `StreamError` always and `Error`
  except in `Extended` mode (see above).
- Logs: `~/.codex/log/codex-tui.log` (TUI, default `RUST_LOG=...=info`). `codex exec`
  logs to stderr at level `error` by default — no separate exec log file; use the
  `--json` stream instead.

### Codex sources

- `codex exec --json` event schema: https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs
- exec jsonl processor / exit-code logic: https://github.com/openai/codex/blob/main/codex-rs/exec/src/event_processor_with_jsonl_output.rs,
  https://github.com/openai/codex/blob/main/codex-rs/exec/src/lib.rs
- `EventMsg` / `ErrorEvent` / `StreamErrorEvent` / `CodexErrorInfo` / `TokenCount`:
  https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs
- `CodexErr` + `is_retryable` + `to_codex_protocol_error`: https://github.com/openai/codex/blob/eaf81d3f/codex-rs/core/src/error.rs
- HTTP→error mapping (`map_api_error`): https://github.com/openai/codex/blob/eaf81d3f/codex-rs/core/src/api_bridge.rs
- app-server `will_retry` mapping: https://github.com/openai/codex/blob/main/codex-rs/app-server/src/bespoke_event_handling.rs
- Retry/backoff: https://github.com/openai/codex/blob/main/codex-rs/core/src/util.rs,
  https://github.com/openai/codex/blob/9a8730f3/codex-rs/core/src/model_provider_info.rs
- `notify` payload + invocation: https://github.com/openai/codex/blob/main/codex-rs/hooks/src/user_notification.rs,
  https://github.com/openai/codex/blob/main/codex-rs/hooks/src/legacy_notify.rs
- Rollout recorder + persistence policy: https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder.rs,
  https://github.com/openai/codex/blob/main/codex-rs/core/src/rollout/policy.rs
- Official docs: https://developers.openai.com/codex/noninteractive,
  https://developers.openai.com/codex/config-advanced,
  https://developers.openai.com/codex/config-reference
- Relevant issues: #19921, #14813 (notify has no error events; deprecation note),
  #4161 (retry-after parsing), #3026 (config ignored for openai provider),
  #16164 (backoff not configurable), #2248 (log flush on fast exit)

---

## Implications for the `Runner` adapters

Each runner should normalize these into a single internal error signal exposed to the
core (category + HTTP status + transient-vs-terminal). Where to read it:

- **ClaudeRunner, non-interactive:** parse `api_retry` system events (transient) and
  `isApiErrorMessage` transcript records (terminal) from stream-json. *(Already the
  path exercised by the `.orch` logs above.)*
- **ClaudeRunner, interactive:** install a `StopFailure` hook → file/socket the runner
  watches; map `error` enum to the internal category. No transient signal available.
- **CodexRunner, non-interactive:** parse `codex exec --json` (`turn.failed` + the
  `error` line) and the process exit code; string-match `message` for category, or use
  the app-server protocol for typed `codexErrorInfo` + `will_retry`.
- **CodexRunner, interactive:** no programmatic hook — scrape PTY text or
  `~/.codex/log/codex-tui.log`. Prefer steering Codex automation through
  `codex exec --json` instead of an interactive PTY when error detection matters.

### Version-dependence flags

- Claude Code: `StopFailure` → `server_error` mapping for 529 is inferred, not
  verbatim-documented; confirm via `error_details`/`last_assistant_message`.
- Codex: `EventMsg`, `CodexErrorInfo`, and `RolloutItem` enums are `#[non_exhaustive]`
  and drift between releases; `CodexErr` is mid-migration between `core` and `protocol`
  crates; rollout persistence policy for `Error`/`StreamError` has changed across
  revisions; `--json` was once `--experimental-json`; `status_code` on error events is
  recent and not yet plumbed into the `exec --json` surface. Pin to your shipped CLI
  version and re-derive.
