# Backlog — Round 2 plan implementation

Master map for the multi-round build that implements every TODO plan indexed in `plans/README.md` (Round 2, plans 007–026), on branch `feat/round-2-improvement-plans` (off `develop`).
Source: `/tmp/orch-round2-handoff.md` (waves 1–2 done, waves 3–5 remain).

Per-plan gate: `bun run check` (lint + typecheck + unit + mocked-integration + two-pane lifecycle) must be green.
One commit per plan, conventional-commit style, no co-author line, Claude-Session trailer; update the plan's `plans/README.md` status row in a separate `docs(plans)` commit.
Never run bare `bun test` — always path-scoped. Never touch `plans/README.md` from an implementer agent (operator-only).

## Working procedure (do not drop)

- [ ] Group waves by disjoint file footprints; keep the known chain orders.
      Acceptance: `workflow.ts` chain 009→010→011→020→008; runner-file chain 022→014/021→015; CLI chain 007→017→012/018→008 respected when scheduling.
- [ ] Each implementer agent gets: plan file path, footprint allowlist, repo CLAUDE.md rules, path-scoped test rules (no bare `bun test`, no `bun run check`, no repo-wide biome writes, no commits, never edit `plans/README.md`).
      Acceptance: agent brief contains all six constraints before dispatch.
- [ ] After each wave the operator runs `bun run check` serially on a quiet machine, spawns two review agents on the wave diff, applies confirmed findings, commits per plan, updates README rows.
      Acceptance: gate green + review pass recorded before the wave is called done.

## Review debt (do first)

- [ ] Run the skipped Wave-2 code-review pass.
      Acceptance: `ce-correctness-reviewer` + `ce-kieran-typescript-reviewer` run over `git diff 0b1a37d..d521685`; confirmed findings applied as fixup commits; verdict recorded.
- [ ] Give plan 013's commit (`c38c1e4`) extra reviewer scrutiny — no implementer report exists for it.
      Acceptance: diff reviewed against `plans/013-drain-stderr-before-tail-on-abort.md`; any findings applied or explicitly cleared.

## Wave 3 — code-quality + DevEx (plans 011, 012, 015, 016, 018)

- [ ] 011 — Serialize `initRun`/`setArgs`/`setStatus` through the write-queue.
      Acceptance: all three state-store writers go through the queue; no concurrent-write race; scoped state-store tests + gate green. (Chains after 010 on `workflow.ts`/state seam.)
- [ ] 012 — Add exit-code regression tests for `mapResumeError`.
      Acceptance: new tests pin each `mapResumeError` exit-code branch; scoped runner tests green.
- [ ] 015 — Extract the shared runner flag-denylist guard.
      Acceptance: denylist guard lives in one shared helper used by both runners; behavior unchanged; scoped runner tests green. (Chains after 014/021 on runner files.)
- [ ] 016 — Add regression tests for Codex `auth`/`billing` classification.
      Acceptance: tests assert `auth` and `billing` failures classify correctly; follow the 009/010 drift check on the `classify-error` seam.
- [ ] 018 — Accept a runId prefix in `orch logs`.
      Acceptance: `orch logs <prefix>` resolves a unique run; ambiguous/absent prefix errors clearly; scoped CLI tests green.

## Wave 4 — DevEx (plans 020, 023, 024)

- [ ] 020 — Throw on a duplicate step name in the same scope.
      Acceptance: duplicate step name in one scope raises a clear authoring error; scoped workflow tests green. (Chains on `workflow.ts` after 011.)
- [ ] 023 — Accept a bare Zod schema in `returns:`.
      Acceptance: `returns:` accepts a bare Zod schema (not only the wrapped form); type-level + runtime tests green; public API doc updated.
- [ ] 024 — Make `orch init` scaffold a typed two-step handoff.
      Acceptance: `orch init` output is a typed two-step handoff workflow that typechecks and runs; scaffold/CLI tests green.

## Wave 5 — last (plan 008)

- [ ] 008 — Make `orch status` show per-step outcome and the failure reason.
      Acceptance: `orch status` prints per-step outcome + failure reason; benefits from 007's failing-step read; touches `workflow.ts`, `state-store.ts`, `logs.ts`, `status.ts` — run deliberately last to avoid churn; gate green.

## Follow-ups & closeout

- [ ] 021 optional: migrate `examples/*/index.ts` from raw `--permission-mode` flags to `permissions: 'bypass'`.
      Acceptance: no example uses raw `--permission-mode`; examples typecheck.
- [ ] Docs sweep after any wave that changes public behavior (use `orch-docs-updater`); reconcile `docs/public/reference/api.md` + `runners.md` after barrel changes.
      Acceptance: `bun run docs:build` green; reference signatures match `src/`.
- [ ] Final full review + PR back to `develop` once all plans are DONE.
      Acceptance: all Round-2 rows DONE in `plans/README.md`; full review clean; PR opened against `develop`.

## Done (Round 2, for orientation — do not redo)

Wave 1 (committed, reviewed, SHIP): 007, 009, 019, 022, 025 + pre-existing-failure fix.
Wave 2 (committed, gate green, review pending above): 010, 013, 014, 017, 021.
026 was already DONE before Round 2 started. Round 1 (001–006) fully DONE.

## Known gotchas (verified)

- `bun run check` includes real-tmux integration tests that flake (~5s timeouts) on a loaded machine; rerun `tests/integration/services/tmux/tmux-real.integration.test.ts` alone before assuming a regression.
- Background subagents may go idle without delivering a final report; ping via SendMessage, else recover the last long text block from `~/.claude/projects/-Users-martinsumera-projects-futured-claude-orchestration/<session-uuid>.jsonl`.
- `ce-*-reviewer` agents may lack SendMessage and print the report as final text; one wrote findings to `.orch/reviews/`.
- A PostToolUse formatter hook rewrites files after edits; re-Read before a second Edit on the same region.
- User rules: no em dash (plain dash), one sentence per line in Markdown, never bare `bun test`, fix any flaky/failing test you meet.
- 5 known pre-existing ENOENT failures under gitignored `.orch/` fixtures on some machines are not a regression.
