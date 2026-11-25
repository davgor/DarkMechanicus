import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createActivityBindings } from '../agents/activityBindings'
import { createChatStore, type ChatRef } from '../agents/chatStore'
import { agentChatRig, filesUnder } from './__mocks__/agentChatRig'
import { createAgentChatSessions } from './agentChatSessions'
import type { ArbiterOutcome } from './pendingPrompts'
import { builtInAgent } from '../agents/__mocks__/chatFixtures'
import { gate } from '../terminals/__mocks__/terminalSessionsRig'
import type { AgentAuthStatus } from '../../shared/desktop/api'
import type { PendingPrompt } from '../../shared/agents/agentChat'
import type { Callsign } from '../../shared/agents/callsign'
import { removeScratch } from '../../test/removeScratch'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
function rig(kind: 'claude' | 'omp' = 'claude', overrides: Parameters<typeof agentChatRig>[1] = {}, fixture?: string) {
  const value = agentChatRig(kind, overrides, fixture)
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

for (const kind of ['claude', 'omp'] as const) describe(`${kind} surface ownership`, () => {
  it('switches GUI to terminal and back without replacing the session, and pushes once per change', async () => {
    const changed = vi.fn(), r = rig(kind, { onChatChanged: changed }), chat = r.newChat()
    await r.sessions.start(chat)
    await eventually(() => r.store.getChat(chat)!.sessionId !== null)
    const session = r.store.getChat(chat)!.sessionId, pid = r.children[0].pid!
    changed.mockClear()
    expect(await r.sessions.setSurface(chat, 'terminal')).toMatchObject({ surface: 'terminal' })
    expect(r.revoked).toEqual(['grant-1'])
    expect(() => process.kill(pid, 0)).toThrow()
    expect(changed).toHaveBeenCalledExactlyOnceWith(chat)
    expect(r.store.getChat(chat)!.sessionId).toBe(session)
    changed.mockClear()
    expect(await r.sessions.setSurface(chat, 'gui')).toMatchObject({ surface: 'gui' })
    expect(changed).toHaveBeenCalledExactlyOnceWith(chat)
    expect(r.children).toHaveLength(1)
    await r.sessions.start(chat)
    const launches = readFileSync(r.env.FAKE_AGENT_LOG!, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line)).filter(row => row.mode === kind)
    expect(launches[1].argv.slice(-2)).toEqual(['--resume', session])
    expect(r.store.getChat(chat)!.sessionId).toBe(session)
  })
})

for (const kind of ['claude', 'omp'] as const) describe(`${kind} surface cleanup`, () => {

  it('does not persist or release ownership until close, transport cleanup and revocation all settle', async () => {
    const changed = vi.fn(), r = rig(kind, { onChatChanged: changed }), chat = r.newChat()
    const transport = gate<void>(), revoke = gate<void>(), close = gate<void>()
    const spawn = r.deps.startProcess!, originalRevoke = r.deps.revokeChatGrant
    let closed = false
    r.deps.startProcess = spec => {
      const child = spawn(spec)
      return { ...child, stop: async options => { await child.stop(options); await transport.promise },
        onExit: listener => child.onExit(exit => { closed = true; void close.promise.then(() => listener(exit)) }) }
    }
    r.deps.revokeChatGrant = async id => { await revoke.promise; await originalRevoke(id) }
    await r.sessions.start(chat)
    changed.mockClear()
    const switching = r.sessions.setSurface(chat, 'terminal')
    await eventually(() => closed)
    expect(r.sessions.isLive(chat)).toBe(true)
    await expect(r.sessions.start(chat)).rejects.toMatchObject({ code: 'busy' })
    await expect(r.sessions.setSurface(chat, 'terminal')).rejects.toMatchObject({ code: 'busy' })
    expect(r.store.getChat(chat)!.surface).toBe('gui')
    close.open()
    revoke.open()
    await eventually(() => r.revoked.length === 1)
    expect(changed).not.toHaveBeenCalled()
    expect(r.sessions.isLive(chat)).toBe(true)
    transport.open()
    await switching
    expect(r.sessions.isLive(chat)).toBe(false)
    expect(changed).toHaveBeenCalledTimes(1)
  })
})

for (const kind of ['claude', 'omp'] as const) describe(`${kind} surface refusals`, () => {

  it('refuses in-flight and queued turns without stopping or changing the surface', async () => {
    const changed = vi.fn(), r = rig(kind, { onChatChanged: changed }), chat = r.newChat()
    await r.sessions.send(chat, { text: '[hung]' })
    await r.sessions.send(chat, { text: '[text] queued' })
    changed.mockClear()
    await expect(r.sessions.setSurface(chat, 'terminal')).rejects.toMatchObject({ code: 'busy' })
    expect(r.sessions.isLive(chat)).toBe(true)
    expect(r.store.getChat(chat)!.surface).toBe('gui')
    expect(changed).not.toHaveBeenCalled()
    expect(r.revoked).toEqual([])
  })

  it('refuses pending approvals and questions without consuming them', async () => {
    const r = rig(kind), chat = r.newChat('[question]')
    await r.sessions.start(chat)
    await eventually(() => r.sessions.snapshot(chat).pending !== null)
    const before = r.sessions.snapshot(chat).pending, writes = [...r.writes]
    await expect(r.sessions.setSurface(chat, 'terminal')).rejects.toMatchObject({ code: 'busy' })
    expect(r.sessions.snapshot(chat).pending).toEqual(before)
    expect(r.writes).toEqual(writes)
    expect(r.revoked).toEqual([])
  })
})

