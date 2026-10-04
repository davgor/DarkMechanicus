import { describe, expect, it } from 'vitest'
import { ticketSurfaces } from './geometry'

describe('live ticket surfaces', () => {
  it('transforms only current ticket nodes through pan and zoom', () => {
    const surfaces = ticketSurfaces([
      { id: 'ticket', type: 'ticket', position: { x: 100, y: 60 }, width: 200, height: 80 },
      { id: 'epic', type: 'epic', position: { x: 0, y: 0 }, width: 500, height: 100 }
    ], { x: -20, y: 15, zoom: 1.5 })
    expect(surfaces).toEqual([{ id: 'ticket', x: 130, y: 105, width: 300, height: 120, inProgress: false }])
  })

  it('uses the dragged node position and measured size as soon as they change', () => {
    const nodes = [{ id: 'ticket', type: 'ticket', position: { x: 10, y: 20 }, width: 100, height: 40 }]
    expect(ticketSurfaces(nodes, { x: 0, y: 0, zoom: 1 })[0]).toMatchObject({ x: 10, width: 100 })
    nodes[0] = { ...nodes[0]!, position: { x: 40, y: 20 }, width: 180 }
    expect(ticketSurfaces(nodes, { x: 0, y: 0, zoom: 1 })[0]).toMatchObject({ x: 40, width: 180 })
  })

  it('prefers live measured dimensions while falling back per dimension', () => {
    const surfaces = ticketSurfaces([
      { id: 'measured', type: 'ticket', position: { x: 20, y: 30 }, width: 100, height: 40,
        measured: { width: 160, height: 70 } },
      { id: 'partial', type: 'ticket', position: { x: -10, y: 5 }, width: 90, height: 30,
        measured: { width: 120 } },
      { id: 'unknown', type: 'ticket', position: { x: 0, y: 0 }, width: 100 }
    ], { x: 7, y: -9, zoom: 2 })
    expect(surfaces).toEqual([
      { id: 'measured', x: 47, y: 51, width: 320, height: 140, inProgress: false },
      { id: 'partial', x: -13, y: 1, width: 240, height: 60, inProgress: false }
    ])
  })

  it('copies semantic work state and ignores selected styling', () => {
    const surfaces = ticketSurfaces([
      { id: 'running', type: 'ticket', position: { x: 1, y: 2 }, width: 100, height: 40,
        data: { model: { inProgress: true }, active: false } },
      { id: 'selected', type: 'ticket', position: { x: 2, y: 3 }, width: 100, height: 40,
        data: { model: { inProgress: false }, active: true } }
    ], { x: 0, y: 0, zoom: 1 })
    expect(surfaces.map((surface) => surface.inProgress)).toEqual([true, false])
  })
})
