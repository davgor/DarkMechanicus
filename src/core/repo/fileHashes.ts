/**
 * Bounded, workspace-scoped metadata for portable records. Cached identities only eliminate body
 * reads after a containment and file-stamp check and comparison with authoritative SQLite state.
 * Parsed records and image bytes remain in their normal stores.
 */
import type { Db } from '../db/database'
import { assertContained } from './paths'
import type { FsAdapter, RepoLayout } from './types'

export interface FileHashCache {
  scope(db: Db, identity: string): void
  /** The hash remembered for `path` at exactly `stamp`, or null. */
  get(path: string, stamp: string): string | null
  remember(path: string, stamp: string, hash: string): void
}

const MAX_ENTRIES = 4_096
const MAX_BYTES = 8 * 1024 * 1024

export function createFileHashCache(): FileHashCache {
  const entries = new Map<string, { stamp: string; hash: string; bytes: number }>()
  let bytes = 0
  let owner: Db | undefined
  let scope: string | undefined
  return {
    scope: (db, identity) => {
      if (owner === db && scope === identity) return
      entries.clear()
      bytes = 0
      owner = db
      scope = identity
    },
    get: (path, stamp) => {
      const entry = entries.get(path)
      if (entry?.stamp !== stamp) return null
      entries.delete(path)
      entries.set(path, entry)
      return entry.hash
    },
    remember: (path, stamp, hash) => {
      bytes -= entries.get(path)?.bytes ?? 0
      entries.delete(path)
      // Account for UTF-16 strings and fixed bookkeeping for each entry.
      const size = 2 * (path.length + stamp.length + hash.length) + 128
      if (size > MAX_BYTES) return
      entries.set(path, { stamp, hash, bytes: size })
      bytes += size
      while (entries.size > MAX_ENTRIES || bytes > MAX_BYTES) {
        const oldest = entries.entries().next().value!
        bytes -= oldest[1].bytes
        entries.delete(oldest[0])
      }
    }
  }
}

interface HashEnv {
  fs: FsAdapter
  layout?: RepoLayout
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
  if (env.layout !== undefined) assertContained(env.layout, env.fs, path)
  const stamp = env.fs.fileStamp(path)
  const known = stamp === null ? null : env.fileHashes.get(path, stamp)
  if (known !== null && tracked.synced(known)) {
    return null
  }
  const text = tracked.read()
  const hash = tracked.hashOf(text)
  if (stamp !== null && stamp === env.fs.fileStamp(path)) {
    if (env.layout !== undefined) assertContained(env.layout, env.fs, path)
    env.fileHashes.remember(path, stamp, hash)
  }
  return tracked.synced(hash) ? null : { text, hash }
}
