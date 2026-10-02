import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../../shared/domain/bundle'
import type { RunView } from '../../../shared/domain/views'
import {
  bundle,
  draftPlan,
  edge,
  execution,
  runView,
  savedPlan,
  sprint,
  ticket
} from '../epic/__mocks__/fixtures'
import {
  buildGraphModel,
  dropTarget,
  sprintAtY,
  type GraphInput,
  type GraphModel,
  type GraphNode,
  type SprintNodeModel
} from './graphModel'

function input(patch: Partial<GraphInput> = {}): GraphInput {
  return {
    plan: savedPlan(),
    mode: 'saved',
    run: runView(),
    statuses: new Map(),
    outcome: null,
    rejected: null,
    draftNumber: 5,
    ...patch
  }
}

function node(model: GraphModel, id: string): GraphNode {
  const found = model.nodes.find((item) => item.id === id)
  if (!found) {
    throw new Error(`missing node ${id}`)
  }
  return found
}

function sprintNode(model: GraphModel, sprintId: string): SprintNodeModel {
  const found = node(model, `sprint:${sprintId}`)
  if (found.kind !== 'sprint') {
    throw new Error(`${sprintId} is not a sprint`)
  }
  return found
}

function box(model: GraphModel, id: string): [number, number] {
  const found = node(model, id)
  return [found.x, found.y]
}

function text(model: GraphModel, id: string): string {
  const found = node(model, id)
  switch (found.kind) {
    case 'ticket':
      return found.label
    case 'sprint':
      return `${found.heading} | ${found.goal} | ${found.detail}`
    case 'divider':
      return `${found.label} (${found.tone})`
    case 'epic':
      return `${found.eyebrow} | ${found.title}`
  }
}

function withSprints(sprints: PlanBundle['sprints'], edges: PlanBundle['edges'], tickets = bundle().tickets): GraphInput {
  return input({ run: null, plan: savedPlan({ bundle: bundle({ sprints, edges, tickets }) }) })
}

describe('graph layout of the sample plan (1) (1)', () => {
  const model = buildGraphModel(input())

  it('stacks sprints top to bottom and orders columns by prerequisite barycenter', () => {
    expect([box(model, 'tk_101'), box(model, 'tk_102'), box(model, 'tk_103')]).toEqual([
      [185, 128],
      [435, 128],
      [685, 128]
    ])
    expect([box(model, 'tk_203'), box(model, 'tk_201'), box(model, 'tk_202')]).toEqual([
      [185, 304],
      [435, 304],
      [685, 304]
    ])
    expect([box(model, 'tk_301'), box(model, 'tk_302'), box(model, 'tk_304')]).toEqual([
      [185, 592],
      [435, 592],
      [685, 592]
    ])
  })

  it('places a ticket below its same-sprint prerequisite', () => {
    expect(box(model, 'tk_204')).toEqual([185, 416])
  })

  it('positions the epic containment node, sprint labels and dividers', () => {
    expect(node(model, 'epic')).toMatchObject({ x: 320, y: 24, width: 440, height: 64 })
    expect(node(model, 'sprint:sp_1')).toMatchObject({ x: 24, y: 132, width: 140, height: 72 })
    expect(node(model, 'sprint:sp_2')).toMatchObject({ x: 24, y: 308, height: 184 })
    expect(node(model, 'checkpoint:1')).toMatchObject({ x: 16, y: 238, width: 1143, height: 28 })
    expect(node(model, 'checkpoint:2')).toMatchObject({ y: 526 })
    expect(node(model, 'checks')).toMatchObject({ y: 702 })
    expect(model.nodes.filter((item) => item.kind === 'divider').map((item) => item.id)).toEqual([
      'checkpoint:1',
      'checkpoint:2',
      'checks'
    ])
    expect(node(model, 'tk_101')).toMatchObject({ width: 210, height: 72, sprintId: 'sp_1' })
  })
})

