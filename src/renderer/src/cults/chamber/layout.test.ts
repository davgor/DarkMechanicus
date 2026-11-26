import { describe, expect, it } from 'vitest'
import { chamberLayout, MAX_CONSOLES, spriteScaleFor } from './layout'
import { PROPS, ROOMS } from './testFixtures'

describe('chamberLayout', () => {
  it.each(ROOMS)('puts the helm flush right and the door at the left edge at %o', (size) => {
    const layout = chamberLayout(size, PROPS, 6)
    expect(layout.helm.rect.x + layout.helm.rect.width).toBeCloseTo(size.width, 6)
    expect(layout.door.rect.x).toBe(0)
    expect(layout.helm.rect.y + layout.helm.rect.height).toBeCloseTo(layout.floorY, 6)
    expect(layout.teleportPad.rect.x + layout.teleportPad.rect.width).toBeLessThanOrEqual(layout.helm.rect.x)
    expect(layout.magos.x).toBeGreaterThan(layout.helm.rect.x)
    expect(layout.magos.y).toBeLessThan(layout.floorY)
  })

  it.each(ROOMS)('spreads up to six consoles between door and pad without overlap at %o', (size) => {
    const layout = chamberLayout(size, PROPS, 6)
    const doorRight = layout.door.rect.x + layout.door.rect.width
    expect(layout.consoles.length).toBeGreaterThan(0)
    expect(layout.consoles.length).toBeLessThanOrEqual(MAX_CONSOLES)
    let previousRight = doorRight
    for (const station of layout.consoles) {
      expect(station.operatorFacing).toBe('right')
      expect(station.operatorX - layout.spriteSize.width / 2).toBeGreaterThanOrEqual(previousRight)
      expect(station.operatorX + layout.spriteSize.width / 2).toBeLessThanOrEqual(station.rect.x + 1e-6)
      expect(station.rect.y + station.rect.height).toBeCloseTo(layout.floorY, 6)
      previousRight = station.rect.x + station.rect.width
    }
    expect(previousRight).toBeLessThanOrEqual(layout.teleportPad.rect.x)
    const pitches = layout.consoles.slice(1).map((item, index) => item.rect.x - layout.consoles[index]!.rect.x)
    for (const pitch of pitches) expect(pitch).toBeCloseTo(pitches[0]!, 6)
  })

  it('fits six consoles in the widest room', () => {
    expect(chamberLayout(ROOMS[2], PROPS, 6).consoles).toHaveLength(6)
  })
})

describe('chamberLayout surfaces and scale', () => {

  it.each(ROOMS)('puts the viewscreen in the back wall upper middle third at %o', (size) => {
    const { viewscreen, floorY } = chamberLayout(size, PROPS, 6)
    expect(viewscreen.rect.x).toBeGreaterThanOrEqual(size.width / 3)
    expect(viewscreen.rect.x + viewscreen.rect.width).toBeLessThanOrEqual(size.width * 2 / 3)
    expect(viewscreen.rect.y).toBeGreaterThanOrEqual(0)
    expect(viewscreen.rect.y + viewscreen.rect.height).toBeLessThanOrEqual(floorY / 3)
    expect(viewscreen.window.x).toBeGreaterThan(viewscreen.rect.x)
    expect(viewscreen.window.x + viewscreen.window.width).toBeLessThan(viewscreen.rect.x + viewscreen.rect.width)
  })

  it.each(ROOMS)('gives the motion engine console tops and the helm as platforms at %o', (size) => {
    const layout = chamberLayout(size, PROPS, 6)
    const ids = layout.surfaces.tickets.map((ticket) => ticket.id)
    expect(ids).toEqual([...layout.consoles.map((item) => item.id), 'helm'])
    expect(layout.surfaces.viewport).toEqual({ width: size.width, height: layout.floorY })
    for (const ticket of layout.surfaces.tickets) {
      expect(ticket.width).toBeGreaterThanOrEqual(layout.spriteSize.width + 4)
      expect(ticket.y + ticket.height).toBeLessThan(layout.floorY)
    }
  })

  it('scales sprites 1 up to 6 acolytes, linearly down to 0.6 at 24', () => {
    expect(spriteScaleFor(1)).toBe(1)
    expect(spriteScaleFor(6)).toBe(1)
    expect(spriteScaleFor(24)).toBeCloseTo(0.6, 10)
    expect(spriteScaleFor(15)).toBeCloseTo(0.8, 10)
    expect(spriteScaleFor(30)).toBeCloseTo(0.6, 10)
    for (let count = 6; count < 24; count += 1) {
      expect(spriteScaleFor(count) - spriteScaleFor(count + 1)).toBeCloseTo(0.4 / 18, 10)
    }
    const layout = chamberLayout(ROOMS[1], PROPS, 24)
    expect(layout.spriteScale).toBeCloseTo(0.6, 10)
    expect(layout.surfaces.mascotSize).toEqual(layout.spriteSize)
    expect(layout.spriteSize.width).toBeCloseTo(52 * 0.6, 10)
  })
})
