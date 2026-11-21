/**
 * Agent mail through the real command table: real workspaces on a temporary repository, real `dm` CLI grant
 * sessions, the restricted mailbox-poll mode, and separate Node processes competing for one SQLite database.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CommandName } from '../../shared/domain/api'
import type { GrantableRole } from '../../shared/domain/views'
import { createHarness, type Harness, TEST_STORAGE } from '../../test/workspaceHarness'
import { createMemoryFs } from '../../test/memoryFs'
import type { FsAdapter, GitAdapter } from '../repo/types'
import { bindAgentMailEndpoint, provisionAgentMailEndpoint } from '../services/agentMail'
import type { MailEndpoint } from '../services/agentMailStore'
import type { Workspace } from '../workspace'
import { COMMAND_CAPABILITIES } from './capabilities'
import { DomainError } from '../errors'
import { COMMANDS } from './index'

const MAIL_COMMANDS: CommandName[] = [
  'getAgentIdentity',
  'listAgentPeers',
  'sendAgentMessage',
  'readAgentInbox',
  'acknowledgeAgentMessages',
  'getAgentMailStatus'
]

let harness: Harness

beforeEach(() => {
  harness = createHarness()
})

afterEach(() => {
  harness.cleanup()
})

interface Chat {
  endpoint: MailEndpoint
  grantId: string
  token: string
  /** An ordinary `dm` CLI session on the chat's grant. */
  cli(): Workspace
  /** A restricted mailbox-poll session on the chat's grant, as the CLI opens one for status and wake. */
  poll(options?: { fs?: FsAdapter; git?: GitAdapter }): Workspace
}

async function withDesktop(): Promise<Workspace> {
  const desktop = harness.open('desktop')
  await desktop.initializeRepository({ name: 'mail-repo' })
  return desktop
}

async function boundChat(desktop: Workspace, chatId: string, role: GrantableRole = 'worker'): Promise<Chat> {
  const endpoint = provisionAgentMailEndpoint(desktop.ctx(), { chatId, name: `Chat ${chatId}` })
  const { grant, token } = await desktop.issueGrant({ role, label: chatId })
  bindAgentMailEndpoint(desktop.ctx(), { endpointId: endpoint.id, grantId: grant.id })
  return {
    endpoint,
    grantId: grant.id,
    token,
    cli: () => harness.open('reader', { transport: 'cli', grantToken: token }),
    poll: (options = {}) => harness.open('reader', { transport: 'cli', grantToken: token, mailPoll: true, ...options })
  }
}

function codeOf(error: unknown): string {
  return error instanceof DomainError ? error.code : 'thrown'
}

function count(desktop: Workspace, sql: string, ...params: string[]): number {
  return desktop.ctx().db.get<{ n: number }>(sql, ...params)?.n ?? 0
}

describe('the seven mailbox commands', () => {
  it('are declared with mail.use and as local writes that never flush', () => {
    for (const name of MAIL_COMMANDS) {
      expect(COMMAND_CAPABILITIES[name]).toBe('mail.use')
      expect(COMMANDS[name].mutates).toBe(false)
      expect(COMMANDS[name].schema).toBeDefined()
    }
  })

  it('carry a conversation between two bound CLI grants end to end', async () => {
    const desktop = await withDesktop()
    const a = await boundChat(desktop, 'chat-a')
    const b = await boundChat(desktop, 'chat-b', 'orchestrator')
    const sender = a.cli()
    expect(await sender.getAgentIdentity({})).toMatchObject({ endpointId: a.endpoint.id, role: 'worker' })
    expect((await sender.listAgentPeers({})).peers).toEqual([{ endpointId: b.endpoint.id, name: 'Chat chat-b' }])
    const accepted = await sender.sendAgentMessage({ to: b.endpoint.id, clientMessageId: 'hello-1', body: 'Ready for review?' })

    const receiver = b.cli()
    const status = await receiver.getAgentMailStatus({})
    expect(status).toMatchObject({ pendingCount: 1, snapshotHighWater: 1, nextCursor: 1, hasMore: false })
    expect(status.messages[0]).not.toHaveProperty('body')
    const inbox = await receiver.readAgentInbox({ unacknowledgedOnly: true })
    expect(inbox.messages.map((message) => [message.id, message.body])).toEqual([[accepted.messageId, 'Ready for review?']])
    const reply = await receiver.sendAgentMessage({ to: a.endpoint.id, clientMessageId: 'reply-1', body: 'Yes.', inReplyTo: accepted.messageId })
    await receiver.acknowledgeAgentMessages({ messageIds: [accepted.messageId] })
    expect((await receiver.getAgentMailStatus({})).pendingCount).toBe(0)
    expect((await sender.readAgentInbox({})).messages[0]).toMatchObject({ id: reply.messageId, inReplyTo: accepted.messageId })
  })
})

