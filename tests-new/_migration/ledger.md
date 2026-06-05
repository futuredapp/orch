# Migration ledger — old → new accounting (D15)

> **Per-CASE accounting.** A file is wrapped `.skip` only once **every** child
> `it()`/`test()`/`it.each` row is mapped here to a disposition. Every row is
> keyed to the **frozen** baseline (`baseline.json`, D12). `oldTestRefs` on the
> new scenario must back-reference the old case so the U14 reconciliation closes
> the loop.
>
> **Dispositions:** `port` (re-derived 1:1-ish), `merge` (folded into another
> scenario), `demote` (moved to a cheaper category — e.g. full-host → screen),
> `drop` (deleted with reason — a vacuous/unprovable assertion), `new` (born in
> `tests-new/` with **no** baseline twin — tagged so reconciliation does not flag
> it as an unaccounted relocation; parent §U3 during-migration routing rule).
>
> **Status (parent U3).** This is the **template + first illustrative rows** only.
> U3 marks **no** old test `.skip` and adds no real migration rows — the bulk
> migration (U4–U9) fills this in. The overlap report is **non-blocking** in U3;
> U4 flips it to blocking once the first real rows land.

| Old file | Old scenario | New scenario (path) | Disposition | Reason |
|---|---|---|---|---|
| tests/integration/hosts/two-pane/tier-1/follow-live-returns-to-running-step.real.integration.test.ts | press F swaps back to live | model/follow-live--returns-to-running-step.test.ts + full-host/fake-agent/follow-live--keypress-during-stream.test.ts | port | _(illustrative — landed by U4; the live-driven submode unblocks the deferred placeholder)_ |
| tests/unit/hosts/two-pane/steps-view/view-mode-footer.test.tsx | footer reflects mode | screen/follow-live--footer-renders-with-quit-hint.test.ts | demote→screen | _(illustrative — rendering byte risk, not full-host plumbing)_ |
| — | — | full-host/recorded-agent/claude-plan-then-work.test.ts | new | born in tests-new/ (parent U3 tracer); no old twin — realistic-event replay had no equivalent under the old harness |
| — | — | full-host/real-agent/autonomous-multi-step.test.ts | new | parent U3 real-CLI smoke; re-derives the spirit of tests/e2e/tier-4 as a two-pane pane-integration assertion, not a runner-isolation test |
