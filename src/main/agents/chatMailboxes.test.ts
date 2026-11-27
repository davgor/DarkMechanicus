/**
 * The chat mailboxes over real desktop workspaces, the real chat store on disk and real grants: OMP chats (legacy ones
 * too) get one stable mailbox each, keyed by machine and chat id in their own folder's database; every OMP grant is
 * bound before it is handed out; deletion is durable and finished after a crash; untrack suspends; and no stale start,
 * deletion or untrack ever resurrects a mailbox or leaves a usable grant behind.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import { bindAgentMailEndpoint, provisionAgentMailEndpoint } from '../../core/services/agentMail'
import { findEndpointByChat, getBinding, type MailEndpoint } from '../../core/services/agentMailStore'
import { openWorkspace, type Workspace } from '../../core/workspace'
import { gate } from '../terminals/__mocks__/terminalSessionsRig'
import type { ChatRecord } from '../../shared/agents/chat'
import { createSavedEpic, insertRun } from '../../test/authoring'
import { createSequentialIds, createTestClock } from '../../test/testContext'
import { createFakeGit, TEST_STORAGE } from '../../test/workspaceHarness'
import { buildCliConfig } from '../desktop/cliConfig'
import { createTestWorkspacePool as createWorkspacePool, type TestWorkspacePool as WorkspacePool } from '../desktop/__mocks__/projectWorkspaceFixture'
import { builtInAgent, connectedAgents, folderOf } from './__mocks__/chatFixtures'
import { createChatGrants, type ChatGrants, type GrantChat } from './chatGrants'
import { createChatMailboxes, type ChatMailboxes } from './chatMailboxes'
import { mailboxChat } from './chatMailboxOperations'
import { createChatRecords, type ChatRecords } from './chatRecords'
import { createChatStore, nodeChatStoreFs, type ChatStore, type ChatStoreFs } from './chatStore'

const CUSTOM_ID = 'cu_01m65kwqqeyajbj5bnq81gngrb'

let root: string
let repoA: string
let repoB: string
let opened: Workspace[]
let pools: WorkspacePool[]

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-chat-mailboxes-')))
  repoA = join(root, 'a')
  repoB = join(root, 'b')
  mkdirSync(repoA)
  mkdirSync(repoB)
  opened = []
  pools = []
})

afterEach(async () => {
  for (const workspace of opened) workspace.close()
  for (const pool of pools) await pool.closeAll()
  rmSync(root, { recursive: true, force: true })
})

interface Rig {
  pool: WorkspacePool
  tracked: Set<string>
  store: ChatStore
  mailboxes: ChatMailboxes
  records: ChatRecords
  grants: ChatGrants
  logged: string[]
  /** Opens a `dm` CLI session in `folder` on a chat's grant token, as the chat's CLI does. */
  agent: (folder: string, token: string) => Workspace
  /** The chat's endpoint in its folder's database, read as the desktop. */
  endpoint: (chat: ChatRecord) => MailEndpoint | null
  /** A fresh grant for `chat`, issued the way its terminal's start issues it. */
  issue: (chat: ChatRecord, kind?: string) => Promise<{ grantId: string; token: string; endpointId: string | null }>
  /** The app started again: new store, mailboxes and records over the same files and databases. */
  restart: (options?: RigOptions) => Rig
}

interface RigOptions {
  membersFor?: (folder: string) => readonly string[] | undefined
  storeFs?: ChatStoreFs
  contextFails?: () => boolean
  /** What a failing context throws; `database is locked` by default. */
  contextError?: unknown
  removeOmpFolder?: (chatId: string) => Promise<void>
  /** Wraps each pooled workspace, once, for a test that acts between its steps. */
  wrap?: (workspace: ReturnType<WorkspacePool['get']>) => ReturnType<WorkspacePool['get']>
  desktopReady?: () => Promise<void>
  newId?: () => string
}

/** What every rig of one test shares: the desktop's pool of real workspaces, the tracked folders, and agent sessions. */
interface Desktop {
  pool: WorkspacePool
  tracked: Set<string>
  openAgent: (folder: string, token: string) => Workspace
}

async function rig(options: RigOptions = {}): Promise<Rig> {
  const clock = createTestClock('2026-04-01T09:00:00.000Z')
  const ids = createSequentialIds()
  const git = createFakeGit({ branch: 'main', commit: 'b'.repeat(40), detached: false })
  const homeDir = join(root, 'dm-home')
  const pool = createWorkspacePool((repoRoot) => openWorkspace({ repoRoot, role: 'desktop', label: 'Desktop', transport: 'desktop', homeDir, clock, ids, git, ...TEST_STORAGE }))
  pools.push(pool)
  await pool.get(repoA).initializeRepository({ name: 'a' })
  await pool.get(repoB).initializeRepository({ name: 'b' })
  const openAgent = (folder: string, token: string): Workspace => {
    const workspace = openWorkspace({ repoRoot: folder, role: 'reader', label: 'Agent', transport: 'cli', grantToken: token, homeDir, clock, ids, git, ...TEST_STORAGE })
    opened.push(workspace)
    return workspace
  }
  return build({ pool, tracked: new Set([repoA, repoB]), openAgent }, options)
}

function trackedWorkspace(desktop: Desktop, options: RigOptions): (folder: string) => ReturnType<WorkspacePool['get']> {
  const { pool, tracked } = desktop
  const wrapped = new WeakMap<ReturnType<WorkspacePool['get']>, ReturnType<WorkspacePool['get']>>()
  return (folder: string) => {
    if (!tracked.has(folder)) throw new DomainError('unauthorized', 'That folder is not tracked by Dark Mechanicus.')
    const workspace = pool.get(folder)
    if (options.wrap === undefined) return workspace
    const known = wrapped.get(workspace) ?? options.wrap(workspace)
    wrapped.set(workspace, known)
    return known
  }
}

