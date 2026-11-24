import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachHumanWait } from '../../../resources/skitarii/extension/humanWait'
import { humanWaitCurrent } from '../../../resources/skitarii/extension/humanWaitLease'
import type { DmClient } from '../../../resources/skitarii/extension/dmClient'
import type { MailApi, MailContext, MailToolDefinition } from '../../../resources/skitarii/extension/messaging'

const TEN_MINUTES = 600_000
const REQUEST = { question: 'Approve the blue fixture rollout?', why: 'Deployment may not start until you approve the target.' }
const DONE = { messages: [{ role: 'assistant', stopReason: 'stop' }] }
const MAIN = { kind: 'main' }
let home: string

beforeEach(() => {
  vi.useFakeTimers()
  home = mkdtempSync(join(tmpdir(), 'dm-human-wait-'))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(home, { recursive: true, force: true })
})

function rig(options: { run?: DmClient['run']; externallyUnavailable?: true; rejectWake?: true; world?: true } = {}) {
  const handlers = new Map<string, Parameters<MailApi['on']>[1]>()
  const tools = new Map<string, MailToolDefinition>()
  const setStatus = vi.fn<NonNullable<MailContext['ui']['setStatus']>>()
  const send = vi.fn<NonNullable<MailApi['sendUserMessage']>>(async () => {
    if (options.rejectWake) throw new Error('host refused')
  })
  const run = vi.fn<DmClient['run']>(options.run ?? (async (_command, input) => {
    if (typeof input !== 'object' || input === null || !('waitId' in input)) throw new Error('Missing fixture waitId')
    return { ok: true, data: { questionId: input.waitId, state: 'queued' } }
  }))
  const ctx: MailContext = { agent: MAIN, hasUI: true, ui: { setStatus } }
  const pi: MailApi = {
    on: (event, handler) => handlers.set(event, handler),
    registerTool: tool => tools.set(tool.name, tool),
    sendUserMessage: send,
    typebox: { Type: { Object: () => ({}), String: () => ({}), Integer: () => ({}), Boolean: () => ({}), Array: () => ({}), Optional: () => ({}) } }
  }
  attachHumanWait(pi, { home, ...(options.externallyUnavailable ? {} : options.world ? { projects: [{ project: 'fixture', client: { run } }] } : { client: { run } }) })
  const emit = (event: string, data?: unknown, current = ctx) => handlers.get(event)?.(data, current)
  const register = (request: object = REQUEST, current = ctx) => tools.get('wait_for_human')!.execute('start', request, undefined, undefined, current)
  const arm = async (request: object = REQUEST) => {
    emit('agent_start')
    expect((await register(request)).isError).toBeUndefined()
    emit('agent_end', DONE)
  }
  const wakeId = (index = 0) => send.mock.calls[index]?.[0].match(/waitId ([\da-f-]{36})/)?.[1]
  const contact = (id: unknown = wakeId(), current = ctx) => tools.get('contact_waiting_human')!.execute('contact', { waitId: id }, undefined, undefined, current)
  const status = () => setStatus.mock.lastCall?.[1]
  const reply = () => emit('input', { source: 'interactive', text: 'Human response' })
  emit('session_start')
  return { emit, register, arm, contact, setStatus, status, send, run, wakeId, reply, ctx, tools }
}

describe('human wait lifecycle on the interactive OMP host', () => {
  it('1. ten-minute threshold: finishes explicitly blocked, no early wake, one actionable attributed wake at 10:00', async () => {
    const r = rig()
    await r.arm()
    expect(r.status()).toBe('Waiting for human reply')
    await vi.advanceTimersByTimeAsync(599_000)
    expect(r.send).not.toHaveBeenCalled()
    expect(r.status()).toBe('Waiting for human reply')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(r.status()).toBe('Human disengaged · reply outstanding')
    expect(r.send).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(REQUEST.question), { deliverAs: 'aside', attribution: 'agent' })
    expect(r.send.mock.lastCall?.[0]).toContain(REQUEST.why)
    expect(r.send.mock.lastCall?.[0]).toContain('not human input, consent, checkpoint approval or permission')
    expect(r.run).not.toHaveBeenCalled()
  })

  it('2. a real reply before expiry prevents the transition, wake and external contact', async () => {
    const r = rig()
    await r.arm()
    await vi.advanceTimersByTimeAsync(TEN_MINUTES - 1)
    r.reply()
    await vi.advanceTimersByTimeAsync(TEN_MINUTES)
    expect(r.status()).toBeUndefined()
    expect(r.send).not.toHaveBeenCalled()
    expect(r.run).not.toHaveBeenCalled()
  })

  it.each(['running', 'ordinary idle', 'tool running', 'worker waiting', 'automatic continuation', 'aborted response', 'subagent'])('3. %s is not a completed human wait', async mode => {
    const r = rig()
    const ctx = mode === 'subagent' ? { ...r.ctx, agent: { kind: 'sub' } } : r.ctx
    r.emit('agent_start', undefined, ctx)
    if (!['running', 'ordinary idle'].includes(mode)) await r.register(REQUEST, ctx)
    if (mode === 'ordinary idle') r.emit('agent_end', DONE)
    if (mode === 'worker waiting') r.emit('agent_end', { ...DONE, willContinue: true, awaitingAsyncWork: true })
    if (mode === 'automatic continuation') r.emit('agent_end', { ...DONE, willContinue: true })
    if (mode === 'aborted response') r.emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'aborted' }] })
    if (mode === 'subagent') r.emit('agent_end', DONE, ctx)
    await vi.advanceTimersByTimeAsync(TEN_MINUTES)
    expect(r.status()).toBeUndefined()
    expect(r.send).not.toHaveBeenCalled()
  })

})