it('treats a legacy chat as terminal and refuses unsupported GUI kinds without changes', async () => {
  const changed = vi.fn(), r = rig('claude', { agentFor: () => builtInAgent('codex'), onChatChanged: changed })
  const chat = r.store.createChat({ folder: r.repo, agent: 'codex', model: null, role: 'worker', allowSave: false })
  expect(r.sessions.snapshot(chat).surface).toBe('terminal')
  await expect(r.sessions.setSurface(chat, 'gui')).rejects.toMatchObject({ code: 'unsupported' })
  expect(await r.sessions.setSurface(chat, 'terminal')).toMatchObject({ surface: 'terminal' })
  expect(r.store.getChat(chat)).not.toHaveProperty('surface')
  expect(changed).not.toHaveBeenCalled()
})

it('persists a switch to the terminal that already owns the chat once, without stopping, revoking or confirming', async () => {
  const changed = vi.fn(), stopTerminal = vi.fn(async (_ref: ChatRef, _generation: string) => {}), confirm = vi.fn(async () => true)
  const r = rig('claude', { onChatChanged: changed, stopTerminal }), chat = r.newChat()
  r.state.terminalLive = true
  expect(await r.sessions.setSurface(chat, 'terminal', confirm)).toMatchObject({ surface: 'terminal' })
  expect(r.store.getChat(chat)!.surface).toBe('terminal')
  expect([stopTerminal.mock.calls, confirm.mock.calls, r.revoked, r.children, r.state.terminalLive]).toEqual([[], [], [], [], true])
  expect(changed).toHaveBeenCalledExactlyOnceWith(chat)
})

const TERMINAL_ONLY = [
  ['Forge setup', { forgeSetup: { intentId: '6f1c1d2e-8a4b-4c3d-9e5f-0a1b2c3d4e5f', mode: 'onboarding', stepId: '7a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d' } }],
  ['tooling repair', { repairIncidentId: 'ti_repair_fixture' }]
] as const
for (const [label, tag] of TERMINAL_ONLY) for (const kind of ['claude', 'omp'] as const) it(`refuses GUI start and switch for a ${kind} ${label} chat without side effects`, async () => {
  const changed = vi.fn(), stopTerminal = vi.fn(async (_ref: ChatRef, _generation: string) => {}), confirm = vi.fn(async () => true)
  const r = rig(kind, { onChatChanged: changed, stopTerminal })
  const chat = r.store.createChat({ folder: r.repo, agent: kind, model: null, role: 'worker', allowSave: false, surface: 'terminal', ...tag })
  const write = vi.spyOn(r.store, 'updateChat')
  await expect(r.sessions.start(chat)).rejects.toMatchObject({ code: 'unsupported' })
  await expect(r.sessions.send(chat, { text: 'start anyway' })).rejects.toMatchObject({ code: 'unsupported' })
  r.state.terminalLive = true
  await expect(r.sessions.setSurface(chat, 'gui', confirm)).rejects.toMatchObject({ code: 'unsupported' })
  expect([r.steps, r.children, r.pushes, r.revoked, write.mock.calls, changed.mock.calls]).toEqual([[], [], [], [], [], []])
  expect([confirm.mock.calls, stopTerminal.mock.calls, r.sessions.isLive(chat), r.store.getChat(chat)!.surface]).toEqual([[], [], false, 'terminal'])
})

it('refuses a toggle during authentication before any process or grant is issued', async () => {
  const auth = gate<AgentAuthStatus>()
  const r = rig('claude', { checkAuth: () => auth.promise }), chat = r.newChat()
  const starting = r.sessions.start(chat)
  await expect(r.sessions.setSurface(chat, 'terminal')).rejects.toMatchObject({ code: 'busy' })
  auth.open({ state: 'signed_in', reason: 'Fixture auth.' })
  await starting
})

it('refuses a held prompt even when a main-turn result has already reported idle', async () => {
  const r = rig('claude'), chat = r.newChat('[question]'), spawn = r.deps.startProcess!
  let receive!: (raw: string) => void
  r.deps.startProcess = spec => {
    const child = spawn(spec)
    return { ...child, onLine: listener => { receive = listener; return child.onLine(listener) } }
  }
  await r.sessions.start(chat)
  await eventually(() => r.sessions.snapshot(chat).pending !== null)
  receive(JSON.stringify({ type: 'result', uuid: 'injected-idle-with-prompt', is_error: false }))
  expect(r.sessions.snapshot(chat)).toMatchObject({ status: 'idle', pending: { kind: 'question' } })
  await expect(r.sessions.setSurface(chat, 'terminal')).rejects.toMatchObject({ code: 'busy' })
  expect(r.revoked).toEqual([])
})

for (const kind of ['claude', 'omp'] as const) describe(`${kind} confirmed terminal handoff`, () => {
  it('stops only the confirmed live owner before one persisted change and resumes the same session', async () => {
    const order: string[] = [], cleanup = gate<void>(), r = rig(kind), chat = r.newChat()
    await r.sessions.start(chat)
    await eventually(() => r.store.getChat(chat)!.sessionId !== null)
    const session = r.store.getChat(chat)!.sessionId
    await r.sessions.setSurface(chat, 'terminal')
    r.state.terminalLive = true
    r.deps.onChatChanged = ref => { order.push(`changed:${r.store.getChat(ref)!.surface}`) }
    r.deps.stopTerminal = async (_, generation) => {
      order.push(`stop:${generation}`)
      await cleanup.promise
      r.state.terminalLive = false
      order.push('closed+killed+revoked')
    }
    const confirm = vi.fn(async () => { order.push('confirm'); return true })
    const switching = r.sessions.setSurface(chat, 'gui', confirm)
    await eventually(() => order.includes('stop:terminal-1'))
    expect(r.store.getChat(chat)!.surface).toBe('terminal')
    expect(r.sessions.isLive(chat)).toBe(true)
    await expect(r.sessions.setSurface(chat, 'gui', confirm)).rejects.toMatchObject({ code: 'busy' })
    cleanup.open()
    expect(await switching).toMatchObject({ surface: 'gui' })
    expect(order).toEqual(['confirm', 'stop:terminal-1', 'closed+killed+revoked', 'changed:gui'])
    expect(confirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: chat.id }))
    await r.sessions.start(chat)
    const launches = readFileSync(r.env.FAKE_AGENT_LOG!, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line)).filter(row => row.mode === kind)
    expect(launches.map(row => row.argv.slice(-2))[1]).toEqual(['--resume', session])
    expect([r.children.length, r.store.getChat(chat)!.sessionId]).toEqual([2, session])
  })
})

