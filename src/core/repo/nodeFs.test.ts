import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTempRepo, linkDirectory, type TempRepo } from '../../test/tempRepo'
import { nodeFs } from './nodeFs'

let repo: TempRepo

beforeEach(() => {
  repo = createTempRepo()
})

afterEach(() => {
  repo.cleanup()
})

describe('nodeFs files', () => {
  it('writes, reads, sizes, and fsyncs files', () => {
    const file = join(repo.root, 'note.txt')
    nodeFs.writeFile(file, 'héllo')
    nodeFs.fsyncFile(file)
    expect(nodeFs.readFile(file)).toBe('héllo')
    expect(nodeFs.fileSize(file)).toBe(6)
    expect(nodeFs.exists(file)).toBe(true)
    expect(nodeFs.isDirectory(file)).toBe(false)
  })

  it('reports -1 for the size of a missing file and false for missing paths', () => {
    const missing = join(repo.root, 'missing.txt')
    expect(nodeFs.fileSize(missing)).toBe(-1)
    expect(nodeFs.exists(missing)).toBe(false)
    expect(nodeFs.isSymlink(missing)).toBe(false)
    expect(nodeFs.isDirectory(missing)).toBe(false)
    expect(() => nodeFs.fsyncFile(missing)).toThrow()
  })

  it('treats a path below a regular file as missing', () => {
    const file = join(repo.root, 'plain.txt')
    writeFileSync(file, 'x')
    const below = join(file, 'child')
    expect(nodeFs.fileSize(below)).toBe(-1)
    expect(nodeFs.isSymlink(below)).toBe(false)
    expect(nodeFs.isDirectory(below)).toBe(false)
  })

  it('renames over an existing file atomically', () => {
    const target = join(repo.root, 'target.json')
    const temp = join(repo.root, 'target.json.tmp-1')
    writeFileSync(target, 'old')
    writeFileSync(temp, 'new')
    nodeFs.rename(temp, target)
    expect(readFileSync(target, 'utf8')).toBe('new')
    expect(existsSync(temp)).toBe(false)
  })

  it('removes files and ignores missing ones', () => {
    const file = join(repo.root, 'gone.txt')
    writeFileSync(file, 'x')
    nodeFs.remove(file)
    nodeFs.remove(file)
    expect(existsSync(file)).toBe(false)
  })
})

describe('nodeFs directories and links', () => {
  it('creates nested directories and lists entries', () => {
    const nested = join(repo.root, 'a', 'b', 'c')
    nodeFs.mkdirp(nested)
    nodeFs.mkdirp(nested)
    writeFileSync(join(repo.root, 'a', 'file.json'), '{}')
    expect(nodeFs.isDirectory(nested)).toBe(true)
    expect(nodeFs.readdir(join(repo.root, 'a')).sort()).toEqual(['b', 'file.json'])
  })

  it('detects linked directories and resolves real paths', () => {
    const link = join(repo.root, 'escape')
    linkDirectory(repo.outside, link)
    expect(nodeFs.isSymlink(link)).toBe(true)
    expect(nodeFs.isSymlink(repo.outside)).toBe(false)
    expect(nodeFs.realpath(link)).toBe(repo.outside)
  })
})
