import { describe, expect, it } from 'vitest'
import { defaultCapabilityProfile } from '../../../shared/domain/bundle'
import {
  MINUTE,
  NOW,
  SAMPLE_ATTEMPTS,
  attempt,
  event,
  execution,
  iso,
  link,
  ticket,
  ticketDetail
} from '../epic/__mocks__/fixtures'
import {
  attemptCards,
  capabilityRows,
  criteriaChecklist,
  evidenceView,
  formatTokens,
  historyItems,
  linkRows,
  metaLine,
  statePill
} from './ticketView'

const IMPORT = ticketDetail().ticket
const IMPORT_ATTEMPTS = SAMPLE_ATTEMPTS.filter((item) => item.ticketId === 'tk_202')

describe('acceptance criteria checklist', () => {
  it('counts criteria verified by the latest attempt with evidence', () => {
    expect(criteriaChecklist(IMPORT, IMPORT_ATTEMPTS)).toEqual({
      heading: 'ACCEPTANCE CRITERIA · 1 OF 4 VERIFIED',
      items: [
        { id: 'c1', text: 'Bundle with client-local refs returns stable IDs', verified: true, note: 'stable ids returned' },
        { id: 'c2', text: 'An invalid edge rejects the whole bundle and nothing persists', verified: false, note: 'partial rows remained' },
        { id: 'c3', text: 'A retry with the same idempotency key returns the original result', verified: false, note: '' },
        { id: 'c4', text: 'Export outbox entry is written in the same transaction', verified: false, note: '' }
      ]
    })
  })

  it('prefers the newest evidence and handles tickets without criteria', () => {
    const newer = attempt('DM-202', 3, 'submitted', {
      evidence: { checks: [], criteria: [{ criterionId: 'c3', met: true, note: '' }], notes: '' }
    })
    expect(criteriaChecklist(IMPORT, [...IMPORT_ATTEMPTS, newer]).heading).toBe('ACCEPTANCE CRITERIA · 1 OF 4 VERIFIED')
    expect(criteriaChecklist(IMPORT, [...IMPORT_ATTEMPTS, newer]).items.map((item) => item.verified)).toEqual([
      false,
      false,
      true,
      false
    ])
    expect(criteriaChecklist(ticket('DM-1', 'x', { acceptanceCriteria: [] }), []).heading).toBe(
      'ACCEPTANCE CRITERIA · NONE YET'
    )
  })
})

describe('capability profile rows', () => {
  it('lists work type, reasoning, tools, modalities and context estimate', () => {
    expect(capabilityRows(IMPORT.capability)).toEqual([
      { label: 'Work type', value: 'Implementation', note: '' },
      { label: 'Reasoning', value: 'Multi-step', note: 'transaction and outbox ordering' },
      { label: 'Tools', value: 'Repo read · Repo write · Shell · Test execution', note: '' },
      { label: 'Modalities', value: 'Text', note: '' },
      { label: 'Context', value: '~40k tokens', note: '(estimate)' }
    ])
  })

  it('shows empty lists, a missing estimate and a model override', () => {
    const profile = {
      ...defaultCapabilityProfile(),
      tools: [],
      modalities: [],
      preferences: { ...defaultCapabilityProfile().preferences, modelOverride: 'model-x' }
    }
    expect(capabilityRows(profile).slice(2)).toEqual([
      { label: 'Tools', value: 'None', note: '' },
      { label: 'Modalities', value: 'None', note: '' },
      { label: 'Context', value: 'Not estimated', note: '' },
      { label: 'Model override', value: 'model-x', note: '' }
    ])
  })

  it('formats token estimates compactly', () => {
    expect([950, 1_000, 40_000, 42_500, 1_500_000, 2_000_000].map(formatTokens)).toEqual([
      '950',
      '1k',
      '40k',
      '42.5k',
      '1.5M',
      '2M'
    ])
  })
})

describe('ticket state pill and meta line', () => {
  it('pairs execution state and attempt number with a tone', () => {
    expect(statePill(ticketDetail())).toEqual({ label: 'RUNNING · ATTEMPT 2', tone: 'running' })
    const first = ticketDetail({ execution: execution('DM-202', 'sp_2', 'running', { attemptCount: 1 }) })
    expect(statePill(first)).toEqual({ label: 'RUNNING', tone: 'running' })
    expect(statePill(ticketDetail({ execution: null, status: 'completed' }))).toEqual({ label: 'COMPLETED', tone: 'accepted' })
    expect(statePill(ticketDetail({ execution: null, status: null }))).toEqual({ label: 'BACKLOG', tone: 'neutral' })
  })

  it('joins sprint, goal, revision and the read-only reason', () => {
    expect(metaLine(ticketDetail(), 'Authoring through MCP', 4)).toBe(
      'Sprint 2 · Authoring through MCP · rev 4 · Read-only while run #2 is active'
    )
    expect(metaLine(ticketDetail({ sprintOrdinal: null, readOnlyReason: null }), '', null)).toBe('')
  })
})

describe('requires and unlocks rows', () => {
  it('labels linked tickets by execution state, else by status', () => {
    expect(linkRows([link('DM-102', 'SQLite', 'accepted'), { ...link('DM-9', 'New', null), status: null }])).toEqual([
      { ticketId: 'tk_102', key: 'DM-102', title: 'SQLite', label: 'ACCEPTED', tone: 'accepted' },
      { ticketId: 'tk_9', key: 'DM-9', title: 'New', label: 'DRAFT', tone: 'neutral' }
    ])
    expect(linkRows([{ ...link('DM-7', 'Old', null), status: 'completed' }])[0]).toMatchObject({
      label: 'COMPLETED',
      tone: 'accepted'
    })
  })
})

