import { expect, it } from 'vitest'
import { createMotion, stepMotion, type MotionSurfaces } from './motion'

const board: MotionSurfaces = {
  viewport: { width: 500, height: 320 },
  mascotSize: { width: 64, height: 80 },
  tickets: [{ id: 'ticket-a', x: 180, y: 150, width: 210, height: 72 }]
}

function advance(seed: number, count: number, delta = 100): ReturnType<typeof createMotion> {
  let state = createMotion(seed, { x: 80, y: 300 })
  for (let i = 0; i < count; i += 1) state = stepMotion(state, delta, board)
  return state
}

function findApproach() {
  for (let seed = 1; seed <= 40; seed += 1) {
    let state = createMotion(seed, { x: 120, y: 300 })
    for (let i = 0; i < 1200; i += 1) {
      state = stepMotion(state, 40, board)
      if ((state.action === 'walk' || state.action === 'run') && state.targetId === 'ticket-a') return state
    }
  }
  throw new Error('No deterministic ticket approach found in the bounded seed search')
}

function findTicketSupport() {
  for (let seed = 1; seed <= 40; seed += 1) {
    let state = createMotion(seed, { x: 120, y: 300 })
    for (let i = 0; i < 1800; i += 1) {
      state = stepMotion(state, 40, board)
      if (state.supportId === 'ticket-a') return state
    }
  }
  throw new Error('No ticket-top support found in the bounded seed search')
}

function findMidflightJump(surfaces: MotionSurfaces): State | null {
  for (let seed = 1; seed <= 100; seed += 1) {
    let state = createMotion(seed, { x: 240, y: 320 })
    for (let frame = 0; frame < 1000; frame += 1) {
      state = stepMotion(state, 20, surfaces)
      const inFlight = state.action === 'jump' && state.targetId === 'low' && state.toY === 240
        && state.progress > 0.3 && state.progress < 0.7
      if (inFlight) return state
    }
  }
  return null
}

function landOnLowCard(flight: State, surfaces: MotionSurfaces): State {
  let landed = flight
  for (let frame = 0; frame < 200 && landed.supportId !== 'low'; frame += 1) {
    landed = stepMotion(landed, 20, surfaces)
  }
  return landed
}

type State = ReturnType<typeof createMotion>

const tower: MotionSurfaces = {
  viewport: { width: 640, height: 600 }, mascotSize: { width: 64, height: 80 },
  tickets: [
    { id: 'low', x: 80, y: 480, width: 180, height: 65, inProgress: false },
    { id: 'middle', x: 215, y: 370, width: 180, height: 65, inProgress: false },
    { id: 'high', x: 300, y: 260, width: 180, height: 65, inProgress: true }
  ]
}

it('routes through stepping stones to the highest active ticket and works there', () => {
  for (const seed of [2, 7, 19]) {
    let state = createMotion(seed, { x: 100, y: 600 })
    const supports = new Set<string>()
    for (let frame = 0; frame < 3000 && !state.working; frame += 1) {
      state = stepMotion(state, 40, tower)
      if (state.supportId) supports.add(state.supportId)
    }
    expect([...supports]).toContain('low')
    expect([...supports]).toContain('middle')
    expect(state.supportId).toBe('high')
    expect(state.working).toBe(true)
  }
})

it('falls to the first crossed platform on a shake, consuming its id once', () => {
  const start: State = { ...createMotion(7, { x: 345, y: 260 }), supportId: 'high' }
  const shaken = { ...tower, shakeId: 1 }
  const first = stepMotion(start, 40, shaken)
  expect(first.action).toBe('stumble')
  expect(first.y).toBeGreaterThan(260)
  const landed = stepMotion(first, 400, shaken)
  expect(landed.y).toBe(370)
  expect(landed.supportId).toBe('middle')
  expect(landed.lastShakeId).toBe(1)
})

it('carries a supported mascot with a gentle board pan', () => {
  let state: State = { ...createMotion(5, { x: 170, y: 480 }), supportId: 'low' }
  state = stepMotion(state, 20, tower)
  const panned = { ...tower, tickets: tower.tickets.map((ticket) => ({ ...ticket, x: ticket.x + 12, y: ticket.y + 8 })) }
  const next = stepMotion(state, 20, panned)
  expect(next.action).not.toBe('stumble')
  expect(next.supportId).toBe('low')
  expect(next.x).toBeCloseTo(state.x + 12, 1)
  expect(next.y).toBeCloseTo(state.y + 8, 1)
})

it('prefers the highest reachable active ticket over inactive tops with the same seed', () => {
  const lowActive = { ...tower, tickets: tower.tickets.map((ticket) => ({ ...ticket,
    inProgress: ticket.id === 'low' })) }
  let high = createMotion(11, { x: 100, y: 600 })
  let low = createMotion(11, { x: 100, y: 600 })
  for (let frame = 0; frame < 2500 && (!high.working || !low.working); frame += 1) {
    if (!high.working) high = stepMotion(high, 40, tower)
    if (!low.working) low = stepMotion(low, 40, lowActive)
  }
  expect(high.supportId).toBe('high')
  expect(low.supportId).toBe('low')
})

it('explores toward the highest reachable top when no ticket is active', () => {
  const inactive = { ...tower, tickets: tower.tickets.map((ticket) => ({ ...ticket, inProgress: false })) }
  let state = createMotion(19, { x: 100, y: 600 })
  let visitedHigh = false
  for (let frame = 0; frame < 2500 && !visitedHigh; frame += 1) {
    state = stepMotion(state, 40, inactive)
    visitedHigh = state.supportId === 'high'
  }
  expect(visitedHigh).toBe(true)
})

