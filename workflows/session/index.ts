/**
 * session — bootstrap an isolated worktree from a one-line description, then
 * chain interactive Claude / Codex sessions inside it until you stop.
 *
 * Pipeline:
 *   1. slug            autonomous, claude(haiku)   → { slug }
 *   2. createWorktree(`session/<slug>`, {
 *        enter: true,
 *        postCreate: ['bash install.sh', 'mkdir -p docs/sessions/<slug>'],
 *      })             → worktree built + installed, cwd switched in
 *   3. first-session   interactive, claude (EMPTY)  → you drive; resumes on exit
 *   4. loop (<= MAX_SESSIONS):
 *        ask-<i>       buttons [claude, codex, stop] + notes
 *                        - stop / cancel / Esc → break
 *        session-<i>   interactive claude|codex, seeded with notes (or empty)
 *
 * The only scripted prompt is the trivial slug one-liner. Every chained
 * session is bare interactive — seeded purely by whatever you type into the
 * checkpoint's `notes` field (blank notes = empty session).
 *
 * Usage:
 *   bunx orch run session --mode=two-pane "what this session is about"
 *
 * Preconditions: `claude` (and `codex`, if you pick that button) on PATH.
 * The session steps are interactive, so `--mode=plain` fails with
 * ViewResolutionError. install.sh seeds .env from the main repo and runs
 * `bun install` inside the new worktree.
 */

import { z } from 'zod'
import { ask, createWorktree, schema, step, workflow } from '../../src/core/index.ts'
import { claude, codex, type Runner } from '../../src/runners/index.ts'

// `--dangerously-skip-permissions` is only honored when IS_SANDBOX=1 is in the
// env; setting it here propagates to every spawned Claude step.
process.env.IS_SANDBOX = '1'

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'

// Human-driven loop: each pass needs a button press, so this cap only exists
// to stop an infinite loop on a misbehaving host — not as a real limit.
const MAX_SESSIONS = 50

// Structural only — the kebab-case rule lives in the slug prompt, not here.
const SLUG_SCHEMA = z.object({ slug: z.string() })

/** A sandboxed, plugin/skill-loaded interactive Claude tagged with a name. */
function claudeSession(name: string): Runner {
  return claude({
    bare: false,
    flags: ['--dangerously-skip-permissions', '--name', name],
  })
}

/** Interactive Codex with write access to the worktree. */
function codexSession(): Runner {
  return codex({ sandbox: 'workspace-write' })
}

const SLUG = step.define('slug', {
  agent: claude({ model: HAIKU_MODEL, bare: false }),
  prompt:
    'Return a 2-4 word kebab-case slug naming this session (lowercase a-z, digits, ' +
    'and hyphens only; no leading digit, no trailing hyphen).\n\n' +
    'Session description:\n{{description}}',
  returns: schema(SLUG_SCHEMA),
})

const CHECKPOINT = ask({
  name: 'next',
  question: 'Start another session in this worktree? (stop ends the chain)',
  fields: { notes: { placeholder: "what the next session should do (blank = empty session)" } },
  buttons: ['claude', 'codex', 'stop'],
  defaultWhenNoninteractive: { button: 'stop' },
})

export default workflow('session', async (run, args) => {
  if (args.prompt === undefined || args.prompt.trim() === '') {
    throw new Error('session requires a prompt. Usage: orch run session "<what this session is about>"')
  }
  const description = args.prompt.trim()

  // 1. Slug — short folder/branch name derived from the description.
  const { slug } = await run(SLUG, { vars: { description } })

  // 2. Worktree — materialize, install, make the session dir, and switch cwd in.
  //    A non-zero exit from any postCreate line aborts the workflow here.
  await run(
    createWorktree(`session/${slug}`, {
      enter: true,
      postCreate: ['bash install.sh', `mkdir -p docs/sessions/${slug}`],
    }),
  )

  // 3. First session — bare interactive Claude. You drive it; on exit we resume.
  const FIRST_SESSION = step.define('first-session', {
    mode: 'interactive',
    agent: claudeSession(`${slug}-1`),
  })
  await run(FIRST_SESSION)

  // 4. Chain — after each session, ask which agent to launch next (or stop).
  const CLAUDE_SESSION = step.define('claude-session', {
    mode: 'interactive',
    agent: claudeSession(slug),
  })
  const CODEX_SESSION = step.define('codex-session', {
    mode: 'interactive',
    agent: codexSession(),
  })

  for (let i = 1; i <= MAX_SESSIONS; i++) {
    const answer = await run(CHECKPOINT, { as: `next-${i}` })
    if (answer.cancelled || answer.button === 'stop') break

    const step_ = answer.button === 'codex' ? CODEX_SESSION : CLAUDE_SESSION
    const notes = answer.notes.trim()
    const overrides = notes.length > 0 ? { as: `session-${i}`, prompt: notes } : { as: `session-${i}` }
    await run(step_, overrides)
  }
})
