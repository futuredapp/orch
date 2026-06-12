---
date: 2026-06-12
status: brainstorm
topic: Fetch coding-agent session history (Claude Code + Codex) and gather a whole orch run's agent transcripts for after-the-fact analysis
relates-to: docs/logging.md, src/state/state-store.ts, scripts/fetch-session.ts, scripts/fetch-workflow.ts
audited: 2026-06-12 — on-disk schemas for both CLIs verified against live session files on this machine (Claude Code 2.1.170, Codex 0.139.0) and cross-checked against the openai/codex Rust source + community parsers. The orch run→session linkage was traced through src/state/state-store.ts and src/core/workflow.ts. Both scripts were run end-to-end against real runs.
---

# Session & Workflow Fetchers — Brainstorm

## TL;DR

Two small, dependency-free Bun scripts that turn raw coding-agent history into something you can *reason about*:

- **`scripts/fetch-session.ts`** — given a Claude Code **or** Codex session UUID, locate it on disk, normalize the wildly different JSONL schemas into one model, and emit it as JSON / Markdown / raw. Auto-detects which CLI produced the ID; accepts partial-ID prefixes.
- **`scripts/fetch-workflow.ts`** — given an orch `runId`, gather *every* agent session that run produced into one folder (`.orch/state/<runId>/analysis/`): a "how it executed" overview plus one Markdown transcript per agent step. Reuses `fetch-session.ts`. Idempotent.

The point: stop squinting at scattered `.jsonl` files. Point an agent (or yourself) at one folder and ask *"look at this whole workflow — what errors happened, what could we improve?"*

## Why build this

**orch chains agents, but the evidence of what they did is scattered and unreadable.** A single orch run fans work across many Claude/Codex sub-sessions. When a run goes sideways — a step loops, a move is wrong, a review misses something — the actual reasoning lives in each CLI's native session log, which is:

1. **In two different places, in two different formats.** Claude Code writes `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`; Codex writes `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. The record schemas barely resemble each other (Claude: `type`-tagged envelope with `message.content` blocks; Codex: `{timestamp,type,payload}` with the real discriminator nested in `payload.type`, plus `event_msg` duplicates of every message).
2. **Keyed by an opaque UUID**, with no obvious path from "the run I just watched" to "the transcript files behind it."
3. **Not designed to be read by a human in bulk** — they're append-only operational logs, not narratives.

**The compounding goal.** This repo's whole thesis is compound engineering: a run should teach you something. But a learning loop needs *legible* evidence. Today the evidence exists but is effectively write-only. These fetchers make a finished run reviewable in one shot — by a person, and (more importantly) by an analysis agent. That's the unlock: *"here's the full workflow, all the agents, tell me the failure modes"* becomes a one-liner instead of an archaeology project.

**Why it's cheap to build.** orch already captures the missing link. Each step persists the underlying session UUID in `state.json` → `steps.<name>.sessionId` (`src/state/state-store.ts`), captured at spawn time (Claude via `--session-id`, Codex by snapshotting its rollout dir). So the hard part — mapping a run to its transcripts — is just a field lookup, not a heuristic. No timestamp/cwd guessing required.

## The idea

### Layer 1 — `fetch-session.ts`: one session, any tool

A reader that hides the two-format mess behind a single normalized model:

```
NormalSession { id, tool, cwd, gitBranch, model, cliVersion, startedAt, title, messages[] }
NormalMessage { role: user|assistant|system|reasoning|tool, text?, toolCalls?, toolResult?, meta? }
```

Key decisions:

- **Locate by globbing both stores.** A UUID alone doesn't say which CLI made it, so `--tool auto` (the default) searches `~/.claude/projects/*/<id>.jsonl` *and* `~/.codex/sessions/**/rollout-*-<id>.jsonl`. The tool is inferred from where the file is found.
- **Codex de-duplication.** Build the transcript from `response_item` records only; `event_msg` (`user_message`/`agent_message`) is a byte-duplicate of the same content. Getting this wrong doubles every message.
- **Tolerate schema drift.** Both formats are unversioned and evolving. Branch on `type`, ignore unknown record types, treat every field but `type` as optional.
- **Three output shapes.** `json` (normalized, for programmatic analysis), `markdown` (readable narrative), `raw` (untouched records, for debugging the parser itself).

### Layer 2 — `fetch-workflow.ts`: a whole run, gathered once

Given a `runId`, it reads `state.json`, walks the steps, and for each step that captured a `sessionId` it calls into `fetch-session`'s `fetchSession()` + `toMarkdown()`. Output lands in the run's own state dir so it travels with the run:

```
.orch/state/<runId>/analysis/
  _overview.md            ← workflow summary + step table + ⚠️ attention callout
  NN-<step>-<tool>.md     ← one transcript per agent step (interactive AND autonomous)
