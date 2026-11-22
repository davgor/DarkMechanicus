/**
 * A project-less chat reaches every tracked folder through one server-issued grant per folder, each issued in that
 * folder's own workspace and checked there by the command layer like any other grant: the token of one folder opens
 * no other, and a revoked grant opens none.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import { openWorkspace, type Workspace } from '../../core/workspace'
import { createSequentialIds, createTestClock, type TestClock } from '../../test/testContext'
import { createFakeGit, TEST_STORAGE } from '../../test/workspaceHarness'
import { NamingControlError } from '../../shared/agents/chatNaming'
import { buildCliConfig } from '../desktop/cliConfig'
import { createWorkspacePool, type WorkspacePool } from '../desktop/workspacePool'
import { createChatGrants, type ChatGrants } from './chatGrants'

interface Rig {
  ids: ReturnType<typeof createSequentialIds>
  grants: ChatGrants
  pool: WorkspacePool
  clock: TestClock
  homeDir: string
}

let root: string
let alpha: string
let beta: string
/** The desktop pool of the test's rig, closed before its folders are removed (Windows refuses to remove open databases). */
let opened: WorkspacePool | null = null

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-reach-grants-')))
  alpha = join(root, 'alpha')
  beta = join(root, 'beta')
  mkdirSync(alpha)
  mkdirSync(beta)
})

afterEach(() => {
  opened?.closeAll()
  opened = null
  rmSync(root, { recursive: true, force: true })
})

const git = createFakeGit({ branch: 'main', commit: 'b'.repeat(40), detached: false })

async function rig(): Promise<Rig> {
  const clock = createTestClock('2026-04-01T09:00:00.000Z')
  const ids = createSequentialIds()
  const homeDir = join(root, 'dm-home')
  const pool = createWorkspacePool((repoRoot) => openWorkspace({ repoRoot, role: 'desktop', label: 'Desktop', transport: 'desktop', homeDir, clock, ids, git, ...TEST_STORAGE }))
  opened = pool
  await pool.get(alpha).initializeRepository({ name: 'alpha' })
  await pool.get(beta).initializeRepository({ name: 'beta' })
  const tracked = new Set([alpha, beta])
  const grants = createChatGrants({
    workspaceFor: (folder) => {
      if (!tracked.has(folder)) {
        throw new DomainError('unauthorized', 'That folder is not tracked by Dark Mechanicus.')
      }
      return pool.get(folder)
    },
    cliFor: (folder) => buildCliConfig({ execPath: '/bin/electron', appPath: '/app', repoPath: folder }),
    minutes: 12 * 60,
    log: () => {}
  })
  return { grants, pool, clock, homeDir, ids }
}

/** A `dm` CLI session in `folder` presenting `token`, as `dm --repo <folder> --token-file <file>` opens one. */
function cliSession(state: Rig, folder: string, token: string): Workspace {
  return openWorkspace({ repoRoot: folder, role: 'reader', label: 'dm CLI', transport: 'cli', grantToken: token, homeDir: state.homeDir, clock: state.clock, ids: state.ids, git, ...TEST_STORAGE })
}

function targets(): { folder: string; tokenFile: string }[] {
  return [
    { folder: alpha, tokenFile: join(root, 'scratch', '.dm', 'alpha.token') },
    { folder: beta, tokenFile: join(root, 'scratch', '.dm', 'beta.token') }
  ]
}

const GRANT = { role: 'orchestrator', allowSave: true, label: 'Claude Code · Summoned' } as const

describe('chat grants: a project-less chat reaching every tracked folder', () => {
  it('issues one orchestrator grant with Allow save per folder, each token in its own file, and an unpinned dm', async () => {
    const state = await rig()

    const issued = await state.grants.issueReachCli(targets(), GRANT)

    expect(issued.grantIds).toHaveLength(2)
    expect(issued.cli.args).toEqual([join('/app', 'out', 'main', 'cli.js')])
    for (const target of targets()) {
      const token = readFileSync(target.tokenFile, 'utf8').trim()
      const session = cliSession(state, target.folder, token)
      try {
        const capabilities = await session.getCapabilities()
        expect(capabilities.role).toBe('orchestrator')
        expect(capabilities.capabilities).toContain('plan.save')
      } finally {
        session.close()
      }
    }
    expect(issued.cli.env['DM_SESSION_TOKEN']).toBe(readFileSync(targets()[0]?.tokenFile ?? '', 'utf8').trim())
  })

  it("never lets one folder's token act in another folder: the server checks each grant where it was issued", async () => {
    const state = await rig()
    await state.grants.issueReachCli(targets(), GRANT)
    const alphaToken = readFileSync(targets()[0]?.tokenFile ?? '', 'utf8').trim()

    expect(() => cliSession(state, beta, alphaToken)).toThrow(expect.objectContaining({ code: 'unauthorized' }))
  })
})

