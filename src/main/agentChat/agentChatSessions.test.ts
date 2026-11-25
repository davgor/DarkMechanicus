import { readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatRef } from '../agents/chatStore'
import { agentChatRig, filesUnder } from './__mocks__/agentChatRig'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
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

for (const kind of ['claude', 'omp'] as const) describe(`${kind} native GUI input`, () => {
  it('echoes each accepted write immediately and persists two distinct assistant turns', async () => {
    const r = rig(kind), chat = r.newChat()
    await r.sessions.send(chat, { text: '[text] first' })
    expect(r.store.readTranscript(chat)!.items[0]).toMatchObject({ kind: 'user_message', text: '[text] first' })
    expect(r.pushes.find(event => event.type === 'item')).toMatchObject({ item: { kind: 'user_message', text: '[text] first' } })
    await eventually(() => r.sessions.snapshot(chat).status === 'idle')
    await r.sessions.send(chat, { text: '[text] second' })
    await eventually(() => r.sessions.snapshot(chat).status === 'idle')
    const items = r.store.readTranscript(chat)!.items
    const responses = items.filter(item => item.kind === 'assistant_text')
    expect(responses).toHaveLength(2)
    expect(new Set(responses.map(item => item.id)).size).toBe(2)
    expect(items.filter(item => item.kind === 'user_message').map(item => item.text)).toEqual(['[text] first', '[text] second'])
    expect(r.children).toHaveLength(1)
  })

  it('queues a write during slow work and consumes its count only when the next turn starts', async () => {
    const r = rig(kind), chat = r.newChat()
    await r.sessions.send(chat, { text: '[slow]' })
    await r.sessions.send(chat, { text: '[text] queued' })
    await eventually(() => r.sessions.snapshot(chat).queued === 1)
    expect(r.store.readTranscript(chat)!.items.filter(item => item.kind === 'user_message')).toHaveLength(2)
    const inputs = r.writes.map(line => JSON.parse(line)).filter(frame => ['user', 'prompt', 'follow_up'].includes(frame.type))
    expect(inputs.map(frame => frame.type)).toEqual(kind === 'claude' ? ['user', 'user'] : ['prompt', 'follow_up'])
    await eventually(() => r.sessions.snapshot(chat).status === 'idle' && r.sessions.snapshot(chat).items.filter(item => item.kind === 'assistant_text').length === 2)
    expect(r.pushes.filter(event => event.type === 'queued').map(event => event.count)).toEqual([1, 0])
    expect(r.sessions.snapshot(chat).queued).toBe(0)
  })
})

it('consumes a queued Claude error-only turn before accepting a subsequent successful send', async () => {
  const r = rig('claude'), chat = r.newChat()
  await r.sessions.send(chat, { text: '[slow]' })
  await r.sessions.send(chat, { text: '[error]' })
  expect(r.sessions.snapshot(chat).queued).toBe(1)
  expect(r.store.readTranscript(chat)!.items.filter(item => item.kind === 'user_message').map(item => item.text)).toEqual(['[slow]', '[error]'])
  await eventually(() => r.sessions.snapshot(chat).status === 'idle' && r.sessions.snapshot(chat).items.some(item => item.kind === 'error'))
  expect(r.sessions.snapshot(chat).queued).toBe(0)
  expect(r.pushes.filter(event => event.type === 'queued').map(event => event.count)).toEqual([1, 0])
  expect(r.store.readTranscript(chat)!.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'error', message: 'Fixture provider failure' })
  ]))
  await r.sessions.send(chat, { text: '[text] after error' })
  expect(r.sessions.snapshot(chat).queued).toBe(0)
  expect(r.store.readTranscript(chat)!.items.filter(item => item.kind === 'user_message').map(item => item.text)).toEqual(['[slow]', '[error]', '[text] after error'])
  await eventually(() => r.sessions.snapshot(chat).status === 'idle' && r.sessions.snapshot(chat).items.filter(item => item.kind === 'assistant_text').length === 2)
  expect(r.pushes.filter(event => event.type === 'queued').map(event => event.count)).toEqual([1, 0])
})