describe('mailbox command inputs', () => {
  it('refuses unknown properties, a spoofed sender among them, before anything runs', async () => {
    const desktop = await withDesktop()
    const a = await boundChat(desktop, 'chat-a')
    const b = await boundChat(desktop, 'chat-b')
    const cli = a.cli()
    const send = { to: b.endpoint.id, clientMessageId: 'spoof', body: 'x' }
    const refused: [CommandName, unknown][] = [
      ['sendAgentMessage', { ...send, from: b.endpoint.id }],
      ['sendAgentMessage', { ...send, senderEndpointId: b.endpoint.id }],
      ['getAgentIdentity', { endpointId: b.endpoint.id }],
      ['readAgentInbox', { endpointId: b.endpoint.id }],
      ['getAgentMailStatus', { endpointId: b.endpoint.id }],
      ['acknowledgeAgentMessages', { messageIds: [] }],
      ['acknowledgeAgentMessages', { messageIds: Array.from({ length: 101 }, (_, index) => `mm_${String(index).padStart(26, '0')}`) }],
      ['sendAgentMessage', { ...send, body: 'x'.repeat(16 * 1024 + 1) }],
      ['sendAgentMessage', { ...send, clientMessageId: '-leading-dash' }],
      ['listAgentPeers', { limit: 51 }]
    ]
    for (const [name, input] of refused) {
      expect(await cli.execute(name, input).then(() => 'ok', codeOf)).toBe('invalid_input')
    }
    expect(count(desktop, 'SELECT COUNT(*) AS n FROM agent_mail_messages')).toBe(0)
    // Positive control: the same send without the extra property goes through.
    await expect(cli.execute('sendAgentMessage', send)).resolves.toMatchObject({ duplicate: false })
  })
})

