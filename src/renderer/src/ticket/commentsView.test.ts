import { describe, expect, it } from 'vitest'
import { comment, MINUTE, NOW } from '../epic/__mocks__/fixtures'
import { canSubmitComment, commentItems, MAX_COMMENT_LENGTH } from './commentsView'

describe('commentItems', () => {
  it('shows each comment with its author, role, relative time, and Markdown body', () => {
    const items = commentItems(
      [
        comment(1, 90, { body: '**Blocked** on DM-102' }),
        comment(2, 0, { author: { role: 'desktop', label: 'Ada' }, ticketId: null })
      ],
      NOW
    )
    expect(items).toEqual([
      {
        id: 'cm_1',
        author: 'worker-a',
        role: 'Worker',
        when: '1h 30m ago',
        at: new Date(NOW - 90 * MINUTE).toISOString(),
        body: '**Blocked** on DM-102'
      },
      { id: 'cm_2', author: 'Ada', role: 'Desktop', when: 'just now', at: new Date(NOW).toISOString(), body: 'Comment 2' }
    ])
  })

  it('labels every author role', () => {
    const roles = ['desktop', 'planner', 'orchestrator', 'worker', 'reviewer'] as const
    const items = commentItems(
      roles.map((role, index) => comment(index, 1, { author: { role, label: `${role}-session` } })),
      NOW
    )
    expect(items.map((item) => item.role)).toEqual(['Desktop', 'Planner', 'Orchestrator', 'Worker', 'Reviewer'])
  })
})

describe('commentItems role chip', () => {
  it('omits the role when the author label already names it, ignoring case and spaces', () => {
    const items = commentItems(
      [
        comment(1, 1, { author: { role: 'desktop', label: 'Desktop' } }),
        comment(2, 1, { author: { role: 'worker', label: ' worker ' } }),
        comment(3, 1, { author: { role: 'reviewer', label: 'Reviewer bot' } })
      ],
      NOW
    )
    expect(items.map((item) => [item.author, item.role])).toEqual([
      ['Desktop', null],
      [' worker ', null],
      ['Reviewer bot', 'Reviewer']
    ])
  })
})

describe('canSubmitComment', () => {
  it('needs text that is not only whitespace and nothing in flight', () => {
    expect(canSubmitComment('Looks good', false)).toBe(true)
    expect(canSubmitComment('  x  ', false)).toBe(true)
    expect(canSubmitComment('', false)).toBe(false)
    expect(canSubmitComment(' \n\t ', false)).toBe(false)
    expect(canSubmitComment('Looks good', true)).toBe(false)
  })

  it('allows up to the 20,000-character comment limit', () => {
    expect(MAX_COMMENT_LENGTH).toBe(20_000)
    expect(canSubmitComment('x'.repeat(MAX_COMMENT_LENGTH), false)).toBe(true)
    expect(canSubmitComment('x'.repeat(MAX_COMMENT_LENGTH + 1), false)).toBe(false)
  })
})
