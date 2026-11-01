// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ApprovalRequestItem, ChatItem } from '../../../shared/agents/chat'
import { ApprovalRecord } from './ApprovalRecord'

afterEach(cleanup)

const AT = '2026-03-01T10:00:00.000Z'

type DecisionItem = Extract<ChatItem, { kind: 'approval_decision' }>

function request(fields: Partial<ApprovalRequestItem> & Pick<ApprovalRequestItem, 'category' | 'tool'>): ApprovalRequestItem {
  return { id: 'q', at: AT, kind: 'approval_request', requestId: 'req_1', summary: 'Vendor summary', ...fields }
}

function decision(fields: Partial<DecisionItem> & Pick<DecisionItem, 'decision'>): DecisionItem {
  return { id: 'd', at: AT, kind: 'approval_decision', requestId: 'req_1', ...fields }
}

function show(item: ApprovalRequestItem, answer: DecisionItem | null = null): HTMLElement {
  render(<ApprovalRecord request={item} answer={answer} folder="/repo" />)
  return screen.getByRole('article')
}

function lineTexts(card: HTMLElement): string[] {
  return [...within(card).getByLabelText('Changed lines').querySelectorAll('.chat-diff-line')].map((line) => line.textContent ?? '')
}

describe('ApprovalRecord: a command', () => {
  it('shows the command and the folder it ran in, the chat folder when the request named none', () => {
    const card = show(request({ category: 'command', tool: 'Bash', input: { command: ['npm', 'run', 'build'] } }))

    expect(card.getAttribute('aria-label')).toBe('Approval request: Run a command')
    expect(card.querySelector('.chat-approval-command')?.textContent).toBe('npm run build')
    const fact = card.querySelector('.chat-approval-fact')
    expect(fact?.querySelector('dt')?.textContent).toBe('Working directory')
    expect(fact?.querySelector('dd')?.textContent).toBe('/repo')
    expect(card.querySelector('.chat-approval-summary')).toBe(null)
  })

  it('names the working directory the request gave over the chat folder', () => {
    const card = show(request({ category: 'command', tool: 'shell', input: { command: 'ls', cwd: '/repo/packages/app' } }))

    expect(card.querySelector('.chat-approval-fact dd')?.textContent).toBe('/repo/packages/app')
  })
})

describe('ApprovalRecord: an edit', () => {
  it('shows a replacement as removed and added lines, with its file', () => {
    const card = show(request({ category: 'file_edit', tool: 'Edit', input: { file_path: 'src/a.ts', old_string: 'const a = 1', new_string: 'const a = 2\nconst b = 3' } }))

    expect(card.getAttribute('aria-label')).toBe('Approval request: Edit a file')
    expect(card.querySelector('.chat-approval-fact dt')?.textContent).toBe('File')
    expect(card.querySelector('.chat-approval-fact dd')?.textContent).toBe('src/a.ts')
    expect(card.querySelector('.chat-approval-diff-text')?.textContent).toBe('Replaces 1 line with 2 lines')
    expect(lineTexts(card)).toEqual(['- const a = 1', '+ const a = 2', '+ const b = 3'])
    expect(card.querySelector('.chat-diff-removed')?.textContent).toBe('- const a = 1')
    expect([...card.querySelectorAll('.chat-diff-added')].map((line) => line.textContent)).toEqual(['+ const a = 2', '+ const b = 3'])
    expect(card.querySelector('.chat-diff-more')).toBe(null)
  })

  it('lists every file of a multi-file edit, each on its own', () => {
    const card = show(request({ category: 'file_edit', tool: 'apply_patch', input: { files: ['src/a.ts', 'src/b.ts'] } }))

    expect(card.getAttribute('aria-label')).toBe('Approval request: Edit files')
    expect(card.querySelector('.chat-approval-fact dt')?.textContent).toBe('Files')
    expect([...card.querySelectorAll('.chat-approval-fact dd span')].map((file) => file.textContent)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(card.querySelector('.chat-approval-diff')).toBe(null)
  })

  it('counts the changed lines past the preview, in the singular and the plural', () => {
    const thirteen = Array.from({ length: 13 }, (_, index) => `line ${index + 1}`).join('\n')
    const one = show(request({ category: 'file_edit', tool: 'Write', input: { file_path: 'a.txt', content: thirteen } }))
    expect(lineTexts(one)).toHaveLength(13)
    expect(one.querySelector('.chat-diff-more')?.textContent).toBe('… and 1 more changed line')
    cleanup()

    const fourteen = `${thirteen}\nline 14`
    const two = show(request({ category: 'file_edit', tool: 'Write', input: { file_path: 'a.txt', content: fourteen } }))
    expect(two.querySelector('.chat-diff-more')?.textContent).toBe('… and 2 more changed lines')
    expect(two.querySelector('.chat-approval-diff-text')?.textContent).toBe('Writes 14 lines')
  })
})

describe('ApprovalRecord: anything else', () => {
  it('shows the vendor summary and its reason when the request carries nothing structured', () => {
    const card = show(request({ category: 'other', tool: 'WebFetch', input: { reason: 'Read the docs' } }))

    expect(card.getAttribute('aria-label')).toBe('Approval request: Use WebFetch')
    expect(card.querySelector('.chat-approval-summary')?.textContent).toBe('Vendor summary')
    expect(card.querySelector('.chat-approval-note')?.textContent).toBe('Read the docs')
    expect(card.querySelector('.chat-approval-fact')).toBe(null)
    expect(card.querySelector('.chat-approval-command')).toBe(null)
  })

  it('names the subagent that asked, when a subagent did', () => {
    const card = show(request({ category: 'other', tool: 'WebFetch', threadLabel: 'Explore' }))

    expect(card.querySelector('.chat-approval-thread')?.textContent).toBe('Asked by the subagent: Explore')
  })
})

describe('ApprovalRecord: the decision', () => {
  it('shows an unanswered request as not answered, with no second line', () => {
    const card = show(request({ category: 'other', tool: 'WebFetch' }))

    expect(within(card).getByText('Not answered').getAttribute('data-state')).toBe('canceled')
    expect(card.querySelector('.chat-approval-answer-detail')).toBe(null)
  })

  it('says why a decision needs a second line: answered automatically, or cancelled', () => {
    const automatic = show(request({ category: 'other', tool: 'WebFetch' }), decision({ decision: 'allow_chat', automatic: true }))
    expect(within(automatic).getByText('Allowed for this chat').getAttribute('data-state')).toBe('accepted')
    expect(automatic.querySelector('.chat-approval-answer-detail')?.textContent).toBe('Answered automatically by an earlier Allow for this chat.')
    cleanup()

    const cancelled = show(request({ category: 'other', tool: 'WebFetch' }), decision({ decision: 'cancelled' }))
    expect(cancelled.querySelector('.chat-approval-answer-detail')?.textContent).toBe('No answer reached the agent.')
    cleanup()

    const denied = show(request({ category: 'other', tool: 'WebFetch' }), decision({ decision: 'deny' }))
    expect(within(denied).getByText('Denied').getAttribute('data-state')).toBe('blocked')
    expect(denied.querySelector('.chat-approval-answer-detail')).toBe(null)
  })
})
