import { describe, expect, it } from 'vitest'
import { MINUTE, NOW, attempt, iso, runView } from './__mocks__/fixtures'
import { attemptText, recentAttempts, stripItems, syncedLabel } from './attemptsStripView'

const KEYS = new Map([
  ['tk_101', 'DM-101'],
  ['tk_201', 'DM-201'],
  ['tk_202', 'DM-202']
])

describe('attempt text', () => {
  it('describes open, failed, rejected and expired attempts', () => {
    expect(attemptText(attempt('DM-202', 2, 'running', { leaseExpiresAt: iso(4 * MINUTE + 12_000) }), KEYS, NOW)).toBe(
      'DM-202 #2 running · lease 04:12'
    )
    expect(attemptText(attempt('DM-201', 1, 'submitted', { leaseExpiresAt: iso(MINUTE) }), KEYS, NOW)).toBe(
      'DM-201 #1 submitted'
    )
    expect(attemptText(attempt('DM-201', 1, 'claimed'), KEYS, NOW)).toBe('DM-201 #1 claimed')
    const failed = attempt('DM-202', 1, 'failed', { failure: { reason: '2 tests', details: '', retryable: true } })
    expect(attemptText(failed, KEYS, NOW)).toBe('DM-202 #1 failed · 2 tests')
    expect(attemptText(attempt('DM-202', 1, 'failed'), KEYS, NOW)).toBe('DM-202 #1 failed')
    const rejected = attempt('DM-201', 2, 'rejected', {
      decision: { outcome: 'rejected', notes: '', reasons: ['criteria c2 unmet', 'x'], decidedBy: 'reviewer' }
    })
    expect(attemptText(rejected, KEYS, NOW)).toBe('DM-201 #2 rejected · criteria c2 unmet')
    expect(attemptText(attempt('DM-201', 3, 'rejected'), KEYS, NOW)).toBe('DM-201 #3 rejected')
    expect(attemptText(attempt('DM-201', 1, 'lease_expired'), KEYS, NOW)).toBe('DM-201 #1 lease expired · needs reconciliation')
    expect(attemptText(attempt('DM-999', 1, 'accepted'), KEYS, NOW)).toBe('tk_999 #1 accepted')
  })
})

describe('attempts strip', () => {
  it('shows open attempts by recency, then failures, skipping accepted and superseded ones', () => {
    const run = runView({
      attempts: [
        ...runView().attempts,
        attempt('DM-201', 0, 'failed', { superseded: true, updatedAt: iso(-10_000) }),
        attempt('DM-101', 2, 'failed', { updatedAt: iso(-10_000) })
      ]
    })
    expect(stripItems(run, KEYS, NOW).map((item) => [item.text, item.tone, item.ticketId])).toEqual([
      ['DM-202 #2 running · lease 04:12', 'running', 'tk_202'],
      ['DM-201 #1 submitted', 'review', 'tk_201'],
      ['DM-101 #2 failed', 'failed', 'tk_101']
    ])
  })

  it('keeps at most three strip items', () => {
    const run = runView({
      attempts: [1, 2, 3, 4].map((n) => attempt('DM-202', n, 'running', { updatedAt: iso(-n * MINUTE) }))
    })
    expect(stripItems(run, KEYS, NOW).map((item) => item.attemptId)).toEqual(['at_202_1', 'at_202_2', 'at_202_3'])
  })

  it('lists every recent attempt when expanded', () => {
    expect(recentAttempts(runView(), KEYS, NOW).map((item) => item.attemptId)).toEqual([
      'at_202_2',
      'at_201_1',
      'at_202_1',
      'at_101_1'
    ])
    const many = runView({ attempts: Array.from({ length: 15 }, (_, n) => attempt('DM-202', n + 1, 'accepted')) })
    expect(recentAttempts(many, KEYS, NOW).length).toBe(12)
  })

  it('reports how long ago the workspace synced', () => {
    expect(syncedLabel(NOW - 2_000, NOW)).toBe('synced 2s ago')
    expect(syncedLabel(NOW, NOW)).toBe('synced just now')
    expect(syncedLabel(null, NOW)).toBe('not synced yet')
  })
})
