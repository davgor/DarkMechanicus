import { describe, expect, it } from 'vitest'
import {
  advanceEffects, createPacket, createRing, createSparks, PACKET_MAX_MS, PACKET_MIN_MS, packetDuration,
  packetPoint, RING_MS, ringRadius, type ChamberEffect
} from './effects'
import { chamberLayout } from './layout'
import { PROPS, ROOMS } from './testFixtures'

const layout = chamberLayout(ROOMS[1], PROPS, 6)

describe('packets', () => {
  it('take 600 to 1200 ms in proportion to distance', () => {
    const origin = { x: 0, y: 0 }
    expect(packetDuration(origin, origin, layout)).toBe(PACKET_MIN_MS)
    const far = { x: layout.size.width, y: layout.floorY }
    expect(packetDuration(origin, far, layout)).toBe(PACKET_MAX_MS)
    expect(packetDuration({ x: -5000, y: 0 }, { x: 5000, y: 0 }, layout)).toBe(PACKET_MAX_MS)
    const durations = [0, 100, 300, 700, 1200].map((x) => packetDuration(origin, { x, y: 0 }, layout))
    for (const duration of durations) {
      expect(duration).toBeGreaterThanOrEqual(PACKET_MIN_MS)
      expect(duration).toBeLessThanOrEqual(PACKET_MAX_MS)
    }
    expect(durations[2]! - durations[1]!).toBeCloseTo((durations[4]! - durations[3]!) * 200 / 500, 6)
  })

  it('arc above the straight line and arrive exactly at their duration', () => {
    const packet = createPacket(1, { purpose: 'order', from: 'magos', to: 'a',
      fromPoint: { x: 1000, y: 300 }, toPoint: { x: 200, y: 400 } }, layout)
    const middle = packetPoint({ ...packet, elapsed: packet.duration / 2 })
    expect(middle.y).toBeLessThan(350)
    expect(packetPoint({ ...packet, elapsed: packet.duration })).toEqual({ x: 200, y: 400 })
    const early = advanceEffects([packet], packet.duration - 1)
    expect(early.arrivals).toEqual([])
    const late = advanceEffects(early.effects, 1)
    expect(late.effects).toEqual([])
    expect(late.arrivals.map((arrival) => arrival.kind)).toEqual(['packet'])
  })
})

describe('noosphere ring', () => {
  it('reaches targets in order of distance from the helm and ends after the sweep', () => {
    const origin = { x: layout.magos.x, y: layout.magos.y }
    const targets = [
      { id: 'far', point: { x: 50, y: layout.floorY } },
      { id: 'near', point: { x: origin.x - 100, y: layout.floorY } },
      { id: 'mid', point: { x: origin.x - 500, y: layout.floorY } }
    ]
    const ring = createRing(1, { orderId: 'o1', origin, targets }, layout)
    expect(ring.targets.map((target) => target.id)).toEqual(['near', 'mid', 'far'])
    let effects: ChamberEffect[] = [ring]
    const order: string[] = []
    let radius = 0
    for (let time = 0; time < RING_MS + 100; time += 16) {
      const result = advanceEffects(effects, 16)
      effects = result.effects
      for (const arrival of result.arrivals) {
        if (arrival.kind !== 'ring') continue
        order.push(arrival.id)
        const target = targets.find((item) => item.id === arrival.id)!
        expect(ringRadius(arrival.ring) + 1e-6).toBeGreaterThanOrEqual(
          Math.hypot(target.point.x - origin.x, target.point.y - origin.y))
      }
      const current = effects.find((effect) => effect.kind === 'ring')
      if (current?.kind === 'ring') {
        expect(ringRadius(current)).toBeGreaterThanOrEqual(radius)
        radius = ringRadius(current)
      }
    }
    expect(order).toEqual(['near', 'mid', 'far'])
    expect(effects).toEqual([])
  })
})

describe('sparks', () => {
  it('are seeded and finish', () => {
    const [first, seedA] = createSparks(1, [{ x: 10, y: 10 }, { x: 20, y: 20 }], 42)
    const [second, seedB] = createSparks(1, [{ x: 10, y: 10 }, { x: 20, y: 20 }], 42)
    expect(first).toEqual(second)
    expect(seedA).toBe(seedB)
    expect(first.sparks).toHaveLength(8)
    expect(advanceEffects([first], first.duration).effects).toEqual([])
  })
})
