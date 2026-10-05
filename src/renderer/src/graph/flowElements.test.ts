import { describe, expect, it } from 'vitest'
import { bundle, edge, execution, rowCheck, rowView, runView, savedPlan, sprint, ticket } from '../epic/__mocks__/fixtures'
import { toFlowEdges, toFlowNodes } from './flowElements'
import { buildGraphModel, type GraphModel } from './graphModel'

const MODEL: GraphModel = buildGraphModel({
  plan: savedPlan(),
  mode: 'saved',
  run: runView(),
  statuses: new Map(),
  outcome: null,
  rejected: null,
  draftNumber: 5
})

const added: string[] = []
const addedNodes: string[] = []
const OPTIONS = {
  editable: true,
  selectedTicketId: 'tk_202',
  onAddTicket: (id: string) => added.push(id),
  onAddAcceptance: (id: string) => addedNodes.push(id),
  onOpenActivity: () => undefined
}

describe('flow nodes', () => {
  it('maps ticket cards to draggable, connectable nodes with fixed size and handles', () => {
    const node = toFlowNodes(MODEL, OPTIONS).find((item) => item.id === 'tk_202')
    expect(node).toMatchObject({
      type: 'ticket',
      position: { x: 685, y: 304 },
      width: 210,
      height: 72,
      draggable: true,
      connectable: true,
      selectable: true,
      focusable: true,
      deletable: false,
      zIndex: 2,
      ariaLabel: 'DM-202 · RUNNING · ATTEMPT 2: Transactional bundle import',
      handles: [
        { type: 'target', position: 'top', x: 104.5, y: 0, width: 1, height: 1 },
        { type: 'source', position: 'bottom', x: 104.5, y: 72, width: 1, height: 1 }
      ]
    })
    expect(node?.data).toMatchObject({ active: true, editable: true })
    const other = toFlowNodes(MODEL, OPTIONS).find((item) => item.id === 'tk_201')
    expect(other?.data).toMatchObject({ active: false })
  })

  it('keeps structure nodes fixed and places dividers underneath', () => {
    const nodes = toFlowNodes(MODEL, { ...OPTIONS, editable: false })
    const fixed = nodes.filter((item) => item.type !== 'ticket')
    expect(fixed.map((item) => [item.type, item.draggable, item.selectable, item.connectable, item.zIndex])).toEqual([
      ['epic', false, false, false, 1],
      ['sprint', false, false, false, 1],
      ['divider', false, false, false, 0],
      ['sprint', false, false, false, 1],
      ['divider', false, false, false, 0],
      ['sprint', false, false, false, 1],
      ['divider', false, false, false, 0]
    ])
    expect(nodes.find((item) => item.id === 'tk_101')).toMatchObject({ draggable: false, connectable: false })
    const sprintNode = nodes.find((item) => item.type === 'sprint')
    if (sprintNode?.type === 'sprint') {
      sprintNode.data.onAddTicket('sp_1')
    }
    expect(added).toEqual(['sp_1'])
  })
})

/** DM-1, then DM-2 after it, then Sprint 1's node DM-91; the run has a failed check on row 1 and none on row 2. */
const ACCEPTANCE_MODEL = ((): GraphModel => {
  const work = [ticket('DM-1', 'One'), ticket('DM-2', 'Two')]
  const node = ticket('DM-91', 'Sprint 1 acceptance', { kind: 'acceptance' })
  const planBundle = bundle({ tickets: [...work, node], sprints: [sprint(1, 'Build', ['tk_1', 'tk_2', 'tk_91'])], edges: [edge(1, 2)] })
  const rows = [rowView('sp_1', 1, ['DM-1'], rowCheck('sp_1', 1, false)), rowView('sp_1', 2, ['DM-2'])]
  return buildGraphModel({
    plan: savedPlan({ bundle: planBundle }),
    mode: 'saved',
    run: runView({ tickets: [execution('DM-1', 'sp_1', 'accepted'), execution('DM-2', 'sp_1', 'ready')], rows }),
    statuses: new Map(),
    outcome: null,
    rejected: null,
    draftNumber: 5
  })
})()
const ACCEPTANCE_NODES = toFlowNodes(ACCEPTANCE_MODEL, OPTIONS)

