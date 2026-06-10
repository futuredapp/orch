/**
 * tic-tac-toe — Claude vs Codex play tic-tac-toe in alternating moves.
 *
 * Pipeline (per game iteration, up to MAX_GAMES = 5):
 *   1. assign-roles    command(bash): random X/O + first mover + game id, emitted as JSON
 *   2. (inline)        mkdir games/<gameId>/
 *   3. init-board      command(bash): writes games/<gameId>/board.txt = "___\n___\n___\n"
 *   4. setup-trace     command(bash): writes games/<gameId>/setup.md with the assignment
 *   5. move loop (up to 9 moves):
 *        a. move-<g>-<i>-<player>  claude OR codex; mode alternates by pairs
 *                                  rewrites board.txt and writes move-<NN>-<player>.md
 *        b. check-<g>-<i>          autonomous claude(haiku), returns
 *                                  { gameOver, winner, draw, reason }
 *      break on gameOver
 *   6. result-<g>      autonomous claude(haiku); writes games/<gameId>/result.md
 *   7. play-again-<g>  ask() with buttons ['play again', 'stop']; loops or breaks
 *
 * Mode pattern (per the requirement): moves 1-2 interactive, 3-4 autonomous,
 * 5-6 interactive, 7-8 autonomous, 9 interactive. Player turn alternates by
 * parity of move index starting from firstMover (random).
 *
 * Resume-safety:
 *   - All randomness is produced inside `command()` steps, which orch memoizes
 *     by step name. On resume, JSON output is replayed, so gameId / X / O / first
 *     mover are stable.
 *   - All step names are suffixed with `${g}` (and `${i}` inside the move loop)
 *     so re-runs of the same step in the workflow have unique memoization keys.
 *
 * Usage:
 *   bunx orch run tic-tac-toe
 *   bunx orch run tic-tac-toe --mode=two-pane         # required for interactive moves
 *   bunx orch run tic-tac-toe --noninteractive        # ask() defaults to 'stop'; ⚠️ interactive
 *                                                       moves will throw under --mode=plain.
 */

import { mkdir } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { BunFsService, BunProcessService, ask, claude, codex, command, schema, step, workflow, z, type Runner } from 'orch'

process.env.IS_SANDBOX = '1'

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
const MAX_GAMES = 5
const MAX_MOVES = 9

const ROLES_SCHEMA = z.object({
  claudeSymbol: z.enum(['X', 'O']),
  codexSymbol: z.enum(['X', 'O']),
  firstMover: z.enum(['claude', 'codex']),
  gameId: z.string().regex(/^[0-9]{8}-[0-9]{6}-[0-9]+$/),
})

const CHECK_SCHEMA = z.object({
  gameOver: z.boolean(),
  winner: z.enum(['X', 'O']).nullable(),
  draw: z.boolean(),
  reason: z.string().min(1).max(300),
})

const bunFs = new BunFsService()
const bunPs = new BunProcessService()

function claudeFor(name: string): Runner {
  return claude({
    bare: false,
    flags: ['--dangerously-skip-permissions', '--name', name],
  })
}

function codexAgent(): Runner {
  return codex({ sandbox: 'workspace-write' }, { fs: bunFs, ps: bunPs })
}

function judgeAgent(): Runner {
  return claude({ model: HAIKU_MODEL, bare: false })
}

