import { describe, expect, it } from 'vitest'
import { bundle, reportView, reportWithRetro, retroView, tierFacts } from '../epic/__mocks__/fixtures'
import { evidenceParts, retroSections, type TicketRef } from './retroView'

const TICKETS = bundle().tickets

/** A ticket as the report resolves it: the plan's key and title for an id the plan has, else the id itself. */
function ref(ticketId: string): TicketRef {
  const found = TICKETS.find((item) => item.id === ticketId)
  return found === undefined
    ? { ticketId: null, key: ticketId, title: '' }
    : { ticketId: found.id, key: found.key, title: found.title }
}

const NONE_ACCEPTED = (): boolean => false

describe('retro sections', () => {
  it('is absent for a report written without a retro', () => {
    expect(retroSections(reportView(), { ref, accepted: NONE_ACCEPTED })).toBe(null)
  })

  it('names each delivered ticket and says what to look at and where its evidence is', () => {
    const sections = retroSections(reportWithRetro(), { ref, accepted: NONE_ACCEPTED })
    expect(sections?.delivered).toEqual([
      {
        ticket: { ticketId: 'tk_203', key: 'DM-203', title: 'Folder registry & picker' },
        demo: 'Open **Settings** and pick a folder.',
        evidence: [
          { text: 'shots/dm-203/picker.png ', href: null },
          { text: 'https://example.test/pull/12', href: 'https://example.test/pull/12' }
        ]
      },
      {
        ticket: { ticketId: 'tk_201', key: 'DM-201', title: 'MCP authoring tools' },
        demo: 'Run `create_epic` from the MCP console.',
        evidence: [{ text: 'src/mcp/tools.ts', href: null }]
      }
    ])
  })

})

describe('retro sections (2)', () => {
  it('keeps what went well, what went poorly and the actions as written', () => {
    const sections = retroSections(reportWithRetro(), { ref, accepted: NONE_ACCEPTED })
    expect([sections?.wentWell, sections?.wentPoorly, sections?.actions]).toEqual([
      ['Row checks caught a bad merge early'],
      ['DM-202 needed a second attempt'],
      ['Run the replay test before submitting']
    ])
  })

  it('lists discoveries with the ticket they came up on, and leftovers with their reason', () => {
    const sections = retroSections(reportWithRetro(), { ref, accepted: (id) => id === 'tk_202' })
    expect(sections?.discoveries).toEqual([
      {
        title: 'Cache the folder registry',
        body: 'Reads hit the disk on every poll.',
        source: { ticketId: 'tk_203', key: 'DM-203', title: 'Folder registry & picker' }
      },
      { title: 'Document the idempotency key', body: '', source: null }
    ])
    expect(sections?.leftovers).toEqual([
      {
        ticket: { ticketId: 'tk_202', key: 'DM-202', title: 'Transactional bundle import' },
        reason: 'The replay test is still flaky after 2 attempts',
        accepted: true
      }
    ])
  })

  it('shows an unknown ticket by its id, without a link', () => {
    const retro = retroView({ leftovers: [{ ticket: 'tk_gone', reason: 'dropped from the plan' }] })
    const sections = retroSections(reportWithRetro(retro), { ref, accepted: NONE_ACCEPTED })
    expect(sections?.leftovers[0]?.ticket).toEqual({ ticketId: null, key: 'tk_gone', title: '' })
  })
})

describe('tier fit rows', () => {
  const rows = retroSections(reportWithRetro(), { ref, accepted: NONE_ACCEPTED })?.tierFit ?? []

  it('sets what each worked ticket was planned at against the models and efforts it used, in sprint order', () => {
    expect(rows.map((row) => row.ticket.key)).toEqual(['DM-201', 'DM-202', 'DM-203'])
    expect(rows.map((row) => row.planned)).toEqual([
      'No size · Multi-step · Low effort',
      'Medium · Multi-step · Medium effort',
      'Small · Routine · no effort set'
    ])
    expect(rows.map((row) => row.used)).toEqual([
      ['#1 Orchestrator (fallback) · accepted'],
      ['#1 model-small · low effort · rejected', '#2 model-large · high effort · failed'],
      ['#1 model-small · accepted']
    ])
  })

  it('counts the attempts, the rejections and an escalation', () => {
    expect(rows.map((row) => row.attempts)).toEqual(['1 attempt', '2 attempts · 1 rejected · escalated', '1 attempt'])
  })

  it('gives the reporter verdict and note, and none for a ticket the reporter did not judge', () => {
    expect(rows.map((row) => row.verdict)).toEqual([
      null,
      { label: 'Undersized', tone: 'blocked' },
      { label: 'Right-sized', tone: 'accepted' }
    ])
    expect(rows.map((row) => row.note)).toEqual(['', 'Needed the larger model on attempt 2', ''])
  })

  it('leaves out a ticket nobody worked on and judged, and keeps a verdict whose ticket has no facts', () => {
    const report = reportWithRetro(
      retroView({ tierFit: [{ ticket: 'tk_204', verdict: 'oversized', note: 'Only a rename' }] }),
      { tierFacts: [tierFacts('DM-202', { attempts: [], attemptCount: 0, rejectionCount: 0, escalated: false }), tierFacts('DM-203')] }
    )
    const shown = retroSections(report, { ref, accepted: NONE_ACCEPTED })?.tierFit ?? []
    expect(shown.map((row) => row.ticket.key)).toEqual(['DM-203', 'DM-204'])
    expect(shown[1]).toEqual({
      ticket: { ticketId: 'tk_204', key: 'DM-204', title: 'Sidebar plan buckets' },
      planned: 'unknown plan',
      used: [],
      attempts: 'not worked',
      verdict: { label: 'Oversized', tone: 'attention' },
      note: 'Only a rename'
    })
  })

  it('shows an empty table when the retro judged nothing and nothing was worked', () => {
    const report = reportWithRetro(retroView({ tierFit: [] }), { tierFacts: [] })
    expect(retroSections(report, { ref, accepted: NONE_ACCEPTED })?.tierFit).toEqual([])
  })
})

describe('evidence parts', () => {
  it('turns web addresses into links and leaves paths and commits as text', () => {
    expect(evidenceParts('screenshot shots/a.png, PR https://example.test/pull/9 and commit a1b2c3d')).toEqual([
      { text: 'screenshot shots/a.png, PR ', href: null },
      { text: 'https://example.test/pull/9', href: 'https://example.test/pull/9' },
      { text: ' and commit a1b2c3d', href: null }
    ])
  })

  it('leaves the punctuation after an address out of the link', () => {
    expect(evidenceParts('see (https://example.test/a/b).')).toEqual([
      { text: 'see (', href: null },
      { text: 'https://example.test/a/b', href: 'https://example.test/a/b' },
      { text: ').', href: null }
    ])
    expect(evidenceParts('http://one.test/x; https://two.test/y.')).toEqual([
      { text: 'http://one.test/x', href: 'http://one.test/x' },
      { text: '; ', href: null },
      { text: 'https://two.test/y', href: 'https://two.test/y' },
      { text: '.', href: null }
    ])
  })

  it('has no parts for blank evidence and never links other schemes', () => {
    expect(evidenceParts('')).toEqual([])
    expect(evidenceParts('  ')).toEqual([])
    expect(evidenceParts('file:///etc/passwd javascript:alert(1)')).toEqual([{ text: 'file:///etc/passwd javascript:alert(1)', href: null }])
  })
})
