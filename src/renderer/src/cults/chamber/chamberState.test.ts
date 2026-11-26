import { describe, expect, it } from 'vitest'
import {
  applyChamberEvent, BUBBLE_MAX_CHARS, clipDuration, createChamber, DEFAULT_CLIP_TIMINGS, MAGOS_ID,
  staticChamber, stepChamber, type ChamberEvent, type ChamberState
} from './chamberState'
import type { PacketEffect } from './effects'
import { chamberLayout, type ChamberLayout, type Size } from './layout'
import { PROPS, ROOMS } from './testFixtures'

const STEP = 16
const ids = (count: number): string[] => Array.from({ length: count }, (_, index) => `a${index + 1}`)

function apply(state: ChamberState, layout: ChamberLayout, ...events: ChamberEvent[]): ChamberState {
  return events.reduce((next, event) => applyChamberEvent(next, event, layout), state)
}

function run(state: ChamberState, layout: ChamberLayout, ms: number,
  onStep?: (next: ChamberState, previous: ChamberState, time: number) => void): ChamberState {
  let current = state
  for (let time = STEP; time <= ms; time += STEP) {
    const next = stepChamber(current, STEP, layout)
    onStep?.(next, current, time)
    current = next
  }
  return current
}

/** A running chamber whose `count` acolytes have beamed in and wandered for a while. */
function populate(seed: number, count: number, layout: ChamberLayout, settleMs = 3000): ChamberState {
  let state = apply(createChamber(seed), layout, { type: 'runState', runState: 'running' })
  for (const id of ids(count)) state = apply(state, layout, { type: 'memberJoined', id })
  return run(state, layout, settleMs)
}

function packets(state: ChamberState): PacketEffect[] {
  return state.effects.filter((effect): effect is PacketEffect => effect.kind === 'packet')
}

/** Ids that started a salute during this step. */
function salutesStarted(next: ChamberState, previous: ChamberState): string[] {
  return next.acolytes.filter((acolyte) => {
    const before = previous.acolytes.find((item) => item.id === acolyte.id)
    return acolyte.mode === 'saluting' &&
      (before?.mode !== 'saluting' || acolyte.modeElapsed < before.modeElapsed)
  }).map((acolyte) => acolyte.id)
}

function expectBounded(state: ChamberState, layout: ChamberLayout): void {
  for (const acolyte of state.acolytes) {
    expect(acolyte.x).toBeGreaterThanOrEqual(0)
    expect(acolyte.x).toBeLessThanOrEqual(layout.size.width)
    expect(acolyte.y).toBeGreaterThanOrEqual(layout.spriteSize.height - 1e-6)
    expect(acolyte.y).toBeLessThanOrEqual(layout.floorY + 1e-6)
  }
}

const mid = chamberLayout(ROOMS[1], PROPS, 6)
const wide = chamberLayout(ROOMS[2], PROPS, 7)

describe('targeted orders', () => {
  it('send one packet to that acolyte only, which salutes on arrival then resumes its previous mode', () => {
    let state = populate(7, 6, mid)
    state = run(apply(state, mid, { type: 'working', id: 'a2', on: true }), mid, 20_000)
    expect(state.acolytes.find((item) => item.id === 'a2')).toMatchObject({ mode: 'working', pose: 'type' })
    const wanderer = state.acolytes.find((item) => item.id === 'a1')!
    expect(wanderer.mode).toBe('wandering')

    for (const target of ['a2', 'a1']) {
      state = apply(state, mid, { type: 'orderSent', to: target, orderId: `order-${target}` })
      expect(state.magos.action).toBe('order_one')
      expect(packets(state)).toHaveLength(1)
      expect(packets(state)[0]).toMatchObject({ purpose: 'order', from: MAGOS_ID, to: target })
      const previousMode = state.acolytes.find((item) => item.id === target)!.mode
      const saluted: string[] = []
      let motionAtSalute = null as unknown
      state = run(state, mid, 1300, (next, previous) => {
        const started = salutesStarted(next, previous)
        saluted.push(...started)
        if (started.length > 0) motionAtSalute = next.acolytes.find((item) => item.id === target)!.motion
      })
      expect(saluted).toEqual([target])
      expect(packets(state)).toHaveLength(0)
      state = run(state, mid, clipDuration(DEFAULT_CLIP_TIMINGS.salute) + 100)
      const after = state.acolytes.find((item) => item.id === target)!
      expect(after.mode).toBe(previousMode)
      if (previousMode === 'working') expect(after.pose).toBe('type')
      if (previousMode === 'wandering') expect(after.motion).not.toBe(motionAtSalute)
    }
  })

  it('freezes a wandering acolyte for the salute and resumes the same motion afterwards', () => {
    let state = populate(21, 3, mid)
    state = apply(state, mid, { type: 'orderSent', to: 'a3', orderId: 'o' })
    let atSalute: ChamberState | null = null
    state = run(state, mid, 1300, (next, previous) => {
      if (!atSalute && salutesStarted(next, previous).length > 0) atSalute = next
    })
    expect(atSalute).not.toBeNull()
    const frozen = atSalute!.acolytes.find((item) => item.id === 'a3')!
    expect(frozen.pose).toBe('salute')
    expect(frozen.facing).toBe('right')
    let resumed: ChamberState | null = null
    run(atSalute!, mid, 1000, (next, previous) => {
      const before = previous.acolytes.find((item) => item.id === 'a3')!
      const now = next.acolytes.find((item) => item.id === 'a3')!
      if (!resumed && before.mode === 'saluting' && now.mode === 'wandering') resumed = next
    })
    expect(resumed!.acolytes.find((item) => item.id === 'a3')!.motion).toEqual(frozen.motion)
  })
})