function scanAscent(seed: number, surfaces: MotionSurfaces): { rested: number; slipped: number; reached: boolean } {
  let state = createMotion(seed, { x: 120, y: 320 })
  let rested = 0
  let slipped = 0
  for (let frame = 0; frame < 1500 && !state.working; frame += 1) {
    const prior = state
    state = stepMotion(state, 40, surfaces)
    if (state.resting && !prior.resting) {
      rested += 1
      const held = stepMotion(state, 40, surfaces)
      expect(held.action).toBe('climb')
      expect(held.x).toBeCloseTo(state.x)
      expect(held.y).toBeCloseTo(state.y)
    }
    if (state.falling && !prior.falling && (prior.action === 'jump' || prior.action === 'climb')) slipped += 1
  }
  return { rested, slipped, reached: Boolean(state.working) }
}

it('has seeded climbing rests and slips while still reaching work', () => {
  const activeBoard = { ...board, tickets: [{ ...board.tickets[0]!, inProgress: true }] }
  let rested = 0
  let slipped = 0
  let reached = 0
  for (let seed = 1; seed <= 24; seed += 1) {
    const result = scanAscent(seed, activeBoard)
    rested += result.rested
    slipped += result.slipped
    if (result.reached) reached += 1
  }
  expect(rested).toBeGreaterThan(0)
  expect(slipped).toBeGreaterThan(0)
  expect(reached).toBeGreaterThan(16)
})

it('lands on the first crossed top regardless of ticket order or frame size', () => {
  const levels: MotionSurfaces = { viewport: { width: 600, height: 600 },
    mascotSize: { width: 52, height: 80 }, tickets: [
      { id: 'lower', x: 180, y: 370, width: 240, height: 60 },
      { id: 'upper', x: 180, y: 250, width: 240, height: 60 }
    ], shakeId: 1 }
  const start: State = { ...createMotion(4, { x: 280, y: 180 }), action: 'jump' }
  const large = stepMotion(start, 400, levels)
  expect(large.action).toBe('stumble')
  expect(large.supportId).toBe('upper')
  expect(large.y).toBe(250)
  let small = start
  for (let frame = 0; frame < 20; frame += 1) small = stepMotion(small, 20, levels)
  expect(small.supportId).toBe('upper')
  expect(small.y).toBe(250)
  const outside = stepMotion({ ...start, x: 500, fromX: 500, toX: 500 }, 900, levels)
  expect(outside.supportId).toBeNull()
  expect(outside.y).toBe(600)
})

it('recomputes a falling catch when the first platform moves or disappears', () => {
  const levels: MotionSurfaces = { viewport: { width: 600, height: 600 },
    mascotSize: { width: 52, height: 80 }, tickets: [
      { id: 'lower', x: 180, y: 370, width: 240, height: 60 },
      { id: 'upper', x: 180, y: 250, width: 240, height: 60 }
    ], shakeId: 1 }
  const falling = stepMotion({ ...createMotion(4, { x: 280, y: 180 }), action: 'jump' }, 120, levels)
  const moved = { ...levels, tickets: [{ ...levels.tickets[0]! }, { ...levels.tickets[1]!, y: 300 }] }
  const onMoved = stepMotion(falling, 450, moved)
  expect(onMoved.supportId).toBe('upper')
  expect(onMoved.y).toBe(300)
  const removed = stepMotion(falling, 650, { ...levels, tickets: [levels.tickets[0]!] })
  expect(removed.supportId).toBe('lower')
  expect(removed.y).toBe(370)
})

it('stops work when status ends and retargets a newly active higher ticket', () => {
  const lowActive = { ...tower, tickets: tower.tickets.map((ticket) => ({ ...ticket,
    inProgress: ticket.id === 'low' })) }
  let state = createMotion(11, { x: 100, y: 600 })
  for (let frame = 0; frame < 2000 && !state.working; frame += 1) state = stepMotion(state, 40, lowActive)
  expect(state.supportId).toBe('low')
  const stopped = stepMotion(state, 40, { ...lowActive, tickets: lowActive.tickets.map((ticket) => ({
    ...ticket, inProgress: false })) })
  expect(stopped.working).toBe(false)
  const newlyHigh = stepMotion(state, 40, tower)
  expect(newlyHigh.working).toBe(false)
  expect(newlyHigh.targetId === 'middle' || newlyHigh.action === 'walk').toBe(true)
})

it('carries support through zoom and consumes the initial shake baseline', () => {
  const baseline = { ...tower, shakeId: 0 }
  let state: State = { ...createMotion(5, { x: 170, y: 480 }), supportId: 'low' }
  state = stepMotion(state, 20, baseline)
  expect(state.falling).not.toBe(true)
  const zoomed = { ...baseline, tickets: baseline.tickets.map((ticket) => ({ ...ticket,
    x: ticket.x * 1.25 + 20, y: ticket.y * 1.25 - 120,
    width: ticket.width * 1.25, height: ticket.height * 1.25 })) }
  const next = stepMotion(state, 20, zoomed)
  expect(next.supportId).toBe('low')
  expect(next.action).not.toBe('stumble')
  expect(next.x).toBeCloseTo(state.x * 1.25 + 20, 1)
})

it('approaches and climbs a tall ticket from either side', () => {
  for (const [startX, facing] of [[120, 'right'], [450, 'left']] as const) {
    let found = false
    for (let seed = 1; seed <= 20 && !found; seed += 1) {
      let state = createMotion(seed, { x: startX, y: 320 })
      for (let frame = 0; frame < 1500 && !found; frame += 1) {
        state = stepMotion(state, 40, board)
        found = state.action === 'climb' && state.facing === facing
      }
    }
    expect(found).toBe(true)
  }
})

it('works in bounded sessions and drops work immediately when its support is removed', () => {
  let state = createMotion(7, { x: 100, y: 600 })
  for (let frame = 0; frame < 2500 && !state.working; frame += 1) state = stepMotion(state, 40, tower)
  expect(state.working).toBe(true)
  const removed = stepMotion(state, 40, { ...tower, tickets: tower.tickets.filter((ticket) => ticket.id !== 'high') })
  expect(removed.working).toBe(false)
  expect(removed.action).toBe('stumble')
  let paused = false
  for (let frame = 0; frame < 120 && !paused; frame += 1) {
    state = stepMotion(state, 40, tower)
    paused = state.working === false
  }
  expect(paused).toBe(true)
})