function build(desktop: Desktop, options: RigOptions): Rig {
  const { pool, tracked } = desktop
  const logged: string[] = []
  const workspaceFor = trackedWorkspace(desktop, options)
  const store = createChatStore({ root: join(root, 'chats'), fs: options.storeFs ?? nodeChatStoreFs, ...(options.newId === undefined ? {} : { newId: options.newId }) })
  const mailboxes = createChatMailboxes({
    ...(options.membersFor === undefined ? {} : { membersFor: options.membersFor }),
    workspaceFor: (folder) => {
      if (options.contextFails?.() === true) throw options.contextError ?? new Error('database is locked')
      return workspaceFor(folder)
    },
    store,
    ledger: { file: join(root, 'mailboxes.jsonl'), fs: nodeChatStoreFs },
    log: (line) => logged.push(line)
  })
  const records = createChatRecords({
    store,
    agentFor: connectedAgents([builtInAgent('omp'), builtInAgent('claude')]),
    mailboxes,
    ...(options.removeOmpFolder === undefined ? {} : { removeOmpFolder: options.removeOmpFolder })
  })
  const grants = createChatGrants({
    recordWorldMailbox: (owner, member, chatId) => mailboxes.recordRoute(owner, member, chatId),
    workspaceFor,
    cliFor: (folder) => buildCliConfig({ execPath: '/bin/electron', appPath: '/app', repoPath: folder }),
    minutes: 12 * 60,
    log: (line) => logged.push(line),
    ...(options.desktopReady === undefined ? {} : { desktopReady: options.desktopReady })
  })
  return {
    pool,
    tracked,
    store,
    mailboxes,
    records,
    grants,
    logged,
    agent: desktop.openAgent,
    endpoint: (chat) => endpointIn(pool, chat),
    issue: (chat, kind = 'omp') => issueFor(grants, chat, kind),
    restart: (next = {}) => build(desktop, next)
  }
}

function endpointIn(pool: WorkspacePool, chat: ChatRecord): MailEndpoint | null {
  const ctx = pool.get(folderOf(chat)).ctx()
  return findEndpointByChat(ctx, { machineId: ctx.machineId, chatId: chat.id })
}

async function issueFor(grants: ChatGrants, chat: ChatRecord, kind: string): Promise<{ grantId: string; token: string; endpointId: string | null }> {
  const identity: GrantChat = { ...mailboxChat(chat), kind }
  const issued = await grants.issueChatCli(folderOf(chat), { role: chat.role, allowSave: false, label: chat.title }, identity)
  return { grantId: issued.grantId, token: issued.cli.env['DM_SESSION_TOKEN'] ?? '', endpointId: issued.endpointId }
}

async function newOmp(state: Rig, folder: string, title: string): Promise<ChatRecord> {
  return await state.records.createChat({ folder, agent: 'omp', role: 'worker', title })
}

describe('Forge World mailbox lifecycle', () => {
  it('owns separate member endpoints, keeps a root identity, and suspends removed routes across restart', async () => {
    let members = [repoA, repoB]
    const options = { membersFor: (folder: string) => folder === root ? members : undefined }
    const state = await rig(options)
    const chat = await newOmp(state, root, 'World work')
    expect(chat.endpointId).toBeUndefined()
    const routes = await state.mailboxes.routes(chat)
    expect(routes.map(route => route.folder)).toEqual([repoA, repoB])
    await state.records.renameChat(chat, 'Renamed world')
    for (const folder of members) expect(state.endpoint({ ...chat, folder })?.name).toBe('Renamed world')
    // Listing ordinary project chats must not collect the root chat's member endpoint as an orphan.
    await state.records.recoverFolder(repoA)
    expect(state.endpoint({ ...chat, folder: repoA })?.state).toBe('open')
    members = [repoB]
    const restarted = state.restart(options)
    await restarted.mailboxes.recover(root, [chat])
    expect(await restarted.mailboxes.routes(chat)).toEqual([routes[1]])
    expect(state.endpoint({ ...chat, folder: repoA })?.state).toBe('suspended')
    await restarted.mailboxes.delete(chat)
    for (const folder of [repoA, repoB]) expect(state.endpoint({ ...chat, folder })?.state).toBe('deleted')
  })

  it('suspends root-owned endpoints when a member alone is untracked', async () => {
    const state = await rig({ membersFor: folder => folder === root ? [repoA, repoB] : undefined })
    const chat = await newOmp(state, root, 'World work')
    await state.mailboxes.suspendFolder(repoA, [])
    expect(state.endpoint({ ...chat, folder: repoA })?.state).toBe('suspended')
    expect(state.endpoint({ ...chat, folder: repoB })?.state).toBe('open')
  })

  it('withholds routes without suspending stored endpoints while the manifest is unreadable', async () => {
    let broken = false
    const state = await rig({ membersFor: folder => {
      if (folder !== root) return undefined
      if (broken) throw new Error('merge conflict')
      return [repoA, repoB]
    } })
    const chat = await newOmp(state, root, 'World work')
    broken = true
    await state.mailboxes.reconcile(root, [chat])
    expect(await state.mailboxes.routes(chat)).toEqual([])
    expect(state.endpoint({ ...chat, folder: repoA })?.state).toBe('open')
    expect(state.endpoint({ ...chat, folder: repoB })?.state).toBe('open')
  })
})

