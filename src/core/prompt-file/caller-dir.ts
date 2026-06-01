import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Path } from '../../services/types.ts'
import { path } from '../../services/types.ts'
import { PromptFileError } from './errors.ts'

// callerDir — discover the dirname of the file that called `skipFn`.
//
// Scans the stack, finds the first frame whose function name matches
// `skipFn.name`, and returns the dirname of the next frame (the caller).
//
// Why not `Error.captureStackTrace(err, skipFn)`? Bun (1.3.x) honors the call
// but yields an empty stack — so the V8-style "drop frames at and above
// skipFn" approach is unusable. Walking the stack by function name is
// engine-agnostic and works for both `step.define` (skipFn=defineStep) and
// `loadPrompt` (skipFn=loadPrompt). The function name is the public identifier
// in the V8/Bun stack format and is preserved across module loading.
//
// Stack format is parsed defensively to tolerate Bun and Node variants:
//   at <fn> (file:///abs/path.ts:10:5)
//   at file:///abs/path.ts:10:5
//   at <fn> (/abs/path.ts:10:5)
//   at /abs/path.ts:10:5

const FRAME_RE = /(?:\(|^|\s)((?:file:\/\/)?\/[^\s()]+?):\d+:\d+\)?$/

export function callerDir(skipFn: (...args: never[]) => unknown): Path {
  const stack = new Error().stack ?? ''
  const dir = parseCallerDir(stack, skipFn.name)
  if (dir === undefined) {
    throw new PromptFileError(
      'callerDir: could not parse a non-internal caller frame from the stack — ' +
        'pass an absolute path or use the "@/..." sentinel to resolve against the project root',
      { cause: 'read-failed' },
    )
  }
  return dir
}

// Scans stack lines for the first frame whose function name matches skipName,
// then returns the dirname of the next frame with a parseable file path.
// Exported for unit testing.
export function parseCallerDir(stack: string, skipName: string): Path | undefined {
  const lines = stack.split('\n')
  let pastSkip = false
  for (const raw of lines) {
    const line = raw.trim()
    if (!line.startsWith('at ')) continue
    if (!pastSkip) {
      if (frameMatchesName(line, skipName)) {
        pastSkip = true
      }
      continue
    }
    const filePath = extractFilePath(line)
    if (filePath === undefined) continue
    return path(dirname(filePath))
  }
  return undefined
}

function frameMatchesName(line: string, name: string): boolean {
  // Strip "at " prefix, then check the function-name token before "(file://"
  // or before the bare path. Names can be prefixed with "Object." / "Async."
  // / "Module.", so use a word-boundary match.
  const head = line.slice(3).split(' (')[0] ?? ''
  // Bare-path frames have no function name; head will start with "file://"
  // or "/" — those never match a non-empty name.
  if (head.startsWith('file://') || head.startsWith('/')) return false
  const tokens = head.split('.')
  const last = tokens[tokens.length - 1]
  return last === name
}

function extractFilePath(line: string): string | undefined {
  const match = FRAME_RE.exec(line)
  if (match === null) return undefined
  const captured = match[1]
  if (captured === undefined) return undefined
  return captured.startsWith('file://') ? fileURLToPath(captured) : captured
}
