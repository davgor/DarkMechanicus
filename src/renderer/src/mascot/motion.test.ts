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

  it('abandons a side jump or climb if the target card moves', () => {
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
    expect(stepMotion(sideJump!, 40, moved).action).toBe('stumble')
    expect(stepMotion(climb!, 40, moved).action).toBe('stumble')
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

  it('abandons a side approach safely when its ticket moves or disappears', () => {
    const approach = findApproach()
    const moved = { ...board, tickets: [{ ...board.tickets[0]!, x: 260 }] }
    const afterMove = stepMotion(approach, 40, moved)
    expect(afterMove.action).toBe('stumble')
    expect([afterMove.x, afterMove.y, afterMove.progress].every(Number.isFinite)).toBe(true)

    const afterRemoval = stepMotion(approach, 40, { ...board, tickets: [] })
    expect(afterRemoval.action).toBe('stumble')
    expect(afterRemoval.x).toBeGreaterThanOrEqual(0)
    expect(afterRemoval.y).toBeLessThanOrEqual(board.viewport.height)
  })

  it('leaves a ticket top safely when that supporting card moves or disappears', () => {
    const supported = findTicketSupport()
    const moved = { ...board, tickets: [{ ...board.tickets[0]!, y: 140 }] }
    const afterMove = stepMotion(supported, 40, moved)
    expect(afterMove.action).toBe('stumble')
    expect(afterMove.supportId).toBeNull()

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

  it('recovers when a moved top no longer lies under the feet', () => {
    let state = findTicketSupport()
    for (let i = 0; i < 500 && state.action !== 'walk'; i += 1) state = stepMotion(state, 20, board)
    expect(state.action).toBe('walk')
    expect(state.supportId).toBe('ticket-a')
    const moved = { ...board, tickets: [{ ...board.tickets[0]!, x: state.x + 16 }] }
    const after = stepMotion(state, 40, moved)
    expect(after.action).toBe('stumble')
    expect(after.supportId).toBeNull()
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
