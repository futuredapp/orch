/**
 * `addressing.ts` — the single source of truth for how a predictable-fake
 * instance is *addressed* across the process boundary.
 *
 * Three independent consumers must agree byte-for-byte on the env-var names
 * and the control-file layout, or every `waitForAck` / `waitForReady` silently
 * times out:
 *
 *   - the executor (`src/core/workflow.ts`) writes the env vars at spawn (U1),
 *   - the entry process (`__entry.ts` / `interactive-entry.ts`) reads the env
 *     vars and resolves its own control paths (U3 / U4),
 *   - the real-tmux driver (`tests/helpers/real-tmux/agent-handle.ts`) resolves
 *     the *same* paths from the harness's run state dir + derived key (U5).
 *
 * Because three units depend on these names + encoding, they live here rather
 * than as scattered string literals. No module-import side effects: this file
 * exports only constants and pure functions.
 *
 * ## Logical address vs. transport filename
 *
 * The *logical address* is the run-time `deriveStepKey` result — it may contain
 * `>` (sub-path) and `:` (vars-hash) separators. The *transport filename* is an
 * **injective** (collision-free) encoding of that key. The load-bearing
 * property is injectivity, NOT invertibility: distinct keys MUST map to
 * distinct filenames so two keys (`a>b` and `a:b`) cannot collide on the same
 * control file (which would silently break per-instance / per-run isolation).
 * No consumer decodes a filename back to a key — every consumer applies the
 * identical forward `encodeKey`.
 */

import * as nodePath from 'node:path'

// The addressing env-var names live on the Runner port (the executor↔runner
// contract) so `src/core/` can name them without importing a concrete runner.
// Re-exported here so scripted-fake consumers keep one import surface for the
// whole addressing contract (names + encoding + path layout).
export {
  ORCH_PARENT_PID_ENV,
  ORCH_RUN_STATE_DIR_ENV,
  ORCH_STEP_KEY_ENV,
} from '../types.ts'

/** Sub-directory under the run state dir that holds all control transports. */
export const CONTROL_SUBDIR = 'test-control'

const CONTROL_EXT = '.ndjson'

/**
 * Injectively encode a logical key into a filesystem-safe filename stem.
 *
 * Every character outside `[A-Za-z0-9._-]` (including `%` itself) is replaced by
 * `%` + its UTF-16 code unit as **fixed-width 4-digit** hex. The fixed width is
 * load-bearing for injectivity: with variable-width hex, `"" + "0"`
 * (`"%1" + "0"`) and `""` (`"%10"`) would both encode to `"%10"`. A
 * fixed 4-digit field means every `%XXXX` token consumes exactly four hex
 * digits, so distinct keys can never produce the same encoding — the property
 * the whole addressing contract (R10) relies on. Encoding the full unsafe set
 * (not just `>`/`:`) also keeps the filename safe for arbitrary `as:` labels.
 */
export function encodeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, (ch) => {
    const code = ch.charCodeAt(0)
    return `%${code.toString(16).toUpperCase().padStart(4, '0')}`
  })
}

/** The resolved on-disk transport paths for one instance. */
export interface ControlPaths {
  /** `<runStateDir>/test-control` — created lazily by the entry. */
  readonly controlDir: string
  /** `<controlDir>/<encodeKey(key)>.ndjson` — the NDJSON command file. */
  readonly controlPath: string
  /** `<controlPath>.acks` — per-sequence `.ack` confirmations live here. */
  readonly ackDir: string
  /** `<controlDir>/<encodeKey(key)>.ready` — the idle-waiting readiness marker. */
  readonly readyPath: string
  /**
   * `<controlDir>/<encodeKey(key)>.render` — the durable render log.
   *
   * The interactive entry (U4) renders each `type_and_send` line to BOTH the
   * live PTY pane and this file. Interactive mode has no headless transcript
   * pipeline (no `formatted_output` tee), so this file is the interactive
   * analog: a durable on-disk render oracle a driver polls instead of scraping
   * the pane (Tier-5 findings — pane scrapes are racy under fast teardown).
   * The headless entry leaves this unused.
   */
  readonly renderLogPath: string
}

/**
 * The `.acks` / `.ready` sibling layout for a given control file. The single
 * place the suffix convention is written, so the run-time-derived path
 * (`resolveControlPaths`) and the baked-`controlPath` backward-compat branch in
 * the entry cannot drift on it.
 */
export function controlPathsForControlFile(controlPath: string): ControlPaths {
  const stem = controlPath.endsWith(CONTROL_EXT)
    ? controlPath.slice(0, -CONTROL_EXT.length)
    : controlPath
  return {
    controlDir: nodePath.dirname(controlPath),
    controlPath,
    ackDir: `${controlPath}.acks`,
    readyPath: `${stem}.ready`,
    renderLogPath: `${stem}.render`,
  }
}

/**
 * Resolve every control-transport path for an instance from its run state dir
 * and logical key. The one formula both the entry (U3/U4) and the driver (U5)
 * call so they cannot drift.
 */
export function resolveControlPaths(args: {
  readonly runStateDir: string
  readonly key: string
}): ControlPaths {
  const controlDir = nodePath.join(args.runStateDir, CONTROL_SUBDIR)
  const controlPath = nodePath.join(controlDir, `${encodeKey(args.key)}${CONTROL_EXT}`)
  return controlPathsForControlFile(controlPath)
}
