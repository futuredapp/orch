export type Path = string & { readonly __brand: 'Path' }

/**
 * Validating smart constructor for the `Path` branded type.
 *
 * Rejects inputs that cannot safely be used as filesystem paths:
 *  - empty strings (no target)
 *  - strings containing a NUL byte (`\0`) — POSIX path terminator, used in injection
 *  - strings with any `..` path component (directory traversal)
 *
 * The cast is kept private to this module: there is no exported escape hatch
 * beyond `path()`. External callers must go through this function so that
 * every string that crosses a service boundary has been screened.
 */
export const path = (s: string): Path => {
  if (s.length === 0) {
    throw new Error('path(): empty string is not a valid path')
  }
  if (s.includes('\0')) {
    throw new Error('path(): NUL byte is not allowed in a path')
  }
  for (const segment of s.split('/')) {
    if (segment === '..') {
      throw new Error(`path(): ".." component is not allowed (got ${JSON.stringify(s)})`)
    }
  }
  return s as Path
}
