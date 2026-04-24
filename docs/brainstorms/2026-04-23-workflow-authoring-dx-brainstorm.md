---
date: 2026-04-23
topic: workflow-authoring-dx
---

# Workflow Authoring DX — `orch init` and the `.orch/` Project Shape

## What We're Building

A first-class authoring experience for users writing workflow scripts. The bare problem: workflow files are TypeScript, so they need `node_modules`, `tsconfig.json`, and editor tooling to get imports, autocomplete, and lint. "Write it blind" is off the table.

The answer is an `orch init` subcommand that scaffolds an isolated, git-committable `.orch/` folder inside the user's existing repo — fully self-contained so it works whether the host project is Rails, iOS, Android, Python, or anything else.

```
my-app/
├── (user's existing iOS/Android/Python/etc. code — untouched)
└── .orch/
    ├── package.json       # orch + @biomejs/biome devDeps, pinned
    ├── tsconfig.json      # strict, bundler resolution
    ├── biome.json         # lint + format
    ├── orch.config.ts     # auto-discovers workflows/*
    ├── workflows/
    │   └── hello.ts       # working FakeRunner example
    ├── .gitignore         # node_modules, .runs/
    └── README.md
```

Install model: `bun add -g orch` once per machine installs the global `orch` binary. The binary walks up from cwd to locate `.orch/` and executes workflows against the version pinned in `.orch/package.json` — the prisma/vercel/next pattern.

## Why This Approach

Three strategic decisions drove the design:

1. **Isolated `.orch/` over root integration** — orch may live inside polyglot repos (iOS/Android/Python) that have no Node toolchain. A hidden, self-contained folder means we never touch or assume a root `package.json`, while still being committable for team reuse.

2. **Global bin + pinned devDep over bunx-only or global-only** — Users get a clean `orch run hello` invocation (not `bunx orch …`) while teams still get reproducible version pinning. Matches a pattern users already understand from prisma, next, vercel.

3. **Batteries-included over bare skeleton** — A working `hello.ts` using `FakeRunner` means first-run succeeds with zero API keys or CLIs installed. Biome is pre-wired so lint/format work immediately. README is short (20 lines). New users see it work in 60 seconds, then swap `FakeRunner` for `claude()` or `codex()`.

## Key Decisions

- **Location**: `.orch/` hidden folder at repo root. Isolated package.json — never modifies the host's package.json.
  - *Rationale*: supports polyglot repos; committable for team reuse; clear mental boundary (like `.github/` or `.claude/`).
- **Install shape**: global `orch` bin (one-time `bun add -g orch`) + `orch` listed as a devDep in `.orch/package.json` pinned per repo.
  - *Rationale*: clean CLI ergonomics + per-repo version reproducibility.
- **Scaffold contents**: package.json, tsconfig.json, biome.json, orch.config.ts, `workflows/hello.ts` (FakeRunner example), .gitignore, README.md.
  - *Rationale*: first-run works offline with no credentials; lint/autocomplete work out of the box.
- **Workflow registration**: `orch.config.ts` auto-discovers `workflows/*.ts` by default; explicit registration remains available as an escape hatch.
  - *Rationale*: less boilerplate per new workflow; aligns with the "just drop a file in" expectation.
- **Bootstrap**: `orch init` runs `bun install` inside `.orch/` after writing files, so the folder is ready to use immediately.

## Open Questions (for `/workflows:plan`)

- **Discovery algorithm**: how does the global `orch` binary locate `.orch/` when invoked from a subdirectory? (Walk up from cwd? `ORCH_PROJECT` env var? explicit `--project` flag as escape hatch?)
- **Local-version execution**: does the global bin `import()` the local `orch` from `.orch/node_modules`, or re-exec `bun` with cwd=`.orch/`? Trade-offs around version compat and startup cost.
- **Bun prerequisite**: what happens if a user runs `orch init` without Bun installed? (Detect and print install hint? Offer to install? Just error?)
- **Auto-discovery shape**: pattern for `workflows/*.ts`? Does `orch.config.ts` gain a `discover: 'workflows/*.ts'` option on `defineConfig`? What about subfolders (`workflows/foo/index.ts`)?
- **`orch add <name>`**: scaffolder for stamping out a new workflow file with the right imports. Useful but deferrable — `cp workflows/hello.ts workflows/new.ts` works today.
- **Upgrading**: story for bumping orch version inside `.orch/` (`cd .orch && bun update orch` vs. an `orch upgrade` helper).
- **Exact starter `hello.ts` content**: what does the minimal-but-teachable example look like? (One step? Validators shown? Comments inline?)
- **Lint opinionation**: biome confirmed, but do teams that prefer eslint get an escape hatch (`orch init --lint eslint`)? Defer until asked.