it('does not chase an active ticket beyond an unreachable height gap', () => {
  const unreachable = { ...tower, tickets: [
    { ...tower.tickets[0]!, inProgress: true },
    { id: 'isolated', x: 300, y: 100, width: 180, height: 65, inProgress: true }
  ] }
  let state = createMotion(11, { x: 100, y: 600 })
  for (let frame = 0; frame < 1800 && !state.working; frame += 1) state = stepMotion(state, 40, unreachable)
  expect(state.working).toBe(true)
  expect(state.supportId).toBe('low')
})

it('keeps both side grips attached through a zoom and retargets the right approach', () => {
  const ticket = board.tickets[0]!
  const zoomed: MotionSurfaces = { viewport: { width: 1000, height: 640 },
    mascotSize: board.mascotSize, tickets: [{ ...ticket,
      x: ticket.x * 2, y: ticket.y * 2, width: ticket.width * 2, height: ticket.height * 2 }] }
  for (const [fromX, toX, expected] of [[148, 214, 328], [422, 356, 812]] as const) {
    const grip: State = { ...createMotion(4, { x: fromX, y: 222 }), action: 'climb',
      fromX, fromY: 222, toX, toY: 150, targetId: ticket.id,
      targetRect: ticket, duration: 1000, elapsed: 100, progress: 0.1 }
    const next = stepMotion(grip, 20, zoomed)
    expect(next.action).toBe('climb')
    expect(next.fromX).toBe(expected)
    expect(next.falling).not.toBe(true)
  }
  const approach: State = { ...createMotion(4, { x: 450, y: 320 }), action: 'walk',
    fromX: 450, fromY: 320, toX: 422, toY: 320,
    targetId: ticket.id, targetRect: ticket }
  const retargeted = stepMotion(approach, 20, zoomed)
  expect(retargeted.toX).toBe(812)
  expect(retargeted.action).toBe('walk')
})

it('keeps fixed-size feet on both support edges while zooming out', () => {
  const old = { id: 'a', x: 80, y: 200, width: 180, height: 60 }
  const zoomed = { ...old, x: 64, y: 160, width: 144, height: 48 }
  const surfaces: MotionSurfaces = { viewport: { width: 500, height: 320 },
    mascotSize: { width: 52, height: 80 }, tickets: [zoomed] }
  for (const [x, expected] of [[106, 90], [234, 182]] as const) {
    const supported: State = { ...createMotion(5, { x, y: 200 }),
      supportId: 'a', supportRect: old, fromX: x, toX: x }
    const next = stepMotion(supported, 20, surfaces)
    expect(next.supportId).toBe('a')
    expect(next.action).not.toBe('stumble')
    expect(next.x).toBeCloseTo(expected)
    expect(next.y).toBeCloseTo(160)
  }
})

it('keeps direct jump landings inside fixed-size ticket edges on zoom out', () => {
  const old = { id: 'a', x: 80, y: 200, width: 180, height: 60 }
  const zoomed = { ...old, x: 64, y: 160, width: 144, height: 48 }
  const surfaces: MotionSurfaces = { viewport: { width: 500, height: 320 },
    mascotSize: { width: 52, height: 80 }, tickets: [zoomed] }
  for (const [toX, expected] of [[106, 90], [234, 182]] as const) {
    const flight: State = { ...createMotion(5, { x: 150, y: 260 }),
      action: 'jump', fromX: 150, fromY: 320, toX, toY: 200,
      targetId: 'a', targetRect: old, duration: 1000, elapsed: 500, progress: 0.5,
      jumpHeight: 70 }
    const next = stepMotion(flight, 20, surfaces)
    expect(next.action).toBe('jump')
    expect(next.falling).not.toBe(true)
    expect(next.toX).toBeCloseTo(expected)
  }
})

it('ignores an active card whose visible sliver cannot support the feet', () => {
  const clipped: MotionSurfaces = { viewport: { width: 500, height: 320 },
    mascotSize: { width: 52, height: 80 }, tickets: [
      { id: 'sliver', x: -200, y: 220, width: 210, height: 60, inProgress: true },
      { id: 'valid', x: 180, y: 240, width: 180, height: 50, inProgress: true }
    ] }
  let state = createMotion(7, { x: 150, y: 320 })
  for (let frame = 0; frame < 1800 && !state.working; frame += 1) state = stepMotion(state, 40, clipped)
  expect(state.working).toBe(true)
  expect(state.supportId).toBe('valid')
})

it('descends through lower platforms when active work appears below', () => {
  const lowerActive = { ...tower, tickets: tower.tickets.map((ticket) => ({ ...ticket,
    inProgress: ticket.id === 'low' })) }
  let state: State = { ...createMotion(7, { x: 345, y: 260 }), supportId: 'high',
    supportRect: tower.tickets[2] }
  const visited = new Set<string>()
  let descended = false
  for (let frame = 0; frame < 2500 && !state.working; frame += 1) {
    state = stepMotion(state, 40, lowerActive)
    if (state.supportId) visited.add(state.supportId)
    descended ||= Boolean(state.descending || state.falling)
  }
  expect(descended).toBe(true)
  expect(visited.has('middle')).toBe(true)
  expect(state.supportId).toBe('low')
  expect(state.working).toBe(true)
})

function assertGroundedTravel(state: State, startX: number, topActions: Set<string>): void {
  expect(state.x).not.toBe(startX)
  const support = state.supportId ? board.tickets.find((ticket) => ticket.id === state.supportId) : undefined
  expect(state.y).toBeCloseTo(support?.y ?? board.viewport.height, 0)
  if (support) topActions.add(state.action)
}

