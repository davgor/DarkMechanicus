// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { approvalDecision, approvalRequest, mountChatView, REF, transcript } from '../__mocks__/chatViewKit'
import { settle } from '../__mocks__/settle'

afterEach(cleanup)

const cards = (): HTMLElement[] => screen.queryAllByRole('article', { name: /^Approval request/ })
const buttonsOf = (card: HTMLElement): string[] => within(card).queryAllByRole('button').map((button) => button.textContent ?? '')

describe('ApprovalCard asking', () => {
  it('shows the exact command and where it runs, with the three answers', async () => {
    await mountChatView([approvalRequest('q1', { input: { command: 'npm install --save-dev vitest', description: 'Add the test runner' } })])
    const [card] = cards()
    expect(card).toBeTruthy()
    const inside = within(card as HTMLElement)
    expect(inside.getByText('Run a command')).toBeTruthy()
    expect(inside.getByText('npm install --save-dev vitest')).toBeTruthy()
    expect(inside.getByText('Working directory').nextElementSibling?.textContent).toBe('/a')
    expect(inside.getByText('Add the test runner')).toBeTruthy()
    expect(buttonsOf(card as HTMLElement)).toEqual(['Allow once', 'Allow for this chat', 'Deny'])
  })

  it('shows the file and a diff summary for an edit', async () => {
    await mountChatView([
      approvalRequest('q1', {
        category: 'file_edit',
        tool: 'Edit',
        summary: 'Edit /a/src/index.ts',
        input: { file_path: '/a/src/index.ts', old_string: 'const port = 80', new_string: 'const port = 8080\nconst host = "0.0.0.0"' }
      })
    ])
    const inside = within(cards()[0] as HTMLElement)
    expect(inside.getByText('Edit a file')).toBeTruthy()
    expect(inside.getByText('/a/src/index.ts')).toBeTruthy()
    expect(inside.getByText('Replaces 1 line with 2 lines')).toBeTruthy()
    expect(inside.getByText(/const port = 8080/).textContent).toBe('+ const port = 8080')
    expect(inside.getByText(/const port = 80$/).textContent).toBe('- const port = 80')
    expect(inside.queryByText('Working directory')).toBeNull()
  })

  it('renders a request with no detail from its summary, still with the three answers', async () => {
    await mountChatView([approvalRequest('q1', { category: 'other', tool: 'WebFetch', summary: 'Use WebFetch', input: undefined })])
    const [card] = cards()
    expect(within(card as HTMLElement).getByText('Use WebFetch', { selector: 'p.chat-approval-summary' })).toBeTruthy()
    expect(buttonsOf(card as HTMLElement)).toEqual(['Allow once', 'Allow for this chat', 'Deny'])
  })
})

