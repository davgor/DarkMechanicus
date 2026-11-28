/**
 * A chat's grant is revoked through the workspace it was issued in, held since issue, never by
 * finding its folder again: a folder renamed or untracked while the chat ran still has its grant
 * revoked, in the database it moved with. One that cannot be reached is logged in one line naming
 * the grant and its expiry, and the revoke does not throw. While the chat runs its grant is renewed
 * the same way, to the grant's length from the renewal.
 */
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DomainError } from '../../core/errors'
import { openWorkspace } from '../../core/workspace'
import { createSequentialIds, createTestClock, type TestClock } from '../../test/testContext'
import { createFakeGit, TEST_STORAGE } from '../../test/workspaceHarness'
import { buildCliConfig } from '../desktop/cliConfig'
import { createTestWorkspacePool as createWorkspacePool, type TestWorkspacePool as WorkspacePool } from '../desktop/__mocks__/projectWorkspaceFixture'
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
  clock: TestClock
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
async function rig(browserAddress?: () => string | undefined): Promise<Rig> {
  const clock = createTestClock('2026-04-01T09:00:00.000Z')
  const ids = createSequentialIds()
  const git = createFakeGit({ branch: 'main', commit: 'b'.repeat(40), detached: false })
  const homeDir = join(root, 'dm-home')
  const pool = createWorkspacePool((repoRoot) =>
    openWorkspace({ repoRoot, role: 'desktop', label: 'Desktop', transport: 'desktop', homeDir, clock, ids, git, ...TEST_STORAGE })
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
    // A launch environment that already carries a browser address, which no chat may inherit.
    cliFor: (folder) => {
      const cli = buildCliConfig({ execPath: '/bin/electron', appPath: '/app', repoPath: folder })
      return { ...cli, env: { ...cli.env, DM_BROWSER_PIPE: 'inherited-pipe' } }
    },
    minutes: 12 * 60,
    browserAddress,
    log: (line) => logged.push(line)
  })
  return { grants, clock, pool, tracked, logged }
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
    await state.pool.closeAll()

    expect(grantsIn(moved)).toEqual([expect.objectContaining({ revoked_at: expect.any(String) })])
    expect(state.logged).toEqual([])
  })

  it('revokes the grant of a chat whose folder was untracked while it ran, closing the workspace it reopened', async () => {
    const state = await rig()
    const grantId = await liveChat(state)
    // What untracking a folder does: the registry forgets it and the pool closes its workspace.
    state.tracked.delete(repo)
    await state.pool.close(repo)

    await state.grants.revokeChatGrant(grantId)

    expect(grantsIn(repo)).toEqual([expect.objectContaining({ revoked_at: expect.any(String) })])
    expect(openSessionsIn(repo)).toBe(0)
    expect(state.logged).toEqual([])
  })

  it('binds an OMP chat’s grant to its mailbox at issue, and closes that binding with the revoke after an untrack', async () => {
    const state = await rig()
    const issued = await state.grants.issueChatCli(repo, { role: 'worker', allowSave: false, label: 'OMP · Scout' }, { id: 'chat_scout', agent: 'omp', title: 'Scout', kind: 'omp' })
    expect(issued.endpointId).toMatch(/^me_/)
    state.tracked.delete(repo)
    await state.pool.close(repo)

    await state.grants.revokeChatGrant(issued.grantId)

    const db = new DatabaseSync(join(repo, '.darkmechanicus', 'local', 'state.sqlite'))
    try {
      expect(db.prepare('SELECT grant_id, endpoint_id, close_reason FROM agent_mail_bindings').all()).toEqual([
        { grant_id: issued.grantId, endpoint_id: issued.endpointId, close_reason: 'grant_ended' }
      ])
    } finally {
      db.close()
    }
    expect(grantsIn(repo)).toEqual([expect.objectContaining({ id: issued.grantId, revoked_at: expect.any(String) })])
    expect(openSessionsIn(repo)).toBe(0)
    expect(state.logged).toEqual([])
  })
})