describe('graph layout of the sample plan (1) (2)', () => {
  const model = buildGraphModel(input())

  it('keeps the epic node free of dependency edges and ignores relations', () => {
    expect(model.edges.some((item) => item.from === 'epic' || item.to === 'epic')).toBe(false)
    expect(model.edges.map((item) => item.id)).toEqual([
      'tk_101->tk_203',
      'tk_102->tk_201',
      'tk_102->tk_202',
      'tk_103->tk_202',
      'tk_203->tk_204',
      'tk_204->tk_301',
      'tk_201->tk_301',
      'tk_201->tk_302',
      'tk_202->tk_304'
    ])
  })
})

describe('graph layout of the sample plan (2)', () => {
  const model = buildGraphModel(input())

  it('exposes drop bands between checkpoint dividers', () => {
    expect(model.bands).toEqual([
      { sprintId: 'sp_1', top: -Infinity, bottom: 252 },
      { sprintId: 'sp_2', top: 252, bottom: 540 },
      { sprintId: 'sp_3', top: 540, bottom: Infinity }
    ])
  })
})

describe('graph execution overlay (1)', () => {
  const model = buildGraphModel(input())

  it('pairs every execution state color with a text label', () => {
    expect(text(model, 'tk_101')).toBe('DM-101 · ACCEPTED')
    expect(text(model, 'tk_201')).toBe('DM-201 · IN REVIEW')
    expect(text(model, 'tk_202')).toBe('DM-202 · RUNNING · ATTEMPT 2')
    expect(text(model, 'tk_204')).toBe('DM-204 · READY')
    expect(text(model, 'tk_301')).toBe('DM-301 · WAITING')
    expect(node(model, 'tk_202')).toMatchObject({ tone: 'running', dashed: false, note: null })
    expect(node(model, 'tk_301')).toMatchObject({ tone: 'waiting', dashed: true })
    expect(node(model, 'tk_201')).toMatchObject({ tone: 'review' })
  })

  it('draws solid edges only when the prerequisite is accepted', () => {
    const met = Object.fromEntries(model.edges.map((item) => [item.id, item.met]))
    expect(met).toEqual({
      'tk_101->tk_203': true,
      'tk_102->tk_201': true,
      'tk_102->tk_202': true,
      'tk_103->tk_202': true,
      'tk_203->tk_204': true,
      'tk_204->tk_301': false,
      'tk_201->tk_301': false,
      'tk_201->tk_302': false,
      'tk_202->tk_304': false
    })
  })

  it('labels sprints, checkpoints and epic checks from run progress', () => {
    expect(text(model, 'sprint:sp_1')).toBe('SPRINT 1 | Storage foundation | 3 of 3 accepted')
    expect(text(model, 'sprint:sp_2')).toBe('SPRINT 2 | Authoring through MCP | Active · 1 of 4 accepted')
    expect(text(model, 'sprint:sp_3')).toBe('SPRINT 3 | Desktop editing | Waiting on checkpoint 2')
    expect(node(model, 'sprint:sp_2')).toMatchObject({ active: true })
    expect(node(model, 'sprint:sp_1')).toMatchObject({ active: false })
    expect(text(model, 'checkpoint:1')).toBe('CHECKPOINT 1 · PASSED (passed)')
    expect(text(model, 'checkpoint:2')).toBe('CHECKPOINT 2 · LOCKED · 1 OF 4 ACCEPTED (locked)')
    expect(text(model, 'checks')).toBe('EPIC CHECKS · 0 OF 3 MET (neutral)')
    expect(text(model, 'epic')).toBe('EPIC · 10 TICKETS · 3 SPRINTS | Plan through MCP, edit on the desktop')
  })

  it('marks tickets missing from the pinned run and treats their edges as waiting', () => {
    const run = runView({ tickets: runView().tickets.filter((item) => item.ticketId !== 'tk_101') })
    const model2 = buildGraphModel(input({ run }))
    expect(text(model2, 'tk_101')).toBe('DM-101 · NOT IN RUN')
    expect(node(model2, 'tk_101')).toMatchObject({ tone: 'neutral', dashed: true })
    expect(model2.edges.find((item) => item.id === 'tk_101->tk_203')?.met).toBe(false)
  })
})

