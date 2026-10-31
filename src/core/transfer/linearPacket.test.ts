import { describe, expect, it } from 'vitest'
import type { PlanBundle, TicketContent } from '../../shared/domain/bundle'
import type { WorkStatus } from '../../shared/domain/status'
import type { LinearTransferPacket } from '../../shared/domain/transfer'
import { makeBundle, sid, tid } from '../../test/bundles'
import { buildLinearPacket, LINEAR_SUMMARY_MAX, type LinearPacketInput } from './linearPacket'

const EPIC_ID = 'ep_0000000000000000000000epic'
const REVISION_ID = 'rv_000000000000000000000000rv'

function patchTicket(bundle: PlanBundle, n: number, patch: Partial<TicketContent>): void {
  bundle.tickets = bundle.tickets.map((ticket) => (ticket.id === tid(n) ? { ...ticket, ...patch } : ticket))
}

/**
 * Sprint 1 lists acceptance 9, optional 3, then 1, 2, 5, with 1 → 2 → 5: rows [3, 1], [2], [5].
 * Sprint 2 lists acceptance 8, then 7 and 6; 6 requires 5 across sprints, so both sit in row 1.
 * The sprints are stored out of ordinal order, and 9 also has an explicit edge from 2.
 */
function executionBundle(): PlanBundle {
  const bundle = makeBundle(
    [
      [9, 3, 1, 2, 5],
      [8, 7, 6]
    ],
    [
      [1, 2],
      [2, 5],
      [5, 6],
      [2, 9]
    ]
  )
  bundle.sprints.reverse()
  patchTicket(bundle, 3, { optional: true })
  patchTicket(bundle, 9, { kind: 'acceptance', acceptanceCriteria: [{ id: 'c1', text: 'Row two works', covers: tid(2) }] })
  patchTicket(bundle, 8, { kind: 'acceptance' })
  return bundle
}

function packetOf(bundle: PlanBundle, ticketStatuses: Record<string, WorkStatus> = {}): LinearTransferPacket {
  const input: LinearPacketInput = { epic: { id: EPIC_ID }, bundle, revisionId: REVISION_ID, revisionNumber: 4, ticketStatuses }
  return buildLinearPacket(input)
}

