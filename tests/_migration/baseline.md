# Migration baseline (FROZEN — D12)

Snapshot of every `tests/**` path at the end of parent phase U1. Do NOT regenerate
against the mutating tree — U4–U14 accounting queries this frozen artifact.

- Files: **425**
- Test cases: **2517**

| Classification | Files |
|---|---|
| test | 355 |
| type-test | 6 |
| helper | 38 |
| fixture | 22 |
| setup | 2 |
| asset | 2 |

## Test files and cases

### tests/e2e/cli/orch-run.test.ts (5 cases)
- L6 `17062eb3` — orch --help exits 0 and prints usage
- L16 `b123d6eb` — orch with no arguments exits 2
- L22 `9bb977bd` — orch unknown-command exits 2
- L30 `95e1dfd0` — orch runs exits 0 even without state directory
- L38 `e0b3372e` — orch run without a name exits 2

### tests/e2e/resume-real-claude.test.ts (1 cases)
- L29 `e9635577` — real Claude result survives memoization across a resume boundary

### tests/e2e/steps-tui-e2e.test.ts (1 cases)
- L41 `9c5a4be1` — runs a tiny Claude flow under the steps view, then quits via intent

### tests/e2e/tier-4/auto-stop.real.e2e.test.ts (1 cases)
- L31 `230fb488` — finishes its turn and the pane closes on its own with no keystroke

### tests/e2e/tier-4/autonomous-multi-step.real.e2e.test.ts (1 cases)
- L32 `38f5de2d` — two real-CLI autonomous steps run to completion and right.capture() shows live transcript text

### tests/e2e/tier-4/mixed-with-interactive.real.e2e.test.ts (1 cases)
- L17 `0dca4bec` — autonomous step + interactive step share the same harness body

### tests/e2e/workflows/builtin-phased-build.e2e.test.ts (2 cases)
- L70 `725a03b3` — the decide step writes a parseable phase artifact for a tiny plan
- L105 `a1ef13f4` — finishes an interactive turn and the pane closes on its own with no keystroke

### tests/integration/behavioral-dsl/launch-smoke.real.test.ts (4 cases)
- L37 `27c53560` — boots the fixture, parses runId, lands on a reserved socket, and exposes the rawStreams handle
- L64 `3b34bfc2` — drives a held step to mid-run, releases it via the gate file, and finishes
- L106 `f17fa6a7` — teardown is idempotent and removes the isolated stateBase
- L123 `723b933a` — throws a clear error when the fixture name is not registered

### tests/integration/cli/commands/init-e2e.test.ts (3 cases)
- L31 `ad75638d` — scaffolds the .orch/ tree and writes .gitignore in a fresh tmpdir
- L49 `204d9d12` — orch init followed by orch new my-feature: both files exist and manifest lists both
- L68 `2b6edce2` — orch init invoked from the orch source repo exits 2 with the R2 refusal