function movePrompt(args: {
  playerName: 'claude' | 'codex'
  symbol: 'X' | 'O'
  opponentSymbol: 'X' | 'O'
  moveIndex: number
  gameId: string
}): string {
  const { playerName, symbol, opponentSymbol, moveIndex, gameId } = args
  const padded = String(moveIndex).padStart(2, '0')
  return (
    `You are ${playerName} playing tic-tac-toe as "${symbol}" against "${opponentSymbol}".\n\n` +
    `Read the current board from \`games/${gameId}/board.txt\`. ` +
    `It is exactly 3 lines of 3 chars: "_" = empty cell, "X" or "O" = played. ` +
    `Rows are 1-3 top→bottom, columns 1-3 left→right.\n\n` +
    `Choose ONE empty cell and update the file:\n` +
    `1. Replace exactly one "_" with "${symbol}" — keep every other cell unchanged.\n` +
    `2. Overwrite \`games/${gameId}/board.txt\` with the new 3-line board. ` +
    `Exactly 3 chars per line, no trailing spaces, single "\\n" between lines, trailing newline at EOF.\n\n` +
    `Then write a trace at \`games/${gameId}/move-${padded}-${playerName}.md\` with:\n` +
    `- A title: \`# Move ${moveIndex} — ${playerName} ("${symbol}")\`\n` +
    `- The cell you played as \`row N, col M\`\n` +
    `- A 3-5 sentence paragraph explaining your choice: what you blocked, what you set up, ` +
    `what threats remain.\n\n` +
    `Hard constraints:\n` +
    `- Do NOT play on a non-empty cell.\n` +
    `- Do NOT modify any file outside \`games/${gameId}/\`.\n` +
    `- Do NOT run git, do NOT install anything, do NOT inspect other games' folders.\n` +
    `- Stop after both files (board.txt and your trace) are written.`
  )
}

function checkPrompt(gameId: string): string {
  return (
    `Inspect the tic-tac-toe board at \`games/${gameId}/board.txt\`. ` +
    `3 lines of 3 chars: "_" = empty, "X" or "O" played.\n\n` +
    `Return JSON matching the schema: ` +
    `{ "gameOver": boolean, "winner": "X" | "O" | null, "draw": boolean, "reason": string }.\n\n` +
    `Rules:\n` +
    `- "X" wins if three Xs share any row, column, or diagonal. Same for "O".\n` +
    `- Draw = no "_" cells AND no winner.\n` +
    `- Otherwise gameOver=false, winner=null, draw=false.\n\n` +
    `\`reason\` is one short sentence: e.g. "row 2 of X" / "anti-diagonal of O" / ` +
    `"no win line yet — N empty cells". Do not modify any file.`
  )
}

function resultPrompt(args: {
  gameId: string
  claudeSymbol: 'X' | 'O'
  codexSymbol: 'X' | 'O'
  firstMover: 'claude' | 'codex'
}): string {
  const { gameId, claudeSymbol, codexSymbol, firstMover } = args
  return (
    `Read \`games/${gameId}/board.txt\` and every \`games/${gameId}/move-*.md\` trace file ` +
    `in numeric order.\n\n` +
    `Write \`games/${gameId}/result.md\` containing:\n` +
    `- A \`## Result\` heading with one-line outcome (winner X / winner O / draw).\n` +
    `- The final board rendered inside a fenced code block.\n` +
    `- A 3-5 sentence narrative of the game, referring to specific moves by their number.\n` +
    `- A \`## Players\` bullet list: "Claude played \\"${claudeSymbol}\\"", ` +
    `"Codex played \\"${codexSymbol}\\"", "${firstMover} moved first".\n\n` +
    `Stop after writing result.md. Do not modify any other file.`
  )
}

const PLAY_AGAIN = ask({
  name: 'play-again',
  question: 'Game over. Play another?',
  buttons: ['play again', 'stop'],
  defaultWhenNoninteractive: { button: 'stop' },
})

