import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openWorkspace } from '../core/workspace'
import { createFolderRegistry } from '../main/desktop/folderRegistry'
import { createDesktopHandlers, type DesktopHandlers } from '../main/desktop/handlers'
import { buildMcpConfig } from '../main/desktop/mcpConfig'
import { createWorkspacePool, type WorkspacePool } from '../main/desktop/workspacePool'
import { defaultCapabilityProfile } from '../shared/domain/bundle'
import { createSequentialIds, createTestClock } from '../test/testContext'
import { createFakeGit } from '../test/workspaceHarness'

interface Desktop {
  handlers: DesktopHandlers
  pool: WorkspacePool
  repo: string
  cleanup(): void
}

function createDesktop(): Desktop {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'dm-desktop-repo-')))
  const config = mkdtempSync(join(tmpdir(), 'dm-desktop-config-'))
  const clock = createTestClock('2026-04-01T09:00:00.000Z')
  const ids = createSequentialIds()
  const git = createFakeGit({ branch: 'main', commit: 'b'.repeat(40), detached: false })
  const pool = createWorkspacePool((repoRoot) =>
    openWorkspace({ repoRoot, role: 'desktop', label: 'Desktop', transport: 'desktop', clock, ids, git })
  )
  const handlers = createDesktopHandlers({
    registry: createFolderRegistry({ file: join(config, 'folders.json'), homeDir: config }),
    pool,
    pickDirectory: async () => repo,
    writeClipboard: () => undefined,
    openExternal: async () => undefined,
    mcpConfig: (repoPath) => buildMcpConfig({ packaged: false, execPath: 'electron', appPath: '/app', repoPath }),
    installSkills: () => ({ written: [] })
  })
  return {
    handlers,
    pool,
    repo,
    cleanup() {
      pool.closeAll()
      rmSync(repo, { recursive: true, force: true })
      rmSync(config, { recursive: true, force: true })
    }
  }
}

describe('desktop IPC handlers over the real Workspace', () => {
  let desktop: Desktop

  beforeEach(() => {
    desktop = createDesktop()
  })

  afterEach(() => {
    desktop.cleanup()
  })

  it('tracks a folder, initializes it, and authors an epic through dm:command', async () => {
    const picked = await desktop.handlers.pickFolder()
    expect([picked.added, picked.folder?.initialized]).toEqual([true, false])
    const again = await desktop.handlers.pickFolder()
    expect(again.added).toBe(false)

    const init = await desktop.handlers.command(desktop.repo, 'initializeRepository', { name: 'desk' })
    expect(init.ok).toBe(true)
    const created = await desktop.handlers.command(desktop.repo, 'createEpic', { title: 'From the desktop' })
    expect(created.ok).toBe(true)
    const listed = await desktop.handlers.command(desktop.repo, 'listEpics', undefined)
    expect(listed.ok ? (listed.data as { title: string }[]).map((epic) => epic.title) : listed.error).toEqual([
      'From the desktop'
    ])
    const folders = await desktop.handlers.listFolders()
    expect(folders.map((folder) => [folder.path, folder.initialized])).toEqual([[desktop.repo, true]])
  })

  it('rejects agent-only commands and untracked folders without opening anything', async () => {
    await desktop.handlers.pickFolder()
    const claim = await desktop.handlers.command(desktop.repo, 'claimTicket', {})
    expect(claim.ok ? 'ok' : claim.error.code).toBe('unauthorized')
    const elsewhere = await desktop.handlers.command(join(desktop.repo, 'nested'), 'listEpics', undefined)
    expect(elsewhere.ok ? 'ok' : elsewhere.error.code).toBe('unauthorized')
    const invalid = await desktop.handlers.command(desktop.repo, 'getEpic', { epicId: '../../etc' })
    expect(invalid.ok ? 'ok' : invalid.error.code).toBe('invalid_input')
  })
})

describe('desktop comments over the real Workspace', () => {
  let desktop: Desktop

  beforeEach(() => {
    desktop = createDesktop()
  })

  afterEach(() => {
    desktop.cleanup()
  })

  it('adds and lists a ticket comment through dm:command, signed by the desktop session', async () => {
    await desktop.handlers.pickFolder()
    await desktop.handlers.command(desktop.repo, 'initializeRepository', { name: 'desk' })
    const created = await desktop.handlers.command(desktop.repo, 'createEpic', { title: 'Commented epic' })
    const epicId = created.ok ? (created.data as { id: string }).id : ''
    const draft = await desktop.handlers.command(desktop.repo, 'updatePlanDraft', {
      epicId,
      ops: [{ op: 'add_ticket', ref: 't', sprint: '1', ticket: { title: 'Only ticket' } }]
    })
    const ticketId = draft.ok ? ((draft.data as { refMap: Record<string, string> }).refMap['t'] ?? '') : ''
    const added = await desktop.handlers.command(desktop.repo, 'addComment', { epicId, ticketId, body: 'Looks **good**' })
    expect(added.ok ? added.data : added.error).toMatchObject({ epicId, ticketId, body: 'Looks **good**', author: { role: 'desktop', label: 'Desktop' } })
    const listed = await desktop.handlers.command(desktop.repo, 'listComments', { epicId, ticketId })
    expect(listed.ok ? listed.data : listed.error).toEqual([added.ok ? added.data : null])
    const blank = await desktop.handlers.command(desktop.repo, 'addComment', { epicId, body: '   ' })
    expect(blank.ok ? 'ok' : blank.error.code).toBe('invalid_input')
  })
})

describe('named capability profiles through dm:command', () => {
  let desktop: Desktop

  beforeEach(() => {
    desktop = createDesktop()
  })

  afterEach(() => {
    desktop.cleanup()
  })

  it('saves, lists, and reads profiles, and rejects unsafe names', async () => {
    await desktop.handlers.pickFolder()
    await desktop.handlers.command(desktop.repo, 'initializeRepository', { name: 'desk' })
    const capability = { ...defaultCapabilityProfile(), workType: 'review' as const }
    const saved = await desktop.handlers.command(desktop.repo, 'saveProfile', { name: 'deep-review', description: 'Careful', capability })
    expect(saved).toEqual({
      ok: true,
      data: { name: 'deep-review', description: 'Careful', capability, revision: 1, updatedAt: '2026-04-01T09:00:00.000Z' }
    })
    const listed = await desktop.handlers.command(desktop.repo, 'listProfiles', undefined)
    expect(listed.ok ? (listed.data as { name: string }[]).map((profile) => profile.name) : listed.error).toEqual(['deep-review'])
    const read = await desktop.handlers.command(desktop.repo, 'getProfile', { name: 'deep-review' })
    expect(read.ok ? (read.data as { revision: number }).revision : read.error).toBe(1)
    const unsafe = await desktop.handlers.command(desktop.repo, 'saveProfile', { name: '../escape', capability })
    expect(unsafe.ok ? 'ok' : unsafe.error.code).toBe('invalid_input')
    expect(existsSync(join(desktop.repo, '.darkmechanicus', 'profiles', 'deep-review.json'))).toBe(true)
  })
})
