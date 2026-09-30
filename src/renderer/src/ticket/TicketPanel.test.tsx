// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { deferred } from '../__mocks__/deferred'
import { FakeBackend, scenario } from '../epic/__mocks__/fakeBackend'
import { NOW, attempt, comment, savedPlan, ticketDetail } from '../epic/__mocks__/fixtures'
import { allowSlowRendering } from '../epic/__mocks__/testTiming'
import type { ReviewInput } from '../epic/workspaceActions'
import { TicketPanel, type TicketPanelProps } from './TicketPanel'

allowSlowRendering()

afterEach(() => {
  cleanup()
})

interface Recorded {
  edits: number
  closed: number
  selected: string[]
  reviews: ReviewInput[]
}

function renderPanel(backend: FakeBackend, patch: Partial<TicketPanelProps> = {}, reviewError: string | null = null): Recorded {
  window.dm = backend
  const recorded: Recorded = { edits: 0, closed: 0, selected: [], reviews: [] }
  render(
    <TicketPanel
      runner={backend.runner}
      epicId="ep_1"
      ticketId="tk_202"
      plan={savedPlan()}
      reloadKey={0}
      now={NOW}
      canEdit
      onEditInDraft={() => {
        recorded.edits += 1
      }}
      onClose={() => {
        recorded.closed += 1
      }}
      onSelectTicket={(id) => recorded.selected.push(id)}
      onReview={(input) => {
        recorded.reviews.push(input)
        return Promise.resolve(reviewError)
      }}
      {...patch}
    />
  )
  return recorded
}

