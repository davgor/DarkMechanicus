import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import { createFolderRegistry, type RegistryFs } from './folderRegistry'

interface Sandbox {
  root: string
  /** Registry file, inside a directory that does not exist yet. */
  file: string
  /** Fake home directory (created lazily by makeFolder). */
  home: string
}

function withSandbox(run: (sandbox: Sandbox) => void): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dm-registry-')))
  try {
    run({ root, file: join(root, 'state', 'folders.json'), home: join(root, 'home') })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function makeFolder(parent: string, ...segments: string[]): string {
  const path = join(parent, ...segments)
  mkdirSync(path, { recursive: true })
  return path
}

/** Deterministic timestamps: 00:00:01, 00:00:02, … */
function counterNow(): () => string {
  let tick = 0
  return () => {
    tick += 1
    return `2026-01-01T00:00:0${tick}.000Z`
  }
}

function errorCode(action: () => unknown): string {
  try {
    action()
  } catch (error) {
    return error instanceof DomainError ? error.code : `unexpected: ${String(error)}`
  }
  return 'no error'
}

describe('createFolderRegistry tracking', () => {
  it('starts empty and does not create the registry file until something changes', () => {
    withSandbox(({ file, home }) => {
      const registry = createFolderRegistry({ file, homeDir: home })

      expect(registry.list()).toEqual([])
      expect(existsSync(file)).toBe(false)
    })
  })

  it('tracks a folder and describes it', () => {
    withSandbox(({ file, home }) => {
      const folder = makeFolder(home, 'projects', 'alpha')
      const registry = createFolderRegistry({ file, homeDir: home, now: counterNow() })

      const result = registry.track(folder)

      expect(result).toEqual({
        added: true,
        folder: {
          path: folder,
          name: 'alpha',
          displayPath: join('~', 'projects', 'alpha'),
          initialized: false,
          available: true,
          addedAt: '2026-01-01T00:00:01.000Z'
        }
      })
      expect(registry.list()).toEqual([result.folder])
    })
  })

  it('persists a versioned JSON file atomically through a temp file', () => {
    withSandbox(({ file, home }) => {
      const folder = makeFolder(home, 'alpha')
      createFolderRegistry({ file, homeDir: home, now: counterNow() }).track(folder)

      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
        version: 1,
        folders: [{ path: folder, addedAt: '2026-01-01T00:00:01.000Z' }]
      })
      expect(readdirSync(dirname(file))).toEqual(['folders.json'])
    })
  })

  it('keeps insertion order and survives a restart', () => {
    withSandbox(({ file, home }) => {
      const b = makeFolder(home, 'b')
      const a = makeFolder(home, 'a')
      const c = makeFolder(home, 'c')
      const first = createFolderRegistry({ file, homeDir: home, now: counterNow() })
      first.track(b)
      first.track(a)
      first.track(c)

      const restarted = createFolderRegistry({ file, homeDir: home })

      expect(first.list().map((folder) => folder.name)).toEqual(['b', 'a', 'c'])
      expect(restarted.list()).toEqual(first.list())
    })
  })

  it('stamps addedAt with a real ISO time when no clock is injected', () => {
    withSandbox(({ file, home }) => {
      const folder = makeFolder(home, 'alpha')
      const { folder: view } = createFolderRegistry({ file, homeDir: home }).track(folder)

      expect(new Date(view.addedAt).toISOString()).toBe(view.addedAt)
    })
  })
})