describe('mailbox command authority', () => {
  it('gives no mailbox to an ungranted reader, an MCP stdio session with an inherited token, or an unbound grant', async () => {
    const desktop = await withDesktop()
    const a = await boundChat(desktop, 'chat-a')
    const reader = harness.open('reader', { transport: 'cli' })
    const stdio = harness.open('worker', { transport: 'stdio', grantToken: a.token })
    const unbound = harness.open('reader', { transport: 'cli', grantToken: (await desktop.issueGrant({ role: 'worker', label: 'loose' })).token })
    for (const session of [reader, stdio, unbound]) {
      for (const name of MAIL_COMMANDS) {
        const input = name === 'sendAgentMessage' ? { to: a.endpoint.id, clientMessageId: 'x', body: 'x' } : name === 'acknowledgeAgentMessages' ? { messageIds: ['mm_00000000000000000000000001'] } : {}
        expect(await session.execute(name, input).then(() => 'ok', codeOf)).toBe('unauthorized')
      }
    }
    expect((await reader.getCapabilities()).mailbox).toEqual({ bound: false, reason: 'no_mail_capability' })
    expect((await stdio.getCapabilities()).mailbox).toEqual({ bound: false, reason: 'no_grant' })
    expect((await unbound.getCapabilities()).mailbox).toEqual({ bound: false, reason: 'unbound' })
    expect((await a.cli().getCapabilities()).mailbox).toEqual({ bound: true, endpointId: a.endpoint.id })
  })

  it('stops a running CLI session the moment its grant is revoked', async () => {
    const desktop = await withDesktop()
    const a = await boundChat(desktop, 'chat-a')
    const b = await boundChat(desktop, 'chat-b')
    const cli = a.cli()
    await expect(cli.sendAgentMessage({ to: b.endpoint.id, clientMessageId: 'before', body: 'x' })).resolves.toMatchObject({ duplicate: false })
    await desktop.revokeGrant({ grantId: a.grantId })
    await expect(cli.sendAgentMessage({ to: b.endpoint.id, clientMessageId: 'before', body: 'x' })).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('writes mail without a portable flush, even with the coordinating checkout on another branch', async () => {
    const desktop = await withDesktop()
    const a = await boundChat(desktop, 'chat-a')
    const b = await boundChat(desktop, 'chat-b')
    await desktop.createEpic({ title: 'Tracked work' })
    const outbox = count(desktop, 'SELECT COUNT(*) AS n FROM outbox')
    harness.git.setHead({ branch: 'elsewhere', commit: 'b'.repeat(40), detached: false })
    const cli = a.cli()
    await expect(cli.sendAgentMessage({ to: b.endpoint.id, clientMessageId: 'off-branch', body: 'x' })).resolves.toMatchObject({ duplicate: false })
    await expect(b.cli().acknowledgeAgentMessages({ messageIds: (await b.cli().readAgentInbox({})).messages.map((message) => message.id) })).resolves.toBeDefined()
    expect(count(desktop, 'SELECT COUNT(*) AS n FROM outbox')).toBe(outbox)
    // Positive control: a portable flush meets the branch guard that mail never reaches.
    await expect(desktop.flushPortableState()).rejects.toMatchObject({ code: 'branch_changed' })
  })
})

/** `base`, counting each call by method name (its own methods or its prototype's). */
function countingFs(calls: Map<string, number>, base: FsAdapter = TEST_STORAGE.fs as FsAdapter): FsAdapter {
  return new Proxy(base, {
    get(target, name, receiver) {
      const member: unknown = Reflect.get(target, name, receiver)
      if (typeof member !== 'function' || typeof name !== 'string') {
        return member
      }
      return (...args: unknown[]) => {
        calls.set(name, (calls.get(name) ?? 0) + 1)
        return Reflect.apply(member, target, args)
      }
    }
  })
}

/** Filesystem calls that only record maintenance (reconcile, flush, staged-image pruning) makes. */
const MAINTENANCE = ['writeFile', 'writeFileBytes', 'rename', 'remove', 'removeDir', 'readdir'] as const

describe('the restricted mailbox-poll mode at a thousand polls', () => {
  it('answers a thousand status polls on one dedicated session, with no record reconcile, flush or pruning', async () => {
    const desktop = await withDesktop()
    const a = await boundChat(desktop, 'chat-a')
    const b = await boundChat(desktop, 'chat-b')
    await desktop.createEpic({ title: 'Tracked work for reconcile to scan' })
    await a.cli().sendAgentMessage({ to: b.endpoint.id, clientMessageId: 'one', body: 'x' })
    const calls = new Map<string, number>()
    let heads = 0
    const git: GitAdapter = { ...harness.git, head: () => { heads += 1; return harness.git.head() } }

    // Positive control: an ordinary CLI open does record maintenance through the same probes.
    const ordinary = harness.open('reader', { transport: 'cli', grantToken: b.token, fs: countingFs(calls), git })
    await ordinary.getAgentMailStatus({})
    ordinary.close()
    expect(heads).toBeGreaterThan(0)
    expect(calls.get('readdir') ?? 0).toBeGreaterThan(0)

    // The first poll, on the real filesystem: no maintenance, and the dedicated session is created.
    calls.clear()
    heads = 0
    const first = b.poll({ fs: countingFs(calls), git })
    expect((await first.getAgentMailStatus({})).pendingCount).toBe(1)
    first.close()
    expect(MAINTENANCE.map((name) => calls.get(name) ?? 0)).toEqual(MAINTENANCE.map(() => 0))
    expect(heads).toBe(0)

    // The thousand that follow read the project files from memory and the real database, so the loop costs the poll path.
    const files = createMemoryFs()
    const projectFiles = [join(harness.root, '.darkmechanicus', 'project.json'), join(harness.root, '.darkmechanicus', 'local', 'machine.json')]
    projectFiles.forEach((path) => files.put(path, readFileSync(path, 'utf8')))
    const options = { transport: 'cli' as const, grantToken: b.token, mailPoll: true, fs: countingFs(calls, files), git }
    const sessions = count(desktop, 'SELECT COUNT(*) AS n FROM sessions')
    const outbox = count(desktop, 'SELECT COUNT(*) AS n FROM outbox')
    const pendingCounts = new Set<number>()
    const sampledSessions: number[] = []
    for (let index = 1; index <= 1000; index += 1) {
      const poll = harness.open('reader', options)
      pendingCounts.add((await poll.getAgentMailStatus({})).pendingCount)
      poll.close()
      if (index % 250 === 0) {
        sampledSessions.push(count(desktop, 'SELECT COUNT(*) AS n FROM sessions'))
      }
    }
    expect([...pendingCounts]).toEqual([1])
    expect(sampledSessions).toEqual([sessions, sessions, sessions, sessions])
    expect(count(desktop, 'SELECT COUNT(*) AS n FROM agent_mail_poll_sessions WHERE grant_id = ?', b.grantId)).toBe(1)
    expect(count(desktop, 'SELECT COUNT(*) AS n FROM outbox')).toBe(outbox)
    expect(MAINTENANCE.map((name) => calls.get(name) ?? 0)).toEqual(MAINTENANCE.map(() => 0))
    expect(files.writes).toEqual([])
    expect(heads).toBe(0)
  })
})

describe('the restricted mailbox-poll mode’s shared session', () => {
  it('keeps the shared session open across polls, started once and seen on each success, unlike an ordinary CLI close', async () => {
    const desktop = await withDesktop()
    const b = await boundChat(desktop, 'chat-b')
    const sessionRow = (id: string | null) =>
      desktop.ctx().db.get<{ started_at: string; last_seen_at: string; ended_at: string | null; pid: number | null }>(
        'SELECT started_at, last_seen_at, ended_at, pid FROM sessions WHERE id = ?',
        id
      )
    const first = b.poll()
    await first.getAgentMailStatus({})
    const id = first.sessionId()
    first.close()
    const started = sessionRow(id)?.started_at
    harness.clock.advanceSeconds(30)
    const second = b.poll()
    await second.getAgentMailStatus({})
    expect(second.sessionId()).toBe(id)
    second.close()
    expect(sessionRow(id)).toEqual({ started_at: started, last_seen_at: harness.clock.nowIso(), ended_at: null, pid: null })
    expect((await desktop.listSessions()).find((session) => session.id === id)?.active).toBe(true)
    harness.clock.advanceSeconds(120)
    expect((await desktop.listSessions()).find((session) => session.id === id)?.active).toBe(false)

    const ordinary = b.cli()
    await ordinary.getAgentMailStatus({})
    const ordinaryId = ordinary.sessionId()
    ordinary.close()
    expect(ordinaryId).not.toBe(id)
    expect(sessionRow(ordinaryId)?.ended_at).toBe(harness.clock.nowIso())
  })

})

describe('the restricted mailbox-poll mode’s whitelist', () => {
  it('runs only own identity and status reads, refusing every other command before dispatch', async () => {
    const desktop = await withDesktop()
    const a = await boundChat(desktop, 'chat-a')
    const b = await boundChat(desktop, 'chat-b')
    const poll = b.poll()
    const others = (Object.keys(COMMANDS) as CommandName[]).filter((name) => name !== 'getAgentMailStatus' && name !== 'getAgentIdentity')
    for (const name of others) {
      expect(await poll.execute(name, {}).then(() => 'ok', codeOf)).toBe('unauthorized')
    }
    await expect(poll.sendAgentMessage({ to: a.endpoint.id, clientMessageId: 'x', body: 'x' })).rejects.toMatchObject({ code: 'unauthorized' })
    expect(() => poll.heartbeat()).toThrow(/no heartbeat/)
    await expect(poll.getAgentMailStatus({})).resolves.toMatchObject({ pendingCount: 0 })
    await expect(poll.getAgentIdentity({})).resolves.toMatchObject({ endpointId: b.endpoint.id })
  })

  it('needs the CLI and a usable bound grant to open at all', async () => {
    const desktop = await withDesktop()
    const b = await boundChat(desktop, 'chat-b')
    const loose = (await desktop.issueGrant({ role: 'worker', label: 'loose' })).token
    const opening = [
      () => harness.open('reader', { transport: 'cli', mailPoll: true }),
      () => harness.open('worker', { mailPoll: true, grantToken: b.token }),
      () => harness.open('worker', { transport: 'stdio', mailPoll: true, grantToken: b.token }),
      () => harness.open('reader', { transport: 'cli', grantToken: loose, mailPoll: true })
    ]
    for (const open of opening) {
      expect(() => open()).toThrow(expect.objectContaining({ code: 'unauthorized' }))
    }
    expect(() => b.poll()).not.toThrow()
    await desktop.revokeGrant({ grantId: b.grantId })
    expect(() => b.poll()).toThrow(expect.objectContaining({ code: 'unauthorized' }))
  })
})

const WORKSPACE = new URL('../workspace.ts', import.meta.url).href
const REPOSITORY = fileURLToPath(new URL('../../../', import.meta.url))

const CHILD_READY = 'DM_AGENT_MAIL_CHILD_READY'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
  reject(reason?: unknown): void
}

/** Adapts child-process events to promises on the project's ES2022 target. */
function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

interface WaitingProcess {
  ready: Promise<void>
  result: Promise<unknown>
  start(): void
}

/** Starts one script in its own Node process and holds it at the shared start barrier. */
function waitingProcess(source: string): WaitingProcess {
  const ready = deferred<void>()
  const result = deferred<unknown>()
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    cwd: REPOSITORY
  })
  let stdout = ''
  let stderr = ''
  let announced = false
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
    if (!announced && stdout.split(/\r?\n/).includes(CHILD_READY)) {
      announced = true
      ready.resolve()
    }
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  child.stdin.on('error', (error) => {
    ready.reject(error)
    result.reject(error)
  })
  child.on('error', (error) => {
    ready.reject(error)
    result.reject(error)
  })
  child.on('close', (code) => {
    if (!announced) {
      ready.reject(new Error(`child exited before the start barrier: ${stderr}`))
    }
    if (code !== 0) {
      result.reject(new Error(`child exited ${String(code)}: ${stderr}`))
      return
    }
    try {
      result.resolve(JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? 'null'))
    } catch (error: unknown) {
      result.reject(error)
    }
  })
  return {
    ready: ready.promise,
    result: result.promise,
    start: () => {
      if (!child.stdin.destroyed) child.stdin.end('\n')
    }
  }
}