describe('graph execution overlay (2)', () => {
  it('shows a running first attempt without an attempt suffix', () => {
    const run = runView({ tickets: [execution('DM-202', 'sp_2', 'running', { attemptCount: 1 })] })
    expect(text(buildGraphModel(input({ run })), 'tk_202')).toBe('DM-202 · RUNNING')
  })
})

describe('graph run phases', () => {
  function labels(run: RunView): string[] {
    const model = buildGraphModel(input({ run }))
    return ['sprint:sp_2', 'checkpoint:1', 'checkpoint:2'].map((id) => text(model, id))
  }

  it('shows an awaiting checkpoint on the active sprint', () => {
    expect(labels(runView({ state: 'awaiting_checkpoint' }))).toEqual([
      'SPRINT 2 | Authoring through MCP | Awaiting checkpoint',
      'CHECKPOINT 1 · PASSED (passed)',
      'CHECKPOINT 2 · AWAITING APPROVAL (locked)'
    ])
  })

  it('passes every checkpoint once the run completed', () => {
    expect(labels(runView({ state: 'completed' }))).toEqual([
      'SPRINT 2 | Authoring through MCP | 1 of 4 accepted',
      'CHECKPOINT 1 · PASSED (passed)',
      'CHECKPOINT 2 · PASSED (passed)'
    ])
    expect(node(buildGraphModel(input({ run: runView({ state: 'completed' }) })), 'sprint:sp_2')).toMatchObject({
      active: false
    })
  })

  it('falls back to the checkpoint policy before a queued run has an active sprint', () => {
    expect(labels(runView({ state: 'queued', activeSprintOrdinal: null, activeSprintId: null }))).toEqual([
      'SPRINT 2 | Authoring through MCP | 4 tickets',
      'CHECKPOINT 1 · HUMAN APPROVAL (neutral)',
      'CHECKPOINT 2 · HUMAN APPROVAL (neutral)'
    ])
  })

  it('locks checkpoints after the active sprint', () => {
    const labelsAtOne = labels(runView({ activeSprintOrdinal: 1, activeSprintId: 'sp_1' }))
    expect(labelsAtOne).toEqual([
      'SPRINT 2 | Authoring through MCP | Waiting on checkpoint 1',
      'CHECKPOINT 1 · LOCKED · 3 OF 3 ACCEPTED (locked)',
      'CHECKPOINT 2 · LOCKED (neutral)'
    ])
  })
})

describe('graph without a run (1)', () => {
  it('labels tickets with their lifecycle status', () => {
    const statuses = new Map([
      ['tk_101', 'completed' as const],
      ['tk_102', 'in_progress' as const]
    ])
    const model = buildGraphModel(input({ run: null, statuses }))
    expect(text(model, 'tk_101')).toBe('DM-101 · COMPLETED')
    expect(node(model, 'tk_101')).toMatchObject({ tone: 'accepted', dashed: false })
    expect(text(model, 'tk_102')).toBe('DM-102 · IN PROGRESS')
    expect(text(model, 'tk_103')).toBe('DM-103 · BACKLOG')
    expect(model.edges.every((item) => item.met)).toBe(true)
    expect(text(model, 'sprint:sp_1')).toBe('SPRINT 1 | Storage foundation | 3 tickets')
    expect(node(model, 'sprint:sp_2')).toMatchObject({ active: false })
  })

  it('names the checkpoint policy of each sprint', () => {
    const plan = bundle()
    const sprints = plan.sprints.map((item) => (item.ordinal === 2 ? { ...item, checkpoint: { mode: 'auto' as const } } : item))
    const model = buildGraphModel(withSprints(sprints, plan.edges))
    expect(text(model, 'checkpoint:1')).toBe('CHECKPOINT 1 · HUMAN APPROVAL (neutral)')
    expect(text(model, 'checkpoint:2')).toBe('CHECKPOINT 2 · AUTO CONTINUE (neutral)')
  })

  it('counts epic checks from the recorded outcome', () => {
    const all = buildGraphModel(
      input({
        outcome: [
          { criterionId: 's1', met: true, note: '' },
          { criterionId: 's2', met: true, note: '' },
          { criterionId: 's3', met: true, note: '' }
        ]
      })
    )
    expect(text(all, 'checks')).toBe('EPIC CHECKS · 3 OF 3 MET (passed)')
    const some = buildGraphModel(
      input({
        outcome: [
          { criterionId: 's1', met: true, note: '' },
          { criterionId: 's2', met: false, note: '' },
          { criterionId: 'zz', met: true, note: '' }
        ]
      })
    )
    expect(text(some, 'checks')).toBe('EPIC CHECKS · 1 OF 3 MET (neutral)')
  })
})