describe('orders to all', () => {
  it.each([6, 24])('make each of %i acolytes salute exactly once, in order of distance from the helm', (count) => {
    const layout = chamberLayout(ROOMS[1], PROPS, count)
    let state = populate(count * 13, count, layout, 6000)
    state = apply(state, layout, { type: 'orderSent', to: 'all', orderId: 'all-1' })
    expect(state.magos.action).toBe('order_all')
    const ring = state.effects.find((effect) => effect.kind === 'ring')
    if (ring?.kind !== 'ring') throw new Error('no ring')
    const distance = new Map(state.acolytes.map((acolyte) => [acolyte.id,
      Math.hypot(acolyte.x - ring.origin.x, acolyte.y - layout.spriteSize.height * 0.6 - ring.origin.y)]))
    const firstSalute = new Map<string, number>()
    const salutes = new Map<string, number>()
    run(state, layout, 3000, (next, previous, time) => {
      for (const id of salutesStarted(next, previous)) {
        salutes.set(id, (salutes.get(id) ?? 0) + 1)
        if (!firstSalute.has(id)) firstSalute.set(id, time)
      }
    })
    expect([...salutes.keys()].sort()).toEqual(ids(count).sort())
    expect([...salutes.values()].every((value) => value === 1)).toBe(true)
    const byDistance = ids(count).sort((a, b) => distance.get(a)! - distance.get(b)!)
    const times = byDistance.map((id) => firstSalute.get(id)!)
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(times[0]).toBeLessThan(times.at(-1)!)
  })
})

describe('reports and mail', () => {
  it('send a report packet to the Magos, which then plays speak and returns to idle', () => {
    let state = populate(3, 2, mid)
    expect(state.magos.action).toBe('idle')
    state = apply(state, mid, { type: 'reportSent', from: 'a1' })
    expect(packets(state)).toEqual([expect.objectContaining({ purpose: 'report', from: 'a1', to: MAGOS_ID })])
    const flight = packets(state)[0]!.duration
    state = run(state, mid, Math.floor(flight / STEP) * STEP - STEP)
    expect(state.magos.action).toBe('idle')
    state = run(state, mid, 3 * STEP)
    expect(packets(state)).toHaveLength(0)
    expect(state.magos.action).toBe('speak')
    state = run(state, mid, clipDuration(DEFAULT_CLIP_TIMINGS.speak) + 50)
    expect(state.magos.action).toBe('idle')
  })

  it('send a peer-mail packet between acolytes without a salute', () => {
    let state = populate(5, 2, mid)
    state = apply(state, mid, { type: 'peerMail', from: 'a1', to: 'a2' })
    expect(packets(state)).toEqual([expect.objectContaining({ purpose: 'mail', from: 'a1', to: 'a2' })])
    const saluted: string[] = []
    state = run(state, mid, 1500, (next, previous) => saluted.push(...salutesStarted(next, previous)))
    expect(saluted).toEqual([])
    expect(packets(state)).toHaveLength(0)
  })
})