describe('chat grants: a project-less chat’s grants revoked and bound for naming', () => {
  it('revokes every grant it issued, after which no token opens its folder', async () => {
    const state = await rig()
    const issued = await state.grants.issueReachCli(targets(), GRANT)

    await Promise.all(issued.grantIds.map((grantId) => state.grants.revokeChatGrant(grantId)))

    for (const target of targets()) {
      const token = readFileSync(target.tokenFile, 'utf8').trim()
      expect(() => cliSession(state, target.folder, token)).toThrow(expect.objectContaining({ code: 'unauthorized' }))
    }
  })

  it('issues nothing that stays usable when a folder refuses its grant: the ones already issued are revoked', async () => {
    const state = await rig()
    const untracked = join(root, 'gone')

    await expect(state.grants.issueReachCli([...targets(), { folder: untracked, tokenFile: join(root, 'scratch', '.dm', 'gone.token') }], GRANT)).rejects.toThrow(/not tracked/)

    for (const target of targets()) {
      const token = readFileSync(target.tokenFile, 'utf8').trim()
      expect(() => cliSession(state, target.folder, token)).toThrow(expect.objectContaining({ code: 'unauthorized' }))
    }
  })

  it('binds every grant of the start to the project-less chat for naming, and no folder chat by it', async () => {
    const state = await rig()
    const issued = await state.grants.issueReachCli(targets(), GRANT)
    for (const grantId of issued.grantIds) {
      state.grants.bindChatGrant(grantId, { folder: null, chatId: 'chat_9', generation: 'g1' })
    }

    for (const target of targets()) {
      const binding = state.grants.authorizeNaming(readFileSync(target.tokenFile, 'utf8').trim())
      expect(binding).toMatchObject({ folder: null, chatId: 'chat_9' })
    }
    const folderChat = await state.grants.issueChatCli(alpha, GRANT)
    expect(() => state.grants.bindChatGrant(folderChat.grantId, { folder: null, chatId: 'chat_9', generation: 'g2' })).toThrow(NamingControlError)
  })

  it('refuses to bind a reach grant to a folder chat', async () => {
    const state = await rig()
    const issued = await state.grants.issueReachCli(targets(), GRANT)

    expect(() => state.grants.bindChatGrant(issued.grantIds[0] ?? '', { folder: alpha, chatId: 'chat_9', generation: 'g1' })).toThrow(NamingControlError)
  })
})

describe('chat grants: Forge World mail ownership', () => {
  it('binds world mail in each member, receives replies independently, and preserves identity after restart', async () => {
    const state = await rig()
    const chat = { id: 'chat_world', agent: 'omp', kind: 'omp', title: 'World coordinator' }
    const issued = await state.grants.issueReachCli(targets(), GRANT, root, chat)
    const identities: string[] = []
    for (const target of targets()) {
      const world = cliSession(state, target.folder, readFileSync(target.tokenFile, 'utf8').trim())
      const peerGrant = await state.grants.issueChatCli(target.folder, GRANT, { ...chat, id: 'chat_member', title: 'Member agent' })
      const peer = cliSession(state, target.folder, peerGrant.cli.env.DM_SESSION_TOKEN!)
      try {
        const identity = await world.getAgentIdentity({})
        identities.push(identity.endpointId)
        await peer.sendAgentMessage({ to: identity.endpointId, clientMessageId: 'reply', body: target.folder })
        expect((await world.readAgentInbox({})).messages.map(message => message.body)).toEqual([target.folder])
        expect((await peer.listAgentPeers({})).peers).toContainEqual({ endpointId: identity.endpointId, name: 'World coordinator' })
      } finally { world.close(); peer.close() }
    }
    await Promise.all(issued.grantIds.map(id => state.grants.revokeChatGrant(id)))
    await state.grants.issueReachCli(targets(), GRANT, root, chat)
    for (const [index, target] of targets().entries()) {
      const world = cliSession(state, target.folder, readFileSync(target.tokenFile, 'utf8').trim())
      try { expect((await world.getAgentIdentity({})).endpointId).toBe(identities[index]) }
      finally { world.close() }
    }
  })

})

