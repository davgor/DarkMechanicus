// @vitest-environment jsdom
/**
 * The Activity tab of an attempt worked in a chat's terminal: the command layer's timeline, and an Open terminal link
 * to the chat main finds by grant (`chats:boundTerminal`); an old chat's item-based binding still shows next to it.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BoundThread } from '../../../shared/agents/chatApi'
import type { ActivityEntry, AttemptTimelineView } from '../../../shared/domain/activity'
import { FakeDm } from '../__mocks__/fakeDm'
import { chatRecord } from '../__mocks__/fixtures'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { attempt } from '../epic/__mocks__/fixtures'
import { ActivityTab } from './ActivityTab'

let dm: FakeDm
let scheduler: ManualScheduler
let opened: [string, string | undefined][]

const ATTEMPT = 'at_202_2'
const FOLDER = '/repo'
const BASE = { sessionId: 'ss_cli', attemptId: ATTEMPT, ticketId: 'tk_202' }

function claim(): ActivityEntry {
  const worker = { label: 'worker-a', modelId: null, hostId: null, effort: null, rationale: null }
  return { ...BASE, kind: 'claim', id: 'event:1', at: '2026-09-30T11:00:00.000Z', number: 2, worker }
}

function note(seq: number, text: string): ActivityEntry {
  return { ...BASE, kind: 'note', id: `event:${seq}`, at: '2026-09-30T11:05:00.000Z', text, step: null }
}

function page(entries: ActivityEntry[], cursor: number): AttemptTimelineView {
  return {
    attemptId: ATTEMPT,
    runId: 'rn_2',
    ticketId: 'tk_202',
    state: 'running',
    isLive: true,
    cursor,
    entries,
    sessions: [{ id: 'ss_cli', role: 'orchestrator', label: 'dm', grantId: 'gr_1' }]
  }
}

function renderTab(): void {
  render(
    <ActivityTab
      folderPath={FOLDER}
      attempts={[attempt('DM-202', 2, 'running')]}
      attemptId={ATTEMPT}
      onChoose={() => undefined}
      onOpenChat={(chatId, threadId) => opened.push([chatId, threadId])}
      scheduler={scheduler}
    />
  )
}

beforeEach(() => {
  scheduler = new ManualScheduler()
  opened = []
  dm = new FakeDm()
  window.dm = dm
  dm.chats.chats = [chatRecord({ id: 'chat_t', folder: FOLDER, role: 'orchestrator' })]
})

afterEach(cleanup)

describe('Activity tab of an attempt worked in a terminal chat', () => {
  it('shows the command layer’s timeline and an Open terminal link to the chat bound by grant, which opens it', async () => {
    dm.chats.terminals.attempts[ATTEMPT] = 'chat_t'
    dm.handlers.getAttemptTimeline = () => page([claim(), note(2, 'Wrote the tests')], 2)
    renderTab()

    fireEvent.click(await screen.findByRole('button', { name: 'Open terminal' }))

    expect(opened).toEqual([['chat_t', undefined]])
    expect(screen.getByText('Wrote the tests')).toBeTruthy()
    expect(dm.chats.callsOf('boundTerminal')[0]).toEqual([{ folder: FOLDER, attemptId: ATTEMPT }])
    expect(screen.queryByRole('button', { name: 'Open chat' })).toBe(null)
    expect(dm.chats.callsOf('read')).toEqual([])
  })

  it('asks again as the timeline moves until the claim is bound, then keeps the link', async () => {
    const pages = [page([], 0), page([claim()], 1), page([claim()], 1)]
    dm.handlers.getAttemptTimeline = () => (pages.length > 1 ? pages.shift() : pages[0])
    renderTab()
    await settle()
    expect(screen.queryByRole('button', { name: 'Open terminal' })).toBe(null)

    dm.chats.terminals.attempts[ATTEMPT] = 'chat_t'
    act(() => scheduler.fireIntervals())
    await settle()

    expect(await screen.findByRole('button', { name: 'Open terminal' })).toBeTruthy()
    const asked = dm.chats.callsOf('boundTerminal').length
    act(() => scheduler.fireIntervals())
    await settle()
    expect(dm.chats.callsOf('boundTerminal')).toHaveLength(asked)
  })
})

describe('Activity tab links beside each other, and none', () => {
  it('still shows an old chat’s item-based binding beside it, each link opening its own chat', async () => {
    const worker: BoundThread = { folder: FOLDER, chatId: 'chat_old', threadId: 'th_1', role: 'worker' }
    dm.chats.chats.push(chatRecord({ id: 'chat_old', folder: FOLDER, role: 'orchestrator' }))
    dm.chats.transcripts.chat_old = []
    dm.chats.bound.attempts[ATTEMPT] = [worker]
    dm.chats.terminals.attempts[ATTEMPT] = 'chat_t'
    dm.handlers.getAttemptTimeline = () => page([claim()], 1)
    renderTab()

    fireEvent.click(await screen.findByRole('button', { name: 'Open chat' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Open terminal' }))

    expect(opened).toEqual([
      ['chat_old', 'th_1'],
      ['chat_t', undefined]
    ])
  })

  it('shows no link when no chat is bound by grant, or the lookup fails', async () => {
    dm.chats.failures.boundTerminal = { code: 'internal', message: 'No lookup.' }
    dm.handlers.getAttemptTimeline = () => page([claim()], 1)
    renderTab()
    await screen.findByText(/Claimed by worker-a/)
    await settle()

    expect(screen.queryByRole('button', { name: 'Open terminal' })).toBe(null)
    expect(screen.queryByRole('alert')).toBe(null)
  })
})