/** Releases every child only after all are ready, preserving real cross-process contention without a timed spin. */
async function inProcesses(sources: string[]): Promise<unknown[]> {
  const children = sources.map(waitingProcess)
  const results = children.map((child) => child.result)
  for (const result of results) void result.catch(() => undefined)
  try {
    await Promise.all(children.map((child) => child.ready))
  } catch (error: unknown) {
    for (const child of children) child.start()
    await Promise.allSettled(results)
    throw error
  }
  for (const child of children) child.start()
  const settled = await Promise.allSettled(results)
  const values: unknown[] = []
  for (const result of settled) {
    if (result.status === 'rejected') throw result.reason
    values.push(result.value)
  }
  return values
}

/** A script that opens a fresh CLI workspace per call, as `dm` does, after the parent releases its start barrier. */
function script(token: string, body: string): string {
  return `
    import { once } from 'node:events';
    import { openWorkspace } from ${JSON.stringify(WORKSPACE)};
    const open = (extra = {}) => openWorkspace({ repoRoot: ${JSON.stringify(harness.root)}, homeDir: ${JSON.stringify(harness.homeDir)},
      role: 'reader', transport: 'cli', label: 'child', grantToken: ${JSON.stringify(token)}, autoReconcile: false,
      databaseSynchronous: 'off', ...extra });
    const call = async (extra, run) => { const ws = open(extra); try { return await run(ws) } finally { ws.close() } };
    console.log(${JSON.stringify(CHILD_READY)});
    await once(process.stdin, 'data');
    const out = [];
    ${body}
    console.log(JSON.stringify(out));`
}

