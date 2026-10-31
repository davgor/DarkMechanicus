import { join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMemoryFs } from '../../test/memoryFs'
import {
  DEFAULT_STORAGE_MODE,
  dbProjectDir,
  HOME_ENV,
  projectKey,
  resolveHomeDir,
  resolveStorageMode,
  STORAGE_MODES
} from './storageMode'

const HOME = resolve('/home/dev')

describe('STORAGE_MODES', () => {
  it('is the closed set of modes, with repo as the default', () => {
    expect([...STORAGE_MODES]).toEqual(['repo', 'db'])
    expect(DEFAULT_STORAGE_MODE).toBe('repo')
  })
})

describe('resolveHomeDir', () => {
  it('defaults to .darkmechanicus in the home directory', () => {
    expect(resolveHomeDir({}, HOME)).toBe(join(HOME, '.darkmechanicus'))
  })

  it.each([
    ['an absolute override', join(HOME, 'elsewhere'), join(HOME, 'elsewhere')],
    ['a relative override, resolved against the home directory', `work${sep}dm`, join(HOME, 'work', 'dm')]
  ])('honours %s', (_label, value, expected) => {
    expect(resolveHomeDir({ [HOME_ENV]: value }, HOME)).toBe(expected)
  })

  it.each([
    ['an unset override', undefined],
    ['a blank override', '   ']
  ])('ignores %s', (_label, value) => {
    expect(resolveHomeDir({ [HOME_ENV]: value }, HOME)).toBe(join(HOME, '.darkmechanicus'))
  })
})

describe('projectKey', () => {
  it('is a readable slug of the folder name plus a digest of its path', () => {
    const key = projectKey(resolve('/work/Acme Platform'))
    expect(key).toMatch(/^acme-platform-[0-9a-f]{16}$/)
  })

  it('is stable for the same path and differs for another path with the same name', () => {
    const one = projectKey(resolve('/work/one/api'))
    const other = projectKey(resolve('/work/two/api'))
    expect(projectKey(resolve('/work/one/api'))).toBe(one)
    expect(one).not.toBe(other)
    expect(one.startsWith('api-')).toBe(true)
    expect(other.startsWith('api-')).toBe(true)
  })

  it.each([
    ['a dotted folder name', resolve('/work/.hidden'), /^hidden-[0-9a-f]{16}$/],
    ['separators and accents', resolve('/work/My_Repo (v2)'), /^my-repo-v2-[0-9a-f]{16}$/],
    ['a name with nothing usable', resolve('/work/!!!'), /^repo-[0-9a-f]{16}$/]
  ])('builds a filesystem-safe key from %s', (_label, path, pattern) => {
    expect(projectKey(path)).toMatch(pattern)
  })

  it('caps the slug so the key stays a short directory name', () => {
    const key = projectKey(resolve(`/work/${'a'.repeat(120)}`))
    const slug = key.slice(0, key.lastIndexOf('-'))
    expect(slug).toHaveLength(24)
  })

  it('never contains a path separator or traversal', () => {
    for (const path of [resolve('/work/..'), resolve('/'), resolve('/work/a/b')]) {
      const key = projectKey(path)
      expect(key.includes(sep)).toBe(false)
      expect(key.includes('/')).toBe(false)
      expect(key).not.toMatch(/^\.+$/)
    }
  })
})

describe('dbProjectDir', () => {
  it('is one directory per repository under projects/ in the home directory', () => {
    const root = resolve('/work/api')
    expect(dbProjectDir(root, HOME)).toBe(join(HOME, 'projects', projectKey(root)))
  })
})

describe('resolveStorageMode', () => {
  const root = resolve('/work/api')
  const homeDir = join(HOME, '.darkmechanicus')

  it('is db when a database-only project exists for the folder', () => {
    const fs = createMemoryFs()
    fs.put(join(dbProjectDir(root, homeDir), 'project.json'), '{}')
    expect(resolveStorageMode({ repoRoot: root, homeDir, fs })).toBe('db')
  })

  it('is repo when no database-only project exists, even with repository records present', () => {
    const fs = createMemoryFs()
    fs.put(join(root, '.darkmechanicus', 'project.json'), '{}')
    expect(resolveStorageMode({ repoRoot: root, homeDir, fs })).toBe('repo')
  })

  it('is repo for a folder that is set up neither way', () => {
    expect(resolveStorageMode({ repoRoot: root, homeDir, fs: createMemoryFs() })).toBe('repo')
  })

  it('keeps each folder independent', () => {
    const fs = createMemoryFs()
    const other = resolve('/work/other')
    fs.put(join(dbProjectDir(other, homeDir), 'project.json'), '{}')
    expect(resolveStorageMode({ repoRoot: other, homeDir, fs })).toBe('db')
    expect(resolveStorageMode({ repoRoot: root, homeDir, fs })).toBe('repo')
  })
})
