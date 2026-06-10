---
date: 2026-06-06
topic: orch-public-release
relates-to: docs/brainstorms/2026-06-06-public-release-requirements.md
status: resolved-green
---

# Spike: does `bun build --compile` preserve runtime dynamic import of external `.ts`?

## Why this spike exists

The public-release brainstorm gates **all** binary-packaging work (R5–R10) on one
assumption:

> `bun build --compile` supports dynamic `import()` of external TypeScript files
> from the filesystem at runtime via the embedded Bun runtime. This must be
> verified via a runnable test script confirming the behavior before R5–R10 are
> implemented; the spike is the prerequisite gate for all binary packaging work.

orch has two runtime dynamic-import seams that a standalone binary must keep working:

- `src/config/index.ts:156` — `await import(configPath)` loads the user's `orch.config.ts`
- `src/cli/commands/load-workflow.ts:63` — `await import(workflowPath)` loads the workflow `.ts`

And every scaffolded user file imports from the **bare `'orch'` specifier**
(`init-templates.ts`): `orch.config.ts`, `.orch/steps.ts`, and `.orch/workflows/*.ts`.

## Verdict: GREEN — with two required build changes

A compiled binary with **no Bun and no `node_modules` on `PATH`** successfully
scaffolds (`orch init`), dynamically imports the user's `orch.config.ts` →
workflow → `../steps.ts` chain, resolves their bare `'orch'` imports, and runs
the workflow to completion. Reproduce end-to-end:

```bash
bash scripts/spike/run-spike.sh          # exits 0, prints "SPIKE GATE: GREEN"
RUN_SPIKE=1 bun test tests/e2e/compile-binary-dynamic-import.spike.test.ts
```

The gate only holds because the spike surfaced — and fixed — two real packaging
problems that a naive `bun build --compile src/cli/main.ts` hits.

### Snag 1 — the bare `'orch'` specifier has nothing to resolve against

`bun build --compile` bundles the entry's static imports, so the binary's own
code is self-contained. But a user workflow is imported **at runtime from the
user's disk**, and it does `import { workflow } from 'orch'`. A brew-installed
binary has no `node_modules/orch`, so resolution fails:

```
IMPORT_FAILED: Cannot find package 'orch' from '.../workflow.ts'
```

**Fix:** register a runtime module resolver before any command runs, mapping
`'orch'` to the public API embedded in the binary. Implemented as a dedicated
compiled-entry shim, `src/cli/bin.ts`:

```ts
import * as orchApi from '../index.ts'
Bun.plugin({
  name: 'orch-bare-resolver',
  setup(build) {
    build.module('orch', () => ({ exports: orchApi, loader: 'object' }))
  },
})
```

`main.ts` gained `export` on `main()` so the shim can call it; the existing
`if (import.meta.main) main()` guard is untouched, so `bunx orch` / `bun link`
are unaffected. `bin.ts` is the entrypoint **only** for the compiled binary.

### Snag 2 — ink pulls in `react-devtools-core`, which `--compile` can't bundle

`ink/build/reconciler.js` dynamically `import('./devtools.js')` behind
`process.env.DEV === 'true'`, and `devtools.js` statically imports the optional,
uninstalled `react-devtools-core`. Bun's bundler eagerly resolves dynamic-import
targets, so the compile fails regardless of the dead `DEV` branch:

```
error: Could not resolve: "react-devtools-core". Maybe you need to "bun install"?
```

`--external react-devtools-core` is the wrong fix — it just defers the same
failure to runtime. `--define process.env.DEV='"false"'` does not help (the
bundler still walks the dynamic-import target).

**Fix:** a build-time plugin stubs `react-devtools-core` to an empty module.
Because plugins can only be passed via the `Bun.build` JS API (not the
`bun build --compile` CLI), the build lives in `scripts/build-binary.ts`.

## Artifacts produced by this spike

| File | Role |
| --- | --- |
| `scripts/build-binary.ts` | `Bun.build` compile with the devtools stub; `--target`/`--outfile` flags for the per-platform CI matrix (R5) |
| `src/cli/bin.ts` | compiled-binary entrypoint; registers the bare-`'orch'` runtime resolver |
| `src/cli/main.ts` | `main()` now `export`ed (one word; no behavior change) |
| `scripts/spike/run-spike.sh` | end-to-end gate: compile → init → run with no Bun on PATH → assert |
| `tests/e2e/compile-binary-dynamic-import.spike.test.ts` | `RUN_SPIKE=1`-gated repeat of the gate; auto-skips off `bun run check` |

## Notes for the planning phase

- **Binary size:** ~59 MB on macOS arm64 (embedded Bun runtime + ink/react).
  Fine for a brew download; worth noting for release-asset expectations (R6).
- **Cross-platform matrix (open question in the brainstorm):** `scripts/build-binary.ts`
  already takes `--target`, so a GitHub Actions matrix calling it with
  `bun-darwin-arm64` / `bun-darwin-x64` / `bun-linux-x64` is the likely path —
  no GoReleaser equivalent needed. Cross-target compiles were not executed on
  this host; verify each target actually runs on its native OS in CI.
- The runtime resolver embeds orch's **public** API only. A workflow that
  deep-imports a non-public module (e.g. the dev-only `scriptedFake` runner, as
  some `examples/` do) will not resolve from a shipped binary — acceptable, and
  consistent with those examples being marked DEV-ONLY / never-ship.
