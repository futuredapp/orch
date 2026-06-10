# Forward-scaffolding exported through the public barrel with no consumer

**Source:** CE L7 (LOW). Verified against the code.
**Status:** Not a fix in this pass — intentional scaffolding per the module's own design note.

## What the issue is

`resolveInstruction`, `ConfiguredInstructions`, and `InstructionKind` (in `src/core/recovery/instructions.ts`)
are re-exported via `recovery/index.ts` and `src/core/index.ts`, but have **no** non-test consumer in `src/`
— only `defaultInstructionResolver` and the `InstructionResolver` type are actually used today. The module
comment says this is intentional scaffolding for the sibling in-TUI failure-resume feature.

## Where it is

- `src/core/recovery/instructions.ts` → re-exported through `src/core/recovery/index.ts` and
  `src/core/index.ts`.

## Why it matters

Exporting unused symbols through the **public** barrel grows the API surface ahead of need. It is not
accidental dead code (the design note is explicit), but until the sibling feature lands, these symbols are
public commitments with no caller — which can mislead a maintainer into thinking they are load-bearing.

## Why it is recorded here, not fixed

The scaffolding is deliberate and tied to the shared instruction seam (D7 / KTD-4). Trimming the barrel now
is low-value and would likely be reverted when the sibling lands. This is a judgment call for the feature
owner, not a defect.

## Suggested next step

Optional: keep `instructions.ts` as the seam but hold the currently-unused symbols
(`resolveInstruction`, `ConfiguredInstructions`, `InstructionKind`) in the `recovery` barrel only, not the
top-level `src/core/index.ts`, until the sibling feature consumes them — then promote them to the public
barrel with their first real consumer. See also
[`manual-retry-instruction-not-delivered.md`](manual-retry-instruction-not-delivered.md), which is the
feature that will exercise this seam.