describe('graph without a run (2)', () => {
  it('does not call an epic with no success criteria fully checked', () => {
    const plan = bundle()
    const empty = buildGraphModel(
      input({ run: null, outcome: [], plan: savedPlan({ bundle: { ...plan, epic: { ...plan.epic, successCriteria: [] } } }) })
    )
    expect(text(empty, 'checks')).toBe('EPIC CHECKS · 0 OF 0 MET (neutral)')
  })
})

describe('graph draft view', () => {
  const model = buildGraphModel(input({ mode: 'draft', plan: draftPlan() }))

  it('labels tickets by their change since the base revision', () => {
    expect(text(model, 'tk_305')).toBe('DM-305 · NEW IN REV 5')
    expect(node(model, 'tk_305')).toMatchObject({ tone: 'new', dashed: true })
    expect(text(model, 'tk_302')).toBe('DM-302 · EDITED')
    expect(node(model, 'tk_302')).toMatchObject({ tone: 'edited', dashed: false })
    expect(text(model, 'tk_101')).toBe('DM-101 · DRAFT')
    expect(node(model, 'tk_101')).toMatchObject({ tone: 'neutral', dashed: false })
  })

  it('counts tickets per sprint, names checkpoint policies and criteria', () => {
    expect(text(model, 'sprint:sp_3')).toBe('SPRINT 3 | Desktop editing | 4 tickets · 1 new')
    expect(text(model, 'sprint:sp_1')).toBe('SPRINT 1 | Storage foundation | 3 tickets')
    expect(text(model, 'checkpoint:2')).toBe('CHECKPOINT 2 · HUMAN APPROVAL (neutral)')
    expect(text(model, 'checks')).toBe('EPIC CHECKS · 3 CRITERIA (neutral)')
    expect(model.edges.every((item) => item.met)).toBe(true)
  })

  it('widens the canvas for a fourth column', () => {
    expect(box(model, 'tk_305')).toEqual([935, 592])
    expect(node(model, 'epic')).toMatchObject({ x: 445 })
    expect(node(model, 'checkpoint:1')).toMatchObject({ width: 1393 })
  })

  it('annotates both tickets of a rejected dependency edit', () => {
    const rejected = buildGraphModel(input({ mode: 'draft', plan: draftPlan(), rejected: { from: 'tk_301', to: 'tk_203' } }))
    expect(node(rejected, 'tk_203')).toMatchObject({ tone: 'rejected', note: 'Rejected: would require DM-301' })
    expect(node(rejected, 'tk_301')).toMatchObject({ tone: 'rejected', note: 'Rejected as prerequisite of DM-203' })
    expect(node(rejected, 'tk_302')).toMatchObject({ note: null })
  })

  it('uses singular words for one ticket, sprint and criterion', () => {
    const one = bundle({
      tickets: [ticket('DM-1', 'Only')],
      sprints: [sprint(1, '', ['tk_1'])],
      edges: [],
      epic: { ...bundle().epic, successCriteria: [{ id: 's1', text: 'x' }] }
    })
    const single = buildGraphModel(input({ mode: 'draft', plan: draftPlan({ bundle: one, changes: [] }) }))
    expect(text(single, 'epic')).toBe('EPIC · 1 TICKET · 1 SPRINT | Plan through MCP, edit on the desktop')
    expect(text(single, 'sprint:sp_1')).toBe('SPRINT 1 | No goal yet | 1 ticket')
    expect(text(single, 'checks')).toBe('EPIC CHECKS · 1 CRITERION (neutral)')
  })
})

