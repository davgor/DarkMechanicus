import { renameSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatRef } from '../agents/chatStore'
import { agentChatRig, filesUnder } from './__mocks__/agentChatRig'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
function rig(kind: 'claude' | 'omp' = 'claude', overrides: Parameters<typeof agentChatRig>[1] = {}) {
  const value = agentChatRig(kind, overrides)
  cleanups.push(value.cleanup)
  return value
}
async function eventually(check: () => boolean) {
  // Real child stdout/exit delivery cannot be advanced by a fake timer; only manager watches use a fake clock.
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Expected session condition was not reached within 3 seconds.')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
function turn(child: { write(line: string): boolean }, kind: 'claude' | 'omp', text: string) {
  expect(child.write(JSON.stringify(kind === 'claude'
    ? { type: 'user', message: { role: 'user', content: text } }
    : { type: 'prompt', id: `test-${text}`, message: text }))).toBe(true)
}

for (const kind of ['claude', 'omp'] as const) describe(`${kind} native GUI lifecycle`, () => {
  it('persists and pushes a text turn in order and submits the kickoff only once', async () => {
    const r = rig(kind), chat = r.newChat('[text]')
    await r.sessions.start(chat)
    await eventually(() => r.sessions.snapshot(chat).items.some(item => item.kind === 'assistant_text'))
    const persisted = r.store.readTranscript(chat)!.items
    expect(persisted[0]).toMatchObject({ kind: 'user_message', text: '[text]' })
    expect(r.pushes.filter(event => event.type === 'item').map(event => event.item)).toEqual(persisted)
    expect(r.pushes.some(event => event.type === 'delta')).toBe(true)
    expect(r.store.getChat(chat)).toMatchObject({ kickoffSent: true, firstPromptDelivery: 'submitted' })
    expect(r.steps).toEqual(['auth', 'issue', 'spawn', 'bind'])
    expect(r.bound).toEqual(['grant-1'])
    expect(r.writes.some(line => line.includes(kind === 'claude' ? 'initialize' : 'get_state'))).toBe(true)
    await r.sessions.start(chat)
    expect(r.children).toHaveLength(1)
    await r.sessions.stop(chat)
    await r.sessions.start(chat)
    expect(r.writes.filter(line => JSON.parse(line).type === (kind === 'claude' ? 'user' : 'prompt'))).toHaveLength(1)
    expect(r.sessions.snapshot(chat).todos).toEqual([])
  })

  it('prefers the routing firstMessage over the saved first prompt', async () => {
    const r = rig(kind), chat = r.newChat('saved')
    await r.sessions.start(chat, { firstMessage: '[text] routed' })
    expect(r.store.readTranscript(chat)!.items[0]).toMatchObject({ text: '[text] routed' })
  })

  it('stops signed-out starts before grant issuance or spawning', async () => {
    const r = rig(kind), chat = r.newChat()
    r.state.signedOut = true
    expect(await r.sessions.start(chat)).toMatchObject({ status: 'signed_out' })
    expect(r.children).toHaveLength(0)
    expect(r.state.grantCount).toBe(0)
  })

  it('refuses a folder moved during authentication before spawning', async () => {
    const r = rig(kind), chat = r.newChat()
    r.deps.checkAuth = async () => {
      renameSync(r.repo, join(r.root, 'moved'))
      return { state: 'signed_in', reason: 'Signed in.' }
    }
    expect(await r.sessions.start(chat)).toMatchObject({ status: 'failed' })
    expect(r.children).toHaveLength(0)
    expect(r.state.grantCount).toBe(0)
  })

  it('refuses terminal ownership without checking authentication', async () => {
    const r = rig(kind), chat = r.newChat()
    r.state.terminalLive = true
    expect(await r.sessions.start(chat)).toEqual({ code: 'busy_elsewhere' })
    expect(r.steps).toEqual([])
  })
})

for (const kind of ['claude', 'omp'] as const) describe(`${kind} native GUI shutdown and secrets`, () => {

  it('renews hourly, watches the folder each minute, and releases keep-awake once', async () => {
    const r = rig(kind), chat = r.newChat()
    await r.sessions.start(chat)
    expect(r.state.awake).toBe(1)
    r.tick(3_600_000)
    await eventually(() => r.renewed.length === 1)
    expect(r.renewed).toEqual(['grant-1'])
    expect(r.sessions.isLive(chat)).toBe(true)
    r.state.tracked = false
    r.tick(60_000)
    await eventually(() => r.revoked.length === 1)
    expect(r.state.awake).toBe(0)
    await r.sessions.dispose()
    expect(r.state.awake).toBe(0)
    expect(r.revoked).toEqual(['grant-1'])
  })

  it('revokes on exit and dispose leaves the real child dead within five seconds', async () => {
    const r = rig(kind), chat = r.newChat()
    await r.sessions.start(chat)
    turn(r.children[0], kind, '[crash]')
    await eventually(() => r.sessions.snapshot(chat).status === 'failed')
    expect(r.revoked).toEqual(['grant-1'])
    await r.sessions.start(chat)
    const pid = r.children[1].pid!
    expect(() => process.kill(pid, 0)).not.toThrow()
    const started = Date.now()
    await r.sessions.dispose()
    expect(Date.now() - started).toBeLessThan(5000)
    expect(() => process.kill(pid, 0)).toThrow()
    expect(r.revoked).toEqual(['grant-1', 'grant-2'])
  })

  it('never stores or pushes the session token', async () => {
    const r = rig(kind), chat = r.newChat('[leak]')
    await r.sessions.start(chat)
    await eventually(() => r.sessions.snapshot(chat).items.some(item => item.kind === 'tool_call' && item.status === 'completed'))
    turn(r.children[0], kind, '[crash]')
    await eventually(() => r.sessions.snapshot(chat).status === 'failed')
    const lines = filesUnder(r.userData).flatMap(file => file.split(/\r?\n/))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line).not.toContain(r.token)
    for (const event of r.pushes) expect(JSON.stringify(event)).not.toContain(r.token)
    const exit = r.pushes.filter(event => event.type === 'status' && event.status === 'failed').at(-1)
    expect(exit).toMatchObject({ type: 'status', detail: expect.stringContaining('fake-agent crash') })
    expect(JSON.stringify(r.sessions.snapshot(chat))).not.toContain(r.token)
  })
})

