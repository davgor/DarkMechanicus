import { describe, expect, it } from 'vitest'
import { createMemoryFs, type MemoryFs } from '../../test/memoryFs'
import { createFileHashCache, readUnlessSynced } from './fileHashes'
import { resolveLayout } from './layout'
import { readOwnedText } from './portable'
import { domainErrorOf } from '../../test/repoFixtures'
import { resolve } from 'node:path'

const FILE = '/repo/.darkmechanicus/profiles/ui.json'
const LINK = '/repo/.darkmechanicus/profiles/linked.json'

interface Setup {
  fs: MemoryFs
  env: { fs: MemoryFs; fileHashes: ReturnType<typeof createFileHashCache> }
  /** Hashes the database holds as synced. */
  synced: string[]
  /** Texts the tracked file's `read` returned, in call order. */
  reads: string[]
  read(path?: string): ReturnType<typeof readUnlessSynced>
}

function setup(): Setup {
  const fs = createMemoryFs()
  fs.put(FILE, 'v1')
  const env = { fs, fileHashes: createFileHashCache() }
  const synced: string[] = []
  const reads: string[] = []
  const read = (path = FILE): ReturnType<typeof readUnlessSynced> =>
    readUnlessSynced(env, path, {
      hashOf: (text) => `hash:${text}`,
      synced: (hash) => synced.includes(hash),
      read: () => {
        const text = fs.readFile(path)
        reads.push(text)
        return text
      }
    })
  return { fs, env, synced, reads, read }
}

describe('readUnlessSynced', () => {
  it('reads a file it has not seen and returns its text and hash, or null when that hash is synced', () => {
    const first = setup()
    expect(first.read()).toEqual({ text: 'v1', hash: 'hash:v1' })
    const second = setup()
    second.synced.push('hash:v1')
    expect(second.read()).toBeNull()
    expect([first.reads, second.reads]).toEqual([['v1'], ['v1']])
  })

  it('does not read a synced file again while its stamp is unchanged', () => {
    const s = setup()
    s.synced.push('hash:v1')
    expect([s.read(), s.read(), s.read()]).toEqual([null, null, null])
    expect(s.reads).toEqual(['v1'])
  })

  it('reads the file again once it changed, even at the same size', () => {
    const s = setup()
    s.synced.push('hash:v1')
    s.read()
    s.fs.put(FILE, 'v2')
    expect(s.read()).toEqual({ text: 'v2', hash: 'hash:v2' })
    expect(s.reads).toEqual(['v1', 'v2'])
  })

  it('reads again while the remembered hash is not synced, and stops once the database syncs it', () => {
    const s = setup()
    expect([s.read(), s.read()]).toEqual([
      { text: 'v1', hash: 'hash:v1' },
      { text: 'v1', hash: 'hash:v1' }
    ])
    s.synced.push('hash:v1')
    expect([s.read(), s.read()]).toEqual([null, null])
    expect(s.reads).toEqual(['v1', 'v1'])
  })

  it('always reads a path that is not a regular file, such as a link', () => {
    const s = setup()
    s.fs.symlink(LINK, FILE)
    s.synced.push('hash:v1')
    expect([s.read(LINK), s.read(LINK)]).toEqual([null, null])
    expect(s.reads).toEqual(['v1', 'v1'])
  })

  it('remembers nothing when the read fails', () => {
    const s = setup()
    s.synced.push('hash:v1')
    s.fs.failOn({ op: 'readFile' })
    expect(() => s.read()).toThrow(`Injected readFile fault at ${FILE}`)
    expect(s.read()).toBeNull()
    expect(s.reads).toEqual(['v1'])
  })
})


it('evicts cold metadata at the entry and byte bounds', () => {
  const cache = createFileHashCache()
  for (let index = 0; index < 4_096; index += 1) cache.remember(String(index), 'stamp', 'hash')
  expect(cache.get('0', 'stamp')).toBe('hash')
  cache.remember('new', 'stamp', 'hash')
  expect(cache.get('1', 'stamp')).toBeNull()
  expect(cache.get('0', 'stamp')).toBe('hash')
  const largeHash = 'x'.repeat(3 * 1024 * 1024)
  cache.remember('large-1', 'stamp', largeHash)
  cache.remember('large-2', 'stamp', largeHash)
  expect(cache.get('large-1', 'stamp')).toBeNull()
  expect(cache.get('large-2', 'stamp')).toBe(largeHash)
})