/** Real time, since the child processes run on the system clock. */
async function realTimeDesktop(): Promise<Workspace> {
  harness.clock.set(new Date().toISOString())
  return withDesktop()
}

describe('separate processes sending into one mailbox database', () => {
  it('accepts two processes’ concurrent sends into one gap-free sequence, and one shared retry once', async () => {
    const desktop = await realTimeDesktop()
    const a = await boundChat(desktop, 'chat-a')
    const c = await boundChat(desktop, 'chat-c')
    const b = await boundChat(desktop, 'chat-b')
    const sends = (sender: Chat, prefix: string) =>
      script(
        sender.token,
        `for (let i = 0; i < 25; i += 1) {
           out.push(await call({}, (ws) => ws.sendAgentMessage({ to: ${JSON.stringify(b.endpoint.id)}, clientMessageId: '${prefix}-' + i, body: 'body ' + i })));
           if (i === 12) out.push(await call({}, (ws) => ws.sendAgentMessage({ to: ${JSON.stringify(b.endpoint.id)}, clientMessageId: 'shared', body: 'same' })));
         }`
      )
    const [fromA1, fromA2, fromC] = (await inProcesses([sends(a, 'a1'), sends(a, 'a2'), sends(c, 'c')])) as { messageId: string; clientMessageId: string; duplicate: boolean }[][]
    const rows = desktop.ctx().db.all<{ recipient_seq: number; client_message_id: string; sender_endpoint_id: string }>(
      'SELECT recipient_seq, client_message_id, sender_endpoint_id FROM agent_mail_messages WHERE recipient_endpoint_id = ? ORDER BY recipient_seq',
      b.endpoint.id
    )
    expect(rows.map((row) => row.recipient_seq)).toEqual(Array.from({ length: 77 }, (_, index) => index + 1))
    const shared = [...(fromA1 ?? []), ...(fromA2 ?? [])].filter((result) => result.clientMessageId === 'shared')
    expect(new Set(shared.map((result) => result.messageId)).size).toBe(1)
    expect(shared.map((result) => result.duplicate).sort()).toEqual([false, true])
    // C's own "shared" is its own message: the retry key is scoped by sender.
    expect(rows.filter((row) => row.client_message_id === 'shared').map((row) => row.sender_endpoint_id).sort()).toEqual([a.endpoint.id, c.endpoint.id].sort())
    expect(fromC?.every((result) => !result.duplicate)).toBe(true)
  })
})

