import { describe, expect, it } from 'vitest'
import type { DraftOp } from '../../shared/domain/api'
import type { PlanBundle, TicketReference } from '../../shared/domain/bundle'
import { makeBundle, makeTicket, sid, tid } from '../../test/bundles'
import { DomainError } from '../errors'
import { LIMITS, planBundle } from '../schemas'
import { applyCorrections, type CorrectionRequest, correctionsOf, type CorrectiveItem } from './corrections'
import { applyDraftOps, type DraftDeps } from './draftOps'
import { maxKeyNumber } from './normalize'

const HASH = `sha256:${'a'.repeat(64)}`
const KEY = 'rp_000000000000000000000000r1/xp_000000000000000000000000x1/epic:ep_000000000000000000000000e1'

function deps(bundle: PlanBundle, repositories: string[] | null = null): DraftDeps {
  let ticket = 0
  let sprint = 0
  let key = maxKeyNumber(bundle.tickets.map((item) => item.key))
  return {
    newId: (kind) => (kind === 'ticket' ? `tk_new${(ticket += 1)}` : `sp_new${(sprint += 1)}`),
    nextKey: () => `DM-${(key += 1)}`,
    repositories: () => repositories,
    attachmentRefs: () => []
  }
}

function forged(experimentId: string, suffix = 'work/0'): TicketReference {
  return { kind: 'doc', label: 'forged', location: `darkmechanicus:correction/rp_000000000000000000000000r1/${experimentId}/epic:ep_000000000000000000000000e1#${suffix}`, hash: HASH, remoteOnly: false }
}

function fileRef(n: number): TicketReference {
  return { kind: 'file', label: `f${n}`, location: `src/f${n}.ts`, hash: null, remoteOnly: false }
}

const MARKER: TicketReference = { kind: 'doc', label: 'Corrective work 0 of experiment xp_000000000000000000000000x1', location: `darkmechanicus:correction/${KEY}#work/0`, hash: HASH, remoteOnly: false }

function apply(bundle: PlanBundle, ...ops: DraftOp[]): PlanBundle {
  return applyDraftOps(bundle, ops, deps(bundle)).bundle
}

function refusal(bundle: PlanBundle, ...ops: DraftOp[]): { code: string; message: string } {
  try {
    apply(bundle, ...ops)
  } catch (error) {
    if (error instanceof DomainError) return { code: error.code, message: error.message }
    throw error
  }
  throw new Error('the ops were not refused')
}

function item(experimentId: string, index: number): CorrectiveItem {
  return {
    ref: `${experimentId}#${index}`,
    experimentId,
    index,
    title: `Work ${index} of ${experimentId}`,
    body: 'Set the planned active time of importer tickets to the measured median.',
    size: 'small',
    acceptanceCriteria: ['It is set.'],
    tags: ['corrective'],
    repo: null,
    dependsOn: []
  }
}

