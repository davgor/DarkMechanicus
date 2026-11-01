/**
 * A chat's grant is revoked through the workspace it was issued in, held since issue, never by
 * finding its folder again: a folder renamed or untracked while the chat ran still has its grant
 * revoked, in the database it moved with. One that cannot be reached is logged in one line naming
 * the grant and its expiry, and the revoke does not throw.
 */
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import { openWorkspace } from '../../core/workspace'
import { createSequentialIds, createTestClock } from '../../test/testContext'
import { createFakeGit } from '../../test/workspaceHarness'
import { buildCliConfig } from '../desktop/cliConfig'
import { createWorkspacePool, type WorkspacePool } from '../desktop/workspacePool'
import { createChatGrants, type ChatGrants } from './chatGrants'

/** The test clock's start plus the twelve hours a chat grant lasts. */
const EXPIRES_AT = '2026-04-01T21:00:00.000Z'

interface GrantRow {
  id: string
  expires_at: string
  revoked_at: string | null
}

interface Rig {
  grants: ChatGrants
  pool: WorkspacePool
  tracked: Set<string>
  logged: string[]
}

let root: string
let repo: string
let moved: string

beforeEach(() => {
  // Canonical from the start: on macOS the temporary directory is reached through the /var symlink.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-chat-grants-')))
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
  return { grants, pool, tracked, logged }
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

/** Issues a chat's grant in the folder's workspace, as a chat terminal's start does; returns its id. */
async function liveChat(state: Rig): Promise<string> {
  const { grantId } = await state.grants.issueChatCli(repo, { role: 'orchestrator', allowSave: true, label: 'Claude Code · Fix the build' })
  expect(grantsIn(repo)).toEqual([expect.objectContaining({ id: grantId, revoked_at: null })])
  return grantId
}

describe('chat grants: revoked through the workspace they were issued in', () => {
  // Windows refuses to rename a folder while the workspace holds its state.sqlite open, so it cannot happen there.
  it.skipIf(process.platform === 'win32')('revokes the grant of a chat whose folder was renamed while it ran', async () => {
    const state = await rig()
    const grantId = await liveChat(state)
    renameSync(repo, moved)

    await state.grants.revokeChatGrant(grantId)
    state.pool.closeAll()

    expect(grantsIn(moved)).toEqual([expect.objectContaining({ revoked_at: expect.any(String) })])
    expect(state.logged).toEqual([])
  })

  it('revokes the grant of a chat whose folder was untracked while it ran, closing the workspace it reopened', async () => {
    const state = await rig()
    const grantId = await liveChat(state)
    // What untracking a folder does: the registry forgets it and the pool closes its workspace.
    state.tracked.delete(repo)
    state.pool.close(repo)

    await state.grants.revokeChatGrant(grantId)

    expect(grantsIn(repo)).toEqual([expect.objectContaining({ revoked_at: expect.any(String) })])
    expect(openSessionsIn(repo)).toBe(0)
    expect(state.logged).toEqual([])
  })
})

describe('chat grants: a workspace that cannot be reached', () => {
  it('logs one line naming the grant and its expiry, and the revoke does not throw', async () => {
    const state = await rig()
    const grantId = await liveChat(state)
    // The pool released the workspace before the chat's terminal ended, and the folder has moved since.
    state.pool.closeAll()
    renameSync(repo, moved)

    await expect(state.grants.revokeChatGrant(grantId)).resolves.toBeUndefined()

    const [grant] = grantsIn(moved)
    expect(grant).toMatchObject({ id: grantId, expires_at: EXPIRES_AT, revoked_at: null })
    expect(state.logged).toHaveLength(1)
    expect(state.logged[0]).toContain(grantId)
    expect(state.logged[0]).toContain(EXPIRES_AT)
    expect(state.logged[0]).not.toContain('\n')
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
