---
date: 2026-06-12
status: research
topic: Feature comparison of mattpocock/sandcastle vs orch — borrowable ideas
audited: 2026-06-12 — sandcastle claims verified against a shallow clone of mattpocock/sandcastle @ v0.7.0 (analyzed via 5 parallel subagents over src/, docs/adr/, CONTEXT.md, README.md, ideas/, research/, .sandcastle/). orch claims verified against the current working tree. Where sandcastle's published docs drift from its code (e.g. a `config.json` documented but not read anywhere in src/), the code is treated as ground truth and the drift is noted inline.
---

# Sandcastle → orch: feature comparison & borrowable ideas

## TL;DR

[`mattpocock/sandcastle`](https://github.com/mattpocock/sandcastle) (`@ai-hero/sandcastle` v0.7.0) is an Effect-TS CLI/library that runs AI coding agents **inside isolated sandboxes** (Docker / Podman / Vercel / Daytona / no-sandbox) and merges the agent's commits back to your repo via a configurable **branch strategy**. It is provider-agnostic on two axes — 6 agents × 5 sandboxes.

orch and sandcastle are **adjacent but differently-centered**. orch's center of gravity is *chaining and observability* (a typed workflow DSL, memoized resume, two-pane tmux TUI). Sandcastle's is *isolation* (run agents anywhere, behind a ~5-method provider seam). They are strong in complementary places, so almost everything worth borrowing is **additive** — it does not collide with orch's architecture.

The headline gap: **orch runs agents directly on the host; sandcastle's whole thesis is that they shouldn't.** That is the single biggest borrowable concept, and it slots cleanly *below* orch's `ProcessService` seam.

## The two projects side by side

| | **orch** (this repo) | **sandcastle** |
|---|---|---|
| Center of gravity | Chaining & observability | Isolation |
| Where agents run | Directly on the host | In a sandbox; commits merged back via a branch strategy |
| Orchestration model | First-class DSL (`step`, `run`, `parallel`, `commit`, `createWorktree`, `ask`, `command`) | Plain TS — `run()` in `for`-loops / `Promise.all`; **no DSL** |
| Runners / agents | Claude, Codex (+ `Runner` adapter interface) | 6 agents: Claude, Codex, Pi, Cursor, OpenCode, Copilot |
| Resume | Name-keyed **memoization** of whole workflows | Per-agent **session JSONL transfer** (single iteration) + **fork** |
| Structured output | Zod via `schema()` / `returns:` | Standard Schema (Zod/Valibot/ArkType) via XML tag in stdout |
| Config | Real `defineConfig` + typed prompt-var codegen | No config file (only `run()` argument objects; a config file is an `ideas/` sketch) |
| Internals | Hand-rolled service ports, Bun | Effect-TS (`Context.Tag` + `Layer` + `Data.TaggedError`), tsup, Node |
| Observability | Two-pane tmux TUI + structured `.orch/state/<runId>/logs/` | File-log mode (`tail -f`) or Clack terminal UI |

**Reading of the relationship:** sandcastle is strong exactly where orch is empty (isolation, multi-agent breadth, session fork) and weak exactly where orch is strong (no DSL, thin TUI, no typed config). Borrow across the gap, not into the overlap.

---

## Tier 1 — High value, strong fit

### 1. Sandbox isolation as a pluggable axis ⭐ (the marquee borrow)

Today orch runs agents directly on the host — fine for supervised runs, risky for AFK / parallel work. Sandcastle's entire reason for existing is a `SandboxProvider` seam with ~5 methods (`exec` with **line-by-line streaming via `onLine`**, `copyIn` / `copyFileOut`, `close`) and three kinds:

- **bind-mount** (Docker / Podman) — host worktree mounted into the container; shared filesystem, no sync.
- **isolated** (Vercel microVM / Daytona cloud) — own filesystem; code synced in via `git bundle`, out via patches.
- **no-sandbox** — agent runs on the host (what orch does today).

**Why it fits orch:** it slots *below* `ProcessService` — a sandbox is just "where the subprocess runs." orch already has the runner-adapter discipline; a `SandboxProvider` is the same pattern on a different axis, and `no-sandbox` is the zero-risk default that keeps every existing workflow working.

**Borrow the hard-won details, not just the idea** (these are the parts that take months to rediscover):
- **UID alignment without runtime `chown`** — Podman `--userns=keep-id:uid=N,gid=N`; Docker build-arg `AGENT_UID`/`AGENT_GID` + a pre-flight `docker image inspect` that names both remedies on mismatch. (sandcastle ADR-0005, ADR-0014.)
- **Two-phase, artifact-preserving `syncOut`** for isolated providers — eagerly save patches to `.sandcastle/patches/<ts>/` *before* applying; on apply failure, keep them and print copy-pastable recovery commands. Agent work is never lost.
- **Sandbox-owned sync base** — store the last-synced commit in `refs/sandcastle/sync-base` *inside the sandbox's git repo*, because `git am` rewrites SHAs on the host so host HEAD is an invalid base on the 2nd sync. (ADR-0017.)
- **Git-worktree-aware mounts incl. Windows overlay patching** — a `.git` *file* worktree needs both the file and the parent repo's `.git` dir mounted; Windows needs an overlay at a deterministic POSIX path. (ADR-0006.)
- **Single-listener shutdown registry + file-based worktree locks** — install exactly one `SIGINT/SIGTERM/exit` handler no matter how many sandboxes are live (avoids Node's MaxListeners warning past ~10), and `O_EXCL` PID-liveness locks at `.sandcastle/locks/<name>.lock` to fail-fast on worktree contention. (ADR-0007.)

**Effort:** Large — this is a roadmap phase, not an afternoon. But it is the biggest capability gap.

**Tension to resolve:** orch's observability is tmux-on-the-host. An isolated (cloud) sandbox has no local PTY to attach the right pane to — the two-pane TUI assumes the agent process is local. Bind-mount (Docker/Podman) is the natural first target because the agent's stdout still streams to the host; isolated providers would need the right pane fed from a streamed log rather than a live PTY. Worth a dedicated brainstorm before committing.

### 2. Branch strategy as a first-class concept

Sandcastle picks `head` / `merge-to-head` / `branch` at provider construction:
- `head` — agent writes directly to the host working dir, no worktree.
- `merge-to-head` — throwaway timestamped branch in a worktree, merged back to HEAD when done; HEAD is untouched on failure. "Safe default for automation."
- `branch` — commits land on an explicit named branch (for PRs); **safe worktree reuse** — clean + strictly-behind → `git fetch` + ff-only; dirty/diverged → reuse as-is with a warning, never clobber unpushed work. (ADR-0003.)

**Why it fits:** orch already has `createWorktree()` and `commit()`. A `branchStrategy` makes explicit *what happens to the agent's commits* — currently implicit. The safe-reuse + ff-only-when-provably-safe logic is the borrowable substance.

**Effort:** Medium.

### 3. Session fork for fan-out

`result.fork(prompt)` — one parent agent primes context, then N children fork its session JSONL onto **distinct branches** and diverge: `Promise.all([r.fork(a), r.fork(b)])`. The parent JSONL is left byte-for-byte intact. (ADR-0018.)

**Why it fits:** orch has `parallel()` but no session-fork primitive. This is the natural "explore once, then fan out" pattern the DSL could expose as e.g. `run.fork(STEP)`. **Copy the caveat too:** fork isolates the *session only*, not the branch/worktree — git-safe **only** with a distinct branch per child. Encode that in the API shape rather than docs.

**Effort:** Medium (depends on how orch's runners expose `--fork-session` / `codex exec fork`).

### 4. Hanging-process completion timeout (ADR-0019)

When an agent emits its done-signal but the process won't exit (a spawned child like `gh` or an MCP server holds stdout open so EOF never arrives), sandcastle swaps the long idle timeout for a short (60s) **completion grace timer** that *succeeds* with buffered output instead of failing and discarding committed work. The window resets on each trailing line so late data (final `result`, usage, structured-output tags) is still captured.

**Why it fits:** this is a real reliability bug class orch's runners will hit. orch's `interactive auto-stop` is adjacent but solves a different phase (interactive, not autonomous-with-completion-signal). Low effort, high payoff.

### 5. `!`command`` prompt expansion

Prompt templates can embed `` !`gh issue view 42` `` which executes and inlines stdout *before* the agent runs; all expressions run in parallel, each timeout-guarded, fail-fast (no retry — ADR-0020).

**Security model worth copying verbatim:** a `\x01` marker is inserted between `!` and the backtick of shell blocks present in the *raw template*, and stripped from incoming `promptArgs` — so a `` !`cmd` `` arriving via *substituted argument data* is treated as literal text and never executed. They fixed an RCE-class bug here; inherit the fix.

**Why it fits:** complements orch's typed prompt-file codegen. orch has typed *inputs*; this adds *dynamic* inputs. Note orch would run expansion on the host (or, post-#1, inside the sandbox like sandcastle does).

**Effort:** Medium.

---

## Tier 2 — Good fit, smaller scope

| Feature | What it is | Fit note for orch |
|---|---|---|
| **Host-vs-sandbox lifecycle hooks** | `hooks.{host,sandbox}.onSandboxReady: [{command}]` run before the agent (e.g. `npm install`) | orch has `command()` steps; a declarative pre-run hook is a lighter ergonomic for setup. |
| **Reusable sandbox** (`createSandbox` → N `run()`s) | Container made once; commits accumulate on one branch — powers implement-then-review on the same workspace | Maps to "a session/workspace that survives multiple steps" — useful for review loops. |
| **More agent adapters** (Pi, Cursor, OpenCode, Copilot) | 4 more runners behind the same interface | orch's `runner-author` skill makes these cheap; breadth is a selling point. Mind the resume gates (Cursor/OpenCode are non-resumable by design — ADR-0016). |
| **Standard Schema for structured output** | `Output.object({tag, schema})` accepts Zod/Valibot/ArkType, not Zod-locked | orch is Zod-only; Standard Schema is a ~1-line generalization. The stronger borrow is the **resume-to-correct error loop** — `StructuredOutputError` carries `sessionId` so a failed parse resumes the same session with feedback instead of redoing the work. |
| **`copyToWorktree`** (copy-on-write) | Clone host files (`.env`, `node_modules`, caches) into the worktree via APFS clonefile / `--reflink=auto` | Speeds up the worktree-based runs orch already supports. |
| **Subpath exports + optional peerDeps** | `@ai-hero/sandcastle/sandboxes/docker`; heavy SDKs (`@vercel/sandbox`, `@daytona/sdk`) are optional peer deps | Directly applies to orch's per-runner adapters — a Claude-only user shouldn't pull Codex's deps. |

---

## Tier 3 — Engineering / process practices (cheap, high leverage)

Sandcastle is unusually disciplined. Several practices are nearly free to adopt and compound over time. (Note: sandcastle is the *upstream* of conventions orch already uses — `grill-with-docs`, `CONTEXT.md`, triage labels, `docs/agents/` — so this is partly "adopt the rest of a system you've already bought into.")

1. **`CONTEXT.md` glossary with explicit `_Avoid_:` rejected-synonym lists per term.** Kills terminology drift at the source (their "iteration ≠ run" distinction; "completion signal" orthogonal to "structured output"). orch has CLAUDE.md rules but no anti-synonym glossary, and its two-pane / runner / host vocabulary would benefit.
2. **`.out-of-scope/` register** — short docs for rejected features, each tied to an issue #, distinguishing *principled refusal* (provider-retry, base-image abstraction) from *cost-deferral* (multi-repo). Prevents re-litigating scope. orch has `brainstorms/` and `plans/` but no rejected-scope register.
3. **ADRs that lead with rejected alternatives**, plus a small set of cross-cutting principles threaded through them: *fail-fast over retry/degrade*, *build-time over runtime config*, *push variability behind the provider (keep the core additive)*, *encode constraints in the API shape, not validation*, *behavior follows the source/identity of an input, not adjacent flags*.
4. **"Retry belongs in the orchestration layer, never in primitives" (ADR-0020).** Sandcastle fails fast in `run()` and dogfoods a `run-with-retry` wrapper in its own CI. A clean boundary for orch's core/runner split (orch currently has recovery/backoff — worth deciding which layer owns it).
5. **Public-API purity CI gate** — `scripts/check-public-types-effect-free.mjs` asserts internal (Effect) types don't leak the published barrel. Generalizes directly to orch's "single public barrel per module" rule as an enforceable check.
6. **Label-driven issue→PR CI state machine** with explicit *refusal* preflights (refuse sub-issue / PRD-with-children / existing collaborator PR) — a robust AFK-agent pattern for orch's phased roadmap.
7. **Provider capability questionnaires** (`docs/agents/adding-an-agent-provider.md`: "must-have / strongly-preferred / **not-sufficient-on-its-own**" — e.g. "MCP server only" is explicitly insufficient). Maps 1:1 onto orch's `runner-author` skill; adding such a section would sharpen it.

---

## What NOT to borrow (orch already wins here)

- **Workflow model** — orch's typed DSL > sandcastle's plain-TS loops. Keep it.
- **Observability** — orch's two-pane tmux TUI + structured `.orch/state/<runId>/logs/` is far richer than sandcastle's file/stdout display.
- **Resume** — orch's memoized-workflow resume is more powerful than sandcastle's single-iteration session resume (they solve a narrower problem; per ADR-0011 their resume is deliberately one iteration).
- **Config** — orch has real `defineConfig` + typed prompt-var codegen; sandcastle's config file is still an `ideas/` sketch (the `config.json` in its published docs is drift — nothing reads it).
- **Effect-TS** — sandcastle's internals are Effect end-to-end (and it pays a CI gate to keep Effect out of its public API). orch's hand-rolled service ports achieve the same "mock only at the edge" goal without the dependency. No reason to switch; do steal the *idea* of the public-purity gate (Tier 3 #5).

---

## Recommendation

- **Strategic:** Tier 1 #1 (sandbox isolation) + #2 (branch strategy) together unlock safe AFK / parallel runs — the natural next frontier for an orchestrator whose agents currently run on the host. Treat as a roadmap phase, and brainstorm the two-pane-vs-isolated-sandbox tension (Tier 1 #1) before committing.
- **Quick wins:** Tier 1 #3–#5 (session fork, completion timeout, prompt expansion) are independently shippable at medium-or-less effort and high value — good candidates to pick off one at a time.
- **Free now:** Tier 3 #1–#3 (`CONTEXT.md` `_Avoid_` lists, `.out-of-scope/`, ADRs-lead-with-rejected-alternatives) cost almost nothing and compound.

## Appendix — sources

- Repo analyzed: `mattpocock/sandcastle` @ v0.7.0 (shallow clone, 2026-06-12).
- Primary files: `CONTEXT.md`, `docs/adr/0001`–`0020`, `README.md` (~80KB), `src/SandboxProvider.ts`, `src/AgentProvider.ts`, `src/Orchestrator.ts`, `src/run.ts`, `src/interactive.ts`, `src/syncIn.ts`, `src/syncOut.ts`, `src/SessionStore.ts`, `src/PromptPreprocessor.ts`, `src/InitService.ts`, `ideas/config-and-hooks.md`, `research/sandbox-provider-research.md`, `.sandcastle/` self-hosting prompts, `.out-of-scope/`.
- ADRs cited by number throughout (sandcastle's `docs/adr/`).
- orch claims: current working tree of this repo.
