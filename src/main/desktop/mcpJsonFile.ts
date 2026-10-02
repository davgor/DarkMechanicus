/**
 * Writes the Dark Mechanicus server into the repository's Claude Code config, `.mcp.json` at the
 * repository root. It reads and writes only that one file, never executes or commits anything.
 * Repository contents are untrusted, so, as for skill installation, a symbolic link (or junction),
 * an unexpected file type, or a resolved path outside the repository is refused before anything is
 * read or written.
 */
import { closeSync, constants, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { ClaudeCodeConnectResult } from '../../shared/desktop/api'
import { DomainError } from '../../core/errors'
import { mergeMcpServer, type McpServerEntry } from './mcpJson'

type EntryKind = 'missing' | 'file' | 'directory' | 'symlink' | 'other'

/** The filesystem surface the writer uses; tests inject fakes through it. */
export interface McpJsonFs {
  /** What is at `path`, without following symbolic links. */
  entryKind(path: string): EntryKind
  readFile(path: string): string
  writeFile(path: string, data: string): void
  /** Canonical real path with every symbolic link resolved. */
  realpath(path: string): string
}

const FILE_NAME = '.mcp.json'
/** Opening fails on a link swapped in after the checks (POSIX; Windows has no such flag). */
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0)

const nodeMcpJsonFs: McpJsonFs = {
  entryKind(path) {
    const stats = lstatSync(path, { throwIfNoEntry: false })
    if (stats === undefined) {
      return 'missing'
    }
    if (stats.isSymbolicLink()) {
      return 'symlink'
    }
    if (stats.isDirectory()) {
      return 'directory'
    }
    return stats.isFile() ? 'file' : 'other'
  },
  readFile: (path) => readFileSync(path, 'utf8'),
  writeFile: (path, data) => {
    const fd = openSync(path, WRITE_FLAGS)
    try {
      writeFileSync(fd, data, 'utf8')
    } finally {
      closeSync(fd)
    }
  },
  realpath: (path) => realpathSync.native(path)
}

function resolveRoot(fs: McpJsonFs, repoRoot: string): string {
  try {
    return fs.realpath(repoRoot)
  } catch {
    throw new DomainError('not_found', `Repository folder not found: ${repoRoot}`)
  }
}

function assertUsable(path: string, kind: EntryKind): void {
  if (kind !== 'missing' && kind !== 'file') {
    const reason = kind === 'symlink' ? 'is a symbolic link' : 'is not a regular file'
    throw new DomainError('unsafe_path', `Refusing to write ${FILE_NAME}: ${path} ${reason}.`, { path })
  }
}

function assertInside(root: string, candidate: string): void {
  const rel = relative(root, candidate)
  const outside = rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
  if (outside) {
    throw new DomainError('unsafe_path', `Refusing to write ${FILE_NAME} outside the repository: ${candidate}`, {
      path: candidate
    })
  }
}

/**
 * Adds `server` to the repository's `.mcp.json`, creating the file when there is none. A different
 * existing `darkmechanicus` entry is replaced only with `replace`; a file that cannot be merged is
 * reported (`invalid`) and left as it is. Refusals (`unsafe_path`, `not_found`) happen before any read.
 */
export function writeMcpServer(
  repoRoot: string,
  server: McpServerEntry,
  options: { replace: boolean },
  fs: McpJsonFs = nodeMcpJsonFs
): ClaudeCodeConnectResult {
  const rootReal = resolveRoot(fs, repoRoot)
  const file = join(repoRoot, FILE_NAME)
  const kind = fs.entryKind(file)
  assertUsable(file, kind)
  const exists = kind === 'file'
  if (exists) {
    assertInside(rootReal, fs.realpath(file))
  }
  const merged = mergeMcpServer(exists ? fs.readFile(file) : null, server, options)
  if (!('text' in merged)) {
    return merged
  }
  fs.writeFile(file, merged.text)
  return { outcome: merged.outcome }
}