describe('ticket panel overview', () => {
  it('shows the key, state, title, meta line, Markdown body and criteria progress', async () => {
    renderPanel(new FakeBackend())
    const panel = await screen.findByLabelText('Ticket DM-202')
    expect((await within(panel).findByText('RUNNING · ATTEMPT 2')).textContent).toBe('RUNNING · ATTEMPT 2')
    expect(within(panel).getByRole('heading', { level: 2 }).textContent).toBe('Transactional bundle import')
    expect(within(panel).getByText('Sprint 2 · Authoring through MCP · rev 4 · Read-only while run #2 is active').tagName).toBe('P')
    expect(panel.querySelector('.md code')?.textContent).toBe('save_plan_draft')
    expect(within(panel).getByText('ACCEPTANCE CRITERIA · 1 OF 4 VERIFIED').textContent).toBe('ACCEPTANCE CRITERIA · 1 OF 4 VERIFIED')
    const boxes = within(panel).getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes.map((box) => box.checked)).toEqual([true, false, false, false])
  })

  it('shows the capability profile and requires/unlocks links that open other tickets', async () => {
    const recorded = renderPanel(new FakeBackend())
    const profile = await screen.findByLabelText('Capability profile')
    expect(within(profile).getByText('Multi-step').textContent).toBe('Multi-step · transaction and outbox ordering')
    expect(within(profile).getByText('~40k tokens').textContent).toBe('~40k tokens · (estimate)')
    expect(within(profile).getByText('Database design').className).toBe('ew-chip')
    expect(within(profile).getByText('Implementation').textContent).toBe('Implementation')
    const requires = screen.getByLabelText('REQUIRES')
    expect(within(requires).getAllByRole('button').map((item) => item.textContent)).toEqual([
      'DM-102SQLite schema & migrationsACCEPTED',
      'DM-103Portable export outboxACCEPTED'
    ])
    fireEvent.click(within(screen.getByLabelText('UNLOCKS')).getByRole('button'))
    expect(recorded.selected).toEqual(['tk_304'])
  })

  it('offers Edit in draft and close', async () => {
    const recorded = renderPanel(new FakeBackend())
    fireEvent.click(await screen.findByRole('button', { name: 'Edit in draft' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close ticket' }))
    expect([recorded.edits, recorded.closed]).toEqual([1, 1])
  })

  it('hides Edit in draft when editing is not allowed and shows load errors', async () => {
    const backend = new FakeBackend()
    backend.fail('getTicket', 'not_found', 'Ticket tk_202 not found.')
    renderPanel(backend, { canEdit: false })
    expect((await screen.findByRole('alert')).textContent).toBe('Ticket tk_202 not found.')
    expect(screen.queryByRole('button', { name: 'Edit in draft' })).toBe(null)
  })
})

describe('ticket panel attempts', () => {
  it('lists attempts with worker, lease and failure details', async () => {
    renderPanel(new FakeBackend())
    fireEvent.click(await screen.findByRole('tab', { name: 'Attempts (2)' }))
    const cards = screen.getAllByRole('listitem').filter((item) => item.className.startsWith('tp-attempt'))
    expect(cards.map((card) => card.getAttribute('aria-label'))).toEqual(['Attempt #2', 'Attempt #1'])
    expect(within(cards[0] as HTMLElement).getByText('lease 04:12 left · heartbeat 20s ago').textContent).toBe(
      'lease 04:12 left · heartbeat 20s ago'
    )
    expect(within(cards[1] as HTMLElement).getByText('2 tests failed — idempotency replay returned a new id')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Attempts (2)' }).getAttribute('aria-selected')).toBe('true')
  })

  it('accepts or rejects a submitted attempt with a required reason and abandons an expired one', async () => {
    const submitted = attempt('DM-202', 3, 'submitted')
    const expired = attempt('DM-202', 2, 'lease_expired')
    const backend = new FakeBackend(scenario({ ticket: ticketDetail({ attempts: [submitted, expired] }) }))
    const recorded = renderPanel(backend, {}, 'The attempt is no longer submitted.')
    fireEvent.click(await screen.findByRole('tab', { name: 'Attempts (2)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect((await screen.findByText('The attempt is no longer submitted.')).getAttribute('role')).toBe('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Reject…' }))
    const reject = screen.getByRole('button', { name: 'Reject attempt' }) as HTMLButtonElement
    expect(reject.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Reason for rejecting'), { target: { value: ' c2 unmet ' } })
    fireEvent.click(reject)
    fireEvent.click(screen.getByRole('button', { name: 'Mark abandoned' }))
    await screen.findAllByText('The attempt is no longer submitted.')
    expect(recorded.reviews).toEqual([
      { attemptId: 'at_202_3', decision: 'accept' },
      { attemptId: 'at_202_3', decision: 'reject', reason: 'c2 unmet' },
      { attemptId: 'at_202_2', decision: 'abandon' }
    ])
  })

  it('says when there are no attempts yet', async () => {
    renderPanel(new FakeBackend(scenario({ ticket: ticketDetail({ attempts: [], execution: null }) })))
    fireEvent.click(await screen.findByRole('tab', { name: 'Attempts (0)' }))
    expect(screen.getByText('No attempts yet.').textContent).toBe('No attempts yet.')
    expect(screen.getByText('IN PROGRESS').textContent).toBe('IN PROGRESS')
  })
})

describe('ticket panel evidence and history', () => {
  it('shows checks, criteria results and notes of the latest evidence', async () => {
    renderPanel(new FakeBackend())
    fireEvent.click(await screen.findByRole('tab', { name: 'Evidence' }))
    const checks = screen.getByLabelText('Checks')
    expect(within(checks).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '✗Unit tests2 failed',
      '✓Typecheck0 errors',
      '–Lintnot configured'
    ])
    expect(screen.getByText('FROM ATTEMPT #1').textContent).toBe('FROM ATTEMPT #1')
    expect(screen.getByText('flaky').tagName).toBe('STRONG')
  })

  it('says when no evidence exists', async () => {
    renderPanel(new FakeBackend(scenario({ ticket: ticketDetail({ attempts: [] }) })))
    fireEvent.click(await screen.findByRole('tab', { name: 'Evidence' }))
    expect(screen.getByText('No evidence recorded yet.').textContent).toBe('No evidence recorded yet.')
  })

  it("lists the ticket's events newest first", async () => {
    renderPanel(new FakeBackend())
    fireEvent.click(await screen.findByRole('tab', { name: 'History' }))
    const items = await screen.findAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual(['Attempt failed · 2m ago2 tests failed', 'Attempt claimed · 1m ago'])
    expect(document.querySelectorAll('.tp-history-detail').length).toBe(1)
  })

  it('reports empty and failing history', async () => {
    const empty = new FakeBackend(scenario({ events: [] }))
    renderPanel(empty)
    fireEvent.click(await screen.findByRole('tab', { name: 'History' }))
    expect((await screen.findByText('No events for this ticket yet.')).textContent).toBe('No events for this ticket yet.')
    cleanup()
    const failing = new FakeBackend()
    failing.fail('listEvents', 'internal', 'Event log unavailable.')
    renderPanel(failing)
    fireEvent.click(await screen.findByRole('tab', { name: 'History' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Event log unavailable.')
  })
})

describe('ticket panel attempt details', () => {
  it('shows outputs, decisions, carry-forward and supersession details only when present', async () => {
    const files = Array.from({ length: 14 }, (_, index) => `src/file${index}.ts`)
    const decided = attempt('DM-202', 4, 'rejected', {
      kind: 'carry_forward',
      superseded: true,
      outputs: { summary: 'Reworked the importer.', artifacts: [], commits: ['0123456789', 'abcdef9999'], changedFiles: files, branch: null },
      decision: { outcome: 'rejected', notes: 'Retry with tests', reasons: ['c2 unmet'], decidedBy: 'reviewer' }
    })
    const plain = attempt('DM-202', 3, 'canceled', {
      worker: { sessionId: null, label: 'w', modelId: null, hostId: null, catalogRevision: null, rationale: null }
    })
    renderPanel(new FakeBackend(scenario({ ticket: ticketDetail({ attempts: [decided, plain] }) })))
    fireEvent.click(await screen.findByRole('tab', { name: 'Attempts (2)' }))
    const [rich, bare] = screen.getAllByRole('listitem').filter((item) => item.className.startsWith('tp-attempt'))
    expect(rich?.className).toBe('tp-attempt is-superseded')
    const richText = within(rich as HTMLElement)
    expect(richText.getByText('Reworked the importer.').className).toBe('tp-attempt-summary')
    expect(richText.getByText('0123456 · abcdef9').textContent).toBe('0123456 · abcdef9')
    expect(richText.getByText('and 2 more').textContent).toBe('and 2 more')
    expect(within(richText.getByLabelText('Changed files')).getAllByRole('listitem').length).toBe(13)
    expect(richText.getByText('Rejected by reviewer: Retry with tests').textContent).toBe('Rejected by reviewer: Retry with tests')
    expect(richText.getByText('c2 unmet').tagName).toBe('LI')
    expect(richText.getByText('carried forward').className).toBe('ew-chip')
    expect(richText.getByText('superseded').className).toBe('ew-chip')
    expect(bare?.className).toBe('tp-attempt')
    expect(bare?.querySelectorAll('p').length).toBe(1)
    expect(bare?.querySelectorAll('.ew-chip, ul').length).toBe(0)
  })

  it('lists changed files without an overflow line when there are few', async () => {
    const small = attempt('DM-202', 1, 'accepted', {
      outputs: { summary: '', artifacts: [], commits: [], changedFiles: ['a.ts'], branch: null }
    })
    renderPanel(new FakeBackend(scenario({ ticket: ticketDetail({ attempts: [small] }) })))
    fireEvent.click(await screen.findByRole('tab', { name: 'Attempts (1)' }))
    expect(within(screen.getByLabelText('Changed files')).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['a.ts'])
    expect(document.querySelectorAll('.tp-attempt-summary').length).toBe(0)
    expect(screen.getByText('Needs multi-step reasoning').textContent).toBe('Needs multi-step reasoning')
  })
})

const HOSTILE_NOTE = [
  '**Blocked** on DM-102',
  '',
  '<script>alert(1)</script> [run](javascript:alert(1)) [docs](https://example.com/docs)'
].join('\n')

async function openComments(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('tab', { name: 'Comments' }))
  return screen.findByRole('list', { name: 'Comments' })
}

async function openEmptyComments(): Promise<void> {
  fireEvent.click(await screen.findByRole('tab', { name: 'Comments' }))
  await screen.findByText('No comments yet.')
}

describe('ticket panel comments list', () => {
  it("lists the ticket's comments oldest first with author, role and time", async () => {
    const other = comment(9, 1, { ticketId: 'tk_101', body: 'Elsewhere' })
    const backend = new FakeBackend(scenario({ comments: [comment(1, 90), other, comment(2, 5, { author: { role: 'desktop', label: 'Ada' } })] }))
    renderPanel(backend)
    const list = await openComments()
    const items = within(list).getAllByRole('listitem')
    expect(items.map((item) => item.getAttribute('aria-label'))).toEqual(['Comment by worker-a', 'Comment by Ada'])
    expect(within(items[0] as HTMLElement).getByText('worker-a').className).toBe('tp-comment-author')
    expect(within(items[0] as HTMLElement).getByText('Worker').className).toBe('ew-chip')
    expect(within(items[0] as HTMLElement).getByText('1h 30m ago').getAttribute('datetime')).toBe(new Date(NOW - 90 * 60_000).toISOString())
    expect(within(items[1] as HTMLElement).getByText('Desktop').className).toBe('ew-chip')
    expect(backend.inputs('listComments')).toEqual([{ epicId: 'ep_1', ticketId: 'tk_202' }])
    expect(screen.getByRole('tab', { name: 'Comments' }).getAttribute('aria-selected')).toBe('true')
  })

  it('renders comment Markdown through the safe renderer', async () => {
    renderPanel(new FakeBackend(scenario({ comments: [comment(1, 3, { body: HOSTILE_NOTE })] })))
    const list = await openComments()
    expect(list.querySelector('.md strong')?.textContent).toBe('Blocked')
    expect(list.querySelectorAll('script, img, iframe').length).toBe(0)
    expect(list.textContent?.includes('<script>alert(1)</script>')).toBe(true)
    expect([...list.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual(['https://example.com/docs'])
  })

  it('says when there are no comments and shows a load failure', async () => {
    renderPanel(new FakeBackend())
    fireEvent.click(await screen.findByRole('tab', { name: 'Comments' }))
    expect((await screen.findByText('No comments yet.')).tagName).toBe('P')
    cleanup()
    const failing = new FakeBackend()
    failing.fail('listComments', 'internal', 'Comments unavailable.')
    renderPanel(failing)
    fireEvent.click(await screen.findByRole('tab', { name: 'Comments' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Comments unavailable.')
  })
})

function typeComment(text: string): HTMLButtonElement {
  fireEvent.change(screen.getByRole('textbox', { name: 'New comment' }), { target: { value: text } })
  return screen.getByRole('button', { name: 'Add comment' }) as HTMLButtonElement
}

describe('ticket panel comment form', () => {
  it('adds a comment, clears the form and shows the refreshed list', async () => {
    const backend = new FakeBackend(scenario({ comments: [comment(1, 30)] }))
    renderPanel(backend)
    await openComments()
    fireEvent.click(typeComment('Decision: **ship** it'))
    const added = await screen.findByRole('listitem', { name: 'Comment by Desktop' })
    expect(added.querySelector('.md strong')?.textContent).toBe('ship')
    expect(backend.inputs('addComment')).toEqual([{ epicId: 'ep_1', ticketId: 'tk_202', body: 'Decision: **ship** it' }])
    expect((screen.getByRole('textbox', { name: 'New comment' }) as HTMLTextAreaElement).value).toBe('')
    expect(within(screen.getByRole('list', { name: 'Comments' })).getAllByRole('listitem')).toHaveLength(2)
  })

  it('offers Add comment only for text and not while the comment is being added', async () => {
    const backend = new FakeBackend()
    const hold = deferred()
    backend.gates.addComment = hold.promise
    renderPanel(backend)
    await openEmptyComments()
    const button = screen.getByRole('button', { name: 'Add comment' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(typeComment('  \n ').disabled).toBe(true)
    expect(typeComment('Looks good').disabled).toBe(false)
    fireEvent.click(button)
    expect(button.disabled).toBe(true)
    hold.resolve()
    expect(await screen.findByRole('listitem', { name: 'Comment by Desktop' })).toBeTruthy()
    expect(button.disabled).toBe(true)
    expect(typeComment('Another').disabled).toBe(false)
  })

  it('shows why a comment was refused and keeps the text', async () => {
    const backend = new FakeBackend()
    backend.fail('addComment', 'completed_epic', 'Completed epics are read-only. Create a new epic to extend this work.')
    renderPanel(backend)
    await openEmptyComments()
    fireEvent.click(typeComment('Too late'))
    expect((await screen.findByRole('alert')).textContent).toBe('Completed epics are read-only. Create a new epic to extend this work.')
    expect((screen.getByRole('textbox', { name: 'New comment' }) as HTMLTextAreaElement).value).toBe('Too late')
    expect((screen.getByRole('button', { name: 'Add comment' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows comments read-only, without the form, when the epic is completed', async () => {
    renderPanel(new FakeBackend(scenario({ comments: [comment(1, 2)] })), { canEdit: false })
    const list = await openComments()
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    expect(screen.queryByRole('textbox', { name: 'New comment' })).toBe(null)
    expect(screen.queryByRole('button', { name: 'Add comment' })).toBe(null)
    expect(screen.getByText('Comments on a completed epic are read-only.').tagName).toBe('P')
  })
})