describe('Forge World mailbox cleanup after mappings disappear', () => {
  it('records deletion for an untracked member and drains it before that member is readded', async () => {
    let members = [repoA, repoB]
    const options = { membersFor: (folder: string) => folder === root ? members : undefined }
    const state = await rig(options)
    const chat = await newOmp(state, root, 'World work')
    state.tracked.delete(repoA)
    members = [repoB]
    await expect(state.mailboxes.delete(chat)).resolves.toBeUndefined()
    expect(state.endpoint({ ...chat, folder: repoA })?.state).toBe('open')
    state.tracked.add(repoA)
    const restarted = state.restart(options)
    await restarted.records.recoverFolder(repoA)
    expect(state.endpoint({ ...chat, folder: repoA })?.state).toBe('deleted')
    members = [repoA, repoB]
    expect((await restarted.mailboxes.reconcile(root, [chat])).deleting).toEqual([chat])
    expect(await restarted.mailboxes.routes(chat)).toEqual([])
  })

  it('records a conflict resolver binding even when the current manifest cannot be read', async () => {
    const state = await rig({ membersFor: folder => { if (folder === root) throw new Error('merge conflict'); return undefined } })
    const chat = await newOmp(state, root, 'Conflict resolver')
    const target = { folder: repoA, tokenFile: join(root, 'private', 'grant.token') }
    const issued = await state.grants.issueReachCli([target], { role: 'worker', allowSave: false, label: 'Resolver' }, root, { ...chat, kind: 'omp' })
    expect(state.endpoint({ ...chat, folder: repoA })?.state).toBe('open')
    await state.grants.revokeChatGrant(issued.grantIds[0]!)
    await state.mailboxes.delete(chat)
    expect(state.endpoint({ ...chat, folder: repoA })?.state).toBe('deleted')
  })

  it('keeps archived root mailboxes suspended across recovery and leaves another chat open', async () => {
    const options = { membersFor: (folder: string) => folder === root ? [repoA, repoB] : undefined }
    const state = await rig(options)
    const chat = await newOmp(state, root, 'Archived resolver')
    const other = await newOmp(state, root, 'Live world work')
    await state.mailboxes.suspendChat(chat)
    const archived = { ...chat, archived: true }
    const restarted = state.restart(options)
    await restarted.mailboxes.recover(root, [archived, other])
    for (const folder of [repoA, repoB]) {
      expect(state.endpoint({ ...chat, folder })?.state).toBe('suspended')
      expect(state.endpoint({ ...other, folder })?.state).toBe('open')
    }
    expect(await restarted.mailboxes.routes(archived)).toEqual([])
  })
})

describe('Forge World durable deletion failures', () => {
  it('keeps a failed deletion intent across restart and refuses a late binding without duplicating it', async () => {
    let failing = false
    const options = { membersFor: (folder: string) => folder === root ? [repoA] : undefined, contextFails: () => failing }
    const state = await rig(options)
    const chat = await newOmp(state, root, 'Delete me')
    failing = true
    await expect(state.mailboxes.delete(chat)).rejects.toThrow('database is locked')
    const persisted = readFileSync(join(root, 'mailboxes.jsonl'), 'utf8')
    const restarted = state.restart(options)
    await expect(restarted.mailboxes.delete(chat)).rejects.toThrow('database is locked')
    expect(readFileSync(join(root, 'mailboxes.jsonl'), 'utf8')).toBe(persisted)
    expect(() => restarted.mailboxes.recordRoute(root, repoA, chat.id)).toThrow('was deleted')
    expect(await restarted.mailboxes.routes(chat)).toEqual([])
    failing = false
    expect((await restarted.mailboxes.reconcile(root, [chat])).deleting).toEqual([chat])
    expect(state.endpoint({ ...chat, folder: repoA })?.state).toBe('deleted')
  })

  it('deletes a lost root chat endpoint without collecting a member chat or a live root', async () => {
    const options = { membersFor: (folder: string) => folder === root ? [repoA] : undefined }
    const state = await rig(options)
    const lost = await newOmp(state, root, 'Lost root')
    const live = await newOmp(state, root, 'Live root')
    const member = await newOmp(state, repoA, 'Member')
    state.store.deleteChat(lost)
    await state.restart(options).records.recoverFolder(root)
    expect(state.endpoint({ ...lost, folder: repoA })?.state).toBe('deleted')
    expect(state.endpoint({ ...live, folder: repoA })?.state).toBe('open')
    expect(state.endpoint(member)?.state).toBe('open')
  })
})

describe('Forge World route availability', () => {
  it('omits unavailable and suspended routes, then resumes the same endpoint on reconciliation', async () => {
    let failing = false
    const state = await rig({ membersFor: folder => folder === root ? [repoA] : undefined, contextFails: () => failing })
    const chat = await newOmp(state, root, 'World')
    const routes = await state.mailboxes.routes(chat)
    failing = true
    expect(await state.mailboxes.routes(chat)).toEqual([])
    failing = false
    await state.mailboxes.suspendFolder(root, [chat])
    expect(await state.mailboxes.routes(chat)).toEqual([])
    await state.mailboxes.reconcile(root, [chat])
    expect(await state.mailboxes.routes(chat)).toEqual(routes)
    expect(state.logged).toEqual([expect.stringContaining('read world mailbox routes')])
  })

  it('archives ordinary chats without touching another chat and gives unprovisioned chats no route', async () => {
    const state = await rig()
    const chat = await newOmp(state, repoA, 'Archive')
    const other = await newOmp(state, repoA, 'Keep')
    expect(await state.mailboxes.routes(chat)).toEqual([{ folder: repoA, endpointId: chat.endpointId }])
    expect(await state.mailboxes.routes({ ...chat, endpointId: undefined })).toEqual([])
    for (const excluded of [{ ...chat, folder: null }, { ...chat, agent: 'claude' }]) {
      await state.mailboxes.suspendChat(excluded)
      expect(await state.mailboxes.routes(excluded)).toEqual([])
    }
    await state.mailboxes.suspendChat(chat)
    await state.mailboxes.recover(repoA, [{ ...chat, archived: true }, other])
    expect(state.endpoint(chat)?.state).toBe('suspended')
    expect(state.endpoint(other)?.state).toBe('open')
  })
})