function isSideJump(state: State): boolean {
  const ticket = board.tickets[0]!
  const half = board.mascotSize.width / 2
  return state.action === 'jump' && state.targetId === ticket.id &&
    state.toY === ticket.y + ticket.height &&
    (state.toX === ticket.x - half || state.toX === ticket.x + ticket.width + half)
}

function routeStage(state: State): string | null {
  if (state.action === 'climb' && state.targetId === 'ticket-a') return 'climb'
  if (isSideJump(state)) return 'sideJump'
  if ((state.action === 'walk' || state.action === 'run') && state.targetId === 'ticket-a') return 'approach'
  if (state.supportId === 'ticket-a' && state.y === board.tickets[0]!.y) return 'top'
  return null
}

function assertRouteStage(state: State, stage: string): void {
  const ticket = board.tickets[0]!
  const half = board.mascotSize.width / 2
  if (stage === 'approach') expect(state.y).toBeCloseTo(board.viewport.height, 1)
  if (stage === 'sideJump') expect(state.toY).toBe(ticket.y + ticket.height)
  if (stage !== 'climb') return
  expect(state.fromY).toBe(ticket.y + ticket.height)
  expect(state.fromX === ticket.x - half || state.fromX === ticket.x + ticket.width + half).toBe(true)
  expect(state.facing).toBe(state.fromX < ticket.x ? 'right' : 'left')
  if (state.progress < 0.75) expect(state.x).toBeCloseTo(state.fromX, 3)
  expect(state.y).toBeGreaterThanOrEqual(ticket.y)
}

function isAirborne(state: State): boolean {
  return state.progress > 0.25 && state.progress < 0.75 && state.y < state.fromY - 20
}

