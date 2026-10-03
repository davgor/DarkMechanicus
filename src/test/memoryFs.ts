/**
 * In-memory FsAdapter for repository tests. Not shipped.
 * Supports symbolic links (reported by `isSymlink`), junction-like redirects that are NOT reported
 * as links (to exercise the realpath containment check), an access log of resolved paths, readdir
 * overrides (hostile listings such as `..`), and fault injection on any operation.
 */
import { basename, dirname, join, parse, resolve, sep } from 'node:path'
import type { FsAdapter } from '../core/repo/types'

type FsOperation = 'writeFile' | 'fsyncFile' | 'rename' | 'readFile' | 'mkdirp' | 'readdir' | 'remove' | 'removeDir'

export interface FaultSpec {
  op: FsOperation
  /** 1-based index among the matching calls of `op` (default 1). */
  nth?: number
  /** Only calls whose requested path (rename: destination) satisfies this predicate count. */
  match?: (path: string) => boolean
}

export interface MemoryFs extends FsAdapter {
  /** Resolved paths that were read, sized, or listed, in call order. */
  readonly reads: string[]
  /** Resolved paths that were written, renamed onto, created, or removed, in call order. */
  readonly writes: string[]
  /** Test setup: writes a file, creating parent directories (no faults, not logged). */
  put(path: string, text: string): void
  /** Deletes a directory and everything under it (test setup only; not a recorded write). */
  removeTree(path: string): void
  /** Test inspection: file contents at a path (following links), or undefined. */
  get(path: string): string | undefined
  symlink(path: string, target: string): void
  /** A redirect that `isSymlink` does not report (like a reparse point the OS hides). */
  junction(path: string, target: string): void
  failOn(fault: FaultSpec): void
  setReaddir(path: string, names: string[]): void
  /** Makes `fileSize` report `bytes` for an existing file (large files without the memory). */
  setSize(path: string, bytes: number): void
  /** Copy of every file keyed by resolved path. */
  files(): Map<string, string>
}

interface PendingFault {
  op: FsOperation
  remaining: number
  match: (path: string) => boolean
}

const MAX_LINK_HOPS = 32

