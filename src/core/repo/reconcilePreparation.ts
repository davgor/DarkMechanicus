import type { Db } from '../db/database'
import type { FsAdapter } from './types'

/** The machine-local data read while preparing an import must still be current after BEGIN IMMEDIATE. */
export function databaseRevision(db: Db): string {
  const { data_version } = db.get<{ data_version: number }>('PRAGMA data_version')!
  const { changes } = db.get<{ changes: number }>('SELECT total_changes() AS changes')!
  return `${data_version}:${changes}`
}

/**
 * Record filesystem observations used by the read-only scan. Recheck each distinct observation
 * under the writer lock before publishing its result. Retain no additional copy of a file body.
 */
export function observeRepository(fs: FsAdapter): { fs: FsAdapter; unchanged(): boolean } {
  const observations = new Map<string, { value: string; check(): string }>()
  let stable = true
  function observe<T>(operation: keyof FsAdapter, path: string, read: (path: string) => T): T {
    const value = read.call(fs, path)
    const encode = (item: T): string => JSON.stringify(Array.isArray(item) ? [...item].sort() : item)
    const encoded = encode(value)
    const key = `${operation}:${path}`
    const prior = observations.get(key)
    if (prior === undefined) {
      observations.set(key, { value: encoded, check: () => encode(read.call(fs, path)) })
    } else if (prior.value !== encoded) {
      stable = false
    }
    return value
  }

  const fileStamp = (path: string): string | null => observe('fileStamp', path, fs.fileStamp)
  return {
    fs: {
      ...fs,
      exists: (path) => observe('exists', path, fs.exists),
      fileSize: (path) => observe('fileSize', path, fs.fileSize),
      fileStamp,
      isDirectory: (path) => observe('isDirectory', path, fs.isDirectory),
      isSymlink: (path) => observe('isSymlink', path, fs.isSymlink),
      readdir: (path) => observe('readdir', path, fs.readdir),
      realpath: (path) => observe('realpath', path, fs.realpath),
      readFile: (path) => {
        const before = fileStamp(path)
        const text = fs.readFile(path)
        if (before === null || before !== fileStamp(path)) stable = false
        return text
      }
    },
    unchanged: () => {
      if (!stable) return false
      try {
        for (const { value, check } of observations.values()) {
          if (value !== check()) return false
        }
        return true
      } catch {
        return false
      }
    }
  }
}