### tests/integration/cli/commands/init.test.ts (17 cases)
- L64 `35c49301` — creates the canonical .orch/ tree and .gitignore when neither exists
- L79 `17c9d53d` — preserves an existing .gitignore and appends the new line
- L90 `34c259bc` — is idempotent on .gitignore when the line is already present
- L101 `0462196e` — scaffolds a manifest registering the hello workflow (covers AE5 prep)
- L113 `6a35e375` — does not invoke the confirmService on the clean-project F1 path
- L146 `35464178` — AE1 (R7): declining the replace prompt exits 0 and leaves files untouched
- L168 `22c5b00a` — AE2 (R7 + R8 keep): preserves user workflows and state, rewrites scaffolded files
- L198 `0f1fc250` — AE3 (R8 don't-keep): wipes .orch/ and re-scaffolds fresh
- L225 `4d610a49` — AE4 (R9): refuses up-front when --noninteractive even with TTY
- L240 `11ffe6bb` — R9 via piped stdin (isStdinTty=false) refuses identically
- L252 `17416216` — R2 guard still fires in re-init context (before any prompt)
- L268 `8f7714b2` — declining the replace prompt leaves .gitignore untouched
- L311 `2c6f3c7d` — clean F1 init prints no zod warning (scaffold files use orch)
- L326 `8ebb9cca` — reinit keep-mode warns when a preserved user workflow imports from "zod"
- L358 `2e72a385` — reinit keep-mode prints no zod warning when preserved workflows use orch
- L386 `a7eaee3d` — refuses to run when cwd looks like the orch source repo
- L401 `b72e6a10` — proceeds when the host package.json declares a different name

### tests/integration/cli/commands/logs-old-and-new-runs.test.ts (2 cases)
- L81 `1a646ca0` — reads a NEW run with transcriptPath at logs/agents/<step>/events.ndjson
- L117 `8dd02620` — reads an OLD run with transcriptPath at steps/<step>.transcript.ndjson

### tests/integration/cli/commands/new.test.ts (12 cases)
- L70 `5631a19d` — creates the workflow file and appends to the manifest
- L81 `e4d7e9b3` — the scaffolded workflow file interpolates the name in the workflow() call
- L90 `0cb5e963` — appends multiple workflows in the order they were added
- L106 `5fddf18e` — exits 2 with a "No .orch/ found" message when .orch/ is absent
- L119 `59f95237` — rejects an uppercase name with a kebab-case error
- L128 `105ace15` — rejects a name beginning with a digit
- L137 `a7487ff1` — rejects an empty name with a usage hint
- L145 `448eaacb` — rejects a name containing a slash
- L153 `39db7f7b` — rejects a name containing path traversal segments
- L165 `6957df72` — exits 2 when the workflow file already exists and leaves it unchanged
- L177 `eb2fbc6c` — writes the workflow file but exits 2 with a clear "config has been edited" message
- L195 `a376a954` — refuses to run inside the orch source repository

### tests/integration/cli/commands/resume.test.ts (8 cases)
- L72 `72760e33` — returns CANNOT_RESUME when no runs exist
- L82 `58a2a4dd` — returns CANNOT_RESUME when all runs are completed
- L96 `cdc0f6a8` — finds the latest crashed run and attempts resume
- L112 `50561261` — returns CANNOT_RESUME for explicit ID that does not match any run
- L128 `9ddf4b51` — returns CANNOT_RESUME for ambiguous prefix
- L145 `102ca5df` — CLI prompt override is persisted before loadConfig is attempted
- L173 `67a38811` — preserves persisted args when CLI supplies none
- L192 `67a0f279` — returns CONFIG_ERROR for pre-v5 state (prerelease — no migrations)

### tests/integration/cli/commands/runs.test.ts (3 cases)
- L46 `dc33afb0` — returns EXIT.OK and prints message when no runs exist
- L55 `83457b7a` — returns EXIT.OK and lists runs that exist on disk
- L68 `ac230e18` — lists multiple runs in chronological order

### tests/integration/cli/commands/status.test.ts (6 cases)
- L47 `f55b3d18` — returns EXIT.CONFIG_ERROR when no id argument is given
- L56 `22074275` — returns EXIT.CONFIG_ERROR when run is not found
- L65 `55faa0dc` — returns EXIT.OK and displays a completed run with steps
- L82 `cbe363b8` — resolves a partial run ID prefix
- L94 `25d61b1c` — returns EXIT.CONFIG_ERROR for ambiguous prefix
- L108 `34350103` — displays a crashed run with zero steps

### tests/integration/cli/interactive-plain-error.test.ts (1 cases)
- L55 `93c441ac` — exits CONFIG_ERROR with "use --mode=two-pane" pointing at the step name

### tests/integration/cli/interactivity-flag.test.ts (6 cases)
- L9 `ccde67e4` — defaults to interactive when no flag is supplied
- L15 `51e36b4e` — --interactive is the explicit form of the default
- L21 `82aae253` — --noninteractive switches to noninteractive
- L27 `7519fd83` — rejects both flags as mutually exclusive
- L31 `8a2e7b56` — reads ORCH_NONINTERACTIVE=1 when no flag is supplied
- L46 `874b42b0` — --interactive overrides ORCH_NONINTERACTIVE=1

### tests/integration/cli/main-dispatch.test.ts (5 cases)
- L38 `168ab27c` — orch init exits 0 and does not print the [orch] mode=... banner
- L45 `79b36117` — orch new foo does not print the [orch] mode=... banner
- L53 `d8f49818` — orch --help lists both init and new with one-line descriptions
- L62 `efb37020` — orch init --mode=two-pane does not crash on tmux probe (banner skipped entirely)
- L73 `f5f69c48` — unknown command still exits 2 with "Unknown command:" message

### tests/integration/cli/run-builtin.test.ts (5 cases)
- L58 `c4161c72` — loads the packaged built-in and never consults config.workflows for an orch:: name
- L70 `fb3ec915` — resolves a bare registered user workflow through config.workflows as before
- L81 `e115266d` — still throws the existing unknown-workflow error for an unknown bare name
- L90 `7a2d92a6` — reports the available built-ins for an unknown orch:: name
- L100 `d7118450` — surfaces the config error (not a locator error) when an orch:: run has no .orch/

### tests/integration/cli/run-end-of-run-summary.test.ts (2 cases)
- L30 `1dae8536` — prints the two-line success block with a relative data path
- L61 `43627d40` — prints the two-line failure block with the mapped reason

### tests/integration/cli/run-resume-cycle.test.ts (3 cases)
- L48 `a738b309` — v3 state is written with workflowName and timestamps after initRun + setStatus
- L71 `054e5737` — crash then resume cycle preserves v3 state fields end-to-end
- L106 `f7e986f0` — runs and status commands work on the same state files

### tests/integration/cli/run-resume-registry-forwarding.test.ts (1 cases)
- L97 `92df6314` — passes a defined ResumeRegistry into hostFactory inputs

### tests/integration/cli/single-pane-no-terminal-clear.test.ts (2 cases)
- L57 `da8bdf7b` — --mode=single-pane fails fast with the deferral message and writes nothing to stdout (no alt-screen-exit)
- L71 `0dc942ec` — --mode=plain runs against a missing config without leaking alt-screen-exit to stdout

### tests/integration/cli/two-pane-auto-attach.test.ts (5 cases)
- L117 `b41b9819` — spawns tmux -L <socket> attach-session -t orch via the host
- L153 `519de7ed` — when the attach exits first, prints the detached hint and still waits for the workflow
- L227 `35e8a06c` — when the workflow finishes first, skips the detached hint and exits OK
- L303 `6bfb5c4a` — does not spawn attach-session and emits the attach-with hint to stderr
- L332 `33451071` — accepts --mode=two-pane with noAttach=true even when TTY is unavailable

### tests/integration/cli/two-pane-tty-guard.test.ts (4 cases)
- L31 `3934de09` — exits with RunModeError when --mode=two-pane and no TTY and no --no-attach
- L48 `f1728398` — accepts --mode=two-pane --no-attach without a TTY (CI path)
- L63 `836c02a6` — rejects host creation inside a nested tmux session with actionable guidance
- L90 `d1cff22d` — bypasses the nested-tmux guard when skipAttach is true (headless --no-attach in nested tmux)

### tests/integration/cli/unknown-flag.test.ts (2 cases)
- L36 `6eae7cbf` — --tmux exits CONFIG_ERROR with a message pointing at --mode=two-pane
- L44 `bbfd1e51` — --observe exits CONFIG_ERROR with a message pointing at --mode=two-pane

### tests/integration/codegen/codegen-fixture.test.ts (5 cases)
- L31 `22efab4d` — writes one .d.ts per prompt source on a clean tree
- L52 `a6bf2196` — emits Record<string, never> for placeholder-free sources
- L66 `679d483c` — is idempotent — a second run writes nothing
- L82 `51e19583` — rewrites the sidecar when the source content changes
- L103 `bb46148a` — expands brace globs through Bun.Glob

### tests/integration/core/ask-lifecycle.test.ts (2 cases)
- L62 `8e95420e` — emits a step:start event for the ask step before the prompt is awaited so the TUI can show a row for it
- L102 `d2d3a23e` — emits a step:complete event for the ask step after the prompt resolves so the TUI can mark the row done

### tests/integration/core/ask-mocked.test.ts (11 cases)
- L52 `58713d73` — runs the prompt service and persists the typed value
- L91 `b238882c` — replays the cached ask on resume without calling the prompt service
- L122 `fd1375bf` — caches a cancelled ask and replays it without re-prompting
- L166 `e60038f3` — re-prompts when the cached entry has a button no longer in the config
- L204 `13182a7f` — re-prompts when the cached entry is missing a current field key
- L247 `d51aa75f` — keeps cancelled cache valid across button changes
- L278 `bfe8b8b5` — resolves declared default under noninteractive without calling the prompt service
- L300 `c4594abe` — throws AskNoDefaultError under noninteractive when no default is declared
- L329 `0734b82b` — throws AskParallelError when ask is invoked inside parallel()
- L366 `4293ba42` — crashes resume into noninteractive when the un-cached ask has no default
- L405 `60ce8cdb` — rejects prompt overrides on an ask step at the call site

### tests/integration/core/codex-thread-id-capture.integration.test.ts (7 cases)
- L61 `5edb30b5` — replaces the orch UUID with the captured thread_id when capture succeeds
- L90 `550abc4a` — persists sessionIdCaptureError = ambiguous and omits sessionId when capture reports ambiguous
- L115 `515db2b3` — persists sessionIdCaptureError = empty when capture reports empty
- L138 `0e1e39e4` — persists sessionIdCaptureError = error and is distinguishable from the empty variant
- L161 `67392610` — keeps the orch UUID and writes runnerName when the runner declares no captureSessionId (Claude path)
- L185 `6298ee21` — awaits snapshotReady before host.runInteractive is invoked
- L233 `106fa5fa` — does not invoke captureSessionId for autonomous steps and writes no runnerName

### tests/integration/core/command-mocked.test.ts (21 cases)
- L83 `e8d1eb1a` — runs argv through ProcessService and captures stdout in the result
- L100 `976829ec` — captures stderr lines into result.stderr
- L116 `550740f6` — streams stdout lines into host.onCommandLine in arrival order
- L130 `879c03f7` — routes lines to the resolved pane (default 'right')
- L145 `e6b51dc3` — respects pane: 'left' override
- L159 `55529169` — silent: true skips host.onCommandLine but still captures stdout/stderr
- L180 `fa13110e` — throws StepError on non-zero exit when onFailure is 'halt'
- L200 `b4a92d8c` — returns the result on non-zero exit when onFailure is 'continue'
- L214 `8eb36318` — emits step:complete (not step:failed) under onFailure:'continue' with non-zero exit
- L231 `4d4dbc29` — emits step:failed under onFailure:'halt' with non-zero exit
- L254 `d44e22c9` — persists the CommandResult to state.json after success
- L275 `bb0f3502` — persists the CommandResult under continue policy with non-zero exit
- L293 `e216a611` — cache hit on resume returns the persisted CommandResult without re-spawning
- L329 `211001b7` — resolves cwd to currentCwd (deps.cwd) when config.cwd is absent
- L347 `d155674a` — resolves cwd verbatim when config.cwd is absolute
- L367 `28cf4e3a` — inherits the active worktree cwd when createWorktree({enter:true}) ran upstream
- L404 `88ba271c` — merges process.env with config.env (config.env wins)
- L447 `c8aab865` — composes inside parallel(items, fn) without sharing capture buffers across branches
- L473 `e4a38de4` — rejects prompt overrides
- L494 `06417397` — rejects extraContext overrides
- L514 `afcf9172` — rejects extraPrompt overrides

### tests/integration/core/command-real.test.ts (8 cases)
- L56 `538fc47f` — skipped: bun binary not found on PATH
- L60 `9499e9d5` — skipped: sh binary not found on PATH
- L64 `2ada9b70` — runs `bun --version` and captures stdout
- L80 `a5347c92` — captures stderr from a sh -c snippet that writes to both
- L99 `c71aa4c1` — non-zero exit halts under onFailure:'halt'
- L118 `0b967acf` — non-zero exit returns the result under onFailure:'continue'
- L133 `05734b39` — tail(result.stdout, 5) returns the last 5 lines of a 20-line program
- L152 `1a6d23c9` — the cwd override actually changes the spawn's working directory

### tests/integration/core/commit-mocked.test.ts (3 cases)
- L54 `ecb87974` — agent step + commit step round-trip persists correct state shape
- L90 `17b00ad7` — commit step on clean tree persists null value
- L108 `af5a343b` — commit step is skipped on resume when already persisted

### tests/integration/core/commit-real.test.ts (3 cases)
- L80 `d3558426` — creates a commit and returns the new HEAD SHA
- L110 `caf3e852` — returns null on clean tree
- L125 `0f82b7b9` — returns cached result on resume

### tests/integration/core/interactive-workflow.test.ts (2 cases)
- L55 `8f1af7ab` — interactive step followed by autonomous step produces correct state
- L143 `823219e8` — mode override at run() call site overrides step config

### tests/integration/core/parallel-mocked.test.ts (5 cases)
- L51 `7f989051` — heterogeneous parallel persists both step entries
- L79 `a0879ef3` — homogeneous parallel creates entries with as-override names
- L103 `9dc5f57c` — resume skips completed branches and re-runs failed ones
- L162 `fdebf544` — concurrency cap 2 over 5 items limits active runners
- L193 `d4450991` — schema steps return Zod-parsed values through parallel

### tests/integration/core/prompt-file-workflow.test.ts (5 cases)
- L49 `6cd54b10` — imports the workflow module without throwing — step.define calls live inside the workflow body, so module load is purely the workflow() factory call
- L58 `535ca2ef` — slug step holds the raw template (substitution deferred to run())
- L72 `d598e790` — AE5: loadPrompt continues to substitute eagerly (composition escape hatch)
- L91 `31f4a397` — summarize step holds the raw template (substitution deferred to run())
- L105 `3a7be48f` — a workflow .md with a typo throws PromptFileError naming BOTH placeholder and key — but at run() not define()

### tests/integration/core/resume.test.ts (9 cases)
- L56 `e3307e27` — four-step crash at step 3, resume completes all steps with memoization
- L121 `4479fb8e` — resume resets status to running before re-executing
- L170 `b1cf0d44` — double resume: crash at C, resume crashes at D, second resume completes
- L250 `7b567431` — resume on run with zero completed steps re-executes all steps
- L295 `4a9cc387` — resume with parallel branches skips cached branch and re-runs failed one
- L346 `55319573` — resume with commit steps skips cached agent step and re-runs crashed commit
- L401 `b2b71771` — resume on completed run throws ResumeError with correct runId and status
- L429 `a4c12423` — resume on non-existent runId throws RunNotFoundError with correct runId
- L449 `df0a1f20` — resume on stuck running run succeeds

### tests/integration/core/typed-vars-workflow.test.ts (5 cases)
- L95 `15f779fb` — inline {{topic}} literal: distinct vars produce distinct cache entries
- L117 `27b3d8df` — promptFile path: substitution happens at run() time, file is read at define()
- L144 `f771d192` — optional {{name?}} placeholder substitutes to empty when run() omits vars
- L163 `66e06183` — explicit RunOverrides.prompt bypasses substitution entirely (R10)
- L181 `a7d4b9f0` — runCodegen against the reusable-step fixture emits a valid sidecar

### tests/integration/core/validators-workflow.test.ts (3 cases)
- L51 `f35e568a` — throws ValidationError and leaves no StepEntry when fileProduced fails against a real temp dir
- L84 `27d9ba28` — persists StepEntry.validations to disk and reads it back via FileStateStore
- L114 `1a39b5de` — persists 20+ validators through the atomic-write path without corruption

### tests/integration/core/view-resolution.test.ts (3 cases)
- L36 `90a91cfd` — suppresses runner events for silent steps but still fires lifecycle events
- L95 `375179e0` — emits runner events for both steps when neither is silent
- L151 `406239b6` — raises ViewResolutionError for an interactive step under --mode=plain when no onInteractive handler is wired

### tests/integration/core/workflow.test.ts (3 cases)
- L53 `5827d79d` — four-step fake workflow runs end-to-end and persists all steps in state.json
- L90 `83d50dc8` — four-step workflow with crash at step 3, then resume completes all steps
- L153 `42a12fa5` — state.json matches RunState schema after a complete workflow run

### tests/integration/core/worktree-mocked.test.ts (4 cases)
- L108 `f92bff0e` — createWorktree(enter: true) followed by an agent step persists both StepEntry rows with expected shape
- L144 `10981e8e` — homogeneous parallel — each branch creates its own worktree without leaking cwd to siblings
- L204 `9b374361` — parallel branches that crashed mid-execution resume on a fresh process: each branch hits its cache and reapplies cwd in its own ALS scope
- L295 `fa5d49c2` — resume crashed inside postCreate re-runs the entire step (strict — no partial cache)

### tests/integration/core/worktree-real.test.ts (6 cases)
- L117 `24049972` — creates a worktree at the sibling default with branch off HEAD; git worktree list reflects it
- L156 `16a2319e` — from: "main" creates a worktree based off the main branch
- L184 `b340cedd` — enter: true; a subsequent commit step lands a commit on the new branch
- L225 `6c261ae1` — postCreate sugar with $ORIGIN and $TARGET runs cp / touch and produces the expected files
- L256 `4a4ae52a` — a pre-existing branch produces a clear GitCommandError
- L282 `9a933384` — a pre-existing worktree path produces a clear GitCommandError

### tests/integration/examples/subworkflows-smoke.test.ts (5 cases)
- L90 `56a86058` — each example exports a default WorkflowExecutor with the expected name
- L100 `0636579b` — every subworkflow example is registered in examples/orch.config.ts
- L115 `c60010a3` — each example exposes a `execute` and `resume` callable surface
- L132 `b016fdf3` — parent + sub composition emits enter/exit and runs sub step under the sub-path cache key
- L156 `dbb2e339` — homogeneous parallel of two distinct subs runs without tripping R20

### tests/integration/hosts/plain-host-command-line.test.ts (3 cases)
- L24 `b4b6bab5` — writes [<step>] line to stdout for stdout stream
- L46 `4e1690e5` — routes stderr stream to opts.stderr
- L70 `2c788bd5` — emits an NDJSON command-line envelope on stdout

### tests/integration/hosts/plain-mode.test.ts (4 cases)
- L81 `99c4f614` — emits [orch] lifecycle lines and [stepName] runner lines in order
- L98 `95ac72b4` — writes the Story 1.5 failure frame to stderr and exits via StepError
- L154 `9eb323e1` — persists rendered stdout bytes to agents/<step>/formatted_output.{ansi,txt}
- L233 `b1cd1e40` — emits one NDJSON envelope per event with ts/run/ev/step

### tests/integration/hosts/plain/transcript-render-claude.test.ts (2 cases)
- L44 `4f32d4e8` — renders the captured NDJSON into a readable plain-text transcript ending in a done block
- L75 `a2502c53` — emits ANSI escape sequences when color=true and none when color=false

### tests/integration/hosts/tmux-host-command-line.test.ts (4 cases)
- L113 `209616cf` — writes command bytes to the per-step tee, not to the right pane
- L146 `0fb1698e` — ignores pane:'left' — command bytes still flow to the tee, not the left pane
- L178 `b201aae4` — preserves ANSI escape sequences byte-for-byte in the tee (no [step] prefix)
- L212 `acff69eb` — drops writes after teardown without throwing

### tests/integration/hosts/two-pane-failure-and-parallel.test.ts (2 cases)
- L44 `7134f468` — renders the Story 1.5 failure frame on the right pane when an autonomous step fails
- L107 `c0884cf0` — does not fan rollup bytes onto the right pane (U7 invariant) — no logger, no controller

### tests/integration/hosts/two-pane-interactive-session-lost.test.ts (1 cases)
- L39 `506b4d7f` — translates the dead-socket TmuxCommandError into a HostUnavailableError instead of letting it escape un-wrapped

### tests/integration/hosts/two-pane-interactive.test.ts (1 cases)
- L37 `d0250659` — creates a per-source PTY session with runner argv, swaps it visible, waits pane-exit, then kills the session (U4)

### tests/integration/hosts/two-pane-mocked.test.ts (4 cases)
- L37 `8099f291` — streams readable transcript bytes through the per-step tee (U5: no right-pane sendKeys for transcripts)
- L112 `3cea41f8` — left pane is no longer painted by startStatusLoop (steps-view daemon owns it)
- L166 `ec3af851` — persists rendered transcript bytes to agents/<step>/formatted_output.{ansi,txt}
- L248 `e511db30` — captures workflow-body console.log between steps instead of leaking it to tmux

### tests/integration/hosts/two-pane-sequential-runs.test.ts (3 cases)
- L133 `81a9e19a` — two consecutive runs in the same process both finish cleanly
- L147 `c8b35f94` — two consecutive runs against the same workspace filesystem both finish cleanly
- L167 `bc634baf` — two consecutive CLI subprocess invocations both produce a state directory

### tests/integration/hosts/two-pane/autonomous-live-pane-shows-content-immediately.integration.test.ts (1 cases)
- L75 `559eba2a` — creates the tee file with non-empty content before any runner events arrive, so tail -F has something to render immediately

### tests/integration/hosts/two-pane/end-of-run-mount.integration.test.ts (3 cases)
- L48 `07579ebb` — keeps the host alive past workflow completion until awaitForegroundShutdown fires
- L98 `6f57522f` — tears down idempotently — second teardown is a no-op
- L131 `fb253809` — quit intent fires the canonical shutdown signal exactly once

### tests/integration/hosts/two-pane/end-of-run.real.integration.test.ts (1 cases)
- L73 `b3986c64` — renders the end-of-run footer when the seeded run is in a terminal state

### tests/integration/hosts/two-pane/follow-live-prefers-live-over-interactive-replay.integration.test.ts (1 cases)
- L141 `683730b1` — after entering a past interactive step replay, pressing follow-live swaps the visible slot back to the live autonomous source

### tests/integration/hosts/two-pane/interactive-unregister-keeps-visible-slot-alive.integration.test.ts (1 cases)
- L144 `482d7c7a` — leaves visiblePaneId pointing at a live pane so a subsequent replay swap does not target the killed pane

### tests/integration/hosts/two-pane/kind-details.integration.test.ts (1 cases)
- L91 `d01a3754` — writes commit / worktree / ask payloads to .replay/<step>.txt and tails them on scratch

### tests/integration/hosts/two-pane/pane-map-source-session.real.integration.test.ts (7 cases)
- L65 `686a663d` — creates a per-source session as a sibling of the visible orch session, on the same socket
- L96 `e7cd18b2` — runs the cat holder argv as the placeholder session initial pane
- L123 `dae0c110` — runs the file-tail argv as the initial pane for a non-placeholder source
- L154 `4b1d9823` — rounds the sanitizer output trip — a colon/dot key produces a session name actually present on the socket
- L178 `600a9698` — teardownSourceSession kills the per-source session and leaves orch alive
- L201 `83167b03` — teardownSourceSession tolerates double-teardown without erroring
- L219 `f46d9ca6` — two file-tail per-source sessions can be swapped through the visible pane (cross-session swap-pane)

### tests/integration/hosts/two-pane/real-tmux-server-killed-externally.integration.test.ts (3 cases)
- L76 `35f1508a` — translates the dead socket into HostUnavailableError and reports unreachable
- L114 `54c93b65` — records tmuxReachabilityProbeFailed in the lifecycle log on the failure path
- L171 `b0a8a1d2` — host.teardown() against a dead server completes without throwing

### tests/integration/hosts/two-pane/resume-failure-mocked.integration.test.ts (1 cases)
- L124 `0a59ea75` — writes the canonical "resume failed" footer and tails it from a hidden pane

### tests/integration/hosts/two-pane/resume-launcher-mocked.integration.test.ts (1 cases)
- L122 `ce38d27d` — spawns the resume argv as a pty source in a per-source session and swaps it in

### tests/integration/hosts/two-pane/right-pane-busy-gate.integration.test.ts (1 cases)
- L91 `86b431ee` — issues no stray sendKeys footer or respawn-cat on the visible right pane while a step is in flight or after it completes

### tests/integration/hosts/two-pane/right-pane-live-doubling.real.integration.test.ts (1 cases)
- L78 `bc7920a2` — does not double-render or echo ANSI bytes in the visible right pane (file-tail model)

### tests/integration/hosts/two-pane/right-pane-live-output.test.ts (5 cases)
- L138 `2cbf6e7f` — writes runner bytes to the per-step tee instead of the visible right pane
- L158 `8f9661ee` — does not respawn the right pane during the autonomous step (file-tail model)
- L171 `21a9fb47` — writes ANSI-colored payloads to the tee (color: true)
- L180 `5f9511c0` — registers a file-tail source on step:start (createSession for per-source session with tail command) (U4)
- L198 `3b4e80fb` — left-pane bootstrap respawn is unrelated to the right-pane live path

### tests/integration/hosts/two-pane/right-pane-replay.integration.test.ts (6 cases)
- L94 `bfb4635b` — spawns tail -F over .replay/<step>.txt in a per-source session and swaps in for a commit step
- L152 `b5129ebc` — tails .replay/<step>.txt for an autonomous step with no persisted tee (JSON fallback)
- L201 `10ceb6e4` — does not call newWindow / selectWindow / killWindow / respawnPane(rightPaneId) on any path
- L249 `94aa1076` — renders Claude assistant text via toClaudeTranscriptLines when the host wires it as transcriptRenderer
- L308 `f8d28529` — warm-caches the replay pane: re-Enter on the same step swaps without re-spawning
- L352 `f3cd2c4f` — swaps to placeholder on follow-live after a prior Enter when no live/rollup is registered

### tests/integration/hosts/two-pane/right-pane-source-invariant.test.ts (2 cases)
- L61 `a01361e6` — no respawnPane call in src/hosts/two-pane/ targets rightPaneId (use controller.showSource instead)
- L90 `e6d92c09` — exercises the matcher on a synthetic forbidden snippet (self-test)

### tests/integration/hosts/two-pane/steps-tui-e2e.mocked.test.ts (1 cases)
- L47 `902f7289` — keeps the TUI mounted through workflow completion until quit fires

### tests/integration/hosts/two-pane/steps-view-header-no-duplicate.real.integration.test.ts (1 cases)
- L68 `fac60a83` — renders the run breadcrumb exactly once after several state changes and pane resizes

### tests/integration/hosts/two-pane/steps-view/steps-tui.real.integration.test.ts (1 cases)
- L69 `635e460d` — renders the seeded workflow name and step name into the left pane

### tests/integration/hosts/two-pane/tier-1/auto-stop.real.integration.test.ts (4 cases)
- L93 `1418e608` — closes itself when the stop channel is signaled, with no manual close
- L123 `52532452` — records armed → signaled → terminated lifecycle events in order
- L155 `895a9cd8` — resolves via pane-exit when an armed autoStop pane is manually closed, with no stop signal
- L181 `3b41967f` — a step without autoStop never arms and ignores a stop-channel signal

### tests/integration/hosts/two-pane/tier-1/autonomous-live-pane-shows-content.real.integration.test.ts (1 cases)
- L35 `69de587d` — right.waitForText resolves before its timeout, both transcript lines are visible, and no caret-notation echo bytes appear

### tests/integration/hosts/two-pane/tier-1/banner-info-and-error-ttl.real.integration.test.ts (1 cases)
- L43 `8a117f92` — step:failed renders 'step plan failed' in the steps-view left pane

### tests/integration/hosts/two-pane/tier-1/end-of-run-summary-visible.real.integration.test.ts (1 cases)
- L40 `3df2e444` — left.capture() contains `run completed` footer and `steps 1/1 completed` summary

### tests/integration/hosts/two-pane/tier-1/follow-live-returns-to-running-step.real.integration.test.ts (1 cases)
- L33 `d71c1d2e` — press F after navigating to a past step swaps right pane back to the live source

### tests/integration/hosts/two-pane/tier-1/interactive-pane-shows-prompt.real.integration.test.ts (1 cases)
- L24 `2178a8af` — right.waitForText resolves on the prompt sentinel for an interactive step

### tests/integration/hosts/two-pane/tier-1/many-sources-no-split-failure.real.integration.test.ts (2 cases)
- L57 `a6135e04` — runs 6 autonomous steps back-to-back; each lands in its own per-source session and the right pane shows the latest
- L113 `6ee893c3` — captures different pane content after swapping the visible slot across six sources

### tests/integration/hosts/two-pane/tier-1/multi-step-right-pane-shows-latest.real.integration.test.ts (1 cases)
- L39 `c9808ffa` — after the first step completes, the right pane auto-advances to the second live step while the first stays warm-cached

### tests/integration/hosts/two-pane/tier-1/replay-revisit-reuses-pane.real.integration.test.ts (1 cases)
- L39 `b40c385a` — the per-source session pane count is stable across two right-pane captures after step:complete

### tests/integration/hosts/two-pane/tier-1/replay-shows-same-transcript-as-live.real.integration.test.ts (1 cases)
- L36 `93dc7c19` — after the workflow ends, right.capture() still contains both transcript lines

### tests/integration/hosts/two-pane/tier-1/right-pane-shows-failure-summary.real.integration.test.ts (1 cases)
- L38 `35ce8d82` — right.capture() contains the failure headline and error message after the step throws

### tests/integration/hosts/two-pane/tier-1/view-mode-footer-reflects-mode.real.integration.test.ts (1 cases)
- L35 `3b30bd68` — after the workflow completes, the left pane renders the terminal-state footer and the workflow name

### tests/integration/hosts/two-pane/tmux-host-rollup-pane-map.integration.test.ts (4 cases)
- L117 `79afbe09` — writes rollup snapshots to the _rollup tee instead of the visible right pane
- L137 `053f06b5` — registers a file-tail source on step:parallel-start (createSession for the rollup per-source session with tail command) (U4)
- L160 `8f49051f` — does not respawn the right pane during a parallel block
- L172 `027760aa` — kills the rollup per-source session on step:parallel-complete (warm cache is live-only) (U4)

### tests/integration/hosts/two-pane/transcript-replay-memory.smoke.test.ts (1 cases)
- L26 `5c70df79` — keeps resident-set growth under 120MB on a 10MB synthetic transcript

### tests/integration/hosts/two-pane/wheel-no-mode-error.real.test.ts (4 cases)
- L42 `1f154d35` — list-keys -T root after init exposes WheelUpPane with the nested if-shell shape gating copy-mode entry on both mouse_any_flag and alternate_on
- L68 `82d4a939` — WheelDownPane in the root table NEVER falls back to copy-mode at the live tail — only WheelUp opens scrollback (regression guard for trapped-in-copy-mode)
- L95 `7360b8fd` — copy-mode and copy-mode-vi tables contain ONLY the audited allowlist after init — exit (q/Escape/C-c) and scroll (j/k/Up/Down/PageUp/PageDown/g/G/wheel) — so the user can never get trapped
- L149 `062c3921` — the if-shell format strings evaluate against tmux 3.3+ without errors when probed via display-message

### tests/integration/hosts/two-pane/wheel-up-on-ink-prompt-no-copy-mode.real.test.ts (1 cases)
- L52 `e4beb091` — the visible right pane reports alternate_on == 1 while the prompt is open so the smart-wheel binding does not enter copy-mode

### tests/integration/hosts/two-pane/windows.real.integration.test.ts (3 cases)
- L59 `0bb3daf7` — creates a second window via newWindow, leaving list-windows showing two windows
- L83 `4a43f2d5` — selectWindow back to window 0, then killWindow on window 1, leaves only one window
- L109 `dbc9f98f` — killWindow tolerates a missing window id (idempotent teardown)

### tests/integration/lifecycle/ask.noninteractive-uses-default-and-does-not-block.behavioral.real.test.ts (1 cases)
- L33 `845cd614` — --noninteractive resolves the ask to its declared default and the next step runs

### tests/integration/lifecycle/banner.error-banner-persists-until-escape.behavioral.real.test.ts (1 cases)
- L26 `a134b7e1` — error banner stays visible past the info-TTL and dismisses on Esc (blocked: orch tears down on step:failed; Tier 5 cannot observe post-failure pane state — see findings F-5)

### tests/integration/lifecycle/banner.info-banner-auto-clears-after-ttl.behavioral.real.test.ts (1 cases)
- L41 `121cfc0b` — the "step complete" info banner is visible briefly then disappears

### tests/integration/lifecycle/click-to-focus-across-divider-smoke.real.test.ts (1 cases)
- L38 `7252dbdd` — clicks move focus between the left and right panes

### tests/integration/lifecycle/close-stdin-during-mid-step.real.test.ts (1 cases)
- L43 `3c0c6cf1` — preserves the weak close-stdin contract — terminal stays balanced

### tests/integration/lifecycle/command.output-streams-to-right-pane-and-exit-code-recorded.behavioral.real.test.ts (1 cases)
- L31 `60fdf5e0` — command stdout streams to disk and state.json records exitCode 0

### tests/integration/lifecycle/commit.step-creates-real-commit-on-branch.behavioral.real.test.ts (1 cases)
- L31 `a5a55131` — git log on the worktree branch shows the commit added by the commit step

### tests/integration/lifecycle/double-sigint-to-orch-during-mid-step.real.test.ts (1 cases)
- L52 `5a3d32db` — still reaches the §6.5 signal-sigint clean state after a redundant SIGINT

### tests/integration/lifecycle/end-of-run.right-pane-rests-on-final-step.behavioral.real.test.ts (1 cases)
- L36 `1b4e3a61` — the final step has a non-empty events.ndjson and session.json on disk

### tests/integration/lifecycle/end-of-run.summary-and-completion-count-visible.behavioral.real.test.ts (1 cases)
- L45 `587d1c53` — all 3 steps complete, run status=completed, lifecycle.ndjson records run-ended

### tests/integration/lifecycle/failure.api-error-on-first-turn-keeps-run-failed-not-crashed.behavioral.real.test.ts (1 cases)
- L50 `e21437b0` — CLI emits terminal error + non-zero exit → step.failed, run.failed (NOT crashed)

### tests/integration/lifecycle/failure.failed-step-shows-x-glyph-and-error-banner.behavioral.real.test.ts (1 cases)
- L48 `43565137` — puppet fail() emits step:failed in lifecycle.ndjson with the message and ends the run as failed

### tests/integration/lifecycle/failure.persisted-state-reflects-failed-status.behavioral.real.test.ts (1 cases)
- L37 `ce4a8fe4` — state.json status=failed, prior steps completed, failed step recorded

### tests/integration/lifecycle/failure.right-pane-shows-failure-summary.behavioral.real.test.ts (1 cases)
- L39 `a49b4365` — the per-step tee file contains the failure headline and error text

### tests/integration/lifecycle/launch.first-step-is-running-and-highlighted.behavioral.real.test.ts (1 cases)
- L38 `8737f31c` — shows the running glyph on the first step and the live source in the right pane

### tests/integration/lifecycle/launch.interactive-badge-renders-on-interactive-step.behavioral.real.test.ts (1 cases)
- L27 `7d7a9c8a` — renders the interactive glyph on an interactive step (blocked: scripted-fake does not support interactive mode; needs Tier 4 or a PTY-capable fake runner)

### tests/integration/lifecycle/launch.workflow-header-and-step-list-render.behavioral.real.test.ts (1 cases)
- L39 `07d82c52` — renders workflow name, step row, and live-mode footer in the left pane

### tests/integration/lifecycle/nav.enter-on-completed-step-swaps-right-pane-to-transcript.behavioral.real.test.ts (1 cases)
- L35 `f8bef1bd` — viewing a completed step shows its transcript and flips the footer

### tests/integration/lifecycle/nav.f-snaps-selection-back-to-live.behavioral.real.test.ts (1 cases)
- L41 `a6963fb4` — pressing f after entering a viewing state returns the footer to live mode

### tests/integration/lifecycle/nav.help-overlay-opens-and-closes.behavioral.real.test.ts (1 cases)
- L34 `85ce0378` — ? opens help overlay, Esc closes it, and the step list survives

### tests/integration/lifecycle/nav.up-down-moves-selection-without-detaching-live.behavioral.real.test.ts (1 cases)
- L33 `33aeb8b7` — arrow keys move selection while the live step stays marked running

### tests/integration/lifecycle/per-source-sessions-10-step-walkthrough.real.test.ts (1 cases)
- L83 `e1b51a85` — runs 10 autonomous steps; no pane-spawn-failed or scratch-window-rotate events fire; teardown reaps every per-source session

### tests/integration/lifecycle/progression.live-focus-follows-newly-running-step.behavioral.real.test.ts (1 cases)
- L30 `d477b5fa` — next step becomes running after the prior one completes

### tests/integration/lifecycle/progression.per-step-artifacts-land-on-disk.behavioral.real.test.ts (1 cases)
- L30 `e5aef850` — writes session.json and events.ndjson for each completed step

### tests/integration/lifecycle/progression.step-completes-glyph-flips-to-check.behavioral.real.test.ts (1 cases)
- L31 `8cb9dbc9` — renders completed glyph and persists completed status after puppet completes

### tests/integration/lifecycle/q-during-fake-mid-step.real.test.ts (1 cases)
- L43 `f6f8f42d` — tears orch down cleanly — §6.5 pane-q-during-run

### tests/integration/lifecycle/resume.cached-steps-replay-with-cached-glyph.behavioral.real.test.ts (1 cases)
- L44 `10f36a95` — cached plan survives across runs; execute re-runs and the resumed run completes

### tests/integration/lifecycle/sighup-to-orch-during-mid-step.real.test.ts (1 cases)
- L48 `1f262d15` — exits cleanly, tears down tmux, and leaves the terminal balanced

### tests/integration/lifecycle/sigint-to-orch-during-mid-step.real.test.ts (1 cases)
- L48 `72366057` — exits via documented signal, tears down tmux, and leaves the terminal balanced

### tests/integration/lifecycle/sigterm-to-orch-during-mid-step.real.test.ts (1 cases)
- L47 `e8e64c82` — exits cleanly, tears down tmux, and leaves the terminal balanced

### tests/integration/lifecycle/worktree.creates-real-git-worktree-and-switches-cwd.behavioral.real.test.ts (1 cases)
- L36 `cf48cf92` — git worktree list reports the branch and the agent step lands inside it

### tests/integration/lifecycle/worktree.post-create-shell-command-creates-file.behavioral.real.test.ts (1 cases)
- L30 `96e29506` — postCreate ["touch sentinel.txt"] creates the file inside the worktree

### tests/integration/observability/resume-per-step-folder.test.ts (4 cases)
- L27 `c8fb35f7` — events.ndjson reflects only the latest attempt after resume
- L53 `d69da875` — streamSink with truncateOnOpen wipes raw_output.ndjson on resume
- L88 `c87cf3a6` — per-step render tee truncates formatted_output.ansi/.txt on resume
- L129 `82447959` — non-truncate streamSink appends across instances (control case)

### tests/integration/observability/session-logger-baseline.integration.test.ts (11 cases)
- L114 `d5c884da` — FakeRunner-driven workflow writes spawns.ndjson with correct argv, envKeys and mode
- L137 `1b3fdf7b` — events.ndjson contains one record per RunnerEvent and every record carries a stepSpanId
- L155 `a205323d` — lifecycle.ndjson brackets the run with host-created and run-ended and records step:start/complete
- L173 `70cb0aca` — timeline.ndjson is a strict superset of spawns, events, and lifecycle and is monotonic in ts
- L203 `4be23f74` — run.meta.json contains orchVersion, argv, envKeys and no env values by default
- L230 `ff1909a2` — run.meta.json with ORCH_LOG_ENV_VALUES emits env values with secrets redacted to ***
- L253 `35b6c46e` — agents/<stepName>/session.json contains prompt, argv, envKeys, finalEvent, and stepSpanId
- L289 `946ccb63` — grep stepSpanId returns matches in every baseline ndjson file
- L309 `28f86a9f` — renderRunReadme produces a README.md that includes the runId and grep recipes
- L327 `c311eb2b` — a failed workflow writes a run-ended lifecycle record with status=failed
- L378 `0abd9f21` — resume appends run:resumed to lifecycle and bumps run.meta.json.resumedAt

### tests/integration/observability/session-logger-debug.integration.test.ts (6 cases)
- L139 `6300097c` — writes raw agent stdout to agents/<step>/raw_output.ndjson regardless of debug
- L162 `7a630b6c` — always opens the per-step raw_output.ndjson sink, even when no stderr bytes flow
- L180 `1e686325` — records non-agent subprocess spawns to subprocesses.ndjson
- L216 `3f9681aa` — writes orch.log entries when orchLog is called from a debug run
- L239 `575e3e22` — still writes always-on per-step files when debug is off; gates only subprocesses/orch/tmux
- L276 `5c54134e` — instrumentProcessService returns the base service unchanged when debug is false

### tests/integration/observability/session-logger.e2e.test.ts (9 cases)
- L142 `ff7a5c29` — writes the full baseline logs directory after a one-step workflow
- L157 `f3b35e13` — writes run.meta.json with the expected keys and no env values
- L170 `8d214d8d` — writes spawns.ndjson with one record per agent spawn
- L186 `2f983a77` — writes events.ndjson with one record per RunnerEvent
- L198 `af4ea071` — writes lifecycle.ndjson bracketed by host-created and run-ended
- L210 `f3289d02` — writes timeline.ndjson as a sorted superset of the three ndjson streams
- L234 `c913ad28` — writes agents/demo/session.json with prompt, argv, envKeys, finalEvent, exitCode
- L248 `9d7401d3` — writes README.md with the runId and the grep recipes heading
- L256 `775fb19f` — grep stepSpanId returns matches in every baseline ndjson file

### tests/integration/observability/status-loop.test.ts (9 cases)
- L43 `8587bf5f` — moves a step from absent to running when step:start fires with autonomous mode
- L49 `df7c4ee4` — records interactive status when step:start fires with interactive mode
- L63 `5a7fc210` — preserves the earlier startedAt when step:complete fires
- L77 `7b9cb853` — marks a cached event without touching timestamps
- L93 `445882db` — sends a clear-and-redraw sendKeys payload whenever a step:start event arrives
- L108 `d63541e2` — re-renders on completion with the frozen duration in place of live elapsed
- L133 `26889aed` — stops rendering after stop() is called and ignores subsequent events
- L153 `f26c15e3` — routes tmux sendKeys failures to the onError hook without throwing to the caller
- L171 `d803d5bf` — exposes the live record list via records() for agent consumers

### tests/integration/observability/status-real.integration.test.ts (1 cases)
- L48 `d01582dc` — renders a step:start event into the status pane within a short capture window

### tests/integration/real-tmux/agent-handle.test.ts (4 cases)
- L47 `1c67821e` — resolves a control file under the run state dir for the given key (R8)
- L59 `a8bcd360` — gives two distinct handles for two distinct labels (R9)
- L72 `d7217827` — drives one instance end-to-end: waitForReady, ack-gated typeAndSend, finish (R8, R12, R13)
- L94 `e7de5a37` — drives two parallel branches independently via their own handles (R9)

### tests/integration/real-tmux/predictable-fake-f1.test.ts (2 cases)
- L60 `d42de576` — drives a two-step workflow to a finished state, every assertion gated on a durable signal
- L110 `2bdedc2d` — renders a hand-typed line exactly once via tmux send-keys (manual stdin, not control)

### tests/integration/real-tmux/predictable-fake-f2.test.ts (2 cases)
- L70 `59c2b90e` — delivers each branch only its own type_and_send text
- L106 `4c548a88` — finishing one run does not end the other; handles never resolve the wrong run

### tests/integration/real-tmux/predictable-fake-ink.test.ts (1 cases)
- L45 `183d3b1a` — drives an Ink step: control line renders to the log and the visible pane, then finishes

### tests/integration/real-tmux/predictable-fake-three-step.test.ts (1 cases)
- L64 `397f674f` — drives a three-step run to a finished state, every assertion gated on a durable signal

### tests/integration/real-tmux/teardown-leak-guard.test.ts (3 cases)
- L67 `92aa1d01` — reaps every fake child after an interactive + headless run
- L94 `1e5a3190` — leaves no leaked processes when torn down while an instance is mid-idle
- L133 `ba4594a4` — exits within one budget when the threaded ORCH_PARENT_PID dies, even though its real ppid is alive

### tests/integration/runners/claude/claude-e2e-lite.test.ts (1 cases)
- L28 `adbef92a` — runs a single-step workflow and persists completed state

### tests/integration/runners/claude/claude-mocked.test.ts (3 cases)
- L22 `bb7e2d38` — round-trips simple-success.jsonl through runRunner with correct events and terminal
- L47 `69899e7d` — round-trips error-max-turns.jsonl with terminal error and message present
- L71 `5146f9b0` — produces the correct argv shape for the spawned process

### tests/integration/runners/claude/claude-real.test.ts (1 cases)
- L15 `66f06268` — runs "Reply with exactly: OK" and receives a success result with intermediate events

### tests/integration/runners/claude/claude-resume.test.ts (1 cases)
- L52 `39988e8b` — step 1 memoized on resume, step 2 re-runs with success fixture

### tests/integration/runners/claude/claude-structured-mocked.test.ts (6 cases)
- L61 `c1123834` — full round-trip: schema step through ClaudeRunner with structured-output-success fixture
- L91 `654be15c` — schema validation failure with structured-output-invalid fixture throws SchemaValidationError
- L128 `e907725a` — error_max_structured_output_retries fixture routes to StepError
- L164 `9c568379` — memoization: second run returns cached value without re-running
- L186 `2c753e4b` — schema step with validators: structured output available as ctx.value in check()
- L211 `66f467d4` — --bare and --json-schema coexist: structured_output present in result envelope

### tests/integration/runners/claude/claude-structured-real.test.ts (1 cases)
- L43 `4114a72e` — real Claude with --json-schema returns Zod-parsed, type-safe value

### tests/integration/runners/codex/codex-mocked.test.ts (5 cases)
- L35 `6646aba8` — round-trips simple-success.jsonl through runRunner with correct events and terminal
- L57 `75f91feb` — round-trips with-output-schema.jsonl with structured output parsed as JSON
- L92 `c13170d1` — round-trips turn-failed.jsonl with terminal error and message present
- L113 `dd0e9191` — produces the correct argv shape for the spawned process
- L136 `3349bb45` — formats command_execution and agent_message into the expected transcript lines via runRunner

### tests/integration/runners/codex/codex-real.test.ts (1 cases)
- L16 `0dff741a` — runs "Reply with exactly: OK" and receives a turn-complete result

### tests/integration/runners/cross-runner-parallel.test.ts (1 cases)
- L21 `b4dd1840` — runs both runners in parallel and both return turn-complete

### tests/integration/runners/run-runner.test.ts (6 cases)
- L18 `10d2cb4d` — round-trips info events, terminal event, and structured output through a FakeRunner
- L38 `40aed10a` — returns a non-zero exitCode when the runner errors and does not throw
- L53 `58961074` — measures durationMs using the injected Clock
- L66 `c7785f12` — never calls extractStructuredOutput in Phase 2
- L86 `96b95265` — reports an error terminal event when the process closes without producing one
- L132 `37e3f17a` — drains trailing stdout lines after the terminal event without including them in events

### tests/integration/runners/scripted-fake-ink.test.tsx (4 cases)
- L113 `ec567f56` — echoes characters into the input prompt before Enter is pressed
- L130 `946db20f` — moves a submitted line into the message list and appends it to the render log once
- L155 `fcd7ecf7` — renders a control type_and_send into the same list + render log and acks it
- L185 `0a25a93d` — resolves the finished deferred when the user submits "q"

### tests/integration/runners/scripted-fake-interactive.test.ts (11 cases)
- L149 `740f5181` — reports supports.interactive true only when constructed interactive
- L157 `caae3de2` — selects the interactive entry argv when interactive
- L170 `9ee0cdae` — writes the .ready marker once idle-waiting after render setup
- L178 `a1bbcb94` — renders a control type_and_send line to the durable render log and acks it
- L189 `f95ac323` — terminates on a control finish and exits 0
- L200 `a539b9ec` — exits 0 even on finish(2) — interactive finish is clean-exit-only
- L215 `776f99df` — renders a bare manual line identically to a control type_and_send (R3, R5)
- L225 `2d2ed0b5` — ends the step on manual q (R5)
- L235 `760abe6d` — ends the step on manual exit (R5)
- L245 `cfffceb7` — ignores an empty manual line, rendering nothing (R3 empty-line parity)
- L258 `3ecafc46` — acks a control command even when a stdin finish arrives concurrently

### tests/integration/runners/scripted-fake-puppet-addressing.test.ts (10 cases)
- L104 `e969a615` — resolves <runStateDir>/test-control/<key>.ndjson for a simple key
- L116 `d3abe4c5` — sanitizes a key with > / : separators into one injective filename (R10)
- L131 `deb50ee2` — maps distinct keys a>b and a:b to distinct transport files (injectivity, R10)
- L140 `a69bfc6d` — isolates two runs with the same key under distinct runId dirs (R11)
- L149 `be28b324` — writes a matching <seq>.ack for each appended command
- L167 `6fa7d421` — propagates a non-zero finish code: terminal error on stdout + matching exit code (R2)
- L191 `2b689409` — writes the .ready marker once the instance is idle-waiting
- L204 `75eecc9e` — deletes a stale marker at spawn and re-writes it from the new attempt
- L228 `33f1d342` — processes a command appended to the control file before the agent starts
- L247 `11404280` — uses the baked path and ignores the threaded key when both are present

### tests/integration/runners/scripted-fake/entry.real.test.ts (9 cases)
- L89 `3b2f9474` — emits a turn-complete event and exits 0 for an instant-ok step
- L100 `cf308c17` — emits scripted info events in order followed by turn-complete
- L123 `a4037f44` — attaches structuredOutput to the turn-complete event when set
- L139 `2a14dbef` — emits a terminal/error event and exits non-zero for instant-fail
- L150 `7e12e038` — defaults instant-fail to exit code 1 when not specified
- L160 `936fa0d7` — blocks on wait-for-file until the gate file exists, then proceeds
- L188 `b6daa41c` — emits-then-hangs until killed and never produces a terminal event
- L233 `935cc0ac` — reports a clear error and exits 1 when ORCH_LIFECYCLE_SCRIPT is unset
- L265 `656bdbfc` — reports a clear error when the step name is missing from the script

### tests/integration/runners/scripted-fake/two-step-linear.smoke.test.ts (1 cases)
- L51 `a3421d8c` — runs both steps to completion when scripted as instant-ok × 2

### tests/integration/services/fs/bun-fs-service.test.ts (7 cases)
- L22 `48b8ce90` — round-trips writeFile and readFile against a real temp directory
- L32 `0e49c6f0` — creates a real temp directory with the requested prefix
- L39 `ee13888d` — performs an atomic rename on the real filesystem
- L51 `bebf9f91` — matches glob patterns over a real directory tree
- L65 `e6bab4bd` — removes files and reports exists false afterward
- L76 `b69c0907` — reports size and mtimeMs via stat on a real file
- L88 `bed56ed1` — creates nested directories with mkdir recursive on the real filesystem

### tests/integration/services/process/bun-process-service.test.ts (8 cases)
- L18 `8355d567` — yields a single line "hello" and exits with code 0 when running sh -c "echo hello"
- L29 `6bc079ce` — yields three lines from sh -c "printf a\nb\nc" even without a trailing newline
- L40 `6c245f14` — yields no stdout and resolves wait() with exitCode 7 when running sh -c "exit 7"
- L51 `c65752db` — throws ProcessSpawnError synchronously when the binary does not exist
- L59 `0a54895f` — throws ProcessSpawnError synchronously when cwd does not exist
- L67 `110f773a` — causes wait() to resolve with a non-zero exitCode after kill() on a long-running sh -c "sleep 30"
- L77 `adb5107f` — drains stderr concurrently so wait() does not deadlock when the child writes > 64 KiB to stderr
- L95 `bcdbc0da` — yields stderr lines live as the child writes them, before wait() resolves

### tests/integration/services/prompt/ink-prompt-service-real.test.ts (3 cases)
- L28 `e4bd36d9` — exits non-zero when invoked with no args (arg-parse boundary)
- L39 `dadaa332` — exits non-zero when --spec is missing
- L58 `ce3f287a` — renders, accepts Enter on the first button, and writes the result file

### tests/integration/services/prompt/ink-prompt-service.test.ts (7 cases)
- L67 `e2dc9d65` — encodes the spec as base64 JSON and reads the child-written result file
- L105 `eb3c23e0` — throws a clear error when the child exits without writing a result file
- L123 `f91d7b67` — throws HostUnavailableError (not the generic message) when the host is unreachable after the child exited
- L143 `e57c2330` — cleans up the temp dir after a successful ask
- L166 `5113be88` — cleans up the temp dir even when the child errors
- L188 `eef081f9` — rejects misrouting under --mode=plain
- L201 `72d03d6a` — passes a cancelled-result through unchanged

### tests/integration/services/tmux/tmux-integration.test.ts (38 cases)
- L16 `3f34da07` — sends new-session with detached flag, socket, window geometry, /dev/null config, and -P -F #{pane_id} (U2)
- L48 `20f022b9` — passes configPath as the -f flag when provided
- L84 `560773c6` — throws TmuxCommandError with the captured stderr when new-session fails
- L120 `aa5d9a89` — returns the parsed pane id from split-window -P output
- L152 `5f3abd4e` — throws when split-window returns a malformed pane id
- L184 `879f9db2` — passes -d so that swapping a hidden pane into the visible slot does not move tmux focus to it
- L201 `6be0cbd0` — passes each key verbatim after -l to prevent metacharacter interpretation
- L216 `de42c1c8` — sends a separate Enter invocation when opts.enter is true
- L236 `fde99730` — resolves once the underlying wait-for subprocess exits zero
- L248 `3864be6a` — waits indefinitely when timeoutMs is omitted and resolves on exit zero
- L263 `7e3b4c1e` — throws the wait-for-failed error path (not the timeout path) when timeoutMs is omitted and the subprocess exits non-zero
- L292 `915de6b8` — returns the stdout line as the rendered format
- L308 `0ebbef51` — throws when tmux returns exit 0 with empty output (invalid pane)
- L326 `9874ef99` — builds a global set-option argv when global is true
- L342 `44b56295` — builds a global set-hook argv with the hook name and command
- L359 `b1596eb6` — sends the expected argv for each single-purpose method
- L379 `26fa43b3` — builds capture-pane argv with -p and appends -e/-J when requested
- L396 `35437945` — omits -e and -J flags when capturePane is called with defaults
- L410 `bbdb8dab` — builds pipe-pane argv with -O and the command as the final positional
- L425 `e5b120ed` — passes an empty command string to tear down an existing pipe
- L439 `732a5598` — splits the format-rendered stdout into one entry per non-empty line
- L455 `4c881a98` — throws TmuxCommandError when list-panes exits non-zero
- L473 `e69597e6` — composes tmux respawn-pane -k -t <pane> <argv...> with no shell interpretation
- L501 `cfcd1172` — omits -k when killRunning is false
- L516 `70d7592c` — throws TmuxCommandError on non-zero exit
- L533 `089004d5` — emits one -e KEY=VAL flag per env entry before -t and the argv
- L564 `420857ea` — omits -e flags entirely when env is undefined or empty
- L580 `999a65e7` — throws when an env key contains '=' or newline (would corrupt -e KEY=VAL argv)
- L605 `4d13d629` — emits -c <cwd> after -e flags and before -t when cwd is set
- L641 `37d3abc4` — omits -c entirely when cwd is undefined
- L664 `80f95ce4` — emits unbind-key -a -T <table> for the requested table
- L674 `08bfe78c` — emits unbind-key for the copy-mode-vi table verbatim
- L687 `a46a8384` — throws TmuxCommandError when unbind-key exits non-zero
- L701 `15631ac0` — emits bind-key -n <key> <command...> when table is 'root-no-prefix'
- L719 `9650c6ca` — emits bind-key -T <table> <key> <command...> for non-root-no-prefix tables
- L744 `d69552df` — rejects a key containing a newline before any subprocess is spawned
- L758 `221b0f82` — rejects a key containing a NUL byte before any subprocess is spawned
- L772 `e41609b9` — throws TmuxCommandError when bind-key exits non-zero

### tests/integration/services/tmux/tmux-real.integration.test.ts (26 cases)
- L50 `fa988d00` — creates a session, splits a pane, and returns a valid tmux pane id
- L66 `f454edee` — createSession returns the initial pane id, and listPanes confirms it owns that pane
- L86 `9b9fb993` — queries pane status via display-message with a format variable
- L108 `d953657c` — throws TmuxCommandError when display-message targets a non-existent pane
- L123 `6d77071e` — sendKeys with Enter delivers literal keystrokes to the target pane
- L156 `937284b6` — signals the per-pane wait-for channel via the pane-died hook on the same socket
- L200 `18d8c67e` — signals the wait-for channel even when the pane process exits 0
- L236 `dc8876b3` — inherits the orch process env so non-allowlist keys reach pane processes
- L272 `0e7368af` — respawn-pane -c sets the pane current_path so runners see the project cwd
- L313 `4f065a8c` — swapPane exchanges the contents of two panes
- L361 `8810608e` — swapPane works across sessions on the same socket
- L402 `468fee78` — swapPane throws TmuxCommandError when either pane id is invalid
- L420 `1ee99d04` — splitPane argv runs the given argv as the pane process
- L444 `d397f844` — splitPane argv with env exports the env to the pane process
- L464 `d8890c08` — splitPane argv with cwd sets the pane current_path
- L489 `f516d34e` — splitPane argv rejects env keys containing = or newline
- L507 `01679dbe` — splitPane argv rejects argv elements containing NUL
- L524 `ace3751e` — isolates state across concurrent sockets
- L574 `2cf82664` — list-keys -T root contains exactly the six allowlist bindings after init
- L594 `4815900a` — list-keys for the prefix table is empty after init (no prefix-rooted commands survive the wipe)
- L605 `fff77c86` — list-keys for copy-mode and copy-mode-vi tables contain the audited allowlist (exit + scroll) after init
- L640 `06f3f9bd` — show-options -g prefix returns None after init so C-b is inert
- L656 `fa9ba3c3` — display-message #{history_limit} is >= 50000 on the initial pane after init
- L678 `ce0c5f95` — display-message #{history_limit} is >= 50000 on a freshly split pane
- L706 `064cf6be` — show-hooks -g pane-died reveals the lifecycle hook still installed after the unbind-key wipe
- L727 `05735fce` — show-options -g status-right contains the in-pane scroll hint after init

### tests/integration/state/run-registry.test.ts (1 cases)
- L17 `ed40e6e7` — lists runs from a real temp directory

### tests/integration/state/state-store.test.ts (2 cases)
- L18 `89141a2d` — round-trips against a real temp directory
- L34 `71c15605` — atomic write produces valid JSON on disk

### tests/integration/tests-setup/cleanup-reaper.real.integration.test.ts (6 cases)
- L81 `84772477` — reaps a reserved orch-test- server whose owner pid is dead (server gone + socket file gone)
- L96 `481c0f43` — leaves a reserved orch-test- server whose owner pid is alive (live parallel run)
- L110 `6581372e` — leaves a live production orch-r- server untouched (incident repro)
- L126 `2d745b69` — reaps only the dead-pid server when a dead and a live reserved server coexist (parallel safety)
- L142 `00f37243` — errs safe — an alive-but-unrelated owner pid is skipped (missed cleanup, never wrongful kill)
- L157 `9db62a4d` — determines reap purely by pid liveness, independent of socket age

### tests/integration/validators/file-produced.test.ts (3 cases)
- L29 `22deb5c5` — returns ok when a matching file exists under a real temp dir
- L39 `77532343` — returns a failure on an empty real temp dir
- L51 `f3f2286e` — matches nested files via the ** glob against a real temp dir

### tests/integration/validators/git-validators.test.ts (5 cases)
- L40 `8003e863` — gitDiffCreated fails on a clean repo then passes after an unstaged edit
- L65 `c5232de5` — gitCommitCreated fails before a commit and passes after HEAD moves
- L102 `34e11191` — BunGitService.headSha returns a non-empty SHA on the seeded repo
- L114 `cebe7d4a` — produces a path that exists and a commit SHA shaped like hex
- L121 `e5bb476d` — cleanup removes the directory

### tests/integration/workflows/builtin-variants.test.ts (7 cases)
- L32 `a22df12a` — exports a work-cc executor named work-cc
- L38 `d7cc9336` — exports a work-codex executor named work-codex
- L47 `6f416f5d` — routes work-cc into the phased body — empty prompt yields the usage error, not a stub error
- L53 `d139ab64` — routes work-codex into the phased body — empty prompt yields the usage error, not a stub error
- L65 `ff1c8343` — both names run the same interactive-step sequence and prompts; only the runner differs
- L89 `e739c5e0` — every agent step is interactive + autoStop — the pipeline has no autonomous step (R5)
- L107 `37f876df` — completes a 2-phase plan from an inline description with no human keystrokes

### tests/integration/workflows/phased-build-decide.test.ts (4 cases)
- L31 `d3125dbd` — uses the freshly-emitted artifact, not the phase structure in the input plan
- L48 `61466720` — prompts the agent to re-derive rather than copy the input's structure
- L63 `52e237a2` — runs the decide step interactively with autoStop enabled
- L79 `ae27324f` — halts when the read-back is empty (a decide step that wrote nothing)

### tests/integration/workflows/phased-build-input.test.ts (6 cases)
- L17 `ab4889d3` — loads an existing file as the plan text handed to the decide step
- L33 `eec38c1c` — hands the argument string itself to the decide step when it is not a readable file
- L48 `f42f6654` — halts before the decide step when an existing file is empty
- L63 `d4621ec2` — throws a clear usage error before any agent step when the argument is missing
- L74 `df6870c0` — throws on a whitespace-only argument
- L85 `f1da8abb` — produces executors with distinct names but identical step structure from one factory

### tests/integration/workflows/phased-build-loop.test.ts (5 cases)
- L28 `67845e7c` — runs exactly three implement steps in order and completes unattended
- L49 `b54b841b` — caches each phase under a distinct key so resume re-enters the right phase
- L68 `67d31297` — scopes each prompt to a single phase with no commit or validation instruction
- L85 `edad9485` — halts before the next phase when a phase reports a non-ok sentinel
- L103 `8fb9e1a7` — halts when a phase leaves a missing or empty sentinel (no-write / crashed phase)

### tests/unit/barrel.test.ts (5 cases)
- L10 `7905bbc8` — re-exports `z` so workflows can author schemas without installing zod in the host repo
- L18 `21e6a28c` — re-exports the schema() wrapper alongside z so they can be imported together
- L22 `df312955` — re-exports the workflow primitives (workflow, step)
- L28 `243ec670` — re-exports loadPrompt and PromptFileError so workflow authors can compose prompt fragments
- L35 `b91ee022` — does not leak the internal prompt-file helpers into the public surface

### tests/unit/cli/argv.test.ts (26 cases)
- L5 `5052c15d` — parses a command with a positional argument
- L13 `77557af7` — parses a command without a positional argument
- L21 `45e01639` — returns undefined command when no arguments are given
- L28 `89817c97` — parses --help flag
- L34 `951630d0` — parses -h shorthand
- L40 `2237a0a2` — parses --help alongside a command
- L47 `d845d12b` — ignores unknown flags without throwing
- L54 `e4027ef2` — parses dry-run as a single command word
- L63 `d74d3fc0` — captures a positional prompt as args.prompt
- L71 `c247511d` — captures a --prompt flag as args.prompt
- L77 `a92ba8c3` — leaves args empty when no prompt is supplied
- L83 `fd63de67` — treats an empty-string positional prompt as distinct from undefined
- L89 `d922601b` — treats an empty-string --prompt flag as distinct from undefined
- L95 `d77db190` — throws ArgvError when both positional and --prompt are given
- L99 `5e95047a` — throws ArgvError when more than one positional prompt is given
- L103 `61fcc2cb` — accepts a prompt on the resume command
- L113 `d0d144b6` — defaults mode to undefined (auto-detected) and format to text
- L120 `4f8a09b4` — accepts --mode=plain
- L126 `4e7595b5` — accepts --mode=two-pane
- L132 `df381b5a` — accepts --mode=single-pane at parse time (deferral handled later)
- L138 `421c03f9` — rejects unknown --mode value
- L142 `9181e808` — accepts --format=json
- L148 `9f01c5b9` — rejects --format=json with --mode=two-pane
- L154 `1dcd4ab4` — rejects unknown --format value
- L160 `15c26bf8` — rejects --tmux with a message pointing at --mode=two-pane
- L172 `d8461d68` — rejects --observe with a message pointing at --mode=two-pane

### tests/unit/cli/banner.test.ts (4 cases)
- L21 `8e655023` — renders the resolved mode, source, and reason on a single line
- L31 `217f4270` — returns the in-pane scroll + orch logs hint for two-pane non-JSON runs
- L42 `03b03871` — returns undefined for plain runs because plain prints the transcript inline
- L46 `400a9c12` — returns undefined for two-pane JSON runs because JSON suppresses the banner entirely

### tests/unit/cli/commands/init-templates.test.ts (7 cases)
- L22 `fe7e3542` — all four templates parse as valid TypeScript
- L29 `a14da57d` — HELLO_WORKFLOW_TEMPLATE imports workflow from "orch" and default-exports workflow(...)
- L34 `87152268` — STEPS_TEMPLATE imports claude and step from "orch" and exports HELLO
- L39 `95ac0a47` — CONFIG_TEMPLATE uses `export const config` (preferred over default export)
- L44 `632c8cbf` — CONFIG_TEMPLATE registers hello → workflows/hello.ts
- L48 `dc21d789` — newWorkflowTemplate interpolates name into the workflow() call only
- L56 `602553c4` — newWorkflowTemplate does not blow up on awkward inputs (regression for unvalidated names)

### tests/unit/cli/commands/scaffold.test.ts (31 cases)
- L14 `c1232df3` — creates the workflows + state directories and scaffolds the four files
- L27 `38482f01` — does not touch files outside the target orchDir
- L39 `bd723b3e` — creates the file with exactly one line + trailing newline when absent
- L48 `4ff95028` — is idempotent: running twice does not duplicate the line
- L58 `56f3f160` — appends without disturbing existing lines (file ends in newline)
- L68 `cc0e6b04` — inserts a leading newline when the existing file lacks a trailing one
- L78 `382539ee` — treats whitespace-trimmed matches as present (does not duplicate)
- L90 `709f6285` — rejects paths that do not end with /.orch
- L99 `15e4e18b` — removes the tree recursively for a path ending in /.orch
- L114 `bd9a34e3` — returns every .ts file in workflows/ except hello.ts
- L128 `c134663f` — returns an empty list when only hello.ts is present
- L138 `1f0f3439` — returns an empty list when workflows/ does not exist
- L158 `d3d951c7` — adds a new entry to the workflows map while preserving surrounding content
- L177 `3c384f01` — appends multiple workflows in the order they were added
- L202 `af208d22` — throws a clear actionable error when the workflows-block regex does not match
- L215 `49416572` — produces a manifest that still parses as valid TypeScript after insertion
- L234 `364e5092` — detects a named import from single-quoted zod
- L238 `458a0bb1` — detects a named import from double-quoted zod
- L242 `22d805b0` — detects a default import from zod
- L246 `6fbbc281` — detects a namespace import from zod
- L250 `3e33c8a6` — detects a re-export from zod
- L254 `8aed60a9` — detects a side-effect import from zod
- L258 `7191c9c0` — does NOT match imports from orch (even if zod appears elsewhere)
- L262 `cfb24aab` — does NOT match a commented-out zod import
- L266 `fe5d17a9` — does NOT match string content that mentions zod
- L270 `aa4dbadb` — returns false on empty source
- L276 `2f0abfb7` — returns an empty list when no workflow imports zod
- L290 `808a7d47` — flags every .orch/workflows/*.ts file that imports zod directly
- L308 `a4e7d4a0` — flags steps.ts when it imports zod directly
- L321 `ad2b41c2` — skips non-.ts files in workflows/
- L331 `c6fe0e42` — handles a missing workflows/ directory gracefully

### tests/unit/cli/detect-self.test.ts (7 cases)
- L14 `22f19454` — returns true when package.json name is "orch" AND src/cli/main.ts exists
- L24 `a09156a6` — returns false when package.json declares a different name
- L34 `312132d2` — returns false when src/cli/main.ts is absent (incomplete repo)
- L43 `a404e09a` — returns false when package.json is missing entirely
- L50 `52075606` — returns false when package.json is malformed JSON
- L60 `07a24601` — returns false when package.json parses to a non-object top-level value
- L70 `50be74ba` — returns false from a subdirectory of the orch source repo (only literal cwd is checked)

### tests/unit/cli/detect-tmux.test.ts (9 cases)
- L10 `5fa69ef2` — returns true when TMUX is set to a non-empty string
- L14 `6eada566` — returns false when TMUX is undefined
- L18 `cebcafb3` — returns false when TMUX is an empty string
- L24 `f7143316` — accepts tmux 3.3 exactly
- L28 `795a70ff` — accepts any release above 3.3
- L33 `12640bc8` — rejects tmux 3.2 and earlier (smart-wheel requires the mouse_any_flag format from 3.3)
- L41 `c97e3ef0` — parses the major and minor components of tmux -V output
- L52 `ae46eeb2` — returns undefined when tmux -V exits non-zero
- L61 `9a33c713` — throws when tmux -V output does not look like a version string

### tests/unit/cli/execute-with-attach.test.ts (8 cases)
- L72 `9c64578c` — writes the two-line success summary on the success path
- L92 `f8fb3b34` — writes the two-line failure summary on a mapped failure
- L112 `01823b9b` — does not double-write the reason — mapError is side-effect free
- L131 `e451b737` — two-pane: prints the detach hint when the host is still reachable after attach exits
- L160 `ee59303e` — two-pane: prints unreachable notice (NOT the detach hint) when probe fails after attach exits
- L193 `cad6e358` — two-pane: when attach exits to an unreachable host, fails on host loss instead of continuing to a later interactive step
- L237 `42c4c3a8` — renders a crash summary and exits STEP_FAILURE when mapError returns undefined (never re-throws into the silent backstop)
- L263 `503141a6` — crash summary uses String(reason) when a non-Error is thrown

### tests/unit/cli/format.test.ts (8 cases)
- L6 `a4e86f21` — returns Unicode glyphs when TTY is true
- L14 `43d1c09d` — returns ASCII fallback glyphs when TTY is false
- L24 `64ab3122` — formats sub-second durations as milliseconds
- L30 `637332a4` — formats seconds when >= 1000ms and < 60s
- L36 `fb518410` — formats minutes and seconds when >= 60s
- L44 `90e6702b` — uses endedAt - startedAt when both are present
- L50 `e720888f` — falls back to step timestamps when endedAt is undefined
- L63 `405fb4a5` — returns em dash for zero-step runs without endedAt

### tests/unit/cli/logs-command.test.ts (9 cases)
- L132 `fe6cca1b` — resolves to the most recent run id from the registry
- L153 `24796647` — exits 2 with "No runs found" when --latest finds nothing
- L167 `2a3215e7` — rejects --latest combined with a positional runId as mutually exclusive
- L187 `b700186a` — prints only the named step when --step is an exact match
- L229 `4fa8922a` — exits 2 and lists valid step names when --step has no exact match
- L252 `19008668` — exits 2 with a hint pointing at --step when --follow is missing --step
- L268 `078f8146` — prints the full transcript and exits 0 without tailing when the run is already completed
- L284 `e5aa27ad` — prints the full transcript and exits 0 without tailing when the run has crashed
- L300 `71bb3eed` — tails an in-progress run and exits 0 once the run reaches a terminal status

### tests/unit/cli/run-codegen-prepass.test.ts (5 cases)
- L93 `b320c09c` — silently skips when orch.config.ts is missing (ConfigLoadError)
- L106 `999a1240` — emits the "Generated N sidecar(s)" line on a cold tree
- L127 `ead041f9` — suppresses the "Generated N sidecar(s)" line under ORCH_QUIET=1
- L148 `9f22ee99` — does not throw and emits no warning when there are no errors
- L167 `f272e890` — records a CodegenError on configDir when discoverPrompts throws

### tests/unit/cli/tail-lines.test.ts (3 cases)
- L31 `d7951083` — yields one line for each newline-terminated chunk written between ticks
- L51 `cef5a965` — holds a partial line across ticks until a newline arrives
- L71 `f4a6ddf3` — flushes a non-empty pending partial when abort fires before the trailing newline

### tests/unit/cli/types-command-watch.test.ts (3 cases)
- L108 `c24f708e` — regenerates sidecars when a prompt file changes
- L165 `92de8fa8` — does not re-run codegen on every poll tick when nothing has changed
- L224 `ffb08eca` — picks up a newly-created prompt file via the poll backstop

### tests/unit/cli/types-command.test.ts (5 cases)
- L105 `4f2e3bf7` — writes one sidecar per discovered prompt file
- L126 `163e0c64` — suppresses the summary on a clean idempotent repeat run
- L157 `688209fa` — exits non-zero when the config is missing
- L170 `bbb00b27` — emits NDJSON events when --format=json is set
- L201 `e4450645` — falls back to the documented defaults when prompts is omitted

### tests/unit/codegen/discover-prompts.test.ts (9 cases)
- L7 `48d04999` — passes a non-brace pattern through unchanged
- L11 `b9cb28d0` — expands a single brace group
- L15 `035162c2` — expands an embedded brace group
- L22 `b15c56c7` — cross-multiplies multiple brace groups
- L41 `f4368e68` — returns files matching a single include glob
- L53 `730c3854` — expands brace globs across .md and .txt
- L65 `a2386843` — filters out files matched by exclude
- L78 `f3cd0544` — returns paths sorted ASCII for stable downstream ordering
- L94 `ca646c0e` — returns an empty list when no files match

### tests/unit/codegen/emit-sidecar.test.ts (9 cases)
- L8 `208cdd0c` — produces a .d.ts targeted next to the source file
- L16 `79d861ce` — augments PromptFileRegistry under the `@/<relative>` key
- L27 `1aad5811` — emits required keys as `string | number | boolean`
- L35 `769b5d27` — emits optional keys with a trailing `?`
- L43 `fcc3408f` — emits both required and optional keys joined with `;`
- L53 `7582fe94` — emits `Record<string, never>` for a placeholder-free template
- L61 `211a10c1` — ends with `export {}` to make the sidecar a module
- L69 `d4d2358a` — starts with an AUTO-GENERATED comment header
- L77 `55377e90` — throws when the source path contains a newline (comment-injection guard)

### tests/unit/codegen/extract-placeholders.test.ts (12 cases)
- L6 `6ba51a09` — returns a single required placeholder
- L10 `24b89463` — returns a single optional placeholder
- L14 `7f54560f` — deduplicates repeated required placeholders
- L18 `3c0fd315` — deduplicates repeated optional placeholders
- L25 `f3d46930` — promotes a placeholder that appears as both required and optional to required
- L29 `e806626e` — tolerates whitespace inside the braces
- L33 `1114b012` — tolerates whitespace around the optional marker
- L38 `0752d535` — ignores `${legacy}` template-literal syntax
- L43 `7b09f770` — returns empty arrays for a template with no placeholders
- L47 `29bcc2c4` — handles a mixed required+optional template
- L54 `c6f8724d` — parity: shares the PLACEHOLDER_RE constant with runtime substitute()
- L60 `cce530a3` — extracts placeholders across multi-line prompts

### tests/unit/codegen/run-codegen.test.ts (7 cases)
- L13 `70d3b38a` — writes one sidecar per discovered prompt file
- L36 `ab7d784e` — skips files whose sidecar already matches on disk
- L54 `24cfa1a2` — rewrites a sidecar when the source file changes
- L75 `40a7faf9` — collects per-file errors without throwing
- L96 `a47e3e71` — emits the registry key relative to configDir
- L111 `e6241667` — returns an empty result when no sources match
- L125 `82614850` — does not re-discover its own .d.ts sidecars on the next pass

### tests/unit/config/load-config.test.ts (19 cases)
- L14 `bfc887c0` — returns the config unchanged as a typed identity function
- L33 `f09e5507` — resolves a relative workflow path against the config directory
- L39 `83db4282` — resolves a relative path without dot prefix against the config directory
- L45 `d470e18e` — keeps an absolute path as-is
- L51 `8b65b25b` — resolves relative entries against an isolated `.orch/` config directory
- L57 `d7e0124b` — throws on an unknown workflow name
- L61 `34f18fa3` — lists available workflows in the error message
- L71 `5837e466` — rejects a workflow path containing ".." traversal
- L79 `64975996` — shows (none) when config has an empty workflow map
- L97 `899c0069` — prefers `.orch/orch.config.ts` over a sibling root-level config
- L105 `bbdb072b` — falls back to root-level `orch.config.ts` when no `.orch/` is present
- L113 `952d59fe` — walks up to find a `.orch/orch.config.ts` in an ancestor directory
- L121 `dacadfda` — walks up to find a root-level `orch.config.ts` in an ancestor directory
- L129 `f8b4e9e9` — prefers a closer `.orch/orch.config.ts` over a more distant root-level one
- L137 `be781cab` — returns undefined when no config exists in any ancestor
- L151 `890dd230` — ConfigLoadError carries configPath
- L161 `5f72d852` — returns the documented defaults when prompts is omitted
- L167 `65d065d7` — returns explicit user config verbatim when prompts is set
- L179 `9e9e8413` — defaults cover the recommended on-disk layout

### tests/unit/core/ask.test.ts (26 cases)
- L5 `7c773565` — returns a frozen Step with kind ask
- L12 `ae5570d3` — prefixes the step name slug with "ask:"
- L18 `e29eee82` — preserves the question, fields, and buttons in config
- L32 `bf784a00` — omits defaultWhenNoninteractive from config when not provided
- L39 `ed3ba0e9` — preserves defaultWhenNoninteractive when provided
- L51 `e150c214` — rejects an empty name
- L55 `685d7cbf` — rejects a whitespace-only name
- L59 `d2620843` — rejects a name containing a null byte
- L63 `d9372fe5` — rejects a name containing a newline
- L67 `c3cffc9e` — rejects a name beginning with a dash
- L71 `bf44bac4` — rejects an all-punctuation name that slugifies to empty
- L75 `75048c40` — rejects an empty question
- L81 `4627e0c7` — rejects a whitespace-only question
- L85 `57da9d55` — rejects a question containing a null byte
- L89 `3ebaa4ee` — rejects an empty buttons array
- L93 `d9ef84bd` — rejects duplicate button labels
- L97 `8057525e` — rejects an empty button label
- L101 `c8c896bd` — rejects a button label containing a newline
- L105 `5e02d974` — rejects a field key starting with a digit
- L111 `d05e1a74` — rejects a field key containing a hyphen
- L117 `d003b7a1` — rejects a field key starting with an underscore
- L123 `41f83f67` — rejects a field key containing a dollar sign
- L129 `6a145fcf` — rejects a field key matching __proto__
- L136 `a1041578` — rejects a field key matching constructor
- L142 `5c15b964` — rejects a field key matching prototype
- L148 `fb079a58` — accepts a valid field key with letters, digits, and underscores

### tests/unit/core/command.test.ts (38 cases)
- L16 `9685e844` — rejects an empty step name
- L20 `7d9de351` — rejects a whitespace-only step name
- L24 `723f3faf` — rejects a step name that begins with the reserved "command:" prefix
- L30 `3ff615da` — rejects a name that slugifies to more than 120 characters
- L37 `c7645ace` — accepts a name that slugifies to exactly 120 characters
- L45 `2001b378` — rejects a name that slugifies to empty (all punctuation)
- L49 `d13266a5` — derives the step name as "command:<slug>" from the input name
- L55 `0478133e` — strips leading/trailing non-alphanumeric characters from the slug
- L61 `4abb75d9` — lowercases the slug
- L69 `d4bf0ed7` — rejects argv that is empty
- L73 `c02454a5` — rejects argv whose first element is the empty string
- L77 `929dedb8` — rejects argv whose first element contains a null byte
- L81 `188caf02` — rejects argv whose first element contains a newline
- L85 `3589d59f` — rejects subsequent argv elements containing a null byte
- L91 `27e61bee` — rejects an unknown onFailure value
- L101 `4bd0399b` — requires onFailure — undefined throws
- L111 `001dffed` — accepts onFailure: 'halt'
- L118 `8eb8ea4b` — accepts onFailure: 'continue'
- L127 `81049649` — rejects env values containing null bytes
- L133 `b282e813` — rejects env values containing newlines
- L141 `7fda5dcd` — returns a frozen Step
- L147 `c029505f` — produces config.kind === "command"
- L153 `67e7d493` — preserves argv verbatim in config
- L166 `6089200f` — accepts a well-formed CommandResult
- L177 `92112428` — rejects a CommandResult with a non-integer exitCode
- L188 `c67b7d49` — rejects a CommandResult with a negative durationMs
- L199 `68c69d62` — rejects a CommandResult with a non-string stdout
- L216 `47027332` — succeeds for a well-formed cached value
- L228 `0f637058` — throws for a malformed cached value
- L238 `06bab463` — does not re-execute the command (no side effects)
- L256 `87499fcf` — returns the entire string when n exceeds the line count
- L260 `34c65fef` — returns the empty string when n is 0
- L264 `af66838e` — returns the empty string when n is negative
- L268 `6fe3ebd6` — preserves a trailing newline
- L272 `e5a9e38f` — omits a trailing newline when the input had none
- L276 `2fcacec5` — handles a string with no newlines
- L280 `d1c88e8a` — handles an empty string
- L284 `c530f190` — handles CRLF line endings (preserves \r inside retained lines)

### tests/unit/core/commit.test.ts (13 cases)
- L5 `72012056` — derives step name from message: after research becomes commit:after-research
- L11 `25be1a96` — config has kind commit
- L17 `d888f8b3` — preserves the original message in config
- L24 `c9974802` — returns a frozen Step object
- L30 `006321f0` — throws for an empty message
- L34 `0da98e95` — throws for a whitespace-only message
- L38 `539c3643` — throws for all-punctuation message that slugifies to empty
- L42 `54b580f4` — throws for a message containing null bytes
- L46 `c0c6c904` — throws for a message containing newlines
- L50 `0dbfde14` — accepts a message that slugifies to exactly 505 chars
- L60 `e24e7216` — throws for a message whose slug exceeds 505 chars
- L66 `771a83d3` — strips leading and trailing non-alphanumeric characters from the slug
- L72 `c06a4ee6` — lowercases the message in the slug

### tests/unit/core/derive-step-key.test.ts (8 cases)
- L11 `ae75ee15` — returns the bare name when subPath is empty and no overrides
- L15 `3f328103` — returns the bare name when subPath is empty (explicit empty array)
- L19 `80abfc5b` — prepends the single sub-path segment as a `>`-joined prefix
- L25 `d076c6a8` — joins multiple sub-path segments with `>` and ends in the step name
- L29 `08e9c545` — lets `as:` override bypass sub-folding entirely (legacy flat key)
- L34 `9118be64` — appends the vars-hash suffix AFTER the sub-path prefix
- L41 `b6c5a213` — omits the vars suffix when vars is empty even inside a sub
- L45 `f0757c0e` — keys two same-named steps in different subs to different cache keys

### tests/unit/core/errors.test.ts (12 cases)
- L13 `fc7b2985` — carries the step name and a hoist-above-or-fan-in remediation
- L25 `809bc608` — names the step and runner and points at the supporting runners
- L40 `25761436` — synthesizes the suggested defaultWhenNoninteractive from the actual config
- L59 `0212c2e7` — omits the field hint when there are no fields
- L75 `c11ba752` — includes the colliding step name and both sub-paths in its message
- L92 `01df3a3d` — renders <root> when a sub-path is empty
- L99 `dcebcb8b` — emits the same-invocation hint when both sub-paths are equal
- L106 `ad74b893` — emits the different-scope hint when sub-paths differ
- L112 `136c2a89` — has a name that survives cross-realm instanceof via .name sentinel
- L120 `5516860e` — includes the depth, max, and chain in its message
- L134 `86c9401e` — renders <root> when the chain is empty
- L140 `c1d6cd46` — has a name that survives cross-realm instanceof via .name sentinel

### tests/unit/core/execution-context.test.ts (18 cases)
- L18 `05d3bf80` — returns the fallback when no store is active
- L22 `596cc166` — returns the fallback when workflowCwd is undefined inside an active store
- L32 `7f85d4f9` — returns workflowCwd when set inside the store
- L44 `1dabe073` — mutates the active store and persists across awaits inside the same scope
- L59 `16a27b8a` — throws when called outside an active executionContext scope
- L65 `2fc69413` — does not leak workflowCwd from one homogeneous parallel branch to a sibling
- L89 `e12da3e3` — throws when called inside a heterogeneous parallel branch (hard guard)
- L112 `17de2755` — parallel branches inherit the outer workflowCwd at branch start
- L126 `a15f48da` — returns 0 outside any ALS scope
- L130 `037a1cbe` — returns 0 inside an ALS scope that does not set the field
- L138 `02795b01` — returns the field when the ALS scope sets it
- L148 `16d961be` — returns the empty array outside any ALS scope
- L152 `efb21a1e` — returns the empty array inside an ALS scope that does not set the field
- L160 `fbf63693` — returns the chain when the ALS scope sets it
- L170 `ac456530` — returns false outside any ALS scope
- L174 `ecb94b0f` — returns false at the workflow root (parallelDepth = 0, no insideParallel)
- L182 `96752d43` — returns true when parallelDepth > 0 even if insideParallel is not yet set
- L191 `c898f921` — returns true when insideParallel is set (descendant of sub-of-sub-inside-parallel)

### tests/unit/core/failure-summary.test.ts (8 cases)
- L14 `26019b57` — carries the step name, runId, and failedAt through verbatim
- L27 `23e08daa` — extracts the Error.message as the summary errorMessage
- L38 `c4dca358` — passes through a string error as the errorMessage
- L50 `40c2cc97` — falls back to JSON.stringify for object errors
- L61 `98077b86` — drops the first line of Error.stack (the duplicate name/message line)
- L80 `1a7fd933` — builds the Story 1.5 resume + logs hints from the runId
- L92 `19314b07` — carries downstream step names when supplied
- L104 `8a0c200d` — defaults downstream to an empty list when omitted

### tests/unit/core/interactive-mode.test.ts (11 cases)
- L86 `d1e654ca` — resolves to interactive when step config has mode interactive
- L110 `66b6630c` — resolves to interactive when override mode is interactive
- L134 `7c955f47` — resolves to autonomous when neither config nor override specifies mode
- L152 `aeefc90e` — throws InteractiveParallelError when interactive step runs inside parallel context
- L186 `8d9cbba3` — throws RunnerCapabilityError when runner does not support interactive
- L212 `9ff354c0` — throws StepError when interactive session exits non-zero
- L242 `f627fedd` — caches a completed interactive step and skips it on resume
- L311 `b98a55f2` — emits step:start and step:complete for a successful interactive step
- L337 `04be465a` — emits step:cached when a step is served from cache
- L373 `37a076a0` — returns 0 when outside any parallel context
- L377 `7b215961` — returns the depth set by executionContext.run

### tests/unit/core/parallel-inherits-subworkflow-fields.test.ts (7 cases)
- L22 `6129863d` — propagates runFnRef into every branch so runWorkflow inside the branch can read it
- L42 `2e0a671d` — propagates subworkflowPath so sibling branches share the same prefix at branch entry
- L61 `7f3584a6` — propagates subCallId so branch-local steps belong to the enclosing sub invocation
- L82 `e1ef4613` — propagates subworkflowDepth so nested runWorkflow inside a branch starts from the parent depth
- L101 `7eb725e0` — always marks insideParallel: true on the branch store
- L114 `a2f0857c` — propagates maxSubworkflowDepth so the depth guard reads the parent snapshot
- L133 `cf1edb59` — does not leak a sub-frame mutation across sibling branches

### tests/unit/core/parallel.test.ts (26 cases)
- L23 `e4e687d4` — two promises return values in order
- L30 `59fad059` — single-element tuple returns one value
- L36 `03314b64` — empty array returns empty array
- L42 `de3e9eb6` — one failure produces ParallelError with settled in order
- L62 `f7081af6` — all failures produce ParallelError
- L75 `f3df0e16` — settled array has both ok and error entries in input order
- L95 `f4af1e55` — maps callback and returns results in order
- L101 `122079f3` — single item returns single-element array
- L107 `09e33860` — empty array returns empty array
- L113 `eeee6380` — one mapped branch failure produces ParallelError
- L132 `70815f47` — sync throw from callback is captured by settle-all
- L155 `d2db75c6` — concurrency cap is never exceeded
- L175 `940709d4` — concurrency 1 runs sequentially
- L191 `d60c056b` — concurrency greater than or equal to items runs all concurrently
- L210 `7b4a938f` — queued items continue after a branch fails
- L234 `2d110619` — Infinity concurrency runs all items concurrently
- L259 `b1bfc6f3` — concurrency 0 throws RangeError
- L263 `d7be338a` — negative concurrency throws RangeError
- L267 `50f369a5` — non-integer concurrency throws RangeError
- L277 `c6c2c021` — inner ParallelError appears in outer settled array
- L305 `406e8c67` — AwaitedTuple resolves [Promise<string>, Promise<number>] to [string, number]
- L309 `868b61ac` — AwaitedTuple resolves empty tuple to []
- L313 `38c29f9c` — homogeneous return is T[]
- L327 `0b4c4f7d` — message includes failure count
- L338 `b9801a8a` — settled array is accessible and readonly
- L345 `b6986caa` — name is ParallelError

### tests/unit/core/prompt-file/cache-key.test.ts (18 cases)
- L5 `0bc8c8d4` — returns empty string for empty vars (sentinel for no participation in key)
- L9 `7820ba63` — returns a stable 16-char hex string for a populated vars object
- L16 `9dff88cc` — snapshots the hash for { topic: "A" } so future regressions surface
- L21 `3232aed2` — produces identical output across two calls with the same vars
- L25 `526a7cbd` — AE3: produces identical output regardless of key insertion order
- L29 `f0d96398` — produces distinct outputs for distinct values
- L33 `590da8d5` — produces identical outputs for numerically-equal numbers (42 vs 42.0)
- L37 `16fef107` — distinguishes booleans from string-truthy ("true" vs true)
- L41 `886cd5bb` — correctly escapes embedded quotes in string values (JSON.stringify behavior)
- L48 `957d8189` — does not crash on NaN input and produces a stable value
- L56 `0f6185dd` — emits only hex characters across a fuzz of inputs (fits STEP_NAME_PATTERN)
- L77 `161b558f` — emits keys in ASCII-sorted order, no whitespace, no surrounding spaces
- L81 `63c14409` — stringifies numbers via String() (no quotes)
- L85 `981d104c` — stringifies booleans without quotes
- L89 `97e10099` — escapes embedded quotes via JSON.stringify in string values
- L93 `6ae1f8f8` — omits keys whose value is undefined (optional-var omission semantics)
- L99 `c027c634` — returns "{}" for an empty object
- L103 `9c52cc67` — treats NaN as the literal "NaN" rather than throwing

### tests/unit/core/prompt-file/caller-dir.test.ts (9 cases)
- L10 `747b94a5` — returns the directory of the test file itself when called directly
- L26 `0c2be15e` — returns the dir of the frame immediately after the named skip frame
- L38 `d45b84d0` — walks past multiple internal frames to reach the defineStep caller
- L51 `0e366f13` — parses Node-style stack with bare absolute path frames after the skip
- L61 `56907793` — matches dotted function names by their trailing token
- L72 `02d734dd` — returns undefined when no frame matches skipName
- L79 `0d02beff` — returns undefined when the skip frame is the last frame
- L85 `73c598e6` — returns undefined for an empty stack
- L91 `0fa6d9ca` — throws PromptFileError(cause:read-failed) when the stack has no parseable frames

### tests/unit/core/prompt-file/load-prompt.test.ts (9 cases)
- L20 `c22cac6e` — reads a workflow-local file and substitutes vars
- L31 `027a3cef` — AE5: resolves the @/ sentinel against the project root
- L42 `6096ec10` — AE5: composing two fragments produces the substituted concatenation
- L56 `c173cf9e` — throws read-failed when the file is not in the reader
- L73 `3b002182` — propagates missing-placeholder from substitute
- L90 `0835ac53` — rejects a traversal path before any file read
- L104 `5aa67f01` — rejects unsupported vars types at the call site
- L118 `f5dc9bef` — throws PromptFileError(cause: "empty-prompt") when the file is empty
- L141 `5179ca17` — does not share state between calls

### tests/unit/core/prompt-file/resolve-prompt-path.test.ts (11 cases)
- L13 `1e04c4d2` — resolves a workflow-local relative path against callerDir
- L19 `de25c71e` — resolves a nested workflow-local path
- L25 `accd5adf` — resolves the @/ sentinel against the project root
- L31 `18c54af3` — AE4: same @/ fragment resolves identically from two different workflow dirs
- L39 `d4a671f4` — rejects a path that escapes the project root via ..
- L52 `f5fc327c` — rejects an @/ path that escapes the project root
- L64 `de4245fb` — rejects an empty input
- L68 `5ba0aac3` — accepts a path equal to the project root edge case (resolved == root)
- L93 `b4ceda76` — rejects a symlink whose target sits outside the project root
- L108 `ce8c9167` — accepts a symlink whose target sits inside the project root
- L119 `236890ee` — falls back to the lexical check for non-existent paths

### tests/unit/core/prompt-file/step-define-prompt-file.test.ts (12 cases)
- L30 `6927c67b` — stores the raw, unsubstituted file contents in the prompt field
- L44 `a5c43ef6` — does not retain `vars` on the resolved config
- L56 `b981283e` — AE2 / R3: rejects both `prompt` and `promptFile` set together
- L71 `91f0da33` — returns the raw file content when no placeholders are present
- L84 `4b1a2cdd` — AE4: resolves the @/ sentinel to the project root
- L101 `ced1e084` — R7: rejects a traversal path
- L114 `99b3aca8` — produces a frozen step (preserves existing behavior)
- L128 `765f7dab` — accepts promptFile on the interactive overload and stores the raw template
- L146 `0b5ca270` — rejects an interactive step with `returns:` (existing rule unchanged by new fields)
- L165 `51a537bd` — throws PromptFileError with cause "vars-on-define" when vars is set with promptFile
- L192 `78871aee` — throws cause "vars-on-define" even when promptFile is absent
- L207 `a1824afe` — error message points the user at the migration recipe

### tests/unit/core/prompt-file/substitute.test.ts (26 cases)
- L6 `8ae2058c` — AE1: substitutes a single named placeholder
- L10 `9b957836` — tolerates whitespace inside the braces
- L14 `89e71f31` — stringifies a number value via String()
- L18 `f2a64487` — stringifies a boolean value as lowercase
- L22 `58df5ae8` — substitutes the same placeholder used multiple times
- L26 `fc7ea34c` — substitutes multiple distinct placeholders
- L31 `436e578e` — treats `${var}` as literal — orch does NOT use template-literal syntax
- L39 `7f3fe354` — leaves text with spaces between braces unchanged
- L45 `75dc30c5` — leaves an invalid identifier inside braces unchanged (no dot syntax)
- L51 `fda97ec9` — AE3: missing-placeholder error names BOTH the placeholder and the supplied key
- L66 `56be3349` — throws extra-key when vars supplies an unused key
- L79 `25fd0b75` — throws extra-key when vars supplies a strict superset of placeholders
- L83 `9571e222` — throws missing-placeholder when the template uses a placeholder with no vars supplied
- L97 `6fcb001d` — AE6: rejects an array value and suggests loadPrompt
- L113 `85a5b59d` — rejects a null value
- L117 `004c5102` — rejects an undefined value
- L121 `d1553ab5` — rejects a nested plain object
- L125 `9118c638` — rejects a top-level array
- L129 `5378f965` — accepts a mix of strings, numbers, and booleans
- L135 `39177f87` — substitutes the value when an optional key is supplied
- L139 `584dcfb3` — substitutes empty string when an optional placeholder has no matching key
- L143 `06543331` — tolerates whitespace around the optional marker (inside braces)
- L147 `f3188542` — tolerates whitespace between the identifier and the optional marker
- L151 `3fb057a3` — substitutes a required placeholder alongside an unsupplied optional
- L155 `a78c2a5b` — still throws missing-placeholder for the required key only — optionals never appear
- L168 `21f140ed` — throws extra-key when a key is supplied that the template does not reference

### tests/unit/core/resume-registry.test.ts (6 cases)
- L21 `9f837d19` — returns an empty registry from createResumeRegistry()
- L27 `345d4267` — register then getRunnerForStep returns the registered runner
- L36 `65798745` — returns undefined for a step never registered
- L43 `5c20b2ee` — keeps the most recent runner when registered twice for the same stepName (last-write-wins)
- L54 `90453208` — resolves two distinct same-named runner instances by their step names (F6 regression)
- L67 `2ba6347e` — a workflow that registers steps A, B, C produces a registry where all three resolve

### tests/unit/core/run-mode-tty-guard.test.ts (3 cases)
- L10 `1a9c2237` — two-pane with no TTY and no allowHeadless returns an explicit RunModeError
- L28 `eb4c7c11` — two-pane with no TTY but allowHeadlessTwoPane=true resolves to two-pane via flag
- L41 `abebb682` — two-pane with a TTY is unaffected by allowHeadlessTwoPane

### tests/unit/core/run-mode.test.ts (17 cases)
- L11 `2b7101ff` — prefers the explicit flag when supplied
- L24 `cd3eed96` — falls to plain when CI=true and no flag is given
- L35 `a7966cc4` — picks two-pane when TTY present and tmux ≥ 3.2
- L47 `e22c67c6` — falls to plain when tmux version is too old
- L59 `b03e4556` — falls to plain when TTY present but tmux missing
- L70 `b61add8e` — falls to plain when no TTY is attached
- L82 `d9c859f2` — never auto-selects single-pane
- L97 `4cebcabf` — throws with the deferral message for explicit --mode=single-pane
- L109 `f6a3a887` — throws on explicit --mode=two-pane when tmux is missing
- L126 `12fea9c7` — throws on explicit --mode=two-pane when tmux is too old
- L145 `009a0335` — accepts known modes
- L151 `02387d47` — rejects unknown strings
- L158 `edb28953` — returns true for CI=true
- L162 `781b7345` — returns false for CI=false (some test runners set this)
- L166 `461294c7` — returns true for GitHub Actions
- L170 `174e939b` — returns true for GitLab CI
- L174 `b5845c81` — returns false for an empty env

### tests/unit/core/run-step-once-collision.test.ts (6 cases)
- L70 `5e10fc8d` — keys a step run inside a sub under `<sub>>name` when the ALS frame carries a subPath
- L98 `0126553c` — keeps two same-named steps in different subs as distinct cache entries
- L136 `49fcb90c` — throws StepNameCollisionError when the same sub-path is entered twice with different subCallIds
- L182 `a4366075` — does NOT throw on a second call with the SAME subCallId (legitimate cache replay)
- L208 `b2a9babb` — records `insideParallel: true` on the entry when the ALS frame is inside a parallel branch
- L231 `d0b78f79` — omits subPath/subCallId/insideParallel from root-frame entries (back-compat)

### tests/unit/core/run-workflow.test.ts (12 cases)
- L135 `5f7e7411` — throws when called outside any active workflow execution
- L144 `87fd85aa` — emits subworkflow:enter before sub steps, subworkflow:exit after, both with depth 1
- L166 `588059ae` — nested runWorkflow reports depth 2 on its enter event
- L189 `17df9053` — sub error propagates as a 'failed' parent classification and emits subworkflow:exit with outcome failed
- L207 `813988ed` — throws SubworkflowDepthError at the bound (default 8)
- L227 `9deb2f1d` — respects a per-execution maxSubworkflowDepth override
- L243 `8c835fa1` — passes the typed args object into the sub body
- L266 `1861e473` — two sibling runWorkflow calls inside a homogeneous parallel block report depth 1 and insideParallel
- L297 `ba6169ce` — host throw on subworkflow:enter propagates, logs host-error and failed exit, and the sub body does NOT run
- L345 `10503900` — host throw on subworkflow:exit is suppressed and emitted as a typed host-error event
- L375 `6ae82bb2` — does not replay the first cached sub invocation for a second same-sub call after resume
- L403 `13a5e0c8` — claims a same-sub key before async persistence so parallel duplicate sub calls collide

### tests/unit/core/runner-addressing.test.ts (6 cases)
- L91 `3353f4b7` — exposes the derived key, run state dir, and parent pid to buildCommand
- L107 `f67b2498` — surfaces the flat `as:` label as the step key (bypassing sub-folding)
- L119 `1e1d29fa` — surfaces the sub-path-folded key for a step inside a subworkflow
- L134 `282f5fe4` — surfaces the vars-hash suffix for a vars-bearing step
- L148 `af519e6d` — exposes the same addressing values, identical in shape to the autonomous path
- L166 `063a3492` — claude builds identical argv with and without the addressing env present

### tests/unit/core/schema-validation.test.ts (11 cases)
- L83 `ed99e62b` — step with returns on a runner that does not support structured output throws at step start
- L108 `1c1d7506` — step with returns on a capable runner does not throw
- L126 `c0440658` — step without returns does not Zod-validate and returns raw value
- L143 `352d3a2d` — valid structured output is Zod-parsed and returned
- L161 `73a74451` — invalid structured output throws SchemaValidationError with Zod path
- L188 `c2ca1710` — undefined structured_output with schema present throws clear error before Zod parse
- L216 `34f151fb` — null structured_output with schema present reaches Zod parse and produces actionable error
- L240 `5e2b592b` — z.transform schema applies transform after CLI extraction
- L258 `bf79506e` — validators receive post-transform value in ctx.value
- L285 `d3783d79` — re-validates cached value when schema is present
- L356 `51086e38` — end-to-end: define step with schema, script FakeRunner, run, destructure typed result

### tests/unit/core/schema.test.ts (20 cases)
- L15 `dd2e6fbb` — produces a SchemaWrapper with valid JSON Schema string for z.object
- L26 `4dc25189` — returns a frozen wrapper
- L32 `2b907730` — produces stable jsonSchema string across reads
- L38 `4e36ed80` — does not include $schema key in JSON Schema output
- L45 `068f390e` — uses inline definitions with no $ref pointers
- L52 `429f9d3d` — produces correct JSON Schema for z.array
- L60 `e9cebce0` — produces correct JSON Schema for z.string
- L67 `39a30870` — produces correct JSON Schema for z.number
- L74 `521fa1c9` — produces correct JSON Schema for z.boolean
- L81 `14bc19cc` — produces correct JSON Schema for z.enum
- L89 `3116f7ca` — produces correct JSON Schema for z.optional
- L97 `c7126f85` — produces correct JSON Schema for z.nullable
- L120 `8487e48d` — throws when the converter returns no usable shape (simulating a Zod v4 schema)
- L129 `5f250645` — error message names the failure mode and points at the fix
- L149 `ac52d06e` — does NOT throw for any normal v3 zod schema
- L191 `d3faa3eb` — step with returns: schema(z.object) infers Step<{ a: string }>
- L198 `ce951833` — step without returns infers Step<unknown>
- L204 `1409a8a7` — step with returns: schema(z.string()) infers Step<string>
- L213 `92c2f19b` — message includes step name and Zod path details
- L228 `856057b7` — instanceof works cross-transpile via Object.setPrototypeOf

### tests/unit/core/session-id-capture.test.ts (4 cases)
- L69 `cecb735d` — writes StepEntry.sessionId for an interactive step whose runner declares resumeCommand
- L83 `b5f11a7a` — omits StepEntry.sessionId when the interactive runner has no resumeCommand
- L98 `699b19b0` — omits StepEntry.sessionId for autonomous steps (resume only applies to interactive)
- L114 `0650dfa1` — routes the generated sessionId into the runner via ctx.sessionId for interactive steps

### tests/unit/core/step-lifecycle.test.ts (6 cases)
- L55 `a28b114f` — emits step:start then step:complete with the wall-clock duration when the body resolves
- L71 `44752fd0` — reports the stamped duration instead of wall-clock when the body stamps the timer
- L85 `9d2fb0df` — emits step:start then step:failed carrying the thrown error and rethrows it when the body throws
- L101 `00eb5ec5` — wraps a tracked parallel step with running and completed branch-updates around the trio
- L125 `56a912f2` — emits a failed branch-update with the elapsed time when a tracked parallel step throws
- L146 `149fc0f7` — omits all branch-updates when trackParallel is false even inside parallel()

### tests/unit/core/step.test.ts (34 cases)
- L15 `feaae16b` — returns a frozen Step with the given name and config
- L26 `43c3f935` — produces config with kind agent
- L38 `ab1fe6f3` — validates the name as a StepName
- L46 `bf5c8654` — throws for an empty name
- L52 `e46d2bf6` — throws for a name with uppercase letters
- L58 `2b815195` — throws for a name with slashes
- L64 `689fad61` — rejects names starting with the reserved commit: prefix
- L70 `9770823d` — rejects names starting with the reserved worktree: prefix
- L76 `67fac6bb` — rejects names starting with the reserved ask: prefix and points to ask()
- L82 `d85d829b` — rejects reserved prefix %s (table-driven)
- L92 `e2d48ce1` — defaults mode to undefined when not specified
- L103 `d3b48a80` — accepts mode interactive and produces a Step
- L114 `2772f554` — accepts mode autonomous explicitly
- L125 `14c4d0ee` — throws at runtime when interactive mode is combined with returns
- L140 `02ba83fa` — carries autoStop:true on an interactive step config
- L151 `8a6e5569` — leaves autoStop absent on an interactive step that does not set it
- L162 `d678254a` — throws at definition time when autoStop:true is set on an autonomous step
- L173 `79ac40d0` — accepts a step-level view override of transcript
- L184 `0b09b260` — accepts a step-level pane override of left
- L195 `1d65c1e5` — accepts silent:true on an otherwise-default step
- L206 `3e38b062` — rejects silent:true combined with view
- L214 `10ffd253` — rejects silent:true combined with pane
- L222 `7b6d3988` — rejects an unknown view kind and lists the accepted values
- L240 `efc0ea1e` — agent kind without returns is a no-op
- L247 `295f7747` — agent kind with returns re-validates the cached value against the schema
- L259 `5f5e2f84` — commit kind is a no-op regardless of cached value
- L268 `7e2d8580` — ask kind is a no-op on cache replay (validity is checked separately)
- L284 `a23eacec` — worktree kind with enter:true reapplies setWorkflowCwd from cached path
- L305 `0644d6e3` — worktree kind with enter:false leaves workflowCwd untouched
- L326 `76c6920f` — throws when cached worktree value is missing path
- L339 `d39eda21` — throws when cached worktree value has a non-string branch
- L352 `0991b38d` — throws when cached branch differs from the current config (slug collision)
- L376 `376c681d` — throws when cached fromRef differs from the current config
- L401 `8ead66e4` — accepts an exact-match cache hit (resume case)

### tests/unit/core/types-step-name-pattern.test.ts (11 cases)
- L11 `53bc5ba5` — accepts a single `>` mid-string (single-sub cache key)
- L15 `72637b7b` — accepts multiple `>` mid-string (nested-sub cache key)
- L19 `8ca87e14` — accepts the full sub-path + vars-hash shape
- L23 `7632e9f1` — still rejects `>` as the FIRST character
- L27 `d6f55650` — still rejects whitespace
- L31 `f734b4ec` — still rejects newlines
- L35 `e6b1a4ae` — still rejects uppercase characters
- L39 `699bcf75` — still rejects empty
- L45 `23497b96` — accepts a depth-8 chain with 15-char sub names plus a step and vars hash
- L56 `767ab7a2` — rejects a name over 512 chars
- L61 `7947dcef` — accepts a name exactly at the 512-char boundary

### tests/unit/core/types.test.ts (11 cases)
- L10 `15a6b715` — accepts a colon-separated name like commit:foo
- L16 `84a48b66` — accepts a name with multiple colon segments like a:b:c
- L22 `cd9576b0` — still accepts simple hyphenated names
- L28 `493837c9` — rejects names with uppercase letters
- L32 `e1e8d217` — rejects names starting with a colon
- L36 `394fafb2` — rejects empty strings
- L42 `abf6f4a7` — parses a valid InteractiveResult round-trip
- L54 `b6a4b97b` — rejects non-integer exitCode
- L64 `6dafce76` — rejects negative durationMs
- L74 `0a845e33` — rejects non-UUID sessionId
- L86 `d0be4354` — accepts interactive and autonomous as valid StepMode values

### tests/unit/core/view-registry.test.ts (8 cases)
- L18 `84143f7a` — returns silent when stepConfig.silent is true, bypassing mode checks
- L30 `97a188df` — uses the step-level view override over the runner default
- L42 `b5f5c38f` — falls back to the runner defaultView when the step has no override
- L55 `997e36ed` — falls back to the built-in default when the runner exposes no defaultView
- L68 `98d617e8` — forces interactive view when stepMode is interactive, overriding the runner default
- L80 `3e94d875` — throws ViewResolutionError for interactive view under --mode=plain
- L99 `06c55d61` — honors a step-level pane override even when the runner picks right
- L111 `51d35c97` — passes silent first even when view/pane would otherwise resolve

### tests/unit/core/workflow-args.test.ts (6 cases)
- L39 `32f3b845` — delivers args.prompt to the callback when supplied via deps.args
- L55 `752d58aa` — delivers an empty object when deps.args is omitted
- L71 `3cf49220` — preserves empty-string prompt as distinct from undefined
- L87 `2eb3bab4` — accepts a legacy single-parameter callback (async (run) => ...)
- L105 `77d38ed2` — persists args into state.json via initRun
- L120 `ed4fd053` — does not persist args when none were supplied

### tests/unit/core/workflow-auto-stop.test.ts (7 cases)
- L70 `bfe55cab` — throws AutoStopUnsupportedError before any host spawn when the runner lacks prepareAutoStop
- L93 `1a65d6d6` — calls prepareAutoStop once and passes autoStop:true to the host
- L107 `c1fd222f` — merges the env returned by prepareAutoStop into the spawn env handed to the host
- L121 `daacc67a` — cleans up the prepared auto-stop artifact after the interactive spawn
- L137 `2031ab56` — cleans up when the host spawn path throws before host-owned cleanup can run
- L156 `3b7644c3` — does not double-clean when the host also invokes the cleanup handle
- L174 `d9897588` — never calls prepareAutoStop and spawns as today when autoStop is absent

### tests/unit/core/workflow-name-validation.test.ts (12 cases)
- L10 `b44f7426` — accepts names matching the existing alphabet
- L16 `327c1d12` — rejects a name containing the sub-path separator `>`
- L20 `8d147e67` — rejects a name containing the vars-hash separator `:`
- L24 `8dbfa416` — rejects an empty name
- L28 `6c9222c1` — rejects a name starting with a hyphen
- L32 `8cf46e97` — rejects a name containing uppercase characters
- L36 `a3d4d799` — rejects a name containing whitespace
- L40 `1e7f0321` — quotes the offending name in the error message
- L46 `7024be75` — hides the symbol-keyed body from Object.keys
- L55 `e888a058` — hides the symbol-keyed body from for...in enumeration
- L63 `cbe098e0` — exposes the body to readers that hold the symbol
- L70 `4ced6273` — preserves the typed body identity across the executor wrapper

### tests/unit/core/workflow-parallel-lifecycle.test.ts (4 cases)
- L56 `a9e2b99a` — emits one step:parallel-start before the first branch and one step:parallel-complete after the last branch
- L95 `81c7efcb` — two sequential parallel blocks emit two pairs with distinct block ids
- L128 `2f32e4a9` — emits start/complete even when a parallel block has zero items
- L144 `14f3f3aa` — emits start/complete even when a branch throws (parallel still settles)

### tests/unit/core/workflow-resume-registry.test.ts (6 cases)
- L62 `e6b3125d` — writes StepEntry.runnerName for an interactive agent step
- L76 `2a6bab41` — omits StepEntry.runnerName for autonomous agent steps
- L92 `6a52a7ac` — registers the runner in the registry at the start of an interactive step
- L106 `3db574c9` — does NOT register autonomous agent steps in the registry
- L121 `dbbe7552` — registers a cache-hit interactive step on replay so resumed runs progressively populate the registry
- L143 `06729fe8` — a workflow with no resumeRegistry dep still executes (registry is optional)

### tests/unit/core/workflow-tmux-guards.test.ts (2 cases)
- L52 `3cc4671a` — fires host.onRunnerEvent for every parsed runner event in order
- L79 `2e56800a` — runs an autonomous step normally with a default host

### tests/unit/core/workflow-validators.test.ts (10 cases)
- L80 `759b385d` — captures preRunSnapshot.headSha before the runner is invoked when a validator needs it
- L107 `64df1fc2` — persists one PersistedValidation entry per passing validator
- L127 `6834d0c7` — does not persist a StepEntry and throws ValidationError when a single validator fails
- L154 `8f984c95` — runs every validator (no fail-fast) and aggregates all failures in order
- L181 `c48fa961` — normalizes thrown exceptions inside a validator into a failure with the error message
- L206 `b7536e16` — short-circuits with StepError before running any validator on a failing runner
- L234 `75415afb` — resume path: a cached step returns value without calling headSha and without re-running validators
- L276 `38ecdd03` — treats validate: single vs validate: array identically
- L300 `b82c933d` — does not call gitService.headSha when no validator declares needs: headSha
- L316 `beca85ad` — safeHeadSha returns undefined on a non-git cwd without crashing the workflow

### tests/unit/core/workflow-vars-cache-key.test.ts (11 cases)
- L84 `bc3b4c82` — AE3: distinct vars produce distinct cache entries inside the same run
- L109 `bb1c3228` — same vars on a second call hit the cache
- L123 `f8603b64` — uses overrides.as verbatim (no vars-hash appended) when as is set
- L138 `6f72d0b3` — no vars → cache key unchanged from today (back-compat)
- L155 `1b5b617e` — empty vars object also produces the unchanged cache key
- L172 `26cc78fe` — substitutes the template at run() time, not at step.define time
- L186 `65c40be7` — overrides.prompt bypasses substitution entirely (R10)
- L199 `571bf3aa` — throws missing-placeholder before runner starts when vars is empty but template has placeholders
- L220 `cc9f6971` — throws extra-key when caller passes vars but template has no placeholders
- L245 `36761438` — static prompt + no vars = no substitution (back-compat for shipped workflows)
- L258 `2afe410a` — combines substituted template with extraContext and extraPrompt

### tests/unit/core/workflow.test.ts (26 cases)
- L64 `10b171e5` — executes a step and returns its value via extractStructuredOutput
- L79 `3c17c839` — memoizes by step name — second invocation returns cached value without re-running
- L98 `519f8097` — uses overrides.as as the memoization key instead of step name
- L118 `b1321e4b` — overrides at call site do not change the memoization key when as is absent
- L137 `69995893` — assembles prompt from config default, overrides.prompt, extraContext, and extraPrompt
- L157 `87c7cc9d` — throws StepError when runner returns an error terminal event
- L179 `0528dac7` — sets status to completed on success
- L194 `345622cc` — sets status to failed on step failure
- L214 `62032787` — resume skips completed steps and re-runs the failed step
- L274 `aa48170c` — workflow throws StepError when the runner exits non-zero even after a turn-complete event
- L319 `df51fde6` — initRun persists empty running state before any steps
- L342 `c920bb9f` — forwards transcript lines from runner.toTranscriptLines to host.onRunnerEvent for autonomous steps
- L396 `198de864` — catches a thrown formatter, forwards an empty lines array, and lets the run complete
- L441 `a345a589` — does not invoke runner.toTranscriptLines for interactive steps
- L482 `22400f44` — commit step stages and commits when tree is dirty
- L496 `616446d7` — commit step returns null when tree is clean
- L509 `da04565f` — commit step is memoized on resume
- L548 `67249d41` — commit step uses overrides.as for memoization key
- L567 `507a8059` — commit step does not invoke any Runner
- L582 `e54356d5` — commit step throws when prompt override is provided
- L592 `fa289cae` — commit step throws when extraContext override is provided
- L602 `b774a065` — commit step throws when extraPrompt override is provided
- L612 `8fc3be9f` — commit step propagates GitCommandError from stageAll
- L627 `474def14` — commit step propagates GitCommandError from commit
- L650 `ebdf417d` — agent step reads currentCwd, defaulting to deps.cwd when no workflowCwd is set
- L686 `1df6ae19` — agent step honors a workflowCwd set by an earlier step in the same workflow

### tests/unit/core/worktree-executor-cache.test.ts (4 cases)
- L13 `61b3173e` — step is memoized — second invocation returns cached WorktreeResult without calling git
- L30 `2559233f` — cache hit with enter: true reapplies setWorkflowCwd before the next run() observes cwd
- L74 `3a24012e` — createWorktree throws when two different branches slug to the same step name within one workflow
- L100 `e1d98f36` — cache hit with enter: false does not mutate workflow cwd

### tests/unit/core/worktree-executor-conflicts.test.ts (6 cases)
- L8 `507e3d8f` — throws GitCommandError when branchExists returns true
- L30 `72797c64` — throws GitCommandError when worktreePathExists returns true
- L52 `5921dce3` — does not call git addWorktree when a conflict is detected (negative boundary)
- L74 `76ee84e4` — throws when prompt override is provided
- L96 `89cba051` — throws when extraContext override is provided
- L117 `2d4748ad` — throws when extraPrompt override is provided

### tests/unit/core/worktree-executor-postcreate.test.ts (7 cases)
- L14 `fc06ba0d` — runs each sugar line via /bin/sh -c with ORIGIN and TARGET in env
- L29 `5930df05` — runs sugar lines sequentially (second line waits for first to exit)
- L49 `5008d9ab` — aborts subsequent sugar lines on first non-zero exit and fails the step
- L71 `f19dc7ec` — callback receives origin, target, and exec (cwd defaults to target)
- L98 `fa065d71` — exec wrapper rejects with PostCreateExecError on non-zero exit
- L128 `6b98510e` — step fails when postCreate callback throws
- L153 `1d608439` — step does not call setWorkflowCwd when postCreate fails (cwd unchanged)

### tests/unit/core/worktree-executor.test.ts (8 cases)
- L15 `93248c4f` — creates a worktree at the sibling default and persists WorktreeResult to state.json
- L43 `b01343eb` — enter: true mutates the workflow cwd for subsequent run() calls
- L70 `14f758a7` — enter: false leaves the workflow cwd unchanged
- L97 `84f4f799` — from override drives git addWorktree fromRef argument
- L113 `c157082c` — target as an absolute path resolves the leaf inside that directory
- L129 `d615b2a0` — target as a relative path resolves the leaf relative to repoRoot
- L145 `94bb5500` — inside an active worktree (nested), createWorktree resolves repoRoot from currentCwd, not deps.cwd
- L171 `914e64cb` — does not invoke any Runner during createWorktree (negative boundary)

### tests/unit/core/worktree.test.ts (34 cases)
- L5 `4ff828e9` — derives step name from branch: feat/foo becomes worktree:feat-foo
- L11 `07b5aa10` — config carries kind worktree
- L17 `277540d7` — preserves the original (unsanitized) branch in config
- L24 `045aad80` — preserves enter, from, target, postCreate in config
- L40 `b04148cc` — returns a frozen Step object
- L46 `9fab08e5` — rejects missing enter at compile time and at runtime
- L51 `26388c8a` — throws for an empty branch
- L55 `63da7c07` — throws for a whitespace-only branch
- L59 `a11af423` — throws for a branch containing null bytes
- L63 `42d05b5d` — throws for a branch containing newlines
- L67 `68526576` — throws when branch begins with a dash
- L71 `a45ac6be` — throws when from begins with a dash
- L77 `606d38f8` — throws when from contains a null byte
- L81 `0bc515b1` — throws when from contains a newline character
- L85 `615fb2a1` — throws when target begins with a dash
- L89 `5f07b43a` — throws for an all-punctuation branch that sanitizes to empty
- L93 `88c5e49b` — accepts a branch sanitizing to exactly 119 chars (the 128 - "worktree:".length cap)
- L101 `708368fb` — accepts a branch sanitizing to exactly 1 char (lower boundary)
- L107 `16e6c638` — throws for a branch whose sanitized form exceeds 119 chars
- L113 `7175005e` — lowercases the branch when building the slug
- L119 `8055aa1e` — collapses slashes and other separators to single dashes
- L125 `ee9d5f25` — strips leading and trailing dashes from the slug
- L134 `a4c01591` — sanitizes branches with leading non-alpha chars to a clean slug (parity with commit())
- L140 `308a89f0` — sanitizes Unicode ligatures by lowercase-then-strip-non-ascii (parity with commit())
- L147 `d8d3fff7` — accepts postCreate as string array (sugar)
- L157 `07450a78` — accepts postCreate as async callback
- L165 `fead55c2` — accepts postCreate as an empty string array (no-op sugar)
- L172 `1f15af57` — throws when postCreate string array contains an empty string
- L178 `5030c71e` — throws when from is whitespace-only
- L182 `216c7a80` — throws when target contains null bytes
- L186 `4d5277a2` — throws when target contains newlines
- L192 `72bab964` — accepts the literal target "sibling"
- L199 `bfc7d6ec` — accepts target as a relative path
- L206 `cf78cb21` — accepts target as an absolute path

### tests/unit/helpers/behavioral-dsl/invariants.test.ts (20 cases)
- L45 `0f95c62c` — matches when orch exited with code 0
- L50 `6bb7913f` — matches when orch died via a documented signal (SIGINT)
- L55 `2d721939` — fails when orch is still alive
- L61 `d7f97949` — fails with the actual code in the message for an undocumented non-zero exit
- L69 `757eebc4` — matches when both tmux server and session are gone
- L73 `6e797f90` — fails when the tmux server is still up
- L81 `fffbfcf7` — matches when enters===exits AND ons===offs
- L92 `03a09660` — fails with both pair counts in the error message when unbalanced
- L108 `5b3f5933` — matches when no orphans were swept
- L112 `96921c54` — fails with the orphan list in the message
- L125 `e1680360` — matches when every per-step file is intact
- L132 `0f4d1656` — fails with the names of truncated steps
- L142 `c0a7560a` — returns a polling budget for the given timeout
- L146 `e33910b2` — rejects non-positive values
- L153 `9395b1ec` — returns an empty violation list when every matcher passes
- L158 `83351f7a` — names each unsatisfied matcher in the violation list
- L172 `104550b9` — evaluates the pane-q-during-run contract row with exitedNormally + tmuxIsTornDown
- L193 `2204a37e` — returns no violations for pane-q-during-run when orch has cleanly torn down
- L208 `00e8ccf5` — throws on an unknown scenario tag (programming error)
- L214 `4bde8d58` — honors hasStatus("cancelled") as a workflow matcher when matched in isolation

### tests/unit/helpers/behavioral-dsl/pane-matchers.test.ts (22 cases)
- L52 `f181205d` — matches when the literal substring appears in the bound pane
- L57 `26274e6e` — does not match when the substring is missing
- L62 `ba13f513` — matches a RegExp needle
- L67 `f37d0fad` — binds to the right pane when the factory is called with "right"
- L75 `7256d6ca` — matches when the needle is absent
- L80 `ff6c20df` — surfaces the offending text on failure
- L89 `8e3480d4` — matches when the bound pane is focused
- L94 `398e3ad5` — does not match when the bound pane is unfocused
- L100 `eeaa0d1f` — matches the "live" banner pattern in the pane text
- L106 `1ef01af1` — does not match when the pattern is absent
- L112 `f4324f58` — matches the "error-banner" pattern for failure summaries
- L121 `67e613b6` — matches when the needle appears in the last few lines of the pane
- L126 `62247835` — does not match when the needle is in the top half but not the footer
- L135 `3397528a` — matches when the pane text is empty / whitespace only
- L139 `06f51208` — does not match when the pane has any content
- L145 `34e1495f` — matches when the bound pane reports pane_dead=1
- L158 `96935c43` — isRunningStep matches when stateStatus=running and the step entry is unfinalized
- L166 `f99761c5` — isRunningStep does not match when the step has completed
- L174 `edc3777d` — hasStatus matches the snapshot stateStatus
- L179 `84dfcf0c` — hasStepStatus matches per-step state
- L185 `9283ae2a` — hasExitCode matches a known exit code
- L191 `4c016289` — hasExitedBySignal matches the latched signal

### tests/unit/helpers/behavioral-dsl/snapshot.test.ts (15 cases)
- L112 `d2bb0703` — reports tmuxServerExists=false and an empty pane state when the probe says the server is down
- L124 `b28909f3` — captures pane text and focus from the probe when the session is up
- L142 `fb1843b4` — reports orchAlive=true when the wait() promise has not yet resolved
- L152 `60c79b8d` — latches orchExit with code and inferred signal when wait() resolves
- L164 `a332bfea` — reads stateStatus and stepStatuses from state.json under stateDir
- L182 `9540efd4` — reports stateStatus=unknown when state.json is missing
- L192 `8e33694e` — flags perStepFilesIntact=false when a formatted_output file lacks a trailing newline
- L226 `4cac1178` — reports perStepFilesIntact=true for steps with no on-disk file yet
- L243 `ee43ba13` — counts cumulative alt-screen and mouse-tracking escapes from stdout bytes
- L263 `66b295d0` — returns an empty orphanChildren list when orchPid is omitted
- L272 `79ed08ab` — sweeps grandchildren (not direct children) of orch via recursive pgrep
- L296 `2eb61b92` — stamps capturedAtMs and orchAliveDurationMs derived from the supplied clock
- L317 `ac9499ec` — returns zero counts for an empty buffer
- L322 `583d9c15` — counts each escape sequence exactly once even when adjacent to other bytes
- L327 `401dab5f` — treats \x1b[?1000h and \x1b[?1003h as equivalent mouse-on markers

### tests/unit/hosts/await-foreground-shutdown.test.ts (3 cases)
- L37 `5af42861` — resolves immediately under plain mode (no foreground UI to wait on)
- L58 `c8b53ba6` — resolves under two-pane when attachForeground exits
- L91 `1ed10b94` — resolves under two-pane when a quit intent fires (before attachForeground returns)

### tests/unit/hosts/failure-text.test.ts (5 cases)
- L14 `70511eae` — leads with the failed step headline and error message
- L28 `9efb00b0` — includes the stack trace when the error is an Error with a stack
- L39 `872e73fe` — omits the stack block for string errors
- L47 `df5a05ed` — lists downstream steps when present
- L61 `d12a9611` — ends with the resume + logs hints using the provided runId

### tests/unit/hosts/host-registry.test.ts (7 cases)
- L51 `2d173a7c` — accepts a `stateStore` field — required by the two-pane right-pane controller
- L72 `6f19629e` — accepts a `transcriptRenderer` field — required for formatted ⏎ inspect on completed steps
- L90 `dcdcffb9` — accepts a `resumeRegistry` field — same live reference the workflow executor receives
- L164 `5a54f95e` — passes the env socket into createTmuxHost when ORCH_TMUX_SOCKET is set
- L170 `297a27db` — derives orch-${runId} when ORCH_TMUX_SOCKET is unset (production default)
- L176 `8b781e68` — derives orch-${runId} when ORCH_TMUX_SOCKET is empty
- L182 `65fead51` — throws at the socketName smart constructor for a malformed ORCH_TMUX_SOCKET

### tests/unit/hosts/pane-queue.test.ts (4 cases)
- L6 `37c58bb5` — preserves submission order for a single pane even when ops resolve out of order
- L25 `19d42814` — keeps separate panes independent — ordering within a pane, concurrent across panes
- L49 `be377858` — continues the chain after a rejection so a failing send does not block respawn-pane
- L66 `4e53e1ed` — drain() waits for every pending op across every pane

### tests/unit/hosts/parallel-rollup.test.ts (7 cases)
- L12 `8972d816` — starts with no branches and runningCount 0
- L18 `8ee23a37` — tracks a branch going running → completed and preserves insertion order
- L34 `9e76354a` — carries toolCount through subsequent updates when the later update omits it
- L44 `10e65bce` — reset() clears all branches
- L55 `78d1e97b` — renders the "parallel branches:" header + one line per branch
- L78 `4f6f8197` — uses the failure glyph for failed branches and the dot glyph for cancelled
- L88 `c4414b3e` — returns a placeholder line when no branches are tracked

### tests/unit/hosts/plain-host-attach-foreground.test.ts (1 cases)
- L26 `e5f66305` — resolves immediately with no subprocess spawn

### tests/unit/hosts/plain-host.test.ts (13 cases)
- L51 `109c986b` — writes the banner to stderr, not stdout
- L59 `25565bd8` — renders a lifecycle step:start event as [orch] step:start …
- L67 `49eb2a53` — writes one prefixed text line per kind:line transcript line under [stepName]
- L78 `f8d56eda` — suppresses runner events whose lines array is empty
- L85 `12e4b3ec` — writes a heading and indented rows for kind:block lines without the [step] prefix
- L107 `883684d8` — emits step:complete with duration
- L116 `70a27795` — writes the Story 1.5 failure frame to stderr after the [orch] line
- L131 `89bf1a13` — renders a string error message without a stack block
- L141 `4e499eac` — suppresses the stderr failure frame when --format=json
- L150 `211aa887` — suppresses the banner on stderr when --format=json
- L158 `e9ebad93` — emits a flat NDJSON envelope with ts/run/ev/step fields for step:start
- L171 `2499ca31` — emits one line per event
- L184 `6ab39af1` — emits runner events as ev:event with kind/type

### tests/unit/hosts/plain/per-step-tee.test.ts (6 cases)
- L34 `c76ee654` — returns the null tee when no logger is provided
- L38 `99090d3f` — writes ANSI bytes verbatim and stripped form to the txt sibling
- L56 `c0791654` — write before open is a no-op (silent or interactive steps leave no files)
- L69 `d9dbbb61` — keeps two parallel branches independent
- L96 `47fbe71c` — open is idempotent — repeated open() reuses the existing sinks (resume safety)
- L113 `69194b14` — drain closes any sinks left open by SIGINT mid-step

### tests/unit/hosts/plain/plain-host-subworkflow-divider.test.ts (10 cases)
- L47 `a162ce70` — renders an enter divider for sequential composition
- L56 `759df39b` — renders an exit divider with the completed glyph
- L71 `9e48e131` — renders an exit divider with the failed glyph when outcome is failed
- L85 `fb99d92e` — suppresses the divider for events flagged insideParallel
- L108 `280e07c9` — renders a host-error diagnostic line
- L126 `aef2a0c9` — emits a subworkflow.enter JSON record
- L137 `39d094f9` — emits a subworkflow.exit JSON record with outcome and durationMs
- L155 `d664756a` — emits a host-error JSON record
- L172 `5554c082` — emits subworkflow records with insideParallel when the event carries it
- L187 `cea816ef` — emits insideParallel on subworkflow.exit when the event carries it

### tests/unit/hosts/plain/render-line-no-duplicate.test.ts (5 cases)
- L37 `69da3856` — `returns exactly one string for kind=line, category=${category}`
- L43 `fac193b4` — `never emits caret-notation escape sequences for category=${category}`
- L50 `23f44f63` — returns heading + one string per row for kind=block, with no caret escapes
- L66 `e70a95ac` — still emits real ANSI bytes when color is on (sanity check the escape sequence path)
- L75 `90b51b6c` — emits no escape bytes at all when color is off

### tests/unit/hosts/terminal-reset.test.ts (5 cases)
- L20 `b21c016b` — writes the canonical DEC private-mode reset string when the stream is a TTY
- L29 `2a0f8f49` — disables every mouse-tracking variant so SGR reports cannot leak into the outer shell
- L42 `ce2d61fe` — exits the alternate screen and turns bracketed paste off so prompts redraw cleanly
- L53 `3635bac5` — writes nothing when the stream is not a TTY so piped output stays clean
- L61 `af56fafa` — writes nothing when the stream has no isTTY property at all

### tests/unit/hosts/tmux-host-attach-foreground.test.ts (8 cases)
- L74 `2148cef0` — composes tmux -L <socket> attach-session -t <session> via spawnForeground
- L83 `d6f2f465` — resolves when the attach subprocess exits cleanly
- L93 `2b30d5b4` — resolves silently when teardown already triggered the attach exit
- L108 `75e45007` — writes a diagnostic to stderr when exit is non-zero and teardown did not fire
- L120 `254cb42f` — logs attach exit code, teardown state, and tmux reachability
- L144 `1e4e7694` — is a no-op that never spawns when skipAttach is true
- L167 `63366c54` — throws HostCreationError with the nested-tmux guidance when $TMUX is non-empty
- L195 `58f4dff1` — skips the guard when $TMUX is set but skipAttach is true (headless attach is a no-op)

### tests/unit/hosts/tmux-host.test.ts (24 cases)
- L121 `39d4c141` — creates the session, lists the initial pane, and splits the right pane with cat
- L146 `b13c0fc9` — prepares the left pane with `clear && exec cat` so sendKeys draws to a clean pty
- L165 `8a828d4c` — registers a hard-exit backstop that emits the DEC private-mode resets so tmux mode leaks survive `process.exit()`
- L202 `284daa3d` — routes an unhandled rejection to the lifecycle log instead of bleeding the stack to fd-2
- L246 `49eaa4c8` — does not sendKeys to the right pane — runner bytes flow through the per-step tee (U5)
- L274 `21296f01` — suppresses runner events whose lines array is empty
- L292 `16ba2234` — does not sendKeys the failure frame to the right pane — it is appended to the per-step tee (U5)
- L321 `07fb7338` — forwards the event to the status loop so the left pane marks failed
- L347 `637b1a3c` — does not fan rollup bytes onto the right pane (U7 invariant — rollup lives in the _rollup tee)
- L389 `4e009ef9` — logs right-pane interactive pane lifecycle diagnostics
- L420 `57a00186` — logs left-pane wait failures so fake clean TUI exits are diagnosable
- L459 `0d15c66a` — creates a per-source tmux session with the runner argv + env + cwd, swaps it visible, and kills the session on exit (U4)
- L540 `2a0d743a` — omits timeoutMs on the pane-exit waitFor so an idle interactive agent never trips a default timeout
- L563 `45a375a9` — stops the status loop and drains the per-pane write queue
- L584 `6d91a7e2` — kills the visible orch session on teardown — no shared substrate session is created at boot (U4)
- L611 `f6081df7` — is idempotent — a second teardown does not re-issue kill-session
- L627 `a7e1b2a1` — drains every per-source session before killing the visible orch session (U4)
- L666 `8392e92e` — still kills the visible orch session when controller.teardownSessions() fails (U4)
- L708 `5abe4156` — latches concurrent teardown calls — second caller waits for kill-session to complete
- L768 `b8b26606` — does not touch the outer TTY again after teardown returns on the graceful exit path
- L851 `609f3a51` — derives the socket as orch-${runId} when no socket is supplied
- L858 `56ab6111` — routes every tmux call through an explicit socket override when supplied
- L864 `f782e7d6` — embeds the provided socket in the pane-died hook, not orch-${runId}
- L872 `1741faba` — functions when socket diverges from runId — session setup and right-pane split still run

### tests/unit/hosts/two-pane/await-interactive-pane-exit.test.ts (5 cases)
- L39 `3fe5dd23` — resolves via the pane-died hook when the hook signal arrives
- L48 `acdbd601` — falls back to the liveness poll when the hook signal is lost, reporting the dead status
- L67 `d338194f` — releases the parked hook waiter via signalChannel when the poll wins
- L87 `64ea8205` — keeps waiting while the pane is alive and never fails a live pane
- L114 `6695f8d0` — treats a vanished pane (display-message throws) as exited

### tests/unit/hosts/two-pane/kind-details.test.ts (5 cases)
- L10 `61ae08c8` — renders the SHA on a CommitResult-shaped value
- L24 `9671995c` — renders the no-commit fallback when value is null (clean tree)
- L40 `9883418d` — renders path / branch / fromRef from a WorktreeResult-shaped value
- L58 `125ff63a` — shows the cancelled marker when the prompt was cancelled
- L73 `190cb8c2` — shows the chosen button + scalar fields when the user submitted

### tests/unit/hosts/two-pane/lifecycle-choreographer.test.ts (14 cases)
- L63 `271f285a` — opens the tee, writes the starting marker, then registers a live file-tail source for an autonomous step
- L80 `e74af886` — emits a no-transcript banner and registers no source when no logs directory is configured
- L97 `6c4b8f6f` — produces no side effects for a non-autonomous step
- L112 `6a021a80` — emits a single cached-no-transcript info banner
- L127 `94207ea1` — unregisters the live source before closing the tee
- L146 `a2ae5ad7` — writes the failure summary, unregisters with the completion banner suppressed, emits the error, then closes the tee
- L178 `3a4f37fe` — skips the failure-summary write when the host is already tearing down
- L198 `c03bc98a` — opens the rollup tee and registers a rollup file-tail source on parallel-start
- L214 `9acd8005` — aggregates every branch update into one rollup snapshot written to the rollup tee
- L238 `6f59aeff` — closes the rollup tee only after unregistering the rollup source on parallel-complete
- L254 `79f22cfc` — resets the rollup aggregator so a later parallel block starts with a fresh snapshot
- L279 `a888fad5` — settles an earlier event's full effect sequence before a later event's begins
- L305 `0edbd8d3` — keeps processing later events after one event rejects, routing the rejection to onSendError
- L331 `be145ab7` — still runs the tee effects and never throws when no controller is wired

### tests/unit/hosts/two-pane/pane-map/resume-refusal.test.ts (10 cases)
- L185 `39858c86` — R10: omitting resumeRegistry refuses with "no runner wired"
- L193 `1812d8b5` — R8: registry present but no entry AND no runnerName refuses with legacy text
- L204 `bcd21a3f` — R11: registry present, no entry, BUT runnerName set refuses with "not ready yet"
- L218 `c04e8c10` — runner without resumeCommand refuses with the unsupported-runner text (existing branch)
- L230 `cc73c35b` — R9: sessionIdCaptureError='ambiguous' refuses with an ambiguous-specific message
- L245 `b57fe35e` — R9: sessionIdCaptureError='empty' refuses with an empty-specific message
- L260 `5026626d` — R9: sessionIdCaptureError='error' refuses with an internal-error message distinct from 'empty'
- L277 `a3bc25e8` — defensive: registry hit + runner.resumeCommand but no sessionId and no captureError refuses with 'no captured sessionId'
- L292 `e84ee17f` — happy path: registry hit + sessionId + resumeCommand spawns the runner without a refusal file
- L340 `0f3817a7` — step-keyed lookup resolves two distinct same-named runners to their own runners (F6 regression)

### tests/unit/hosts/two-pane/pane-map/right-pane-controller-banner.test.ts (6 cases)
- L101 `c0ad27f1` — writes a snapshot with a fresh monotonic seq on every call
- L122 `8a884d7f` — preserves the current view-mode across banner emits
- L138 `6f117628` — is a no-op (in-memory only, no write) when tuiOverlayPath is omitted
- L173 `42595ca0` — writes a snapshot with the new view-mode and no banner change
- L190 `a0d8c506` — clears the in-memory banner and writes a snapshot with banner: null
- L208 `8ba18578` — is a no-op when no banner is set

### tests/unit/hosts/two-pane/pane-map/right-pane-controller-failure-recovery.test.ts (4 cases)
- L162 `ba26e264` — does not write to opts.stderr when registerSource throws during dispatchEnter
- L182 `f0ced2eb` — still surfaces a banner overlay on a session-create failure
- L218 `6fed54ab` — still emits the completion banner by default (the live → replay info toast)
- L238 `ab04dff6` — skips the completion banner when suppressCompletionBanner is true

### tests/unit/hosts/two-pane/pane-map/right-pane-controller-interactive-dead-pane.test.ts (4 cases)
- L164 `b054f452` — does not swap-pane to the dead resume pane of a cached interactive source
- L251 `b637ee63` — surfaces a swap failure as an error banner instead of letting it escape and bleed to the TTY
- L317 `f9a06aa3` — does not swap-pane to a dead source when the user presses follow-live (f)
- L391 `31e84eff` — recovers by re-registering when the cached interactive pane died but its session is still alive (remain-on-exit)

### tests/unit/hosts/two-pane/pane-map/right-pane-controller-replay-dead-pane.test.ts (1 cases)
- L142 `4fe8e525` — does not swap-pane to the dead pane of a completed step whose per-source session was killed

### tests/unit/hosts/two-pane/pane-map/right-pane-controller-session-lost.test.ts (4 cases)
- L150 `f60b9c8c` — registerSource for an interactive source throws when the socket is lost, with no stderr bleed
- L181 `a1449a7a` — a session-lost registerSource leaves no ghost entry in the pane map
- L234 `fe74b5be` — unregisterSource after the server has died does not write to stderr
- L271 `e4c74b79` — FakeTmuxService.markSocketLost produces the canonical macOS error shape

### tests/unit/hosts/two-pane/pane-map/right-pane-controller.test.ts (20 cases)
- L102 `ff783629` — creates a per-source tmux session whose initial pane runs the file-tail argv
- L133 `bbf9ef06` — creates a per-source tmux session with argv, env, and cwd forwarded verbatim for a pty spec
- L161 `e215d092` — two distinct sources produce two distinct createSession calls — no shared substrate
- L187 `473e6de2` — is idempotent when called twice with the same key
- L206 `09a34636` — failure isolation: source B succeeds even when source A fails to create its session
- L238 `6983fb6f` — issues swapPane(src=entry.paneId, dst=visible) and updates the visible pane id
- L278 `bca7d594` — preserves the pane-id-sticky invariant: getPaneId(key) is unchanged after a swap
- L301 `c5aac0ab` — is a no-op when currentKey already equals the target key
- L320 `6c81aa89` — logs a miss and does not call swapPane when the key is not registered
- L335 `2bfee24f` — transforms a live key into a replay key without killing the per-source session
- L363 `5d9d14eb` — kills the per-source session for an interactive key (no warm cache)
- L388 `73f400d6` — kills the per-source session for a rollup key
- L417 `ac6ed12a` — auto-advances the visible pane to the next live step when the current live step completes
- L450 `aedeb61d` — issues one killSession per registered source and clears the map
- L481 `420786c5` — tolerates one entry throwing — the rest still tear down
- L513 `01df3828` — prefers rollup over live sources when both are registered
- L540 `86396aab` — picks the most-recently-registered live source when rollup is absent
- L567 `5ba8f08b` — is a no-op when no rollup, live, or placeholder source is registered
- L591 `e9b3b965` — chains dst across concurrent registerSource calls so each swap targets the previously-visible pane id
- L643 `3736ecff` — keeps the final visible-pane bookkeeping consistent when an interactive source races command sources

### tests/unit/hosts/two-pane/pane-map/right-pane-on-intent.test.ts (8 cases)
- L156 `9a0275b0` — warm-caches the replay pane: re-enter on the same step does not create a second per-source session
- L180 `81c1608a` — flips viewMode to replay on successful enter
- L205 `029ccb01` — does nothing for an unknown stepName (lookup miss)
- L227 `18bfe737` — prefers the persisted ANSI tee for autonomous replay when the file is non-empty
- L273 `a8716588` — on follow-live with no rollup/live registered swaps to placeholder when one exists
- L299 `a31859f2` — on enter for a running step (live source registered) swaps to live, not replay
- L378 `815bae93` — stops following the live edge after the user opens an earlier step — a later step does not swap in
- L429 `c4723849` — re-entering a completed interactive step stays in replay, not live (run r-2026-05-27-154145-nk)

### tests/unit/hosts/two-pane/pane-map/source-session.test.ts (13 cases)
- L32 `0624c9a8` — maps the colon separator in a live source key to a dash and prefixes orch-src-
- L38 `2d24b4a2` — replaces dots inside step names with dashes so tmux accepts the session name
- L42 `b6a9de23` — replaces whitespace (space and tab) with dashes — defensive against malformed step names
- L48 `ec327241` — maps the singleton placeholder key to a stable session name (idempotent calls)
- L56 `522da57b` — maps the singleton rollup key to a stable session name
- L60 `225f9c0d` — truncates over-long inputs and appends an 8-char hex hash for collision safety
- L71 `d9e9c488` — distinguishes two inputs that share their first 56 chars via the hash suffix
- L86 `4bbc1e79` — records exactly one createSession call with the expected session name, command, width, and height
- L109 `8ed71853` — returns the source session handle with the pane id scripted on the fake
- L127 `5897dd3d` — never calls splitPane — the per-source design removes split-window from the spawn path
- L143 `5a3f6167` — propagates TmuxCommandError from createSession unchanged (no retry, no rotation)
- L168 `bf18f6f8` — issues exactly one killSession against the handled session
- L190 `eb00531a` — clears the fake pane-ownership table for the torn-down session

### tests/unit/hosts/two-pane/real-tmux-harness/pane-handle.test.ts (11 cases)
- L35 `b8650a95` — returns true for tmux named keys the harness supports
- L42 `2cb125ca` — returns false for literal characters and arbitrary strings
- L51 `9f62a972` — removes CSI sequences but keeps the visible text
- L58 `b7ed56b8` — exposes left and right pane handles for the orch session
- L75 `0f134502` — captures pane text with ANSI stripped by default and raw bytes via captureRaw
- L93 `2edcc4bf` — runWorkflow drives a single FakeRunner step to completion (empty workflow case)
- L107 `1d9d50a1` — runWorkflow uses the agentProcessService slot so a scripted FakeRunner runs end-to-end
- L135 `38153f5a` — rejects with an error containing the last frame when the text never appears
- L158 `20fad778` — resolves on the first predicate match without exhausting the timeout
- L180 `8d1fd293` — sends Enter as a real keystroke (tmux exits 0)
- L197 `7e253e08` — sends a literal F via the service path so the keymap reads it as uppercase-F

### tests/unit/hosts/two-pane/real-tmux-harness/socket-allocation.test.ts (18 cases)
- L29 `4bfdca71` — returns a reserved orch-test-<pid>-<nonce> name embedding this process pid
- L36 `bd536bff` — returns a fresh, distinct name on every call
- L43 `2378f938` — never produces a production-shaped or bare orch- socket name
- L59 `5dd5fe38` — allocateSocketName() never yields a production-shaped or bare socket name
- L66 `10620a84` — a created fixture socket never yields a production-shaped or bare socket name
- L76 `3fa78f84` — parses the pid from a reserved orch-test- socket name
- L80 `dfaea9b8` — returns undefined for a production-shaped orch-r- socket name
- L84 `be861aa5` — returns undefined when the first segment after the prefix is not numeric
- L88 `0120e301` — round-trips with allocateSocketName back to this process pid
- L94 `e91f78ad` — returns silently when TMUX is unset or empty
- L100 `8418a550` — throws a clear error naming TMUX when running inside a tmux session
- L106 `f5dc0f1b` — returns false when TMUX is set even if tmux is on PATH
- L110 `076e5758` — mirrors Bun.which(tmux) presence when TMUX is unset
- L116 `689a0baa` — exposes services, a reserved orch-test- socket decoupled from runId, and an existing state-base directory
- L130 `8b766190` — allocates a distinct runId, socket, and state base for two concurrent fixtures
- L141 `18430fbf` — removes the state base on dispose and tolerates being called twice
- L151 `e7414d76` — throws the nested-tmux guard error before allocating anything when TMUX is set
- L159 `1276602c` — kills a tmux server booted on its socket so list-sessions exits non-zero after dispose

### tests/unit/hosts/two-pane/replay-command-pane.test.ts (4 cases)
- L25 `0c863281` — returns the captured pane log path when the file exists and has bytes
- L40 `049c6f9f` — returns the inline placeholder when paneLogPath is undefined
- L52 `3c4348e6` — returns the inline placeholder when the pane log file is empty
- L66 `4a12758d` — returns the inline placeholder when the pane log file is missing on disk

### tests/unit/hosts/two-pane/replay-transcript.test.ts (5 cases)
- L25 `74cb9cc9` — renders assistant info events into the replay payload
- L47 `803a43ec` — renders the no-events placeholder when the sidecar contains no parseable events
- L59 `bbd79d59` — skips malformed lines silently rather than crashing the replay
- L81 `a60b27c4` — runs every event through the supplied toTranscriptLines instead of the JSON fallback
- L108 `51b69658` — still renders the no-events placeholder when the sidecar is empty even with a custom renderer

### tests/unit/hosts/two-pane/session-lost-classification.test.ts (13 cases)
- L27 `9b6eefa9` — classifies the macOS "error connecting to ... (No such file or directory)" shape as session-lost
- L35 `d4a2f490` — classifies the Linux-style "no server running on ..." shape as session-lost
- L40 `b0e029cd` — classifies "session not found" with a session name as session-lost
- L45 `22d36b03` — classifies "can't find session" as session-lost
- L50 `c26d646b` — classifies "lost server" as session-lost
- L55 `99240124` — matches case-insensitively (tmux/macOS sometimes capitalize "No such file")
- L60 `582b7522` — handles a bare "No such file or directory" in stderr (the canonical macOS connect-time variant)
- L69 `0536ffc7` — does NOT classify "no space for new pane" — this is in-server, not server-lost
- L74 `8a3074e0` — does NOT classify "duplicate session" — server is alive, name collision
- L79 `c2bbedf4` — does NOT classify "can't find pane: %99" — pane-level lookup, server alive
- L84 `ae85f48a` — does NOT classify a generic "tmux: unknown command" error
- L89 `65b4f188` — returns false for non-TmuxCommandError instances (plain Error, string, undefined, null)
- L96 `67eca191` — returns false for a TmuxCommandError with empty stderr

### tests/unit/hosts/two-pane/stdio-capture.test.ts (5 cases)
- L48 `540e1901` — captures console.log output with object formatting
- L59 `c1fa5d4e` — captures console.warn and console.error as stderr lines
- L72 `90ef9c6a` — captures direct stdout.write calls without touching the original stream
- L85 `5a2a11e7` — restores console and stdout.write so later writes use the original stream
- L101 `4f018a05` — restore is idempotent and closes the target once

### tests/unit/hosts/two-pane/steps-view/adaptive-columns.test.ts (2 cases)
- L15 `95f2b20d` — hides elapsed below width 70 and exposes it from 70 upward across the canonical breakpoints
- L36 `c1b7d1f7` — exposes the documented threshold constants so future phases can flip cost/tokens on without forking the policy

### tests/unit/hosts/two-pane/steps-view/applyLifecycleEvent.test.ts (8 cases)
- L15 `51b349a8` — records a step:start as running with startedAt and the supplied mode
- L27 `f8480a0b` — records a step:start with mode=interactive as status interactive
- L39 `26838d5d` — preserves subPath and insideParallel metadata for live-only projected rows
- L65 `0154d7d7` — flips to completed on step:complete and preserves the prior mode + startedAt
- L79 `2f9db8b1` — flips to failed on step:failed and preserves the prior mode + startedAt
- L91 `ecd9d062` — uses subPath metadata on terminal events even when no start event was seen
- L113 `ed28d46c` — marks step:cached without overwriting previously-set timing fields
- L121 `b07b54c7` — ignores events with an unknown type or missing stepName so the projector cannot wedge on bad lifecycle lines

### tests/unit/hosts/two-pane/steps-view/applySubworkflowEvent.test.ts (3 cases)
- L13 `d4530f42` — keys sibling nested subworkflows by full subPath, not leaf name
- L55 `96824e57` — preserves insideParallel from enter or exit events
- L91 `2f04c863` — rejects invalid subworkflow events without mutating the overlay

### tests/unit/hosts/two-pane/steps-view/banner-rendering.test.tsx (3 cases)
- L38 `ca52936b` — info banner text appears in the frame
- L52 `075fa42d` — error banner text appears in the frame
- L66 `6cc75276` — no banner field → no banner row in the frame

### tests/unit/hosts/two-pane/steps-view/empty-steps-state.test.tsx (2 cases)
- L33 `80f80514` — renders the placeholder row, the run header, and the live footer when steps is []
- L44 `29f20ce1` — Enter fires no intent when there is no selectable step

### tests/unit/hosts/two-pane/steps-view/end-of-run-footer.test.tsx (4 cases)
- L43 `d16bcce6` — completed terminal status shows the run-completed footer
- L55 `803f815f` — failed terminal status shows the run-failed footer
- L65 `f6671561` — crashed terminal status shows the run-crashed footer
- L75 `6765b0a0` — pre-terminal (status: live) keeps the live footer indicator

### tests/unit/hosts/two-pane/steps-view/end-of-run-summary-colors.test.tsx (4 cases)
- L32 `fabb7d1c` — renders the "completed" label in green
- L44 `3333de87` — renders the "failed" label in red
- L52 `e2cd9d8e` — renders the "crashed" label in red
- L60 `25d401c5` — does not color the run header text (only the status word)

### tests/unit/hosts/two-pane/steps-view/end-of-run-summary.test.tsx (5 cases)
- L69 `788b533d` — repaints the header into a summary block on completion (totals + duration)
- L83 `2bfc0348` — renders distinct labels for failed and crashed terminal states
- L101 `c7d9b4bc` — leads with "q to quit · ⏎ to inspect" and includes the run status
- L110 `d62e74e1` — keeps Enter wired so resume on a past interactive step still fires onIntent
- L132 `ad24d625` — renders the same frame on a re-render with an unchanged terminal state (no flicker)

### tests/unit/hosts/two-pane/steps-view/header-rerender.test.tsx (1 cases)
- L300 `74ade3d1` — renders the breadcrumb header exactly once after state changes + a pane resize at a narrow width

### tests/unit/hosts/two-pane/steps-view/key-intent-mapping.test.tsx (7 cases)
- L59 `ef9dbf7f` — ⏎ on the selected step fires { type: enter, stepName }
- L74 `1b08fcfe` — f fires { type: follow-live } exactly once
- L88 `251b5ce1` — q fires { type: quit }
- L102 `e2afdbfe` — Esc on an error banner fires { type: dismiss-banner }
- L119 `3badeaf8` — Esc on no banner fires no intent
- L133 `8fe911cc` — ↑/↓ does not fire any intent — selection is local state
- L149 `a2a44fef` — ? opens help and does not fire any intent

### tests/unit/hosts/two-pane/steps-view/preview-cursor.test.tsx (4 cases)
- L71 `239e4477` — moves a distinct preview cursor on ↑ while leaving the committed highlight on the live step
- L99 `b827999c` — does not draw a preview cursor when it coincides with the committed row
- L115 `dfc9ebf0` — commits the previewed step (not the committed row) on Enter
- L140 `21299dc3` — snaps the preview cursor back to the committed row on f

### tests/unit/hosts/two-pane/steps-view/scroll-no-clear-flicker.test.tsx (4 cases)
- L92 `ada710b4` — does not emit a full-screen clearTerminal when a scroll-up keypress is pressed at a narrow pane width
- L108 `e5314be2` — stays flicker-free across repeated scroll keypresses
- L126 `373333a3` — does not blank the pane when a banner appears or disappears mid-run
- L147 `d006d8c2` — keeps the scrolled / End-live indicator visible at a narrow width

### tests/unit/hosts/two-pane/steps-view/selection-tracks-view.test.tsx (4 cases)
- L81 `ca5c08cc` — highlights the single live step at startup so the left pane matches the right pane
- L97 `db3d5921` — keeps the highlight on the step the right pane shows when there are multiple steps at startup
- L111 `9e99ef70` — moves the highlight to the next step when the right pane auto-advances without a keypress
- L133 `9f0b3220` — shows exactly one highlighted row and it equals the right-pane step

### tests/unit/hosts/two-pane/steps-view/selection.test.tsx (4 cases)
- L71 `ea8db86b` — auto-tracks the live step on first render with isUserDriven=false
- L83 `92f5aaa5` — moves selection up when the user presses arrow-up and flips isUserDriven=true
- L95 `831b5c34` — moves selection down when the user presses arrow-down
- L106 `315f25eb` — snaps back to live and clears isUserDriven when the user presses f

### tests/unit/hosts/two-pane/steps-view/start-steps-view.test.ts (9 cases)
- L77 `b5b7db6d` — records intentsStartOffset = 0 for a fresh state dir and spawns the runner script onto the left pane
- L107 `f32b7d8e` — records intentsStartOffset to the size of the existing intents file so stale lines are not replayed
- L139 `bf5eab78` — dispatches an intent appended after start through onIntent
- L169 `58736d5d` — logs a `tui-intent` lifecycle entry for each parsed intent received from the child
- L218 `3d27ad83` — logs a `tui-intent-parse-error` lifecycle entry when the intents file contains garbage
- L263 `ceb30fb8` — writes the canonical "TUI unavailable" message via PaneQueue and logs tui-crashed on unexpected child exit
- L318 `5b627345` — parses {type: "dismiss-banner"} successfully
- L322 `23ab35d5` — rejects unknown intent types
- L326 `cd541d72` — still parses the legacy intents

### tests/unit/hosts/two-pane/steps-view/steps-view-banner.test.tsx (13 cases)
- L49 `18a812e2` — renders ▶ live · ⏎ view step · q quit · ? help in live mode (no `f live` token)
- L65 `c4a043eb` — renders ⏸ viewing <stepName> · f live · … in replay mode
- L79 `9fc315fd` — truncates a long stepName to 30 chars with ellipsis in the footer
- L96 `d0238506` — renders an info banner above the steps grid
- L110 `441776ba` — renders an error banner with an Esc-dismiss hint
- L127 `16eb1a5c` — Esc with help open closes help only — does not dispatch dismiss-banner
- L145 `2cbf4772` — Esc with help closed and an error banner dispatches dismiss-banner
- L165 `a074f864` — Esc with help closed and no banner is a no-op
- L180 `2597010f` — Esc on an info banner is NOT manually dismissable (auto-clears instead)
- L206 `109440b3` — dispatches dismiss-banner for an info banner after ttlMs elapses
- L230 `6dea6b24` — does NOT auto-dismiss an error banner regardless of ttlMs
- L254 `625c0787` — restarts the auto-dismiss timer when seq bumps even with identical text
- L295 `c2020a1a` — lists f, Esc, and the view-mode indicator

### tests/unit/hosts/two-pane/steps-view/steps-view-colors.test.tsx (9 cases)
- L106 `6d2c8124` — renders cursor and name in cyan on the selected row, with bold name
- L116 `804961b1` — does not put cyan or bold on a row that is neither committed nor previewed
- L142 `ff99623a` — renders the preview cursor as a bold chevron with no cyan
- L187 `a7fa01bf` — renders a green check for completed steps
- L196 `28e5e0d1` — renders a red cross for failed steps
- L205 `5828282a` — renders a yellow half-circle for running steps
- L214 `8c20cac5` — renders a dim middle dot for pending steps
- L223 `fe2aa60d` — keeps glyph color independent of selection (committed failed row stays red, name turns cyan)
- L255 `a549f92d` — retains every structural element (names, glyphs, hairlines, cursor, footer) under stripAnsi

### tests/unit/hosts/two-pane/steps-view/steps-view-model.test.ts (12 cases)
- L18 `c4fd0319` — returns a live state with no steps when neither persisted state nor overlay exist
- L31 `2f65bb13` — surfaces a running step that exists only in the overlay (not yet persisted)
- L49 `c09bace2` — renders a completed agent step persisted in state.json with no live overlay entry
- L67 `0483e5ac` — marks a step as failed when the live overlay says so
- L82 `ac51836a` — routes prefixed names to the correct kind (commit / worktree / ask / command) and bare names to agent
- L109 `ecf81635` — produces a completed end-of-run summary when every step succeeded
- L132 `2767088e` — flips a completed run to failed status when at least one step has live status failed
- L153 `4783a7d1` — reports a crashed run with non-optional summary
- L165 `47a73076` — defaults view to {mode:"live"} when omitted, with no banner
- L172 `c4454c67` — propagates a replay view-mode through to the projected state
- L183 `9d8410c5` — propagates a banner verbatim onto the projected state
- L196 `762b817d` — preserves view + banner on terminal-status runs (completed/failed/crashed)

### tests/unit/hosts/two-pane/steps-view/steps-view-scroll.test.tsx (8 cases)
- L58 `b620ac62` — starts at live tail with no scrolled indicator in the footer
- L72 `7c2b006c` — k scrolls up and surfaces the scrolled indicator in the footer
- L88 `fc676b50` — End resets the scroll offset, emits follow-live, and clears the scrolled indicator
- L113 `10d1e135` — PageUp moves the offset further than k (one row vs many)
- L137 `4e5e968c` — Home clamps to the top of the buffer (visible window starts at step-000)
- L153 `a2f644b5` — scroll offset survives a state-prop change so a new step event does not jerk the viewport (R11/AE3)
- L192 `a06dfa57` — few-step case (steps.length <= visibleCount) does not surface the scrolled indicator after k
- L207 `fc203278` — ArrowUp/ArrowDown remain pure selection movement and do not surface the scrolled indicator

### tests/unit/hosts/two-pane/steps-view/steps-view.test.tsx (10 cases)
- L73 `93e04716` — renders the run header, every step name, and the keymap on a live run
- L90 `e0f6e1e5` — renders the end-of-run footer when the run is no longer live
- L101 `c4c674d7` — snapshots a "no steps yet" empty live frame
- L115 `26192a6f` — wraps the steps list in upper and lower hairline rules when steps exist
- L127 `1c99d345` — does not render hairlines around the empty state
- L143 `4290e739` — places the banner above the upper hairline when steps exist
- L160 `0cac8bf8` — keeps hairlines and drops the elapsed column on narrow terminals (<70 cols)
- L194 `0e741d97` — invokes onKey for arrow keys, return, f, q, and ?
- L225 `6eae2b67` — emits the follow-live intent for uppercase F (case-insensitive)
- L245 `15048745` — captures unknown keys as `other` with the raw input character

### tests/unit/hosts/two-pane/steps-view/subworkflow-boundary-projection.test.ts (8 cases)
- L34 `405cfb9f` — emits ▼-sub / children / ✓-sub between parent-A and parent-B (AE8)
- L72 `c853055a` — stacks `│ ` gutter columns additively across nested subs (AE11 mid-flight)
- L107 `57f8a126` — closes deepest-first when both subs exit (AE11 completion)
- L145 `43b81aac` — renders ▼-row for an in-flight stepless sub at the end of the projected list
- L161 `a25eb0d0` — synthesizes ✗ exit rows for any open sub at terminal status
- L192 `d19305cf` — does not count boundary rows in the end-of-run summary totals
- L226 `e6575317` — keeps sibling nested subworkflows with the same leaf name separate
- L274 `c6d80963` — uses live overlay subPath for an in-flight child step before persistence

### tests/unit/hosts/two-pane/steps-view/subworkflow-boundary-selection.test.tsx (6 cases)
- L123 `52bffa89` — ↑ from the committed live row (parent-B) skips the ✓ exit and lands on child-2
- L141 `10fb9dea` — ↓ from child-2 skips the ✓ exit and lands on parent-B
- L157 `ca103287` — committedName tracks the most recent selectable row, never a boundary row
- L180 `3533f226` — selection-skip terminal: ↑ stays put when no selectable row exists above the cursor
- L213 `82ed002c` — selection-skip empty: a pane with only boundary rows reports selectedName=none
- L226 `d309a6c9` — ⏎ while the cursor is forced onto a boundary row emits no `enter` intent

### tests/unit/hosts/two-pane/steps-view/subworkflow-collapse.test.tsx (4 cases)
- L69 `f158b4a4` — renders the compact `│4 ` token for depth-4 step rows at pane width 50
- L76 `6af1f487` — renders depth-4 sub boundary rows with the depth-3 compact form (`│3 ▼ leaf`)
- L84 `91cbec9d` — renders the stacked-bar form at pane width 80 even when depth is 4
- L93 `c41e08d6` — renders the stacked-bar form at depth 3, width 50 (both conditions are required)

### tests/unit/hosts/two-pane/steps-view/subworkflow-parallel-suppression.test.ts (4 cases)
- L89 `646862be` — suppresses sub boundary rows for sub-of-parallel branches (AE9)
- L146 `1c92f43f` — suppresses transitively for sub-of-sub-inside-parallel (AE13)
- L184 `c1098011` — does NOT suppress sequential subs whose steps run outside any parallel
- L212 `79e97f49` — keeps insideParallel on lifecycle records for suppressed homogeneous sub boundaries

### tests/unit/hosts/two-pane/steps-view/tail-ndjson.test.ts (3 cases)
- L28 `542b4b0c` — emits one onLine call per newline-terminated record found in the file
- L43 `025ab2dc` — buffers a trailing partial line until the producer writes the newline
- L62 `73dca07b` — skips pre-existing content under startOffset >= size and surfaces only post-start appends

### tests/unit/hosts/two-pane/steps-view/tail-state-json.test.ts (3 cases)
- L28 `5b3fb96f` — fires onChange exactly once when start() is called against an existing file (leading-edge)
- L45 `fb942f01` — re-fires onChange after a subsequent writeFile (poll fallback at 50ms catches it)
- L69 `bfc73280` — is idempotent on stop() — calling twice does not throw

### tests/unit/hosts/two-pane/steps-view/tui-overlay.test.ts (11 cases)
- L16 `0b21a76a` — parses a live view-mode snapshot with no banner
- L22 `b43d2750` — parses a replay view-mode snapshot with the stepName preserved
- L30 `a36fed4c` — parses an info banner snapshot with seq and ttlMs preserved
- L44 `fef191a2` — parses an error banner snapshot without ttlMs
- L58 `723821e3` — treats banner:null as "no banner" (explicit clear sentinel)
- L64 `16ce6b97` — returns undefined on malformed JSON
- L68 `bb5ee9d3` — returns undefined when view is missing
- L72 `3128e754` — returns undefined when banner has a negative seq
- L83 `227f4d64` — returns undefined for unknown banner kinds
- L96 `37bfa530` — writes banner:null when banner is undefined (explicit clear sentinel)
- L106 `e62e6936` — round-trips a full banner snapshot through parse

### tests/unit/hosts/two-pane/steps-view/view-mode-footer.test.tsx (3 cases)
- L53 `3eedd037` — live mode renders '▶ live · ⏎ view step · q quit · ? help'
- L65 `cf265fb2` — replay mode renders '⏸ viewing <stepName> · f live · ⏎ view another'
- L77 `6f49eabc` — flipping state from live → replay re-renders the footer indicator

### tests/unit/observability/file-session-logger.test.ts (21 cases)
- L29 `20c34e23` — writes an ndjson line to the category file with auto-injected ts
- L40 `c453e8b3` — mirrors the record into timeline.ndjson with a source tag
- L50 `ca8138ae` — forStep returns a span whose append auto-tags stepName and stepSpanId
- L61 `837bbde1` — concurrent appends to the same category do not interleave
- L73 `7afe84ad` — concurrent appends to different categories run independently
- L92 `17ed5e64` — close awaits every in-flight append before resolving
- L106 `9021fe5c` — writes a complete file atomically via temp-then-rename through FsService
- L114 `e4f2415c` — creates nested subdirectories lazily
- L121 `514f6fdb` — rejects traversal segments in the rel path
- L126 `aba4880e` — rejects absolute paths
- L131 `1699ec71` — rejects control characters in the rel path
- L138 `d665ef1c` — returns null when debug is false
- L143 `87448f90` — returns a writable sink when debug is true and appends bytes through FsService
- L156 `8d10bb1f` — rejects writes after close
- L165 `6e0274bb` — returns a writable sink even when debug is false
- L177 `176815f5` — appends across multiple writes preserving order
- L190 `a961fe69` — writes from two streamSinks at the same path stay independent per call
- L204 `1b2feeaf` — rejects writes after close
- L211 `7d8d324a` — truncates the target file on first write when truncateOnOpen is true
- L225 `36f3dad0` — does not truncate without the flag
- L238 `429b52ea` — rejects traversal segments in the rel path

### tests/unit/observability/instrument-process-service.test.ts (4 cases)
- L67 `484d3019` — returns the base service unchanged when debug is false
- L77 `60a447cf` — records non-agent spawn() calls to subprocesses.ndjson with argv, envKeys, and durationMs
- L111 `edd906fa` — skips spawns tagged as agent so they do not duplicate spawns.ndjson
- L134 `d08cfe65` — records spawnForeground() calls with kind=spawnForeground

### tests/unit/observability/null-session-logger.test.ts (9 cases)
- L6 `03e3616d` — returns a SessionLogger whose append resolves without side effects
- L11 `bb631311` — returns null from rawSink regardless of the relPath
- L16 `37b2d4ac` — exposes a debug flag that defaults to false
- L20 `317ee876` — honours an explicit debug flag override
- L24 `4a639e7d` — forStep returns a span with a non-empty stepSpanId and the requested stepName
- L32 `c8495a45` — forStep returns distinct stepSpanIds across calls
- L39 `93848c8e` — writeFile and close resolve without touching disk
- L45 `d4b8fc69` — streamSink returns a no-op sink whose write and close resolve
- L52 `4c78fa33` — streamSink accepts truncateOnOpen and stays a no-op

### tests/unit/observability/readme-template.test.ts (5 cases)
- L14 `d31238c4` — includes the runId in the top-level heading
- L19 `2369ae5c` — includes workflow name, mode, started-at, and orch version
- L27 `bf5b672a` — reports debug off when debug is false and prompts the reader to re-run with --debug
- L33 `4df5a6d3` — lists debug-only file types when debug is true
- L41 `cf22f90b` — includes a grep recipes section with a stepSpanId example

### tests/unit/observability/redact.test.ts (12 cases)
- L10 `0719243c` — flags ANTHROPIC-prefixed env keys as secret
- L15 `b30eb889` — flags CLAUDE-prefixed env keys as secret
- L20 `db3f424c` — flags keys ending with _TOKEN, _SECRET, _KEY, or _PASSWORD as secret
- L27 `e49531fd` — passes through benign env keys untouched
- L36 `f54f3e93` — returns a sorted list of env keys with no values
- L41 `f1667a9e` — returns an empty list for an empty env
- L47 `76d3b593` — drops ANTHROPIC_API_KEY value
- L52 `7669ae6e` — drops *_TOKEN / *_SECRET / *_KEY / *_PASSWORD values
- L69 `f32e067d` — passes through benign env vars untouched
- L74 `51797034` — skips undefined values
- L81 `c084f07c` — redacts values inside reproduce commands
- L86 `f01d5fea` — leaves benign KEY=value pairs untouched

### tests/unit/observability/status-loop-subworkflow.test.ts (4 cases)
- L14 `dc581520` — subworkflow:enter does not register a new live entry
- L22 `dc05186c` — subworkflow:exit does not register a new live entry
- L34 `50d760ae` — host-error does not register a new live entry
- L46 `c90cffc3` — does not perturb a pre-existing rollup when a subworkflow event fires

### tests/unit/observability/status-pane.test.ts (26 cases)
- L30 `92b490bb` — uses Unicode glyphs for every step status when tty is true
- L39 `375017bf` — falls back to ASCII glyphs when tty is false
- L54 `89ea73d0` — returns a green check for completed
- L58 `41a13840` — returns a red cross for failed
- L62 `cbea0e9d` — returns a yellow half-circle for running
- L66 `1684e7ff` — returns a dim middle dot for pending
- L70 `1d63f213` — returns a dim cycle glyph for interactive
- L74 `93a0a994` — returns a dim cached glyph for cached
- L78 `ec341ed8` — does not affect the plain-text stepGlyph table
- L90 `b1cdb3da` — formats sub-second durations in milliseconds
- L95 `8a1176b2` — formats second-and-minute durations with rounded seconds
- L102 `143e58e6` — treats negative inputs as zero instead of throwing
- L112 `2fa0651f` — removes color escapes from a rendered step name
- L117 `af76b85d` — removes cursor-motion escapes injected via untrusted prompts
- L122 `4dd011cc` — strips OSC sequences and leaves plain ascii untouched
- L144 `074ee8b7` — returns an empty list when neither persisted state nor live records exist
- L148 `460e1e98` — marks persisted steps as completed with their recorded mode and timestamps
- L171 `1d3c7dc2` — lets live records override persisted status for the same step
- L183 `9b8051c2` — appends live-only records after persisted ones preserving insertion order
- L202 `6c49bbf0` — renders the empty-state line when no records are provided
- L206 `b1a55a94` — renders a running step with live elapsed time against now
- L213 `ab01abd3` — renders a completed step with its frozen duration instead of wall-clock elapsed
- L221 `6ecbe98b` — renders a pending step without a duration column
- L226 `2b7b5608` — renders the run title above the step list when provided
- L234 `f994923c` — uses ASCII glyphs and strips ANSI from step names when tty is false
- L242 `23a5270f` — renders a mixed list of interactive, cached, and failed steps with matching glyphs

### tests/unit/runners/claude/build-command.test.ts (27 cases)
- L17 `df116d44` — returns a runner with name "claude", structuredOutput true, and interactive true
- L25 `56103106` — returns a frozen runner object
- L31 `c78d7cf3` — accepts all options without error
- L44 `ef228ef9` — produces correct argv with defaults (bare, stream-json, verbose, no-session-persistence)
- L60 `add9cb60` — includes --model when provided
- L68 `56932675` — includes --max-turns when provided
- L76 `07f3a96c` — omits --bare when bare is false
- L85 `28137e6c` — appends flags before extraArgs, extraArgs last
- L97 `067e3c77` — includes --model and --max-turns together when both provided
- L110 `c59e2efb` — appends --json-schema flag with serialized JSON Schema when schema is present
- L120 `111f521a` — does not append --json-schema flag when schema is absent
- L127 `8045e121` — places --json-schema before user flags and extraArgs
- L144 `4fd58bc0` — includes both --bare and --json-schema when both are active
- L155 `232bdfee` — produces interactive argv with session-id and -- flag terminator
- L164 `c02ca399` — omits --bare, -p, --output-format, --verbose, --no-session-persistence in interactive mode
- L175 `81ab1778` — includes --model in interactive mode when configured
- L183 `259328ba` — applies flag denylist in interactive mode
- L189 `78a1b9ac` — passes --dangerously-skip-permissions through to argv (denylist removed by policy)
- L196 `3a63d6d2` — produces autonomous argv unchanged when mode is undefined
- L205 `be591745` — uses buildClaudeEnv for both interactive and autonomous modes
- L215 `36a9c9fe` — sets FORCE_COLOR=3 in interactive mode so Ink keeps colors under inherit stdio
- L222 `3902793f` — does not set FORCE_COLOR in autonomous mode where stdout is piped NDJSON
- L229 `5023dcbb` — lets ctx.env override the interactive FORCE_COLOR extra (mergeEnv contract)
- L243 `56bfe299` — rejects --settings in flags
- L249 `f6c4c939` — no longer rejects --dangerously-skip-permissions (removed by policy)
- L256 `1295b7f7` — rejects --settings in ctx.extraArgs
- L264 `71748cb1` — rejects --mcp-config=foo (prefix match) in flags

### tests/unit/runners/claude/claude-auto-stop.test.ts (7 cases)
- L27 `0066043e` — writes Stop and StopFailure hooks whose command is exactly the signal-only one-liner
- L39 `d65048e7` — writes a signal-only command — no termination verb and no stdout side effect
- L51 `8a0f9482` — has written the file by the time prepareAutoStop resolves (write-before-launch)
- L62 `0db565b3` — preserves the user hooks and appends the two injected hooks (no clobber)
- L83 `d76dbca6` — removes the file it wrote when no settings existed before
- L94 `be826834` — restores the original bytes when a settings file existed before
- L107 `f5ff64bc` — never touches a ~/.claude path during prepare or cleanup

### tests/unit/runners/claude/format-event.test.ts (20 cases)
- L24 `84f7fb13` — renders the synthesized session-started event as one line with model, tool count, and mcp server count
- L45 `f53725ad` — renders a raw system-init event that bypassed the parser as the init line
- L67 `295b397d` — suppresses high-frequency task_progress system events emitted by background workflows
- L73 `06751ae8` — suppresses thinking_tokens system events
- L79 `baf3c4bc` — renders a lifecycle system subtype as one compact line rather than a bogus init summary
- L87 `71cdf95a` — renders a system event with no subtype as a bare system marker, never a fake init line
- L97 `f9cb680e` — expands an assistant message into ordered lines per content block (thinking, tool_use, text)
- L113 `4c25c042` — renders multiple text blocks in a single assistant message as separate lines
- L125 `3a5dffce` — truncates a 50KB assistant text block to 4000 chars
- L138 `a3b0b508` — skips empty text blocks rather than emitting a label-only assistant line
- L146 `238ecdc5` — renders Read tool_use with middle-ellipsis on a long file path
- L162 `30f3507a` — renders Bash tool_use with command truncated at 120 chars
- L174 `2426ce9a` — renders TodoWrite tool_use with the todo count
- L189 `9ba093c3` — renders an unknown tool_use as JSON-stringified input truncated at 80
- L209 `120af2c6` — renders a tool_result with is_error=true as the tool-error category
- L228 `ab61e264` — renders a tool_result with multi-line content as the first non-empty line
- L244 `92f5a9b8` — renders turn-complete as a done block with rows present in usage
- L287 `628d082e` — renders turn-complete with partial usage by emitting only present rows
- L301 `a7328964` — renders terminal/error as a failed block with the message row
- L313 `8b739fa6` — returns [] for rate_limit_event, missing content, and empty content

### tests/unit/runners/claude/parse-events.test.ts (21 cases)
- L6 `3d61a5ee` — parses a success result into a turn-complete TerminalEvent with envelope in data
- L33 `e3dbe659` — parses an error result into an error TerminalEvent with message from errors[0]
- L53 `ff60069f` — uses "unknown error" when errors array is empty
- L72 `bc58f3fb` — parses a success envelope with is_error: true as a terminal error carrying the result text as the message
- L103 `45256f98` — surfaces the "Not logged in" message from a bare-mode authentication_failed envelope
- L137 `dbaf7858` — parses unknown error subtype successfully (not rejected by enum)
- L156 `9045d6ae` — parses an unknown event type as an InfoEvent with raw type and payload
- L173 `0891f783` — returns null for malformed JSON
- L179 `dd7d8fb0` — returns null for JSON without a type field
- L185 `5a7fb136` — returns null for empty/whitespace lines
- L191 `9e46bdbf` — returns null for non-object JSON (string, number, array)
- L197 `f1e9270e` — returns an error TerminalEvent with Zod issues for result with invalid schema
- L213 `1669bf66` — preserves extra fields via passthrough on success results
- L246 `dab092fb` — preserves extra fields on error result data
- L268 `e996af75` — returns the result text from a success terminal event
- L297 `d63aace0` — returns undefined for an error terminal event
- L310 `269498c7` — returns undefined when turn-complete has no valid data
- L323 `d05b8f19` — returns structured_output when present in the result envelope
- L353 `3661f99e` — returns structured_output even if result is also present
- L383 `71009562` — returns null structured_output as-is without falling through to result
- L415 `ed40f798` — routes error_max_structured_output_retries to error terminal event

### tests/unit/runners/codex/build-command.test.ts (36 cases)
- L26 `8b9da382` — returns a runner with name "codex" and structuredOutput true
- L35 `9e2376b0` — returns a frozen runner object
- L44 `66b1c7c1` — produces correct default argv (exec, json, full-auto, skip-git-repo-check, ephemeral, -- separator)
- L62 `f7eebbfa` — includes -- separator before prompt
- L72 `e18e9505` — includes -m <model> when provided
- L81 `db4c3f7f` — replaces --full-auto with --sandbox <mode> for non-preset modes
- L91 `05052640` — uses --full-auto for the default sandbox mode
- L100 `bd9e01e3` — writes temp schema file via FsService and adds --output-schema when ctx.schema is set
- L119 `bfe6f57b` — appends user flags and extraArgs after built-in flags but before --
- L135 `835c9682` — resets lastAgentMessage between invocations so stale output does not leak
- L169 `87e29692` — rejects --yolo in flags
- L176 `e11f5762` — rejects --dangerously-bypass-approvals-and-sandbox in flags
- L185 `2a2c7dbe` — rejects --config in extraArgs
- L194 `532506fa` — rejects --sandbox in extraArgs
- L203 `b1e85578` — rejects -c in extraArgs
- L212 `62c24fb8` — rejects --approval-mode in flags
- L221 `027691b8` — rejects --config=path prefix match
- L232 `9975ee76` — resolves when version is sufficient
- L241 `8b572fa9` — throws CodexVersionError when version is too old
- L250 `5e62bd64` — throws CodexVersionError with actionable message for old version
- L261 `6db1a5c7` — throws CodexVersionError when version output is unparseable
- L270 `a3232292` — only checks version once across multiple buildCommand calls
- L291 `4c68c03a` — reaches the version check instead of throwing on undefined deps when constructed with only options
- L316 `ad52a466` — builds the default interactive argv with --full-auto, --no-alt-screen, the -- separator, and the prompt
- L328 `a7d94a08` — adds --dangerously-bypass-hook-trust for interactive auto-stop runs
- L345 `1394ad61` — does not add --dangerously-bypass-hook-trust for interactive runs without auto-stop
- L353 `ff058b1a` — does not add --dangerously-bypass-hook-trust to autonomous argv
- L363 `5b2784e6` — does not duplicate --dangerously-bypass-hook-trust when a workflow already passes it
- L372 `b95a31cf` — keeps --no-alt-screen out of the autonomous (exec) argv
- L380 `31d3be39` — replaces --full-auto with --sandbox <mode> when the user picks a non-default sandbox
- L390 `59253e55` — places the --no-alt-screen default before user flags, then extraArgs, then the -- separator
- L409 `b6b06631` — treats a user-supplied --no-alt-screen as idempotent: it appears alongside the default without raising
- L421 `34cb984c` — throws synchronously when ctx.schema is set and ctx.mode is interactive
- L435 `af76142a` — applies the same flag denylist in interactive mode as in autonomous mode
- L444 `5c576314` — reuses the versionChecked closure flag across modes so the preflight runs once total
- L460 `951af576` — sets FORCE_COLOR=3 in env for interactive mode

### tests/unit/runners/codex/capture-lock.test.ts (5 cases)
- L5 `b81131b7` — returns independent lock instances that do not block each other
- L19 `ccbd358c` — serializes two acquires on the same lock in FIFO order
- L42 `99f105c6` — serializes three concurrent acquires strictly in FIFO order on a single lock
- L72 `58da1c0b` — ignores a second release call so subsequent acquires still work
- L88 `ac4b44c9` — does not let an unreleased acquire on one lock poison another lock

### tests/unit/runners/codex/capture-session-id.test.ts (7 cases)
- L57 `e37e19b8` — captures a thread_id when exactly one new rollout with a matching cwd appears
- L78 `0addae47` — returns ambiguous when two new rollouts share the workflow cwd
- L101 `39bfed46` — returns empty when the capture window elapses with no matching rollout
- L115 `e79628ea` — returns error when the underlying fs throws mid-poll, and still releases the lock
- L170 `0ccce00f` — serializes two concurrent captures sharing one lock so the second snapshot waits for the first capture to complete
- L207 `9e4a4f3f` — does not serialize captures across two independent lock instances
- L236 `607cdc57` — is undefined because Claude pre-sets its session id via --session-id

### tests/unit/runners/codex/capture-thread-id.test.ts (18 cases)
- L39 `b25b8594` — resolves snapshotReady before the first new file can appear and then yields the matching sessionId
- L69 `3b43a10e` — returns ambiguous when two new rollouts have a cwd matching the workflow cwd
- L93 `bf6056c5` — returns empty when no new rollout appears before the timeout fires
- L116 `96e98bf8` — returns error when the underlying fs throws unexpectedly mid-poll
- L159 `d6004a5e` — keeps polling and returns empty when a new rollout has a non-matching cwd
- L186 `563119dc` — treats a session_meta payload missing payload.id as not-ready and times out as empty
- L213 `c55cfb62` — treats a malformed first line as not-ready and times out as empty when the file never becomes parseable
- L237 `0a6976c7` — keeps retrying an unparseable file across iterations and succeeds once it parses
- L272 `85fd8fa7` — captures a rollout whose first session_meta line lands ~9s after the empty file appears (the codex 0.130 timing)
- L318 `e5f4b65f` — uses a default timeout long enough to survive >5s of an empty rollout file
- L354 `03580495` — resolves snapshotReady when today's sessions directory does not yet exist and then captures the new file
- L380 `53d290a9` — watches tomorrow's directory so a rollout that lands after midnight is still captured
- L410 `15c4d0bf` — returns error immediately when sessionsRoot resolution fails (no env override and no homedir)
- L427 `ce8e044a` — returns empty as soon as an AbortSignal fires before the next iteration
- L455 `a7c9949a` — returns the ORCH_CODEX_SESSIONS_ROOT override when set to a non-empty value
- L464 `c4e3e58b` — falls back to homedir + /.codex/sessions when the env override is absent
- L473 `b4b7bd6e` — treats an empty env override as absent
- L482 `2c462fcd` — returns undefined when neither the env override nor homedir yields a usable path

### tests/unit/runners/codex/codex-auto-stop.test.ts (14 cases)
- L41 `36fbf8ae` — points CODEX_HOME at a stable sibling of the real home, not a fresh temp dir
- L50 `33c809ac` — returns the same home on a second run so Codex trusts the hook only once
- L61 `964016c2` — does not throw on the second run when the inherited symlinks already exist
- L71 `b41c880f` — keeps the orch home in place after cleanup so trust state survives
- L83 `902467a0` — symlinks every real-home entry except config.toml and hooks.json
- L97 `ee634791` — inherits auth.json as a symlink that resolves to the real credentials
- L108 `d88f6cf6` — registers the signal-only Stop hook in hooks.json, not config.toml
- L121 `287215a8` — leaves the orch config.toml free of any inline hook block so Codex loads hooks one way
- L132 `20f077dd` — folds the user's existing hooks.json hooks alongside the orch hook
- L144 `ccaa13eb` — refreshes the orch hook every run so an updated command propagates
- L163 `867427d7` — does not duplicate the orch hook when the real hooks.json already declares it
- L192 `336984b8` — enables the hooks feature and disables the startup update check
- L204 `03a59ea4` — never writes back to the real ~/.codex config.toml or hooks.json
- L217 `a3a0de71` — preserves an existing orch config.toml so Codex-written trust state is not clobbered

### tests/unit/runners/codex/format-event.test.ts (14 cases)
- L14 `e5337aa5` — dispatches item.completed events to the per-item formatter
- L24 `3fd3184b` — returns an empty list for the suppressed event type %s
- L34 `1264856a` — renders an unknown info event.type as a single system fallback line
- L42 `2519c032` — renders agent_message as an assistant line, truncated at MAX_ASSISTANT_TEXT
- L61 `3528aeb6` — renders reasoning as a thinking marker line with no body
- L69 `b72cf2b6` — renders successful command_execution as a tool-call bash line with the first line of the command, truncated
- L84 `ee0bfd01` — renders non-zero exit command_execution as a tool-error with the exit code appended on a second line
- L106 `380aa5b3` — renders file_change as a tool-call edit line with a middle-ellipsised path
- L126 `d353d9ed` — renders mcp_tool_call as %s when is_error=%p
- L152 `dc180bcc` — renders web_search as a tool-call web line with the query
- L164 `2f5b0de0` — renders an error item as a tool-error line with the message truncated at MAX_ERROR_TEXT
- L181 `83b786cb` — renders an unknown item.type as a single system fallback line
- L189 `49ce2aee` — renders turn-complete as a done block with tokens, cache, reasoning, and a truncated result row, omitting rows whose data is absent
- L217 `9556d923` — renders error terminal as a failed block with one message row

### tests/unit/runners/codex/parse-events.test.ts (18 cases)
- L8 `7b74872a` — surfaces thread.started as a session-started info event with sessionId in payload
- L28 `dbcd9057` — parses turn.started as info event
- L35 `e664c4ec` — parses item.started as info event
- L44 `afeb87cd` — parses item.completed as info event
- L56 `5d7db7f8` — parses turn.completed as terminal turn-complete with usage data
- L74 `5068fe53` — parses turn.failed as terminal error with message
- L89 `7a84d19a` — parses stream-level error as terminal error with message
- L101 `1534d51d` — parses stream-level error without message field as "unknown error"
- L111 `f0c682e6` — parses unknown event types as info passthrough
- L121 `87f397ba` — returns null for malformed JSON
- L125 `4e645d45` — returns null for empty/whitespace lines
- L131 `027426b6` — returns null for JSON without type field
- L135 `eb624912` — returns null for non-object JSON (string, number, array)
- L150 `343a6e1c` — returns parsed JSON from _accumulatedText in terminal data
- L170 `82a71bb4` — returns undefined when no agent_message was accumulated
- L183 `616bc4ba` — returns raw text when _accumulatedText is not valid JSON
- L202 `74d73d2f` — returns undefined for error terminal event even if agent_message was accumulated
- L226 `38e8cccc` — returns undefined after closure reset when second invocation has no agent_message

### tests/unit/runners/default-view.test.ts (3 cases)
- L12 `43836109` — claude ships { kind: transcript, pane: right }
- L18 `45ed3c25` — codex ships { kind: transcript, pane: right }
- L26 `3f446bb7` — FakeRunner ships { kind: transcript, pane: right } so tests inherit the shape

### tests/unit/runners/define-runner.test.ts (11 cases)
- L33 `b96d3604` — accepts a valid adapter and returns a frozen copy
- L42 `a38a7e9b` — throws a readable error when name is missing
- L49 `aaf90462` — throws a readable error when supports is missing
- L56 `5d293675` — throws a readable error when buildCommand is missing
- L63 `4d007986` — throws a readable error when parseEvents is missing
- L70 `50c3fa41` — throws a readable error when extractStructuredOutput is missing
- L77 `a39cca66` — throws a readable error when toTranscriptLines is missing
- L84 `6b196b38` — does not leak config values in error messages
- L97 `5ee8c163` — narrows a turn-complete event to TerminalEvent
- L107 `3b61d883` — narrows an error event to TerminalEvent
- L117 `a98a6854` — returns false for an arbitrary info event

### tests/unit/runners/execute-interactive.test.ts (2 cases)
- L36 `f2eed1ad` — returns exit code 0 and elapsed duration on successful foreground process
- L53 `5e5fbff0` — returns non-zero exit code when the foreground process fails

### tests/unit/runners/execute.test.ts (3 cases)
- L117 `673f387c` — runRunner kills the subprocess when parseEvents throws mid-stream
- L138 `6d61e971` — runRunner kills the subprocess when the stdout iterator rejects
- L159 `e3ac0f56` — forwards every parsed RunnerEvent to the onEvent callback in order

### tests/unit/runners/fake/fake-runner.test.ts (9 cases)
- L35 `2f76a784` — emits the configured info events followed by a turn-complete terminal event
- L54 `d166cbf9` — surfaces the scripted structured output via extractStructuredOutput
- L71 `6e26fc08` — produces an error terminal event and a non-zero exit code when script sets failWith
- L85 `69ab20ec` — increments invocationCount each time buildCommand runs
- L100 `d07e08fb` — consumes scripts in FIFO order across two independent runs
- L119 `91af320a` — throws when the script queue is empty
- L126 `a9b2707d` — exposes prepareAutoStop as a function by default
- L133 `391f0616` — returns a no-op preparation (empty env, inert cleanup) from the default prepareAutoStop
- L143 `1f2ea789` — omits prepareAutoStop when constructed with supportsAutoStop:false

### tests/unit/runners/runner-resume.test.ts (10 cases)
- L34 `61cb515b` — returns argv that resumes the named session via claude --resume
- L42 `4349b5ed` — threads --model and configured flags into the resume argv
- L58 `c23bffff` — forwards FORCE_COLOR=3 in the resume env so Ink renders truecolor in tmux
- L68 `422a4b8f` — returns argv that resumes the named thread via codex resume with --no-alt-screen before the sessionId positional
- L76 `5d62e693` — threads configured flags into the resume argv after the sessionId positional
- L96 `0a8e67bd` — is undefined until withResumeCommand is called
- L102 `92dece2c` — returns the configured argv shape after withResumeCommand()
- L122 `a43f6d5b` — is undefined until withCaptureSessionId is called (mirrors a runner with no capture primitive)
- L128 `81ab3e49` — resolves snapshotReady and result with a synthetic sessionId after withCaptureSessionId() default
- L142 `245ca6da` — uses a caller-supplied implementation when provided

### tests/unit/runners/scripted-fake/addressing.test.ts (7 cases)
- L14 `e2e33b7b` — maps the cache-key separators > and : to distinct stems
- L18 `176c8eda` — leaves filesystem-safe characters untouched
- L22 `88a4bd15` — does not collide a control char with an adjacent literal (fixed-width hex)
- L31 `10bc1514` — encodes % itself so a raw key cannot forge an escape token
- L37 `404e7b0b` — never leaks > or : into the encoded stem
- L45 `70a2f56f` — derives the .acks and .ready siblings from the key under test-control
- L54 `cc20a9bc` — derives the same sibling layout from a baked control file path

### tests/unit/runners/scripted-fake/command-engine.test.ts (15 cases)
- L38 `7b6e88eb` — appends exactly one line for a non-empty type_and_send and continues
- L47 `4b2e74a8` — treats an empty type_and_send as a no-op in the sink (R3 mode parity)
- L56 `59d67944` — terminates with the default code 0 on finish()
- L65 `1f499797` — terminates with the supplied non-zero code on finish(2)
- L76 `9de939bf` — parses a bare line to type_and_send of that exact text (AE1)
- L80 `ee9ac564` — parses literal q and literal exit each to finish (AE2)
- L85 `01591dab` — ignores an empty line and a whitespace-only line (no op)
- L90 `9c893fda` — treats a quit word with trailing space as finish (trim-based)
- L94 `db5d84c1` — keeps a line that merely starts with q as type_and_send
- L100 `76f808df` — control type_and_send and a manual bare line yield the same op
- L111 `ca93d153` — control finish and a manual q yield the same op
- L122 `f6f504d8` — propagates an explicit finish code from the control channel
- L132 `4285b164` — returns an error result for malformed JSON without throwing
- L138 `a92a0f11` — returns an error result for a schema-invalid command without throwing
- L144 `ac895e65` — maps a legacy command to no engine op (handled by the entry directly)

### tests/unit/runners/scripted-fake/script-loader.test.ts (9 cases)
- L20 `2fc79c4b` — reads, parses, and validates a well-formed script file
- L38 `a999807f` — throws ScriptLoadError when the env var is unset
- L44 `692c0c53` — throws ScriptLoadError when the script file is missing
- L52 `ff40d0d8` — throws ScriptLoadError when the script file is not valid JSON
- L62 `12bc18b0` — throws ScriptLoadError when an entry has an unknown kind
- L71 `88b16054` — throws ScriptLoadError when wait-for-file is missing the gatePath field
- L80 `a56ff960` — throws ScriptLoadError when the top-level shape is not { steps: ... }
- L91 `ab24dab5` — returns the StepScript for the named step
- L105 `6467147f` — throws ScriptLoadError when the step name is not in the script

### tests/unit/runners/scripted-fake/scripted-fake-runner.test.ts (11 cases)
- L17 `dd422572` — refuses an empty stepName at construction time
- L21 `cacb7ef3` — builds an argv that re-invokes the entry script under bun
- L30 `922ef52c` — exports ORCH_LIFECYCLE_STEP_NAME so the entry process can pick its script row
- L38 `1d1ab518` — lets ctx.env win last over the runner-set step name (mergeEnv contract)
- L46 `d37f71fc` — parses NDJSON RunnerEvents from stdout
- L56 `42c20695` — returns null for blank lines and unparseable JSON instead of throwing
- L64 `e95d8fdc` — extracts structuredOutput from a turn-complete terminal event
- L76 `08770166` — returns undefined when the terminal event is an error
- L88 `882a0891` — surfaces a terminal/error event as a failed block in the transcript
- L100 `2f012c62` — surfaces an info event with text payload as an assistant line
- L114 `e64bde94` — reports the runner name and supports flags so defineRunner validation passes

### tests/unit/services/clock/fake-clock.test.ts (4 cases)
- L5 `be079575` — reports the initial value from now() when constructed with an explicit seed
- L11 `a310ffba` — defaults the initial value to zero when constructed with no argument
- L17 `68c53e65` — moves forward monotonically after advance(ms)
- L27 `c88bd5ab` — allows set(ms) to move the clock backward for state replay tests

### tests/unit/services/clock/sleep.test.ts (6 cases)
- L7 `7254a2e5` — resolves only after the requested duration has elapsed in real time
- L17 `5e99d1cc` — resolves immediately when given zero milliseconds
- L29 `9ee91d33` — leaves a sleep(50) promise unresolved until advance(50) has fired
- L50 `7ba528e6` — resolves multiple pending sleepers in dueAt order when advance crosses several deadlines
- L64 `a39631c9` — resolves a sleeper exactly once when advance crosses past its deadline
- L81 `9d943330` — resolves a sleep(0) call on the next advance(0) tick

### tests/unit/services/fs/bun-fs-service.test.ts (4 cases)
- L8 `6c94fb1a` — refuses to remove the filesystem root
- L14 `34e6b639` — refuses to remove the current user home directory
- L20 `834b8bb2` — refuses to remove the direct parent of the home directory
- L26 `23d6f9da` — allows removing an ordinary file under a real temp directory

### tests/unit/services/fs/fake-fs-service-remove.test.ts (4 cases)
- L10 `cd91aa88` — removes the target and every descendant entry
- L28 `b4d36cec` — removes a leaf directory cleanly when it has no children
- L39 `f9dc7c8d` — is a no-op when the target does not exist (matches force: true)
- L49 `135e0d07` — does not delete siblings whose path shares a prefix (e.g. /a vs /aaa)

### tests/unit/services/fs/fake-fs-service.test.ts (11 cases)
- L15 `fd1d50e8` — round-trips writeFile and readFile for a single path
- L25 `b3dc714a` — flips exists from false to true after writeFile and back to false after remove
- L38 `c594f4ce` — performs an atomic rename that removes the source and creates the destination
- L49 `1983e4e7` — creates nested paths when mkdir is called with recursive true
- L59 `d6b6bee4` — throws when mkdir is called non-recursively on a missing parent
- L65 `51ecca3a` — matches glob patterns **/*.json and foo/*.md over the in-memory tree
- L80 `c5f5a06b` — lists direct children via readDir
- L92 `db470cdc` — reports size and mtimeMs via stat on a file
- L104 `a43bf330` — returns a unique temp directory path per tempDir invocation
- L115 `3a4b0787` — overwrites existing files on writeFile without requiring an explicit remove
- L126 `94a6d074` — writeFile honors an injected clock for mtime

### tests/unit/services/fs/symlink.test.ts (3 cases)
- L7 `0324468e` — creates a link that exists() reports true and that resolves to the target on read
- L18 `3c01c642` — removing the link leaves the target intact
- L32 `79a7f756` — creates a real symlink that exists() reports true and that resolves to the target

### tests/unit/services/git/bun-git-service.test.ts (33 cases)
- L16 `a78de2a8` — spawns `git rev-parse HEAD --` in the given cwd and returns stdout trimmed
- L28 `6531bd1b` — throws GitCommandError on non-zero exit
- L41 `4d2effdc` — returns false when `git diff --quiet` exits 0 (clean)
- L48 `60dd1a21` — returns true when `git diff --quiet` exits 1 (dirty)
- L55 `33ad5202` — throws GitCommandError on exit > 1
- L64 `45031601` — rejects a SHA that does not match the hex pattern without spawning git
- L74 `733cfa83` — uses --name-only and returns raw stdout
- L87 `d3ccfaf6` — rejects unsafe SHA arguments before spawning git
- L97 `44bf9fbb` — invokes git with the argv shape documented by the port (captured per command)
- L114 `71accfe0` — returns true when git status --porcelain stdout is empty
- L124 `e74aca25` — returns false for a modified file
- L134 `4fb89bb4` — returns false for an untracked file
- L144 `9101a5cb` — throws GitCommandError on non-zero exit
- L156 `2a8b9ed3` — spawns git add . with correct argv and cwd
- L165 `ab5aff58` — throws GitCommandError when git add fails
- L177 `546fe145` — spawns git commit -m then git rev-parse HEAD and returns the SHA
- L190 `4706ec99` — throws GitCommandError when git commit fails
- L200 `67806024` — propagates GitCommandError when rev-parse HEAD fails after successful commit
- L213 `a720fcca` — strips credential URLs from GitCommandError stderr
- L233 `9d6bd517` — returns the absolute path from git rev-parse --show-toplevel
- L245 `93dca0e8` — throws GitCommandError when git rev-parse --show-toplevel fails
- L256 `c9577731` — redacts $HOME paths in repoRoot stderr before throwing
- L278 `06787e4c` — returns true when git show-ref --verify --quiet exits 0
- L287 `583f96a0` — returns false when git show-ref --verify --quiet exits 1
- L296 `ff641b53` — throws GitCommandError when git show-ref exits with code >= 2
- L307 `76e44b55` — returns true when the path appears as a worktree line in --porcelain output
- L327 `bf1ba041` — returns false when the path is absent from --porcelain output
- L339 `a84d4387` — does not match a partial path prefix as a worktree entry
- L351 `c65e6139` — throws GitCommandError when git worktree list fails
- L365 `6a781064` — spawns git worktree add -b <branch> -- <path> <fromRef> and resolves to undefined
- L389 `d9cbefdd` — passes the user-provided fromRef through to git
- L402 `08de3029` — addWorktree includes "--" separator before path and fromRef
- L430 `f5ce7a20` — throws GitCommandError with redacted stderr when git worktree add fails

### tests/unit/services/git/fake-git-service.test.ts (24 cases)
- L5 `bf7470ca` — returns the scripted SHA for the matching cwd
- L14 `4e44c796` — throws a loud error when no SHA is scripted for the cwd
- L20 `1fb8fe16` — isolates scripted state per cwd
- L31 `f71534e0` — returns the scripted boolean for the matching (cwd, baseline) pair
- L38 `7fd7d883` — throws a loud error when the (cwd, baseline) pair is unscripted
- L46 `5a3c3836` — isolates scripted state per baseline within one cwd
- L57 `1974816c` — returns the scripted diff text for the matching (cwd, baseline) pair
- L64 `8341864b` — throws a loud error when the (cwd, baseline) pair is unscripted
- L74 `e950df0c` — returns the scripted boolean for the matching cwd
- L81 `99c9ebf5` — returns false when scripted as dirty
- L88 `a9458628` — throws a loud error when no isClean is scripted for the cwd
- L96 `1cd00793` — is a no-op that resolves without error
- L104 `2dee1837` — returns the scripted SHA for the matching cwd
- L113 `f5f37a7c` — throws a loud error when no commit SHA is scripted for the cwd
- L121 `27dd904c` — returns the scripted repo root for the matching cwd
- L130 `f0dadbb3` — throws a loud error when no repoRoot is scripted for the cwd
- L136 `440637ee` — isolates scripted state per cwd
- L147 `5c56f744` — returns the scripted boolean per (cwd, branch) pair
- L156 `99f937a3` — throws a loud error when the (cwd, branch) pair is unscripted
- L166 `41757b23` — returns the scripted boolean per (cwd, path) pair
- L175 `2f67c051` — throws a loud error when the (cwd, path) pair is unscripted
- L185 `c1c23469` — throws a loud error when addWorktree has not been allowed for the cwd
- L197 `69aa6e42` — resolves to undefined and records the call when allowed
- L218 `d22b6164` — records every call in invocation order

### tests/unit/services/process/fake-process-service.test.ts (7 cases)
- L16 `4d6beb1d` — emits the scripted stdout lines and exit code for a matching argv
- L28 `af1ded30` — emits the scripted stderr lines symmetrically with stdout
- L42 `f1357635` — serves two distinct argvs independently with no cross-talk
- L59 `36f0e0c9` — consumes scripts for the same argv in FIFO order
- L76 `4e49704f` — throws FakeProcessService: no scripted response for argv ... when the queue is empty
- L84 `b8da1e19` — reports exitCode -1 via wait() when kill() interrupts the iteration with an AbortError
- L108 `8af006ac` — does not resolve wait() before the stdout iterator has emitted all scripted lines

### tests/unit/services/process/foreground.test.ts (5 cases)
- L8 `a1a6a162` — returns the scripted exit code when a foreground process completes
- L18 `a49e0d54` — returns a non-zero exit code for a failed foreground process
- L28 `ca5b6cd9` — reports exitCode -1 when killed before wait resolves
- L39 `648008d1` — throws when no foreground response is scripted for the argv
- L47 `4bcb76cb` — consumes foreground scripts in FIFO order for the same argv

### tests/unit/services/process/line-framer.test.ts (7 cases)
- L23 `8564e59c` — splits a single chunk into one yield per newline-delimited line
- L29 `c088a687` — strips a single trailing carriage return from each line for CRLF tolerance
- L35 `388b2fcf` — yields the trailing residual when EOF arrives with a non-empty buffer
- L41 `3920edc1` — completes silently when EOF arrives with an empty buffer
- L47 `851b1ffd` — yields nothing for an empty input stream
- L53 `5815212f` — reassembles lines that are split across chunk boundaries
- L59 `cd8317b9` — decodes multi-byte UTF-8 characters that span chunk boundaries

### tests/unit/services/process/merge-env.test.ts (8 cases)
- L10 `0b2a6456` — passes arbitrary keys from processEnv through verbatim
- L32 `17e59927` — filters undefined values from processEnv at the boundary
- L39 `53ebc8b6` — produces no undefined values in the result
- L47 `f6fda947` — returns an empty object when processEnv, extras, and ctxEnv are all empty
- L53 `c6c8f4a3` — lets extras override processEnv on conflict
- L59 `0bbd7800` — lets ctxEnv override extras on conflict
- L65 `f9aa8da7` — lets ctxEnv override processEnv on conflict
- L71 `15650c2c` — applies all three layers in order: processEnv < extras < ctxEnv

### tests/unit/services/process/raw-streams.test.ts (13 cases)
- L22 `5ceabd0f` — omits writeStdin and stdoutBytes from the handle when rawStreams is omitted (back-compat probe)
- L34 `d8f83d6a` — omits writeStdin and stdoutBytes from the handle when rawStreams is explicitly false
- L46 `5b583886` — exposes writeStdin so a write reaches the child and is read back from stdin
- L75 `046203e4` — accumulates raw stdout bytes including escape sequences that line-framing would otherwise split
- L98 `7ad8bd13` — keeps the line-framed stdout view and stdoutBytes() reading from the same tee — both views observe the child output
- L118 `11f2eaf5` — reports stdoutBytes() as monotonically growing between two reads (no reset)
- L142 `c3ca85f0` — keeps each spawn independent — a rawStreams: false spawn after a rawStreams: true one has no leftover stdin/stdoutBytes
- L166 `8f8ff36a` — omits writeStdin and stdoutBytes when rawStreams is omitted, even if stdoutBytes is configured on the response
- L178 `b08cc7d6` — exposes stdoutBytes() returning the configured Buffer when rawStreams: true
- L190 `2ba5eed3` — yields the logical lines of the configured stdoutBytes via the line-framed stdout iterable
- L201 `ea9c8e7e` — falls back to the legacy stdout: string[] field for line-framing when stdoutBytes is unset and rawStreams: true
- L213 `be30b8c6` — appends each writeStdin call to the configured stdinObservations buffer array
- L232 `1cdc97ae` — does not throw when writeStdin is called and stdinObservations is unset (best-effort sink)

### tests/unit/services/prompt/confirm-service.test.ts (14 cases)
- L11 `6e48320b` — returns the default when input is the empty string
- L16 `497e417d` — returns the default when input is whitespace only
- L21 `69806e22` — parses single-letter yes/no case-insensitively
- L28 `0d5441c1` — parses full-word yes/no case-insensitively
- L35 `820babdc` — returns undefined on unrecognised input
- L43 `d411e090` — uppercases the default side
- L74 `74598d14` — returns true on "y" and writes the question with [y/N] suffix to the output stream
- L83 `99ba8277` — returns false on "n"
- L89 `f2a7be1e` — returns the default on empty input
- L95 `8b993510` — re-prompts on unrecognised input then accepts a valid answer
- L103 `1827f49d` — returns the default after 3 unrecognised attempts and warns
- L113 `22ad0d6d` — returns scripted answers in FIFO order
- L119 `52a585a2` — records each call with its question and default
- L129 `189d4433` — throws a clear error when the scripted queue is exhausted

### tests/unit/services/prompt/fake-prompt-service.test.ts (4 cases)
- L18 `62434d9f` — returns the scripted result for the configured step
- L31 `adbe6ac6` — throws with a "configure via .when()" message for an unscripted step
- L39 `8060efd6` — records calls in arrival order
- L51 `c30b222e` — exposes the spec passed to each call

### tests/unit/services/prompt/ink-app.test.tsx (8 cases)
- L112 `864dfd71` — renders the question, all field labels, and all button labels
- L127 `0a150511` — cancels on Esc with the values typed so far
- L147 `9ecaf444` — cancels on Ctrl-C with the values typed so far
- L166 `0ec134e9` — typing into the focused TextInput updates the field value at submit
- L194 `3a0bcdb7` — Tab cycles focus from field 0 to field 1 to button 0 to button 1
- L214 `4a8f3031` — Shift-Tab cycles focus backwards
- L237 `03814a82` — auto-focuses the first button when there are no fields
- L258 `dd2d69ab` — resolves only once even if the user mashes Enter after submit

### tests/unit/services/prompt/readline-prompt-service.test.ts (5 cases)
- L53 `d6a4e94a` — reads a field then the chosen button and resolves with the labels
- L69 `b882db03` — treats empty input on the choice prompt as button[0]
- L82 `f1923ff8` — re-prompts on out-of-range button choice with an "invalid choice; pick 1-N" line
- L96 `10587bc8` — cancels after MAX_RETRIES (5) consecutive out-of-range choices
- L106 `0f5bb437` — writes one prompt line per field, in declared order

### tests/unit/services/tmux/external-mouse-events.test.ts (7 cases)
- L10 `7242161e` — encodes a left-button press as ESC[<0;col;rowM
- L14 `ec137dab` — encodes a left-button release as ESC[<0;col;rowm
- L18 `7900139b` — encodes middle-button events with code 1
- L22 `e2935b10` — encodes right-button events with code 2
- L28 `447faecb` — throws when col is non-positive
- L34 `2e10ca9f` — throws when row is non-positive
- L40 `8de31ee6` — throws when col is non-integer

### tests/unit/services/tmux/has-session-server.test.ts (12 cases)
- L19 `b5409e92` — returns true when tmux has-session exits 0
- L29 `f8b947b6` — returns false when tmux reports a missing session on a live server
- L41 `f70cbfa1` — returns false when the tmux server itself is down
- L53 `3a08f9cd` — returns false when tmux exits 1 with empty stderr (silent missing-session)
- L63 `c2a01ddf` — throws TmuxCommandError on unexpected tmux failures
- L77 `f3ae00cb` — returns true when tmux list-sessions exits 0
- L89 `df87abf8` — returns false when tmux reports "no server running"
- L101 `31c31c8a` — throws TmuxCommandError on unexpected stderr
- L113 `adbd3163` — reports presence after createSession on the matching socket
- L122 `28581bd1` — returns false for unknown sockets even after a session was created elsewhere
- L131 `0245800e` — reflects killSession by reporting the session as gone
- L143 `2a16e663` — honors setSessions for scripted server-up / server-down setups

### tests/unit/services/tmux/session-init.test.ts (12 cases)
- L32 `34cac097` — writes a config file containing history-limit >= 50000, mouse on, remain-on-exit on, prefix None, exit-empty off, and destroy-unattached off
- L59 `5f23dae8` — passes the config path to createSession via the configPath option
- L72 `681e4f37` — wipes all four key tables before installing any bindings
- L94 `8e313ec8` — binds MouseDrag1Border to resize-pane -M as the first root-table binding
- L108 `3adce2fd` — installs the six root-table bindings first, in MouseDrag, MouseDown, M-Left, M-Right, WheelUpPane, WheelDownPane order
- L130 `5513ac11` — WheelUpPane uses the smart-wheel rule that falls back to copy-mode -e on a normal text pane
- L147 `47b1ec5c` — WheelDownPane uses the smart-wheel rule WITHOUT a copy-mode fallback (no surprise enter on scroll-down at the live tail)
- L167 `548a6721` — after the root bindings, installs the copy-mode allowlist under both copy-mode and copy-mode-vi tables
- L183 `963fb6a0` — the copy-mode allowlist binds q, Escape, and C-c to the cancel command so the user can always exit copy-mode
- L203 `3641100c` — the copy-mode allowlist binds j/k/Up/Down/PageUp/PageDown/g/G and the wheel to the documented scroll commands
- L237 `15f020a6` — installs the persistent status-right hint after the bindings are in place
- L260 `3867a859` — installs the pane-died hook after the bindings so unbind-key cannot wipe it

### tests/unit/services/tmux/tmux-service-window.test.ts (4 cases)
- L12 `d6b524c8` — accepts well-formed tmux window ids like @0 and @42
- L17 `31892c0e` — rejects pane id shapes like %42 (the pane prefix must not pass)
- L21 `3ed202ee` — rejects the empty string
- L25 `378dd324` — rejects non-digit suffixes like @abc and decimals like @1.2

### tests/unit/services/tmux/tmux-service.test.ts (43 cases)
- L16 `e207e3c2` — accepts tmux pane ids shaped like %42
- L20 `b0c4fdbd` — accepts single-digit pane ids like %0
- L24 `f9de99c5` — rejects strings that do not start with a percent sign
- L28 `b50efd00` — rejects strings containing shell metacharacters
- L32 `5c3ef792` — rejects the empty string
- L38 `86d82056` — accepts lowercase alphanumerics with dashes
- L42 `faf25026` — rejects uppercase characters
- L46 `a88fed1a` — rejects whitespace
- L50 `ab0638c4` — rejects shell metacharacters that could escape run-shell templates
- L56 `776ae303` — rejects the empty string
- L66 `7db459b6` — preserves the exit code and stderr passed to the constructor
- L75 `cf0f2d6d` — survives an instanceof check after being thrown
- L87 `9186b6a5` — records every method call with its options in order
- L101 `79e2dfb3` — exposes recordedCalls as a read-only view that reflects later calls
- L116 `e98b6de0` — returns scripted pane ids in FIFO order
- L129 `88fc2ecd` — falls back to a synthetic pane id when none is scripted
- L140 `c0c65195` — returns the next scripted createSession pane id when one is queued
- L150 `376ffb4b` — falls back to an auto-synthesized pane id when no createSession id is scripted
- L162 `66250d40` — does not consume the splitPane pane-id queue when createSession runs
- L178 `41cef215` — throws the next scripted createSession error and still records the call
- L193 `0676f094` — records the new pane id in paneIdsForSession after createSession resolves
- L203 `890f90e3` — returns an empty array from paneIdsForSession for unknown sessions
- L210 `7f819762` — clears paneIdsForSession when killSession fires for that session
- L222 `67ad2949` — clears every paneIdsForSession entry on the socket when killServer fires
- L238 `64821346` — returns scripted display results in FIFO order
- L259 `654f7552` — throws a loud error when no result is scripted
- L278 `f013fbf3` — records the capture call and returns the scripted result
- L293 `b8b9f455` — returns an empty string when no capture result is scripted
- L304 `3df1c052` — records the pipe command and append flag for observe-mode assertions
- L324 `5a4bd4f1` — returns scripted pane lines in FIFO order
- L344 `de60436a` — returns an empty list when no result is scripted
- L356 `2ce5dbd4` — records the session teardown call so host tests can assert it fired
- L370 `8e9bea91` — stays a no-op when called twice so teardown can be idempotent
- L383 `ce98c830` — records argv verbatim even when entries contain shell metacharacters
- L406 `0ed0eee4` — records killRunning=false when the caller opts out of -k
- L423 `7e37078b` — records the swap call with src and dst pane ids in the order received
- L437 `334fd329` — records the argv shape separately from the command shape with env and cwd fields
- L457 `c2cc2b0b` — records argv elements verbatim even when they contain shell metacharacters
- L475 `1f0b11a2` — records a wait without timeoutMs so interactive callers can assert the no-timeout contract
- L489 `d797fcdd` — records the timeoutMs value verbatim when a caller supplies one
- L511 `3defa889` — includes -P -F #{pane_id} after the new-session geometry flags so tmux prints the initial pane id
- L545 `42f4dc85` — returns the pane id parsed from stdout when a holder argv is appended after -P -F
- L583 `5494b9d4` — throws TmuxCommandError when stdout has no parseable pane id (e.g. empty)

### tests/unit/services/types.test.ts (4 cases)
- L5 `c0c7caff` — rejects the empty string as an invalid path
- L9 `7059b8d0` — rejects paths that contain a ".." traversal segment
- L14 `59ce73de` — rejects paths that contain a NUL byte
- L18 `ebcb86b4` — accepts a legitimate absolute path and returns it branded

### tests/unit/setup/reap-test-sockets.test.ts (12 cases)
- L51 `dd2b5bf7` — reaps a reserved orch-test- socket whose owner pid is dead
- L66 `a8985e53` — skips a reserved orch-test- socket whose owner pid is alive (parallel live run)
- L81 `71178f1d` — skips a production-shaped orch-r- socket regardless of liveness (prefix gate, incident repro)
- L96 `2a58d3b8` — skips a bare orch- socket whose first segment is not "test"
- L111 `833dcb65` — skips an orch-test- entry whose pid segment is non-numeric
- L126 `9b31ab8a` — reaps only the dead-pid socket when live and dead sockets sit side by side
- L144 `e39cf2b0` — still removes the socket file when killServer reports the server already gone
- L162 `fba824dd` — reaps purely on pid-liveness with no age input — a "new" dead socket is still reaped
- L178 `74163e3d` — skips a missing or unreadable directory without throwing
- L195 `d1b3b2cf` — reports this process as alive
- L199 `f587de62` — reports a reaped child process as dead (ESRCH)
- L206 `b9734479` — errs safe — treats pid 1 (alive, EPERM when not root) as alive

### tests/unit/state/run-id.test.ts (9 cases)
- L8 `bbee2586` — produces r-YYYY-MM-DD-HHMMSS-xx format
- L16 `e843fc1d` — uses clock for date and time portions in local time
- L28 `25538edb` — derives the time slug from clock.getHours/getMinutes/getSeconds
- L44 `9f9e4ffd` — two calls within the same second produce distinct IDs
- L59 `d9fd0336` — validates correct format
- L67 `9adb55aa` — throws on invalid format: missing time/suffix segments
- L71 `20d1e9c7` — throws on invalid format: arbitrary string
- L75 `17228311` — throws on invalid format: uppercase suffix
- L79 `24e250bb` — rejects the old 6-char-slug format and accepts the new format

### tests/unit/state/run-registry.test.ts (8 cases)
- L15 `f28a853c` — listRuns returns empty array when base directory does not exist
- L24 `2895ce8c` — listRuns returns empty array when base directory is empty
- L34 `b9a67861` — listRuns returns sorted run IDs
- L52 `638ca381` — listRuns ignores non-matching directory entries
- L65 `19687b5a` — findLatest returns undefined when no runs exist
- L74 `73958b6f` — findLatest returns the most recent run
- L88 `9e1bfad9` — findByPrefix returns matching runs
- L103 `ed4fd5f2` — findByPrefix returns empty array when nothing matches

### tests/unit/state/state-store-runner-name-and-capture-error.test.ts (6 cases)
- L16 `0bd43bcc` — round-trips a step entry with sessionId, runnerName, and sessionIdCaptureError all set
- L37 `7416a54e` — round-trips a step entry with neither new field set (no null drift)
- L51 `9ee9a2f1` — loads a pre-feature v5 state file (no new keys) cleanly
- L83 `c46533b3` — accepts all three valid sessionIdCaptureError enum values
- L105 `d3e9d2be` — rejects an unknown sessionIdCaptureError value at schema-validation time
- L133 `32f1a5a4` — rejects an empty-string runnerName at schema-validation time

### tests/unit/state/state-store-session-id.test.ts (4 cases)
- L16 `b667e602` — round-trips a step entry with sessionId set
- L29 `d84a4fa9` — round-trips a step entry with sessionId absent (no null drift)
- L41 `19ba7c1f` — loads a pre-Phase-3 v5 state file (no sessionId key) cleanly
- L75 `9f7e4b14` — rejects an empty-string sessionId at schema-validation time

### tests/unit/state/state-store-subpath.test.ts (6 cases)
- L20 `feadc60d` — round-trips an entry with subPath set to a single-level chain
- L38 `5a75fc3a` — round-trips an entry with subPath set to a nested chain
- L55 `7e4a2e11` — round-trips an entry with insideParallel: true
- L71 `12bc3b30` — omits sub-fields from the on-disk JSON when not set (no null drift)
- L87 `35cb66c8` — loads a pre-feature v5 state file (no sub-fields) cleanly
- L118 `b505e3c3` — accepts an empty array as a legitimate subPath (root step that opted in)

### tests/unit/state/state-store-v5.test.ts (17 cases)
- L21 `f728cb06` — round-trips a v5 state file with all current fields
- L35 `da6156f8` — setStatus writes endedAt on terminal states
- L46 `3a53e983` — setStatus without endedAt does not add the field
- L57 `8caddad2` — initRun without meta uses defaults
- L68 `dd951241` — saveStep preserves v5 fields through a write cycle
- L82 `3a0bbeb0` — initRun persists args when supplied
- L95 `aa908c72` — initRun omits args when not supplied
- L104 `e6f6b7b5` — initRun persists empty-string prompt as distinct from undefined
- L113 `31674309` — setArgs overwrites persisted args on an existing run
- L127 `cd864860` — setArgs throws when the run does not exist
- L133 `26db45ae` — saveStep preserves args across write cycles
- L143 `a6bb2486` — setStatus preserves args
- L155 `2bb56140` — rejects a v1 state file with wipe hint
- L174 `917a4538` — rejects a v2 state file with wipe hint
- L186 `4b1579d4` — rejects a v3 state file with wipe hint
- L200 `594f1b4f` — rejects a v4 state file with wipe hint
- L213 `3965a527` — rejects unknown schemaVersion with StateCorruptionError

### tests/unit/state/state-store.test.ts (21 cases)
- L82 `5f1b0883` — runDir resolves <basePath>/<runId> without touching the filesystem
- L91 `696dcd50` — loadRun returns undefined for a non-existent run
- L99 `093e36da` — saveStep then loadRun round-trips a single step entry
- L114 `c52df2fe` — saveStep then loadRun round-trips multiple step entries
- L130 `b21529ff` — saveStep overwrites an existing step with the same name
- L143 `c06a08d6` — saveStep creates the run directory if it does not exist
- L152 `e149dd49` — loadRun throws StateCorruptionError on corrupted JSON
- L162 `ff26be5f` — atomic write leaves original state untouched when rename fails
- L184 `3e1121e8` — saveStep wraps JSON.stringify errors with step name and cause
- L200 `407194d2` — initRun creates an empty running state
- L214 `f5cae472` — initRun is idempotent — calling twice does not clear existing steps
- L227 `c300dcdd` — setStatus transitions status from running to completed
- L238 `4acf889c` — setStatus transitions status from running to crashed
- L249 `d8e489ca` — setStatus throws for a non-existent run
- L256 `2a05d5fe` — loadRun rethrows EACCES errors instead of returning undefined
- L269 `f1a99fb7` — saveStep cleans up its .tmp file when the rename step fails
- L289 `051031eb` — saveStep uses a unique tmp path per invocation
- L304 `77ce508c` — loadRun returns a branded RunId, not a raw string
- L320 `24b2e590` — concurrent saveStep calls for the same runId do not lose entries
- L337 `1d098d56` — concurrent saveStep calls for different runIds do not interfere
- L356 `7adf2dc0` — write queue cleans up after chain goes idle

### tests/unit/validators/check.test.ts (9 cases)
- L22 `b14d17a5` — returns ok for a bare `true`
- L29 `fe14cf2b` — returns a failure with a default reason for a bare `false`
- L36 `ee384690` — returns a failure with the string as the reason
- L43 `cb1dd553` — passes through a full ValidatorResult
- L54 `7ba567da` — throws a programmer-error when the function returns undefined
- L61 `6e29dbee` — lets thrown exceptions bubble up (the executor catches them)
- L70 `410d4931` — receives ctx.value as its only positional argument
- L83 `b2b91673` — is renamed to check@<stepName>#<index> when normalized by the executor helper
- L92 `916a382b` — a single-check shorthand still gets auto-renamed when wrapped into an array

### tests/unit/validators/define-validator.test.ts (8 cases)
- L28 `734d2f9a` — returns a Validator with the given name directly (not a factory)
- L35 `9319f560` — registers the validator under its name so getValidator can retrieve it
- L41 `a6c3fce7` — getValidator returns undefined for an unknown name
- L45 `53cb2b4d` — throws DuplicateValidatorError when the same name is registered twice
- L51 `1272cdb3` — normalizes the return shape the same way check does
- L60 `91357210` — runs the registered function against ctx.value
- L72 `7857d308` — registration is isolated across tests via __resetValidatorRegistryForTests
- L81 `76a18e6c` — carries the validator name on the instance

### tests/unit/validators/file-produced.test.ts (9 cases)
- L20 `5ca73bfa` — carries a name that embeds the glob for clear failure messages
- L26 `65ecad09` — returns ok when at least one file matches the glob under cwd
- L36 `711b724c` — returns a failure with glob and cwd in the reason when no files match
- L50 `c7af3c7e` — throws synchronously on an empty glob at factory time
- L54 `cf65d827` — throws synchronously on a whitespace-only glob at factory time
- L58 `3bdbb923` — throws synchronously on an absolute path glob at factory time
- L62 `9c91089b` — throws synchronously on a tilde-prefixed glob at factory time
- L66 `a90e93e0` — throws synchronously on a glob containing a .. component at factory time
- L70 `367b63b6` — short-circuits on the first match without consuming the full iterator

### tests/unit/validators/git-commit-created.test.ts (4 cases)
- L29 `fe266a14` — declares headSha as a capability need
- L35 `3d06ed0f` — returns ok when the current HEAD differs from the baseline
- L44 `e8644ea3` — returns a failure when HEAD has not moved since the baseline
- L56 `58aabb88` — returns a distinct failure reason when the baseline was never captured

### tests/unit/validators/git-diff-created.test.ts (4 cases)
- L29 `cf622ac1` — declares headSha as a capability need so the executor captures a baseline
- L35 `4d49ac33` — returns ok when hasDiffSince reports a diff relative to the baseline
- L44 `6baec02d` — returns a failure with the short baseline when there is no diff
- L57 `6be104ba` — returns a distinct failure reason when the baseline was never captured

### tests/unit/validators/validation-error.test.ts (7 cases)
- L6 `6a58c034` — renders every failure in the message with name and reason
- L19 `2ebcb241` — exposes failures as a readonly array on the instance
- L32 `008858c4` — is instanceof Error and instanceof ValidationError across the transpile boundary
- L40 `0db6cdc1` — carries the stepName brand on the instance
- L48 `bcc2f0e5` — ok() produces a passing ValidatorResult
- L52 `52276817` — fail(reason) produces a failing result without a hint
- L56 `0c77658d` — fail(reason, hint) attaches the hint

### tests/unit/workflows/parse-phases.test.ts (16 cases)
- L13 `8c5e0a0b` — returns a single phase for a one-block artifact without padding it
- L22 `9d9d4e8b` — returns N phases in source order for an N-block artifact
- L32 `748a553f` — treats the description as optional, returning an empty string when absent
- L40 `ab71065c` — preserves a multi-line description verbatim
- L50 `99401f31` — returns all blocks and emits a warning when more than four phases parse
- L61 `6320246e` — does not warn at exactly four phases
- L72 `2bb43368` — throws PhaseParseError on an empty string
- L76 `d63e796d` — throws PhaseParseError on whitespace-only input
- L80 `506572a9` — throws when the delimiter is present but every block is empty
- L86 `8df0cd60` — throws when there is text but no delimiter at all
- L92 `d3cc587d` — ignores a preamble before the first delimiter
- L101 `13320502` — tolerates a trailing delimiter with no block after it
- L109 `3d455a0c` — tolerates blank lines between the delimiter and the title
- L117 `1fe51d97` — tolerates surrounding whitespace on the delimiter line
- L125 `89914e36` — parses an artifact written with CRLF line endings
- L139 `9dcd3647` — exposes a fixed artifact path under .orch/

### tests/unit/workflows/resolve-builtin.test.ts (10 cases)
- L14 `41a4d42c` — is true for a name carrying the orch:: prefix
- L18 `5bf9c08b` — is false for a bare workflow name
- L22 `ffd8d3a3` — is false for the empty string
- L26 `0c817c02` — is false when orch:: appears mid-string rather than as a prefix
- L32 `5e4a3382` — resolves orch::work-cc to the packaged module under orch source, not cwd
- L38 `76c7a989` — resolves orch::work-codex to the packaged codex module under orch source
- L44 `6ffe7f8f` — returns an absolute, source-anchored path (guards the dev-vs-installed decision)
- L51 `9c27360d` — resolves a bare name identically to its orch:: form (prefix is optional here)
- L55 `e8327407` — throws naming the available built-ins for an unknown built-in name
- L68 `bdbee258` — rejects an inherited Object.prototype key with the unknown-built-in error, not a TypeError

