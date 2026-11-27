import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { folderStoreId } from '../agentChat/folderStoreId'
import { createSiteStore, MAX_SITES } from './siteStore'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const FOLDER = join(tmpdir(), 'Some Repo')

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dm-sites-'))
  roots.push(root)
  const lines: string[] = []
  const store = createSiteStore({ root, log: (line) => lines.push(line) })
  const fileOf = (folder: string | null) => join(root, `${folder === null ? 'projectless' : folderStoreId(folder)}.json`)
  const seed = (folder: string | null, text: string) => {
    mkdirSync(root, { recursive: true })
    writeFileSync(fileOf(folder), text)
  }
  return { root, lines, store, fileOf, seed }
}

describe('createSiteStore', () => {
  it('adds, lists and removes origins, kept per folder in a version 1 file named by the folder store id', async () => {
    const { root, store, fileOf } = setup()
    expect(await store.list(FOLDER)).toEqual([])
    expect(await store.add(FOLDER, 'https://example.com')).toEqual(['https://example.com'])
    expect(await store.add(FOLDER, 'http://localhost:5173')).toEqual(['https://example.com', 'http://localhost:5173'])
    expect(await store.add(FOLDER, 'https://example.com')).toEqual(['https://example.com', 'http://localhost:5173'])
    expect(await store.add(null, 'https://projectless.example')).toEqual(['https://projectless.example'])

    expect(await store.list(FOLDER)).toEqual(['https://example.com', 'http://localhost:5173'])
    expect(await store.list(null)).toEqual(['https://projectless.example'])
    expect(JSON.parse(readFileSync(fileOf(FOLDER), 'utf8'))).toEqual({ version: 1, origins: ['https://example.com', 'http://localhost:5173'] })
    expect(readdirSync(root).sort()).toEqual([`${folderStoreId(FOLDER)}.json`, 'projectless.json'].sort())

    expect(await store.remove(FOLDER, 'https://example.com')).toEqual(['http://localhost:5173'])
    expect(await store.remove(FOLDER, 'https://never.example')).toEqual(['http://localhost:5173'])
    expect(await store.list(FOLDER)).toEqual(['http://localhost:5173'])
    expect(await store.list(null)).toEqual(['https://projectless.example'])
  })

  it('keeps the list across store instances, as after a restart', async () => {
    const { root, store } = setup()
    await store.add(FOLDER, 'https://example.com')
    expect(await createSiteStore({ root, log: () => undefined }).list(FOLDER)).toEqual(['https://example.com'])
  })
})

describe('createSiteStore normalized origins and the cap', () => {
  it.each([
    'https://Example.com',
    'https://example.com/',
    'https://example.com/path',
    'https://example.com:443',
    'https://bücher.example',
    'example.com',
    'http://localhost:5173/',
    'https://user@example.com',
    'http://169.254.169.254',
    'file:///C:/x',
    'about:blank',
    'null',
    ''
  ])('never stores the non-normalized or refused origin %j', async (origin) => {
    const { store, fileOf } = setup()
    await expect(store.add(FOLDER, origin)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(await store.list(FOLDER)).toEqual([])
    expect(() => readFileSync(fileOf(FOLDER))).toThrow()
  })

  it(`keeps at most ${MAX_SITES} origins and refuses the next one`, async () => {
    const { store, seed } = setup()
    const origins = Array.from({ length: MAX_SITES }, (_, index) => `https://site${index}.example`)
    seed(FOLDER, JSON.stringify({ version: 1, origins: origins.slice(0, -1) }))
    expect(await store.add(FOLDER, origins.at(-1)!)).toHaveLength(MAX_SITES)
    await expect(store.add(FOLDER, 'https://one-too-many.example')).rejects.toMatchObject({ code: 'capacity_exceeded' })
    expect(await store.add(FOLDER, origins[0])).toEqual(origins)
    expect(await store.list(FOLDER)).toEqual(origins)
    expect(await store.remove(FOLDER, origins[0])).toHaveLength(MAX_SITES - 1)
    expect(await store.add(FOLDER, 'https://one-too-many.example')).toHaveLength(MAX_SITES)
  })
})

describe('createSiteStore corrupt files', () => {
  it.each([
    ['not json', '{ version: 1'],
    ['another version', JSON.stringify({ version: 2, origins: ['https://example.com'] })],
    ['no version', JSON.stringify({ origins: ['https://example.com'] })],
    ['extra keys', JSON.stringify({ version: 1, origins: ['https://example.com'], allowAll: true })],
    ['a non-normalized origin', JSON.stringify({ version: 1, origins: ['https://example.com', 'https://Example.org/'] })],
    ['a refused origin', JSON.stringify({ version: 1, origins: ['http://169.254.169.254'] })],
    ['a non-string origin', JSON.stringify({ version: 1, origins: [1] })],
    ['duplicates', JSON.stringify({ version: 1, origins: ['https://example.com', 'https://example.com'] })],
    ['too many origins', JSON.stringify({ version: 1, origins: Array.from({ length: MAX_SITES + 1 }, (_, i) => `https://s${i}.example`) })],
    ['an array', JSON.stringify(['https://example.com'])],
    ['null', 'null']
  ])('loads a file with %s as empty and logs it once', async (_label, text) => {
    const { store, seed, lines, fileOf } = setup()
    seed(FOLDER, text)
    expect(await store.list(FOLDER)).toEqual([])
    expect(await store.list(FOLDER)).toEqual([])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(fileOf(FOLDER))
    expect(readFileSync(fileOf(FOLDER), 'utf8')).toBe(text)
  })

  it('replaces a corrupt file with a valid one on the next add', async () => {
    const { store, seed, fileOf } = setup()
    seed(FOLDER, '\u0000garbage')
    expect(await store.add(FOLDER, 'https://example.com')).toEqual(['https://example.com'])
    expect(JSON.parse(readFileSync(fileOf(FOLDER), 'utf8'))).toEqual({ version: 1, origins: ['https://example.com'] })
  })

  it('logs nothing for a folder with no file yet', async () => {
    const { store, lines } = setup()
    expect(await store.list(FOLDER)).toEqual([])
    expect(lines).toEqual([])
  })
})

describe('createSiteStore concurrent changes', () => {
  it('runs concurrent changes one at a time so none is lost, leaving no staged files behind', async () => {
    const { root, store } = setup()
    const origins = Array.from({ length: 20 }, (_, index) => `https://site${index}.example`)
    await Promise.all(origins.map((origin) => store.add(FOLDER, origin)))
    expect((await store.list(FOLDER)).sort()).toEqual([...origins].sort())
    await Promise.all([store.remove(FOLDER, origins[0]), store.add(FOLDER, 'https://late.example'), store.remove(FOLDER, origins[1])])
    expect(await store.list(FOLDER)).toEqual([...origins.slice(2), 'https://late.example'])
    expect(readdirSync(root)).toEqual([`${folderStoreId(FOLDER)}.json`])
  })

  it('keeps working after a refused change', async () => {
    const { store, seed } = setup()
    seed(FOLDER, JSON.stringify({ version: 1, origins: Array.from({ length: MAX_SITES }, (_, i) => `https://s${i}.example`) }))
    const refused = store.add(FOLDER, 'https://extra.example')
    const removed = store.remove(FOLDER, 'https://s0.example')
    await expect(refused).rejects.toMatchObject({ code: 'capacity_exceeded' })
    expect(await removed).toHaveLength(MAX_SITES - 1)
  })
})