## Next Steps

→ Run `/workflows:plan` to turn these decisions into an implementation plan. Likely slots as a new phase in `docs/plans/implementation-phases.md` (nothing in current phases covers authoring DX / init).

---

## Appendix A — Sketch of the Getting Started story

> These flows are **aspirational**. They describe what `orch init` would feel like once the decisions above are implemented. Use them as a gut-check: if any step feels wrong or missing, the brainstorm has a gap.

### A.1 For a new user (never heard of this tool)

Assume: an existing app in `~/code/my-app` (could be Rails, iOS, Python — orch doesn't care). Machine has no Node/Bun yet.

```bash
# 1. One-time: install Bun (prerequisite) and the global orch bin.
curl -fsSL https://bun.sh/install | bash
bun add -g orch

# 2. Drop into your project and scaffold .orch/.
cd ~/code/my-app
orch init
#   writes .orch/{package.json,tsconfig.json,biome.json,orch.config.ts,workflows/hello.ts,.gitignore,README.md}
#   runs `bun install` inside .orch/
#   prints: "Try: orch run hello"

# 3. First run — works offline, no API keys, uses FakeRunner.
orch run hello
#   green checkmark, ~2 seconds. You now know the plumbing works.

# 4. Open .orch/workflows/hello.ts in your editor.
#    Autocomplete and lint work immediately because .orch/ is a real TS project.

# 5. Swap FakeRunner for a real one when you're ready.
#    Edit hello.ts: `agent: fake()` → `agent: claude()` (or `codex()`).
#    Make sure `claude` / `codex` are on your PATH and logged in.
orch run hello

# 6. Commit .orch/ so your team inherits the same pinned version and workflows.
git add .orch
git commit -m "chore: add orch workflows"
```

**What a new user should internalize in the first 5 minutes**

- `.orch/` is a real, self-contained TS project — not a config folder. That's why editor tooling just works.
- `orch run <name>` resolves `<name>` to `.orch/workflows/<name>.ts` via auto-discovery. No registration step.
- The global `orch` bin is a thin shim: it walks up from cwd to find `.orch/` and delegates to the pinned local version. Upgrading is per-repo (`cd .orch && bun update orch`), not global.
- `FakeRunner` exists specifically so the first run never fails for credential reasons. Treat it as a smoke test, then replace it.

### A.2 What `orch init` actually writes

Seven files. Roughly 60 lines of content total — the scaffold is deliberately small so the user can read every file in one sitting.

```
.orch/
├── package.json         # ~15 lines — pinned devDeps, lint/format scripts
├── tsconfig.json        # ~15 lines — strict + bundler resolution
├── biome.json           #  ~5 lines — formatter + recommended rules
├── orch.config.ts       #  ~5 lines — discover: 'workflows/*.ts'
├── workflows/
│   └── hello.ts         # ~10 lines — one step, FakeRunner, no creds
├── .gitignore           #  2 lines — node_modules/, .runs/
└── README.md            # ~20 lines — cheat sheet + upgrade path
```

Sketch of each file (exact contents TBD in the plan — shown here to make the decisions concrete):

**`.orch/package.json`** — isolated from the host project's `package.json` (decision #1). `orch` is pinned so the team gets reproducible runs; the global bin delegates here.

```json
{
  "name": "my-app-orch",
  "private": true,
  "type": "module",
  "dependencies": { "orch": "^0.1.0" },
  "devDependencies": {
    "@biomejs/biome": "^2.4.10",
    "@types/bun": "latest"
  },
  "scripts": {
    "lint": "biome check .",
    "format": "biome format --write ."
  }
}
```

**`.orch/tsconfig.json`** — mirrors the root repo's strictness (CLAUDE.md rule 6) so workflow authors get the same editor experience as the orch maintainers.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "types": ["bun-types"]
  },
  "include": ["workflows/**/*", "orch.config.ts"]
}
```

**`.orch/biome.json`** — tiny on purpose. Teams that want eslint are served by the deferred `orch init --lint eslint` escape hatch in the open questions.

```json
{
  "$schema": "https://biomejs.dev/schemas/2.4.10/schema.json",
  "formatter": { "indentStyle": "space", "indentWidth": 2 },
  "linter": { "rules": { "recommended": true } }
}
```

**`.orch/orch.config.ts`** — auto-discovery is the default (decision #4). Explicit registration remains available but isn't in the scaffold.

```ts
import { defineConfig } from 'orch'

export default defineConfig({
  discover: 'workflows/*.ts',
})
```

**`.orch/workflows/hello.ts`** — the minimal teachable example. One step, `FakeRunner`, no schema, no validators. Shows `step.define` + `workflow` + `run` — enough to plant the mental model without drowning the reader on first open.

```ts
import { workflow, step, fake } from 'orch'

