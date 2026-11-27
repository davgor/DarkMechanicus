// @vitest-environment jsdom
/**
 * `useCultPipeline` over the fake cults backend: it pages every entry in order once, appends what arrives on a
 * `cults:event` hint, a member's mail push or the recovery poll without showing any entry twice, folds an order's
 * message shown alone into the order, and reads a past run once with no listener or poll.
 */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CultPipelineEntry, CultPipelinePage } from '../../../shared/cults/cultApi'
import type { CommandResult } from '../../../shared/desktop/api'
import { deferred } from '../__mocks__/deferred'
import { FakeChatMail } from '../__mocks__/fakeChatMail'
import { FakeCults, memberDetail, runDetail } from '../__mocks__/fakeCults'
import { FakeDm } from '../__mocks__/fakeDm'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { mergeEntries, PIPELINE_POLL_MS, useCultPipeline } from './useCultPipeline'

let cults: FakeCults
let mail: FakeChatMail
let scheduler: ManualScheduler

const MAGOS = { chatId: 'chat_magos', displayName: 'Magos Vettius', role: 'magos' as const }
const FERRUM = { chatId: 'chat_a', displayName: 'Acolyte Ferrum-3', role: 'acolyte' as const }

function message(seq: number, patch: Partial<CultPipelineEntry> = {}): CultPipelineEntry {
  return {
    seq, at: new Date(Date.UTC(2026, 10, 27, 12, 0, seq)).toISOString(), kind: 'message', eventKind: null, sender: MAGOS, recipients: [FERRUM],
    orderId: null, messageIds: [`mm_${seq}`], inReplyTo: null, text: `message ${seq}`, truncated: false, ...patch
  }
}

beforeEach(() => {
  const dm = new FakeDm()
  cults = new FakeCults()
  mail = new FakeChatMail()
  dm.cults = cults
  dm.chats.mail = mail
  window.dm = dm
  scheduler = new ManualScheduler()
  cults.pipelines = { run_1: Array.from({ length: 450 }, (_, index) => message(index + 1)) }
})

afterEach(() => cleanup())

const seqs = (entries: readonly CultPipelineEntry[]): number[] => entries.map((entry) => entry.seq)
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, index) => from + index)

describe('useCultPipeline', () => {
  it('pages every entry in order, then appends live entries from each hint and the poll with no duplicates', async () => {
    const { result, unmount } = renderHook(() => useCultPipeline('run_1', { live: scheduler, memberChatIds: ['chat_magos', 'chat_a'] }))
    await settle()
    expect(result.current.state.status).toBe('ready')
    expect(seqs(result.current.state.entries)).toEqual(range(1, 450))
    expect(cults.pipelineCalls.map(([, request]) => request.afterSeq)).toEqual([0, 200, 400])

    cults.pipelines.run_1!.push(message(451))
    cults.push(runDetail({}, [memberDetail()]))
    mail.emit({ type: 'mail_state', state: { ...mail.put({ folder: '/w', chatId: 'chat_a' }) } })
    await settle()
    cults.pipelines.run_1!.push(message(452))
    act(() => scheduler.fireIntervals(PIPELINE_POLL_MS))
    await settle()
    // A push for a chat outside the run asks nothing.
    const asked = cults.pipelineCalls.length
    mail.emit({ type: 'mail_state', state: mail.put({ folder: '/w', chatId: 'chat_outsider' }) })
    await settle()
    expect(cults.pipelineCalls).toHaveLength(asked)
    expect(seqs(result.current.state.entries)).toEqual(range(1, 452))
    expect(scheduler.intervals()).toEqual([PIPELINE_POLL_MS])
    unmount()
    expect(scheduler.intervals()).toEqual([])
    expect(cults.listenerCount).toBe(0)
  })

  it('exposes seq, kind, sender, recipients and orderId, and an order replaces its message shown alone', async () => {
    cults.pipelines = { run_1: [message(1, { messageIds: ['mm_o1'] })] }
    const { result } = renderHook(() => useCultPipeline('run_1', { live: scheduler, memberChatIds: [] }))
    await settle()
    const recipients = [FERRUM, { chatId: 'chat_b', displayName: 'Acolyte Vox-4', role: 'acolyte' as const }]
    cults.pipelines.run_1!.push(message(3, { kind: 'order_all', eventKind: 'order_all', orderId: 'co_1', messageIds: ['mm_o1', 'mm_o2'], recipients, text: 'Conclude.' }))
    act(() => scheduler.fireIntervals(PIPELINE_POLL_MS))
    await settle()
    expect(result.current.state.entries.map(({ seq, kind, sender, recipients: to, orderId }) => ({ seq, kind, sender, to, orderId }))).toEqual([
      { seq: 3, kind: 'order_all', sender: MAGOS, to: recipients, orderId: 'co_1' }
    ])
  })

  it('reads a past run once, with no poll and no listener', async () => {
    const { result } = renderHook(() => useCultPipeline('run_1', { live: null, memberChatIds: ['chat_a'] }))
    await settle()
    expect(seqs(result.current.state.entries)).toEqual(range(1, 450))
    expect(scheduler.intervals()).toEqual([])
    expect(cults.listenerCount).toBe(0)
  })

  it('merges overlapping pages without duplicates', () => {
    const first = [message(1), message(2)]
    expect(seqs(mergeEntries(first, [message(2), message(3)]))).toEqual([1, 2, 3])
    expect(mergeEntries(first, [message(1)])).toEqual(first)
  })
})

