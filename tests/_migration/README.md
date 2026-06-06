# tests/_migration — migration artifacts

This directory contains the artifacts produced by the test-suite restructure
(`docs/plans/2026-06-05-001-refactor-testing-strategy-restructure-plan.md`).

## Directory contents

| Path | Purpose |
|---|---|
| `baseline.json` | Machine-readable snapshot of every test case at the start of the migration (D12 freeze) |
| `baseline.md` | Human-readable form of the same snapshot, with per-file case lists |
| `relocation-map.json` | Maps every old test path to its new location under `tests/` |
| `reconcile.ts` | Oracle: verifies that the current `tests/` tree covers all cases in `baseline.json` |
| `import-parity.ts` | Oracle: verifies that no test imports a dead module path |
| `overlap-report.ts` | Utility: detects duplicate test names across migration layers |
| `snapshot.ts` | Utility: generates a fresh baseline snapshot |
| `ledger.md` | Running ledger of coverage drops and deliberate exclusions |
| `closeout/` | Per-closeout-phase ledgers and relocation maps (C1–C6) |
| `__tests__/` | Unit tests for the oracle scripts themselves |

## Completeness proof — reproducibility notice

**The full dual-tree completeness proof cannot be reproduced from HEAD.**

During the migration, a set of `.skip`-annotated copies of old tests were kept in the new
`tests/` tree so that `reconcile` could compare old counts against new counts and prove
zero regression. Those archived `.skip` files were **intentionally deleted** as part of the
finalize step at commit `c99a364` — this was the designed conclusion of the strangler-fig
pattern, not an accidental loss.

**Key facts:**

- `c99a364` — final commit: deleted the `.skip` archive; no test coverage was lost at this
  point (reconcile exited 0 immediately before deletion)
- `0742468` — the last commit where the full dual-tree completeness proof reproduces; you can
  check out this commit and run `bun run reconcile` to see the proof in its entirety
- `baseline.json` — the frozen record of the pre-migration test count (425 files, 2517 cases);
  `bun run reconcile` still validates the current `tests/` tree against this frozen baseline

To verify that the current tree is complete against the frozen baseline:

```
bun run reconcile
```

To see the original dual-tree proof:

```
git checkout 0742468
bun run reconcile
```
