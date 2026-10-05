import { getNodesBounds, getViewportForBounds } from '@xyflow/react'
import { expect, it } from 'vitest'
import { bundle, savedPlan, sprint, ticket } from '../epic/__mocks__/fixtures'
import { buildGraphModel } from '../graph/graphModel'
import { toFlowNodes } from '../graph/flowElements'
import { ticketSurfaces } from './geometry'
import { createMotion, stepMotion, type MotionSurfaces } from './motion'

it('reaches and climbs a ticket in a normal single-sprint fitView board', () => {
  const plan = savedPlan({ bundle: bundle({
    tickets: [ticket('DM-1', 'Build'), ticket('DM-2', 'Check')],
    sprints: [sprint(1, 'Build and check', ['tk_1', 'tk_2'])], edges: []
  }) })
  const model = buildGraphModel({
    plan, mode: 'saved', run: null, statuses: new Map(), outcome: null, rejected: null, draftNumber: 1
  })
  const nodes = toFlowNodes(model, {
    editable: false, selectedTicketId: null, onAddTicket: () => undefined, onAddAcceptance: () => undefined,
    onOpenActivity: () => undefined
  })
  const bounds = getNodesBounds(nodes)
  const viewport = getViewportForBounds(bounds, 800, 500, 0.2, 1.5, 0.08)
  const surfaces: MotionSurfaces = {
    viewport: { width: 800, height: 500 }, mascotSize: { width: 52, height: 80 },
    tickets: ticketSurfaces(nodes, viewport)
  }
  expect(Math.min(...surfaces.tickets.map((item) => 500 - item.y - item.height))).toBeGreaterThan(120)
  let state = createMotion(0x5eed, { x: 400, y: 500 })
  let climbed = false
  let supported = false
  for (let index = 0; index < 6000; index += 1) {
    state = stepMotion(state, 50, surfaces)
    if (state.action === 'climb') climbed = true
    if (climbed && state.supportId !== null) { supported = true; break }
  }
  expect(climbed).toBe(true)
  expect(supported).toBe(true)
})