describe('legacy mailbox ledger recovery', () => {
  it('retains valid legacy ownership while ignoring malformed records and deletes only its orphan', async () => {
    const state = await rig()
    const chat = await newOmp(state, repoA, 'Legacy')
    const foreign = provisionAgentMailEndpoint(state.pool.get(repoA).ctx(), { chatId: 'chat_foreign', name: 'Foreign' })
    writeFileSync(join(root, 'mailboxes.jsonl'), JSON.stringify({ folder: repoA, chatId: chat.id }) + '\n')
    appendFileSync(join(root, 'mailboxes.jsonl'), '{"folder":7,"chatId":"chat_foreign"}\n{"folder":"truncated"\n')
    state.store.deleteChat(chat)
    const restarted = state.restart()
    await restarted.records.recoverFolder(repoA)
    expect(state.endpoint(chat)?.state).toBe('deleted')
    expect(findEndpointByChat(state.pool.get(repoA).ctx(), { machineId: state.pool.get(repoA).ctx().machineId, chatId: foreign.chatId })?.state).toBe('open')
    expect(restarted.logged).toEqual([])
  })
})

describe('world mailbox boundaries', () => {
  it('never opens a mapped Forge World root as a member database', async () => {
    const state = await rig({ membersFor: folder => folder === root ? [repoA] : undefined })
    const chat = await newOmp(state, root, 'World')
    writeFileSync(join(repoA, 'forge-world.json'), '{}')
    await state.mailboxes.suspendFolder(root, [chat])
    expect(await state.mailboxes.routes(chat)).toEqual([])
    await state.mailboxes.reconcile(root, [chat])
    expect(state.endpoint({ ...chat, folder: repoA })?.state).toBe('open')
    expect(state.logged).toEqual([])
  })
})

/** Grants in the folder's database that are still usable (not revoked). */
function liveGrants(state: Rig, folder: string): string[] {
  return state.pool
    .get(folder)
    .ctx()
    .db.all<{ id: string }>('SELECT id FROM grants WHERE revoked_at IS NULL ORDER BY id')
    .map((row) => row.id)
}

function messagesTo(state: Rig, folder: string, endpointId: string): number {
  return state.pool.get(folder).ctx().db.get<{ n: number }>('SELECT COUNT(*) AS n FROM agent_mail_messages WHERE recipient_endpoint_id = ?', endpointId)?.n ?? -1
}

describe('chat mailboxes: stable and discoverable', () => {
  it('provisions a legacy OMP chat on the trusted list, so a never-started chat receives, and no other CLI gets one', async () => {
    const state = await rig()
    const legacy = state.store.createChat({ folder: repoA, agent: 'omp', model: null, role: 'worker', allowSave: false, title: 'Scout' })
    const claude = state.store.createChat({ folder: repoA, agent: 'claude', model: null, role: 'worker', allowSave: false, title: 'Claude' })
    const custom = state.store.createChat({ folder: repoA, agent: CUSTOM_ID, model: null, role: 'worker', allowSave: false, title: 'Mine' })
    expect(legacy.endpointId).toBeUndefined()

    const listed = await state.records.listChats(repoA)
    const endpointId = listed.find((chat) => chat.id === legacy.id)?.endpointId
    expect(endpointId).toMatch(/^me_/)
    expect(listed.find((chat) => chat.id === claude.id)?.endpointId).toBeUndefined()
    expect(listed.find((chat) => chat.id === custom.id)?.endpointId).toBeUndefined()

    const sender = await newOmp(state, repoA, 'Sender')
    const issued = await state.issue(sender)
    expect(issued.endpointId).toBe(sender.endpointId)
    const agent = state.agent(repoA, issued.token)
    expect((await agent.listAgentPeers({})).peers).toEqual([{ endpointId, name: 'Scout', epicId: null, role: 'worker' }])
    await agent.sendAgentMessage({ to: endpointId ?? '', clientMessageId: 'm1', body: 'Ready for review.' })
    expect(messagesTo(state, repoA, endpointId ?? '')).toBe(1)

    // The same id on every list, after a restart, and in the index on disk.
    expect((await state.records.listChats(repoA)).find((chat) => chat.id === legacy.id)?.endpointId).toBe(endpointId)
    const again = state.restart()
    expect((await again.records.listChats(repoA)).find((chat) => chat.id === legacy.id)?.endpointId).toBe(endpointId)
    expect(again.store.getChat(legacy)?.endpointId).toBe(endpointId)
  })

  it('binds no grant of another CLI’s chat, a custom CLI or an external grant, and provisions nothing for them', async () => {
    const state = await rig()
    const claude = await state.records.createChat({ folder: repoA, agent: 'claude', role: 'worker', title: 'Claude' })
    const custom = await state.records.createChat({ folder: repoA, agent: CUSTOM_ID, role: 'worker', title: 'Mine' })
    const omp = await newOmp(state, repoA, 'Skitarius')

    const results = [await state.issue(claude, 'claude'), await state.issue(custom, 'custom'), await state.issue(omp, 'custom')]
    const external = await state.grants.issueChatCli(repoA, { role: 'worker', allowSave: false, label: 'External' })

    expect([...results.map((result) => result.endpointId), external.endpointId]).toEqual([null, null, null, null])
    const ctx = state.pool.get(repoA).ctx()
    expect([...results.map((result) => result.grantId), external.grantId].map((grantId) => getBinding(ctx, grantId))).toEqual([null, null, null, null])
    expect([state.endpoint(claude), state.endpoint(custom)]).toEqual([null, null])
  })
})