describe('createFolderRegistry canonical paths', () => {
  it('selects the existing entry instead of adding a duplicate', () => {
    withSandbox(({ file, home }) => {
      const folder = makeFolder(home, 'alpha')
      const registry = createFolderRegistry({ file, homeDir: home, now: counterNow() })
      const first = registry.track(folder)

      const again = registry.track(folder)

      expect(first.added).toBe(true)
      expect(again.added).toBe(false)
      expect(again.folder).toEqual(first.folder)
      expect(registry.list()).toHaveLength(1)
    })
  })

  it('treats a trailing separator as the same folder', () => {
    withSandbox(({ file, home }) => {
      const folder = makeFolder(home, 'alpha')
      const registry = createFolderRegistry({ file, homeDir: home })
      registry.track(folder)

      const result = registry.track(`${folder}${sep}`)

      expect(result.added).toBe(false)
      expect(result.folder.path).toBe(folder)
      expect(registry.list()).toHaveLength(1)
    })
  })

  it('treats a dot-dot detour as the same folder', () => {
    withSandbox(({ file, home }) => {
      const folder = makeFolder(home, 'alpha')
      makeFolder(home, 'beta')
      const registry = createFolderRegistry({ file, homeDir: home })
      registry.track(folder)

      const result = registry.track(join(home, 'beta', '..', 'alpha'))

      expect(result.added).toBe(false)
      expect(registry.list()).toHaveLength(1)
    })
  })

  it('stores the real path when tracking through a symbolic link, and dedupes both ways', () => {
    withSandbox(({ root, file, home }) => {
      const folder = makeFolder(home, 'alpha')
      const link = join(root, 'link-to-alpha')
      symlinkSync(folder, link, 'junction')
      const viaLink = createFolderRegistry({ file, homeDir: home })

      const first = viaLink.track(link)
      const second = viaLink.track(folder)

      expect(first.added).toBe(true)
      expect(first.folder.path).toBe(folder)
      expect(second.added).toBe(false)
      expect(viaLink.list()).toHaveLength(1)
    })
  })

  it('resolves aliases of tracked folders to the canonical path and nothing else', () => {
    withSandbox(({ root, file, home }) => {
      const folder = makeFolder(home, 'alpha')
      const other = makeFolder(home, 'other')
      const link = join(root, 'link-to-alpha')
      symlinkSync(folder, link, 'junction')
      const registry = createFolderRegistry({ file, homeDir: home })
      registry.track(folder)

      expect(registry.resolve(folder)).toBe(folder)
      expect(registry.resolve(link)).toBe(folder)
      expect(registry.resolve(`${folder}${sep}`)).toBe(folder)
      expect(registry.resolve(other)).toBeNull()
      expect(registry.resolve(join(home, 'missing'))).toBeNull()
      expect(registry.resolve('alpha')).toBeNull()
      expect(registry.resolve('')).toBeNull()
      expect(registry.has(link)).toBe(true)
      expect(registry.has(other)).toBe(false)
    })
  })

  it('rejects paths that cannot be tracked', () => {
    withSandbox(({ root, file, home }) => {
      const registry = createFolderRegistry({ file, homeDir: home })
      const plainFile = join(root, 'a-file.txt')
      writeFileSync(plainFile, 'not a folder')

      expect(errorCode(() => registry.track(join(root, 'missing')))).toBe('not_found')
      expect(errorCode(() => registry.track(plainFile))).toBe('invalid_input')
      expect(errorCode(() => registry.track('relative/path'))).toBe('invalid_input')
      expect(errorCode(() => registry.track(''))).toBe('invalid_input')
      expect(registry.list()).toEqual([])
      expect(existsSync(file)).toBe(false)
    })
  })
})

describe('createFolderRegistry folder state', () => {
  it('reports whether the repository has been initialized, at the time of listing', () => {
    withSandbox(({ file, home }) => {
      const folder = makeFolder(home, 'alpha')
      const registry = createFolderRegistry({ file, homeDir: home })
      const tracked = registry.track(folder)

      makeFolder(folder, '.darkmechanicus')
      const withDirOnly = registry.list()[0]?.initialized
      writeFileSync(join(folder, '.darkmechanicus', 'project.json'), '{}')

      expect(tracked.folder.initialized).toBe(false)
      expect(withDirOnly).toBe(false)
      expect(registry.list()[0]?.initialized).toBe(true)
    })
  })

  it('keeps a deleted folder listed as unavailable so it can be untracked', () => {
    withSandbox(({ file, home }) => {
      const folder = makeFolder(home, 'alpha')
      const registry = createFolderRegistry({ file, homeDir: home })
      registry.track(folder)
      rmSync(folder, { recursive: true })

      const [view] = registry.list()

      expect(view?.available).toBe(false)
      expect(view?.initialized).toBe(false)
      expect(view?.path).toBe(folder)
      expect(registry.resolve(folder)).toBe(folder)
      expect(registry.has(folder)).toBe(true)
      expect(registry.untrack(folder)).toEqual([])
    })
  })

  it('reports a path that turned into a file as unavailable', () => {
    withSandbox(({ file, home }) => {
      const folder = makeFolder(home, 'alpha')
      const registry = createFolderRegistry({ file, homeDir: home })
      registry.track(folder)
      rmSync(folder, { recursive: true })
      writeFileSync(folder, 'now a file')

      expect(registry.list()[0]?.available).toBe(false)
    })
  })
})

