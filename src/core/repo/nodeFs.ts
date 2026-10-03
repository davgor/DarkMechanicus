import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import type { FsAdapter } from './types'

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    // Missing path or a non-directory parent (lstat throws ENOTDIR even with throwIfNoEntry).
    return false
  }
}

function stampOf(path: string): string | null {
  try {
    const stats = lstatSync(path, { bigint: true, throwIfNoEntry: false })
    return stats?.isFile() === true ? `${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}:${stats.ino}` : null
  } catch {
    // A non-directory parent (ENOTDIR): nothing to stamp, so the caller reads (and rejects) the path.
    return null
  }
}

function fsyncPath(path: string): void {
  // 'r+' so FlushFileBuffers is permitted on Windows; the file must already exist.
  const fd = openSync(path, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Synchronous `node:fs` implementation of the repository filesystem boundary. */
export const nodeFs: FsAdapter = {
  exists: (path) => existsSync(path),
  readFile: (path) => readFileSync(path, 'utf8'),
  fileSize: (path) => statSync(path, { throwIfNoEntry: false })?.size ?? -1,
  fileStamp: stampOf,
  writeFile: (path, data) => writeFileSync(path, data, 'utf8'),
  fsyncFile: fsyncPath,
  rename: (from, to) => renameSync(from, to),
  mkdirp: (path) => {
    mkdirSync(path, { recursive: true })
  },
  readdir: (path) => readdirSync(path),
  // Native realpath resolves symlinks, Windows junctions, and 8.3 short names consistently.
  realpath: (path) => realpathSync.native(path),
  isSymlink: isLink,
  isDirectory: (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false,
  remove: (path) => rmSync(path, { force: true }),
  removeDir: (path) => rmdirSync(path)
}
