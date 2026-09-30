import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openWorkspace } from '../core/workspace'
import { createFolderRegistry } from '../main/desktop/folderRegistry'
import { createDesktopHandlers, type DesktopHandlers } from '../main/desktop/handlers'
import { buildMcpConfig } from '../main/desktop/mcpConfig'
import { createWorkspacePool, type WorkspacePool } from '../main/desktop/workspacePool'
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