describe('evidence view', () => {
  it('shows checks, criteria results and notes from the latest evidence', () => {
    expect(evidenceView(IMPORT, IMPORT_ATTEMPTS)).toEqual({
      source: 'From attempt #1',
      checks: [
        { name: 'Unit tests', status: 'failed', detail: '2 failed', icon: '✗' },
        { name: 'Typecheck', status: 'passed', detail: '0 errors', icon: '✓' },
        { name: 'Lint', status: 'skipped', detail: 'not configured', icon: '–' }
      ],
      criteria: [
        { text: 'Bundle with client-local refs returns stable IDs', met: true, note: 'stable ids returned' },
        { text: 'An invalid edge rejects the whole bundle and nothing persists', met: false, note: 'partial rows remained' }
      ],
      notes: 'Replay test is **flaky**.'
    })
    expect(evidenceView(IMPORT, [])).toBe(null)
  })

  it('falls back to the criterion id for unknown criteria', () => {
    const odd = attempt('DM-202', 1, 'submitted', {
      evidence: { checks: [], criteria: [{ criterionId: 'c9', met: true, note: '' }], notes: '' }
    })
    expect(evidenceView(IMPORT, [odd])?.criteria).toEqual([{ text: 'c9', met: true, note: '' }])
  })
})

describe('history items', () => {
  it('filters events to the ticket, newest first, with a readable title and detail', () => {
    const events = [
      event(1, 'attempt.claimed', { payload: { attemptId: 'at_1' } }),
      event(2, 'attempt.failed', { payload: { reason: '2 tests failed' } }),
      event(3, 'plan.saved', { ticketId: null }),
      event(4, 'attempt_submitted', { ticketId: 'tk_202', payload: { summary: 'done', state: 'x' } })
    ]
    expect(historyItems(events, 'tk_202', NOW)).toEqual([
      { seq: 4, title: 'Attempt submitted', when: '4m ago', detail: 'done' },
      { seq: 2, title: 'Attempt failed', when: '2m ago', detail: '2 tests failed' },
      { seq: 1, title: 'Attempt claimed', when: '1m ago', detail: '' }
    ])
  })
})

describe('attempt cards (1)', () => {
  it('describes each attempt newest first with worker, lease, outputs and allowed actions', () => {
    const cards = attemptCards([...IMPORT_ATTEMPTS, SAMPLE_ATTEMPTS[3] ?? IMPORT_ATTEMPTS[0]], NOW)
    expect(cards.map((card) => [card.id, card.heading, card.state])).toEqual([
      ['at_202_2', '#2', 'RUNNING'],
      ['at_202_1', '#1', 'FAILED'],
      ['at_201_1', '#1', 'SUBMITTED']
    ])
    expect(cards[0]).toMatchObject({
      tone: 'running',
      worker: 'worker-a · model model-large · host claude-code',
      rationale: 'Needs multi-step reasoning',
      lease: 'lease 04:12 left · heartbeat 20s ago',
      canReview: false,
      canAbandon: false
    })
    expect(cards[1]).toMatchObject({ failure: '2 tests failed — idempotency replay returned a new id', lease: '' })
    expect(cards[2]).toMatchObject({
      canReview: true,
      summary: 'Added create_epic and update_plan_draft tools.',
      commits: ['a1b2c3d'],
      files: ['src/mcp/tools.ts', 'src/mcp/server.ts'],
      moreFiles: 0
    })
  })
})

describe('attempt cards (2)', () => {
  it('handles expired leases, decisions, carry-forward and long file lists', () => {
    const expired = attempt('DM-202', 3, 'lease_expired', { leaseExpiresAt: iso(-MINUTE) })
    const decided = attempt('DM-202', 4, 'rejected', {
      kind: 'carry_forward',
      superseded: true,
      decision: { outcome: 'rejected', notes: 'Retry with tests', reasons: ['c2 unmet'], decidedBy: 'reviewer' },
      outputs: { summary: '', artifacts: [], commits: [], changedFiles: Array.from({ length: 14 }, (_, n) => `f${n}`), branch: null }
    })
    const [rejected, lapsed] = attemptCards([expired, decided], NOW)
    expect(lapsed).toMatchObject({ lease: 'lease expired — needs reconciliation', canAbandon: true, canReview: false })
    expect(rejected).toMatchObject({
      decision: 'Rejected by reviewer: Retry with tests',
      reasons: ['c2 unmet'],
      kindLabel: 'carried forward',
      superseded: true,
      moreFiles: 2
    })
    expect(rejected?.files.length).toBe(12)
    const claimed = attempt('DM-202', 6, 'claimed', { leaseExpiresAt: iso(4 * MINUTE) })
    expect(attemptCards([claimed], NOW)[0]?.lease).toBe('lease 04:00 left')
    const bare = attempt('DM-202', 5, 'claimed', {
      worker: { sessionId: null, label: 'w', modelId: null, hostId: null, catalogRevision: null, rationale: null },
      decision: { outcome: 'accepted', notes: '', reasons: [], decidedBy: 'desktop' }
    })
    expect(attemptCards([bare], NOW)[0]).toMatchObject({
      worker: 'w',
      rationale: '',
      lease: '',
      decision: 'Accepted by desktop',
      kindLabel: '',
      failure: ''
    })
  })
})
