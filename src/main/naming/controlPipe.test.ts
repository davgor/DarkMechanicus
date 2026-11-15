import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setImmediate as turn } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDesktopClient } from '../../core/desktop/desktopClient'
import { DomainError } from '../../core/errors'
import { openWorkspace, type Workspace } from '../../core/workspace'
import { NAMING_CONTROL, type NamingOperation, type NamingReply } from '../../shared/agents/chatNaming'
import { createTestClock, type TestClock } from '../../test/testContext'
import { createFakeGit } from '../../test/workspaceHarness'
import { createChatGrants, type ChatGrants } from '../agents/chatGrants'
import { FakeClock, gate } from '../terminals/__mocks__/terminalSessionsRig'
import { createControlPipe, type ControlPipe, type NamingDispatcher, type NamingOperationContext } from './controlPipe'

let root: string
let repo: string
let workspace: Workspace
let grants: ChatGrants
let clock: TestClock
let logged: string[]
let servers: ControlPipe[]
let sockets: Socket[]
let issued: { token: string; grantId: string }

beforeEach(async () => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-control-')))
  repo = join(root, 'repo')
  mkdirSync(repo)
  clock = createTestClock('2026-04-01T09:00:00.000Z')
  workspace = openWorkspace({ repoRoot: repo, homeDir: join(root, 'home'), role: 'desktop', label: 'test', transport: 'desktop', clock, git: createFakeGit({ branch: 'main', commit: 'b'.repeat(40), detached: false }) })
  await workspace.initializeRepository({ name: 'transport-test' })
  logged = []
  servers = []
  sockets = []
  grants = createChatGrants({
    workspaceFor: () => workspace,
    cliFor: () => ({ command: 'node', args: [], env: {} }),
    minutes: 60, log: (line) => logged.push(line),
  })
  const grant = await grants.issueChatCli(repo, { role: 'worker', allowSave: false, label: 'worker' })
  issued = { token: grant.cli.env['DM_SESSION_TOKEN']!, grantId: grant.grantId }
  grants.bindChatGrant(issued.grantId, { folder: repo, chatId: 'chat-one', generation: 'pty-one' })
})
afterEach(async () => {
  for (const socket of sockets) { socket.destroy() }
  await Promise.all(servers.map((server) => server.close()))
  grants.dispose()
  workspace.close()
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function endpoint(dispatch?: NamingDispatcher, timers?: FakeClock): Promise<ControlPipe> {
  const server = await createControlPipe({ authorize: (token) => grants.authorizeNaming(token), dispatch,
    ...(timers === undefined ? {} : { clock: { now: () => timers.now, after: (callback: () => void, ms: number) => timers.after(callback, ms) } }) })
  servers.push(server)
  return server
}
function wire(operation: NamingOperation = { op: 'name_chat', args: { title: 'Semantic label' } }, token = issued.token): Buffer {
  return Buffer.from(JSON.stringify({ version: 1, requestId: 'test-id', token, ...operation }) + '\n')
}
function raw(address: string, chunks: Buffer[], end = false): { socket: Socket; reply: Promise<NamingReply> } {
  const socket = createConnection(address)
  sockets.push(socket)
  const reply = new Promise<NamingReply>((resolve, reject) => {
    const received: Buffer[] = []
    socket.on('data', (chunk: Buffer) => received.push(chunk))
    socket.once('error', reject)
    socket.once('end', () => {
      try { resolve(JSON.parse(Buffer.concat(received).toString()) as NamingReply) } catch (error) { reject(error) }
    })
    socket.once('connect', () => {
      void (async () => {
        for (const chunk of chunks) { socket.write(chunk); await turn() }
        if (end) { socket.end() }
      })()
    })
  })
  // Attach a rejection observer immediately; assertions still await the original rejecting promise.
  void reply.catch(() => {})
  return { socket, reply }
}
const NAME = { op: 'name_chat', args: { title: 'Semantic label' } } as const

it('authenticates a real per-instance naming reply with a live usable worker grant', async () => {
  const server = await endpoint(() => ({ applied: true }))
  const client = createDesktopClient({ env: { DM_DESKTOP_PIPE: server.address, DM_SESSION_TOKEN: issued.token } })
  expect(await client.request({ op: 'name_chat', args: { title: 'Semantic label' } })).toMatchObject({ ok: true, data: { applied: true } })
  if (process.platform !== 'win32') {
    expect(statSync(server.address).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(server.address)).mode & 0o777).toBe(0o700)
  }
  const unavailable = await endpoint()
  expect(await raw(unavailable.address, [wire()]).reply).toMatchObject({ ok: false, error: { code: 'operation_unavailable' } })
})
it('decodes fragmented UTF-8 only after the complete raw-bounded frame arrives', async () => {
  const seen: NamingOperation[] = []
  const server = await endpoint((operation) => { seen.push(operation); return { applied: true } })
  const bytes = wire({ op: 'name_chat', args: { title: 'Repair \u732b display' } })
  const split = bytes.indexOf(Buffer.from('\u732b')) + 1
  expect(await raw(server.address, [bytes.subarray(0, split), bytes.subarray(split)]).reply).toMatchObject({ ok: true })
  expect(seen).toEqual([{ op: 'name_chat', args: { title: 'Repair \u732b display' } }])
  expect(JSON.stringify(seen)).not.toContain(issued.token)
})
it('rejects 4096+1 unterminated bytes before JSON parsing or authorization', async () => {
  const server = await endpoint()
  expect(await raw(server.address, [Buffer.alloc(NAMING_CONTROL.requestBytes + 1, 120)], false).reply).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
})
it.each([
  () => Buffer.from('{bad}\n'),
  () => Buffer.from([0xff, 10]),
  () => Buffer.concat([wire(), wire()]),
  () => Buffer.from(JSON.stringify({ version: 2, requestId: 'test-id', token: issued.token, op: 'name_chat', args: { title: 'Semantic label' } }) + '\n'),
  () => Buffer.from(JSON.stringify({ version: 1, requestId: 'test-id', token: issued.token, op: 'name_chat', args: { title: 'Semantic label' }, chatId: 'other' }) + '\n'),
  () => Buffer.from(JSON.stringify({ version: 1, requestId: 'test-id', token: issued.token, op: 'constructor', args: {} }) + '\n'),
  () => wire({ op: 'capture_pane', args: { pane: 'terminal', waitForLoad: true } } as unknown as NamingOperation),
  () => wire({ op: 'open_in_pane', args: { url: 'https://example.com', path: '/tmp/file' } } as unknown as NamingOperation),
  () => wire({ op: 'name_chat', args: { title: 'bad' + String.fromCharCode(0) } }),
  () => wire({ op: 'open_in_pane', args: { path: '/tmp/file', pane: 'browser' } } as unknown as NamingOperation)
])('rejects malformed, extra, versioned and unknown-field input without dispatch (%#)', async (input) => {
  const dispatch = vi.fn(() => ({ applied: true }))
  const server = await endpoint(dispatch)
  expect(await raw(server.address, [input()]).reply).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  expect(dispatch).not.toHaveBeenCalled()
})
it('cancels an active handler on a subsequent extra frame with no late publication', async () => {
  const held = gate<void>()
  const entered = gate<NamingOperationContext>()
  let published = false
  const server = await endpoint(async (_operation, context) => {
    entered.open(context)
    await held.promise
    context.publish(() => { published = true })
    return { applied: true }
  })
  const request = raw(server.address, [wire(NAME)], false)
  const context = await entered.promise
  request.socket.write(wire())
  expect(await request.reply).toMatchObject({ error: { code: 'invalid_request' } })
  expect(context.signal.aborted).toBe(true)
  held.open()
  await turn()
  expect(published).toBe(false)
})
it('bounds responses and sanitizes thrown token/raw-request text', async () => {
  let big = true
  const server = await endpoint(() => {
    if (big) { return 'x'.repeat(NAMING_CONTROL.responseBytes) }
    throw new Error(`secret ${issued.token} ${wire().toString()}`)
  })
  expect(await raw(server.address, [wire(NAME)]).reply).toMatchObject({ error: { code: 'internal_error' } })
  big = false
  const reply = await raw(server.address, [wire(NAME)]).reply
  expect(reply).toMatchObject({ error: { code: 'internal_error' } })
  expect(JSON.stringify(reply) + logged.join()).not.toContain(issued.token)
})
it('bounds 32 total open connections and the 2s incomplete-frame deadline', async () => {
  const timers = new FakeClock()
  const server = await endpoint(undefined, timers)
  const waiting = Array.from({ length: NAMING_CONTROL.connections }, () => raw(server.address, [Buffer.from('{')], false))
  await vi.waitFor(() => expect(timers.pending).toBe(NAMING_CONTROL.connections))
  expect(await raw(server.address, [wire()]).reply).toMatchObject({ error: { code: 'busy' } })
  timers.advance(NAMING_CONTROL.frameMs)
  expect(await Promise.all(waiting.map((request) => request.reply))).toEqual(Array.from({ length: NAMING_CONTROL.connections }, () => expect.objectContaining({ error: expect.objectContaining({ code: 'timeout' }) })))
  expect(timers.pending).toBe(0)
})
it('expires blocked-active plus eight queued metadata operations at admission deadlines, not dequeue', async () => {
  const timers = new FakeClock()
  const held = gate<void>()
  const entered = gate<NamingOperationContext>()
  let calls = 0
  let published = 0
  const server = await endpoint(async (_operation, context) => {
    calls += 1
    entered.open(context)
    await held.promise
    context.publish(() => { published += 1 })
    return { applied: true }
  }, timers)
  const active = raw(server.address, [wire(NAME)])
  const context = await entered.promise
  expect(context.deadline).toBe(NAMING_CONTROL.serverMs)
  const queued = Array.from({ length: 8 }, () => raw(server.address, [wire(NAME)]))
  await vi.waitFor(() => expect(timers.pending).toBe(18))
  expect(await raw(server.address, [wire(NAME)]).reply).toMatchObject({ error: { code: 'busy' } })
  timers.advance(NAMING_CONTROL.serverMs - 1)
  timers.advance(1)
  const replies = await Promise.all([active.reply, ...queued.map((request) => request.reply)])
  expect(replies.every((reply) => !reply.ok && reply.error.code === 'timeout')).toBe(true)
  expect(context.signal.aborted).toBe(true)
  held.open()
  await turn()
  expect([calls, published, timers.pending]).toEqual([1, 0, 0])
})
it('passes only remaining queue-inclusive budget to a dequeued handler ', async () => {
  const timers = new FakeClock()
  const held = gate<void>()
  const entered = gate<void>()
  const seen: NamingOperationContext[] = []
  const server = await endpoint(async (_operation, context) => {
    seen.push(context)
    if (seen.length === 1) { entered.open(); await held.promise }
    return { applied: true }
  }, timers)
  const active = raw(server.address, [wire(NAME)])
  await entered.promise
  timers.advance(2_000)
  const queued = raw(server.address, [wire(NAME)])
  await vi.waitFor(() => expect(timers.pending).toBe(4))
  timers.advance(17_000)
  held.open()
  expect(await active.reply).toMatchObject({ ok: true })
  expect(await queued.reply).toMatchObject({ ok: true })
  expect(seen[1]!.deadline).toBe(22_000)
  expect(seen[1]!.remainingMs()).toBe(3_000)
})
it('treats a caller half-close as cancellation rather than authorizing detached work', async () => {
  const held = gate<void>()
  let context: NamingOperationContext | undefined
  let published = false
  const server = await endpoint(async (_operation, current) => { context = current; await held.promise; current.publish(() => { published = true }); return { applied: true } })
  const pending = raw(server.address, [wire(NAME)], true)
  // Windows named-pipe EOF may also close its read side, so a cancellation reply is not guaranteed.
  const reply = await pending.reply.catch(() => null)
  expect(reply === null || (!reply.ok && reply.error.code === 'cancelled')).toBe(true)
  await vi.waitFor(() => expect(context?.signal.aborted).toBe(true))
  held.open()
  await turn()
  expect(published).toBe(false)
})
it('removes disconnected queued work immediately and never invokes it', async () => {
  const timers = new FakeClock()
  const held = gate<void>()
  const entered = gate<void>()
  let calls = 0
  const server = await endpoint(async () => { calls += 1; entered.open(); await held.promise; return { applied: true } }, timers)
  const active = raw(server.address, [wire(NAME)])
  await entered.promise
  const disconnected = createConnection(server.address)
  sockets.push(disconnected)
  await new Promise<void>((resolve) => disconnected.once('connect', resolve))
  disconnected.write(wire(NAME))
  await vi.waitFor(() => expect(timers.pending).toBe(4))
  disconnected.destroy()
  await vi.waitFor(() => expect(timers.pending).toBe(2))
  held.open()
  expect(await active.reply).toMatchObject({ ok: true })
  await turn()
  expect(calls).toBe(1)
})
it('cancels disconnected active work before final metadata publication', async () => {
  const held = gate<void>()
  const entered = gate<NamingOperationContext>()
  let published = false
  const server = await endpoint(async (_operation, context) => {
    entered.open(context)
    await held.promise
    context.publish(() => { published = true })
    return { applied: true }
  })
  const socket = createConnection(server.address)
  sockets.push(socket)
  await new Promise<void>((resolve) => socket.once('connect', resolve))
  socket.write(wire(NAME))
  const context = await entered.promise
  socket.destroy()
  await vi.waitFor(() => expect(context.signal.aborted).toBe(true))
  held.open()
  await turn()
  expect(published).toBe(false)
})

describe('live database authority over real sockets', () => {
  it('denies a currently usable grant that lost chat.name, even to raw callers', async () => {
    workspace.ctx().db.run('UPDATE grants SET role = ? WHERE id = ?', 'reader', issued.grantId)
    const server = await endpoint()
    expect(await raw(server.address, [wire()]).reply).toMatchObject({ error: { code: 'unauthorized' } })
  })
  it.each(['manual revoke', 'expiry', 'machine', 'exit'] as const)('denies %s while the PTY binding exists and blocks final publication', async (reason) => {
    const held = gate<void>()
    const entered = gate<NamingOperationContext>()
    let published = false
    const server = await endpoint(async (_operation, context) => {
      entered.open(context)
      await held.promise
      context.publish(() => { published = true })
      return { applied: true }
    })
    const pending = raw(server.address, [wire(NAME)])
    const context = await entered.promise
    if (reason === 'manual revoke') { await workspace.revokeGrant({ grantId: issued.grantId }) }
    if (reason === 'expiry') { clock.advanceSeconds(3601) }
    if (reason === 'machine') { workspace.ctx().db.run('UPDATE grants SET machine_id = ? WHERE id = ?', 'other-machine', issued.grantId) }
    if (reason === 'exit') { void grants.revokeChatGrant(issued.grantId) }
    expect(() => context.publish(() => { published = true })).toThrow()
    expect(await raw(server.address, [wire()]).reply).toMatchObject({ error: { code: 'unauthorized' } })
    await vi.waitFor(() => expect(context.signal.aborted).toBe(true))
    held.open()
    expect(await pending.reply).toMatchObject({ ok: false })
    expect(published).toBe(false)
  })
})
describe('instance and generation isolation over real sockets', () => {
  it('rejects unbound/historical, wrong-instance, wrong-repo and replaced-generation authority', async () => {
    const server = await endpoint()
    const historical = await grants.issueChatCli(repo, { role: 'worker', allowSave: false, label: 'not spawned' })
    expect(await raw(server.address, [wire(undefined, historical.cli.env['DM_SESSION_TOKEN']!)]).reply).toMatchObject({ error: { code: 'unauthorized' } })
    const otherRepo = join(root, 'other')
    mkdirSync(otherRepo)
    expect(() => grants.bindChatGrant(historical.grantId, { folder: otherRepo, chatId: 'chat-one', generation: 'wrong' })).toThrow()
    const foreign = await workspace.issueGrant({ role: 'reader', label: 'not app-issued' })
    expect(await raw(server.address, [wire(undefined, foreign.token)]).reply).toMatchObject({ error: { code: 'unauthorized' } })
    grants.bindChatGrant(historical.grantId, { folder: repo, chatId: 'chat-one', generation: 'pty-two' })
    expect(await raw(server.address, [wire()]).reply).toMatchObject({ error: { code: 'unauthorized' } })
    expect(await raw(server.address, [wire(undefined, historical.cli.env['DM_SESSION_TOKEN']!)]).reply).toMatchObject({ error: { code: 'operation_unavailable' } })
    grants.dispose()
    expect(await raw(server.address, [wire(undefined, historical.cli.env['DM_SESSION_TOKEN']!)]).reply).toMatchObject({ error: { code: 'unauthorized' } })
  })
  it('rejects an old app token on a newly started instance even while its database grant remains usable', async () => {
    const replacement = createChatGrants({
      workspaceFor: () => workspace, cliFor: () => ({ command: 'node', args: [], env: {} }),
      minutes: 60, log: (line) => logged.push(line)
    })
    const server = await createControlPipe({ authorize: (token) => replacement.authorizeNaming(token) })
    servers.push(server)
    expect((await workspace.listGrants()).find((grant) => grant.id === issued.grantId)?.active).toBe(true)
    expect(await raw(server.address, [wire()]).reply).toMatchObject({ error: { code: 'unauthorized' } })
    replacement.dispose()
  })
  it('invalidates before a failing asynchronous revoke, without echoing the exception secret', async () => {
    let fail: (error: Error) => void = () => {}
    const revoke = new Promise<never>((_resolve, reject) => { fail = reject })
    vi.spyOn(workspace, 'revokeGrant').mockImplementation(() => revoke)
    const server = await endpoint()
    const revoking = grants.revokeChatGrant(issued.grantId)
    expect(await raw(server.address, [wire()]).reply).toMatchObject({ error: { code: 'unauthorized' } })
    fail(new Error(`database failure includes ${issued.token}`))
    await revoking
    expect((await workspace.listGrants()).find((grant) => grant.id === issued.grantId)?.active).toBe(true)
    expect(logged).toHaveLength(1)
    expect(logged.join()).not.toContain(issued.token)
  })
})
it('cancels shutdown work, cleans timers/listeners and closes the real endpoint', async () => {
  const timers = new FakeClock()
  const entered = gate<NamingOperationContext>()
  const held = gate<void>()
  let published = false
  const server = await endpoint(async (_operation, context) => { entered.open(context); await held.promise; context.publish(() => { published = true }); return { applied: true } }, timers)
  const request = raw(server.address, [wire(NAME)])
  const context = await entered.promise
  await server.close()
  expect(await request.reply).toMatchObject({ error: { code: 'cancelled' } })
  expect([context.signal.aborted, timers.pending]).toEqual([true, 0])
  held.open()
  await turn()
  expect(published).toBe(false)
  const client = createDesktopClient({ env: { DM_DESKTOP_PIPE: server.address, DM_SESSION_TOKEN: issued.token } })
  expect(await client.request({ op: 'name_chat', args: { title: 'Semantic label' } })).toMatchObject({ error: { code: 'desktop_unavailable' } })
})

describe('hostile handler output containment over real sockets', () => {
  it('rejects an unrecognized thrown error code without leaking its attacker-controlled fields', async () => {
    const server = await endpoint(() => { throw Object.assign(new Error(`private ${issued.token}`), { code: `forged-${issued.token}` }) })
    const reply = await raw(server.address, [wire(NAME)]).reply
    expect(reply).toMatchObject({ ok: false, error: { code: 'internal_error' } })
    expect(JSON.stringify(reply) + logged.join()).not.toContain(issued.token)
  })

  it.each(['cycle', 'bigint'] as const)('contains an unserializable %s response and releases the chat lane', async (kind) => {
    const server = await endpoint(() => {
      if (kind === 'bigint') return { private: issued.token, value: 1n }
      const value: { private: string; self?: unknown } = { private: issued.token }
      value.self = value
      return value
    })
    const reply = await raw(server.address, [wire(NAME)]).reply
    expect(reply).toMatchObject({ ok: false, error: { code: 'internal_error' } })
    expect(JSON.stringify(reply) + logged.join()).not.toContain(issued.token)
  })
})

it('refuses EOF before a complete frame without dispatching and keeps the endpoint usable', async () => {
  const dispatch = vi.fn(() => { throw new Error('incomplete input reached handler') })
  const server = await endpoint(dispatch)
  const reply = await raw(server.address, [Buffer.from('{"version":1')], true).reply.catch(() => null)
  // Named-pipe EOF can also close the caller read side, as with active cancellation.
  if (reply !== null) expect(reply).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  expect(dispatch).not.toHaveBeenCalled()
})

it('retires cooperative active work and queued mutations while shutdown also closes an incomplete caller', async () => {
  const timers = new FakeClock()
  const entered = gate<NamingOperationContext>()
  let queuedEntered = false
  let published = false
  let activeEntered = false
  const server = await endpoint(async (_operation, context) => {
    if (activeEntered) queuedEntered = true
    activeEntered = true
    entered.open(context)
    const cancelled = gate<void>()
    context.signal.addEventListener('abort', () => cancelled.open(), { once: true })
    await cancelled.promise
    context.publish(() => { published = true })
    return { applied: true }
  }, timers)
  const active = raw(server.address, [wire(NAME)])
  const context = await entered.promise
  const queued = raw(server.address, [wire(NAME)])
  const incomplete = createConnection(server.address)
  sockets.push(incomplete)
  const incompleteClosed = gate<void>()
  const connected = gate<void>()
  incomplete.once('close', () => incompleteClosed.open())
  incomplete.once('connect', () => connected.open())
  await connected.promise
  incomplete.write('{')
  await vi.waitFor(() => expect(timers.pending).toBe(5))
  const closing = server.close()
  expect(context.signal.aborted).toBe(true)
  expect(await active.reply).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  expect(await queued.reply).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  await Promise.all([closing, incompleteClosed.promise])
  expect(queuedEntered).toBe(false)
  expect(published).toBe(false)
  expect(timers.pending).toBe(0)
})

it('preserves a recognized application error code without exposing its private message', async () => {
  const server = await endpoint(() => { throw new DomainError('not_found', `private ${issued.token}`) })
  const reply = await raw(server.address, [wire(NAME)]).reply
  expect(reply).toMatchObject({ ok: false, error: { code: 'not_found' } })
  expect(JSON.stringify(reply) + logged.join()).not.toContain(issued.token)
})

it.each([null, 'private foreign rejection'])('contains a non-Error handler rejection and keeps subsequent requests usable (%j)', async (rejection) => {
  let reject = true
  const server = await endpoint(() => {
    if (reject) { throw rejection }
    return { applied: true }
  })
  expect(await raw(server.address, [wire(NAME)]).reply).toMatchObject({ ok: false, error: { code: 'internal_error' } })
  reject = false
  expect(await raw(server.address, [wire(NAME)]).reply).toMatchObject({ ok: true, data: { applied: true } })
})