function hasLanded(state: State): boolean {
  return state.supportId !== null || Math.abs(state.y - board.viewport.height) < 0.1
}

  it('walks and runs along reachable support surfaces', () => {
    let state = createMotion(4, { x: 90, y: 300 })
    const seen = new Set<string>()
    const ticketTopActions = new Set<string>()
    const startX = state.x
    for (let i = 0; i < 500; i += 1) {
      state = stepMotion(state, 100, board)
      seen.add(state.action)
      expect(Number.isFinite(state.x) && Number.isFinite(state.y)).toBe(true)
      if (state.action === 'walk' || state.action === 'run') {
        assertGroundedTravel(state, startX, ticketTopActions)
      }
    }
    expect(seen.has('walk')).toBe(true)
    expect(seen.has('run')).toBe(true)
    expect(ticketTopActions.has('walk')).toBe(true)
    expect(ticketTopActions.has('run')).toBe(true)
  })

  it('jumps through an air arc and lands back on a supported surface', () => {
    let state = createMotion(23, { x: 100, y: 300 })
    let highestFeet = state.y
    let sawJump = false
    let sawCrouch = false
    let sawFlight = false
    let landedSupported = false
    for (let i = 0; i < 1200; i += 1) {
      state = stepMotion(state, 40, board)
      if (state.action === 'jump') {
        sawJump = true
        highestFeet = Math.min(highestFeet, state.y)
        if (state.progress <= 0.14) {
          sawCrouch = true
          expect(state.y).toBeCloseTo(state.fromY, 3)
        }
        if (isAirborne(state)) sawFlight = true
        if (state.progress >= 0.86) expect(state.y).toBeCloseTo(state.toY, 3)
      } else if (sawJump) {
        landedSupported = hasLanded(state)
        if (landedSupported) break
      }
    }
    expect(sawJump).toBe(true)
    expect(sawCrouch).toBe(true)
    expect(sawFlight).toBe(true)
    expect(highestFeet).toBeLessThan(300)
    expect(landedSupported).toBe(true)
  })

  it('climbs from a ticket side to its top through a visible climb sequence', () => {
    let state = createMotion(2, { x: 120, y: 300 })
    const seen = new Set<string>()
    for (let i = 0; i < 1800; i += 1) {
      state = stepMotion(state, 50, board)
      const stage = routeStage(state)
      if (!stage) continue
      if (stage === 'climb') expect(seen.has('sideJump')).toBe(true)
      assertRouteStage(state, stage)
      if (stage !== 'top' || seen.has('climb')) seen.add(stage)
    }
    expect(seen).toEqual(new Set(['approach', 'sideJump', 'climb', 'top']))
  })

  it('never climbs a floating card whose bottom is beyond jump reach', () => {
    const high: MotionSurfaces = { ...board, viewport: { width: 500, height: 600 }, tickets: [{ id: 'high', x: 180, y: 150, width: 210, height: 72 }] }
    let state = createMotion(2, { x: 120, y: 600 })
    for (let i = 0; i < 1400; i += 1) {
      state = stepMotion(state, 40, high)
      expect(state.action).not.toBe('climb')
      expect(state.supportId).not.toBe('high')
    }
  })

  it('carries a side jump or climb with a moving target card', () => {
    let state = createMotion(2, { x: 120, y: 300 })
    let sideJump: typeof state | null = null
    let climb: typeof state | null = null
    for (let i = 0; i < 1800 && (!sideJump || !climb); i += 1) {
      state = stepMotion(state, 40, board)
      if (state.action === 'jump' && state.targetId === 'ticket-a' && state.toY === 222) sideJump = state
      if (state.action === 'climb' && state.targetId === 'ticket-a') climb = state
    }
    expect(sideJump).not.toBeNull()
    expect(climb).not.toBeNull()
    const moved = { ...board, tickets: [{ ...board.tickets[0]!, y: 130 }] }
    expect(stepMotion(sideJump!, 40, moved).action).not.toBe('stumble')
    expect(stepMotion(climb!, 40, moved).action).not.toBe('stumble')
  })

  it('matches one long update to short frames across jump and climb boundaries', () => {
    let short = createMotion(2, { x: 120, y: 300 })
    const total = 24_000
    for (let elapsed = 0; elapsed < total; elapsed += 20) short = stepMotion(short, 20, board)
    const long = stepMotion(createMotion(2, { x: 120, y: 300 }), total, board)
    expect(long.action).toBe(short.action)
    expect(long.supportId).toBe(short.supportId)
    expect(long.targetId).toBe(short.targetId)
    expect(long.x).toBeCloseTo(short.x, 4)
    expect(long.y).toBeCloseTo(short.y, 4)
    expect(long.progress).toBeCloseTo(short.progress, 4)
    expect(long.randomState).toBe(short.randomState)
  })

  it('keeps empty, tiny, changed, and very long updates finite and in bounds', () => {
    let state = createMotion(9, { x: 25, y: 40 })
    const tiny: MotionSurfaces = { viewport: { width: 12, height: 10 }, mascotSize: { width: 88, height: 88 }, tickets: [] }
    state = stepMotion(state, 1_000_000, tiny)
    expect(state.action).toBe('idle')
    expect(state.x).toBe(6)
    expect(state.y).toBe(10)

    const movedAway: MotionSurfaces = { ...board, tickets: [{ id: 'ticket-a', x: 800, y: -500, width: 210, height: 72 }] }
    for (const input of [movedAway, { ...board, tickets: [] }, { ...board, viewport: { width: 0, height: 0 } }]) {
      state = stepMotion(state, 30_000, input)
      expect([state.x, state.y, state.progress].every(Number.isFinite)).toBe(true)
      expect(state.x).toBeGreaterThanOrEqual(0)
      expect(state.x).toBeLessThanOrEqual(input.viewport.width)
      expect(state.y).toBeGreaterThanOrEqual(0)
      expect(state.y).toBeLessThanOrEqual(input.viewport.height)
    }
  })

  it('retargets a side approach when its ticket moves and falls if it disappears', () => {
    const approach = findApproach()
    const moved = { ...board, tickets: [{ ...board.tickets[0]!, x: 260 }] }
    const afterMove = stepMotion(approach, 40, moved)
    expect(afterMove.action).not.toBe('stumble')
    expect([afterMove.x, afterMove.y, afterMove.progress].every(Number.isFinite)).toBe(true)

    const afterRemoval = stepMotion(approach, 40, { ...board, tickets: [] })
    expect(afterRemoval.action).toBe('stumble')
    expect(afterRemoval.x).toBeGreaterThanOrEqual(0)
    expect(afterRemoval.y).toBeLessThanOrEqual(board.viewport.height)
  })

  it('rides a moving supporting card and falls if it disappears', () => {
    const supported = findTicketSupport()
    const moved = { ...board, tickets: [{ ...board.tickets[0]!, y: 140 }] }
    const afterMove = stepMotion(supported, 40, moved)
    expect(afterMove.action).not.toBe('stumble')
    expect(afterMove.supportId).toBe('ticket-a')

    const afterRemoval = stepMotion(supported, 40, { ...board, tickets: [] })
    expect(afterRemoval.action).toBe('stumble')
    expect(afterRemoval.supportId).toBeNull()
    expect([afterRemoval.x, afterRemoval.y].every(Number.isFinite)).toBe(true)
  })

  it('rebases an active floor walk when the viewport floor moves', () => {
    let state = createMotion(4, { x: 90, y: 300 })
    for (let i = 0; i < 100 && state.action !== 'walk'; i += 1) state = stepMotion(state, 20, board)
    expect(state.action).toBe('walk')
    expect(state.supportId).toBeNull()
    const taller = { ...board, viewport: { width: 500, height: 500 } }
    const resized = stepMotion(state, 20, taller)
    expect(resized.action).toBe('walk')
    expect(resized.y).toBe(500)
    expect(resized.fromY).toBe(500)
    expect(resized.toY).toBe(500)
  })

  it('carries the mascot when its supporting top moves horizontally', () => {
    let state = findTicketSupport()
    for (let i = 0; i < 500 && state.action !== 'walk'; i += 1) state = stepMotion(state, 20, board)
    expect(state.action).toBe('walk')
    expect(state.supportId).toBe('ticket-a')
    const moved = { ...board, tickets: [{ ...board.tickets[0]!, x: state.x + 16 }] }
    const after = stepMotion(state, 40, moved)
    expect(after.action).not.toBe('stumble')
    expect(after.supportId).toBe('ticket-a')
  })

  it('jumps off a card edge before descending below its top', () => {
    let state = createMotion(2, { x: 120, y: 300 })
    const ticket = board.tickets[0]!
    let sampled = 0
    for (let i = 0; i < 1800; i += 1) {
      state = stepMotion(state, 20, board)
      if (state.action !== 'jump' || state.fromY !== ticket.y || state.toY !== board.viewport.height) continue
      sampled += 1
      expect(state.toX <= ticket.x - 32 || state.toX >= ticket.x + ticket.width + 32).toBe(true)
      if (state.y > ticket.y + 1) {
        expect(state.x <= ticket.x - 32 || state.x >= ticket.x + ticket.width + 32).toBe(true)
      }
    }
    expect(sampled).toBeGreaterThan(2)
  })

  it('repeats the same seeded trajectory and reaches idle and stumble opportunities', () => {
    const a = advance(71, 1000, 60)
    const b = advance(71, 1000, 60)
    expect(a).toEqual(b)
    let state = createMotion(71, { x: 80, y: 300 })
    const seen = new Set<string>()
    for (let i = 0; i < 3000; i += 1) {
      state = stepMotion(state, 50, board)
      seen.add(state.action)
    }
    expect(seen.has('idle')).toBe(true)
    expect(seen.has('stumble')).toBe(true)
  })

  it('advances consistently across ordinary frame sizes', () => {
    let smallSteps = createMotion(88, { x: 100, y: 300 })
    let largeSteps = createMotion(88, { x: 100, y: 300 })
    for (let i = 0; i < 100; i += 1) smallSteps = stepMotion(smallSteps, 20, board)
    for (let i = 0; i < 40; i += 1) largeSteps = stepMotion(largeSteps, 50, board)
    expect(largeSteps.x).toBeCloseTo(smallSteps.x, 2)
    expect(largeSteps.y).toBeCloseTo(smallSteps.y, 2)
    expect(largeSteps.action).toBe(smallSteps.action)
  })

  it('lands a direct jump on a reachable card top and recovers if the target vanishes in flight', () => {
    const reachable: MotionSurfaces = {
      viewport: { width: 500, height: 320 }, mascotSize: { width: 64, height: 80 },
      tickets: [{ id: 'low', x: 170, y: 240, width: 180, height: 50 }]
    }
    const flight = findMidflightJump(reachable)
    expect(flight).not.toBeNull()
    expect(flight!.y).toBeLessThan(flight!.fromY)
    expect(flight!.toX).toBeGreaterThanOrEqual(170 + 32)
    expect(flight!.toX).toBeLessThanOrEqual(350 - 32)
    const landed = landOnLowCard(flight!, reachable)
    expect(landed.supportId).toBe('low')
    expect(landed.y).toBeCloseTo(240)
    const recovered = stepMotion(flight!, 20, { ...reachable, tickets: [] })
    expect(recovered.action).toBe('stumble')
    expect(recovered.supportId).toBeNull()
    expect(recovered.y).toBeGreaterThanOrEqual(flight!.y)
  })

  it('falls from a removed support without teleporting and settles on the viewport floor', () => {
    const supported = findTicketSupport()
    const empty = { ...board, tickets: [] }
    const first = stepMotion(supported, 20, empty)
    expect(first.action).toBe('stumble')
    expect(first.x).toBeCloseTo(supported.x)
    expect(first.y).toBeGreaterThanOrEqual(supported.y)
    expect(first.y).toBeLessThan(board.viewport.height)
    let after = first
    let reachedFloor = false
    for (let i = 0; i < 40; i += 1) {
      after = stepMotion(after, 20, empty)
      if (Math.abs(after.y - board.viewport.height) < 0.01) reachedFloor = true
    }
    expect(reachedFloor).toBe(true)
    expect(after.supportId).toBeNull()
  })

  it('separates vertical climbing from the final move onto the card', () => {
    const base = createMotion(17, { x: 148, y: 222 })
    const climbing: State = {
      ...base, action: 'climb', fromX: 148, fromY: 222, toX: 214, toY: 150,
      x: 148, y: 222, duration: 1000, elapsed: 0, targetId: 'ticket-a'
    }
    const half = stepMotion(climbing, 500, board)
    expect(half.action).toBe('climb')
    expect(half.x).toBeCloseTo(148)
    expect(half.y).toBeGreaterThan(150)
    expect(half.y).toBeLessThan(222)
    const nearTop = stepMotion(half, 250, board)
    expect(nearTop.x).toBeCloseTo(148)
    expect(nearTop.y).toBeLessThan(half.y)
    const across = stepMotion(nearTop, 140, board)
    expect(across.x).toBeGreaterThan(148)
    expect(across.y).toBeCloseTo(150)
  })

  it('holds jump takeoff and landing poses around an airborne arc', () => {
    const base = createMotion(31, { x: 100, y: 320 })
    const jumping: State = {
      ...base, action: 'jump', fromX: 100, fromY: 320, toX: 240, toY: 240,
      x: 100, y: 320, duration: 1000, elapsed: 0, jumpHeight: 60, targetId: 'low'
    }
    const surfaces: MotionSurfaces = {
      ...board, tickets: [{ id: 'low', x: 170, y: 240, width: 180, height: 50 }]
    }
    const crouch = stepMotion(jumping, 100, surfaces)
    expect(crouch.x).toBeCloseTo(100)
    expect(crouch.y).toBeCloseTo(320)
    const peak = stepMotion(crouch, 400, surfaces)
    expect(peak.x).toBeCloseTo(170)
    expect(peak.y).toBeCloseTo(220)
    const landing = stepMotion(peak, 400, surfaces)
    expect(landing.x).toBeCloseTo(240)
    expect(landing.y).toBeCloseTo(240)
  })