/** Makes each pipeline request wait until the returned gate opens, then answer as the fake would. */
function holdPipeline(): () => void {
  const gate = deferred()
  const answer = cults.pipeline
  cults.pipeline = async (runId, request) => {
    await gate.promise
    return answer(runId, request)
  }
  return gate.resolve
}

const refused = (message: string): Promise<CommandResult<CultPipelinePage>> =>
  Promise.resolve({ ok: false, error: { code: 'internal', message } })

describe('useCultPipeline failures', () => {
  it('asks for no further page when the run is closed while a page is in flight', async () => {
    const release = holdPipeline()
    const { result, unmount } = renderHook(() => useCultPipeline('run_1', { live: scheduler, memberChatIds: [] }))
    await settle()
    unmount()
    release()
    await settle()
    expect(cults.pipelineCalls).toHaveLength(1)
    expect(result.current.state).toEqual({ status: 'loading', entries: [] })
  })

  it('shows main’s refusal and keeps the entries already shown', async () => {
    const { result } = renderHook(() => useCultPipeline('run_1', { live: scheduler, memberChatIds: [] }))
    await settle()
    cults.pipeline = () => refused('Run log unreadable.')
    act(() => scheduler.fireIntervals(PIPELINE_POLL_MS))
    await settle()
    expect(result.current.state.status).toBe('error')
    expect(result.current.state).toMatchObject({ message: 'Run log unreadable.' })
    expect(seqs(result.current.state.entries)).toEqual(range(1, 450))
  })

  it('reports a rejection that is not an Error by its text', async () => {
    cults.pipeline = () => Promise.reject('bridge closed')
    const { result } = renderHook(() => useCultPipeline('run_1', { live: null, memberChatIds: [] }))
    await settle()
    expect(result.current.state).toEqual({ status: 'error', entries: [], message: 'bridge closed' })
  })

  it('applies nothing when a failure lands after the run is closed', async () => {
    const gate = deferred()
    cults.pipeline = async () => {
      await gate.promise
      return refused('Too late.')
    }
    const { result, unmount } = renderHook(() => useCultPipeline('run_1', { live: null, memberChatIds: [] }))
    await settle()
    unmount()
    gate.resolve()
    await settle()
    expect(result.current.state).toEqual({ status: 'loading', entries: [] })
  })
})

describe('useCultPipeline mail hints and full text', () => {
  it('asks again when a member chat’s mailbox is removed, and not for one outside the run', async () => {
    renderHook(() => useCultPipeline('run_1', { live: scheduler, memberChatIds: ['chat_a'] }))
    await settle()
    const asked = cults.pipelineCalls.length
    mail.remove('/w', 'chat_outsider')
    await settle()
    expect(cults.pipelineCalls).toHaveLength(asked)
    mail.remove('/w', 'chat_a')
    await settle()
    expect(cults.pipelineCalls).toHaveLength(asked + 1)
    expect(cults.pipelineCalls.at(-1)).toEqual(['run_1', { afterSeq: 450, limit: 200 }])
  })

  it('reads an entry’s whole text, or null when refused or when that entry is gone', async () => {
    const { result } = renderHook(() => useCultPipeline('run_1', { live: null, memberChatIds: [] }))
    await settle()
    expect(await result.current.fullText(7)).toBe('message 7')
    expect(cults.pipelineCalls.at(-1)).toEqual(['run_1', { afterSeq: 6, limit: 1, full: true }])

    cults.pipelines.run_1 = cults.pipelines.run_1!.filter((entry) => entry.seq !== 9)
    expect(await result.current.fullText(9)).toBeNull()

    cults.pipeline = () => refused('Gone.')
    expect(await result.current.fullText(7)).toBeNull()
  })
})