function liveTerminalRig() {
  const changed = vi.fn()
  // A successful stop of the confirmed owner leaves no terminal of the chat live.
  const stopTerminal = vi.fn(async (_ref: ChatRef, _generation: string) => { r.state.terminalLive = false })
  const r = rig('claude', { onChatChanged: changed, stopTerminal })
  const chat = r.store.updateChat(r.newChat(), { surface: 'terminal' })
  r.state.terminalLive = true
  const write = vi.spyOn(r.store, 'updateChat')
  const unchanged = () => {
    expect([write.mock.calls, changed.mock.calls, r.revoked, r.children]).toEqual([[], [], [], []])
    expect([r.store.getChat(chat)!.surface, r.state.terminalLive, r.sessions.isLive(chat)]).toEqual(['terminal', true, false])
  }
  return { r, chat, changed, stopTerminal, write, unchanged }
}

describe('live terminal confirmation refusals', () => {
  it('refuses a missing confirmation, as for automatic callers, without stopping, writing or pushing', async () => {
    const { r, chat, stopTerminal, unchanged } = liveTerminalRig()
    await expect(r.sessions.setSurface(chat, 'gui')).rejects.toMatchObject({ code: 'busy' })
    expect(stopTerminal).not.toHaveBeenCalled()
    unchanged()
  })

  it('changes nothing when the confirmation is declined, throws or rejects', async () => {
    const { r, chat, stopTerminal, unchanged } = liveTerminalRig()
    const answers: (() => Promise<boolean>)[] = [async () => false, async () => { throw new Error('dialog failed') }, () => Promise.reject(new Error('dialog closed'))]
    await expect(r.sessions.setSurface(chat, 'gui', answers[0])).rejects.toMatchObject({ code: 'cancelled' })
    await expect(r.sessions.setSurface(chat, 'gui', answers[1])).rejects.toThrow('dialog failed')
    await expect(r.sessions.setSurface(chat, 'gui', answers[2])).rejects.toThrow('dialog closed')
    expect(stopTerminal).not.toHaveBeenCalled()
    unchanged()
  })

  for (const change of ['replaced', 'exited'] as const) it(`invalidates an approval when the owner is ${change} while the dialog waits`, async () => {
    const { r, chat, stopTerminal, unchanged } = liveTerminalRig(), answer = gate<boolean>()
    const switching = r.sessions.setSurface(chat, 'gui', () => answer.promise)
    if (change === 'replaced') r.state.terminalGeneration = 'terminal-2'
    else r.deps.terminalOwner = () => null
    answer.open(true)
    await expect(switching).rejects.toMatchObject({ code: 'busy' })
    expect(stopTerminal).not.toHaveBeenCalled()
    unchanged()
  })

  it('refuses a starting or retiring terminal that has no confirmable owner without asking', async () => {
    const { r, chat, stopTerminal, unchanged } = liveTerminalRig(), confirm = vi.fn(async () => true)
    r.deps.terminalOwner = () => null
    await expect(r.sessions.setSurface(chat, 'gui', confirm)).rejects.toMatchObject({ code: 'busy' })
    expect([confirm.mock.calls, stopTerminal.mock.calls]).toEqual([[], []])
    unchanged()
  })
})

