# fix-step-import-sort

## What I did

Fixed the single blocking biome `assist/source/organizeImports` regression at `src/core/step.ts:16`.
Reordered the named members so the type member sorts before the value member (case-insensitive):

Before:
```ts
import { SchemaValidationError, schema, type SchemaWrapper } from './schema.ts'
```
After (final content of line 16):
```ts
import { SchemaValidationError, type SchemaWrapper, schema } from './schema.ts'
```

## Key decisions

- Made the targeted one-line edit by hand rather than running any repo-wide `biome check --write .` or `bun run lint:fix`, to avoid reformatting unrelated files. Only line 16 changed; no other file, source, test, doc, or config was touched.

## What I verified

- `bun run lint` (`biome check .`) → checked 754 files, no fixes applied, **exit 0** (was exit 1 before, single error at src/core/step.ts:16).
- `bun run typecheck` (`tsc --noEmit`) → **exit 0** (type import still resolves correctly).

Did not run any tests beyond these two commands, per task scope. No git commands run — changes left in the working tree for the workflow to commit.

## Left for later / risk

- Nothing deferred within this task. This unblocks lint (stage 1 of `bun run check`); the downstream stages (typecheck/unit/mocked-integration/two-pane-lifecycle/migration) still need a consolidated pass from the top — that is the next task (full-gate-round6), not mine.