it('consumes multiple Claude queued turns once across errors, tools and streamed text', async () => {
  const r = rig('claude'), chat = r.newChat()
  for (const text of ['[slow]', '[error]', '[tool]', '[text]']) await r.sessions.send(chat, { text })
  expect(r.sessions.snapshot(chat).queued).toBe(3)
  await eventually(() => r.sessions.snapshot(chat).status === 'idle' && r.sessions.snapshot(chat).items.filter(item => item.kind === 'assistant_text').length === 3)
  expect(r.pushes.filter(event => event.type === 'queued').map(event => event.count)).toEqual([1, 2, 3, 2, 1, 0])
  expect(r.sessions.snapshot(chat).queued).toBe(0)
  expect(r.store.readTranscript(chat)!.items.filter(item => item.kind === 'error')).toHaveLength(1)
  expect(r.store.readTranscript(chat)!.items.filter(item => item.kind === 'tool_call')).toEqual([
    expect.objectContaining({ name: 'Read', status: 'completed' })
  ])
})

for (const explicit of [false, true]) it(`handles output-free Claude results and tool/subagent traffic (explicit queue: ${explicit})`, async () => {
  const r = rig('claude'), chat = r.newChat(), start = r.deps.startProcess!
  let receive!: (raw: string) => void
  const nativeLines: string[] = []
  r.deps.startProcess = spec => {
    const child = start(spec)
    return { ...child, onLine: listener => {
      receive = listener
      return child.onLine(raw => { nativeLines.push(raw); listener(raw) })
    } }
  }
  for (const text of ['[hung]', '[error]', '[tool]']) await r.sessions.send(chat, { text })
  await eventually(() => nativeLines.some(raw => raw.includes('msg_T1_text')))
  const frame = (value: object) => receive(JSON.stringify(value))
  frame({ type: 'result', uuid: 'first-result', is_error: false, queued_turn_count: 2 })
  expect(r.sessions.snapshot(chat).queued).toBe(2)
  frame({ type: 'result', uuid: 'queued-empty-result', is_error: explicit, errors: ['No assistant output'],
    ...(explicit ? { queued_turn_count: 1 } : {}) })
  expect(r.sessions.snapshot(chat).queued).toBe(1)
  frame({ type: 'assistant', uuid: 'child-text', parent_tool_use_id: 'background-worker',
    message: { id: 'child-message', content: [{ type: 'text', text: 'Background progress' }] } })
  expect(r.sessions.snapshot(chat).queued).toBe(1)
  frame({ type: 'assistant', uuid: 'main-tool', parent_tool_use_id: null,
    message: { id: 'main-tool-only', content: [{ type: 'tool_use', id: 'main-read', name: 'Read', input: { file_path: 'a.txt' } }] } })
  expect(r.sessions.snapshot(chat)).toMatchObject({ queued: 0, status: 'busy' })
  frame({ type: 'result', uuid: 'tool-result', is_error: false })
  expect(r.sessions.snapshot(chat)).toMatchObject({ queued: 0, status: 'idle' })
  expect(r.pushes.filter(event => event.type === 'queued').map(event => event.count)).toEqual([1, 2, 2, 1, 0])
  expect(r.store.readTranscript(chat)!.items.filter(item => item.kind === 'user_message')).toHaveLength(3)
})

