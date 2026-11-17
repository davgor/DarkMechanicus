/** Storage switch refusals and cleanup edges: each guard leaves the original store selected and intact. */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DomainError } from './errors'
import { createHarness, type Harness } from '../test/workspaceHarness'
import { nodeFs } from './repo/nodeFs'
import { dbProjectDir, projectKey, resolveStorageMode } from './repo/storageMode'
import type { FsAdapter } from './repo/types'
import type { Workspace } from './workspace'

let harness: Harness
beforeEach(() => { harness = createHarness() })
afterEach(() => { harness.cleanup() })

const switchTo = (workspace: Workspace, mode: 'repo' | 'db') => workspace.switchStorageMode({ mode, confirmed: true })
const resolved = () => resolveStorageMode({ repoRoot: harness.root, homeDir: harness.homeDir, fs: nodeFs })
const repoDir = () => join(harness.root, '.darkmechanicus')
const journalFile = () => join(harness.homeDir, 'projects', `${projectKey(harness.root)}.switch.json`)

/** A database-mode folder with one saved epic. */
async function prepared(): Promise<Workspace> {
  const app = harness.open('desktop', { transport: 'desktop', mode: 'db' })
  await app.initializeRepository({ name: 'Guard proof' })
  const epic = await app.createEpic({ title: 'Kept through every refusal' })
  const draft = await app.openDraft({ epicId: epic.id })
  if (draft.draftRevision === null) throw new Error('Expected the guard fixture to have an open draft')
  await app.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
  return app
}

/** The prepared folder moved to repository storage, reopened through `fs` (the real filesystem by default). */
async function inRepo(fs: FsAdapter = nodeFs): Promise<Workspace> {
  const original = await prepared()
  await switchTo(original, 'repo')
  original.close()
  return harness.open('desktop', { transport: 'desktop', fs })
}

/** The refusal `action` rejected with, as code and message. */
async function refusal(action: Promise<unknown>): Promise<{ code: string; message: string }> {
  const error: unknown = await action.then(() => null, (caught: unknown) => caught)
  return error instanceof DomainError ? { code: error.code, message: error.message } : { code: 'none', message: String(error) }
}

describe('storage switch preflight refusals', () => {
  it('refuses a switch to the mode the folder already uses', async () => {
    const app = await prepared()
    expect(await refusal(switchTo(app, 'db'))).toEqual({ code: 'invalid_input', message: 'This folder already uses db storage.' })
    expect(resolved()).toBe('db')
  })

  it('refuses when the project record disappeared under the open session', async () => {
    const app = await inRepo()
    rmSync(join(repoDir(), 'project.json'))
    expect(await refusal(switchTo(app, 'db'))).toEqual({ code: 'not_initialized', message: 'Initialize the folder before switching storage.' })
    expect(existsSync(dbProjectDir(harness.root, harness.homeDir))).toBe(false)
  })

  it('keeps a folder of repositories in the database', async () => {
    mkdirSync(join(harness.root, 'alpha', '.git'), { recursive: true })
    const app = harness.open('desktop', { transport: 'desktop', mode: 'db' })
    await app.initializeRepository({ name: 'Many', layout: 'multi_repo' })
    expect(await refusal(switchTo(app, 'repo'))).toEqual({ code: 'invalid_input', message: 'A folder of repositories must remain database only.' })
    expect(resolved()).toBe('db')
  })

  it('refuses a leftover staging directory and removes nothing', async () => {
    const app = await prepared()
    const staging = `${repoDir()}.switch-staging`
    mkdirSync(staging)
    writeFileSync(join(staging, 'keep.txt'), 'mine')
    expect(await refusal(switchTo(app, 'repo'))).toMatchObject({ code: 'conflict', message: expect.stringContaining('Storage switch destination already exists') })
    expect(readFileSync(join(staging, 'keep.txt'), 'utf8')).toBe('mine')
    expect(resolved()).toBe('db')
  })

  it('refuses while another session long silent still has a live process', async () => {
    const app = await prepared()
    const other = harness.open('reader')
    app.ctx().db.run("UPDATE sessions SET last_seen_at = '2000-01-01T00:00:00.000Z', pid = ? WHERE id <> ?", process.pid, app.ctx().session.id)
    expect(await refusal(switchTo(app, 'repo'))).toMatchObject({ code: 'conflict', message: expect.stringContaining('other connected agent or desktop sessions') })
    other.close()
  })
})

