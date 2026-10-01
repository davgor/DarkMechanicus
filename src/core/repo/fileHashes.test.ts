import { describe, expect, it } from 'vitest'
import { createMemoryFs, type MemoryFs } from '../../test/memoryFs'
import { createFileHashCache, readUnlessSynced } from './fileHashes'

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