describe('live terminal confirmation outcomes', () => {
  it('asks once for duplicate concurrent requests without reserving ownership, then pushes once', async () => {
    const { r, chat, changed, stopTerminal } = liveTerminalRig(), answer = gate<boolean>(), confirm = vi.fn(() => answer.promise)
    const first = r.sessions.setSurface(chat, 'gui', confirm)
    await expect(r.sessions.setSurface(chat, 'gui', confirm)).rejects.toMatchObject({ code: 'busy' })
    expect([confirm.mock.calls.length, r.sessions.isLive(chat), r.state.terminalLive]).toEqual([1, false, true])
    answer.open(true)
    expect(await first).toMatchObject({ surface: 'gui' })
    expect(stopTerminal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: chat.id }), 'terminal-1')
    expect(changed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: chat.id }))
  })

  it('keeps the surface and pushes nothing when terminal cleanup fails', async () => {
    const { r, chat, changed, stopTerminal, write } = liveTerminalRig()
    stopTerminal.mockRejectedValueOnce(new Error('The terminal process tree did not stop.'))
    await expect(r.sessions.setSurface(chat, 'gui', async () => true)).rejects.toThrow('process tree did not stop')
    expect(stopTerminal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: chat.id }), 'terminal-1')
    expect([write.mock.calls, changed.mock.calls, r.store.getChat(chat)!.surface]).toEqual([[], [], 'terminal'])
  })

  it('refuses to persist the GUI while an earlier fenced terminal owner keeps the chat live after the confirmed stop', async () => {
    const { r, chat, changed, stopTerminal, write } = liveTerminalRig()
    // The confirmed owner retires, but an earlier owner whose cleanup failed is still fenced.
    stopTerminal.mockImplementationOnce(async () => {})
    await expect(r.sessions.setSurface(chat, 'gui', async () => true)).rejects.toMatchObject({ code: 'busy' })
    expect(stopTerminal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: chat.id }), 'terminal-1')
    expect([write.mock.calls, changed.mock.calls, r.pushes, r.children, r.store.getChat(chat)!.surface]).toEqual([[], [], [], [], 'terminal'])
    expect([r.state.terminalLive, r.sessions.isLive(chat)]).toEqual([true, false])
  })

  it('switches an exited terminal without asking or stopping anything', async () => {
    const { r, chat, changed, stopTerminal } = liveTerminalRig(), confirm = vi.fn(async () => true)
    r.state.terminalLive = false
    expect(await r.sessions.setSurface(chat, 'gui', confirm)).toMatchObject({ surface: 'gui' })
    expect([confirm.mock.calls, stopTerminal.mock.calls, changed.mock.calls.length]).toEqual([[], [], 1])
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

for (const kind of ['claude', 'omp'] as const) {
  for (const scenario of ['approval', 'question'] as const) {
    const answer = scenario === 'question' ? { optionId: 'text', text: 'Chosen database' } : { optionId: 'allow_once' }
    const kinds = scenario === 'approval'
      ? kind === 'claude' ? ['user_message', 'tool_call', 'approval_request', 'approval_decision'] : ['user_message', 'approval_request', 'approval_decision', 'tool_call', 'assistant_text']
      : kind === 'claude' ? ['user_message', 'tool_call', 'approval_request', 'approval_decision', 'user_message'] : ['user_message', 'approval_request', 'approval_decision', 'user_message', 'assistant_text']
    const category = scenario === 'approval' && kind === 'claude' ? 'command' : 'other'
    const tool = scenario === 'question' ? kind === 'claude' ? 'AskUserQuestion' : 'ask' : kind === 'claude' ? 'Bash' : 'OMP'
    const outputKind = kind === 'claude' ? 'tool_call' : 'assistant_text'
    const output = kind === 'claude' ? { status: 'completed', resultSummary: scenario === 'question' ? 'SQLite' : 'hello' }
      : { text: scenario === 'question' ? 'SQLite' : 'hello' }
    it(`${kind} holds ${scenario} for ten fake minutes, replays it, and records only the accepted answer`, async () => {
      const r = rig(kind), chat = r.newChat(`[${scenario}]`)
      await r.sessions.start(chat)
      await eventually(() => r.sessions.snapshot(chat).pending !== null)
      const pending = r.sessions.snapshot(chat).pending!
      const before = [...r.writes]
      expect(r.sessions.snapshot(chat)).toMatchObject({ status: 'busy', pending: { id: pending.id, arbitration: { state: 'off', reason: null } } })
      vi.useFakeTimers()
      await vi.advanceTimersByTimeAsync(600_000)
      expect(r.writes).toEqual(before)
      expect(r.sessions.snapshot(chat).pending).toEqual(pending)
      vi.useRealTimers()
      await expect(r.sessions.answer(chat, { promptId: 'unknown', optionId: 'allow_once' })).rejects.toMatchObject({ code: 'stale_prompt' })
      await expect(r.sessions.answer(chat, { promptId: pending.id, optionId: 'invented' })).rejects.toMatchObject({ code: 'invalid_input' })
      expect(r.writes).toEqual(before)
      await r.sessions.answer(chat, { promptId: pending.id, ...answer })
      await eventually(() => r.sessions.snapshot(chat).status === 'idle')
      const items = r.store.readTranscript(chat)!.items
      expect(items.map(item => item.kind)).toEqual(kinds)
      expect(items.find(item => item.kind === 'approval_request')).toMatchObject({ requestId: pending.id, category, tool })
      expect(items.filter(item => item.kind === 'approval_decision')).toEqual([expect.objectContaining({ requestId: pending.id, decision: 'allow_once', decidedBy: 'person' })])
      if (scenario === 'question') expect(items.filter(item => item.kind === 'user_message').map(item => item.text)).toEqual(['[question]', 'Chosen database'])
      expect(items.find(item => item.kind === outputKind)).toMatchObject(output)
      expect(r.sessions.snapshot(chat).pending).toBeNull()
      const after = [...r.writes]
      await expect(r.sessions.answer(chat, { promptId: pending.id, optionId: 'deny' })).rejects.toMatchObject({ code: 'stale_prompt' })
      expect(r.writes).toEqual(after)
    })
  }

  it(`${kind} writes the allow_chat golden line but never answers a subsequent approval itself`, async () => {
    const r = rig(kind), chat = r.newChat('[approval_chat]')
    await r.sessions.start(chat)
    await eventually(() => r.sessions.snapshot(chat).pending !== null)
    await r.sessions.answer(chat, { promptId: r.sessions.snapshot(chat).pending!.id, optionId: 'allow_chat' })
    const golden = readFileSync(join(import.meta.dirname, '__fixtures__', kind, 'approval_chat.in.jsonl'), 'utf8').trim().split(/\r?\n/)[1]
    expect(r.writes.at(-1)).toBe(golden)
    await eventually(() => r.sessions.snapshot(chat).status === 'idle')
    expect(r.store.readTranscript(chat)!.items.filter(item => item.kind === 'approval_decision')).toEqual([expect.objectContaining({ decision: 'allow_chat', decidedBy: 'person' })])
    await r.sessions.send(chat, { text: '[approval]' })
    await eventually(() => r.sessions.snapshot(chat).pending !== null)
    expect(r.store.readTranscript(chat)!.items.filter(item => item.kind === 'approval_decision')).toHaveLength(1)
    await r.sessions.stop(chat)
    expect(r.sessions.snapshot(chat).pending).toBeNull()
    expect(r.pushes.filter(event => event.type === 'pending').at(-1)).toMatchObject({ prompt: null })
  })

  it(`${kind} completes through the optional Magos seam with masked bounded provenance`, async () => {
    const reason = `dmg_${'a1'.repeat(32)} ${'x'.repeat(600)}`
    const arbitrate = vi.fn(() => ({ result: Promise.resolve<ArbiterOutcome>({ decision: 'allow_once', reason }), cancel: vi.fn() }))
    const r = rig(kind, { arbitrate }), chat = r.newChat('[approval]')
    await r.sessions.start(chat)
    await eventually(() => r.sessions.snapshot(chat).status === 'idle')
    expect(arbitrate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      ref: { folder: chat.folder, id: chat.id }, chat: expect.objectContaining({ id: chat.id }),
      agent: expect.objectContaining({ kind }), prompt: expect.objectContaining({ arbitration: { state: 'deciding', reason: null } })
    }))
    const decisions = r.store.readTranscript(chat)!.items.filter(item => item.kind === 'approval_decision')
    expect(decisions).toEqual([expect.objectContaining({ decision: 'allow_once', decidedBy: 'magos', reason: expect.any(String) })])
    expect(decisions[0].reason).toHaveLength(500)
    expect(JSON.stringify([r.pushes, decisions])).not.toContain('dmg_')
  })

  it(`${kind} lets the person win a hanging arbiter and drops its later verdict`, async () => {
    let resolve!: (verdict: ArbiterOutcome) => void
    const result = new Promise<ArbiterOutcome>(yes => { resolve = yes }), cancel = vi.fn()
    const r = rig(kind, { arbitrate: () => ({ result, cancel }) }), chat = r.newChat('[approval]')
    await r.sessions.start(chat)
    await eventually(() => r.sessions.snapshot(chat).pending !== null)
    const promptId = r.sessions.snapshot(chat).pending!.id
    expect(r.sessions.snapshot(chat).pending?.arbitration.state).toBe('deciding')
    await r.sessions.answer(chat, { promptId, optionId: 'allow_once' })
    expect(cancel).toHaveBeenCalledTimes(1)
    const writes = [...r.writes]
    resolve({ decision: 'deny', reason: 'Late verdict' })
    await Promise.resolve()
    await eventually(() => r.sessions.snapshot(chat).status === 'idle')
    expect(r.writes).toEqual(writes)
    expect(r.store.readTranscript(chat)!.items.filter(item => item.kind === 'approval_decision')).toEqual([expect.objectContaining({ decidedBy: 'person', decision: 'allow_once' })])
  })

  it(`${kind} does not consume or record a prompt when its transport refuses the answer`, async () => {
    const r = rig(kind), chat = r.newChat('[approval]'), start = r.deps.startProcess!
    let refuse = false
    r.deps.startProcess = spec => { const child = start(spec); return { ...child, write: line => refuse ? false : child.write(line) } }
    await r.sessions.start(chat)
    await eventually(() => r.sessions.snapshot(chat).pending !== null)
    const pending = r.sessions.snapshot(chat).pending!, items = r.sessions.snapshot(chat).items
    refuse = true
    await expect(r.sessions.answer(chat, { promptId: pending.id, optionId: 'allow_once' })).rejects.toThrow('before accepting input')
    expect(r.sessions.snapshot(chat)).toMatchObject({ pending, items })
  })
}

