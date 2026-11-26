import { describe, expect, it } from 'vitest'
import { createMemoryFs, type MemoryFs } from '../../test/memoryFs'
import { observeRepository } from './reconcilePreparation'
import type { FsAdapter } from './types'

const FILE = '/repo/.darkmechanicus/epics/e/state.json'

/** The read operations of `fs`, with `readFile` replaced. */
function readingWith(fs: MemoryFs, readFile: (path: string) => string): FsAdapter {
  return {
    exists: (path) => fs.exists(path), readFile, readFileBytes: (path) => fs.readFileBytes(path),
    fileSize: (path) => fs.fileSize(path), fileStamp: (path) => fs.fileStamp(path), writeFile: (path, data) => fs.writeFile(path, data),
    writeFileBytes: (path, data) => fs.writeFileBytes(path, data), fsyncFile: (path) => fs.fsyncFile(path),
    rename: (from, to) => fs.rename(from, to), mkdirp: (path) => fs.mkdirp(path), readdir: (path) => fs.readdir(path),
    realpath: (path) => fs.realpath(path), isSymlink: (path) => fs.isSymlink(path), isDirectory: (path) => fs.isDirectory(path),
    remove: (path) => fs.remove(path), removeDir: (path) => fs.removeDir(path)
  }
}

describe('observeRepository', () => {
  it('stays unchanged while every observation still reads the same', () => {
    const fs = createMemoryFs()
    fs.put(FILE, '{"a":1}')
    const observed = observeRepository(fs)
    expect(observed.fs.readFile(FILE)).toBe('{"a":1}')
    expect(observed.fs.readdir('/repo/.darkmechanicus/epics')).toEqual(['e'])
    expect(observed.unchanged()).toBe(true)
  })

  it('reports a change when one scan sees two answers for the same observation', () => {
    const fs = createMemoryFs()
    fs.put(FILE, 'one')
    const observed = observeRepository(fs)
    expect(observed.fs.exists(FILE)).toBe(true)
    fs.removeTree('/repo/.darkmechanicus/epics/e')
    expect(observed.fs.exists(FILE)).toBe(false)
    fs.put(FILE, 'one')
    expect(observed.unchanged()).toBe(false)
  })

  it('reports a change when a file is rewritten while it is being read', () => {
    const fs = createMemoryFs()
    fs.put(FILE, 'before')
    const observed = observeRepository(readingWith(fs, (path) => {
      const text = fs.readFile(path)
      fs.put(path, 'after, a longer text')
      return text
    }))
    expect(observed.fs.readFile(FILE)).toBe('before')
    expect(observed.unchanged()).toBe(false)
  })

  it('reports a change when an observation differs under the lock or can no longer be made', () => {
    const fs = createMemoryFs()
    fs.put(FILE, 'short')
    const observed = observeRepository(fs)
    expect(observed.fs.fileSize(FILE)).toBe(5)
    fs.put(FILE, 'a longer body')
    expect(observed.unchanged()).toBe(false)

    const again = observeRepository(readingWith(fs, (path) => fs.readFile(path)))
    again.fs.realpath(FILE)
    fs.removeTree('/repo/.darkmechanicus/epics/e')
    expect(again.unchanged()).toBe(false)
  })
})

describe('observeRepository real paths', () => {
  it('asks a path\'s real path once per scan, and still reports a real path that moved by the time of the lock', () => {
    const fs = createMemoryFs()
    fs.put(FILE, 'body')
    const asked: string[] = []
    let real = '/repo/.darkmechanicus/epics/e'
    const observed = observeRepository({ ...readingWith(fs, (path) => fs.readFile(path)), realpath: (path) => { asked.push(path); return real } })
    expect([observed.fs.realpath('/repo/.darkmechanicus/epics/e'), observed.fs.realpath('/repo/.darkmechanicus/epics/e')]).toEqual([real, real])
    expect(asked).toEqual(['/repo/.darkmechanicus/epics/e'])
    expect(observed.unchanged()).toBe(true)
    real = '/elsewhere/e'
    expect(observed.unchanged()).toBe(false)
  })
})
