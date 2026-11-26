import type { FsAdapter } from './types'

/** Whether `path` is `prefix` or lies below it. */
function within(path: string, prefix: string): boolean {
  return path === prefix || (path.startsWith(prefix) && (path[prefix.length] === '/' || path[prefix.length] === '\\'))
}

export interface ObservedRepository {
  fs: FsAdapter
  /** Whether every observation still reads as it did. */
  unchanged(): boolean
  /** Whether every observation of `prefix` and the paths below it still reads as it did. */
  unchangedUnder(prefix: string): boolean
}

/**
 * `read`, asked once per path; later calls get the first answer. `assertContained` asks the real path of every folder
 * above every record it reads: thousands of times a scan, for a few dozen folders. Within one scan the first answer
 * stands; the writer lock rechecks it with every other observation, and each use still refuses links through
 * `isSymlink`, which is asked every time.
 */
function firstAnswer(read: (path: string) => string): (path: string) => string {
  const answers = new Map<string, string>()
  return (path) => {
    let answer = answers.get(path)
    if (answer === undefined) {
      answer = read(path)
      answers.set(path, answer)
    }
    return answer
  }
}

/**
 * Record filesystem observations used by the read-only scan. Recheck each distinct observation
 * under the writer lock before publishing its result. Retain no additional copy of a file body.
 */
export function observeRepository(fs: FsAdapter): ObservedRepository {
  const observations = new Map<string, { path: string; value: string; check(): string }>()
  /** Paths read twice with different answers, or whose file changed while read. */
  const unstable = new Set<string>()
  function observe<T>(operation: keyof FsAdapter, path: string, read: (path: string) => T): T {
    const value = read.call(fs, path)
    const encode = (item: T): string => JSON.stringify(Array.isArray(item) ? [...item].sort() : item)
    const encoded = encode(value)
    const key = `${operation}:${path}`
    const prior = observations.get(key)
    if (prior === undefined) {
      observations.set(key, { path, value: encoded, check: () => encode(read.call(fs, path)) })
    } else if (prior.value !== encoded) {
      unstable.add(path)
    }
    return value
  }
  const holds = (matches: (path: string) => boolean): boolean => {
    if ([...unstable].some(matches)) return false
    try {
      return [...observations.values()].every(({ path, value, check }) => !matches(path) || value === check())
    } catch {
      return false
    }
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
      realpath: firstAnswer((path) => observe('realpath', path, fs.realpath)),
      readFile: (path) => {
        const before = fileStamp(path)
        const text = fs.readFile(path)
        if (before === null || before !== fileStamp(path)) unstable.add(path)
        return text
      }
    },
    unchanged: () => holds(() => true),
    unchangedUnder: (prefix) => holds((path) => within(path, prefix))
  }
}