for (const kind of ['claude', 'omp'] as const) it(`${kind} reconciles injected concurrent prompts FIFO and clears all on native exit`, async () => {
  const r = rig(kind), chat = r.newChat(), start = r.deps.startProcess!
  let receive!: (raw: string) => void
  r.deps.startProcess = spec => { const child = start(spec); return { ...child, onLine: listener => { receive = listener; return child.onLine(listener) } } }
  await r.sessions.start(chat)
  for (const id of ['first', 'second', 'third']) receive(JSON.stringify(kind === 'claude'
    ? { type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'a.txt' } } }
    : { type: 'extension_ui_request', id, method: 'select', options: ['Approve', 'Deny'], title: id }))
  expect(r.sessions.snapshot(chat).pending?.id).toBe('first')
  const writes = [...r.writes]
  await expect(r.sessions.answer(chat, { promptId: 'second', optionId: 'allow_once' })).rejects.toMatchObject({ code: 'stale_prompt' })
  expect(r.writes).toEqual(writes)
  if (kind === 'omp') receive(JSON.stringify({ type: 'extension_ui_request', id: 'withdrawal', method: 'cancel', targetId: 'first' }))
  else await r.sessions.answer(chat, { promptId: 'first', optionId: 'allow_once' })
  expect(r.sessions.snapshot(chat).pending?.id).toBe('second')
  await expect(r.sessions.answer(chat, { promptId: 'first', optionId: 'deny' })).rejects.toMatchObject({ code: 'stale_prompt' })
  await r.sessions.answer(chat, { promptId: 'second', optionId: 'deny' })
  expect(r.sessions.snapshot(chat).pending?.id).toBe('third')
  await r.children[0].stop()
  await eventually(() => !r.sessions.isLive(chat))
  expect(r.sessions.snapshot(chat).pending).toBeNull()
  expect(r.pushes.filter(event => event.type === 'pending').at(-1)).toMatchObject({ prompt: null })
  await expect(r.sessions.answer(chat, { promptId: 'third', optionId: 'allow_once' })).rejects.toMatchObject({ code: 'stale_prompt' })
})