```

The **overview** is the "brief description of how the workflow executed" — it merges `state.json` (canonical step list, mode, validations, status) with `logs/spawns.ndjson` (per-step `exitCode`, `runnerName`, `durationMs`) into:

- header: workflow name, status, duration, args, agent-step count;
- a **⚠️ Needs attention** section auto-derived from the data — crashed/failed run status, non-zero exit codes, `sessionIdCaptureError`s, failed validations, and steps that needed retries;
- a step table (runner · mode · status · duration · transcript link).

Key decisions:

- **Stored once, idempotent.** Already-written transcripts are skipped unless `--force`. Re-running on a live run just tops up new steps. Output sits under gitignored `.orch/`, so it never pollutes the repo.
- **Interactive *and* autonomous.** A step gets a transcript iff it has a captured `sessionId`, regardless of TTY mode — both kinds land in the same native CLI stores.
- **Reuse, don't reimplement.** `fetch-session.ts` exports its internals and guards its CLI with `import.meta.main`; `fetch-workflow.ts` imports them. One parser, two entry points.

## Why a standalone script, not core

These are **analysis tools**, deliberately outside `src/`:

- They read `~/.claude` and `~/.codex` directly rather than through `ProcessService` — they touch no subprocesses, and they must work against history produced by *other* machines/versions, so the core's isolation rules don't apply.
- They're read-only and side-effecting only into the gitignored run dir.
- Keeping them in `scripts/` (alongside `changelog-section.ts`, `build-binary.ts`) means zero coupling to the orchestrator's runtime and no risk to the `bun run check` gate.

## Open questions / future directions

- **Steps without a captured `sessionId`.** Older autonomous steps (pre-full-capture) have no upstream UUID, so no transcript — the overview lists them with status/exit but no link. orch *does* keep its own per-step event stream at `logs/agents/<step>/events.ndjson` (a different RunnerEvents shape). Worth wiring in as a fallback so *every* agent step yields a narrative, even without an upstream session.
- **From gathering to insight.** Right now the scripts *assemble* the evidence; a human/agent does the analysis. Natural next step: a thin `analyze-workflow` layer (or skill) that runs over `analysis/` and emits the actual "errors found / improvements" report — closing the compound loop.
- **Cross-file continuation.** Claude sometimes splits one logical conversation across files (shared `slug`, compaction boundaries). `fetch-session` currently reads the single file named by the ID; following the `slug` chain would stitch resumed sessions into one transcript.
- **Promote to a CLI subcommand?** If this proves useful, `orch sessions <id>` / `orch analyze <runId>` could front these scripts — but only after the read-from-foreign-history concern is reconciled with the core's boundaries.

## Status

Both scripts are written and verified against real runs (a mixed Claude+Codex `tic-tac-toe` run, an autonomous `generate-changelog` run, and a `crashed` run for the empty/attention path). Typecheck clean under `strict` + `noUncheckedIndexedAccess`. They are not on the `bun run check` gate (no tests yet) — if they earn a permanent place, they should get unit coverage over the normalizers against captured fixture records.