describe('chat mailboxes: trusted epic and role from the chat record', () => {
  async function epicChat(state: Rig, title: string, request: Partial<Pick<ChatRecord, 'role' | 'epicId' | 'runId' | 'transferEpicId' | 'conversation'>>): Promise<ChatRecord> {
    return await state.records.createChat({ folder: repoA, agent: 'omp', role: 'worker', title, ...request })
  }

  it('provisions each chat with its record’s epic and role, so its Magos finds exactly the epic’s Lexmechanic', async () => {
    const state = await rig()
    const E = createSavedEpic(state.pool.get(repoA).ctx(), { title: 'E' }).epicId
    const lexmechanic = await epicChat(state, 'Lexmechanic', { role: 'planner', epicId: E })
    const magos = await epicChat(state, 'Magos', { role: 'orchestrator', epicId: E })
    const loose = await epicChat(state, 'Loose planner', { role: 'planner' })
    expect(state.endpoint(lexmechanic)).toMatchObject({ epicId: E, chatRole: 'planner' })
    expect(state.endpoint(magos)).toMatchObject({ epicId: E, chatRole: 'orchestrator' })
    expect(state.endpoint(loose)).toMatchObject({ epicId: null, chatRole: 'planner' })

    const issued = await state.issue(magos)
    const agent = state.agent(repoA, issued.token)
    expect(await agent.listAgentPeers({ epicId: E, role: 'planner' })).toEqual({
      peers: [{ endpointId: lexmechanic.endpointId, name: 'Lexmechanic', epicId: E, role: 'planner' }],
      nextAfterId: lexmechanic.endpointId,
      hasMore: false
    })
  })

  it('resolves the legacy bindings main stored before epicId: a transfer, a board conversation and an orchestrated run', async () => {
    const state = await rig()
    const ctx = state.pool.get(repoA).ctx()
    const saved = createSavedEpic(ctx, { title: 'Legacy' })
    const runId = insertRun(ctx, { epicId: saved.epicId, revisionId: saved.revisionId, state: 'running' })
    const transfer = await epicChat(state, 'Transfer', { transferEpicId: saved.epicId })
    const conversation = await epicChat(state, 'Talk', { conversation: { epicId: saved.epicId } })
    const orchestrator = await epicChat(state, 'Orchestrator', { role: 'orchestrator', runId })
    const card = await epicChat(state, 'Card talk', { conversation: { cardId: 'kc_card' } })
    const missingRun = await epicChat(state, 'Missing run', { role: 'orchestrator', runId: 'rn_missing' })
    expect([transfer, conversation, orchestrator].map((chat) => state.endpoint(chat)?.epicId)).toEqual([saved.epicId, saved.epicId, saved.epicId])
    expect([card, missingRun].map((chat) => state.endpoint(chat)?.epicId)).toEqual([null, null])
    expect(state.endpoint(orchestrator)?.chatRole).toBe('orchestrator')
  })

  it('keeps them through a rename and refreshes them from the record on the next binding', async () => {
    const state = await rig()
    const E = createSavedEpic(state.pool.get(repoA).ctx(), { title: 'E' }).epicId
    const chat = await epicChat(state, 'Lexmechanic', { role: 'planner', epicId: E })
    const renamed = await state.records.renameChat(chat, 'Lexmechanic, renamed')
    expect(state.endpoint(chat)).toMatchObject({ name: 'Lexmechanic, renamed', epicId: E, chatRole: 'planner' })

    // Whatever the row holds, a start binds the chat's grant from the record main owns.
    state.pool.get(repoA).ctx().db.run('UPDATE agent_mail_endpoints SET epic_id = NULL, chat_role = NULL WHERE id = ?', chat.endpointId ?? '')
    const issued = await state.issue(renamed)
    expect(issued.endpointId).toBe(chat.endpointId)
    expect(state.endpoint(chat)).toMatchObject({ epicId: E, chatRole: 'planner' })
  })
})

describe('chat mailboxes: project-less chats', () => {
  it('gives a project-less OMP chat no mailbox: its records reach no folder’s database and its grants are bound to none', async () => {
    // Every mailbox call that reaches a folder's database fails, so one made for the project-less chat shows.
    const state = await rig({ contextFails: () => true, contextError: new Error('no folder’s database may be reached') })
    const chat = await state.records.createChat({ folder: null, agent: 'omp', role: 'orchestrator', title: 'Summoned' })
    expect((await state.records.listChats(null)).map((listed) => listed.endpointId)).toEqual([undefined])
    const renamed = await state.records.renameChat(chat, 'Renamed')

    const reach = await state.grants.issueReachCli([{ folder: repoA, tokenFile: join(root, 'reach-a.token') }], { role: 'orchestrator', allowSave: true, label: renamed.title })
    expect(reach.grantIds.map((grantId) => getBinding(state.pool.get(repoA).ctx(), grantId))).toEqual([null])
    await state.records.deleteChat(renamed)

    expect(renamed.endpointId).toBeUndefined()
    expect(await state.records.listChats(null)).toEqual([])
    expect(state.logged).toEqual([])
  })
})