it('records injected OMP secret questions without persisting or pushing their input', async () => {
  const r = rig('omp'), chat = r.newChat(), start = r.deps.startProcess!
  let receive!: (raw: string) => void
  r.deps.startProcess = spec => { const child = start(spec); return { ...child, onLine: listener => { receive = listener; return child.onLine(listener) } } }
  await r.sessions.start(chat)
  receive(JSON.stringify({ type: 'extension_ui_request', id: 'secret', method: 'input', secret: true, title: 'Password' }))
  await r.sessions.answer(chat, { promptId: 'secret', optionId: 'text', text: 'private-password-value' })
  expect(r.writes.at(-1)).toBe('{"type":"extension_ui_response","id":"secret","value":"private-password-value"}')
  expect(r.sessions.snapshot(chat).items.map(item => item.kind)).toEqual(['approval_request', 'approval_decision'])
  expect(r.sessions.snapshot(chat).items[0]).toMatchObject({ category: 'other', tool: 'input' })
  expect(JSON.stringify([r.pushes, r.sessions.snapshot(chat), filesUnder(r.userData)])).not.toContain('private-password-value')
})

it('retains translator thread attribution on injected Claude question requests and answers', async () => {
  const r = rig('claude'), chat = r.newChat(), start = r.deps.startProcess!
  let receive!: (raw: string) => void
  r.deps.startProcess = spec => { const child = start(spec); return { ...child, onLine: listener => { receive = listener; return child.onLine(listener) } } }
  await r.sessions.start(chat)
  receive(JSON.stringify({ type: 'assistant', parent_tool_use_id: 'worker', message: { id: 'child-message',
    content: [{ type: 'tool_use', id: 'child-question', name: 'AskUserQuestion', input: { questions: [{ question: 'Proceed?' }] } }] } }))
  receive(JSON.stringify({ type: 'control_request', request_id: 'child-request', request: {
    subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 'child-question', input: { questions: [{ question: 'Proceed?' }] }
  } }))
  expect(r.sessions.snapshot(chat).pending?.threadId).toBe('thread:worker')
  await r.sessions.answer(chat, { promptId: 'child-request', optionId: 'text', text: 'Proceed' })
  const records = r.sessions.snapshot(chat).items.filter(item => ['approval_request', 'approval_decision', 'user_message'].includes(item.kind))
  expect(records.map(item => [item.kind, item.threadId])).toEqual([
    ['approval_request', 'thread:worker'], ['approval_decision', 'thread:worker'], ['user_message', 'thread:worker']
  ])
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
    await r.sessions.deleteChat(chat, async () => {
      expect(() => process.kill(pid, 0)).toThrow()
      r.store.deleteChat(chat)
    })
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

const CLAIM = 'at_01j0000000000000000000000a.fixtureSecretAAAAAAAAAAAAAAAAAAA'
const ATTEMPT = 'at_01j0000000000000000000000a'
const RUN = 'rn_callsign_run'
const WORKER_THREAD = 'thread:toolu_T1_claim_worker'
const acolyte = (ticketKey: string, ticketVerified: boolean): Callsign => ({ role: 'Acolyte', ticketKey, ordinal: null, purpose: 'run the tests', ticketVerified })
const servitor = (ordinal: number, purpose: string | null): Callsign => ({ role: 'Servitor', ticketKey: null, ordinal, purpose, ticketVerified: false })
const MAGOS: Callsign = { role: 'Magos', ticketKey: null, ordinal: null, purpose: null, ticketVerified: false }

type Rig = ReturnType<typeof rig>
/** `runId` null makes a New chat: an orchestrator with no run. */
function orchestratorChat(r: Rig, kind: 'claude' | 'omp', firstPrompt: string, runId: string | null = RUN): ChatRef {
  return r.store.createChat({ folder: r.repo, agent: kind, role: 'orchestrator', allowSave: false, model: null, surface: 'gui', firstPrompt, ...(runId === null ? {} : { runId }) })
}
function item(store: Pick<Rig['store'], 'readTranscript'>, chat: ChatRef, id: string) {
  return store.readTranscript(chat)!.items.find(entry => entry.id === id)
}
/** The golden fixtures copied beside a fake CLI whose replay a test may edit; removed after the rig. */
function editedFixtures(edit: (directory: string) => void): string {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm callsign fixtures ')))
  cpSync(join(import.meta.dirname, '__fixtures__'), directory, { recursive: true })
  edit(directory)
  cleanups.push(async () => { removeScratch(directory) })
  return join(directory, 'fakeAgentCli.mjs')
}
function verifiedClaim(r: Rig, ticketKey: string | null, runId = RUN) {
  r.claims.live.set(CLAIM, { attemptId: ATTEMPT, runId, ticketId: 'tk_worker' })
  if (ticketKey !== null) r.claims.ticketKeys.set(ATTEMPT, ticketKey)
}
/** The claim check runs when the spawn is read; its bind and ticket lookup settle as microtasks of that turn. */
async function settled(r: Rig) {
  await eventually(() => r.claims.verified.length > 0)
  await new Promise(resolve => setImmediate(resolve))
}
const threadCallsigns = (store: Pick<Rig['store'], 'readTranscript'>, chat: ChatRef) =>
  Object.fromEntries(store.readTranscript(chat)!.items.flatMap(entry => entry.kind === 'thread' ? [[entry.id, entry.callsign]] : []))

describe('callsigns from a verified worker claim', () => {
  it('stamps the bound ticket key, verified, on the thread, its approval request and the pending prompt', async () => {
    const r = rig()
    verifiedClaim(r, 'DM-442')
    const chat = orchestratorChat(r, 'claude', '[worker_approval]')
    await r.sessions.start(chat)
    await eventually(() => r.sessions.snapshot(chat).pending?.callsign?.ticketVerified === true)
    expect(r.sessions.snapshot(chat).pending).toMatchObject({ threadId: WORKER_THREAD, attributed: true, callsign: acolyte('DM-442', true) })
    expect(item(r.store, chat, WORKER_THREAD)).toMatchObject({ kind: 'thread', callsign: acolyte('DM-442', true) })
    await eventually(() => (item(r.store, chat, 'approval:req_T1_worker_approval') as { callsign?: Callsign } | undefined)?.callsign?.ticketVerified === true)
    expect(r.pushes.filter(event => event.type === 'pending' && event.prompt?.callsign?.ticketVerified).length).toBeGreaterThan(0)
    expect(r.claims.lookups).toEqual([ATTEMPT])
  })

  it('lets the bound ticket key win over a mismatched label key', async () => {
    const r = rig()
    verifiedClaim(r, 'DM-500')
    const chat = orchestratorChat(r, 'claude', '[worker_approval]')
    await r.sessions.start(chat)
    await eventually(() => r.sessions.snapshot(chat).pending?.callsign?.ticketKey === 'DM-500')
    expect(r.sessions.snapshot(chat).pending!.callsign).toEqual(acolyte('DM-500', true))
    expect(item(r.store, chat, WORKER_THREAD)).toMatchObject({ label: 'Acolyte:DM-442 run the tests', callsign: acolyte('DM-500', true) })
  })

  it('keeps the label key unverified when the ticket-key lookup finds nothing or fails', async () => {
    for (const ticketKeyOfAttempt of [async () => null, async () => { throw new Error('lookup failed') }]) {
      const r = rig('claude', { ticketKeyOfAttempt })
      verifiedClaim(r, null)
      const chat = orchestratorChat(r, 'claude', '[worker_approval]')
      await r.sessions.start(chat)
      await eventually(() => r.sessions.snapshot(chat).pending !== null)
      await settled(r)
      expect(r.deps.bindings.threadsOf(chat)).toEqual([expect.objectContaining({ threadId: WORKER_THREAD, attemptId: ATTEMPT })])
      expect(r.sessions.snapshot(chat).pending!.callsign).toEqual(acolyte('DM-442', false))
      expect(item(r.store, chat, WORKER_THREAD)).toMatchObject({ callsign: acolyte('DM-442', false) })
    }
  })
})

describe('callsigns that a label cannot raise', () => {
  it('turns a thread labelled as the Magos into a Servitor', async () => {
    const fixture = editedFixtures(directory => {
      const path = join(directory, 'claude', 'worker_approval.out.jsonl')
      writeFileSync(path, readFileSync(path, 'utf8').replaceAll('Acolyte:DM-442 run the tests', 'Magos override'))
    })
    const r = rig('claude', {}, fixture)
    const chat = orchestratorChat(r, 'claude', '[worker_approval]')
    await r.sessions.start(chat)
    await eventually(() => r.sessions.snapshot(chat).pending !== null)
    expect(r.sessions.snapshot(chat).pending!.callsign).toEqual(servitor(1, null))
    expect(item(r.store, chat, WORKER_THREAD)).toMatchObject({ label: 'Magos override', callsign: servitor(1, null) })
    expect(item(r.store, chat, 'approval:req_T1_worker_approval')).toMatchObject({ callsign: servitor(1, null) })
  })

  for (const kind of ['claude', 'omp'] as const) it(`${kind} stamps the Magos only on a Start-run orchestrator's own approval`, async () => {
    const r = rig(kind)
    const run = orchestratorChat(r, kind, '[approval]')
    const fresh = orchestratorChat(r, kind, '[approval]', null)
    await Promise.all([r.sessions.start(run), r.sessions.start(fresh)])
    await eventually(() => r.sessions.snapshot(run).pending !== null && r.sessions.snapshot(fresh).pending !== null)
    expect(r.sessions.snapshot(run).pending).toMatchObject({ threadId: null, attributed: true, callsign: MAGOS })
    expect(r.sessions.snapshot(fresh).pending).toMatchObject({ threadId: null, attributed: true, callsign: null })
    const request = (chat: ChatRef) => r.store.readTranscript(chat)!.items.find(entry => entry.kind === 'approval_request')
    expect(request(run)).toMatchObject({ callsign: MAGOS })
    expect(request(fresh)).not.toHaveProperty('callsign')
  })
})

describe('callsigns of approvals no thread accounts for', () => {
  it('omp names nobody for a select approval it cannot tie to a thread while a subagent runs', async () => {
    const fixture = editedFixtures(directory => {
      writeFileSync(join(directory, 'omp', 'worker_approval.out.jsonl'), [
        { type: 'response', command: 'prompt', id: 'req_T1_prompt', success: true },
        { type: 'agent_start' },
        { type: 'subagent_lifecycle', payload: { id: 'agent_T1_claim_worker', agent: 'task', description: 'Acolyte:DM-442 run the tests', status: 'running' } },
        { type: 'extension_ui_request', id: 'ui_T1_approval', method: 'select', title: 'Run bash: echo tests?', options: ['Approve Once', 'Deny'] },
        { type: 'subagent_lifecycle', payload: { id: 'agent_T1_claim_worker', agent: 'task', description: 'Acolyte:DM-442 run the tests', status: 'completed' } },
        { type: 'prompt_result', id: 'req_T1_prompt', agentInvoked: true, status: 'completed' }
      ].map(frame => JSON.stringify(frame)).join('\n') + '\n')
    })
    const arbitrated: PendingPrompt[] = []
    const r = rig('omp', { arbitrate: ({ prompt }) => { arbitrated.push(prompt); return { result: new Promise(() => undefined), cancel: () => undefined } } }, fixture)
    const chat = orchestratorChat(r, 'omp', '[worker_approval]')
    await r.sessions.start(chat)
    await eventually(() => r.sessions.snapshot(chat).pending !== null)
    expect(r.sessions.snapshot(chat).pending).toMatchObject({ threadId: null, attributed: false, callsign: null })
    expect(arbitrated).toEqual([expect.objectContaining({ attributed: false, callsign: null })])
    expect(r.store.readTranscript(chat)!.items.find(entry => entry.kind === 'approval_request')).not.toHaveProperty('callsign')
    expect(JSON.stringify(r.pushes.filter(event => event.type === 'pending'))).not.toContain('"Magos"')
  })
})

describe('worker claim verification', () => {
  it('binds only a claim the project verifies for this chat\'s own run', async () => {
    for (const [name, setup] of [['forged secret', () => undefined], ['another run', (r: Rig) => verifiedClaim(r, 'DM-442', 'rn_other_run')]] as const) {
      const r = rig()
      setup(r)
      const chat = orchestratorChat(r, 'claude', '[worker_approval]')
      await r.sessions.start(chat)
      await eventually(() => r.sessions.snapshot(chat).pending !== null)
      await settled(r)
      expect(r.claims.verified, name).toEqual([ATTEMPT])
      expect(r.deps.bindings.threadsOf(chat), name).toEqual([])
      expect(existsSync(r.bindingsFile), name).toBe(false)
      expect(r.claims.lookups, name).toEqual([])
      expect(r.sessions.snapshot(chat).pending!.callsign, name).toEqual(acolyte('DM-442', false))
    }
  })

  it('never verifies a claim in a New chat or a project-less chat', async () => {
    const r = rig()
    verifiedClaim(r, 'DM-442')
    const fresh = orchestratorChat(r, 'claude', '[worker_approval]', null)
    const projectless = r.store.createChat({ folder: null, agent: 'claude', role: 'orchestrator', allowSave: false, model: null, surface: 'gui', firstPrompt: '[worker_approval]', runId: RUN })
    await Promise.all([r.sessions.start(fresh), r.sessions.start(projectless)])
    // The spawn (and any claim check, which starts synchronously) is read before its approval is pending.
    await eventually(() => r.sessions.snapshot(fresh).pending !== null && r.sessions.snapshot(projectless).pending !== null)
    expect(r.claims.verified).toEqual([])
    expect(existsSync(r.bindingsFile)).toBe(false)
    expect(r.sessions.snapshot(fresh).pending!.callsign).toEqual(acolyte('DM-442', false))
  })
})

describe('callsigns across a restart', () => {
  async function firstSession(r: Rig, chat: ChatRef) {
    await r.sessions.start(chat)
    await eventually(() => r.sessions.snapshot(chat).pending?.callsign?.ticketVerified === true)
    await r.sessions.answer(chat, { promptId: r.sessions.snapshot(chat).pending!.id, optionId: 'allow_once' })
    await eventually(() => r.sessions.snapshot(chat).status === 'idle')
    await r.sessions.send(chat, { text: '[subagent]' })
    await eventually(() => r.sessions.snapshot(chat).status === 'idle' && r.store.readTranscript(chat)!.items.filter(entry => entry.kind === 'thread').length === 2)
    await r.sessions.dispose()
  }

  it('persists the attempt binding without the claim secret', async () => {
    const r = rig()
    verifiedClaim(r, 'DM-442')
    const chat = orchestratorChat(r, 'claude', '[worker_approval]')
    await firstSession(r, chat)
    expect(threadCallsigns(r.store, chat)).toEqual({ [WORKER_THREAD]: acolyte('DM-442', true), 'thread:toolu_T2_worker': servitor(1, null) })
    const stored = readFileSync(r.bindingsFile, 'utf8')
    expect(stored).toContain(ATTEMPT)
    expect(stored).not.toContain('fixtureSecret')
    expect(JSON.stringify(r.pushes)).not.toContain('fixtureSecret')
    expect(filesUnder(r.userData).filter(text => text.includes('fixtureSecret'))).toEqual([])
  })

  it('restamps the same callsigns and Servitor ordinals from a fresh manager over the same userData', async () => {
    const r = rig()
    verifiedClaim(r, 'DM-442')
    const chat = orchestratorChat(r, 'claude', '[worker_approval]')
    await firstSession(r, chat)
    const before = threadCallsigns(r.store, chat), stored = readFileSync(r.bindingsFile, 'utf8')
    // No claim verifies any more, yet the stored binding and ordinals hold.
    const store = createChatStore({ root: join(r.userData, 'agents', 'chats') })
    const reopened = createAgentChatSessions({ ...r.deps, store, bindings: createActivityBindings({ file: r.bindingsFile }),
      verifyAttemptClaim: async () => null, ticketKeyOfAttempt: async () => 'DM-442' })
    // Before the rig removes its scratch folder: a live child there makes Windows refuse the removal.
    cleanups.unshift(() => reopened.dispose())
    const restamped = r.pushes.length
    await reopened.send(chat, { text: '[worker_approval]' })
    await eventually(() => reopened.snapshot(chat).pending?.callsign?.ticketVerified === true)
    expect(reopened.snapshot(chat).pending!.callsign).toEqual(acolyte('DM-442', true))
    await reopened.answer(chat, { promptId: reopened.snapshot(chat).pending!.id, optionId: 'allow_once' })
    await eventually(() => reopened.snapshot(chat).status === 'idle')
    await reopened.send(chat, { text: '[subagent]' })
    await eventually(() => reopened.snapshot(chat).status === 'idle' && r.pushes.slice(restamped).some(event => event.type === 'item' && event.item.id === 'thread:toolu_T2_worker'))
    expect(threadCallsigns(store, chat)).toEqual(before)
    const pushed = r.pushes.slice(restamped).flatMap(event => event.type === 'item' && event.item.kind === 'thread' ? [[event.item.id, event.item.callsign]] : [])
    expect(Object.fromEntries(pushed)).toEqual(before)
    expect(readFileSync(r.bindingsFile, 'utf8')).toBe(stored)
    await reopened.dispose()
  })
})