describe('storage switch path and repository refusals', () => {
  it('refuses a dangling link where the staging directory would go', async () => {
    const app = await prepared()
    symlinkSync(join(harness.root, 'nowhere'), `${repoDir()}.switch-staging`, 'junction')
    expect(await refusal(switchTo(app, 'repo'))).toMatchObject({ code: 'unsafe_path', message: expect.stringContaining('Cannot safely resolve storage migration path') })
    expect(resolved()).toBe('db')
  })

  it('refuses a repository whose .gitignore is a link', async () => {
    const gitignore = join(harness.root, '.gitignore')
    const app = await inRepo({ ...nodeFs, isSymlink: (path) => path === gitignore || nodeFs.isSymlink(path) })
    expect(await refusal(switchTo(app, 'db'))).toEqual({ code: 'unsafe_path', message: 'The repository .gitignore is a link; switching was refused.' })
    expect(resolved()).toBe('repo')
  })

  it('keeps the repository store when a tracked record cannot be imported', async () => {
    const app = await inRepo()
    mkdirSync(join(repoDir(), 'epics', 'ep_short'))
    expect(await refusal(switchTo(app, 'db'))).toEqual({
      code: 'conflict',
      message: 'Repository records could not be imported without conflicts; the original store was kept.'
    })
    expect(resolved()).toBe('repo')
    expect(existsSync(dbProjectDir(harness.root, harness.homeDir))).toBe(false)
  })
})

describe('storage switch journal fencing', () => {
  it('keeps a prepared journal of a live process and a file not named like one when it opens', async () => {
    const app = await prepared()
    app.close()
    const live = `${journalFile()}.prepare-${process.ppid}-00000000-0000-4000-8000-000000000000`
    const other = `${journalFile()}.prepare-notes`
    writeFileSync(live, '{')
    writeFileSync(other, 'mine')
    expect((await harness.open('reader').getProject()).name).toBe('Guard proof')
    expect([existsSync(live), readFileSync(other, 'utf8')]).toEqual([true, 'mine'])
  })

  it('refuses to open while a live process holds the switch journal', async () => {
    const app = await prepared()
    app.close()
    writeFileSync(journalFile(), JSON.stringify({ version: 1, sourceMode: 'db', pid: process.ppid }))
    expect(() => harness.open('reader')).toThrow('Another process is switching this folder’s storage. Close it or wait for it to finish.')
    expect(existsSync(journalFile())).toBe(true)
  })

  it('refuses to open a second session in this process during a switch', async () => {
    const original = await prepared()
    original.close()
    let during: unknown = null
    const app = harness.open('desktop', { transport: 'desktop', fs: { ...nodeFs, writeFile(path, data) {
      if (path.includes('migration-records.json')) {
        try { harness.open('reader') } catch (error) { during = error }
      }
      nodeFs.writeFile(path, data)
    } } })
    await switchTo(app, 'repo')
    expect(during).toMatchObject({ code: 'conflict', message: 'A storage switch is already in progress for this folder.' })
    expect(resolved()).toBe('repo')
  })
})

