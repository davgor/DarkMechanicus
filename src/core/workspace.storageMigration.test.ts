import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultCapabilityProfile } from '../shared/domain/bundle'
import { createHarness, type Harness } from '../test/workspaceHarness'
import { pngBytes } from '../test/images'
import { nodeFs } from './repo/nodeFs'
import { dbProjectDir, resolveStorageMode } from './repo/storageMode'
import type { Db } from './db/database'
import type { Workspace } from './workspace'

let harness: Harness
beforeEach(() => { harness = createHarness() })
afterEach(() => { harness.cleanup() })

function records(db: Db): unknown {
  const tables = db.all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'search_index_%' AND name <> 'sync_state' ORDER BY name")
  return tables.map(({ name }) => [name, db.all(`SELECT * FROM "${name}"${name === 'meta' ? " WHERE key NOT IN ('checkout_branch', 'last_reconcile_at', 'reconcile_problems')" : ''}`).map((row) => JSON.stringify(row)).sort()])
}

function portableText(dir: string): string {
  return readdirSync(dir).filter((name) => name !== 'local').map((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? portableText(path) : name.endsWith('.json') ? readFileSync(path, 'utf8') : ''
  }).join('\n')
}

async function populated(): Promise<Workspace> {
  const workspace = harness.open('desktop', { mode: 'db', transport: 'desktop' })
  await workspace.initializeRepository({ name: 'Migration proof' })
  const epic = await workspace.createEpic({ title: 'Saved history' })
  const draft = await workspace.openDraft({ epicId: epic.id })
  await workspace.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
  const image = await workspace.uploadAttachment({ data: pngBytes(2, 3).toString('base64'), label: 'Migration image', purpose: 'reference' })
  await workspace.addComment({ epicId: epic.id, body: 'Keep this comment unchanged.', attachments: [image.id] })
  await workspace.openDraft({ epicId: epic.id })
  await workspace.createEpic({ title: 'Never saved draft' })
  await workspace.saveProfile({ name: 'migration-proof', description: 'Keep profile', capability: defaultCapabilityProfile() })
  const card = await workspace.createKanbanCard({ title: 'Keep the card and event', body: 'Migration history' })
  await workspace.playKanbanCard({ cardId: card.id })
  const worker = harness.open('orchestrator')
  const packet = await worker.claimKanbanCard({ cardId: card.id })
  if (packet.claimToken === null) throw new Error('Expected a fresh claim token')
  await worker.submitKanbanCard({ attemptId: packet.attemptId, claimToken: packet.claimToken, outputs: { summary: 'Historical completed card' } })
  await workspace.approveKanbanCard({ cardId: card.id })
  worker.close()
  const run = await workspace.queueRun({ epicId: epic.id })
  await workspace.cancelRun({ runId: run.id, reason: 'Terminal history retained' })
  return workspace
}

function resolved(): string {
  return resolveStorageMode({ repoRoot: harness.root, homeDir: harness.homeDir, fs: nodeFs })
}

const switchTo = (workspace: Workspace, mode: 'repo' | 'db'): Promise<unknown> =>
  workspace.switchStorageMode({ mode, confirmed: true })