describe('graph layout edge cases (1)', () => {
  const many = Array.from({ length: 8 }, (_, index) => ticket(`DM-${index + 1}`, `T${index + 1}`))

  it('wraps wide rows after six columns', () => {
    const model = buildGraphModel(withSprints([sprint(1, 'Wide', many.map((item) => item.id))], [], many))
    expect(box(model, 'tk_6')).toEqual([1435, 128])
    expect(box(model, 'tk_7')).toEqual([185, 240])
    expect(box(model, 'tk_8')).toEqual([435, 240])
    expect(node(model, 'sprint:sp_1')).toMatchObject({ height: 184 })
  })

  it('keeps preferred columns when there is room and clamps at the right edge', () => {
    const tickets = [...many, ticket('DM-9', 'Child A'), ticket('DM-10', 'Child B')]
    const sprints = [sprint(1, 'Wide', many.slice(0, 6).map((item) => item.id)), sprint(2, 'Kids', ['tk_9', 'tk_10'])]
    const model = buildGraphModel(withSprints(sprints, [edge(6, 9), edge(6, 10)], tickets))
    expect(box(model, 'tk_9')).toEqual([1185, 304])
    expect(box(model, 'tk_10')).toEqual([1435, 304])
    const lone = buildGraphModel(withSprints([sprints[0], sprint(2, 'Kid', ['tk_9'])], [edge(5, 9)], tickets))
    expect(box(lone, 'tk_9')).toEqual([1185, 304])
  })

  it('gives each link of a same-sprint chain its own row', () => {
    const tickets = many.slice(0, 4)
    const ids = ['tk_4', 'tk_3', 'tk_2', 'tk_1']
    const model = buildGraphModel(withSprints([sprint(1, 'Chain', ids)], [edge(1, 2), edge(2, 3), edge(3, 4)], tickets))
    expect(['tk_1', 'tk_2', 'tk_3', 'tk_4'].map((id) => box(model, id)[1])).toEqual([128, 240, 352, 464])
  })

  it('places cycle members after the acyclic rows', () => {
    const tickets = many.slice(0, 3)
    const model = buildGraphModel(withSprints([sprint(1, 'Loop', ['tk_1', 'tk_2', 'tk_3'])], [edge(1, 2), edge(2, 1)], tickets))
    expect(box(model, 'tk_3')).toEqual([185, 128])
    expect([box(model, 'tk_1'), box(model, 'tk_2')]).toEqual([
      [185, 240],
      [435, 240]
    ])
  })

  it('gives an empty sprint one row and skips tickets outside any sprint', () => {
    const tickets = many.slice(0, 2)
    const model = buildGraphModel(
      withSprints([sprint(1, 'One', ['tk_1']), sprint(2, 'Empty', [])], [edge(2, 1), { from: 'tk_1', to: 'tk_99' }], tickets)
    )
    expect(node(model, 'sprint:sp_2')).toMatchObject({ y: 308, height: 72 })
    expect(model.nodes.some((item) => item.id === 'tk_2')).toBe(false)
    expect(model.edges).toEqual([])
  })
})