for (const kind of ['claude', 'omp'] as const) describe(`${kind} native GUI ephemeral state and deletion`, () => {

  it('keeps the latest per-thread todos only in memory, retains on exit and resets on restart', async () => {
    const r = rig(kind), chat = r.newChat('[todo]')
    await r.sessions.start(chat)
    await eventually(() => r.pushes.some(event => event.type === 'todos' && event.phases.length > 0))
    await eventually(() => r.sessions.snapshot(chat).status === 'idle')
    const latest = new Map()
    for (const event of r.pushes) if (event.type === 'todos') {
      if (event.phases.length) latest.set(event.threadId, event.phases)
      else latest.delete(event.threadId)
    }
    const todos = [...latest].map(([threadId, phases]) => ({ threadId, phases }))
    expect(r.sessions.snapshot(chat).todos).toEqual(todos)
    for (const file of filesUnder(r.userData)) {
      expect(file).not.toContain('"type":"todos"')
      expect(file).not.toContain('"phases"')
    }
    await r.sessions.stop(chat)
    expect(r.sessions.snapshot(chat).todos).toEqual(todos)
    await r.sessions.start(chat)
    expect(r.sessions.snapshot(chat).todos).toEqual([])
  })

  it('deletes only after the process is dead and its grant is revoked', async () => {
    const r = rig(kind), chat = r.newChat()
    await r.sessions.start(chat)
    const pid = r.children[0].pid!
    await r.sessions.deleteChat(chat)
    expect(r.store.getChat(chat)).toBeNull()
    expect(() => process.kill(pid, 0)).toThrow()
    expect(r.revoked).toEqual(['grant-1'])
  })
})

it('cancels a held auth check without delaying dispose', async () => {
  const r = rig('claude', { checkAuth: () => new Promise(() => undefined) })
  const chat = r.newChat()
  const start = r.sessions.start(chat)
  await r.sessions.dispose()
  expect(await start).toMatchObject({ status: 'failed' })
  expect(r.children).toHaveLength(0)
})

it('revokes an issued grant when post-spawn binding fails', async () => {
  const r = rig('claude', { bindChatGrant: () => { throw new Error('binding failed') } })
  const chat = r.newChat()
  expect(await r.sessions.start(chat)).toMatchObject({ status: 'failed' })
  expect(r.revoked).toEqual(['grant-1'])
  expect(() => process.kill(r.children[0].pid!, 0)).toThrow()
})

it('pauses an orchestrator run when its exited agent has signed out', async () => {
  const r = rig(), chat = r.store.createChat({ folder: r.repo, agent: 'claude', role: 'orchestrator', allowSave: false, model: null, runId: 'run-test' })
  await r.sessions.start(chat)
  r.state.signedOut = true
  turn(r.children[0], 'claude', '[crash]')
  await eventually(() => r.state.pauses.length === 1)
  expect(r.state.pauses).toHaveLength(1)
})

it('uses reach grants and a scratch cwd for project-less chats', async () => {
  const r = rig(), chat: ChatRef = r.newChat('[text]', null)
  await r.sessions.start(chat)
  expect(r.bound).toEqual(['grant-1'])
  await r.sessions.stop(chat)
  expect(r.revoked).toEqual(['grant-1'])
})
