// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatItem } from '../../../shared/agents/chat'
import type { AttemptTimelineView } from '../../../shared/domain/activity'
import type { RunView } from '../../../shared/domain/views'
import { mountChatView, toolCall, transcript, type Mounted } from '../__mocks__/chatViewKit'
import { settle } from '../__mocks__/settle'

afterEach(cleanup)

const RUN = 'rn_01k8zq3v7c2m5n9p4r6t8w0xyb'
const ATTEMPT = 'at_01k8zq4a1b2c3d4e5f6g7h8j9k'
const TICKET = 'tk_01k8zq2m3n4p5q6r7s8t9v0w1x'
const EPIC = 'ep_01k8zq2a3b4c5d6e7f8g9h0j1k'
const TOKEN = `${ATTEMPT}.Qx7vT2mN9pL4kR8sW1yZ3bC6dF0gH5jA`

/** A Dark Mechanicus call as the adapters store it, completed unless the patch says otherwise. */
function dmCall(id: string, tool: string, input: Record<string, string>, patch: Partial<Extract<ChatItem, { kind: 'tool_call' }>> = {}): ChatItem {
  return toolCall(id, { name: `mcp__darkmechanicus__${tool}`, input, resultSummary: null, ...patch })
}

/** The desktop's answers for the run and the attempt the calls name: DM-12 is the ticket of the run's epic. */
function knowRun(dm: Mounted['dm']): void {
  dm.handlers.getRun = () => ({ id: RUN, epicId: EPIC, tickets: [{ ticketId: TICKET, key: 'DM-12' }] }) as unknown as RunView
  dm.handlers.getAttemptTimeline = () => ({ attemptId: ATTEMPT, runId: RUN, ticketId: TICKET }) as unknown as AttemptTimelineView
}

async function mountWith(items: ChatItem[], know = true, options: Parameters<typeof mountChatView>[1] = {}): Promise<Mounted> {
  const mounted = await mountChatView([], options)
  if (know) {
    knowRun(mounted.dm)
  }
  items.forEach((item) => act(() => mounted.dm.chats.emitItem('chat_1', item)))
  await settle()
  return mounted
}

const marker = (name: RegExp | string): HTMLElement => within(transcript().getByRole('listitem', { name: /^Action:/ })).getByText(name)

describe('Dark Mechanicus calls as markers (c2)', () => {
  it('shows each call of the Dark Mechanicus server as a compact marker with the ticket key, and any other call as an ordinary call', async () => {
    await mountWith([
      dmCall('c1', 'claim_ticket', { runId: RUN, ticketId: TICKET }, { resultSummary: `{"ok":true,"data":{"attempt":{"id":"${ATTEMPT}","runId":"${RUN}","ticketId":"${TICKET}"}}}` }),
      dmCall('c2', 'accept_attempt', { attemptId: ATTEMPT }),
      dmCall('c3', 'reject_attempt', { attemptId: ATTEMPT }),
      toolCall('c4', { name: 'Bash', input: { command: 'npm test' } })
    ])

    expect(screen.getByRole('button', { name: /claimed DM-12/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /accepted DM-12/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /rejected DM-12/ })).toBeTruthy()
    expect(screen.getByRole('listitem', { name: 'Tool call: Bash' })).toBeTruthy()
    expect(screen.queryByRole('listitem', { name: /Tool call: mcp__darkmechanicus/ })).toBeNull()
  })

  it('knows the calls of Codex too, and says what a call that has no ticket did', async () => {
    await mountWith([
      toolCall('c1', { name: 'darkmechanicus.accept_attempt', input: { attemptId: ATTEMPT }, resultSummary: null }),
      dmCall('c2', 'submit_sprint_report', { runId: RUN, sprintId: 'sp_1' })
    ])

    expect(screen.getByRole('button', { name: /accepted DM-12/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /sprint report filed/ })).toBeTruthy()
  })

  it('says "a ticket" until the key is found, then names it', async () => {
    const mounted = await mountChatView([])
    knowRun(mounted.dm)
    const hold = mounted.dm.holdNext('getAttemptTimeline')
    act(() => mounted.dm.chats.emitItem('chat_1', dmCall('c1', 'accept_attempt', { attemptId: ATTEMPT })))
    await settle()

    expect(marker('accepted a ticket')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /accepted/ })).toBeNull()

    hold.resolve()
    await settle()
    expect(marker('accepted DM-12')).toBeTruthy()
  })

})