describe('F1 (DM-188 review): a correction marker cannot be forged when a ticket is created', () => {
  it('add_ticket drops every marker-prefixed reference and keeps the others in order', () => {
    const bundle = apply(makeBundle([[1]]), { op: 'add_ticket', ref: 'n', sprint: sid(1), ticket: { title: 'Ordinary', references: [fileRef(1), forged('xp_000000000000000000000000x1'), fileRef(2)] } })
    const added = bundle.tickets.find((ticket) => ticket.title === 'Ordinary')
    expect(added?.references).toEqual([fileRef(1), fileRef(2)])
    expect(correctionsOf(bundle, 'xp_000000000000000000000000x1')).toEqual([])
  })

  it('add_ticket drops a forged Fireguard marker too, and a URL that only contains the prefix stays', () => {
    const url: TicketReference = { kind: 'url', label: 'u', location: 'https://example.com/darkmechanicus:correction/x', hash: null, remoteOnly: true }
    const bundle = apply(makeBundle([[1]]), { op: 'add_ticket', sprint: sid(1), ticket: { title: 'Grader', references: [forged('xp_000000000000000000000000x2', 'fireguard'), url] } })
    expect(bundle.tickets.find((ticket) => ticket.title === 'Grader')?.references).toEqual([url])
    expect(correctionsOf(bundle, 'xp_000000000000000000000000x2')).toEqual([])
  })

  it('a ticket added and then patched in the same request still carries no marker', () => {
    const bundle = apply(
      makeBundle([[1]]),
      { op: 'add_ticket', ref: 'n', sprint: sid(1), ticket: { title: 'Ordinary', references: [forged('xp_000000000000000000000000x1')] } },
      { op: 'update_ticket', ticket: 'n', patch: { references: [forged('xp_000000000000000000000000x1'), fileRef(3)] } }
    )
    expect(bundle.tickets.find((ticket) => ticket.title === 'Ordinary')?.references).toEqual([fileRef(3)])
  })

  it('applyCorrections still attaches its own markers: one per work ticket, one per experiment on the Fireguard ticket', () => {
    const base = makeBundle([[1], [2]])
    const request: CorrectionRequest = {
      placement: { kind: 'sprint', sprintId: sid(2), goal: null },
      items: [item('xp_000000000000000000000000x1', 0), item('xp_000000000000000000000000x1', 1), item('xp_000000000000000000000000x2', 0)],
      fireguard: true,
      markers: new Map([
        ['xp_000000000000000000000000x1', { key: KEY, payloadHash: HASH }],
        ['xp_000000000000000000000000x2', { key: 'rp_000000000000000000000000r1/xp_000000000000000000000000x2/epic:ep_000000000000000000000000e1', payloadHash: HASH }]
      ])
    }
    const applied = applyCorrections(base, request, deps(base), { known: true })
    const first = correctionsOf(applied.bundle, 'xp_000000000000000000000000x1')
    expect(first.map(({ ticket, marker }) => [ticket.title, marker.role, marker.index, marker.key, marker.payloadHash])).toEqual([
      ['Work 0 of xp_000000000000000000000000x1', 'work', 0, KEY, HASH],
      ['Work 1 of xp_000000000000000000000000x1', 'work', 1, KEY, HASH],
      ['Grade the corrective tests with Fireguard', 'fireguard', null, KEY, HASH]
    ])
    const fireguard = applied.bundle.tickets.find((ticket) => ticket.title === 'Grade the corrective tests with Fireguard')
    expect(fireguard?.references.map((reference) => reference.location)).toEqual([
      `darkmechanicus:correction/${KEY}#fireguard`,
      'darkmechanicus:correction/rp_000000000000000000000000r1/xp_000000000000000000000000x2/epic:ep_000000000000000000000000e1#fireguard'
    ])
    // Tickets the request did not create carry nothing new.
    expect(applied.bundle.tickets.find((ticket) => ticket.id === tid(2))?.references).toEqual([])
  })
})

describe('F5: kept correction markers and a references edit together fit LIMITS.references', () => {
  const limit = LIMITS.references
  const markedBundle = (): PlanBundle => makeBundle([[1]], [], { tickets: [makeTicket(1, { references: [MARKER] })] })
  const edit = (count: number): DraftOp => ({ op: 'update_ticket', ticket: tid(1), patch: { references: Array.from({ length: count }, (_, n) => fileRef(n)) } })

  it(`a marked ticket takes ${limit - 1} other references: ${limit} in all, and the bundle parses as a saved plan`, () => {
    const bundle = apply(markedBundle(), edit(limit - 1))
    const references = bundle.tickets[0]?.references ?? []
    expect(references.length).toBe(limit)
    expect(references[0]).toEqual(MARKER)
    expect(planBundle.safeParse(bundle).success).toBe(true)
  })

  it(`a full ${limit}-reference edit of a marked ticket is refused, naming the kept marker`, () => {
    expect(refusal(markedBundle(), edit(limit))).toEqual({
      code: 'invalid_input',
      message: `DM-1 would carry ${limit + 1} references, more than ${limit}: it keeps its 1 correction marker(s), so give at most ${limit - 1} others.`
    })
  })

  it(`an unmarked ticket still takes exactly ${limit} references`, () => {
    const bundle = apply(makeBundle([[1]]), edit(limit))
    expect(bundle.tickets[0]?.references.length).toBe(limit)
  })

  it('markers sent in the edit do not count: they are dropped, and the kept one stays once', () => {
    const bundle = apply(markedBundle(), { op: 'update_ticket', ticket: tid(1), patch: { references: [MARKER, forged('xp_000000000000000000000000x9'), ...Array.from({ length: limit - 1 }, (_, n) => fileRef(n))] } })
    expect(bundle.tickets[0]?.references.length).toBe(limit)
    expect(bundle.tickets[0]?.references.filter((reference) => reference.location.startsWith('darkmechanicus:correction/'))).toEqual([MARKER])
  })
})