describe('human-wait wake delivery and idempotency', () => {
  it('4. the wake performs only the authorized, exact question request, never grants consent or claims a queued response was sent', async () => {
    const r = rig({ world: true })
    await r.arm({ ...REQUEST, project: 'fixture' })
    expect(r.tools.get('contact_waiting_human')?.approval).toBe('write')
    expect((await r.contact('made-up')).isError).toBe(true)
    await vi.advanceTimersByTimeAsync(TEN_MINUTES)
    const id = r.wakeId()!
    const result = await r.contact(id)
    expect(result.content[0].text).toContain('Request queued (not confirmed sent)')
    expect(result.content[0].text).toContain('Consent and approval are still required')
    expect(r.run).toHaveBeenCalledExactlyOnceWith('ask_human', {
      question: `${REQUEST.question}\n\nWhy this is blocking progress: ${REQUEST.why}`,
      responseRequired: true, humanEngaged: false, waitId: id
    }, undefined)
    expect(humanWaitCurrent(home, id)).toBe(true)
    r.reply()
    expect(humanWaitCurrent(home, id)).toBe(false)
  })

  it('5. reply after the timeout but before wake handling makes that wake stale', async () => {
    const r = rig()
    await r.arm()
    await vi.advanceTimersByTimeAsync(TEN_MINUTES)
    r.reply()
    expect((await r.contact()).content[0].text).toMatch(/stale/)
    expect(r.run).not.toHaveBeenCalled()
    expect(r.status()).toBeUndefined()
  })

  it('5. duplicate turn-end and wake handling do not duplicate external contact', async () => {
    const r = rig()
    await r.arm()
    r.emit('agent_end', DONE)
    r.emit('input', { source: 'extension', text: 'not a human reply' })
    await vi.advanceTimersByTimeAsync(TEN_MINUTES)
    expect((await r.contact()).isError).toBeUndefined()
    expect((await r.contact()).isError).toBe(true)
    r.emit('agent_start')
    expect((await r.register()).isError).toBe(true)
    r.emit('agent_end', DONE)
    await vi.advanceTimersByTimeAsync(TEN_MINUTES * 2)
    expect(r.send).toHaveBeenCalledTimes(1)
    expect(r.run).toHaveBeenCalledTimes(1)
    r.emit('session_shutdown')
  })

})

describe('human-wait re-engagement and contact limitations', () => {
  it('6. a new independent request after re-engagement gets its own ten minutes', async () => {
    const r = rig()
    await r.arm()
    await vi.advanceTimersByTimeAsync(TEN_MINUTES)
    r.reply()
    expect(r.status()).toBeUndefined()
    await r.arm({ question: 'Choose a new target?', why: 'It determines the test matrix.' })
    await vi.advanceTimersByTimeAsync(TEN_MINUTES - 1)
    expect(r.send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(r.wakeId(1)).not.toBe(r.wakeId(0))
    expect(r.send.mock.lastCall?.[0]).toContain('Choose a new target?')
    expect(r.send).toHaveBeenCalledTimes(2)
  })

  it('7. missing route leaves the request and limitation in the conversation and never loops', async () => {
    const r = rig({ externallyUnavailable: true })
    r.emit('agent_start')
    const initial = await r.register()
    expect(initial.content[0].text).toContain(REQUEST.question)
    expect(initial.content[0].text).toContain(REQUEST.why)
    r.emit('agent_end', DONE)
    await vi.advanceTimersByTimeAsync(TEN_MINUTES)
    expect(r.send.mock.lastCall?.[0]).toContain(REQUEST.question)
    expect((await r.contact()).content[0].text).toMatch(/unavailable.*No external message was sent/)
    expect(r.run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(TEN_MINUTES * 2)
    expect(r.send).toHaveBeenCalledTimes(1)
  })

  it.each(['unauthorized', 'operation_unavailable'])('honors an existing dm %s refusal without retrying or bypassing it', async code => {
    const r = rig({ run: async () => ({ ok: false, error: { source: 'dm', code, message: 'fixture refusal' } }) })
    await r.arm()
    await vi.advanceTimersByTimeAsync(TEN_MINUTES)
    expect((await r.contact()).content[0].text).toMatch(/refused or unavailable/)
    expect(humanWaitCurrent(home, r.wakeId()!)).toBe(false)
    expect((await r.contact()).isError).toBe(true)
    expect(r.run).toHaveBeenCalledTimes(1)
  })

  it('reports a host wake refusal honestly without auto-resuming again', async () => {
    const r = rig({ rejectWake: true })
    await r.arm()
    await vi.advanceTimersByTimeAsync(TEN_MINUTES)
    expect(r.status()).toContain('wake unavailable; the request remains in chat')
    await vi.advanceTimersByTimeAsync(TEN_MINUTES)
    expect(r.send).toHaveBeenCalledTimes(1)
  })
})