describe('chat mailboxes: identity across restarts, folders and crashes', () => {
  it('keeps one mailbox and its unread mail through stop, restart and rename; old grants stay unbound', async () => {
    const state = await rig()
    const chat = await newOmp(state, repoA, 'Worker')
    const peer = await newOmp(state, repoA, 'Peer')
    const first = await state.issue(chat)
    const peerGrant = await state.issue(peer)
    await state.agent(repoA, peerGrant.token).sendAgentMessage({ to: chat.endpointId ?? '', clientMessageId: 'm1', body: 'Unread while you were away.' })

    // The terminal stops: its grant is revoked and its binding closed.
    await state.grants.revokeChatGrant(first.grantId)
    const renamed = await state.records.renameChat(chat, 'Worker, renamed')
    const second = await state.issue(renamed)

    expect([first.endpointId, second.endpointId, renamed.endpointId]).toEqual([chat.endpointId, chat.endpointId, chat.endpointId])
    expect(state.endpoint(chat)).toMatchObject({ id: chat.endpointId, name: 'Worker, renamed', state: 'open' })
    const ctx = state.pool.get(repoA).ctx()
    expect(getBinding(ctx, first.grantId)).toMatchObject({ closeReason: 'grant_ended' })
    const inbox = await state.agent(repoA, second.token).readAgentInbox({ unacknowledgedOnly: true })
    expect(inbox.messages.map((message) => message.body)).toEqual(['Unread while you were away.'])
    expect(() => state.agent(repoA, first.token)).toThrow('That grant is not usable')
  })

  it('isolates the same chat id in two folders: two mailboxes, and deleting one leaves the other', async () => {
    const state = await rig({ newId: () => 'chat_same' })
    const inA = await newOmp(state, repoA, 'Same')
    const inB = await newOmp(state, repoB, 'Same')

    expect(inA.id).toBe(inB.id)
    expect(inA.endpointId).not.toBe(inB.endpointId)
    await state.records.deleteChat(inA)

    expect(state.endpoint(inA)?.state).toBe('deleted')
    expect(state.endpoint(inB)).toMatchObject({ id: inB.endpointId, state: 'open' })
    expect((await state.records.listChats(repoB)).map((chat) => chat.endpointId)).toEqual([inB.endpointId])
  })

  it('finds the same endpoint after a crash between the SQLite commit and the index line', async () => {
    const crashing: ChatStoreFs = {
      ...nodeChatStoreFs,
      appendFile: (path, data) => {
        if (data.includes('"endpointId"')) throw new Error('The app crashed before the index line was written.')
        nodeChatStoreFs.appendFile(path, data)
      }
    }
    const before = await rig({ storeFs: crashing })
    const chat = before.store.createChat({ folder: repoA, agent: 'omp', model: null, role: 'worker', allowSave: false, title: 'Crashy' })

    expect((await before.records.listChats(repoA))[0]?.endpointId).toBeUndefined()
    const committed = before.endpoint(chat)
    expect(committed?.state).toBe('open')
    expect(before.logged).toEqual([expect.stringContaining(chat.id)])

    const after = before.restart()
    expect((await after.records.listChats(repoA))[0]?.endpointId).toBe(committed?.id)
  })
})

