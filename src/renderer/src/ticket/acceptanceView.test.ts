import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../../shared/domain/bundle'
import { attempt, bundle, sprint, ticket } from '../epic/__mocks__/fixtures'
import { coverageView, definitionOfDoneRows } from './acceptanceView'

const DEFINITION = [
  { name: 'Unit tests', command: 'npm test', description: 'Every unit test passes.' },
  { name: 'Typecheck', command: 'npm run typecheck', description: 'No type errors.' },
  { name: 'Build', command: 'npm run build', description: 'The app builds.' }
]

/** Sprint 1: DM-1, DM-2, an optional DM-3, a required DM-4 no criterion covers, and the node DM-91. DM-5 is in Sprint 2. */
function planWithNode(criteria = NODE_CRITERIA): PlanBundle {
  return bundle({
    tickets: [
      ticket('DM-1', 'Row checks'),
      ticket('DM-2', 'Increments'),
      ticket('DM-3', 'Nice to have', { optional: true }),
      ticket('DM-4', 'Docs'),
      ticket('DM-5', 'Later work'),
      ticket('DM-91', 'Sprint 1 acceptance', { kind: 'acceptance', acceptanceCriteria: criteria })
    ],
    sprints: [sprint(1, 'Build', ['tk_1', 'tk_2', 'tk_3', 'tk_4', 'tk_91']), sprint(2, 'Ship', ['tk_5'])],
    edges: []
  })
}

const NODE_CRITERIA = [
  { id: 'c1', text: 'Row 1 check passes', covers: 'tk_1' },
  { id: 'c2', text: 'No regression in row checks', covers: 'tk_1' },
  { id: 'c3', text: 'Increment is one commit', covers: 'tk_2' },
  { id: 'c4', text: 'Demo works end to end' }
]

function node(plan = planWithNode()) {
  const found = plan.tickets.find((item) => item.id === 'tk_91')
  if (!found) {
    throw new Error('no node')
  }
  return found
}

describe('coverageView', () => {
  it('groups the criteria by the ticket each covers, in sprint order, with the sprint-wide ones last', () => {
    const view = coverageView(node(), [], planWithNode())
    expect(view.heading).toBe('ACCEPTANCE CRITERIA · 0 OF 4 VERIFIED')
    expect(view.groups.map((group) => [group.key, group.title, group.items.map((item) => item.id)])).toEqual([
      ['DM-1', 'Row checks', ['c1', 'c2']],
      ['DM-2', 'Increments', ['c3']],
      ['DM-4', 'Docs', []],
      ['', 'The sprint as a whole', ['c4']]
    ])
  })

  it('links a group to its ticket and marks a required ticket no criterion covers', () => {
    const groups = coverageView(node(), [], planWithNode()).groups
    expect(groups.map((group) => [group.ticketId, group.uncovered])).toEqual([
      ['tk_1', false],
      ['tk_2', false],
      ['tk_4', true],
      [null, false]
    ])
  })

  it('leaves an optional ticket out until a criterion covers it', () => {
    const covered = planWithNode([...NODE_CRITERIA, { id: 'c5', text: 'Nice thing works', covers: 'tk_3' }])
    const groups = coverageView(node(covered), [], covered).groups
    expect(groups.map((group) => group.key)).toEqual(['DM-1', 'DM-2', 'DM-3', 'DM-4', ''])
    expect(groups[2]?.items.map((item) => item.id)).toEqual(['c5'])
  })

  it('keeps a criterion that covers a ticket outside the sprint, or one that no longer exists, in its own group', () => {
    const odd = planWithNode([
      { id: 'c1', text: 'Row 1 check passes', covers: 'tk_1' },
      { id: 'c2', text: 'Later work lands', covers: 'tk_5' },
      { id: 'c3', text: 'Gone', covers: 'tk_gone' }
    ])
    const groups = coverageView(node(odd), [], odd).groups
    expect(groups.map((group) => [group.ticketId, group.key, group.title])).toEqual([
      ['tk_1', 'DM-1', 'Row checks'],
      ['tk_2', 'DM-2', 'Increments'],
      ['tk_4', 'DM-4', 'Docs'],
      ['tk_5', 'DM-5', 'Later work'],
      ['tk_gone', 'tk_gone', '']
    ])
  })

})