describe('flow nodes for acceptance nodes', () => {
  const nodes = ACCEPTANCE_NODES

  it('selects and connects an acceptance node like a ticket but never drags it out of its sprint', () => {
    expect(nodes.find((item) => item.id === 'tk_91')).toMatchObject({
      type: 'ticket',
      draggable: false,
      connectable: true,
      selectable: true,
      focusable: true,
      zIndex: 2
    })
    expect(nodes.find((item) => item.id === 'tk_2')).toMatchObject({ draggable: true })
    expect(nodes.find((item) => item.id === 'tk_91')?.data).toMatchObject({ editable: true })
  })
})

describe('flow nodes for joins and row checks', () => {
  const nodes = ACCEPTANCE_NODES

  it('keeps the join and the row checks fixed, the join under the cards and the chips able to show a tooltip', () => {
    const join = nodes.find((item) => item.id === 'join:sp_1')
    expect(join).toMatchObject({
      type: 'join',
      draggable: false,
      selectable: false,
      connectable: false,
      focusable: false,
      zIndex: 0,
      width: 14
    })
    const chips = nodes.filter((item) => item.type === 'rowcheck')
    expect(chips.map((item) => [item.id, item.draggable, item.selectable, item.focusable, item.zIndex])).toEqual([
      ['rowcheck:sp_1:1', false, false, false, 1],
      ['rowcheck:sp_1:2', false, false, false, 1]
    ])
    expect(chips.map((item) => item.style)).toEqual([{ pointerEvents: 'all' }, { pointerEvents: 'all' }])
    expect(chips[0]?.data).toMatchObject({ model: { state: 'failed', status: 'FAILED' } })
  })
})

describe('flow nodes of a sprint label', () => {
  it('hands the sprint label both add handlers', () => {
    const label = ACCEPTANCE_NODES.find((item) => item.type === 'sprint')
    if (label?.type === 'sprint') {
      label.data.onAddAcceptance('sp_1')
      expect(label.data.model.hasAcceptance).toBe(true)
    }
    expect(addedNodes).toEqual(['sp_1'])
  })
})

describe('flow edges', () => {
  it('draws met prerequisites solid and waiting ones dashed, deletable only while editing', () => {
    const edges = toFlowEdges(MODEL, true)
    expect(edges[0]).toMatchObject({
      id: 'tk_101->tk_203',
      source: 'tk_101',
      target: 'tk_203',
      type: 'default',
      className: 'pg-edge is-met',
      markerEnd: { type: 'arrowclosed', width: 16, height: 16, color: 'var(--edge)' },
      selectable: true,
      deletable: true,
      focusable: true,
      ariaLabel: 'DM-203 requires DM-101 (met)'
    })
    const waiting = edges.find((item) => item.id === 'tk_204->tk_301')
    expect(waiting).toMatchObject({
      className: 'pg-edge is-waiting',
      markerEnd: { color: 'var(--edge-waiting)' },
      ariaLabel: 'DM-301 requires DM-204 (waiting)'
    })
    expect(toFlowEdges(MODEL, false)[0]).toMatchObject({ selectable: false, deletable: false, focusable: false })
  })
})

describe('flow nodes for a long sprint goal', () => {
  const goal = 'Every word of this goal is shown or reachable, and it keeps going so that the label needs many lines. '.repeat(4)
  const sprints = [sprint(1, goal, ['tk_101']), sprint(2, 'Next', ['tk_201'])]
  const longModel = buildGraphModel({
    plan: savedPlan({ bundle: bundle({ sprints, edges: [] }) }),
    mode: 'saved',
    run: null,
    statuses: new Map(),
    outcome: null,
    rejected: null,
    draftNumber: 5
  })
  const nodes = toFlowNodes(longModel, { ...OPTIONS, editable: false })

  function find(id: string) {
    const found = nodes.find((item) => item.id === id)
    if (!found) {
      throw new Error(`missing node ${id}`)
    }
    return found
  }

  it('places the checkpoint divider below the whole sprint label', () => {
    expect(goal.length).toBeGreaterThanOrEqual(300)
    const label = find('sprint:sp_1')
    const divider = find('checkpoint:1')
    expect(label.height).toBeGreaterThan(72)
    expect(label.position.y + (label.height ?? 0)).toBeLessThanOrEqual(divider.position.y)
  })

  it('keeps the next sprint label under the divider pill', () => {
    const divider = find('checkpoint:1')
    expect(divider.position.y + (divider.height ?? 0)).toBeLessThanOrEqual(find('sprint:sp_2').position.y)
  })

  it('hands the node the reserved line count so it can clamp the goal', () => {
    const label = find('sprint:sp_1')
    expect(label.type === 'sprint' ? label.data.model.goalLines : null).toBe(6)
  })
})
