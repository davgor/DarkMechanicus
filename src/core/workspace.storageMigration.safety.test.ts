import { spawnSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHarness, TEST_STORAGE, type Harness } from '../test/workspaceHarness'
import { nodeFs } from './repo/nodeFs'
import { dbProjectDir, projectKey, resolveStorageMode } from './repo/storageMode'
import { openWorkspace, type Workspace } from './workspace'

const fault = vi.hoisted(() => ({ journalWrite: false }))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof NodeFs>()
  return { ...fs, writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    if (fault.journalWrite && typeof args[0] === 'number') {
      fault.journalWrite = false
      fs.writeFileSync(args[0], '{')
      throw new Error('Injected initial journal write failure')
    }
    return fs.writeFileSync(...args)
  } }
})
let harness: Harness
beforeEach(() => { harness = createHarness() })
afterEach(() => { fault.journalWrite = false; harness.cleanup() })

async function prepared(): Promise<Workspace> {
  const app = harness.open('desktop', { transport: 'desktop', mode: 'db' })
  await app.initializeRepository({ name: 'Safety proof' })
  const epic = await app.createEpic({ title: 'Keep the authoritative source' })
  const draft = await app.openDraft({ epicId: epic.id })
  await app.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
  return app
}
const move = (app: Workspace, mode: 'repo' | 'db') => app.switchStorageMode({ mode, confirmed: true })
const mode = (homeDir = harness.homeDir) => resolveStorageMode({ repoRoot: harness.root, homeDir, fs: nodeFs })

async function repoWithHome(linked: boolean): Promise<{ app: Workspace; homeDir: string }> {
  const original = await prepared()
  await move(original, 'repo')
  original.close()
  const nested = join(harness.root, '.darkmechanicus', 'local', 'home')
  let homeDir = nested
  if (linked) {
    mkdirSync(nested, { recursive: true })
    homeDir = join(harness.homeDir, 'linked-home')
    symlinkSync(nested, homeDir, process.platform === 'win32' ? 'junction' : 'dir')
  }
  const app = openWorkspace({ repoRoot: harness.root, homeDir, role: 'desktop', transport: 'desktop',
    label: 'Nested home proof', git: harness.git, clock: harness.clock, ...TEST_STORAGE })
  return { app, homeDir }
}

const preparedJournals = () => readdirSync(join(harness.homeDir, 'projects'))
  .filter((name) => name.startsWith(`${projectKey(harness.root)}.switch.json.prepare-`))

describe('nested database source path safety', () => {
  it('refuses a database source that is inside the repository destination', async () => {
    const homeDir = join(harness.root, '.darkmechanicus', 'local', 'home')
    const app = openWorkspace({ repoRoot: harness.root, homeDir, role: 'desktop', transport: 'desktop',
      label: 'Nested database proof', git: harness.git, clock: harness.clock, ...TEST_STORAGE })
    try {
      await app.initializeRepository({ name: 'Nested database', mode: 'db' })
      const before = await app.getProject()
      await expect(move(app, 'repo')).rejects.toMatchObject({ code: 'unsafe_path' })
      expect(mode(homeDir)).toBe('db')
      expect(await app.getProject()).toEqual(before)
      expect(existsSync(join(harness.root, '.darkmechanicus', 'project.json'))).toBe(false)
    } finally { app.close() }
  })
})

describe('reviewed storage migration safety boundaries', () => {
  it.each([false, true])('refuses a home inside the source local subtree, linked ancestor %s', async (linked) => {
    const { app, homeDir } = await repoWithHome(linked)
    try {
      const before = await app.listEpics()
      await expect(move(app, 'db')).rejects.toMatchObject({ code: 'unsafe_path' })
      expect(mode(homeDir)).toBe('repo')
      expect(await app.listEpics()).toEqual(before)
      expect(existsSync(join(harness.root, '.darkmechanicus', 'local', 'state.sqlite'))).toBe(true)
      expect(existsSync(dbProjectDir(harness.root, homeDir))).toBe(false)
    } finally { app.close() }
  })

  it.each(['hardlink', 'junction'] as const)('does not follow a pre-existing root-ignore temporary %s', async (kind) => {
    const app = await prepared()
    await move(app, 'repo')
    writeFileSync(join(harness.root, '.gitignore'), 'keep/\n.darkmechanicus/local/\n')
    const victim = join(harness.homeDir, 'unrelated.txt')
    writeFileSync(victim, 'Unrelated bytes must survive')
    const temp = join(harness.root, '.gitignore.dm-switch.tmp')
    if (kind === 'hardlink') linkSync(victim, temp)
    else symlinkSync(harness.homeDir, temp, process.platform === 'win32' ? 'junction' : 'dir')
    await move(app, 'db')
    expect(readFileSync(victim, 'utf8')).toBe('Unrelated bytes must survive')
    expect(readFileSync(join(harness.root, '.gitignore'), 'utf8')).toBe('keep/\n')
    expect(nodeFs.isSymlink(join(harness.root, '.gitignore'))).toBe(false)
  })
})