describe('separate processes polling one mailbox database', () => {
  it('maps concurrent status polls from two processes to one dedicated session', async () => {
    const desktop = await realTimeDesktop()
    const a = await boundChat(desktop, 'chat-a')
    const b = await boundChat(desktop, 'chat-b')
    await a.cli().sendAgentMessage({ to: b.endpoint.id, clientMessageId: 'wake', body: 'x' })
    const sessions = count(desktop, 'SELECT COUNT(*) AS n FROM sessions')
    const polls = script(
      b.token,
      `for (let i = 0; i < 15; i += 1) {
         out.push(await call({ mailPoll: true }, async (ws) => ({ status: await ws.getAgentMailStatus({}), session: ws.sessionId() })));
       }`
    )
    const results = ((await inProcesses([polls, polls])) as { session: string; status: { pendingCount: number } }[][]).flat()
    expect(new Set(results.map((result) => result.session)).size).toBe(1)
    expect(count(desktop, 'SELECT COUNT(*) AS n FROM sessions')).toBe(sessions + 1)
    expect(results).toHaveLength(30)
    expect(results.every((result) => result.status.pendingCount === 1)).toBe(true)
  })
})

describe('separate processes and a revocation that commits mid-stream', () => {
  it('stops a sending process at the revocation that commits mid-stream, while another keeps acknowledging', async () => {
    const desktop = await realTimeDesktop()
    const a = await boundChat(desktop, 'chat-a')
    const b = await boundChat(desktop, 'chat-b')
    const fromA = (): number => count(desktop, 'SELECT COUNT(*) AS n FROM agent_mail_messages WHERE sender_endpoint_id = ?', a.endpoint.id)
    // The sender keeps going until three refusals in a row; any success after a refusal would show a stale grant.
    const sender = script(
      a.token,
      `for (let i = 0; i < 400 && out.filter((result) => result !== 'ok').length < 3; i += 1) {
         try { await call({}, (ws) => ws.sendAgentMessage({ to: ${JSON.stringify(b.endpoint.id)}, clientMessageId: 'r-' + i, body: 'body ' + i })); out.push('ok') }
         catch (error) { out.push(error.code ?? 'thrown') }
       }`
    )
    // The recipient reads and acknowledges throughout; any failure of its own fails the child.
    const acker = script(
      b.token,
      `for (let i = 0; i < 40; i += 1) {
         const ids = await call({}, async (ws) => (await ws.readAgentInbox({ unacknowledgedOnly: true })).messages.map((message) => message.id));
         if (ids.length > 0) out.push((await call({}, (ws) => ws.acknowledgeAgentMessages({ messageIds: ids }))).acknowledged.length);
       }`
    )
    let settled = false
    const children = inProcesses([sender, acker]).finally(() => {
      settled = true
    })
    // Revoke only once the sender has demonstrably been sending: the positive control for the refusals that follow.
    // The sender is another process on the real clock, so this waits on its observable progress, not a fixed delay.
    while (!settled && fromA() < 5) {
      await delay(5)
    }
    await desktop.revokeGrant({ grantId: a.grantId })
    const [sent, acked] = (await children) as [string[], number[]]
    const firstRefusal = sent.indexOf('unauthorized')
    expect(firstRefusal).toBeGreaterThanOrEqual(5)
    expect(sent.slice(firstRefusal)).toEqual(['unauthorized', 'unauthorized', 'unauthorized'])
    expect(fromA()).toBe(firstRefusal)
    expect(acked.reduce((sum, n) => sum + n, 0)).toBeGreaterThan(0)
    // The recipient's grant was never touched: it still acknowledges whatever is left, and nothing stays pending.
    const recipient = b.cli()
    const left = (await recipient.readAgentInbox({ unacknowledgedOnly: true })).messages.map((message) => message.id)
    if (left.length > 0) {
      await recipient.acknowledgeAgentMessages({ messageIds: left })
    }
    expect((await recipient.getAgentMailStatus({})).pendingCount).toBe(0)
  })
})