const GREET = step.define('greet', {
  agent: fake({ reply: 'hello from orch' }),
})

export default workflow('hello', async (run) => {
  await run(GREET)
})
```

**`.orch/.gitignore`** — `.runs/` holds per-run state, transcripts, and the journaled plan. It's local-machine noise; committing it would be the equivalent of committing `.next/` or `tmp/`.

```
node_modules/
.runs/
```

**`.orch/README.md`** — ~20 lines, as promised in the brainstorm. Pointer document, not a manual. The real tutorial lives in `docs/getting-started.md` upstream.

```markdown
# .orch — workflows for this repo

Run workflows with `orch run <name>` from anywhere in the repo.

- `workflows/` — one TS file per workflow, auto-discovered.
- `orch.config.ts` — discovery pattern and defaults.
- `.runs/` — (gitignored) run state, transcripts, logs.

## Common commands

    orch run hello              # start a fresh run
    orch runs                   # list past runs
    orch resume <run-id>        # pick up after a crash
    orch status <run-id>        # inspect a run's state tree

## Upgrading orch

    cd .orch && bun update orch

Commit this folder. Teammates inherit the pinned version and all workflows.
```

**After file writes**, `orch init` runs `bun install` inside `.orch/` so step 3 of the new-user flow ("first run succeeds offline") works without a second manual command. The `node_modules/` directory that appears is already gitignored.

### A.3 For a maintainer testing against local `src/`

Assume: working copy of this repo at `~/code/orch`. You've just edited something in `src/` and want to see a real workflow exercise it end-to-end — *not* the published npm version.

```bash
# 1. Inside the repo: install, typecheck, unit tests must be green first.
cd ~/code/orch
bun install
bun run check

# 2. Make your local build discoverable as a global bin.
bun link                     # registers this package's `bin` globally
# `orch` on your PATH now points at ~/code/orch/src/cli/main.ts

# 3. Create (or reuse) a scratch target repo for authoring experiments.
mkdir -p /tmp/orch-scratch && cd /tmp/orch-scratch
git init

# 4. Scaffold, but point the scaffold at your local checkout instead of npm.
orch init --link ~/code/orch
#   equivalent of: scaffold .orch/ as normal, then `bun link orch` inside .orch/
#   so .orch/node_modules/orch is a symlink to ~/code/orch.
#   Now every `orch run …` from here executes your unreleased src/.

# 5. Iterate: edit src/ in the repo, re-run workflow in the scratch repo.
#    No rebuild step — Bun executes TS directly.
cd /tmp/orch-scratch
orch run hello

# 6. When satisfied, run the full test gate before pushing.
cd ~/code/orch
bun run check                # lint + typecheck + unit + mocked integration
RUN_REAL_E2E=1 bun run test:e2e    # only if you touched a runner or spawn path
```

**What a maintainer should internalize**

- `bun link` + `orch init --link <path>` is the only supported way to dogfood unreleased changes. Don't copy the global install over the local checkout — you lose the ability to edit.
- The scratch `.orch/` is disposable. Nuke `/tmp/orch-scratch/.orch` whenever the scaffold itself changes shape.
- `bun run check` is the gate (see CLAUDE.md rule 10). If it's red, don't bother running workflows — the bug is upstream of the DX surface.
- Real-CLI e2e tests are env-gated (`RUN_REAL_E2E=1`). Run them before shipping anything that touches `src/hosts/` or `src/runners/`.

### A.4 Key decisions this walkthrough surfaces

Four decisions from the brainstorm become concrete when you read the flows above:

1. **Install shape is a two-step ritual for new users, not one.** `bun add -g orch` *then* `orch init`. The alternative (single `npx orch init`) was rejected because it breaks the "clean `orch run` invocation" promise. If the two-step friction is unacceptable, reopen this decision.
2. **Bun is a hard prerequisite, not bundled.** Step 1 for a new user is installing Bun. The brainstorm leaves "what does `orch init` do without Bun?" as an open question — the answer shapes whether Bun-install is a pre-flight check, a suggestion, or a hard stop.
3. **`FakeRunner` in the scaffold is load-bearing.** Without it, step 3 ("first run succeeds offline") fails and the 60-second-to-success promise collapses. This elevates FakeRunner from a test utility to a user-facing primitive — it must be exported from the public barrel.
4. **Maintainer dogfooding needs `orch init --link <path>`.** Not in the brainstorm's decisions list yet, but falls out of A.2. Without it, maintainers either (a) test against stale published versions, or (b) hand-edit `.orch/package.json` after each scaffold. Worth adding to the open questions.
