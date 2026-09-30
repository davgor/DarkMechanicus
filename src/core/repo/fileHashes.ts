/**
 * Per-workspace memory of the tracked comment and profile files a reconcile has read: for each
 * path, the file's stamp (size, modification and change times, inode) when it was read and the
 * change-detection hash of its text. While a file keeps that stamp, a later reconcile reuses the
 * hash instead of reading and hashing the file again, so an unchanged reconcile costs one stat per
 * file. The cache never decides what is accepted: the hash is still compared with the database's
 * sync state, and anything not synced is read and checked in full.
 */
import type { FsAdapter } from './types'

export interface FileHashCache {
  /** The hash remembered for `path` at exactly `stamp`, or null. */
  get(path: string, stamp: string): string | null
  remember(path: string, stamp: string, hash: string): void
}

export function createFileHashCache(): FileHashCache {
  const entries = new Map<string, { stamp: string; hash: string }>()
  return {
    get: (path, stamp) => {
      const entry = entries.get(path)
      return entry?.stamp === stamp ? entry.hash : null
    },
    remember: (path, stamp, hash) => {
      entries.set(path, { stamp, hash })
    }
  }
}

interface HashEnv {
  fs: FsAdapter
  fileHashes: FileHashCache
}

interface TrackedText {
  /** Change-detection hash of the file's text. */
  hashOf(text: string): string
  /** The database already holds this exact hash: nothing to import. */
  synced(hash: string): boolean
  /** Reads the text with every check an untrusted record needs (containment, size, kind). */
  read(): string
}

/**
 * The text and hash of a tracked file that is not synced, or null when it is. A file whose stamp
 * matches the one remembered with a synced hash is not read at all. The stamp is taken before the
 * read, so a change racing the read leaves a stamp that no longer matches and is read next time.
 */
export function readUnlessSynced(env: HashEnv, path: string, tracked: TrackedText): { text: string; hash: string } | null {
  const stamp = env.fs.fileStamp(path)
  const known = stamp === null ? null : env.fileHashes.get(path, stamp)
  if (known !== null && tracked.synced(known)) {
    return null
  }
  const text = tracked.read()
  const hash = tracked.hashOf(text)
  if (stamp !== null) {
    env.fileHashes.remember(path, stamp, hash)
  }
  return tracked.synced(hash) ? null : { text, hash }
}
