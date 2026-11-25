import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { agentChatState, reduceAgentChat } from './agentChatModel'
import { removeScratch } from '../../../test/removeScratch'
import { createChatStore } from '../../../main/agents/chatStore'
import { createAgentChatSessions } from '../../../main/agentChat/agentChatSessions'
import { startAgentProcess, type AgentProcess, type AgentProcessExit } from '../../../main/agentChat/agentProcess'
import { agentChatRig } from '../../../main/agentChat/__mocks__/agentChatRig'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function gate<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function eventually(check: () => boolean) {
  // Native child delivery uses real I/O; only lifecycle renewal/folder timers are faked.
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Native lifecycle condition did not arrive within 3 seconds.')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
function controlledClose() {
  const release = gate<void>(), observed = gate<AgentProcessExit>(), stopped = gate<void>()
  const children: AgentProcess[] = []
  const start: typeof startAgentProcess = spec => {
    const child = startAgentProcess(spec)
    children.push(child)
    return { pid: child.pid, write: line => child.write(line), onLine: listener => child.onLine(listener),
      onStderr: listener => child.onStderr(listener),
      onExit: listener => child.onExit(exit => { observed.resolve(exit); void release.promise.then(() => listener(exit)) }),
      stop: async () => { await child.stop(); stopped.resolve() } }
  }
  return { start, children, release, observed, stopped }
}

it('retains OMP responses across process restarts and a reopened store in the real renderer reducer', async () => {
  const r = agentChatRig('omp'), chat = r.newChat('[text]')
  cleanups.push(r.cleanup)
  let view = agentChatState()
  const originalPush = r.deps.push
  r.deps.push = event => { originalPush(event); view = reduceAgentChat(view, event) }
  await r.sessions.start(chat)
  await eventually(() => view.items.filter(item => item.kind === 'assistant_text').length === 1)
  await r.sessions.stop(chat)
  await r.sessions.start(chat)
  r.children[1].write(JSON.stringify({ type: 'prompt', id: 'second-turn', message: '[text]' }))
  await eventually(() => view.items.filter(item => item.kind === 'assistant_text').length === 2)
  await r.sessions.dispose()
  const store = createChatStore({ root: join(r.userData, 'agents', 'chats') })
  const reopened = createAgentChatSessions({ ...r.deps, store })
  cleanups.push(() => reopened.dispose())
  view = agentChatState(reopened.snapshot(chat))
  await reopened.start(chat)
  r.children[2].write(JSON.stringify({ type: 'prompt', id: 'third-turn', message: '[text]' }))
  await eventually(() => view.items.filter(item => item.kind === 'assistant_text').length === 3)
  const items = store.readTranscript(chat)!.items.filter(item => item.kind === 'assistant_text')
  expect(items).toHaveLength(3)
  expect(new Set(items.map(item => item.id)).size).toBe(3)
  expect(view.items.filter(item => item.kind === 'assistant_text')).toEqual(items)
  const ids = new Set(items.map(item => item.id))
  for (const event of r.pushes) if (event.type === 'delta' && event.kind === 'text') expect(ids.has(event.itemId)).toBe(true)
  expect(view.streaming.size).toBe(0)
})

it('reserves one restart while the previous grant revocation is held', async () => {
  const revoke = gate<void>(), entered = gate<void>(), revoked: string[] = []
  const r = agentChatRig('claude', { revokeChatGrant: async id => {
    if (id === 'grant-1') { entered.resolve(); await revoke.promise }
    revoked.push(id)
  } })
  cleanups.push(async () => { revoke.resolve(); await r.cleanup() })
  const chat = r.newChat()
  await r.sessions.start(chat)
  const stop = r.sessions.stop(chat)
  await entered.promise
  const starts = [r.sessions.start(chat), r.sessions.start(chat), r.sessions.start(chat)]
  expect(r.state.grantCount).toBe(1)
  revoke.resolve()
  await stop
  await Promise.all(starts)
  expect(r.state.grantCount).toBe(2)
  expect(r.children).toHaveLength(2)
  expect(r.bound).toEqual(['grant-1', 'grant-2'])
  expect(revoked).toEqual(['grant-1'])
  await r.sessions.dispose()
  expect(revoked).toEqual(['grant-1', 'grant-2'])
  for (const child of r.children) expect(() => process.kill(child.pid!, 0)).toThrow()
})

it.each(['stop', 'deleteChat', 'dispose'] as const)('%s waits separately for close notification and grant revocation', async operation => {
  const close = controlledClose(), revoke = gate<void>(), revoked: string[] = []
  const r = agentChatRig('claude', { startProcess: close.start, revokeChatGrant: async id => {
    await revoke.promise; revoked.push(id)
  } })
  cleanups.push(async () => { close.release.resolve(); revoke.resolve(); await r.cleanup() })
  const chat = r.newChat()
  await r.sessions.start(chat)
  let settled = false
  const ending = (operation === 'dispose' ? r.sessions.dispose() : r.sessions[operation](chat)).then(() => { settled = true })
  await close.stopped.promise
  await close.observed.promise
  await new Promise(setImmediate)
  expect(settled).toBe(false)
  expect(revoked).toEqual([])
  revoke.resolve()
  await eventually(() => revoked.length === 1)
  expect(settled).toBe(false)
  expect(r.store.getChat(chat)).not.toBeNull()
  close.release.resolve()
  await ending
  expect(() => process.kill(close.children[0].pid!, 0)).toThrow()
  expect(revoked).toEqual(['grant-1'])
  if (operation === 'deleteChat') expect(r.store.getChat(chat)).toBeNull()
})

it('rejects disposal at its five-second deadline when no close notification arrives, without claiming cleanup', async () => {
  const close = controlledClose(), r = agentChatRig('claude', { startProcess: close.start })
  const chat = r.newChat()
  cleanups.push(async () => { close.release.resolve(); await r.sessions.dispose().catch(() => undefined); removeScratch(r.root) })
  await r.sessions.start(chat)
  const ending = r.sessions.dispose()
  await expect(ending).rejects.toThrow('shutdown did not complete within 5 seconds')
  expect(r.revoked).toEqual(['grant-1'])
  expect(r.sessions.isLive(chat)).toBe(true)
  expect(r.store.getChat(chat)).not.toBeNull()
  expect(() => process.kill(close.children[0].pid!, 0)).toThrow()
  close.release.resolve()
  await eventually(() => !r.sessions.isLive(chat))
})

it('settles rejected Claude initialization while the native CLI remains alive until stopped', async () => {
  const r = agentChatRig(), chat = r.newChat('must not send')
  cleanups.push(r.cleanup)
  r.env.FAKE_AGENT_INITIALIZE_ERROR = '1'
  expect(await r.sessions.start(chat)).toMatchObject({ status: 'failed' })
  expect(r.store.readTranscript(chat)!.items).toEqual([expect.objectContaining({ kind: 'error', message: 'Fake initialization rejected.' })])
  expect(r.writes.some(line => JSON.parse(line).type === 'user')).toBe(false)
  expect(r.revoked).toEqual(['grant-1'])
  expect(r.sessions.isLive(chat)).toBe(false)
  expect(() => process.kill(r.children[0].pid!, 0)).toThrow()
})

it.each(['claude', 'omp'] as const)('%s removes actionable prompts from the real reducer on stop and independent exit', async kind => {
  const r = agentChatRig(kind), chat = r.newChat('[approval]')
  cleanups.push(r.cleanup)
  let view = agentChatState()
  const push = r.deps.push
  r.deps.push = event => { push(event); view = reduceAgentChat(view, event) }
  await r.sessions.start(chat)
  await eventually(() => view.pending !== null)
  await r.sessions.stop(chat)
  expect(view.pending).toBeNull()
  expect(r.sessions.snapshot(chat).pending).toBeNull()
  await r.sessions.start(chat)
  r.children[1].write(JSON.stringify(kind === 'claude'
    ? { type: 'user', message: { role: 'user', content: '[approval]' } }
    : { type: 'prompt', id: 'approval-again', message: '[approval]' }))
  await eventually(() => view.pending !== null)
  await r.children[1].stop()
  await eventually(() => view.status === 'exited')
  expect(view.pending).toBeNull()
  expect(r.sessions.snapshot(chat).pending).toBeNull()
  expect(r.pushes.filter(event => event.type === 'pending' && event.prompt === null).length).toBeGreaterThanOrEqual(2)
})

it('recovers later stop, single-owner restart and deletion only after late close and revocation', async () => {
  const close = controlledClose(), releaseGrant = gate<void>(), revoked: string[] = []
  const r = agentChatRig('claude', { startProcess: close.start, revokeChatGrant: async id => {
    if (id === 'grant-1') await releaseGrant.promise
    revoked.push(id)
  } })
  cleanups.push(async () => { close.release.resolve(); releaseGrant.resolve(); await r.cleanup() })
  const chat = r.newChat()
  await r.sessions.start(chat)
  const original = r.sessions.stop(chat)
  const failure: unknown = await original.catch(error => error)
  expect(failure).toBeInstanceOf(Error)
  await expect(original).rejects.toThrow('shutdown did not complete within 5 seconds')
  expect(r.sessions.isLive(chat)).toBe(true)
  close.release.resolve()
  await close.observed.promise
  await expect(r.sessions.stop(chat)).rejects.toBe(failure)
  expect(revoked).toEqual([])
  releaseGrant.resolve()
  await eventually(() => !r.sessions.isLive(chat))
  await expect(r.sessions.stop(chat)).resolves.toBeUndefined()
  await Promise.all([r.sessions.start(chat), r.sessions.start(chat)])
  expect(close.children).toHaveLength(2)
  expect(r.bound).toEqual(['grant-1', 'grant-2'])
  expect(revoked).toEqual(['grant-1'])
  await r.sessions.deleteChat(chat)
  expect(r.store.getChat(chat)).toBeNull()
  expect(revoked).toEqual(['grant-1', 'grant-2'])
  for (const child of close.children) expect(() => process.kill(child.pid!, 0)).toThrow()
  await expect(original).rejects.toBe(failure)
  expect(r.pushes.some(event => event.type === 'status' && event.status === 'failed' && event.detail?.includes('5 seconds'))).toBe(true)
})

it('allows a later explicit disposal after late cleanup without reopening the manager', async () => {
  const close = controlledClose(), releaseGrant = gate<void>(), revoked: string[] = []
  const r = agentChatRig('claude', { startProcess: close.start, revokeChatGrant: async id => {
    await releaseGrant.promise; revoked.push(id)
  } })
  cleanups.push(async () => { close.release.resolve(); releaseGrant.resolve(); await r.cleanup() })
  const chat = r.newChat()
  await r.sessions.start(chat)
  const original = r.sessions.dispose()
  const failure: unknown = await original.catch(error => error)
  await expect(original).rejects.toThrow('shutdown did not complete within 5 seconds')
  await expect(r.sessions.start(chat)).rejects.toThrow('The chat is stopping.')
  close.release.resolve()
  releaseGrant.resolve()
  await eventually(() => !r.sessions.isLive(chat))
  await expect(r.sessions.dispose()).resolves.toBeUndefined()
  await expect(original).rejects.toBe(failure)
  await expect(r.sessions.start(chat)).rejects.toThrow('The chat is stopping.')
  expect(close.children).toHaveLength(1)
  expect(revoked).toEqual(['grant-1'])
  expect(() => process.kill(close.children[0].pid!, 0)).toThrow()
})

it('does not recover ownership or deletion when grant revocation failed despite confirmed close', async () => {
  const close = controlledClose(), failure = new Error('Grant revocation failed')
  let revocations = 0
  const r = agentChatRig('claude', { startProcess: close.start, revokeChatGrant: async () => {
    revocations++; throw failure
  } })
  cleanups.push(async () => { close.release.resolve(); await close.children[0].stop(); await r.sessions.dispose().catch(() => undefined); removeScratch(r.root) })
  const chat = r.newChat()
  await r.sessions.start(chat)
  await expect(r.sessions.stop(chat)).rejects.toBe(failure)
  await close.observed.promise
  close.release.resolve()
  await new Promise(setImmediate)
  await expect(r.sessions.stop(chat)).rejects.toBe(failure)
  expect(await r.sessions.start(chat)).toMatchObject({ status: 'failed' })
  await expect(r.sessions.deleteChat(chat)).rejects.toBe(failure)
  await expect(r.sessions.dispose()).rejects.toBe(failure)
  expect(r.store.getChat(chat)).not.toBeNull()
  expect(close.children).toHaveLength(1)
  expect(revocations).toBe(1)
})