describe('ApprovalCard answering', () => {
  it('sends each button’s decision through chats:answerApproval', async () => {
    const { dm } = await mountChatView([approvalRequest('q1'), approvalRequest('q2'), approvalRequest('q3')])
    const [first, second, third] = cards() as [HTMLElement, HTMLElement, HTMLElement]
    fireEvent.click(within(first).getByRole('button', { name: 'Allow once' }))
    await settle()
    fireEvent.click(within(second).getByRole('button', { name: 'Allow for this chat' }))
    await settle()
    fireEvent.click(within(third).getByRole('button', { name: 'Deny' }))
    await settle()
    expect(dm.chats.callsOf('answerApproval')).toEqual([
      [{ ...REF, requestId: 'q1', decision: 'allow_once' }],
      [{ ...REF, requestId: 'q2', decision: 'allow_chat' }],
      [{ ...REF, requestId: 'q3', decision: 'deny' }]
    ])
  })

  it('swaps the buttons for the decision once it is stored, for a request that arrives while the chat is open', async () => {
    const { dm } = await mountChatView([])
    act(() => dm.chats.emitItem('chat_1', approvalRequest('q1')))
    expect(buttonsOf(cards()[0] as HTMLElement)).toHaveLength(3)

    fireEvent.click(within(cards()[0] as HTMLElement).getByRole('button', { name: 'Allow once' }))
    await settle()

    const card = within(cards()[0] as HTMLElement)
    expect(card.getByText('Allowed once')).toBeTruthy()
    expect(card.queryAllByRole('button')).toHaveLength(0)
    expect(cards()).toHaveLength(1)
  })

  it('says why an answer failed and keeps the buttons, so it can be tried again', async () => {
    const { dm } = await mountChatView([approvalRequest('q1')])
    dm.chats.failures.answerApproval = { code: 'not_found', message: 'That approval request is no longer waiting for an answer.' }
    fireEvent.click(within(cards()[0] as HTMLElement).getByRole('button', { name: 'Deny' }))
    await settle()
    const card = within(cards()[0] as HTMLElement)
    expect(card.getByRole('alert').textContent).toContain('no longer waiting')
    expect(buttonsOf(cards()[0] as HTMLElement)).toEqual(['Allow once', 'Allow for this chat', 'Deny'])
    expect((card.getByRole('button', { name: 'Deny' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('ApprovalCard answered', () => {
  it('shows the decision and no buttons, in the place of the request', async () => {
    await mountChatView([approvalRequest('q1'), approvalDecision('q1', 'deny')])
    expect(cards()).toHaveLength(1)
    const card = within(cards()[0] as HTMLElement)
    expect(card.getByText('Denied')).toBeTruthy()
    expect(card.getByText('npm install')).toBeTruthy()
    expect(card.queryAllByRole('button')).toHaveLength(0)
    expect(transcript().queryByText(/Approval answered/)).toBeNull()
  })

  it('shows what an earlier Allow for this chat answered, and a request nobody answered', async () => {
    await mountChatView([approvalRequest('q1'), approvalDecision('q1', 'allow_chat', true), approvalRequest('q2'), approvalDecision('q2', 'cancelled')])
    const [automatic, cancelled] = cards() as [HTMLElement, HTMLElement]
    expect(within(automatic).getByText('Allowed for this chat')).toBeTruthy()
    expect(within(automatic).getByText('Answered automatically by an earlier Allow for this chat.')).toBeTruthy()
    expect(within(cancelled).getByText('Cancelled')).toBeTruthy()
    expect(within(cancelled).getByText('No answer reached the agent.')).toBeTruthy()
    expect(buttonsOf(automatic)).toEqual([])
    expect(buttonsOf(cancelled)).toEqual([])
  })

  it('still shows a decision whose request is not in the transcript', async () => {
    await mountChatView([approvalDecision('lost', 'allow_once')])
    expect(transcript().getByText('Approval answered: allowed once.')).toBeTruthy()
  })
})

describe('ApprovalCard keyboard', () => {
  it('focuses nothing by itself and never makes Allow the default: no autofocus, no form, only plain buttons', async () => {
    const { dm } = await mountChatView([approvalRequest('q1')])
    const card = cards()[0] as HTMLElement
    const buttons = within(card).getAllByRole('button')
    for (const button of buttons) {
      expect(button.getAttribute('type')).toBe('button')
      expect(button.hasAttribute('autofocus')).toBe(false)
      expect(button.closest('form')).toBeNull()
      expect(document.activeElement).not.toBe(button)
    }
    fireEvent.keyDown(document.body, { key: 'Enter' })
    fireEvent.keyDown(card, { key: 'Enter' })
    await settle()
    expect(dm.chats.callsOf('answerApproval')).toEqual([])
  })

  it('labels each button with the request it answers', async () => {
    await mountChatView([approvalRequest('q1')])
    const card = cards()[0] as HTMLElement
    const describedBy = within(card).getByRole('button', { name: 'Deny' }).getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy ?? '')?.textContent).toContain('Run a command')
    expect(within(card).getByRole('group', { name: 'Answer' })).toBeTruthy()
  })
})

describe('ApprovalCard Allow for this chat on a Dark Mechanicus tool', () => {
  const OWN = 'Allow for this chat covers all Dark Mechanicus tools in this chat.'
  const ownCall = { category: 'other', tool: 'mcp__darkmechanicus__claim_ticket', summary: 'Use mcp__darkmechanicus__claim_ticket', input: { ticketId: 'tk_1' }, ownServer: true } as const

  it('says Allow for this chat covers all of the chat’s Dark Mechanicus tools, beside the answers', async () => {
    await mountChatView([approvalRequest('q1', ownCall)])
    const card = cards()[0] as HTMLElement
    const note = within(card).getByText(OWN)
    expect(buttonsOf(card)).toEqual(['Allow once', 'Allow for this chat', 'Deny'])
    expect(note.compareDocumentPosition(within(card).getByRole('group', { name: 'Answer' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('reads the note with each button, after the request itself', async () => {
    await mountChatView([approvalRequest('q1', ownCall)])
    const card = cards()[0] as HTMLElement
    const ids = (within(card).getByRole('button', { name: 'Allow for this chat' }).getAttribute('aria-describedby') ?? '').split(' ')
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual(['Use mcp__darkmechanicus__claim_ticket', OWN])
  })

  it('says nothing about it on a card for another server, a command or a file edit', async () => {
    await mountChatView([
      approvalRequest('q1', { category: 'other', tool: 'mcp__other__claim_ticket', summary: 'Use mcp__other__claim_ticket', input: undefined }),
      approvalRequest('q2'),
      approvalRequest('q3', { category: 'file_edit', tool: 'Edit', summary: 'Edit /a/x.ts', input: { file_path: '/a/x.ts' } })
    ])
    expect(cards()).toHaveLength(3)
    expect(screen.queryByText(OWN)).toBeNull()
  })

  it('drops the note once the request is answered, since there is nothing left to choose', async () => {
    await mountChatView([approvalRequest('q1', ownCall), approvalDecision('q1', 'allow_chat')])
    const card = cards()[0] as HTMLElement
    expect(within(card).getByText('Allowed for this chat')).toBeTruthy()
    expect(within(card).queryByText(OWN)).toBeNull()
  })
})