describe('Dark Mechanicus markers open the ticket or epic (c2)', () => {
  it('opens the ticket in its epic when its marker is pressed, on the attempt\'s Activity tab when the call names an attempt', async () => {
    const { links } = await mountWith([dmCall('c1', 'accept_attempt', { attemptId: ATTEMPT }), dmCall('c2', 'get_ticket', { ticketId: TICKET, epicId: EPIC })])

    fireEvent.click(screen.getByRole('button', { name: /accepted DM-12/ }))
    fireEvent.click(screen.getByRole('button', { name: /get ticket/ }))

    expect(links.tickets).toEqual([
      { epicId: EPIC, ticketId: TICKET, attemptId: ATTEMPT },
      { epicId: EPIC, ticketId: TICKET, attemptId: null }
    ])
    expect(links.epics).toEqual([])
  })

  it('opens the epic when the call is about an epic or a run and no ticket', async () => {
    const { links } = await mountWith([
      dmCall('c1', 'start_run', { epicId: EPIC }, { resultSummary: `{"ok":true,"data":{"id":"${RUN}","epicId":"${EPIC}"}}` }),
      dmCall('c2', 'get_checkpoint', { runId: RUN })
    ])

    fireEvent.click(screen.getByRole('button', { name: /started the run/ }))
    fireEvent.click(screen.getByRole('button', { name: /read the checkpoint/ }))

    expect(links.epics).toEqual([EPIC, EPIC])
    expect(links.tickets).toEqual([])
  })

  it('leaves a marker that cannot be tied to a ticket or epic as plain text, and one in a view with nowhere to go', async () => {
    await mountWith([dmCall('c1', 'accept_attempt', { attemptId: ATTEMPT })], false)
    expect(marker('accepted a ticket').closest('button')).toBeNull()
    cleanup()

    await mountWith([dmCall('c1', 'accept_attempt', { attemptId: ATTEMPT })], true, { noNavigation: true })
    expect(marker('accepted DM-12')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /accepted/ })).toBeNull()
  })

  it('never shows a claim token or an id, however the call carries them', async () => {
    await mountWith([
      dmCall('c1', 'submit_attempt', { attemptId: ATTEMPT, claimToken: TOKEN }, { resultSummary: `{"ok":true,"data":{"id":"${ATTEMPT}","claimToken":"${TOKEN}"}}` }),
      dmCall('c2', 'heartbeat_attempt', { attemptId: ATTEMPT, claimToken: '[claim token masked]' }, { status: 'failed', resultSummary: `Refused for ${TOKEN}` })
    ])

    const text = screen.getByRole('log', { name: 'Transcript' }).textContent ?? ''
    expect(text).toContain('submitted DM-12')
    expect(text).not.toContain('Qx7vT2mN9pL')
    expect(text).not.toContain(ATTEMPT)
    expect(text).not.toContain(TICKET)
  })

  it('shows what a refused call says, and an hourglass while a call is still running', async () => {
    await mountWith([
      dmCall('c1', 'claim_ticket', { runId: RUN, ticketId: TICKET }, { status: 'failed', resultSummary: '{"ok":false,"error":{"code":"conflict","message":"Another worker holds it."}}' }),
      dmCall('c2', 'accept_attempt', { attemptId: ATTEMPT }, { status: 'running' })
    ])

    expect(screen.getByRole('button', { name: /could not claim DM-12/ }).textContent).toContain('Another worker holds it.')
    const running = screen.getByRole('button', { name: /accepting DM-12/ })
    expect(running.querySelector('[data-icon="hourglass"]')).not.toBeNull()
  })
})