describe('the Magos', () => {
  it('plays one action at a time by priority', () => {
    let state = populate(9, 1, mid)
    state = apply(state, mid, { type: 'magosBusy', on: true })
    expect(state.magos.action).toBe('speak')
    state = apply(state, mid, { type: 'petitionPending', on: true })
    expect(state.magos.action).toBe('petition')
    state = apply(state, mid, { type: 'orderSent', to: 'a1', orderId: 'o' })
    expect(state.magos).toMatchObject({ action: 'petition', queue: ['order_one'] })
    state = apply(state, mid, { type: 'petitionPending', on: false })
    expect(state.magos).toMatchObject({ action: 'order_one', oneShot: true })
    state = apply(state, mid, { type: 'runState', runState: 'ending' })
    expect(state.magos.action).toBe('order_one')
    state = run(state, mid, clipDuration(DEFAULT_CLIP_TIMINGS.order_one) + STEP)
    expect(state.magos.action).toBe('chronicle')
    state = run(state, mid, clipDuration(DEFAULT_CLIP_TIMINGS.chronicle) + 2 * STEP)
    expect(state.magos.action).toBe('speak')
  })

  it('takes one-shot durations from the injected clip timings', () => {
    const clips = { ...DEFAULT_CLIP_TIMINGS, summon: { fps: 2, frames: 6 } }
    let state = apply(createChamber(1, clips), mid, { type: 'memberJoined', id: 'a1' })
    expect(state.magos.action).toBe('summon')
    state = run(state, mid, 2900)
    expect(state.magos.action).toBe('summon')
    state = run(state, mid, 200)
    expect(state.magos.action).toBe('idle')
  })
})

describe('acolyte modes', () => {
  it('beam in at the pad, then wander, jump, climb and stumble with consoles as platforms', () => {
    let state = apply(createChamber(4), mid, { type: 'memberJoined', id: 'a1' })
    expect(state.acolytes[0]).toMatchObject({ mode: 'arriving', x: mid.teleportPad.centerX, y: mid.floorY })
    expect(state.effects.map((effect) => effect.kind)).toEqual(['beam'])
    state = apply(state, mid, ...ids(6).slice(1).map((id): ChamberEvent => ({ type: 'memberJoined', id })))
    const poses = new Set<string>()
    const supports = new Set<string>()
    run(state, mid, 120_000, (next) => {
      for (const acolyte of next.acolytes) {
        poses.add(acolyte.pose)
        if (acolyte.motion.supportId) supports.add(acolyte.motion.supportId)
      }
    })
    for (const pose of ['walk', 'jump', 'climb', 'stumble']) expect(poses).toContain(pose)
    expect([...supports].some((id) => id.startsWith('console-'))).toBe(true)
  })

  it('send working acolytes to their consoles to type; the 7th worker drills', () => {
    let state = populate(17, 7, wide)
    expect(wide.consoles).toHaveLength(6)
    state = apply(state, wide, ...ids(7).map((id): ChamberEvent => ({ type: 'working', id, on: true })))
    state = run(state, wide, 25_000)
    for (const [index, station] of wide.consoles.entries()) {
      expect(state.acolytes[index]).toMatchObject({ mode: 'working', consoleId: station.id, pose: 'type',
        x: station.operatorX, y: wide.floorY, facing: station.operatorFacing })
    }
    expect(state.acolytes[6]).toMatchObject({ mode: 'working', consoleId: null, pose: 'drill', y: wide.floorY })
    state = run(apply(state, wide, { type: 'working', id: 'a1', on: false }), wide, 1000)
    expect(state.acolytes[0]!.mode).toBe('wandering')
    expect(state.acolytes[6]).toMatchObject({ consoleId: 'console-1', pose: 'walk' })
  })

  it('walk a dismissed acolyte out of the door and remove it', () => {
    let state = apply(populate(2, 2, mid), mid, { type: 'memberLeft', id: 'a2' })
    expect(state.acolytes[1]!.mode).toBe('leaving')
    let lastX = 0
    state = run(state, mid, 20_000, (_, previous) => {
      lastX = previous.acolytes.find((item) => item.id === 'a2')?.x ?? lastX
    })
    expect(state.acolytes.map((item) => item.id)).toEqual(['a1'])
    expect(Math.abs(lastX - mid.door.exitX)).toBeLessThanOrEqual(110 * STEP / 1000 + 1e-6)
  })
})

