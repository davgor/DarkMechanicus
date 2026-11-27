import { describe, expect, it, vi } from 'vitest'
import type { EpicDetailView, RunView, TicketDetailView } from '../../shared/domain/views'
import type { AttemptTimelineView } from '../../shared/domain/activity'
import type { ActivityBinding } from '../agents/activityBindings'
import { readArbiterContext, ticketKeyOfAttempt, type ArbiterReads } from './arbiterContext'

const RUN = 'rn_01j0000000000000000000000r'
const EPIC = 'ep_01j0000000000000000000000e'
const ATTEMPT = 'at_01j0000000000000000000000a'
const THREAD = 'thread:toolu_worker'
const INTENT = '# Agent chats\nWhy.\n## Standards\nRun targeted checks.\n### Windows\nUse path.join.\n## Design\nNot for the arbiter.'
const BINDING: ActivityBinding = { chatId: 'ch_1', folder: 'C:\\repo', threadId: THREAD, kind: 'attempt', attemptId: ATTEMPT, role: 'worker' }

/** A stub workspace over one run, epic, attempt and ticket; `fail` names a read that throws. */
function workspace(fail?: keyof ArbiterReads, attemptRun = RUN) {
  const reads = {
    getRun: vi.fn(async ({ runId }: { runId?: string }) => (runId === RUN ? { id: RUN, epicId: EPIC } as RunView : null)),
    getEpic: vi.fn(async () => ({ id: EPIC, intent: INTENT }) as EpicDetailView),
    getAttemptTimeline: vi.fn(async () => ({ attemptId: ATTEMPT, runId: attemptRun, ticketId: 'tk_1' }) as AttemptTimelineView),
    getTicket: vi.fn(async (input: { epicId: string; ticketId: string; view: 'saved' | 'draft' }) => ({
      epicId: input.epicId, view: input.view,
      ticket: { id: input.ticketId, key: 'DM-442', title: 'Run the tests', body: 'Run **all** the tests.',
        acceptanceCriteria: [{ id: 'c1', text: 'Tests pass' }, { id: 'c2', text: 'Logs kept' }] }
    }) as TicketDetailView)
  }
  if (fail) reads[fail].mockRejectedValue(new Error(`${fail} failed`))
  return reads
}

const STANDARDS = 'Run targeted checks.\n### Windows\nUse path.join.'

describe('readArbiterContext', () => {
  it('a bound worker prompt gets its ticket key, title, body and criteria, plus the Standards section', async () => {
    const reads = workspace()
    expect(await readArbiterContext(reads, { chat: { runId: RUN }, threadId: THREAD, binding: BINDING })).toEqual({
      ticket: { key: 'DM-442', title: 'Run the tests', body: 'Run **all** the tests.', acceptance: ['Tests pass', 'Logs kept'] },
      standards: STANDARDS
    })
    expect(reads.getTicket).toHaveBeenCalledExactlyOnceWith({ epicId: EPIC, ticketId: 'tk_1', view: 'saved' })
    expect(reads.getAttemptTimeline).toHaveBeenCalledExactlyOnceWith({ attemptId: ATTEMPT })
  })

  it('a main-thread prompt gets Standards only, with no ticket read', async () => {
    const reads = workspace()
    expect(await readArbiterContext(reads, { chat: { runId: RUN }, threadId: null, binding: null })).toEqual({ ticket: null, standards: STANDARDS })
    expect(reads.getAttemptTimeline).not.toHaveBeenCalled()
    expect(reads.getTicket).not.toHaveBeenCalled()
  })

  it('an unbound worker thread, or a binding of another thread, gets Standards only', async () => {
    const reads = workspace()
    expect(await readArbiterContext(reads, { chat: { runId: RUN }, threadId: THREAD, binding: null })).toEqual({ ticket: null, standards: STANDARDS })
    expect(await readArbiterContext(reads, { chat: { runId: RUN }, threadId: 'thread:other', binding: BINDING })).toEqual({ ticket: null, standards: STANDARDS })
    expect(reads.getTicket).not.toHaveBeenCalled()
  })

  for (const fail of ['getRun', 'getEpic', 'getAttemptTimeline', 'getTicket'] as const) it(`a throwing ${fail} rejects`, async () => {
    await expect(readArbiterContext(workspace(fail), { chat: { runId: RUN }, threadId: THREAD, binding: BINDING })).rejects.toThrow(`${fail} failed`)
  })

  it('an unknown run or an attempt of another run rejects; a chat with no run gives nulls', async () => {
    await expect(readArbiterContext(workspace(), { chat: { runId: 'rn_01j0000000000000000000000x' }, threadId: null, binding: null }))
      .rejects.toThrow('The run of the chat was not found.')
    expect(await readArbiterContext(workspace(), { chat: { runId: undefined }, threadId: null, binding: null })).toEqual({ ticket: null, standards: null })
    await expect(readArbiterContext(workspace(undefined, 'rn_01j0000000000000000000000x'), { chat: { runId: RUN }, threadId: THREAD, binding: BINDING }))
      .rejects.toThrow('The bound attempt belongs to another run.')
  })

  it('an epic with no Standards section gives a null section and keeps the ticket', async () => {
    const reads = workspace()
    reads.getEpic.mockResolvedValue({ id: EPIC, intent: '# Epic\n## Design\nOnly design.' } as EpicDetailView)
    expect(await readArbiterContext(reads, { chat: { runId: RUN }, threadId: THREAD, binding: BINDING })).toMatchObject({ ticket: { key: 'DM-442' }, standards: null })
  })
})

describe('ticketKeyOfAttempt', () => {
  it('returns the ticket key of the attempt', async () => {
    const reads = workspace()
    expect(await ticketKeyOfAttempt(reads, ATTEMPT)).toBe('DM-442')
    expect(reads.getRun).toHaveBeenCalledExactlyOnceWith({ runId: RUN })
    expect(reads.getTicket).toHaveBeenCalledExactlyOnceWith({ epicId: EPIC, ticketId: 'tk_1', view: 'saved' })
  })

  for (const fail of ['getRun', 'getAttemptTimeline', 'getTicket'] as const) it(`returns null when ${fail} throws`, async () => {
    expect(await ticketKeyOfAttempt(workspace(fail), ATTEMPT)).toBeNull()
  })

  it('returns null when the attempt\'s run is not found', async () => {
    expect(await ticketKeyOfAttempt(workspace(undefined, 'rn_01j0000000000000000000000x'), ATTEMPT)).toBeNull()
  })
})