describe('chat grants: Forge World root ownership', () => {
  it.each(['planner', 'worker'] as const)('preserves the selected %s role and disabled Allow save in a world member grant', async role => {
    const state = await rig()
    const issued = await state.grants.issueReachCli([targets()[0]!], { role, allowSave: false, label: 'World work' }, root)
    const token = readFileSync(targets()[0]!.tokenFile, 'utf8').trim()
    const session = cliSession(state, alpha, token)
    try {
      const capabilities = await session.getCapabilities()
      expect(capabilities.role).toBe(role)
      expect(capabilities.capabilities).not.toContain('plan.save')
    } finally { session.close() }
    await state.grants.revokeChatGrant(issued.grantIds[0]!)
  })

  it('binds a world reach grant only to its root chat identity, renews it in the member, and revokes it there', async () => {
    const state = await rig()
    const issued = await state.grants.issueReachCli(targets(), GRANT, root)
    for (const grantId of issued.grantIds) {
      expect(() => state.grants.bindChatGrant(grantId, { folder: null, chatId: 'chat_world', generation: 'g1' })).toThrow(NamingControlError)
      expect(() => state.grants.bindChatGrant(grantId, { folder: alpha, chatId: 'chat_world', generation: 'g1' })).toThrow(NamingControlError)
      state.grants.bindChatGrant(grantId, { folder: root, chatId: 'chat_world', generation: 'g1' })
      await state.grants.renewChatGrant(grantId)
    }
    for (const target of targets()) {
      expect(state.grants.authorizeNaming(readFileSync(target.tokenFile, 'utf8').trim())).toMatchObject({ folder: root, chatId: 'chat_world' })
    }
    await Promise.all(issued.grantIds.map(id => state.grants.revokeChatGrant(id)))
    for (const target of targets()) {
      expect(() => cliSession(state, target.folder, readFileSync(target.tokenFile, 'utf8').trim())).toThrow(expect.objectContaining({ code: 'unauthorized' }))
    }
  })

})

describe('chat grants: later starts and other chats', () => {
  it('binds a folder chat’s grant to its own folder, as before project-less chats', async () => {
    const state = await rig()
    const issued = await state.grants.issueChatCli(alpha, GRANT)

    state.grants.bindChatGrant(issued.grantId, { folder: alpha, chatId: 'chat_1', generation: 'g1' })

    expect(state.grants.authorizeNaming(issued.cli.env['DM_SESSION_TOKEN'] ?? '')).toMatchObject({ folder: alpha, chatId: 'chat_1' })
  })

  it('ends an earlier start’s bindings when the same project-less chat starts again, and no other chat’s', async () => {
    const state = await rig()
    const tokenOf = (target: { tokenFile: string }): string => readFileSync(target.tokenFile, 'utf8').trim()
    const first = await state.grants.issueReachCli([targets()[0] ?? { folder: alpha, tokenFile: '' }], GRANT)
    const firstToken = tokenOf(targets()[0] ?? { tokenFile: '' })
    const other = await state.grants.issueReachCli([targets()[1] ?? { folder: beta, tokenFile: '' }], GRANT)
    const otherToken = tokenOf(targets()[1] ?? { tokenFile: '' })
    state.grants.bindChatGrant(first.grantIds[0] ?? '', { folder: null, chatId: 'chat_9', generation: 'g1' })
    state.grants.bindChatGrant(other.grantIds[0] ?? '', { folder: null, chatId: 'chat_8', generation: 'g1' })

    const again = await state.grants.issueReachCli([{ folder: alpha, tokenFile: join(root, 'scratch', '.dm', 'again.token') }], GRANT)
    state.grants.bindChatGrant(again.grantIds[0] ?? '', { folder: null, chatId: 'chat_9', generation: 'g2' })

    expect(() => state.grants.authorizeNaming(firstToken)).toThrow(NamingControlError)
    expect(state.grants.authorizeNaming(otherToken)).toMatchObject({ chatId: 'chat_8' })
    expect(state.grants.authorizeNaming(readFileSync(join(root, 'scratch', '.dm', 'again.token'), 'utf8').trim())).toMatchObject({ chatId: 'chat_9', generation: 'g2' })
  })
})