describe('graph layout edge cases (2)', () => {
  it('orders sprints by ordinal regardless of array order', () => {
    const plan = bundle()
    const model = buildGraphModel(withSprints([...plan.sprints].reverse(), plan.edges))
    expect(box(model, 'tk_101')).toEqual([185, 128])
    expect(box(model, 'tk_301')).toEqual([185, 592])
  })
})

describe('sprint drop targets', () => {
  const model = buildGraphModel(input())

  it('finds the band containing a y coordinate, boundaries belonging to the lower sprint', () => {
    expect(sprintAtY(model.bands, 251.5)).toBe('sp_1')
    expect(sprintAtY(model.bands, 252)).toBe('sp_2')
    expect(sprintAtY(model.bands, 539.5)).toBe('sp_2')
    expect(sprintAtY(model.bands, 540)).toBe('sp_3')
    expect(sprintAtY(model.bands, -5000)).toBe('sp_1')
    expect(sprintAtY([], 10)).toBe(null)
  })

  it('returns the new sprint only when a dragged card center crosses into another band', () => {
    expect(dropTarget(model, 'tk_204', 460)).toBe(null)
    expect(dropTarget(model, 'tk_204', 504)).toBe('sp_3')
    expect(dropTarget(model, 'tk_204', 520)).toBe('sp_3')
    expect(dropTarget(model, 'tk_204', 100)).toBe('sp_1')
    expect(dropTarget(model, 'epic', 600)).toBe(null)
    expect(dropTarget(model, 'nope', 600)).toBe(null)
  })
})

const LONG_GOAL =
  'The card’s words and pictures are ready: every ticket title reads clearly, the mascot art is in place, ' +
  'the brass trim and the crimson accents match the mockups, the sprint labels wrap without clipping, and a ' +
  'reviewer can open the plan graph on a small window and still follow the whole story from the first checkpoint.'
const LABEL_TICKETS = [ticket('DM-1', 'One'), ticket('DM-2', 'Two')]

function twoSprints(goal: string, patch: Partial<GraphInput> = {}): GraphModel {
  const sprints = [sprint(1, goal, ['tk_1']), sprint(2, 'Next', ['tk_2'])]
  return buildGraphModel({ ...withSprints(sprints, [], LABEL_TICKETS), ...patch })
}

describe('a long sprint goal', () => {
  it('uses a goal of 300 or more characters for these cases', () => {
    expect(LONG_GOAL.length).toBeGreaterThanOrEqual(300)
  })

  it('keeps the checkpoint divider and its pill below the label of a 300+ character goal', () => {
    const model = twoSprints(LONG_GOAL)
    const label = sprintNode(model, 'sp_1')
    const divider = node(model, 'checkpoint:1')
    expect(label.labelHeight).toBeGreaterThan(72)
    expect(label.y + label.labelHeight).toBeLessThanOrEqual(divider.y)
    expect(divider.y + divider.height).toBeLessThanOrEqual(sprintNode(model, 'sp_2').y)
  })

  it('clamps a 300+ character goal to six lines instead of growing without bound', () => {
    const label = sprintNode(twoSprints(LONG_GOAL), 'sp_1')
    expect(label.goalLines).toBe(6)
    expect(label.labelHeight).toBe(18 + 6 * 18 + 18)
    expect(label.goal).toBe(LONG_GOAL)
  })

  it('moves the next sprint, its tickets and the dividers down by the reserved space only', () => {
    const short = twoSprints('Short')
    const long = twoSprints(LONG_GOAL)
    const growth = node(long, 'checkpoint:1').y - node(short, 'checkpoint:1').y
    expect(growth).toBeGreaterThan(0)
    expect(box(long, 'tk_1')).toEqual(box(short, 'tk_1'))
    expect(node(long, 'tk_2').y - node(short, 'tk_2').y).toBe(growth)
    expect(node(long, 'checks').y - node(short, 'checks').y).toBe(growth)
    expect(long.bands[0]?.bottom).toBe((short.bands[0]?.bottom ?? 0) + growth)
  })

  it('clears the epic checks divider under the last sprint too', () => {
    const model = buildGraphModel(withSprints([sprint(1, LONG_GOAL, ['tk_1'])], [], LABEL_TICKETS))
    const label = sprintNode(model, 'sp_1')
    expect(label.y + label.labelHeight).toBeLessThanOrEqual(node(model, 'checks').y)
  })

  it('sizes the sprint node to hold the label', () => {
    const label = sprintNode(twoSprints(LONG_GOAL), 'sp_1')
    expect(label.height).toBeGreaterThanOrEqual(label.labelHeight)
  })

  it('adds no space to a band that is already taller than the label', () => {
    const chain = [1, 2, 3, 4].map((index) => ticket(`DM-${index}`, `T${index}`))
    const sprints = [sprint(1, LONG_GOAL, chain.map((item) => item.id)), sprint(2, 'Next', [])]
    const model = buildGraphModel(withSprints(sprints, [edge(1, 2), edge(2, 3), edge(3, 4)], chain))
    expect(sprintNode(model, 'sp_1')).toMatchObject({ height: 4 * 112 - 40, goalLines: 6 })
    expect(node(model, 'checkpoint:1').y).toBe(128 + 4 * 112 - 40 + 38)
  })
})