describe('buildLinearPacket execution order', () => {
  it('orders by sprint ordinal, then row, then sprint order, with the acceptance node last', () => {
    const packet = packetOf(executionBundle())
    expect(packet.issues.map((issue) => issue.ref)).toEqual([3, 1, 2, 5, 9, 7, 6, 8].map(tid))
    expect(packet.issues.map((issue) => issue.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(packet.issues.map((issue) => issue.milestoneRef)).toEqual([1, 1, 1, 1, 1, 2, 2, 2].map(sid))
    expect(packet.milestones.map((milestone) => [milestone.ref, milestone.position])).toEqual([
      [sid(1), 1],
      [sid(2), 2]
    ])
  })

  it('blocks the acceptance node by exactly its sprint required work tickets', () => {
    const packet = packetOf(executionBundle())
    const node = packet.issues.find((issue) => issue.ref === tid(9))
    expect(node?.blockedBy).toEqual([1, 2, 5].map(tid))
    const other = packet.issues.find((issue) => issue.ref === tid(8))
    expect(other?.blockedBy).toEqual([7, 6].map(tid))
  })
})

describe('buildLinearPacket relations', () => {
  it('turns each edge into a blocks relation from the prerequisite to the dependent', () => {
    const packet = packetOf(executionBundle())
    expect(packet.relations).toContainEqual({ ref: `rel:${tid(1)}:${tid(2)}`, kind: 'blocks', blockerRef: tid(1), blockedRef: tid(2) })
    expect(packet.relations).toContainEqual({ ref: `rel:${tid(5)}:${tid(6)}`, kind: 'blocks', blockerRef: tid(5), blockedRef: tid(6) })
    expect(packet.relations.some((item) => item.kind === 'blocks' && item.blockerRef === tid(2) && item.blockedRef === tid(1))).toBe(false)
    expect(packet.relations.every((item) => item.ref.length <= 64)).toBe(true)
  })

  it('adds no duplicate when an explicit edge repeats an acceptance prerequisite', () => {
    const packet = packetOf(executionBundle())
    const intoNode = packet.relations.filter((item) => item.kind === 'blocks' && item.blockedRef === tid(9))
    expect(intoNode.map((item) => item.ref)).toEqual([1, 2, 5].map((n) => `rel:${tid(n)}:${tid(9)}`))
    const refs = packet.relations.map((item) => item.ref)
    expect(new Set(refs).size).toBe(refs.length)
  })

  it('lists the relations in issue order', () => {
    const packet = packetOf(executionBundle())
    expect(packet.relations.map((item) => item.ref)).toEqual([
      `rel:${tid(1)}:${tid(2)}`,
      `rel:${tid(2)}:${tid(5)}`,
      `rel:${tid(1)}:${tid(9)}`,
      `rel:${tid(2)}:${tid(9)}`,
      `rel:${tid(5)}:${tid(9)}`,
      `rel:${tid(5)}:${tid(6)}`,
      `rel:${tid(7)}:${tid(8)}`,
      `rel:${tid(6)}:${tid(8)}`
    ])
  })

  it('turns related_to into one related relation per pair', () => {
    const bundle = executionBundle()
    bundle.relations = [
      { kind: 'related_to', from: tid(7), to: tid(3) },
      { kind: 'related_to', from: tid(3), to: tid(7) }
    ]
    const related = packetOf(bundle).relations.filter((item) => item.kind === 'related')
    expect(related).toEqual([{ ref: `see:${tid(3)}:${tid(7)}`, kind: 'related', fromRef: tid(3), toRef: tid(7) }])
  })

  it('writes a duplicate_of into the description and makes no relation of it', () => {
    const bundle = executionBundle()
    bundle.relations = [{ kind: 'duplicate_of', from: tid(7), to: tid(1) }]
    const packet = packetOf(bundle)
    const issue = packet.issues.find((item) => item.ref === tid(7))
    expect(issue?.description).toContain('- Duplicate of DM-1 (Ticket 1)')
    expect(packet.relations.some((item) => item.kind === 'related')).toBe(false)
  })
})

describe('buildLinearPacket fields', () => {
  it('maps each priority to its Linear number', () => {
    const bundle = executionBundle()
    patchTicket(bundle, 3, { priority: 'critical' })
    patchTicket(bundle, 1, { priority: 'high' })
    patchTicket(bundle, 2, { priority: 'normal' })
    patchTicket(bundle, 5, { priority: 'low' })
    const priorities = packetOf(bundle).issues.slice(0, 4).map((issue) => issue.priority)
    expect(priorities).toEqual([1, 2, 3, 4])
  })

  it('carries the tags as labels', () => {
    const bundle = executionBundle()
    patchTicket(bundle, 1, { tags: ['linear', 'core'] })
    expect(packetOf(bundle).issues.find((issue) => issue.ref === tid(1))?.labels).toEqual(['linear', 'core'])
  })

  it('gives a completed ticket the completed state and every other ticket the default', () => {
    const packet = packetOf(executionBundle(), { [tid(1)]: 'completed', [tid(2)]: 'in_progress' })
    const states = Object.fromEntries(packet.issues.map((issue) => [issue.ref, issue.state]))
    expect(states[tid(1)]).toBe('completed')
    expect(states[tid(2)]).toBe('default')
    expect(states[tid(3)]).toBe('default')
  })
})

describe('buildLinearPacket issue text', () => {
  it('ends each issue description with the back-link and the marker', () => {
    const bundle = executionBundle()
    patchTicket(bundle, 1, {
      body: 'Do the thing.\n',
      references: [{ kind: 'file', label: 'Spec', location: 'docs/spec.md', hash: null, remoteOnly: false }]
    })
    const issue = packetOf(bundle).issues.find((item) => item.ref === tid(1))
    const marker = `dm:${EPIC_ID}/${tid(1)}`
    expect(issue?.marker).toBe(marker)
    expect(issue?.description).toBe(
      [
        'Do the thing.',
        'Acceptance criteria\n- [ ] c1 Ticket 1 works',
        'References\n- Spec (file): docs/spec.md',
        `DM key DM-1 · epic ${EPIC_ID} · revision 4`,
        marker
      ].join('\n\n')
    )
  })

  it('names the covered key on an acceptance node and says when a ticket is optional', () => {
    const packet = packetOf(executionBundle())
    expect(packet.issues.find((item) => item.ref === tid(9))?.description).toContain('- [ ] c1 (DM-2) Row two works')
    expect(packet.issues.find((item) => item.ref === tid(3))?.description).toContain('Optional:')
    expect(packet.issues.find((item) => item.ref === tid(1))?.description).not.toContain('Optional:')
  })
})

describe('buildLinearPacket project and milestone text', () => {
  it('keeps the project summary within 255 characters, ending with the marker', () => {
    const packet = packetOf(executionBundle())
    const marker = `dm:${EPIC_ID}/project`
    expect(packet.project.summary).toBe(`From Dark Mechanicus: epic ${EPIC_ID}, revision 4\n${marker}`)
    expect(packet.project.content.endsWith(`\n${marker}`)).toBe(true)
    const long = buildLinearPacket({
      epic: { id: 'e'.repeat(200) },
      bundle: executionBundle(),
      revisionId: REVISION_ID,
      revisionNumber: 4,
      ticketStatuses: {}
    })
    expect(long.project.summary.length).toBeLessThanOrEqual(LINEAR_SUMMARY_MAX)
    expect(long.project.summary.endsWith(long.project.marker)).toBe(true)
  })

  it('names each milestone "Sprint N: <first line of goal>" and ends its description with the marker', () => {
    const bundle = executionBundle()
    bundle.sprints = bundle.sprints.map((sprint) =>
      sprint.id === sid(1)
        ? { ...sprint, goal: '\nShip the packet.\nMore detail.', exitCriteria: [{ id: 'x1', text: 'Packet built' }] }
        : sprint
    )
    const [first, second] = packetOf(bundle).milestones
    expect(first?.name).toBe('Sprint 1: Ship the packet.')
    expect(second?.name).toBe('Sprint 2: Sprint 2 goal')
    expect(first?.description).toBe(
      `\nShip the packet.\nMore detail.\n\nExit criteria\n- x1 Packet built\n\ndm:${EPIC_ID}/${sid(1)}`
    )
  })
})

describe('buildLinearPacket hash', () => {
  it('is stable for the same input and changes when a title changes', () => {
    const first = packetOf(executionBundle())
    expect(packetOf(executionBundle()).packetHash).toBe(first.packetHash)
    expect(first.packetHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    const renamed = executionBundle()
    patchTicket(renamed, 1, { title: 'Renamed' })
    expect(packetOf(renamed).packetHash).not.toBe(first.packetHash)
  })

  it('carries the packet header', () => {
    const packet = packetOf(executionBundle())
    expect(packet).toMatchObject({ format: 'darkmechanicus.linear-transfer', version: 1, epicId: EPIC_ID, revisionId: REVISION_ID })
  })
})