export default workflow('tic-tac-toe', async (run) => {
  for (let g = 1; g <= MAX_GAMES; g++) {
    const assignBash =
      `set -eu; ` +
      `if [ $((RANDOM % 2)) -eq 0 ]; then cs=X; xs=O; else cs=O; xs=X; fi; ` +
      `if [ $((RANDOM % 2)) -eq 0 ]; then fm=claude; else fm=codex; fi; ` +
      `gid="$(date +%Y%m%d-%H%M%S)-$RANDOM"; ` +
      `printf '{"claudeSymbol":"%s","codexSymbol":"%s","firstMover":"%s","gameId":"%s"}\\n' ` +
      `"$cs" "$xs" "$fm" "$gid"`
    const ASSIGN = command(`assign-roles-${g}`, {
      argv: ['/bin/bash', '-c', assignBash],
      onFailure: 'halt',
    })
    const assignResult = await run(ASSIGN)
    const roles = ROLES_SCHEMA.parse(JSON.parse(assignResult.stdout.trim()))
    const { claudeSymbol, codexSymbol, firstMover, gameId } = roles

    const gameDir = nodePath.join('games', gameId)
    await mkdir(gameDir, { recursive: true })

    const INIT_BOARD = command(`init-board-${g}`, {
      argv: [
        '/bin/bash',
        '-c',
        `mkdir -p "${gameDir}" && printf '___\\n___\\n___\\n' > "${gameDir}/board.txt"`,
      ],
      onFailure: 'halt',
    })
    await run(INIT_BOARD)

    const setupBash =
      `cat > "${gameDir}/setup.md" <<EOF\n` +
      `# Game ${g} setup\n\n` +
      `- Game id: ${gameId}\n` +
      `- Claude plays: ${claudeSymbol}\n` +
      `- Codex plays: ${codexSymbol}\n` +
      `- First mover: ${firstMover}\n` +
      `EOF\n`
    const SETUP = command(`setup-trace-${g}`, {
      argv: ['/bin/bash', '-c', setupBash],
      onFailure: 'halt',
    })
    await run(SETUP)

    console.log(
      `[tic-tac-toe] game ${g} · id=${gameId} · ` +
        `claude=${claudeSymbol} codex=${codexSymbol} firstMover=${firstMover}`,
    )

    let gameOver = false
    for (let i = 1; i <= MAX_MOVES; i++) {
      const claudeMovesThisTurn =
        (firstMover === 'claude' && i % 2 === 1) ||
        (firstMover === 'codex' && i % 2 === 0)
      const playerName: 'claude' | 'codex' = claudeMovesThisTurn ? 'claude' : 'codex'
      const symbol = claudeMovesThisTurn ? claudeSymbol : codexSymbol
      const opponentSymbol = claudeMovesThisTurn ? codexSymbol : claudeSymbol

      const pairIndex = Math.floor((i - 1) / 2)
      const isInteractive = pairIndex % 2 === 0

      const moveAgent: Runner = claudeMovesThisTurn
        ? claudeFor(`${gameId}-move-${i}`)
        : codexAgent()

      const MOVE = step.define(`move-${g}-${i}-${playerName}`, {
        agent: moveAgent,
        mode: isInteractive ? 'interactive' : 'autonomous',
        prompt: movePrompt({ playerName, symbol, opponentSymbol, moveIndex: i, gameId }),
      })
      await run(MOVE)

      const CHECK = step.define(`check-${g}-${i}`, {
        agent: judgeAgent(),
        prompt: checkPrompt(gameId),
        returns: schema(CHECK_SCHEMA),
      })
      const verdict = await run(CHECK)
      console.log(
        `[tic-tac-toe] game ${g} move ${i} → ${playerName}(${symbol}) · ` +
          `mode=${isInteractive ? 'interactive' : 'autonomous'} · ` +
          `gameOver=${verdict.gameOver} winner=${verdict.winner ?? 'none'} ` +
          `draw=${verdict.draw} · ${verdict.reason}`,
      )
      if (verdict.gameOver) {
        gameOver = true
        break
      }
    }

    if (!gameOver) {
      console.log(`[tic-tac-toe] game ${g} hit the move cap with no verdict; treating as draw.`)
    }

    const RESULT = step.define(`result-${g}`, {
      agent: judgeAgent(),
      prompt: resultPrompt({ gameId, claudeSymbol, codexSymbol, firstMover }),
    })
    await run(RESULT)

    const decision = await run(PLAY_AGAIN, { as: `play-again-${g}` })
    if (decision.cancelled || decision.button === 'stop') {
      console.log(`[tic-tac-toe] stopping after game ${g}.`)
      break
    }
    console.log(`[tic-tac-toe] starting a fresh game (#${g + 1}).`)
  }
})