const open = { width: 500, height: 320 }
const body = { width: 52, height: 80 }
const lone = (ticket: MotionSurfaces['tickets'][number], extra: Partial<MotionSurfaces> = {}): MotionSurfaces =>
  ({ viewport: open, mascotSize: body, tickets: [ticket], ...extra })

function runUntil(surfaces: MotionSurfaces, start: State, stop: (state: State) => boolean, frames = 2000): State {
  let state = start
  for (let frame = 0; frame < frames && !stop(state); frame += 1) state = stepMotion(state, 40, surfaces)
  return state
}

it('treats a zero or non-finite seed and position as the documented defaults', () => {
  expect(createMotion(0).randomState).toBe(createMotion(0x6d2b79f5).randomState)
  expect(createMotion(Number.NaN).randomState).toBe(0x6d2b79f5)
  const broken: State = { ...createMotion(3), x: Number.NaN, y: Number.POSITIVE_INFINITY, duration: Number.NaN }
  const next = stepMotion(broken, 0, { viewport: open, mascotSize: body, tickets: [] })
  expect(next.x).toBe(250)
  expect(next.y).toBe(320)
  expect(next.duration).toBe(1)
})

it('keeps the fall trajectory when a shake arrives mid-fall, consuming the shake id', () => {
  const empty: MotionSurfaces = { viewport: open, mascotSize: body, tickets: [] }
  const falling = stepMotion({ ...createMotion(3, { x: 250, y: 100 }), supportId: 'gone' }, 40, empty)
  expect(falling.falling).toBe(true)
  const calm = stepMotion(falling, 40, empty)
  const shaken = stepMotion(falling, 40, { ...empty, shakeId: 1 })
  expect(shaken.falling).toBe(true)
  expect(shaken.y).toBe(calm.y)
  expect(shaken.elapsed).toBe(calm.elapsed)
  expect(shaken.lastShakeId).toBe(1)
})

