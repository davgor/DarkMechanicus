import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Db, openDatabase } from '../../core/db/database'
import { DomainError } from '../../core/errors'
import { migrate } from '../../core/db/migrations'
import { idleAgentDeps } from '../../test/idleAgents'
import { createAgentRegistry, type AgentRegistry } from './agentRegistry'
import { APP_MIGRATIONS } from './appDatabase'
import { createFolderAgentDefaults, type FolderAgentDefaults } from './folderAgentDefaults'
import { createFolderRegistry, type FolderRegistry } from './folderRegistry'
import { createDesktopHandlers, type DesktopHandlers } from './handlers'

const STAMP = '2026-01-01T00:00:00.000Z'

interface World {
  db: Db
  agents: AgentRegistry
  folders: FolderRegistry
  defaults: FolderAgentDefaults
  handlers: DesktopHandlers
  repo: string
}

let root: string

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-folder-defaults-')))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function createWorld(): World {
  const db = openDatabase(':memory:')
  migrate(db, APP_MIGRATIONS)
  const agents = createAgentRegistry({ db, now: () => STAMP })
  agents.upsert({ kind: 'claude', executablePath: '/bin/claude', version: '1', connectedVia: 'found' })
  agents.upsert({ kind: 'codex', executablePath: '/bin/codex', version: '1', connectedVia: 'found' })
  const folders = createFolderRegistry({ file: join(root, 'folders.json'), homeDir: root, dmHome: join(root, 'dm') })
  const repo = join(root, 'repo')
  mkdirSync(repo)
  folders.track(repo)
  const defaults = createFolderAgentDefaults({ db, now: () => STAMP })
  const handlers = createDesktopHandlers({
    ...idleAgentDeps(),
    agents,
    folderDefaults: defaults,
    registry: folders,
    pool: { get: () => Promise.reject(new Error('no workspace')) as never, close: () => undefined },
    pickDirectory: async () => null,
    writeClipboard: () => undefined,
    openExternal: async () => undefined,
    mcpConfig: () => ({ command: 'node', args: [], env: {}, json: '{}', note: 'n' }),
    installSkills: () => ({ written: [] }),
    connectClaudeCode: () => ({ outcome: 'created' }),
    previewBoardRemoval: () => ({ remove: [], kept: [], editByHand: [] }),
    removeBoardFiles: () => ({ removed: [], removedFolders: [], kept: [], editByHand: [] })
  })
  return { db, agents, folders, defaults, handlers, repo }
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof DomainError ? error.code : `unexpected: ${String(error)}`
  }
  return 'resolved'
}

function rowCount(db: Db): number {
  return db.get<{ n: number }>('SELECT COUNT(*) AS n FROM folder_agent_defaults')?.n ?? -1
}

describe('createFolderAgentDefaults', () => {
  it('sets, reads, replaces and clears a folder default', () => {
    const { defaults, repo, db } = createWorld()
    expect(defaults.get(repo)).toBeNull()
    defaults.set(repo, 'claude')
    expect(defaults.get(repo)).toBe('claude')
    defaults.set(repo, 'codex')
    expect(defaults.get(repo)).toBe('codex')
    expect(db.get('SELECT folder, agent_id, updated_at FROM folder_agent_defaults')).toEqual({
      folder: repo,
      agent_id: 'codex',
      updated_at: STAMP
    })
    defaults.set(repo, null)
    expect(defaults.get(repo)).toBeNull()
    expect(rowCount(db)).toBe(0)
  })
})

describe('folder default IPC handlers', () => {
  it('writes and reads the default by the canonical folder path', async () => {
    const { handlers, repo, defaults } = createWorld()
    expect(await handlers.folderDefaultAgent(repo)).toBeNull()
    expect(await handlers.setFolderDefaultAgent({ folder: `${repo}/`, agentId: 'claude' })).toBe('claude')
    expect(defaults.get(repo)).toBe('claude')
    expect(await handlers.folderDefaultAgent(repo)).toBe('claude')
    expect(await handlers.setFolderDefaultAgent({ folder: repo, agentId: null })).toBeNull()
    expect(await handlers.folderDefaultAgent(repo)).toBeNull()
  })

  it('reads the tracked folder default through a symlinked path', async () => {
    const { handlers, repo } = createWorld()
    const link = join(root, 'link')
    symlinkSync(repo, link)
    await handlers.setFolderDefaultAgent({ folder: repo, agentId: 'codex' })
    expect(await handlers.folderDefaultAgent(link)).toBe('codex')
  })
})

describe('folder default IPC refusals', () => {
  it('refuses an untracked folder with unauthorized', async () => {
    const { handlers, db } = createWorld()
    const other = join(root, 'other')
    mkdirSync(other)
    expect(await codeOf(handlers.folderDefaultAgent(other))).toBe('unauthorized')
    expect(await codeOf(handlers.setFolderDefaultAgent({ folder: other, agentId: 'claude' }))).toBe('unauthorized')
    expect(await codeOf(handlers.setFolderDefaultAgent({ folder: other, agentId: null }))).toBe('unauthorized')
    expect(rowCount(db)).toBe(0)
  })

  it('refuses an agent that is not connected with not_found and a malformed one with invalid_input', async () => {
    const { handlers, repo, db } = createWorld()
    expect(await codeOf(handlers.setFolderDefaultAgent({ folder: repo, agentId: 'cursor' }))).toBe('not_found')
    expect(
      await codeOf(handlers.setFolderDefaultAgent({ folder: repo, agentId: 'cu_0123456789abcdefghjkmnpqrs' }))
    ).toBe('not_found')
    expect(await codeOf(handlers.setFolderDefaultAgent({ folder: repo, agentId: '/bin/sh' }))).toBe('invalid_input')
    expect(await codeOf(handlers.setFolderDefaultAgent({ folder: repo, agentId: 'claude', extra: 1 }))).toBe(
      'invalid_input'
    )
    expect(await codeOf(handlers.setFolderDefaultAgent('nope'))).toBe('invalid_input')
    expect(rowCount(db)).toBe(0)
  })

  it('clears the default when the agent is removed', async () => {
    const { handlers, repo, db } = createWorld()
    await handlers.setFolderDefaultAgent({ folder: repo, agentId: 'claude' })
    await handlers.removeAgent('claude')
    expect(await handlers.folderDefaultAgent(repo)).toBeNull()
    expect(rowCount(db)).toBe(0)
  })

  it('clears the default when the folder is untracked', async () => {
    const { handlers, repo, db, folders } = createWorld()
    await handlers.setFolderDefaultAgent({ folder: repo, agentId: 'claude' })
    await handlers.untrackFolder(repo)
    expect(rowCount(db)).toBe(0)
    folders.track(repo)
    expect(await handlers.folderDefaultAgent(repo)).toBeNull()
  })
})