function fsError(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${path}`), { code })
}

function splitPath(path: string): { root: string; parts: string[] } {
  const absolute = resolve(path)
  const root = parse(absolute).root
  return { root, parts: absolute.slice(root.length).split(sep).filter((part) => part !== '') }
}

class MemoryFsImpl implements MemoryFs {
  readonly reads: string[] = []
  readonly writes: string[] = []
  private readonly fileMap = new Map<string, string>()
  private readonly dirSet = new Set<string>()
  private readonly links = new Map<string, string>()
  private readonly junctions = new Map<string, string>()
  private readonly listings = new Map<string, string[]>()
  private readonly sizes = new Map<string, number>()
  /** Bumped on every write of a file, so its stamp changes even when its size does not. */
  private readonly versions = new Map<string, number>()
  private writeCount = 0
  private readonly faults: PendingFault[] = []

  constructor() {
    this.dirSet.add(parse(resolve('/')).root)
  }

  private follow(path: string): string {
    const start = splitPath(path)
    let current = start.root
    const queue = [...start.parts]
    let hops = 0
    while (queue.length > 0) {
      const next = join(current, queue.shift() ?? '')
      const target = this.links.get(next) ?? this.junctions.get(next)
      if (target === undefined) {
        current = next
        continue
      }
      hops += 1
      if (hops > MAX_LINK_HOPS) {
        throw fsError('ELOOP', path)
      }
      const redirected = splitPath(target)
      current = redirected.root
      queue.unshift(...redirected.parts)
    }
    return current
  }

  /** Resolves every component except the last one (lstat semantics). */
  private linkPath(path: string): string {
    const absolute = resolve(path)
    const parent = dirname(absolute)
    return parent === absolute ? absolute : join(this.follow(parent), basename(absolute))
  }

  private fault(op: FsOperation, path: string): void {
    const pending = this.faults.find((item) => item.op === op && item.match(path))
    if (pending === undefined) {
      return
    }
    pending.remaining -= 1
    if (pending.remaining === 0) {
      this.faults.splice(this.faults.indexOf(pending), 1)
      throw new Error(`Injected ${op} fault at ${path}`)
    }
  }

  private ensureDirs(path: string, log: boolean): void {
    const { root, parts } = splitPath(path)
    let current = root
    for (const part of parts) {
      current = this.follow(join(current, part))
      if (this.fileMap.has(current)) {
        throw fsError('ENOTDIR', path)
      }
      if (!this.dirSet.has(current)) {
        this.dirSet.add(current)
        this.pushWrite(current, log)
      }
    }
  }

  private setFile(path: string, text: string): void {
    this.fileMap.set(path, text)
    this.writeCount += 1
    this.versions.set(path, this.writeCount)
  }

  private pushWrite(path: string, log: boolean): void {
    if (log) {
      this.writes.push(path)
    }
  }

  private requireParent(path: string): void {
    if (!this.dirSet.has(dirname(path))) {
      throw fsError('ENOENT', path)
    }
  }

  exists(path: string): boolean {
    try {
      const target = this.follow(path)
      return this.fileMap.has(target) || this.dirSet.has(target)
    } catch {
      return false
    }
  }

  readFile(path: string): string {
    this.fault('readFile', path)
    const target = this.follow(path)
    this.reads.push(target)
    const content = this.fileMap.get(target)
    if (content === undefined) {
      throw fsError(this.dirSet.has(target) ? 'EISDIR' : 'ENOENT', path)
    }
    return content
  }

  fileSize(path: string): number {
    const target = this.follow(path)
    this.reads.push(target)
    const content = this.fileMap.get(target)
    if (content !== undefined) {
      return this.sizes.get(target) ?? Buffer.byteLength(content, 'utf8')
    }
    return this.dirSet.has(target) ? 0 : -1
  }

  /** lstat semantics: a link (or junction) at `path` is not a regular file, so it has no stamp. */
  fileStamp(path: string): string | null {
    const target = this.linkPath(path)
    this.reads.push(target)
    const content = this.fileMap.get(target)
    if (content === undefined) {
      return null
    }
    return `${this.sizes.get(target) ?? Buffer.byteLength(content, 'utf8')}:${this.versions.get(target) ?? 0}`
  }

  writeFile(path: string, data: string): void {
    this.fault('writeFile', path)
    const target = this.follow(path)
    this.requireParent(target)
    if (this.dirSet.has(target)) {
      throw fsError('EISDIR', path)
    }
    this.setFile(target, data)
    this.writes.push(target)
  }

  fsyncFile(path: string): void {
    this.fault('fsyncFile', path)
    if (!this.fileMap.has(this.follow(path))) {
      throw fsError('ENOENT', path)
    }
  }

  rename(from: string, to: string): void {
    this.fault('rename', to)
    const source = this.linkPath(from)
    const target = this.linkPath(to)
    const content = this.fileMap.get(source)
    if (content === undefined) {
      throw fsError('ENOENT', from)
    }
    this.requireParent(target)
    if (this.dirSet.has(target)) {
      throw fsError('EISDIR', to)
    }
    this.links.delete(target)
    this.fileMap.delete(source)
    this.setFile(target, content)
    this.writes.push(target)
  }

  mkdirp(path: string): void {
    this.fault('mkdirp', path)
    this.ensureDirs(path, true)
  }

  readdir(path: string): string[] {
    this.fault('readdir', path)
    const target = this.follow(path)
    this.reads.push(target)
    const override = this.listings.get(target)
    if (override !== undefined) {
      return [...override]
    }
    if (!this.dirSet.has(target)) {
      throw fsError('ENOTDIR', path)
    }
    const entries = [...this.fileMap.keys(), ...this.dirSet, ...this.links.keys(), ...this.junctions.keys()]
    const names = entries.filter((entry) => entry !== target && dirname(entry) === target).map((entry) => basename(entry))
    return [...new Set(names)].sort()
  }

  realpath(path: string): string {
    const target = this.follow(path)
    if (!this.fileMap.has(target) && !this.dirSet.has(target)) {
      throw fsError('ENOENT', path)
    }
    return target
  }

  isSymlink(path: string): boolean {
    try {
      return this.links.has(this.linkPath(path))
    } catch {
      return false
    }
  }

  isDirectory(path: string): boolean {
    try {
      return this.dirSet.has(this.follow(path))
    } catch {
      return false
    }
  }

  remove(path: string): void {
    this.fault('remove', path)
    const target = this.linkPath(path)
    if (this.dirSet.has(target)) {
      throw fsError('EISDIR', path)
    }
    this.links.delete(target)
    this.fileMap.delete(target)
    this.writes.push(target)
  }

  removeDir(path: string): void {
    this.fault('removeDir', path)
    const target = this.linkPath(path)
    if (!this.dirSet.has(target)) {
      throw fsError(this.fileMap.has(target) ? 'ENOTDIR' : 'ENOENT', path)
    }
    const entries = [...this.fileMap.keys(), ...this.dirSet, ...this.links.keys(), ...this.junctions.keys()]
    if (entries.some((entry) => entry !== target && dirname(entry) === target)) {
      throw fsError('ENOTEMPTY', path)
    }
    this.dirSet.delete(target)
    this.listings.delete(target)
    this.writes.push(target)
  }

  put(path: string, text: string): void {
    this.ensureDirs(dirname(resolve(path)), false)
    this.setFile(this.follow(path), text)
  }

  removeTree(path: string): void {
    const root = resolve(path)
    const inside = (candidate: string): boolean => candidate === root || candidate.startsWith(`${root}${sep}`)
    for (const collection of [this.fileMap, this.links, this.junctions, this.listings, this.sizes, this.versions]) {
      for (const key of [...collection.keys()].filter(inside)) {
        collection.delete(key)
      }
    }
    for (const dir of [...this.dirSet].filter(inside)) {
      this.dirSet.delete(dir)
    }
  }

  get(path: string): string | undefined {
    try {
      return this.fileMap.get(this.follow(path))
    } catch {
      return undefined
    }
  }

  symlink(path: string, target: string): void {
    this.ensureDirs(dirname(resolve(path)), false)
    this.links.set(this.linkPath(path), resolve(target))
  }

  junction(path: string, target: string): void {
    this.ensureDirs(dirname(resolve(path)), false)
    this.junctions.set(this.linkPath(path), resolve(target))
  }

  failOn(fault: FaultSpec): void {
    this.faults.push({ op: fault.op, remaining: fault.nth ?? 1, match: fault.match ?? (() => true) })
  }

  setReaddir(path: string, names: string[]): void {
    this.listings.set(this.follow(path), [...names])
  }

  setSize(path: string, bytes: number): void {
    this.sizes.set(this.follow(path), bytes)
  }

  files(): Map<string, string> {
    return new Map(this.fileMap)
  }
}

export function createMemoryFs(): MemoryFs {
  return new MemoryFsImpl()
}

/** True when `path` equals `dir` or lies below it (resolved, lexical). */
export function isWithin(dir: string, path: string): boolean {
  const base = resolve(dir)
  const target = resolve(path)
  return target === base || target.startsWith(`${base}${sep}`)
}