it('catches a fall on the lower id when two identical platforms overlap, in either order', () => {
  const tops = (ids: string[]): MotionSurfaces => ({ viewport: open, mascotSize: body,
    tickets: ids.map((id) => ({ id, x: 150, y: 250, width: 200, height: 40 })) })
  for (const ids of [['b', 'a'], ['a', 'b']]) {
    const start: State = { ...createMotion(3, { x: 250, y: 100 }), supportId: 'gone' }
    const landed = runUntil(tops(ids), start, (state) => state.supportId === 'a' || state.supportId === 'b', 40)
    expect(landed.supportId).toBe('a')
    expect(landed.y).toBe(250)
  }
})

it('resumes a resting climb that has no rest time left instead of stalling', () => {
  const ticket = board.tickets[0]!
  const resting: State = { ...createMotion(3, { x: 148, y: 222 }), action: 'climb', fromX: 148, fromY: 222,
    toX: 214, toY: 150, targetId: ticket.id, duration: 1000, elapsed: 400, progress: 0.4, resting: true }
  const next = stepMotion(resting, 100, board)
  expect(next.action).toBe('climb')
  expect(next.resting).toBe(false)
  expect(next.elapsed).toBe(500)
  expect(next.y).toBeLessThan(222)
})

it('ignores a degenerate remembered support rect and drops off a support too narrow to stand on', () => {
  const support = { id: 'a', x: 100, y: 200, width: 200, height: 40 }
  const standing: State = { ...createMotion(3, { x: 200, y: 200 }), supportId: 'a',
    supportRect: { ...support, x: 50, y: 100, width: 0 } }
  const kept = stepMotion(standing, 0, lone(support))
  expect([kept.x, kept.y, kept.supportId]).toEqual([200, 200, 'a'])
  const narrowed = stepMotion({ ...standing, supportRect: support }, 20, lone({ ...support, x: 180, width: 40 }))
  expect(narrowed.falling).toBe(true)
  expect(narrowed.supportId).toBeNull()
  expect(narrowed.x).toBe(200)
})

it('falls when a climb completes onto a card that rose above the head room', () => {
  const climbing: State = { ...createMotion(3, { x: 236, y: 70 }), action: 'climb', fromX: 154, fromY: 132,
    toX: 236, toY: 60, targetId: 'hi', duration: 1000, elapsed: 990, progress: 0.99 }
  const next = stepMotion(climbing, 20, lone({ id: 'hi', x: 180, y: 60, width: 200, height: 72 }))
  expect(next.falling).toBe(true)
  expect(next.supportId).toBeNull()
  expect(next.x).toBe(236)
  expect(next.y).toBeGreaterThan(60)
})

it('drops from a side jump whose grip side was panned off screen, keeping its facing', () => {
  const ticket = board.tickets[0]!
  const flight: State = { ...createMotion(3, { x: 148, y: 222 }), action: 'jump', fromX: 148, fromY: 320,
    toX: 148, toY: 222, targetId: ticket.id, targetRect: ticket, duration: 520, elapsed: 500, progress: 0.96,
    jumpHeight: 36, facing: 'left' }
  const next = stepMotion(flight, 40, { ...board, tickets: [{ ...ticket, x: 20 }] })
  expect(next.action).toBe('stumble')
  expect(next.falling).toBe(true)
  expect(next.facing).toBe('left')
  expect(next.x).toBe(32)
  expect(next.targetId).toBeNull()
})

it('never targets cards it cannot stand on or climb from an on-screen side', () => {
  const pin = lone({ id: 'pin', x: 200, y: 240, width: 40, height: 40, inProgress: true })
  const roof = { id: 'roof', x: 20, y: 150, width: 460, height: 72, inProgress: true }
  for (const surfaces of [pin, lone(roof), lone(roof, { freeRoam: true })]) {
    let state = createMotion(5, { x: 100, y: 320 })
    for (let frame = 0; frame < 1500; frame += 1) {
      state = stepMotion(state, 40, surfaces)
      expect(state.targetId ?? state.supportId).toBeNull()
    }
  }
})

it('stays on a full-width roof with no on-screen exit, even with active work below', () => {
  const surfaces: MotionSurfaces = { viewport: open, mascotSize: body, tickets: [
    { id: 'roof', x: 20, y: 150, width: 460, height: 72 },
    { id: 'desk', x: 100, y: 260, width: 150, height: 40, inProgress: true }] }
  let state: State = { ...createMotion(3, { x: 200, y: 150 }), supportId: 'roof' }
  const actions = new Set<string>()
  for (let frame = 0; frame < 1500; frame += 1) {
    state = stepMotion(state, 40, surfaces)
    actions.add(state.action)
    expect(state.supportId).toBe('roof')
    expect(state.descending).not.toBe(true)
  }
  expect(actions.has('walk')).toBe(true)
})

it('free-roams onto a reachable top without working and runs to a distant climbable card', () => {
  const top = lone({ id: 'top', x: 170, y: 230, width: 180, height: 50, inProgress: true }, { freeRoam: true })
  const onTop = runUntil(top, createMotion(6, { x: 260, y: 320 }), (state) => state.supportId === 'top', 1500)
  expect(onTop.supportId).toBe('top')
  expect(runUntil(top, onTop, (state) => Boolean(state.working), 500).working).not.toBe(true)
  const wide: MotionSurfaces = { viewport: { width: 900, height: 320 }, mascotSize: body, freeRoam: true,
    tickets: [{ id: 'tall', x: 700, y: 150, width: 120, height: 72 }] }
  const run = runUntil(wide, createMotion(1, { x: 40, y: 320 }), (state) => state.targetId === 'tall')
  expect(run.action).toBe('run')
  expect(run.toX).toBe(674)
})

