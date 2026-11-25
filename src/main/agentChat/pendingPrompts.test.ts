import { afterEach, expect, it, vi } from 'vitest'
import type { PendingPrompt } from '../../shared/agents/agentChat'
import { PendingPrompts, type ArbiterOutcome } from './pendingPrompts'

const prompt = (id: string): PendingPrompt => ({ id, kind: 'approval', title: id, detail: '', threadId: null,
  callsign: null, attributed: true, arbitration: { state: 'off', reason: null }, options: [{ id: 'allow_once', label: 'Allow' }, { id: 'deny', label: 'Deny' }] })
function deferred() {
  // Match the repository's pre-Promise.withResolvers TypeScript library.
  let resolve!: (verdict: ArbiterOutcome) => void
  let reject!: (error: Error) => void
  const result = new Promise<ArbiterOutcome>((yes, no) => { resolve = yes; reject = no })
  return { result, resolve, reject, cancel: vi.fn() }
}
afterEach(() => vi.useRealTimers())

it('holds FIFO heads for replay without a timer and refuses queued, stale and unknown answers', async () => {
  vi.useFakeTimers()
  const publish = vi.fn(), answer = vi.fn(), apply = vi.fn(() => [])
  const registry = new PendingPrompts({ publish, answer })
  const first = prompt('first'), second = prompt('second')
  registry.update([first])
  registry.update([first, second])
  await vi.advanceTimersByTimeAsync(600_000)
  expect(registry.snapshot()).toEqual(first)
  expect(publish).toHaveBeenCalledTimes(1)
  expect(answer).not.toHaveBeenCalled()
  for (const id of ['second', 'unknown']) expect(() => registry.answer(id, apply)).toThrow(expect.objectContaining({ code: 'stale_prompt' }))
  expect(apply).not.toHaveBeenCalled()
  registry.answer('first', () => [second])
  expect(registry.snapshot()).toEqual(second)
  expect(() => registry.answer('first', apply)).toThrow(expect.objectContaining({ code: 'stale_prompt' }))
  registry.answer('second', () => [])
  expect(registry.snapshot()).toBeNull()
  expect(publish.mock.calls.map(([value]) => value?.id ?? null)).toEqual(['first', 'second', null])
})

it('arbitrates only newly exposed heads and preserves deciding/escalated replay', async () => {
  const jobs = [deferred(), deferred()], publish = vi.fn(), answer = vi.fn()
  let index = 0
  const arbitrate = vi.fn(() => jobs[index++])
  const registry = new PendingPrompts({ publish, answer, arbitrate })
  const first = prompt('first'), second = prompt('second')
  registry.update([first, second])
  expect(arbitrate).toHaveBeenCalledTimes(1)
  expect(registry.snapshot()?.arbitration).toEqual({ state: 'deciding', reason: null })
  jobs[0].resolve({ decision: 'escalate', reason: 'Ask the person' })
  await Promise.resolve()
  registry.update([first, second])
  expect(registry.snapshot()?.arbitration).toEqual({ state: 'escalated', reason: 'Ask the person' })
  registry.answer('first', () => [second])
  expect(arbitrate).toHaveBeenCalledTimes(2)
  jobs[1].resolve({ decision: 'allow_once', reason: 'Routine command' })
  await Promise.resolve()
  expect(answer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'second' }), { decision: 'allow_once', reason: 'Routine command' })
})

for (const action of ['person', 'withdraw', 'exit'] as const) it(`drops late verdicts after ${action} and cancels running arbitration`, async () => {
  const job = deferred(), answer = vi.fn(), publish = vi.fn()
  const registry = new PendingPrompts({ publish, answer, arbitrate: () => job })
  registry.update([prompt('first')])
  if (action === 'person') registry.answer('first', () => [])
  else if (action === 'withdraw') registry.update([])
  else registry.clear()
  expect(job.cancel).toHaveBeenCalledTimes(1)
  expect(registry.snapshot()).toBeNull()
  job.resolve({ decision: 'deny', reason: 'Too late' })
  await Promise.resolve()
  expect(answer).not.toHaveBeenCalled()
  expect(publish).toHaveBeenLastCalledWith(null)
  expect(() => registry.answer('first', () => [])).toThrow(expect.objectContaining({ code: 'stale_prompt' }))
})

it('fences a previous arbitration even if a later prompt reuses its id', async () => {
  const old = deferred(), next = deferred(), answer = vi.fn()
  const arbitrate = vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(next)
  const registry = new PendingPrompts({ publish: vi.fn(), answer, arbitrate })
  registry.update([prompt('same')]); registry.clear(); registry.update([prompt('same')])
  old.resolve({ decision: 'allow_once', reason: 'Obsolete' })
  await Promise.resolve()
  expect(answer).not.toHaveBeenCalled()
  expect(registry.snapshot()?.arbitration.state).toBe('deciding')
})

it('keeps a rejected answer pending and prevents reentrant second writes', () => {
  const registry = new PendingPrompts({ publish: vi.fn(), answer: vi.fn() })
  registry.update([prompt('first')])
  expect(() => registry.answer('first', () => { throw new Error('write failed') })).toThrow('write failed')
  expect(registry.snapshot()?.id).toBe('first')
  registry.answer('first', () => {
    expect(() => registry.answer('first', () => [])).toThrow(expect.objectContaining({ code: 'stale_prompt' }))
    return []
  })
})

it('masks and bounds reasons, and escalates rejected arbiters without an answer', async () => {
  const job = deferred(), answer = vi.fn()
  const registry = new PendingPrompts({ publish: vi.fn(), answer, arbitrate: () => job })
  registry.update([prompt('first')])
  job.resolve({ decision: 'escalate', reason: `dmg_${'a1'.repeat(32)} ${'x'.repeat(600)}` })
  await Promise.resolve()
  expect(registry.snapshot()?.arbitration.reason).toHaveLength(500)
  expect(registry.snapshot()?.arbitration.reason).not.toContain('dmg_')
  const failing = deferred()
  const other = new PendingPrompts({ publish: vi.fn(), answer, arbitrate: () => failing })
  other.update([prompt('second')]); failing.reject(new Error('private failure'))
  await Promise.resolve(); await Promise.resolve()
  expect(other.snapshot()?.arbitration).toEqual({ state: 'escalated', reason: 'Arbitration failed.' })
  expect(answer).not.toHaveBeenCalled()
})

it('never applies allow_chat or approval decisions to questions from the seam', async () => {
  const job = deferred(), answer = vi.fn()
  const registry = new PendingPrompts({ publish: vi.fn(), answer, arbitrate: () => job })
  registry.update([{ ...prompt('question'), kind: 'question' }])
  job.resolve({ decision: 'deny', reason: 'Not a question answer' })
  await Promise.resolve()
  expect(registry.snapshot()?.arbitration.state).toBe('escalated')
  expect(answer).not.toHaveBeenCalled()
  const invalid = deferred()
  const other = new PendingPrompts({ publish: vi.fn(), answer, arbitrate: () => invalid })
  other.update([prompt('approval')])
  invalid.resolve({ decision: 'allow_chat', reason: 'Forbidden' } as unknown as ArbiterOutcome)
  await Promise.resolve()
  expect(other.snapshot()?.arbitration.state).toBe('escalated')
  expect(answer).not.toHaveBeenCalled()
})