for (const kind of ['claude', 'omp'] as const) describe(`${kind} native GUI interrupt and resume`, () => {

  it('interrupts slow work and cancels its deadline before a later turn', async () => {
    const r = rig(kind), chat = r.newChat()
    await r.sessions.send(chat, { text: '[slow]' })
    await eventually(() => r.pushes.some(event => event.type === 'delta'))
    const pushed = r.deps.push
    const idle = new Promise<void>(resolve => {
      r.deps.push = event => { pushed(event); if (event.type === 'status' && event.status === 'idle') resolve() }
    })
    vi.useFakeTimers()
    await r.sessions.interrupt(chat)
    await idle
    expect(r.sessions.snapshot(chat).items.some(item => item.kind === 'turn_stopped')).toBe(true)
    const interrupt = JSON.parse(r.writes.at(-1)!)
    expect(interrupt).toMatchObject(kind === 'claude' ? { type: 'control_request', request: { subtype: 'interrupt' } } : { type: 'abort' })
    await r.sessions.send(chat, { text: '[hung]' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(r.sessions.isLive(chat)).toBe(true)
    expect(r.sessions.snapshot(chat).status).toBe('busy')
  })

  it('lazily resumes the same stopped session without replaying its kickoff', async () => {
    const r = rig(kind), chat = r.newChat('[slow]')
    await r.sessions.start(chat)
    await eventually(() => r.store.getChat(chat)!.sessionId !== null)
    const session = r.store.getChat(chat)!.sessionId
    await r.sessions.stop(chat)
    await r.sessions.send(chat, { text: '[text] resumed' })
    await eventually(() => r.sessions.snapshot(chat).status === 'idle')
    const launches = readFileSync(r.env.FAKE_AGENT_LOG!, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line)).filter(row => row.mode === kind)
    expect(launches).toHaveLength(2)
    expect(launches[1].argv.slice(-2)).toEqual(['--resume', session])
    expect(r.store.getChat(chat)!.sessionId).toBe(session)
    expect(r.store.readTranscript(chat)!.items.filter(item => item.kind === 'user_message').map(item => item.text)).toEqual(['[slow]', '[text] resumed'])
    expect(r.revoked).toEqual(['grant-1'])
  })
})

for (const kind of ['claude', 'omp'] as const) describe(`${kind} native GUI input refusals`, () => {

  it('does not echo a refused transport write or change its turn state', async () => {
    const r = rig(kind), chat = r.newChat()
    const start = r.deps.startProcess!
    let refuse = false
    r.deps.startProcess = spec => {
      const child = start(spec)
      return { ...child, write: line => refuse ? false : child.write(line) }
    }
    await r.sessions.start(chat)
    refuse = true
    await expect(r.sessions.send(chat, { text: 'not written' })).rejects.toThrow('before accepting input')
    expect(r.sessions.snapshot(chat)).toMatchObject({ status: 'idle', queued: 0, items: [] })
    expect(r.pushes.filter(event => event.type === 'item')).toEqual([])
  })

  it('refuses terminal-owned and signed-out sends without echo or spawning', async () => {
    const r = rig(kind), chat = r.newChat()
    r.state.terminalLive = true
    await expect(r.sessions.send(chat, { text: 'terminal' })).rejects.toThrow('terminal')
    r.state.terminalLive = false
    r.state.signedOut = true
    await expect(r.sessions.send(chat, { text: 'signed out' })).rejects.toThrow('not running')
    expect(r.children).toHaveLength(0)
    expect(r.sessions.snapshot(chat).items).toEqual([])
  })
})

for (const kind of ['claude', 'omp'] as const) describe(`${kind} native GUI interrupt deadline`, () => {

  it('force-kills an unresponsive turn at five seconds and remains resumable', async () => {
    const r = rig(kind), chat = r.newChat()
    const start = r.deps.startProcess!, forced: number[] = []
    r.deps.startProcess = spec => {
      const child = start(spec)
      return { ...child, stop: options => { if (options?.force) forced.push(Date.now()); return child.stop(options) } }
    }
    await r.sessions.send(chat, { text: '[hung]' })
    await eventually(() => r.store.getChat(chat)!.sessionId !== null)
    const session = r.store.getChat(chat)!.sessionId, pid = r.children[0].pid!
    const pushed = r.deps.push
    const failed = new Promise<void>(resolve => {
      r.deps.push = event => { pushed(event); if (event.type === 'status' && event.status === 'failed') resolve() }
    })
    const interrupted = Date.now()
    await r.sessions.interrupt(chat)
    await r.sessions.interrupt(chat)
    await failed
    expect(forced).toHaveLength(1)
    expect(forced[0] - interrupted).toBeGreaterThanOrEqual(4900)
    expect(forced[0] - interrupted).toBeLessThan(6000)
    await eventually(() => !r.sessions.isLive(chat))
    expect(() => process.kill(pid, 0)).toThrow()
    expect(r.sessions.snapshot(chat)).toMatchObject({ status: 'failed', queued: 0 })
    expect(r.revoked).toEqual(['grant-1'])
    await r.sessions.send(chat, { text: '[text] after timeout' })
    await eventually(() => r.sessions.snapshot(chat).status === 'idle')
    const launches = readFileSync(r.env.FAKE_AGENT_LOG!, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line)).filter(row => row.mode === kind)
    expect(launches[1].argv.slice(-2)).toEqual(['--resume', session])
    expect(r.store.getChat(chat)!.sessionId).toBe(session)
  }, 10_000)
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