describe('run-state theatrics', () => {
  it('pause freezes everything for 10 s and resume continues as if never paused', () => {
    let base = populate(11, 6, mid)
    base = apply(base, mid, { type: 'working', id: 'a1', on: true }, { type: 'working', id: 'a2', on: true },
      { type: 'bubble', id: 'a3', text: 'Praise the Omnissiah' }, { type: 'reportSent', from: 'a4' },
      { type: 'orderSent', to: 'all', orderId: 'x' }, { type: 'magosBusy', on: true })
    base = run(base, mid, 400)

    const paused = apply(base, mid, { type: 'runState', runState: 'paused' })
    expect(paused.stasis).toBe(true)
    const frozen = run(paused, mid, 10_000, (next, previous) => expect(next).toBe(previous))
    expect(frozen).toBe(paused)
    const resumed = run(apply(frozen, mid, { type: 'runState', runState: 'running' }), mid, 8000)
    const unpaused = run(base, mid, 8000)
    expect(resumed.stasis).toBe(false)
    expect(resumed).toEqual(unpaused)
  })

  it('ending: every acolyte reports, exits the door and is removed, then the lights dim', () => {
    let state = populate(12, 6, mid)
    state = apply(state, mid, { type: 'working', id: 'a1', on: true })
    state = run(state, mid, 3000)
    state = apply(state, mid, { type: 'runState', runState: 'ending' })
    expect(packets(state).map((packet) => [packet.purpose, packet.from, packet.to]))
      .toEqual(ids(6).map((id) => ['report', id, MAGOS_ID]))
    expect(state.acolytes.every((acolyte) => acolyte.mode === 'leaving')).toBe(true)
    expect(state.magos.action).toBe('chronicle')
    expect(state.lightsDim).toBe(false)
    const lastX = new Map<string, number>()
    state = run(state, mid, 30_000, (next, previous) => {
      for (const acolyte of previous.acolytes) lastX.set(acolyte.id, acolyte.x)
      expect(next.lightsDim).toBe(next.acolytes.length === 0)
      expectBounded(next, mid)
    })
    expect(state.acolytes).toEqual([])
    expect(state.lightsDim).toBe(true)
    for (const id of ids(6)) expect(Math.abs(lastX.get(id)! - mid.door.exitX)).toBeLessThanOrEqual(2)
    expect(apply(state, mid, { type: 'runState', runState: 'ended' }).lightsDim).toBe(true)
  })
})

describe('run-state theatrics: kill, warning and bounds', () => {

  it('killed removes every acolyte at once and sets blackout and sparks', () => {
    let state = populate(13, 24, chamberLayout(ROOMS[0], PROPS, 24))
    const small = chamberLayout(ROOMS[0], PROPS, 24)
    state = apply(state, small, { type: 'reportSent', from: 'a1' }, { type: 'bubble', id: 'a2', text: 'hi' })
    state = apply(state, small, { type: 'runState', runState: 'killed' })
    expect(state.acolytes).toEqual([])
    expect(state.blackout).toBe(true)
    expect(state.effects.map((effect) => effect.kind)).toEqual(['sparks'])
    expect(state.bubbles).toEqual({})
  })

  it('lastMinute sets and clears warning', () => {
    let state = apply(createChamber(1), mid, { type: 'lastMinute', on: true })
    expect(state.warning).toBe(true)
    state = apply(state, mid, { type: 'lastMinute', on: false })
    expect(state.warning).toBe(false)
  })

  it.each(ROOMS.flatMap((size) => [6, 24].map((count): [Size, number] => [size, count])))(
    'keeps every acolyte inside the room through orders, ending and kill at %o with %i acolytes', (size, count) => {
      const layout = chamberLayout(size, PROPS, count)
      let state = populate(count + size.width, count, layout, 1000)
      state = apply(state, layout, ...ids(count).filter((_, index) => index % 2 === 0)
        .map((id): ChamberEvent => ({ type: 'working', id, on: true })), { type: 'orderSent', to: 'all', orderId: 'o' })
      state = run(state, layout, 8000, (next) => expectBounded(next, layout))
      const killed = apply(state, layout, { type: 'runState', runState: 'killed' })
      expect(killed).toMatchObject({ acolytes: [], blackout: true })
      state = run(apply(state, layout, { type: 'runState', runState: 'ending' }), layout, 40_000,
        (next) => expectBounded(next, layout))
      expect(state).toMatchObject({ acolytes: [], lightsDim: true })
    })
})