describe('storage switch .gitignore replacement checks', () => {
  const isReplacement = (path: string) => path.includes('.gitignore.dm-switch.prepare-')

  it.each([
    ['turns into a link', { ...nodeFs, isSymlink: (path: string) => isReplacement(path) || nodeFs.isSymlink(path) }],
    ['cannot be stamped', { ...nodeFs, fileStamp: (path: string) => (isReplacement(path) ? null : nodeFs.fileStamp(path)) }]
  ])('leaves the cleanup pending when the prepared replacement %s', async (_label, fs) => {
    const gitignore = join(harness.root, '.gitignore')
    const app = await inRepo(fs)
    writeFileSync(gitignore, 'node_modules/\n.darkmechanicus/local/\n')
    expect(await switchTo(app, 'db')).toMatchObject({ mode: 'db', cleanupPending: true })
    expect(readFileSync(gitignore, 'utf8')).toBe('node_modules/\n.darkmechanicus/local/\n')
    expect(readdirSync(harness.root).filter(isReplacement)).toEqual([])
  })
})

describe('storage switch cleanup edges', () => {
  it('leaves a .gitignore without the Dark Mechanicus entry byte for byte', async () => {
    const app = await inRepo()
    writeFileSync(join(harness.root, '.gitignore'), 'node_modules/\r\ndist/\n')
    expect(await switchTo(app, 'db')).toMatchObject({ mode: 'db', cleanupPending: false })
    expect(readFileSync(join(harness.root, '.gitignore'), 'utf8')).toBe('node_modules/\r\ndist/\n')
  })

  it('unlinks a linked folder in the local records without touching what it points to', async () => {
    const app = await inRepo()
    const outside = join(harness.homeDir, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'not ours')
    symlinkSync(outside, join(repoDir(), 'local', 'linked'), 'junction')
    expect(await switchTo(app, 'db')).toMatchObject({ mode: 'db', cleanupPending: false })
    expect(existsSync(repoDir())).toBe(false)
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('not ours')
  })

  it('leaves the cleanup pending when the .gitignore changes while its replacement is prepared', async () => {
    const gitignore = join(harness.root, '.gitignore')
    let reads = 0
    const app = await inRepo({ ...nodeFs, readFile(path) {
      const text = nodeFs.readFile(path)
      if (path !== gitignore) return text
      reads += 1
      return reads === 1 ? text : `${text}edited/\n`
    } })
    writeFileSync(gitignore, 'node_modules/\n.darkmechanicus/local/\n')
    expect(await switchTo(app, 'db')).toMatchObject({ mode: 'db', cleanupPending: true })
    expect(readFileSync(gitignore, 'utf8')).toBe('node_modules/\n.darkmechanicus/local/\n')
    expect(resolved()).toBe('db')
  })
})

describe('storage switch cleanup after the commit', () => {
  it('leaves the cleanup pending when the .gitignore became a link after the commit', async () => {
    const gitignore = join(harness.root, '.gitignore')
    const target = dbProjectDir(harness.root, harness.homeDir)
    const app = await inRepo({ ...nodeFs, isSymlink: (path) => (path === gitignore && existsSync(target)) || nodeFs.isSymlink(path) })
    writeFileSync(gitignore, '.darkmechanicus/local/\n')
    expect(await switchTo(app, 'db')).toMatchObject({ mode: 'db', cleanupPending: true })
    expect(readFileSync(gitignore, 'utf8')).toBe('.darkmechanicus/local/\n')
    expect(resolved()).toBe('db')
  })

  it('treats a fault right after the commit rename as a committed switch', async () => {
    const target = dbProjectDir(harness.root, harness.homeDir)
    const app = await inRepo({ ...nodeFs, rename(from, to) {
      nodeFs.rename(from, to)
      if (to === target) throw new Error('Injected fault after commit')
    } })
    const epics = (await app.listEpics()).map((epic) => epic.id)
    expect(await switchTo(app, 'db')).toEqual({ mode: 'db', projectDir: target, cleanupPending: true })
    expect(resolved()).toBe('db')
    expect((await app.listEpics()).map((epic) => epic.id)).toEqual(epics)
  })
})