describe('createFolderRegistry untracking', () => {
  it('removes only the registry entry and returns the remaining folders', () => {
    withSandbox(({ file, home }) => {
      const a = makeFolder(home, 'a')
      const b = makeFolder(home, 'b')
      makeFolder(a, '.darkmechanicus')
      writeFileSync(join(a, '.darkmechanicus', 'project.json'), '{"keep":"me"}')
      const registry = createFolderRegistry({ file, homeDir: home })
      registry.track(a)
      registry.track(b)

      const remaining = registry.untrack(a)

      expect(remaining.map((folder) => folder.path)).toEqual([b])
      expect(registry.list().map((folder) => folder.path)).toEqual([b])
      expect(registry.has(a)).toBe(false)
      expect(readFileSync(join(a, '.darkmechanicus', 'project.json'), 'utf8')).toBe('{"keep":"me"}')
      expect(JSON.parse(readFileSync(file, 'utf8')).folders.map((entry: { path: string }) => entry.path)).toEqual([b])
    })
  })

  it('accepts an alias of the tracked path', () => {
    withSandbox(({ root, file, home }) => {
      const folder = makeFolder(home, 'alpha')
      const link = join(root, 'link-to-alpha')
      symlinkSync(folder, link, 'junction')
      const registry = createFolderRegistry({ file, homeDir: home })
      registry.track(folder)

      expect(registry.untrack(link)).toEqual([])
      expect(registry.list()).toEqual([])
    })
  })

  it('does nothing, and writes nothing, for a folder that is not tracked', () => {
    withSandbox(({ file, home }) => {
      const tracked = makeFolder(home, 'tracked')
      const stranger = makeFolder(home, 'stranger')
      const registry = createFolderRegistry({ file, homeDir: home })

      expect(registry.untrack(stranger)).toEqual([])
      expect(existsSync(file)).toBe(false)

      registry.track(tracked)
      const before = readFileSync(file, 'utf8')
      expect(registry.untrack(stranger).map((folder) => folder.path)).toEqual([tracked])
      expect(readFileSync(file, 'utf8')).toBe(before)
    })
  })

  it('lets a folder be tracked again after it was untracked', () => {
    withSandbox(({ file, home }) => {
      const folder = makeFolder(home, 'alpha')
      const registry = createFolderRegistry({ file, homeDir: home })
      registry.track(folder)
      registry.untrack(folder)

      expect(registry.track(folder).added).toBe(true)
    })
  })
})

describe('createFolderRegistry recovery', () => {
  it('treats an unreadable or malformed registry file as empty instead of throwing', () => {
    withSandbox(({ file, home }) => {
      mkdirSync(dirname(file), { recursive: true })
      const contents = [
        '{not json',
        '',
        '[]',
        'null',
        '"text"',
        '{"version":2,"folders":[]}',
        '{"version":1}',
        '{"version":1,"folders":"x"}',
        '{"version":1,"folders":{}}'
      ]

      const lists = contents.map((text) => {
        writeFileSync(file, text)
        return createFolderRegistry({ file, homeDir: home }).list()
      })

      expect(lists).toEqual(contents.map(() => []))
    })
  })

  it('treats a registry path that is a directory as empty', () => {
    withSandbox(({ file, home }) => {
      mkdirSync(file, { recursive: true })

      expect(createFolderRegistry({ file, homeDir: home }).list()).toEqual([])
    })
  })

  it('keeps well-formed entries and drops malformed ones', () => {
    withSandbox(({ file, home }) => {
      const folder = makeFolder(home, 'alpha')
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          folders: [
            { path: folder, addedAt: '2026-02-02T00:00:00.000Z' },
            5,
            null,
            { path: 3, addedAt: 'x' },
            { path: '', addedAt: 'x' },
            { path: folder }
          ]
        })
      )

      const list = createFolderRegistry({ file, homeDir: home }).list()

      expect(list.map((view) => [view.path, view.addedAt])).toEqual([[folder, '2026-02-02T00:00:00.000Z']])
    })
  })

  it('rewrites a corrupt file with valid content on the next change', () => {
    withSandbox(({ file, home }) => {
      const folder = makeFolder(home, 'alpha')
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, '{not json')
      const registry = createFolderRegistry({ file, homeDir: home, now: counterNow() })

      registry.track(folder)

      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
        version: 1,
        folders: [{ path: folder, addedAt: '2026-01-01T00:00:01.000Z' }]
      })
    })
  })
})

interface MemoryFs extends RegistryFs {
  files: Map<string, string>
  dirs: Set<string>
  renames: string[]
  faults: { rename: boolean }
}