describe('sprint labels with short goals and details', () => {
  it('keeps short goals exactly where they were', () => {
    for (const goal of ['Storage foundation', 'Two lines of goal text here', '']) {
      const model = twoSprints(goal)
      expect(sprintNode(model, 'sp_1')).toMatchObject({ y: 132, height: 72 })
      expect(node(model, 'checkpoint:1').y).toBe(238)
      expect(box(model, 'tk_2')).toEqual([185, 304])
      expect(node(model, 'checks').y).toBe(414)
    }
  })

  it('keeps short goals in place in the Draft view, which also reserves the + Ticket button', () => {
    const model = twoSprints('Two lines of goal text here', { mode: 'draft', run: null })
    expect(sprintNode(model, 'sp_1')).toMatchObject({ y: 132, goalLines: 2, labelHeight: 18 + 36 + 18 + 30 })
    expect(node(model, 'checkpoint:1').y).toBe(238)
    expect(box(model, 'tk_2')).toEqual([185, 304])
    expect(node(model, 'checks').y).toBe(414)
  })

  it('reserves the + Ticket button in the Draft view only', () => {
    const goal = 'A goal that wraps to three lines of text and more'
    const savedModel = twoSprints(goal)
    const draftModel = twoSprints(goal, { mode: 'draft' })
    const saved = sprintNode(savedModel, 'sp_1')
    const draft = sprintNode(draftModel, 'sp_1')
    expect(saved.goalLines).toBe(3)
    expect(draft.labelHeight - saved.labelHeight).toBe(30)
    expect(saved.y + saved.labelHeight).toBeLessThanOrEqual(node(savedModel, 'checkpoint:1').y)
    expect(draft.y + draft.labelHeight).toBeLessThanOrEqual(node(draftModel, 'checkpoint:1').y)
    expect(node(savedModel, 'checkpoint:1').y).toBe(238)
    expect(node(draftModel, 'checkpoint:1').y).toBeGreaterThan(238)
  })

  it('counts a detail line that wraps, such as an active sprint progress note', () => {
    const model = buildGraphModel(input())
    expect(sprintNode(model, 'sp_2')).toMatchObject({ detail: 'Active · 1 of 4 accepted', labelHeight: 18 + 36 + 36 })
  })

  it('gives a taller label to a long goal in every sprint independently', () => {
    const sprints = [sprint(1, LONG_GOAL, ['tk_1']), sprint(2, 'Short', ['tk_2'])]
    const model = buildGraphModel(withSprints(sprints, [], LABEL_TICKETS))
    expect(sprintNode(model, 'sp_2').labelHeight).toBe(18 + 18 + 18)
    expect(sprintNode(model, 'sp_2').height).toBe(72)
  })
})