describe('storage mode migration', () => {
  it('round trips every database row through JSON and removes the original store only after verification', async () => {
    const workspace = await populated()
    const before = records(workspace.ctx().db)
    const projectBefore = await workspace.getProject()
    await switchTo(workspace, 'repo')
    expect(resolved()).toBe('repo')
    expect((await workspace.getStorageStatus()).storage.mode).toBe('repo')
    expect(existsSync(dbProjectDir(harness.root, harness.homeDir))).toBe(false)
    const dm = join(harness.root, '.darkmechanicus')
    expect(existsSync(join(dm, 'local', 'migration-records.json'))).toBe(true)
    expect(records(workspace.ctx().db)).toEqual(before)
    expect(await workspace.getProject()).toEqual(projectBefore)
    await switchTo(workspace, 'db')
    expect(resolved()).toBe('db')
    expect(records(workspace.ctx().db)).toEqual(before)
    expect(await workspace.getProject()).toEqual(projectBefore)
    expect(existsSync(dm)).toBe(false)
    expect(existsSync(join(dbProjectDir(harness.root, harness.homeDir), 'local', 'state.sqlite'))).toBe(true)
  })

  it('purges only its own ignore entry and leaves MCP and installed skills alone', async () => {
    const workspace = await populated()
    await switchTo(workspace, 'repo')
    writeFileSync(join(harness.root, '.gitignore'), 'node_modules/\n.darkmechanicus/local/\ncustom/\n')
    writeFileSync(join(harness.root, '.mcp.json'), '{"keep":true}\n')
    await switchTo(workspace, 'db')
    expect(readFileSync(join(harness.root, '.gitignore'), 'utf8')).toBe('node_modules/\ncustom/\n')
    expect(readFileSync(join(harness.root, '.mcp.json'), 'utf8')).toBe('{"keep":true}\n')
    expect(existsSync(join(harness.root, '.darkmechanicus'))).toBe(false)
  })

  it.each(['queued', 'running', 'awaiting_checkpoint', 'paused'])('refuses an active %s run without touching either store', async (state) => {
    const workspace = await populated()
    workspace.ctx().db.run('UPDATE runs SET state = ?', state)
    const before = records(workspace.ctx().db)
    await expect(switchTo(workspace, 'repo')).rejects.toThrow(/active run/i)
    expect(resolved()).toBe('db')
    expect(records(workspace.ctx().db)).toEqual(before)
    expect(existsSync(join(harness.root, '.darkmechanicus'))).toBe(false)
  })

  it('refuses dirty tracked records and unknown Git status', async () => {
    const workspace = await populated()
    await switchTo(workspace, 'repo')
    harness.git.countUncommitted = async () => 1
    await expect(switchTo(workspace, 'db')).rejects.toThrow(/uncommitted/i)
    expect(resolved()).toBe('repo')
    harness.git.countUncommitted = async () => null
    await expect(switchTo(workspace, 'db')).rejects.toThrow(/Git/i)
    expect(resolved()).toBe('repo')
  })

  it('requires explicit confirmation and a desktop session', async () => {
    const workspace = await populated()
    await expect(workspace.switchStorageMode({ mode: 'repo', confirmed: false as true })).rejects.toThrow()
    const agent = harness.open('orchestrator')
    await expect(switchTo(agent, 'repo')).rejects.toMatchObject({ code: 'unauthorized' })
    expect(resolved()).toBe('db')
  })

  it('leaves the source unchanged when staging write fails', async () => {
    const original = await populated()
    original.close()
    const workspace = harness.open('desktop', { transport: 'desktop', fs: {
      ...nodeFs,
      writeFile(path, data) {
        if (path.includes('records.json')) throw new Error('Injected export interruption')
        nodeFs.writeFile(path, data)
      }
    } })
    const before = records(workspace.ctx().db)
    await expect(switchTo(workspace, 'repo')).rejects.toThrow('Injected export interruption')
    expect(resolved()).toBe('db')
    expect(records(workspace.ctx().db)).toEqual(before)
    expect(existsSync(join(harness.root, '.darkmechanicus'))).toBe(false)
  })

  it('rolls back a failed cutover after publishing the export, keeping the original usable', async () => {
    const original = await populated()
    original.close()
    const workspace = harness.open('desktop', { transport: 'desktop', fs: {
      ...nodeFs,
      rename(from, to) {
        if (to.endsWith('.switch-retired')) throw new Error('Injected commit failure')
        nodeFs.rename(from, to)
      }
    } })
    const before = records(workspace.ctx().db)
    await expect(switchTo(workspace, 'repo')).rejects.toThrow('Injected commit failure')
    expect(resolved()).toBe('db')
    expect(records(workspace.ctx().db)).toEqual(before)
    expect(existsSync(join(harness.root, '.darkmechanicus'))).toBe(false)
  })

  it('resumes a partially purged committed switch on the next open', async () => {
    const original = await populated()
    const expected = (await original.listEpics()).map((epic) => epic.id).sort()
    original.close()
    let interrupted = false
    const workspace = harness.open('desktop', { transport: 'desktop', fs: {
      ...nodeFs,
      remove(path) {
        if (!interrupted && path.includes('.switch-retired') && path.endsWith('machine.json')) {
          interrupted = true
          throw new Error('Injected purge interruption')
        }
        nodeFs.remove(path)
      }
    } })
    const result = await workspace.switchStorageMode({ mode: 'repo', confirmed: true })
    expect(result).toMatchObject({ mode: 'repo', cleanupPending: true })
    expect((await workspace.listEpics()).map((epic) => epic.id).sort()).toEqual(expected)
    workspace.close()
    const reopened = harness.open('desktop', { transport: 'desktop' })
    expect((await reopened.listEpics()).map((epic) => epic.id).sort()).toEqual(expected)
    expect(existsSync(`${dbProjectDir(harness.root, harness.homeDir)}.switch-retired`)).toBe(false)
  })

  it('fences a stale connection after the storage mode moves', async () => {
    const workspace = await populated()
    await switchTo(workspace, 'repo')
    const stale = harness.open('reader')
    harness.clock.advanceSeconds(61)
    await switchTo(workspace, 'db')
    await expect(stale.getProject()).rejects.toThrow(/storage mode changed/i)
    expect(() => stale.heartbeat()).toThrow(/storage mode changed/i)
    stale.close()
  })

  it('refuses claimed Kanban work even without an active epic run', async () => {
    const workspace = await populated()
    const db = workspace.ctx().db
    const card = await workspace.createKanbanCard({ title: 'Claimed work' })
    db.run(`INSERT INTO kanban_attempts (id, card_id, number, state, claim_secret, created_at)
      VALUES ('ka_00000000000000000000000001', ?, 1, 'claimed', 'private-claim-secret', ?)`, card.id, harness.clock.nowIso())
    await expect(switchTo(workspace, 'repo')).rejects.toThrow(/claimed/i)
    expect(resolved()).toBe('db')
  })

  it('refuses concurrent connected sessions and pending exports', async () => {
    const workspace = await populated()
    const agent = harness.open('reader')
    await expect(switchTo(workspace, 'repo')).rejects.toThrow(/other connected/i)
    agent.close()
    workspace.ctx().db.run("UPDATE outbox SET state = 'failed', last_error = 'disk full' WHERE id = (SELECT MIN(id) FROM outbox)")
    await expect(switchTo(workspace, 'repo')).rejects.toThrow(/pending records/i)
    expect(resolved()).toBe('db')
  })

  it('does not put private credentials in portable records or reuse the checkpoint after canonical edits', async () => {
    const workspace = await populated()
    const issued = await workspace.issueGrant({ role: 'reader', label: 'Private migration grant' })
    await switchTo(workspace, 'repo')
    expect(readFileSync(join(harness.root, '.darkmechanicus', '.gitignore'), 'utf8')).toBe('local/\n')
    expect(portableText(join(harness.root, '.darkmechanicus'))).not.toContain(issued.token)
    expect(portableText(join(harness.root, '.darkmechanicus'))).not.toContain('Private migration grant')
    const profiles = join(harness.root, '.darkmechanicus', 'profiles', 'migration-proof.json')
    const profile = JSON.parse(readFileSync(profiles, 'utf8')) as { description: string }
    profile.description = 'Canonical edit after export'
    writeFileSync(profiles, JSON.stringify(profile))
    await switchTo(workspace, 'db')
    expect((await workspace.getProfile({ name: 'migration-proof' })).description).toBe('Canonical edit after export')
    expect((await workspace.listGrants()).some((grant) => grant.id === issued.grant.id)).toBe(true)
  })

  it('keeps image bytes after purging a repo source whose cache held metadata only', async () => {
    const workspace = await populated()
    await switchTo(workspace, 'repo')
    workspace.ctx().db.run('UPDATE attachments SET data = NULL')
    await switchTo(workspace, 'db')
    const image = workspace.ctx().db.get<{ data: Uint8Array }>('SELECT data FROM attachments')
    expect(Buffer.from(image?.data ?? [])).toEqual(pngBytes(2, 3))
    expect(existsSync(join(harness.root, '.darkmechanicus'))).toBe(false)
  })

  it.each([
    ['db', 'before_commit'], ['db', 'after_commit'], ['repo', 'before_commit'], ['repo', 'after_commit']
  ] as const)('recovers a %s process interruption %s without losing records', async (sourceMode, point) => {
    const workspace = await populated()
    if (sourceMode === 'repo') await switchTo(workspace, 'repo')
    const epics = (await workspace.listEpics()).map((epic) => epic.id).sort()
    const targetMode = sourceMode === 'db' ? 'repo' : 'db'
    const source = sourceMode === 'db' ? dbProjectDir(harness.root, harness.homeDir) : join(harness.root, '.darkmechanicus')
    const target = targetMode === 'db' ? dbProjectDir(harness.root, harness.homeDir) : join(harness.root, '.darkmechanicus')
    workspace.close()
    const module = new URL('./workspace.ts', import.meta.url).href
    const fsModule = new URL('./repo/nodeFs.ts', import.meta.url).href
    const script = `
      import { openWorkspace } from ${JSON.stringify(module)};
      import { nodeFs } from ${JSON.stringify(fsModule)};
      const app = openWorkspace({ repoRoot: ${JSON.stringify(harness.root)}, homeDir: ${JSON.stringify(harness.homeDir)},
        role: 'desktop', label: 'Crash proof', transport: 'desktop', autoReconcile: false,
        git: { head: () => ({ branch: 'main', commit: '${'a'.repeat(40)}', detached: false }), countUncommitted: async () => 0 },
        fs: { ...nodeFs, rename(from, to) {
          nodeFs.rename(from, to);
          const before = ${JSON.stringify(sourceMode)} === 'db' ? to === ${JSON.stringify(target)} : to.endsWith('migration-records.json');
          const after = ${JSON.stringify(sourceMode)} === 'db' ? to.endsWith('.switch-retired') : to === ${JSON.stringify(target)};
          if (${JSON.stringify(point)} === 'before_commit' ? before : after) process.exit(91);
        }} });
      await app.switchStorageMode({ mode: ${JSON.stringify(targetMode)}, confirmed: true }); process.exit(92);`
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8' })
    expect(child.status, child.stderr).toBe(91)
    const reopened = harness.open('desktop', { transport: 'desktop' })
    expect((await reopened.getStorageStatus()).storage.mode).toBe(point === 'before_commit' ? sourceMode : targetMode)
    expect((await reopened.listEpics()).map((epic) => epic.id).sort()).toEqual(epics)
    expect(existsSync(`${target}.switch-staging`)).toBe(false)
    expect(existsSync(`${source}.switch-retired`)).toBe(false)
  })

  it('fences commands on an existing connection while the source is being copied', async () => {
    const original = await populated()
    original.close()
    let during: Promise<unknown> | null = null
    const workspace = harness.open('desktop', { transport: 'desktop', fs: {
      ...nodeFs,
      writeFile(path, data) {
        if (path.includes('migration-records.json')) during = workspace.getProject().catch((error: unknown) => error)
        nodeFs.writeFile(path, data)
      }
    } })
    await switchTo(workspace, 'repo')
    expect(await during).toMatchObject({ code: 'conflict', message: expect.stringContaining('switch in progress') })
    expect((await workspace.getProject()).name).toBe('Migration proof')
  })
})
