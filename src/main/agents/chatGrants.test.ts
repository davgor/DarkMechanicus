/**
 * A chat's grant is revoked through the workspace it was issued in, held since issue, never by
 * finding its folder again: a folder renamed or untracked while the chat ran still has its grant
 * revoked, in the database it moved with. One that cannot be reached is logged in one line naming
 * the grant and its expiry, and the dispose goes on.
 */
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatRecord } from '../../shared/agents/chat'
import { DomainError } from '../../core/errors'
import { openWorkspace } from '../../core/workspace'
import { createSequentialIds, createTestClock } from '../../test/testContext'
import { createFakeGit } from '../../test/workspaceHarness'
import { buildCliConfig } from '../desktop/cliConfig'
import { createWorkspacePool, type WorkspacePool } from '../desktop/workspacePool'
import { AT, connectedAgents, fakeAdapters, memoryChatFs, memoryChatStore } from './__mocks__/fakeChatAdapter'
import { createChatGrants } from './chatGrants'
import { createSessionManager, type SessionManager } from './sessionManager'

/** The test clock's start plus the twelve hours a chat grant lasts. */
const EXPIRES_AT = '2026-04-01T21:00:00.000Z'

interface GrantRow {
  id: string
  expires_at: string
  revoked_at: string | null
}

interface Rig {
  manager: SessionManager
  pool: WorkspacePool
  tracked: Set<string>
  logged: string[]
  errors: unknown[]
}

let root: string
let repo: string
let moved: string

beforeEach(() => {
  // Canonical from the start: on macOS the temporary directory is reached through the /var symlink.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dm-chat-grants-')))
  repo = join(root, 'scratch-a')
  moved = join(root, 'scratch-a-renamed')
  mkdirSync(repo)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** The desktop's composition: a pool of real desktop workspaces, reached only for tracked folders. */
async function rig(): Promise<Rig> {
  const clock = createTestClock('2026-04-01T09:00:00.000Z')
  const ids = createSequentialIds()
  const git = createFakeGit({ branch: 'main', commit: 'b'.repeat(40), detached: false })
  const homeDir = join(root, 'dm-home')
  const pool = createWorkspacePool((repoRoot) =>
    openWorkspace({ repoRoot, role: 'desktop', label: 'Desktop', transport: 'desktop', homeDir, clock, ids, git })
  )
  await pool.get(repo).initializeRepository({ name: 'scratch-a' })
  const tracked = new Set([repo])
  const logged: string[] = []
  const errors: unknown[] = []
  const grants = createChatGrants({
    workspaceFor: (folder) => {
      if (!tracked.has(folder)) {
        throw new DomainError('unauthorized', 'That folder is not tracked by Dark Mechanicus.')
      }
      return pool.get(folder)
    },
    cliFor: (folder) => buildCliConfig({ packaged: false, execPath: '/bin/electron', appPath: '/app', repoPath: folder }),
    minutes: 12 * 60,
    log: (line) => logged.push(line)
  })
  const manager = createSessionManager({
    store: memoryChatStore(memoryChatFs([repo])),
    adapters: fakeAdapters().definitions,
    agentFor: connectedAgents(),
    folders: { trackedFolder: (path) => (tracked.has(path) ? path : null) },
    ...grants,
    push: () => {},
    now: () => AT,
    onError: (error) => errors.push(error)
  })
  return { manager, pool, tracked, logged, errors }
}

function settle(): Promise<void> {
  // Promise.withResolvers is outside the TypeScript lib this repo targets.
  return new Promise((resolve) => setImmediate(resolve))
}

/** The grants in the folder's own `state.sqlite`, read after every session on it has closed. */
function grantsIn(folder: string): GrantRow[] {
  const db = new DatabaseSync(join(folder, '.darkmechanicus', 'local', 'state.sqlite'))
  try {
    return db.prepare('SELECT id, expires_at, revoked_at FROM grants').all() as unknown as GrantRow[]
  } finally {
    db.close()
  }
}

function openSessionsIn(folder: string): number {
  const db = new DatabaseSync(join(folder, '.darkmechanicus', 'local', 'state.sqlite'))
  try {
    const row = db.prepare('SELECT COUNT(*) AS open FROM sessions WHERE ended_at IS NULL').get() as { open: number }
    return row.open
  } finally {
    db.close()
  }
}

/** Starts a chat's agent, so its grant is issued in the folder's workspace. */
async function liveChat(state: Rig): Promise<ChatRecord> {
  const chat = state.manager.createChat({ folder: repo, agent: 'claude', role: 'orchestrator', title: 'Fix the build' })
  await state.manager.send(chat, 'hello')
  await settle()
  expect(grantsIn(repo)).toEqual([expect.objectContaining({ revoked_at: null })])
  return chat
}

const ENDINGS = [
  ['the next message stops it', (state: Rig, chat: ChatRecord) => state.manager.send(chat, 'again')],
  ['the app quits', (state: Rig) => state.manager.disposeAll()]
] as const

describe('chat grants: revoked through the workspace they were issued in', () => {
  it.each(ENDINGS)('revokes the grant of a chat whose folder was renamed while it ran, when %s', async (_when, end) => {
    const state = await rig()
    const chat = await liveChat(state)
    renameSync(repo, moved)

    await end(state, chat)
    await settle()
    state.pool.closeAll()

    expect(grantsIn(moved)).toEqual([expect.objectContaining({ revoked_at: expect.any(String) })])
    expect(state.manager.liveCount()).toBe(0)
    expect([state.logged, state.errors]).toEqual([[], []])
  })

  it('revokes the grant of a chat whose folder was untracked while it ran, closing the workspace it reopened', async () => {
    const state = await rig()
    const chat = await liveChat(state)
    // What untracking a folder does: the registry forgets it and the pool closes its workspace.
    state.tracked.delete(repo)
    state.pool.close(repo)

    await state.manager.send(chat, 'again')
    await settle()

    expect(grantsIn(repo)).toEqual([expect.objectContaining({ revoked_at: expect.any(String) })])
    expect(openSessionsIn(repo)).toBe(0)
    expect([state.logged, state.errors]).toEqual([[], []])
  })
})

describe('chat grants: a workspace that cannot be reached', () => {
  it('logs one line naming the grant and its expiry, and the dispose does not throw', async () => {
    const state = await rig()
    await liveChat(state)
    // The pool released the workspace before the chats were disposed, and the folder has moved since.
    state.pool.closeAll()
    renameSync(repo, moved)

    await expect(state.manager.disposeAll()).resolves.toBeUndefined()

    const [grant] = grantsIn(moved)
    expect(grant).toMatchObject({ expires_at: EXPIRES_AT, revoked_at: null })
    expect(state.logged).toHaveLength(1)
    expect(state.logged[0]).toContain(grant?.id)
    expect(state.logged[0]).toContain(EXPIRES_AT)
    expect(state.logged[0]).not.toContain('\n')
    expect(state.errors).toEqual([])
    expect(state.manager.liveCount()).toBe(0)
  })

  it('logs one line for a grant it never issued, and does not throw', async () => {
    const logged: string[] = []
    const grants = createChatGrants({
      workspaceFor: () => {
        throw new Error('not asked at revoke')
      },
      cliFor: () => ({ command: 'node', args: [], env: {} }),
      minutes: 60,
      log: (line) => logged.push(line)
    })

    await expect(grants.revokeChatGrant('gr_unknown')).resolves.toBeUndefined()

    expect(logged).toEqual([expect.stringContaining('gr_unknown')])
  })
})