it('runs along the floor to the grip side of a far active climbable card', () => {
  const far = lone({ id: 'far', x: 380, y: 150, width: 80, height: 100, inProgress: true })
  const approach = runUntil(far, createMotion(1, { x: 30, y: 320 }), (state) => state.targetId === 'far', 50)
  expect(approach.action).toBe('run')
  expect(approach.toX).toBe(354)
  expect(approach.toY).toBe(320)
})

it('climbs an active card hugging the left edge from its only on-screen side', () => {
  const edge = lone({ id: 'edge', x: 10, y: 150, width: 120, height: 100, inProgress: true })
  const worked = runUntil(edge, createMotion(1, { x: 400, y: 320 }), (state) => Boolean(state.working))
  expect(worked.supportId).toBe('edge')
  expect(worked.working).toBe(true)
})

it('picks the cheaper of two stepping stones to reach active work', () => {
  const surfaces: MotionSurfaces = { viewport: { width: 640, height: 600 }, mascotSize: { width: 64, height: 80 },
    tickets: [{ id: 'a', x: 60, y: 500, width: 160, height: 60 }, { id: 'b', x: 360, y: 500, width: 160, height: 60 },
      { id: 'top', x: 200, y: 400, width: 180, height: 60, inProgress: true }] }
  const worked = runUntil(surfaces, createMotion(2, { x: 300, y: 600 }), (state) => Boolean(state.working), 3000)
  expect(worked.supportId).toBe('top')
})

it('leaves active lower work for active higher work, and retargets when higher work starts', () => {
  const both = { ...tower, tickets: tower.tickets.map((ticket) => ({ ...ticket, inProgress: ticket.id !== 'middle' })) }
  let state: State = { ...createMotion(5, { x: 170, y: 480 }), supportId: 'low' }
  for (let frame = 0; frame < 3000 && !(state.working && state.supportId === 'high'); frame += 1) {
    state = stepMotion(state, 40, both)
    expect(Boolean(state.working) && state.supportId === 'low').toBe(false)
  }
  expect(state.supportId).toBe('high')
  const lowOnly = { ...tower, tickets: tower.tickets.map((ticket) => ({ ...ticket, inProgress: ticket.id === 'low' })) }
  const atLow = runUntil(lowOnly, createMotion(11, { x: 100, y: 600 }), (next) => Boolean(next.working))
  expect(atLow.supportId).toBe('low')
  expect(stepMotion(atLow, 40, lowOnly).working).toBe(true)
  const retargeted = stepMotion(atLow, 40, both)
  expect(retargeted.working).toBe(false)
  expect(retargeted.action).not.toBe('idle')
})

it('jumps off an unstandable sliver instead of leaping from it to higher work', () => {
  const surfaces: MotionSurfaces = { viewport: open, mascotSize: body, tickets: [
    { id: 'sliver', x: -150, y: 200, width: 170, height: 72 },
    { id: 'up', x: 60, y: 120, width: 200, height: 40, inProgress: true }] }
  const climbing: State = { ...createMotion(3, { x: 46, y: 210 }), action: 'climb', fromX: 46, fromY: 272,
    toX: -8, toY: 200, targetId: 'sliver', duration: 1000, elapsed: 960, progress: 0.96, facing: 'left' }
  const next = stepMotion(climbing, 40, surfaces)
  expect(next.action).toBe('jump')
  expect(next.descending).toBe(true)
  expect(next.targetId).toBeNull()
})

it('tracks a direct jump target panned mostly off screen while keeping the body on screen', () => {
  const old = { id: 'a', x: 80, y: 200, width: 180, height: 60 }
  const flight: State = { ...createMotion(5, { x: 150, y: 260 }), action: 'jump', fromX: 150, fromY: 320,
    toX: 170, toY: 200, targetId: 'a', targetRect: old, duration: 1000, elapsed: 500, progress: 0.5, jumpHeight: 70 }
  const next = stepMotion(flight, 20, lone({ ...old, x: -170 }))
  expect(next.action).toBe('jump')
  expect(next.toX).toBe(-80)
  expect(next.x).toBe(26)
})

it('abandons a floor approach whose grip no longer matches the resized body', () => {
  const ticket = board.tickets[0]!
  const approach: State = { ...createMotion(4, { x: 60, y: 320 }), action: 'walk', fromX: 60, fromY: 320,
    toX: 148, toY: 320, targetId: ticket.id, targetRect: ticket, duration: 1000 }
  expect(stepMotion(approach, 20, board).targetId).toBe(ticket.id)
  const resized = stepMotion(approach, 20, { ...board, mascotSize: body, tickets: [{ ...ticket, x: 200 }] })
  expect(resized.action).toBe('stumble')
  expect(resized.targetId).toBeNull()
})

it('treats an idle pause at a grip as a fresh decision, not a side jump, and does not drag it with a pan', () => {
  const ticket = board.tickets[0]!
  const free = { ...board, freeRoam: true }
  const atGrip = (action: 'idle' | 'walk', targetId: string | null): State => ({ ...createMotion(1, { x: 148, y: 320 }),
    action, fromX: 148, toX: 148, fromY: 320, toY: 320, targetId, targetRect: ticket, duration: 300 })
  const walked = stepMotion(atGrip('walk', ticket.id), 310, free)
  expect([walked.action, walked.targetId, walked.toY]).toEqual(['jump', ticket.id, 222])
  const paused = stepMotion(atGrip('idle', ticket.id), 310, free)
  const { targetRect: _ignored, ...plain } = stepMotion(atGrip('idle', null), 310, free)
  expect(paused).toEqual({ ...plain, targetRect: undefined })
  expect(paused.action).toBe('run')
  const panned = stepMotion(atGrip('idle', ticket.id), 20, { ...free, tickets: [{ ...ticket, x: 220 }] })
  expect(panned.action).toBe('stumble')
  expect(panned.x).toBe(148)
  expect(panned.targetId).toBeNull()
})