describe('coverageView with evidence and unusual plans', () => {

  it('shows what the latest evidence says about each criterion', () => {
    const evidence = attempt('DM-91', 1, 'submitted', {
      evidence: {
        checks: [],
        criteria: [
          { criterionId: 'c1', met: true, note: 'row_check test' },
          { criterionId: 'c2', met: false, note: 'flaky' }
        ],
        notes: ''
      }
    })
    const view = coverageView(node(), [evidence], planWithNode())
    expect(view.heading).toBe('ACCEPTANCE CRITERIA · 1 OF 4 VERIFIED')
    expect(view.groups[0]?.items).toEqual([
      { id: 'c1', text: 'Row 1 check passes', verified: true, note: 'row_check test' },
      { id: 'c2', text: 'No regression in row checks', verified: false, note: 'flaky' }
    ])
  })

  it('has only the sprint-wide group and no heading count for a node with no criteria', () => {
    const empty = planWithNode([])
    const view = coverageView(node(empty), [], empty)
    expect(view.heading).toBe('ACCEPTANCE CRITERIA · NONE YET')
    expect(view.groups.map((group) => group.key)).toEqual(['DM-1', 'DM-2', 'DM-4'])
  })

  it('works for a node that is in no sprint of the plan', () => {
    const loose = planWithNode()
    const sprints = loose.sprints.map((item) => ({ ...item, ticketIds: item.ticketIds.filter((id) => id !== 'tk_91') }))
    const view = coverageView(node(loose), [], { ...loose, sprints })
    expect(view.groups.map((group) => group.key)).toEqual(['DM-1', 'DM-2', ''])
  })
})

describe('definitionOfDoneRows', () => {
  it('lists every check with its command and description and no status before any evidence exists', () => {
    expect(definitionOfDoneRows(DEFINITION, node(), [])).toEqual([
      { name: 'Unit tests', command: 'npm test', description: 'Every unit test passes.', status: null },
      { name: 'Typecheck', command: 'npm run typecheck', description: 'No type errors.', status: null },
      { name: 'Build', command: 'npm run build', description: 'The app builds.', status: null }
    ])
  })

  it('marks each check passed, failed, skipped or not reported from the latest evidence, matching names loosely', () => {
    const reported = attempt('DM-91', 1, 'submitted', {
      evidence: {
        checks: [
          { name: ' unit TESTS ', status: 'passed', detail: '' },
          { name: 'Typecheck', status: 'failed', detail: '2 errors' },
          { name: 'Lint', status: 'passed', detail: 'not part of the definition' }
        ],
        criteria: [],
        notes: ''
      }
    })
    expect(definitionOfDoneRows(DEFINITION, node(), [reported]).map((row) => [row.name, row.status])).toEqual([
      ['Unit tests', 'passed'],
      ['Typecheck', 'failed'],
      ['Build', 'not reported']
    ])
  })

  it('counts a check that is also reported skipped as skipped', () => {
    const reported = attempt('DM-91', 1, 'submitted', {
      evidence: {
        checks: [
          { name: 'Build', status: 'passed', detail: '' },
          { name: 'Build', status: 'skipped', detail: 'cached' }
        ],
        criteria: [],
        notes: ''
      }
    })
    expect(definitionOfDoneRows(DEFINITION, node(), [reported]).map((row) => row.status)).toEqual(['not reported', 'not reported', 'skipped'])
  })

  it('is empty for a project without a Definition of Done', () => {
    expect(definitionOfDoneRows([], node(), [])).toEqual([])
  })
})
