/**
 * math-duel — the smallest "fan-out two runners, then compare deterministically"
 * workflow.
 *
 * Three stages:
 *
 *   1. pose     (Claude, autonomous)   → { problem, answer }   — invents a small
 *                                         arithmetic word problem AND its ground-truth answer.
 *   2. solve    (Claude ‖ Codex)       → { answer, reasoning } — both runners solve the
 *                                         SAME problem in parallel, each returning typed output.
 *   3. compare  (no agent, pure TS)    → writes duel-results.md — deterministic scoring against
 *                                         the ground truth. No model involved; just data.
 *   4. check    (Claude, autonomous)   → { same, note } — re-reads the scorecard and judges,
 *                                         independently, whether the two runners agreed.
 *
 * The point: stages 1–2 + 4 use agents + structured output (`returns: schema(...)`),
 * but the core judgement in stage 3 is plain TypeScript. Agents produce values;
 * your code decides what they mean — and a final agent sanity-checks that code.
 *
 * Usage:
 *   bunx orch run math-duel                       # Claude invents the problem
 *   bunx orch run math-duel "two-step % word problem"   # → args.prompt steers the problem
 *
 * Requires `claude` and `codex` (>= 0.118.0) on PATH.
 */

import { writeFile } from 'node:fs/promises'
import { BunFsService, BunProcessService, claude, codex, parallel, schema, step, workflow, z } from 'orch'

const OUTPUT_FILE = 'duel-results.md'

// --- schemas ----------------------------------------------------------------

const PROBLEM_SCHEMA = z.object({
  problem: z.string().min(1).max(400),
  answer: z.number(),
})

const SOLUTION_SCHEMA = z.object({
  answer: z.number(),
  reasoning: z.string().min(1).max(600),
})

const CHECK_SCHEMA = z.object({
  same: z.boolean(),
  note: z.string().min(1).max(300),
})

// --- runners ----------------------------------------------------------------

// Autonomous Claude: bypass permission prompts so `-p` mode can finish unattended.
const claudeAgent = claude({ bare: false, permissions: 'bypass' })

// Codex needs its own deps (schema temp files + version preflight). `read-only`
// is enough — the solver computes, it never writes the workspace.
const codexAgent = codex(
  { sandbox: 'read-only' },
  { fs: new BunFsService(), ps: new BunProcessService() },
)

// --- step definitions -------------------------------------------------------

const POSE = step.define('pose', {
  agent: claudeAgent,
  prompt:
    'Invent ONE small arithmetic word problem a 10-year-old could solve in their head ' +
    '(whole numbers, single integer answer). Return JSON { "problem": string, "answer": number } ' +
    'where `answer` is the correct numeric result. Do not reveal the answer inside `problem`.',
  returns: schema(PROBLEM_SCHEMA),
})

// One step shape per runner — `agent` can't be swapped via run() overrides, so the
// two solvers are distinct definitions sharing the same schema. The prompt is
// supplied per-call (it depends on the problem posed at runtime).
const SOLVE_CLAUDE = step.define('solve-claude', {
  agent: claudeAgent,
  prompt: '<supplied per run() — depends on the posed problem>',
  returns: schema(SOLUTION_SCHEMA),
})

const SOLVE_CODEX = step.define('solve-codex', {
  agent: codexAgent,
  prompt: '<supplied per run() — depends on the posed problem>',
  returns: schema(SOLUTION_SCHEMA),
})

// A final agent that re-reads the written scorecard and judges, on its own,
// whether the two runners landed on the same answer. This double-checks the
// deterministic comparison from stage 3 against a fresh pair of eyes.
const CHECK = step.define('check', {
  agent: claudeAgent,
  prompt:
    `Read \`${OUTPUT_FILE}\` in the working directory. Decide whether the two runners (Claude ` +
    `and Codex) gave the SAME final answer. Return JSON { "same": boolean, "note": string } ` +
    `where note is one short sentence explaining your judgement. Read only the file; do not edit it.`,
  returns: schema(CHECK_SCHEMA),
})

// --- workflow body ----------------------------------------------------------

export default workflow('math-duel', async (run, args) => {
  const steer = args.prompt?.trim()

  // 1. Pose the problem (and its ground-truth answer).
  const { problem, answer: truth } = await run(POSE, {
    extraPrompt: steer ? `Theme/style hint: ${steer}` : undefined,
  })

  // 2. Both runners solve the SAME problem, in parallel.
  const solvePrompt =
    `Solve this problem and return JSON { "answer": number, "reasoning": string }. ` +
    `Keep reasoning to one or two sentences.\n\nProblem: ${problem}`

  const [claudeSol, codexSol] = await parallel([
    run(SOLVE_CLAUDE, { prompt: solvePrompt }),
    run(SOLVE_CODEX, { prompt: solvePrompt }),
  ])

  // 3. Deterministic comparison — no agent. Plain TypeScript decides who won.
  const claudeCorrect = claudeSol.answer === truth
  const codexCorrect = codexSol.answer === truth
  const agree = claudeSol.answer === codexSol.answer

  const verdict =
    claudeCorrect && codexCorrect
      ? 'Both correct'
      : claudeCorrect
        ? 'Claude correct, Codex wrong'
        : codexCorrect
          ? 'Codex correct, Claude wrong'
          : 'Both wrong'

  const report = [
    '# Math Duel Results',
    '',
    `**Problem:** ${problem}`,
    `**Ground-truth answer:** ${truth}`,
    '',
    '| Runner | Answer | Correct? | Reasoning |',
    '| --- | --- | --- | --- |',
    `| Claude | ${claudeSol.answer} | ${claudeCorrect ? '✅' : '❌'} | ${claudeSol.reasoning} |`,
    `| Codex | ${codexSol.answer} | ${codexCorrect ? '✅' : '❌'} | ${codexSol.reasoning} |`,
    '',
    `**Runners agree:** ${agree ? 'yes' : 'no'}`,
    `**Verdict:** ${verdict}`,
    '',
  ].join('\n')

  await writeFile(OUTPUT_FILE, report)
  console.log(`[math-duel] ${verdict} (agree: ${agree}). Wrote ${OUTPUT_FILE}.`)

  // 4. A final agent re-reads the scorecard and judges agreement independently.
  const check = await run(CHECK)
  const matches = check.same === agree
  console.log(
    `[math-duel] checker says same=${check.same} (${check.note}). ` +
      `${matches ? 'Matches' : 'DISAGREES WITH'} the deterministic comparison.`,
  )
})