describe('chat grants: a workspace that cannot be reached', () => {
  it('logs one line naming the grant and its expiry, and the revoke does not throw', async () => {
    const state = await rig()
    const grantId = await liveChat(state)
    // The pool released the workspace before the chat's terminal ended, and the folder has moved since.
    await state.pool.closeAll()
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

describe('chat grants: renewed while the chat runs', () => {
  it('moves the grant’s expiry to twelve hours from the renewal, in the workspace it was issued in', async () => {
    const state = await rig()
    const grantId = await liveChat(state)
    state.clock.advanceSeconds(11 * 60 * 60)

    await state.grants.renewChatGrant(grantId)
    await state.pool.closeAll()

    expect(grantsIn(repo)).toEqual([{ id: grantId, expires_at: '2026-04-02T08:00:00.000Z', revoked_at: null }])
    expect(state.logged).toEqual([])
  })

  it('renews nothing once the grant is revoked, and logs nothing: a renewal that lands after the stop is expected', async () => {
    const state = await rig()
    const grantId = await liveChat(state)
    await state.grants.revokeChatGrant(grantId)

    await state.grants.renewChatGrant(grantId)
    await state.pool.closeAll()

    expect(grantsIn(repo)).toEqual([expect.objectContaining({ expires_at: EXPIRES_AT, revoked_at: expect.any(String) })])
    expect(state.logged).toEqual([])
  })

  it('logs one line naming the grant when the renewal fails, does not throw, and still revokes it later', async () => {
    const state = await rig()
    const grantId = await liveChat(state)
    // The grant has expired: the app was asleep past it, say. The renewal is refused, and the revoke still goes.
    state.clock.advanceSeconds(13 * 60 * 60)

    await expect(state.grants.renewChatGrant(grantId)).resolves.toBeUndefined()
    await state.grants.revokeChatGrant(grantId)
    await state.pool.closeAll()

    expect(state.logged).toHaveLength(1)
    expect(state.logged[0]).toContain(grantId)
    expect(state.logged[0]).not.toContain('\n')
    expect(grantsIn(repo)).toEqual([expect.objectContaining({ expires_at: EXPIRES_AT, revoked_at: expect.any(String) })])
  })
})

it('reopens the same durable chat grant and mailbox after idle eviction, then revokes it', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const state = await rig()
  try {
    const issued = await state.grants.issueChatCli(repo, { role: 'orchestrator', allowSave: true, label: 'Long-lived Skitarii' }, {
      id: 'chat_idle', agent: 'omp', title: 'Long-lived Skitarii', kind: 'omp'
    })
    await state.grants.bindChatGrant(issued.grantId, { folder: repo, chatId: 'chat_idle', generation: 'live-terminal' })
    const old = state.pool.get(repo)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(openSessionsIn(repo)).toBe(0)
    expect(state.pool.get(repo)).toBe(old)
    const binding = state.grants.authorizeNaming(issued.cli.env['DM_SESSION_TOKEN'] ?? '')
    await binding.verifyAuthority?.('chat.name')
    expect(await old.call('listMailboxRoutes', ['chat_idle'])).toEqual([{ chatId: 'chat_idle', endpointId: issued.endpointId }])
    await state.grants.revokeChatGrant(issued.grantId)
    expect((await old.listGrants()).find(grant => grant.id === issued.grantId)?.active).toBe(false)
    expect(binding.signal.aborted).toBe(true)
  } finally {
    await state.pool.closeAll()
    vi.useRealTimers()
  }
})

describe('chat grants: the browser pipe (browser.drive)', () => {
  // Windows cannot remove a folder whose state.sqlite a workspace still holds open.
  const pools: WorkspacePool[] = []
  afterEach(async () => { await Promise.all(pools.splice(0).map((pool) => pool.closeAll())) })
  const browserRig = async (address: () => string | undefined): Promise<Rig> => {
    const state = await rig(address)
    pools.push(state.pool)
    return state
  }

  it.each([
    ['orchestrator', 'browser-pipe'], ['worker', 'browser-pipe'], ['planner', undefined], ['reviewer', undefined]
  ] as const)('gives a %s chat the browser pipe only when its role holds browser.drive', async (role, expected) => {
    const state = await browserRig(() => 'browser-pipe')
    const { cli } = await state.grants.issueChatCli(repo, { role, allowSave: false, label: `${role} chat` })
    expect(cli.env['DM_BROWSER_PIPE']).toBe(expected)
  })

  it('launches a chat without the pipe when the browser pipe failed to start, never waiting for it', async () => {
    const state = await browserRig(() => undefined)
    const { cli } = await state.grants.issueChatCli(repo, { role: 'worker', allowSave: false, label: 'worker chat' })
    expect(cli.env).not.toHaveProperty('DM_BROWSER_PIPE')
  })

  it('authorizes only the live binding of a grant holding browser.drive', async () => {
    const state = await browserRig(() => 'browser-pipe')
    const issue = async (role: 'worker' | 'planner') => {
      const issued = await state.grants.issueChatCli(repo, { role, allowSave: false, label: `${role} chat` })
      return { ...issued, token: issued.cli.env['DM_SESSION_TOKEN'] ?? '' }
    }
    const worker = await issue('worker')
    expect(() => state.grants.authorizeBrowser(worker.token)).toThrow(expect.objectContaining({ code: 'unauthorized' }))
    await state.grants.bindChatGrant(worker.grantId, { folder: repo, chatId: 'chat-w', generation: 'g1' })
    expect(state.grants.authorizeBrowser(worker.token)).toMatchObject({ chatId: 'chat-w', grantId: worker.grantId })
    const planner = await issue('planner')
    await state.grants.bindChatGrant(planner.grantId, { folder: repo, chatId: 'chat-p', generation: 'g1' })
    expect(state.grants.authorizeNaming(planner.token)).toMatchObject({ chatId: 'chat-p' })
    expect(() => state.grants.authorizeBrowser(planner.token)).toThrow(expect.objectContaining({ code: 'unauthorized' }))
    await state.grants.revokeChatGrant(worker.grantId)
    expect(() => state.grants.authorizeBrowser(worker.token)).toThrow(expect.objectContaining({ code: 'unauthorized' }))
  })
})