/** In-memory RegistryFs where realpath is the identity for known directories. */
function createMemoryFs(): MemoryFs {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const renames: string[] = []
  const faults = { rename: false }
  return {
    files,
    dirs,
    renames,
    faults,
    readFile(path) {
      const data = files.get(path)
      if (data === undefined) {
        throw new Error(`ENOENT: ${path}`)
      }
      return data
    },
    writeFile(path, data) {
      files.set(path, data)
    },
    rename(from, to) {
      if (faults.rename) {
        throw new Error('EIO: rename failed')
      }
      files.set(to, files.get(from) ?? '')
      files.delete(from)
      renames.push(`${from} -> ${to}`)
    },
    mkdirp(path) {
      dirs.add(path)
    },
    realpath(path) {
      if (!dirs.has(path)) {
        throw new Error(`ENOENT: ${path}`)
      }
      return path
    },
    exists: (path) => files.has(path) || dirs.has(path),
    isDirectory: (path) => dirs.has(path)
  }
}

const REGISTRY_FILE = join(sep, 'state', 'folders.json')
const HOME = join(sep, 'home', 'u')

function memoryRegistry(fs: MemoryFs, homeDir = HOME) {
  return createFolderRegistry({ file: REGISTRY_FILE, homeDir, fs, now: counterNow() })
}

describe('createFolderRegistry persistence boundary', () => {
  it('writes a temp file next to the registry, then renames it into place', () => {
    const fs = createMemoryFs()
    const folder = join(HOME, 'alpha')
    fs.dirs.add(folder)

    memoryRegistry(fs).track(folder)

    expect(fs.renames).toEqual([`${REGISTRY_FILE}.tmp -> ${REGISTRY_FILE}`])
    expect(fs.files.has(`${REGISTRY_FILE}.tmp`)).toBe(false)
    expect(fs.dirs.has(dirname(REGISTRY_FILE))).toBe(true)
    expect(JSON.parse(fs.files.get(REGISTRY_FILE) ?? 'null').version).toBe(1)
  })

  it('leaves memory and disk unchanged when the write fails, and recovers afterwards', () => {
    const fs = createMemoryFs()
    const folder = join(HOME, 'alpha')
    fs.dirs.add(folder)
    const registry = memoryRegistry(fs)
    fs.faults.rename = true

    expect(() => registry.track(folder)).toThrow('EIO')
    expect(registry.list()).toEqual([])
    expect(fs.files.has(REGISTRY_FILE)).toBe(false)

    fs.faults.rename = false
    expect(registry.track(folder).added).toBe(true)
    expect(registry.list()).toHaveLength(1)
    expect(fs.files.has(REGISTRY_FILE)).toBe(true)
  })

  it('leaves the entry in place when untracking fails to persist', () => {
    const fs = createMemoryFs()
    const folder = join(HOME, 'alpha')
    fs.dirs.add(folder)
    const registry = memoryRegistry(fs)
    registry.track(folder)
    fs.faults.rename = true

    expect(() => registry.untrack(folder)).toThrow('EIO')
    expect(registry.list().map((view) => view.path)).toEqual([folder])
  })

  it('names a filesystem root by its path', () => {
    const fs = createMemoryFs()
    fs.dirs.add(sep)

    expect(memoryRegistry(fs).track(sep).folder.name).toBe(sep)
  })
})

describe('createFolderRegistry display paths', () => {
  function displayPath(path: string, homeDir: string): string | undefined {
    const fs = createMemoryFs()
    fs.dirs.add(path)
    return memoryRegistry(fs, homeDir).track(path).folder.displayPath
  }

  it('abbreviates the home directory as ~', () => {
    expect(displayPath(join(HOME, 'code', 'app'), HOME)).toBe(join('~', 'code', 'app'))
    expect(displayPath(HOME, HOME)).toBe('~')
  })

  it('tolerates a trailing separator on the home directory', () => {
    expect(displayPath(join(HOME, 'code'), `${HOME}${sep}`)).toBe(join('~', 'code'))
  })

  it('does not abbreviate paths that merely share a prefix with home', () => {
    const sibling = join(sep, 'home', 'u2', 'code')

    expect(displayPath(sibling, HOME)).toBe(sibling)
    expect(displayPath(join(sep, 'srv', 'code'), HOME)).toBe(join(sep, 'srv', 'code'))
  })

  it('leaves paths alone when no home directory is known', () => {
    expect(displayPath(join(sep, 'srv', 'code'), '')).toBe(join(sep, 'srv', 'code'))
  })
})
