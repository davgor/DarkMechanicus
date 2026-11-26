import { describe, expect, it } from 'vitest'
import measured from '../../assets/chamber/props.json'
import { chamberLayout, MAX_CONSOLES, spriteScaleFor, type ChamberLayout, type Rect } from './layout'
import { PROPS, ROOMS } from './testFixtures'

const right = (rect: Rect): number => rect.x + rect.width

/** Door, consoles with their operator spots, pad and the helm's Magos reserve, left to right, never overlapping. */
function expectSpacedLeftToRight(layout: ChamberLayout): void {
  const half = layout.spriteSize.width / 2
  let previousRight = right(layout.door.bounds)
  for (const station of layout.consoles) {
    expect(station.operatorFacing).toBe('left')
    expect(station.bounds.x).toBeGreaterThanOrEqual(previousRight)
    expect(station.operatorX - half).toBeGreaterThanOrEqual(right(station.bounds) - 1e-6)
    expect(station.rect.y + station.rect.height).toBeGreaterThanOrEqual(layout.floorY - 1e-6)
    previousRight = station.operatorX + half
  }
  expect(previousRight).toBeLessThanOrEqual(layout.teleportPad.bounds.x)
  expect(right(layout.teleportPad.bounds)).toBeLessThanOrEqual(layout.helm.reserve.x)
  expect(layout.helm.reserve.x).toBeLessThanOrEqual(layout.helm.bounds.x)
  expect(layout.helm.reserve.x).toBeLessThanOrEqual(layout.magos.x - layout.magosCell * 1.3 / 2)
  expect(right(layout.helm.reserve)).toBeLessThanOrEqual(layout.size.width + 1e-6)
}

describe('chamberLayout', () => {
  it.each(ROOMS)('puts the helm flush right and the door at the left edge at %o', (size) => {
    const layout = chamberLayout(size, PROPS, 6)
    expect(right(layout.helm.reserve)).toBeCloseTo(size.width, 6)
    expect(layout.door.bounds.x).toBe(0)
    expect(layout.helm.rect.y + layout.helm.rect.height).toBeCloseTo(layout.floorY, 6)
    expect(layout.teleportPad.rect.x + layout.teleportPad.rect.width).toBeLessThanOrEqual(layout.helm.rect.x)
    expect(layout.magos.x).toBeGreaterThan(layout.helm.rect.x)
    expect(layout.magos.y).toBeLessThan(layout.floorY)
  })

  it.each(ROOMS)('spreads up to six consoles between door and pad without overlap at %o', (size) => {
    const layout = chamberLayout(size, PROPS, 6)
    expect(layout.consoles.length).toBeGreaterThan(0)
    expect(layout.consoles.length).toBeLessThanOrEqual(MAX_CONSOLES)
    expectSpacedLeftToRight(layout)
    const pitches = layout.consoles.slice(1).map((item, index) => item.rect.x - layout.consoles[index]!.rect.x)
    for (const pitch of pitches) expect(pitch).toBeCloseTo(pitches[0]!, 6)
  })

  it('fits six consoles in the widest room', () => {
    expect(chamberLayout(ROOMS[2], PROPS, 6).consoles).toHaveLength(6)
  })
})

describe('chamberLayout with the measured props.json', () => {
  const sizes = [
    { width: 800, height: 450 }, { width: 1280, height: 800 }, { width: 1920, height: 800 },
    { width: 1920, height: 1080 }, { width: 2560, height: 1200 }, { width: 3840, height: 1600 }
  ]

  it('fits at least three consoles at 1280x800 and four at 1920 wide', () => {
    expect(chamberLayout({ width: 1280, height: 800 }, measured, 6).consoles.length).toBeGreaterThanOrEqual(3)
    expect(chamberLayout({ width: 1920, height: 800 }, measured, 6).consoles.length).toBeGreaterThanOrEqual(4)
    expect(chamberLayout({ width: 1920, height: 1080 }, measured, 24).consoles.length).toBeGreaterThanOrEqual(4)
  })

  it.each(sizes)('never places more than six consoles at %o', (size) => {
    expect(chamberLayout(size, measured, 6).consoles.length).toBeLessThanOrEqual(MAX_CONSOLES)
  })

  it.each(sizes)('keeps consoles clear of each other, the door, the pad and the Magos reserve at %o', (size) => {
    for (const count of [6, 24]) expectSpacedLeftToRight(chamberLayout(size, measured, count))
  })

  it.each(sizes)('places props by their opaque bounds at %o', (size) => {
    const layout = chamberLayout(size, measured, 6)
    expect(layout.door.bounds.x).toBeCloseTo(0, 6)
    expect(layout.door.bounds.y + layout.door.bounds.height).toBeCloseTo(layout.floorY, 6)
    expect(right(layout.helm.bounds)).toBeLessThanOrEqual(size.width + 1e-6)
    expect(layout.helm.bounds.x).toBeGreaterThanOrEqual(right(layout.teleportPad.bounds))
    for (const station of layout.consoles) expect(station.bounds.height).toBeCloseTo(layout.spriteSize.height / layout.spriteScale, 6)
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