describe('determinism', () => {
  const script = (seed: number): ChamberState => {
    let state = populate(seed, 6, mid)
    state = apply(state, mid, { type: 'working', id: 'a2', on: true }, { type: 'orderSent', to: 'a3', orderId: 'o' })
    state = run(state, mid, 5000)
    state = apply(state, mid, { type: 'orderSent', to: 'all', orderId: 'p' }, { type: 'peerMail', from: 'a1', to: 'a4' })
    return run(state, mid, 5000)
  }

  it('gives identical states for the same seed and events', () => {
    expect(script(99)).toEqual(script(99))
    expect(script(99).acolytes.map((item) => item.x)).not.toEqual(script(100).acolytes.map((item) => item.x))
  })
})

describe('bubbles', () => {
  it('cap text at 60 characters with an ellipsis', () => {
    const state = apply(populate(1, 1, mid, 100), mid, { type: 'bubble', id: 'a1', text: 'x'.repeat(80) })
    const text = state.bubbles.a1!.text
    expect([...text]).toHaveLength(BUBBLE_MAX_CHARS)
    expect(text.endsWith('…')).toBe(true)
    expect(apply(state, mid, { type: 'bubble', id: 'a1', text: 'short' }).bubbles.a1!.pending).toBe('short')
  })

  it('show each bubble 2.5 to 6 s and replace older text only after the minimum', () => {
    const tick = (state: ChamberState, ms: number): ChamberState => {
      let current = state
      for (let time = 0; time < ms; time += 100) current = stepChamber(current, 100, mid)
      return current
    }
    let state = apply(populate(1, 1, mid, 100), mid, { type: 'bubble', id: MAGOS_ID, text: 'one' })
    state = tick(state, 1000)
    state = apply(state, mid, { type: 'bubble', id: MAGOS_ID, text: 'two' })
    expect(state.bubbles[MAGOS_ID]).toMatchObject({ text: 'one', pending: 'two' })
    state = tick(state, 1400)
    expect(state.bubbles[MAGOS_ID]!.text).toBe('one')
    state = tick(state, 100)
    expect(state.bubbles[MAGOS_ID]).toMatchObject({ text: 'two', age: 0, pending: null })
    state = tick(state, 3000)
    state = apply(state, mid, { type: 'bubble', id: MAGOS_ID, text: 'three' })
    expect(state.bubbles[MAGOS_ID]).toMatchObject({ text: 'three', age: 0 })
    state = tick(state, 5900)
    expect(state.bubbles[MAGOS_ID]!.text).toBe('three')
    state = tick(state, 100)
    expect(state.bubbles[MAGOS_ID]).toBeUndefined()
    expect(apply(state, mid, { type: 'bubble', id: 'nobody', text: 'x' }).bubbles).toEqual({})
  })
})

describe('staticChamber', () => {
  it('places members without motion or effects and keeps bubbles and flags', () => {
    let state = populate(31, 8, mid, 2000)
    state = apply(state, mid, { type: 'working', id: 'a2', on: true }, { type: 'working', id: 'a5', on: true },
      { type: 'bubble', id: 'a1', text: 'Binharic hymn' }, { type: 'lastMinute', on: true },
      { type: 'orderSent', to: 'all', orderId: 'o' })
    const still = staticChamber(state, mid)
    expect(still.effects).toEqual([])
    expect(still.bubbles).toEqual(state.bubbles)
    expect(still.warning).toBe(true)
    expect(still.magos).toMatchObject({ action: state.magos.action, elapsed: 0 })
    const [first, second] = mid.consoles
    expect(still.acolytes[1]).toMatchObject({ x: first!.operatorX, y: mid.floorY, pose: 'type' })
    expect(still.acolytes[4]).toMatchObject({ x: second!.operatorX, y: mid.floorY, pose: 'type' })
    const row = still.acolytes.filter((_, index) => index !== 1 && index !== 4)
    const gaps = row.slice(1).map((acolyte, index) => acolyte.x - row[index]!.x)
    for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0]!, 6)
    expect(row.every((acolyte) => acolyte.y === mid.floorY && acolyte.pose === 'idle')).toBe(true)
    expect(row[0]!.x).toBeGreaterThan(mid.door.rect.x + mid.door.rect.width)
    expect(row.at(-1)!.x).toBeLessThan(mid.teleportPad.rect.x)
    expect(staticChamber(state, mid)).toEqual(still)
  })
})