describe('private purge and failed journal write safety', () => {

  it('keeps both Git ignores while a private-file purge is interrupted', async () => {
    const original = await prepared()
    await move(original, 'repo')
    original.close()
    const dm = join(harness.root, '.darkmechanicus')
    writeFileSync(join(harness.root, '.gitignore'), '.darkmechanicus/local/\nkeep/\n')
    expect(spawnSync('git', ['-C', harness.root, 'init'], { cwd: harness.root }).status).toBe(0)
    const app = harness.open('desktop', { transport: 'desktop', fs: {
      ...nodeFs,
      readdir: (path) => nodeFs.readdir(path).sort(),
      remove(path) {
        if (path === join(dm, 'local', 'migration-records.json')) throw new Error('Interrupted private purge')
        nodeFs.remove(path)
      }
    } })
    const result = await move(app, 'db')
    expect(result.cleanupPending).toBe(true)
    expect(existsSync(join(dm, 'local', 'migration-records.json'))).toBe(true)
    expect(readFileSync(join(dm, '.gitignore'), 'utf8')).toBe('local/\n')
    expect(readFileSync(join(harness.root, '.gitignore'), 'utf8')).toContain('.darkmechanicus/local/')
    expect(spawnSync('git', ['-C', harness.root, 'check-ignore', '.darkmechanicus/local/migration-records.json'], { cwd: harness.root }).status).toBe(0)
    app.close()
    const reopened = harness.open('desktop', { transport: 'desktop' })
    expect((await reopened.getProject()).name).toBe('Safety proof')
    expect(existsSync(dm)).toBe(false)
    expect(readFileSync(join(harness.root, '.gitignore'), 'utf8')).toBe('keep/\n')
  })

  it('a failed first journal write leaves the source usable and a later switch possible', async () => {
    const app = await prepared()
    fault.journalWrite = true
    await expect(move(app, 'repo')).rejects.toThrow('Injected initial journal write failure')
    expect((await app.getProject()).name).toBe('Safety proof')
    expect(mode()).toBe('db')
    expect(preparedJournals()).toEqual([])
    await move(app, 'repo')
    expect(mode()).toBe('repo')
  })
})

describe('initial journal process interruption safety', () => {

  it('an abrupt exit during initial journal writing leaves no unreadable authoritative journal', async () => {
    const original = await prepared()
    original.close()
    const script = `
      import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      import { openWorkspace } from ${JSON.stringify(new URL('./workspace.ts', import.meta.url).href)};
      const app = openWorkspace({repoRoot:${JSON.stringify(harness.root)},homeDir:${JSON.stringify(harness.homeDir)},
        role:'desktop',transport:'desktop',label:'Journal interruption',autoReconcile:false});
      const write = fs.writeFileSync;
      fs.writeFileSync = (file, data, ...args) => { if (typeof file === 'number') { write(file, '{'); process.exit(91); } return write(file, data, ...args); };
      syncBuiltinESMExports(); await app.switchStorageMode({mode:'repo',confirmed:true}); process.exit(92);`
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8'
    })
    expect(child.status, child.stderr).toBe(91)
    expect(existsSync(join(harness.homeDir, 'projects', `${projectKey(harness.root)}.switch.json`))).toBe(false)
    expect(preparedJournals()).toHaveLength(1)
    const reopened = harness.open('desktop', { transport: 'desktop' })
    expect((await reopened.getProject()).name).toBe('Safety proof')
    expect(mode()).toBe('db')
    expect(preparedJournals()).toEqual([])
  })
})

describe('canonical-only active work migration guards', () => {

  it.each(['run', 'claim', 'queued_card'] as const)('refuses active %s work arriving only from canonical JSON', async (work) => {
    const app = await prepared()
    if (work === 'run') {
      const epic = (await app.listEpics())[0]!
      const run = await app.queueRun({ epicId: epic.id })
      await app.cancelRun({ runId: run.id, reason: 'Will import a newer canonical state' })
    } else {
      await app.createKanbanCard({ title: 'Canonical active work' })
    }
    await move(app, 'repo')
    const db = app.ctx().db
    if (work === 'run') {
      const run = db.get<{ id: string }>('SELECT id FROM runs')!
      const file = join(harness.root, '.darkmechanicus', 'history', run.id, 'run.json')
      const record = JSON.parse(readFileSync(file, 'utf8')) as { state: string; endedAt: null }
      record.state = 'running'; record.endedAt = null
      writeFileSync(file, JSON.stringify(record))
    } else {
      const card = (await app.listKanbanCards({})).lanes.backlog[0]!
      const worker = harness.open('orchestrator')
      await app.playKanbanCard({ cardId: card.id })
      if (work === 'claim') await worker.claimKanbanCard({ cardId: card.id })
      worker.close()
      db.run('DELETE FROM kanban_attempts WHERE card_id = ?', card.id)
      db.run("DELETE FROM kanban_events WHERE card_id = ? AND kind <> 'created'", card.id)
      db.run("UPDATE kanban_cards SET lane = 'backlog', play_requested_at = NULL, play_requested_by = NULL WHERE id = ?", card.id)
      db.run("DELETE FROM sync_state WHERE kind IN ('kanban_card','kanban_event')")
    }
    const expected = { run: 'active run', claim: 'claimed or uncertain', queued_card: 'queued Kanban' }[work]
    await expect(move(app, 'db')).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining(expected) })
    expect(mode()).toBe('repo')
    expect(existsSync(dbProjectDir(harness.root, harness.homeDir))).toBe(false)
    expect((await app.getProject()).name).toBe('Safety proof')
  })
})