it('checks containment twice rather than three times on a cold owned read, and still checks every cached acceptance', () => {
  const layout = resolveLayout(resolve('/repo'))
  const fs = createMemoryFs()
  const path = resolve(FILE)
  fs.put(path, 'v1')
  const measured = Object.create(fs) as MemoryFs
  let containmentPasses = 0
  measured.realpath = candidate => {
    if (candidate === layout.dmDir) containmentPasses++
    return fs.realpath(candidate)
  }
  const env = { fs: measured, layout, fileHashes: createFileHashCache() }
  let reads = 0
  const tracked = {
    hashOf: (text: string) => text,
    synced: (hash: string) => hash === 'v1',
    read: () => { reads++; return readOwnedText(env, path)! }
  }
  expect(readUnlessSynced(env, path, tracked)).toBeNull()
  expect([containmentPasses, reads]).toEqual([2, 1])
  expect(readUnlessSynced(env, path, tracked)).toBeNull()
  expect([containmentPasses, reads]).toEqual([3, 1])
})

it.each([false, true])('rejects an unsafe owned path before content or cached-hash acceptance (cached=%s)', cached => {
  const layout = resolveLayout(resolve('/repo'))
  const fs = createMemoryFs()
  const path = resolve(FILE)
  fs.put(path, 'v1')
  const stamp = fs.fileStamp(path)!
  const measured = Object.create(fs) as MemoryFs
  fs.reads.length = 0
  // Even a retained matching metadata stamp cannot hide an ancestor redirect.
  measured.fileStamp = () => stamp
  const env = { fs: measured, layout, fileHashes: createFileHashCache() }
  if (cached) env.fileHashes.remember(path, stamp, 'v1')
  fs.mkdirp(resolve('/outside'))
  fs.junction(resolve('/repo/.darkmechanicus/profiles'), resolve('/outside'))
  let accepted = false
  const error = domainErrorOf(() => readUnlessSynced(env, path, {
    hashOf: text => text,
    synced: () => { accepted = true; return true },
    read: () => readOwnedText(env, path)!
  }))
  expect(error.code).toBe('unsafe_path')
  expect(accepted).toBe(false)
  expect(fs.reads).toEqual([])
})

it('preserves metadata errors on safe paths while an unsafe path still fails containment first', () => {
  const layout = resolveLayout(resolve('/repo'))
  const fs = createMemoryFs()
  const path = resolve(FILE)
  fs.put(path, 'v1')
  const failure = new Error('metadata unavailable')
  const measured = Object.create(fs) as MemoryFs
  measured.fileStamp = () => { throw failure }
  const env = { fs: measured, layout, fileHashes: createFileHashCache() }
  const tracked = { hashOf: (text: string) => text, synced: () => true, read: () => { throw new Error('Must not read content') } }
  expect(() => readUnlessSynced(env, path, tracked)).toThrow(failure)
  fs.mkdirp(resolve('/outside'))
  fs.junction(resolve('/repo/.darkmechanicus/profiles'), resolve('/outside'))
  expect(domainErrorOf(() => readUnlessSynced(env, path, tracked)).code).toBe('unsafe_path')
})

it('refuses to seal a cache entry when containment changes after the guarded content read', () => {
  const layout = resolveLayout(resolve('/repo'))
  const fs = createMemoryFs()
  const path = resolve(FILE)
  fs.put(path, 'v1')
  fs.mkdirp(resolve('/outside'))
  const stamp = fs.fileStamp(path)!
  const measured = Object.create(fs) as MemoryFs
  measured.fileStamp = () => stamp
  const env = { fs: measured, layout, fileHashes: createFileHashCache() }
  expect(domainErrorOf(() => readUnlessSynced(env, path, {
    hashOf: text => text,
    synced: () => true,
    read: () => {
      const text = readOwnedText(env, path)!
      fs.junction(resolve('/repo/.darkmechanicus/profiles'), resolve('/outside'))
      return text
    }
  })).code).toBe('unsafe_path')
  expect(env.fileHashes.get(path, stamp)).toBeNull()
})