describe('chat mailboxes: deletion', () => {
  it('closes the mailbox first, purges its received mail and leaves its sent mail with a deleted sender', async () => {
    const state = await rig()
    const doomed = await newOmp(state, repoA, 'Doomed')
    const peer = await newOmp(state, repoA, 'Peer')
    const doomedGrant = await state.issue(doomed)
    const peerGrant = await state.issue(peer)
    const doomedAgent = state.agent(repoA, doomedGrant.token)
    const peerAgent = state.agent(repoA, peerGrant.token)
    await doomedAgent.sendAgentMessage({ to: peer.endpointId ?? '', clientMessageId: 'out', body: 'From the doomed chat.' })
    await peerAgent.sendAgentMessage({ to: doomed.endpointId ?? '', clientMessageId: 'in', body: 'To the doomed chat.' })

    await state.records.deleteChat(doomed)

    expect(state.store.getChat(doomed)).toBeNull()
    expect(state.endpoint(doomed)?.state).toBe('deleted')
    expect(messagesTo(state, repoA, doomed.endpointId ?? '')).toBe(0)
    expect(getBinding(state.pool.get(repoA).ctx(), doomedGrant.grantId)).toMatchObject({ closeReason: 'deleted' })
    const inbox = await peerAgent.readAgentInbox({})
    expect(inbox.messages).toEqual([expect.objectContaining({ body: 'From the doomed chat.', from: expect.objectContaining({ endpointId: doomed.endpointId, deleted: true }) })])
    expect((await peerAgent.listAgentPeers({})).peers).toEqual([])
    await expect(doomedAgent.sendAgentMessage({ to: peer.endpointId ?? '', clientMessageId: 'late', body: 'x' })).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('never reopens a deleted mailbox for a start whose grant arrives after the deletion, and revokes that grant', async () => {
    // The project's lib target predates Promise.withResolvers; the terminal rig's gate is the same thing.
    const ready = gate<void>()
    const state = await rig({ desktopReady: () => ready.promise })
    const chat = await newOmp(state, repoA, 'Racing')

    const issuing = state.issue(chat)
    await state.records.deleteChat(chat)
    ready.open()

    await expect(issuing).rejects.toMatchObject({ code: 'invalid_state' })
    expect(state.endpoint(chat)?.state).toBe('deleted')
    expect(liveGrants(state, repoA)).toEqual([])
    expect(await state.records.listChats(repoA)).toEqual([])
  })

  it('keeps a chat whose mailbox deletion storage cannot record, visible and deletable again', async () => {
    let failing = false
    const state = await rig({ contextFails: () => failing })
    const chat = await newOmp(state, repoA, 'Keep me')
    failing = true

    await expect(state.records.deleteChat(chat)).rejects.toThrow('database is locked')
    failing = false
    expect((await state.records.listChats(repoA)).map((listed) => listed.id)).toEqual([chat.id])
    expect(state.endpoint(chat)?.state).toBe('open')

    await state.records.deleteChat(chat)
    expect(await state.records.listChats(repoA)).toEqual([])
    expect(state.endpoint(chat)?.state).toBe('deleted')
  })
})

describe('chat mailboxes: recovery at startup', () => {
  it('finishes a deletion a crash cut short after the deleting intent, instead of provisioning the chat again', async () => {
    const state = await rig({
      removeOmpFolder: async () => {
        throw new Error('The app crashed while removing the chat’s files.')
      }
    })
    const chat = await newOmp(state, repoA, 'Half deleted')
    await expect(state.records.deleteChat(chat)).rejects.toThrow('crashed')
    expect(state.store.getChat(chat)).not.toBeNull()

    const removed: string[] = []
    const after = state.restart({ removeOmpFolder: async (chatId) => void removed.push(chatId) })
    expect(await after.mailboxes.reconcile(repoA, after.store.listChats(repoA))).toMatchObject({ chats: [], deleting: [expect.objectContaining({ id: chat.id })] })
    await after.records.recoverFolder(repoA)

    expect(after.store.getChat(chat)).toBeNull()
    expect(removed).toEqual([chat.id])
    expect(after.endpoint(chat)?.state).toBe('deleted')
  })

  it('deletes at startup the open mailbox this installation provisioned for a chat whose record is gone, and leaves one it never did', async () => {
    const state = await rig()
    const lost = await newOmp(state, repoA, 'Lost')
    const ctx = state.pool.get(repoA).ctx()
    const foreign = provisionAgentMailEndpoint(ctx, { chatId: 'chat_of_another_installation', name: 'Foreign' })
    // The index lost the chat's lines (a restored or damaged index), while the database kept its mailbox open.
    state.store.deleteChat(lost)

    await state.restart().records.recoverFolder(repoA)

    expect(state.endpoint(lost)?.state).toBe('deleted')
    expect(findEndpointByChat(ctx, { machineId: ctx.machineId, chatId: foreign.chatId })?.state).toBe('open')
  })
})

describe('chat mailboxes: untrack and track again', () => {
  it('suspends on untrack and binds only a fresh grant after the folder is tracked again', async () => {
    const state = await rig()
    const chat = await newOmp(state, repoA, 'Suspended')
    const old = await state.issue(chat)

    await state.mailboxes.suspendFolder(repoA, state.store.listChats(repoA))
    state.tracked.delete(repoA)
    state.pool.close(repoA)
    expect(state.endpoint(chat)?.state).toBe('suspended')
    expect(getBinding(state.pool.get(repoA).ctx(), old.grantId)).toMatchObject({ closeReason: 'suspended' })
    await expect(state.agent(repoA, old.token).readAgentInbox({})).rejects.toMatchObject({ code: 'unauthorized' })

    state.tracked.add(repoA)
    expect((await state.records.listChats(repoA))[0]?.endpointId).toBe(chat.endpointId)
    expect(state.endpoint(chat)?.state).toBe('open')
    // The old grant is still unexpired and unrevoked here, and still never binds again.
    expect(() => bindAgentMailEndpoint(state.pool.get(repoA).ctx(), { endpointId: chat.endpointId ?? '', grantId: old.grantId })).toThrow(
      'This grant is already bound, or its binding has been closed for good.'
    )
    const fresh = await state.issue(chat)
    expect(fresh.endpointId).toBe(chat.endpointId)
    expect(getBinding(state.pool.get(repoA).ctx(), old.grantId)).toMatchObject({ closeReason: 'suspended' })
    await expect(state.agent(repoA, old.token).readAgentInbox({})).rejects.toMatchObject({ code: 'unauthorized' })
    expect((await state.agent(repoA, fresh.token).getAgentIdentity({})).endpointId).toBe(chat.endpointId)
  })

  it('binds nothing for a grant issued while its folder was being untracked, revokes it, and leaves the mailbox suspended', async () => {
    let state: Rig | null = null
    state = await rig({
      wrap: (workspace) => ({
        ...workspace,
        call: (async (operation, ...args) => {
          const issued = await workspace.call(operation, ...args)
          if (operation !== 'issueChatGrant') return issued
          // The person untracks the folder between the grant's issue and its binding.
          const self = state as Rig
          await self.mailboxes.suspendFolder(repoA, self.store.listChats(repoA))
          self.tracked.delete(repoA)
          self.pool.close(repoA)
          return issued
        }) as typeof workspace.call
      })
    })
    const chat = await newOmp(state, repoA, 'Untracked mid-start')

    await expect(state.issue(chat)).rejects.toMatchObject({ code: 'unauthorized' })

    expect(state.endpoint(chat)?.state).toBe('suspended')
    expect(liveGrants(state, repoA)).toEqual([])
  })
})

describe('chat mailboxes: names and never-provisioned chats', () => {
  it('names the mailbox of a chat with a blank title “Chat”, so it can still be provisioned and found', async () => {
    const state = await rig()
    const blank = state.store.createChat({ folder: repoA, agent: 'omp', model: null, role: 'worker', allowSave: false, title: '   ' })

    const endpointId = (await state.records.listChats(repoA))[0]?.endpointId
    expect(endpointId).toMatch(/^me_/)
    expect(state.endpoint(blank)).toMatchObject({ id: endpointId, name: 'Chat', state: 'open' })
    expect(state.logged).toEqual([])
  })

  it('records a tombstone when deleting an OMP chat that never had a mailbox, so a late start cannot create one', async () => {
    const state = await rig()
    // A legacy chat, never listed since: it has no mailbox yet.
    const legacy = state.store.createChat({ folder: repoA, agent: 'omp', model: null, role: 'worker', allowSave: false, title: 'Never listed' })
    expect(state.endpoint(legacy)).toBeNull()

    await state.records.deleteChat(legacy)

    expect(state.endpoint(legacy)).toMatchObject({ name: 'Never listed', state: 'deleted' })
    await expect(state.issue(legacy)).rejects.toMatchObject({ code: 'invalid_state' })
    expect(liveGrants(state, repoA)).toEqual([])
  })
})

describe('chat mailboxes: a tracked folder never set up for Dark Mechanicus', () => {
  it('lists, renames, deletes and recovers its OMP chats without a mailbox, silently', async () => {
    const state = await rig()
    const bare = join(root, 'bare')
    mkdirSync(bare)
    state.tracked.add(bare)

    const chat = await newOmp(state, bare, 'No database')
    expect(chat.endpointId).toBeUndefined()
    expect((await state.records.listChats(bare)).map((listed) => listed.endpointId)).toEqual([undefined])
    expect((await state.records.renameChat(chat, 'Still none')).title).toBe('Still none')
    await state.records.recoverFolder(bare)
    await state.records.deleteChat(chat)

    expect(await state.records.listChats(bare)).toEqual([])
    expect(state.logged).toEqual([])
  })
})

describe('chat mailboxes: storage that cannot be reached', () => {
  it('renames the chat but logs that its mailbox kept the old name, and a later rename catches up', async () => {
    let failing = false
    const state = await rig({ contextFails: () => failing })
    const chat = await newOmp(state, repoA, 'Before')
    failing = true

    expect((await state.records.renameChat(chat, 'After')).title).toBe('After')
    failing = false
    expect(state.logged).toEqual([`Could not rename the mailbox of chat ${chat.id} in ${repoA}: database is locked`])
    expect(state.endpoint(chat)).toMatchObject({ id: chat.endpointId, name: 'Before' })

    await state.records.renameChat(chat, 'After, again')
    expect(state.endpoint(chat)).toMatchObject({ id: chat.endpointId, name: 'After, again' })
  })

  it('leaves the mailboxes open on untrack and says so, readably even for a thrown non-Error', async () => {
    let failing = false
    const state = await rig({ contextFails: () => failing, contextError: 'SQLITE_BUSY' })
    const chat = await newOmp(state, repoA, 'Stays open')
    failing = true

    await state.mailboxes.suspendFolder(repoA, state.store.listChats(repoA))
    failing = false

    expect(state.logged).toEqual([
      `Could not suspend chat mailboxes in ${repoA}: SQLITE_BUSY`,
      `The chat mailboxes in ${repoA} stay open: the folder's storage could not be reached to suspend them.`
    ])
    expect(state.endpoint(chat)?.state).toBe('open')
  })
})

describe('chat mailboxes: storage that cannot be reached, for other chats and at startup', () => {
  it('never touches storage for a folder with no OMP chat: deleting, renaming and untracking its other chats just work', async () => {
    let failing = false
    const state = await rig({ contextFails: () => failing })
    const claude = await state.records.createChat({ folder: repoA, agent: 'claude', role: 'worker', title: 'Claude' })
    failing = true

    expect((await state.records.renameChat(claude, 'Claude, renamed')).title).toBe('Claude, renamed')
    await state.mailboxes.suspendFolder(repoA, state.store.listChats(repoA))
    await state.records.deleteChat(claude)

    expect(state.store.getChat(claude)).toBeNull()
    expect(state.logged).toEqual([])
  })

  it('rethrows nothing at startup when storage is down, keeping orphaned mailboxes until it can delete them', async () => {
    let failing = false
    const state = await rig({ contextFails: () => failing })
    const lost = await newOmp(state, repoA, 'Lost')
    state.store.deleteChat(lost)
    failing = true

    const restarted = state.restart({ contextFails: () => failing })
    await restarted.records.recoverFolder(repoA)
    failing = false
    expect(restarted.logged).toEqual([`Could not delete the mailboxes of deleted chats in ${repoA}: database is locked`])
    expect(state.endpoint(lost)?.state).toBe('open')

    await restarted.records.recoverFolder(repoA)
    expect(state.endpoint(lost)?.state).toBe('deleted')
  })
})

describe('chat mailboxes: orphans and half-deleted chats', () => {
  it('deletes an orphaned mailbox at startup while keeping the folder’s live chat and its mailbox', async () => {
    const state = await rig()
    const live = await newOmp(state, repoA, 'Live')
    const lost = await newOmp(state, repoA, 'Lost')
    state.store.deleteChat(lost)

    await state.restart().records.recoverFolder(repoA)

    expect(state.endpoint(lost)?.state).toBe('deleted')
    expect(state.endpoint(live)).toMatchObject({ id: live.endpointId, state: 'open' })
    expect((await state.records.listChats(repoA)).map((chat) => chat.endpointId)).toEqual([live.endpointId])
  })

  it('pages through every open mailbox at startup, so an orphan past the first page is deleted too', async () => {
    const state = await rig()
    const ctx = state.pool.get(repoA).ctx()
    const foreign = Array.from({ length: 50 }, (_, index) => provisionAgentMailEndpoint(ctx, { chatId: `chat_foreign_${index}`, name: `Foreign ${index}` }))
    const lost = await newOmp(state, repoA, 'Past the first page')
    expect(foreign.every((endpoint) => endpoint.id < (lost.endpointId ?? ''))).toBe(true)
    state.store.deleteChat(lost)

    await state.restart().records.recoverFolder(repoA)

    expect(state.endpoint(lost)?.state).toBe('deleted')
    expect(foreign.map((endpoint) => findEndpointByChat(ctx, { machineId: ctx.machineId, chatId: endpoint.chatId })?.state)).toEqual(foreign.map(() => 'open'))
  })

  it('renames a chat whose deletion was cut short without reopening its mailbox, logging why', async () => {
    const state = await rig({
      removeOmpFolder: async () => {
        throw new Error('The app crashed while removing the chat’s files.')
      }
    })
    const chat = await newOmp(state, repoA, 'Half deleted')
    await expect(state.records.deleteChat(chat)).rejects.toThrow('crashed')

    expect((await state.records.renameChat(chat, 'Renamed too late')).title).toBe('Renamed too late')

    expect(state.logged).toEqual([expect.stringMatching(new RegExp(`^Could not rename the mailbox of chat ${chat.id}: .*deleted`))])
    expect(state.endpoint(chat)).toMatchObject({ name: 'Half deleted', state: 'deleted' })
  })

  it('suspends the open mailboxes on untrack and leaves a half-deleted chat’s deleted one as it is, without a complaint', async () => {
    const state = await rig({
      removeOmpFolder: async () => {
        throw new Error('The app crashed while removing the chat’s files.')
      }
    })
    const half = await newOmp(state, repoA, 'Half deleted')
    const open = await newOmp(state, repoA, 'Open')
    await expect(state.records.deleteChat(half)).rejects.toThrow('crashed')

    await state.mailboxes.suspendFolder(repoA, state.store.listChats(repoA))

    expect([state.endpoint(half)?.state, state.endpoint(open)?.state]).toEqual(['deleted', 'suspended'])
    expect(state.logged).toEqual([])
  })
})