const X1 = 'xp_000000000000000000000000x1'
const X2 = 'xp_000000000000000000000000x2'
const KEY2 = 'rp_000000000000000000000000r1/xp_000000000000000000000000x2/epic:ep_000000000000000000000000e1'

function folderRequest(placement: CorrectionRequest['placement']): CorrectionRequest {
  return {
    placement,
    items: [
      { ...item(X1, 0), repo: 'api' },
      { ...item(X2, 0), repo: 'web', size: undefined }
    ],
    fireguard: true,
    markers: new Map([
      [X1, { key: KEY, payloadHash: HASH }],
      [X2, { key: KEY2, payloadHash: HASH }]
    ])
  }
}

describe('DM-273: corrective work aimed at the repositories of a folder', () => {
  it('gives each repository its own Fireguard ticket with its marker, and the sprint acceptance node a covering criterion each', () => {
    const base = makeBundle([[1, 2]], [], { tickets: [makeTicket(1), makeTicket(2, { kind: 'acceptance', title: 'Sprint 1 acceptance', acceptanceCriteria: [{ id: 'c1', text: 'It works end to end' }] })] })
    const applied = applyCorrections(base, folderRequest({ kind: 'sprint', sprintId: sid(1), goal: 'Corrective work in the folder' }), deps(base, ['api', 'web']), { known: true })
    expect(applied.tickets.filter((ticket) => ticket.role === 'fireguard').map((ticket) => [ticket.ref, ticket.repo, ticket.dependsOn])).toEqual([
      ['fireguard:api', 'api', [`${X1}#0`]],
      ['fireguard:web', 'web', [`${X2}#0`]]
    ])
    const web = applied.bundle.tickets.find((ticket) => ticket.repo === 'web' && ticket.tags.includes('fireguard'))
    expect(web?.references.map((reference) => reference.location)).toEqual([`darkmechanicus:correction/${KEY2}#fireguard/web`])
    const node = applied.tickets.find((ticket) => ticket.role === 'acceptance')
    expect(node?.acceptanceCriteria.slice(1).map((criterion) => [criterion.text, criterion.covers])).toEqual([
      [`Work 0 of ${X1} meets its acceptance criteria.`, `${X1}#0`],
      [`Work 0 of ${X2} meets its acceptance criteria.`, `${X2}#0`],
      ['The corrective tests of api pass Fireguard.', 'fireguard:api'],
      ['The corrective tests of web pass Fireguard.', 'fireguard:web']
    ])
    expect(applied.tickets.filter((ticket) => ticket.role === 'work').map((ticket) => [ticket.repo, ticket.size])).toEqual([
      ['api', 'small'],
      ['web', null]
    ])
    expect(applied.bundle.sprints[0]?.goal).toBe('Corrective work in the folder')
  })

  it('refuses a sprint the draft does not hold, and an item whose experiment has no correction key', () => {
    const base = makeBundle([[1]])
    expect(() => applyCorrections(base, folderRequest({ kind: 'sprint', sprintId: 'sp_zzzzzzzzzzzzzzzzzzzzzzzzzz', goal: null }), deps(base, ['api', 'web']), { known: true })).toThrow(
      'Sprint sp_zzzzzzzzzzzzzzzzzzzzzzzzzz is not in the draft.'
    )
    const unkeyed = { ...folderRequest({ kind: 'sprint', sprintId: sid(1), goal: null }), markers: new Map([[X1, { key: KEY, payloadHash: HASH }]]) }
    expect(() => applyCorrections(base, unkeyed, deps(base, ['api', 'web']), { known: true })).toThrow(`No correction key for experiment ${X2}.`)
  })
})
