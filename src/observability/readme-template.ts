// ---------------------------------------------------------------------------
// Run-local README.md generator.
// ---------------------------------------------------------------------------
//
// A small, plain-string template so a maintainer (human or AI) dropped into
// `.orch/state/<runId>/logs/` can answer "what is this, and how do I
// navigate it?" without leaving the directory.
//
// No templating engine — one function, one string, ~40 lines. If this grows
// past 60 lines (CLAUDE.md rule #5), split it; don't reach for Handlebars.

export interface ReadmeContext {
  readonly runId: string
  readonly workflowName: string
  readonly mode: 'plain' | 'two-pane' | string
  readonly debug: boolean
  readonly startedAt: string
  readonly orchVersion: string
}

export function renderRunReadme(ctx: ReadmeContext): string {
  const debugSection = ctx.debug
    ? DEBUG_SECTION
    : "(Run without `--debug` — heavy cross-run captures absent. Re-run with `--debug` for tmux pipe-pane, subprocess spawns, and orch's internal trace. Per-step raw + formatted output is always-on under `agents/<step>/`.)"

  return `# Run ${ctx.runId}

- **Workflow:** ${ctx.workflowName}
- **Mode:** ${ctx.mode}
- **Started:** ${ctx.startedAt}
- **orch version:** ${ctx.orchVersion}
- **Debug captures:** ${ctx.debug ? 'on' : 'off'}

This directory is machine-first, human-second. Every file is append-only
NDJSON (one JSON object per line) or a whole JSON/markdown file. No rotation,
no size caps — \`--debug\` is opt-in.

## Baseline files (always present)

- \`spawns.ndjson\` — one line per agent launch: argv, envKeys, cwd, mode, exitCode, durationMs.
- \`events.ndjson\` — merged cross-step RunnerEvents; tagged with \`stepSpanId\`.
- \`lifecycle.ndjson\` — host + tmux + step lifecycle (step:start / step:complete / …).
- \`timeline.ndjson\` — source-tagged mirror of the three streams above. Start here.
- \`run.meta.json\` — reproducibility snapshot (argv, envKeys, runner versions, os, …).
- \`agents/<stepName>/\` — per-step folder: \`session.json\` (landing page), \`events.ndjson\` (parsed), \`raw_output.ndjson\` + \`raw_stderr.log\` (subprocess bytes), \`formatted_output.ansi\` + \`.txt\` (verbatim host bytes; \`cat\` replays).

Silent steps omit \`formatted_output.*\`. Interactive steps contain only
\`session.json\` (tmux owns the PTY). On resume, append-only files in the
folder are truncated so the folder reflects only the latest attempt.

## Grep recipes

One step, every file:

    grep '<stepSpanId>' logs/*.ndjson

All failed steps:

    grep '"type":"step:failed"' logs/lifecycle.ndjson

Every tool call the agent made (Claude runner):

    jq 'select(.event.type | test("^tool_"))' logs/events.ndjson

## Debug captures (\`--debug\` only)

${debugSection}
`
}

const DEBUG_SECTION = `- \`tmux/<paneId>.log\` — tmux \`pipe-pane\` capture (two-pane mode only).
- \`subprocesses.ndjson\` — every non-agent subprocess spawn routed through ProcessService.
- \`orch.log\` — orch's own internal trace (view/mode resolution, state writes, signal handling).`
