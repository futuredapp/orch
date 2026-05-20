import type { Clock } from '../clock/index.ts'
import type { Path } from '../types.ts'
import { path } from '../types.ts'
import type { FsService } from './fs-service.ts'

interface FileEntry {
  data: string
  mtimeMs: number
}

export class FakeFsService implements FsService {
  #files = new Map<string, FileEntry>()
  #dirs = new Set<string>()
  #tempCounter = 0
  readonly #clock: Clock | undefined

  constructor(deps: { readonly clock?: Clock } = {}) {
    this.#clock = deps.clock
    // Root always exists
    this.#dirs.add('/')
  }

  async readFile(p: Path): Promise<string> {
    const entry = this.#files.get(p)
    if (!entry) {
      throw new Error(`ENOENT: no such file: ${p}`)
    }
    return entry.data
  }

  async writeFile(p: Path, data: string): Promise<void> {
    const parent = parentDir(p)
    if (parent && !this.#dirs.has(parent)) {
      throw new Error(`ENOENT: parent directory does not exist: ${parent}`)
    }
    this.#files.set(p, { data, mtimeMs: this.#clock?.now() ?? Date.now() })
  }

  async appendFile(p: Path, data: string): Promise<void> {
    const parent = parentDir(p)
    if (parent && !this.#dirs.has(parent)) {
      throw new Error(`ENOENT: parent directory does not exist: ${parent}`)
    }
    const existing = this.#files.get(p)
    const next = (existing?.data ?? '') + data
    this.#files.set(p, { data: next, mtimeMs: this.#clock?.now() ?? Date.now() })
  }

  async rename(from: Path, to: Path): Promise<void> {
    const entry = this.#files.get(from)
    if (!entry) {
      throw new Error(`ENOENT: no such file: ${from}`)
    }
    this.#files.set(to, entry)
    this.#files.delete(from)
  }

  async mkdir(p: Path, opts?: { readonly recursive?: boolean }): Promise<void> {
    if (opts?.recursive) {
      const segments = p.split('/').filter(Boolean)
      let current = ''
      for (const seg of segments) {
        current += `/${seg}`
        this.#dirs.add(current)
      }
    } else {
      const parent = parentDir(p)
      if (parent && !this.#dirs.has(parent)) {
        throw new Error(`ENOENT: parent directory does not exist: ${parent}`)
      }
      this.#dirs.add(p)
    }
  }

  async exists(p: Path): Promise<boolean> {
    return this.#files.has(p) || this.#dirs.has(p)
  }

  async *glob(pattern: string, opts?: { readonly cwd?: Path }): AsyncIterable<Path> {
    const cwd = opts?.cwd ?? path('/')
    const regex = globToRegex(pattern)

    for (const filePath of this.#files.keys()) {
      if (!filePath.startsWith(cwd === '/' ? '/' : `${cwd}/`)) continue
      const relative = cwd === '/' ? filePath.slice(1) : filePath.slice(cwd.length + 1)
      if (regex.test(relative)) {
        yield path(relative)
      }
    }
  }

  async readDir(p: Path): Promise<readonly Path[]> {
    const prefix = p === '/' ? '/' : `${p}/`
    const children = new Set<string>()

    for (const filePath of this.#files.keys()) {
      if (!filePath.startsWith(prefix)) continue
      const relative = filePath.slice(prefix.length)
      const firstSegment = relative.split('/')[0]
      if (firstSegment) children.add(firstSegment)
    }

    for (const dirPath of this.#dirs) {
      if (!dirPath.startsWith(prefix)) continue
      const relative = dirPath.slice(prefix.length)
      const firstSegment = relative.split('/')[0]
      if (firstSegment) children.add(firstSegment)
    }

    return [...children].sort().map((c) => path(c))
  }

  async stat(p: Path): Promise<{ readonly size: number; readonly mtimeMs: number }> {
    const entry = this.#files.get(p)
    if (!entry) {
      throw new Error(`ENOENT: no such file: ${p}`)
    }
    return { size: new TextEncoder().encode(entry.data).byteLength, mtimeMs: entry.mtimeMs }
  }

  async remove(p: Path): Promise<void> {
    // Match BunFsService.remove's `recursive: true, force: true` contract:
    // remove the target plus every descendant. The trailing slash in the
    // prefix prevents `/a` from matching `/aaa/x.txt`.
    this.#files.delete(p)
    this.#dirs.delete(p)
    const prefix = `${p}/`
    for (const filePath of this.#files.keys()) {
      if (filePath.startsWith(prefix)) this.#files.delete(filePath)
    }
    for (const dirPath of this.#dirs) {
      if (dirPath.startsWith(prefix)) this.#dirs.delete(dirPath)
    }
  }

  async tempDir(prefix: string): Promise<Path> {
    this.#tempCounter++
    const dir = path(`/tmp/${prefix}${this.#tempCounter}`)
    this.#dirs.add(dir)
    return dir
  }
}

function parentDir(p: string): string {
  const idx = p.lastIndexOf('/')
  if (idx <= 0) return '/'
  return p.slice(0, idx)
}

function globToRegex(pattern: string): RegExp {
  let regex = ''
  let i = 0
  while (i < pattern.length) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      regex += '.*'
      i += pattern[i + 2] === '/' ? 3 : 2
    } else if (pattern[i] === '*') {
      regex += '[^/]*'
      i++
    } else if (pattern[i] === '?') {
      regex += '[^/]'
      i++
    } else if (pattern[i] === '.') {
      regex += '\\.'
      i++
    } else {
      regex += pattern[i]
      i++
    }
  }
  return new RegExp(`^${regex}$`)
}
