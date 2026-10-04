export type MotionAction = 'idle' | 'walk' | 'run' | 'jump' | 'climb' | 'stumble'
export type MotionFacing = 'left' | 'right'

export interface MotionRect {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface MotionSurfaces {
  viewport: { width: number; height: number }
  mascotSize: { width: number; height: number }
  tickets: MotionRect[]
}

/** `x` is the sprite center and `y` is the feet line, both in CSS pixels. */
export interface MotionState {
  x: number
  y: number
  facing: MotionFacing
  action: MotionAction
  /** Normalized action progress; jump reserves its ends for crouch and landing frames. */
  progress: number
  randomState: number
  elapsed: number
  duration: number
  fromX: number
  fromY: number
  toX: number
  toY: number
  jumpHeight: number
  targetId: string | null
  /** Ticket whose top currently supports the feet; null means the viewport floor. */
  supportId: string | null
}

const finite = (value: number, fallback = 0): number => Number.isFinite(value) ? value : fallback
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))
const MIN_SIDE_JUMP_REACH = 120
const TOP_JUMP_REACH = 120

function sideOf(ticket: MotionRect, x: number, half: number): MotionFacing | null {
  if (Math.abs(x - (ticket.x - half)) < 1) return 'right'
  if (Math.abs(x - (ticket.x + ticket.width + half)) < 1) return 'left'
  return null
}

function canClimb(ticket: MotionRect, metrics: ReturnType<typeof dimensions>): boolean {
  const { floor, bodyHeight, half, sideJumpReach } = metrics
  const bottom = ticket.y + ticket.height
  return ticket.width >= half * 2 + 4 && ticket.y >= bodyHeight &&
    bottom < floor - 1 && bottom >= floor - sideJumpReach
}

function sideJump(state: MotionState, ticket: MotionRect): MotionState {
  return action({ ...state, supportId: null }, {
    kind: 'jump', x: state.x, y: ticket.y + ticket.height,
    duration: 520, targetId: ticket.id, jumpHeight: 36
  })
}

function climb(state: MotionState, ticket: MotionRect, half: number): MotionState {
  const facing = sideOf(ticket, state.x, half)
  const landingX = facing === 'right' ? ticket.x + half + 2 : ticket.x + ticket.width - half - 2
  const next = action(state, {
    kind: 'climb', x: landingX, y: ticket.y,
    duration: Math.max(450, (state.y - ticket.y) / 95 * 1000), targetId: ticket.id
  })
  return { ...next, facing: facing ?? state.facing }
}

function random(state: MotionState): [number, number] {
  let seed = state.randomState | 0
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  seed |= 0
  return [((seed >>> 0) % 1_000_000) / 1_000_000, seed]
}

function nextRandom(state: MotionState): MotionState {
  const [, randomState] = random(state)
  return { ...state, randomState }
}

function dimensions(surfaces: MotionSurfaces) {
  const width = Math.max(0, finite(surfaces.viewport.width))
  const height = Math.max(0, finite(surfaces.viewport.height))
  const bodyWidth = Math.max(0, finite(surfaces.mascotSize.width))
  const bodyHeight = Math.max(0, finite(surfaces.mascotSize.height))
  const half = Math.min(width / 2, bodyWidth / 2)
  return {
    width, height, bodyWidth, bodyHeight, half,
    floor: Math.min(height, Math.max(bodyHeight, height)),
    sideJumpReach: Math.max(MIN_SIDE_JUMP_REACH, height * 0.55)
  }
}

function cleanTickets(surfaces: MotionSurfaces) {
  return surfaces.tickets.filter((ticket) =>
    [ticket.x, ticket.y, ticket.width, ticket.height].every(Number.isFinite) &&
    ticket.width > 0 && ticket.height > 0
  )
}

function safePoint(x: number, y: number, surfaces: MotionSurfaces) {
  const { width, height, half, bodyHeight } = dimensions(surfaces)
  return {
    x: clamp(finite(x, width / 2), half, Math.max(half, width - half)),
    y: clamp(finite(y, height), Math.min(height, bodyHeight), height)
  }
}

interface ActionSpec {
  kind: MotionAction
  x: number
  y: number
  duration: number
  targetId?: string | null
  jumpHeight?: number
}

function action(state: MotionState, spec: ActionSpec): MotionState {
  const point = { x: finite(spec.x, state.x), y: finite(spec.y, state.y) }
  const face = point.x < state.x ? 'left' : point.x > state.x ? 'right' : state.facing
  return {
    ...state,
    action: spec.kind,
    elapsed: 0,
    duration: Math.max(1, finite(spec.duration, 1)),
    fromX: state.x,
    fromY: state.y,
    toX: point.x,
    toY: point.y,
    targetId: spec.targetId ?? null,
    jumpHeight: Math.max(0, finite(spec.jumpHeight ?? 0)),
    facing: face,
    progress: 0
  }
}

function visibleTickets(surfaces: MotionSurfaces): MotionRect[] {
  const { width, height, bodyHeight } = dimensions(surfaces)
  return cleanTickets(surfaces).filter((ticket) =>
    ticket.y >= bodyHeight && ticket.y <= height && ticket.x + ticket.width >= 0 && ticket.x <= width
  )
}

function chooseClimbRoute(state: MotionState, tickets: MotionRect[], surfaces: MotionSurfaces): [MotionState | null, MotionState] {
  const metrics = dimensions(surfaces)
  const { width, half } = metrics
  const [pick, seed] = random(state)
  const s = { ...state, randomState: seed }
  const ticket = tickets[Math.floor(pick * tickets.length)]!
  if (!canClimb(ticket, metrics)) return [null, s]
  const sideX = [ticket.x - half, ticket.x + ticket.width + half]
    .filter((side) => side >= half && side <= width - half)
    .sort((a, b) => Math.abs(s.x - a) - Math.abs(s.x - b))[0]
  if (sideX === undefined) return [null, s]
  if (Math.abs(s.x - sideX) <= 1) return [sideJump(s, ticket), s]
  const route = action(s, {
    kind: Math.abs(s.x - sideX) > width * 0.55 ? 'run' : 'walk',
    x: sideX, y: s.y, duration: Math.abs(s.x - sideX) / 110 * 1000,
    targetId: ticket.id
  })
  return [route, s]
}

function roamX(state: MotionState, support: MotionRect | undefined, surfaces: MotionSurfaces): [number, MotionState] {
  const { width, half } = dimensions(surfaces)
  const [directionDraw, directionSeed] = random(state)
  const [distanceDraw, distanceSeed] = random({ ...state, randomState: directionSeed })
  const direction = directionDraw < 0.5 ? -1 : 1
  const distance = Math.max(24, width * (0.16 + distanceDraw * 0.34))
  const rightEdge = Math.max(half, width - half)
  const minimumX = support ? clamp(support.x + half, half, rightEdge) : half
  const maximumX = support ? clamp(support.x + support.width - half, minimumX, rightEdge) : rightEdge
  return [clamp(state.x + direction * distance, minimumX, maximumX), { ...state, randomState: distanceSeed }]
}

function jumpDestination(state: MotionState, tickets: MotionRect[], support: MotionRect | undefined,
  surfaces: MotionSurfaces): [MotionRect | null, MotionState] {
  if (tickets.length === 0) return [null, state]
  const [pick, seed] = random(state)
  const s = { ...state, randomState: seed }
  const ticket = tickets[Math.floor(pick * tickets.length)]!
  return [canJumpTop(state, ticket, support, surfaces) ? ticket : null, s]
}

function canJumpTop(state: MotionState, ticket: MotionRect, support: MotionRect | undefined,
  surfaces: MotionSurfaces): boolean {
  const { width, half, floor } = dimensions(surfaces)
  const center = clamp(ticket.x + ticket.width / 2, half, Math.max(half, width - half))
  const rise = (support?.y ?? floor) - ticket.y
  return ticket.id !== support?.id && rise > 8 && rise <= TOP_JUMP_REACH &&
    ticket.width >= half * 2 + 4 && Math.abs(center - state.x) <= 180
}

interface RoamContext { support: MotionRect | undefined; tickets: MotionRect[]; surfaces: MotionSurfaces }
interface Destination { state: MotionState; x: number; y: number; targetId: string | null }

function offCardX(state: MotionState, support: MotionRect, surfaces: MotionSurfaces): number | null {
  const { width, half } = dimensions(surfaces)
  return [support.x - half, support.x + support.width + half]
    .filter((x) => x >= half && x <= width - half)
    .sort((a, b) => Math.abs(state.x - a) - Math.abs(state.x - b))[0] ?? null
}

function jumpRoute(state: MotionState, roamTargetX: number, context: RoamContext): Destination {
  const { support, tickets, surfaces } = context
  const { width, half, floor } = dimensions(surfaces)
  const [ticket, s] = jumpDestination(state, tickets, support, surfaces)
  if (ticket) return {
    state: s, x: clamp(ticket.x + ticket.width / 2, half, Math.max(half, width - half)),
    y: ticket.y, targetId: ticket.id
  }
  const exit = support ? offCardX(s, support, surfaces) : null
  if (support && exit === null) return { state: s, x: s.x, y: support.y, targetId: support.id }
  return { state: s, x: exit ?? roamTargetX, y: floor, targetId: null }
}

function travelAction(kind: 'walk' | 'run' | 'jump', destination: Destination,
  support: MotionRect | undefined): MotionState {
  const { state: s, x, y, targetId } = destination
  const travel = Math.abs(x - s.x) + Math.abs(y - s.y)
  if (x === s.x && y === s.y) return action(s, { kind: 'idle', x: s.x, y: s.y, duration: 450 })
  return action({ ...s, supportId: kind === 'jump' ? null : support?.id ?? null }, {
    kind, x, y, duration: Math.max(280, travel / (kind === 'run' ? 210 : 120) * 1000),
    targetId, jumpHeight: kind === 'jump' ? Math.max(42, Math.min(128, travel * 0.36)) : 0
  })
}

function roam(state: MotionState, kind: 'walk' | 'run' | 'jump', context: RoamContext): MotionState {
  const { support, surfaces } = context
  const [roamTargetX, afterDirection] = roamX(state, support, surfaces)
  const destination = kind === 'jump' ? jumpRoute(afterDirection, roamTargetX, context) : {
    state: afterDirection, x: roamTargetX,
    y: support?.y ?? dimensions(surfaces).floor, targetId: null
  }
  return travelAction(kind, destination, support)
}

function chosenKind(choice: number): 'walk' | 'run' | 'jump' {
  if (choice < 0.51 || choice >= 0.84) return 'walk'
  return choice < 0.69 ? 'run' : 'jump'
}

function chooseAction(state: MotionState, choice: number, context: RoamContext): MotionState {
  let s = state
  if (choice < 0.14) return action(s, { kind: 'idle', x: s.x, y: s.y, duration: 350 + choice * 2400 })
  if (choice < 0.22) return action(s, { kind: 'stumble', x: s.x, y: s.y, duration: 500 + choice * 500 })
  if (choice >= 0.84 && !context.support && context.tickets.length > 0) {
    const [route, afterPick] = chooseClimbRoute(s, context.tickets, context.surfaces)
    if (route) return route
    s = afterPick
  }
  return roam(s, chosenKind(choice), context)
}

function nextAction(state: MotionState, surfaces: MotionSurfaces): MotionState {
  const { width, height, half, floor } = dimensions(surfaces)
  const tickets = visibleTickets(surfaces)
  const s = nextRandom(state)
  const support = state.supportId ? tickets.find((ticket) => ticket.id === state.supportId) : undefined
  if (state.supportId && !support) return action({ ...s, supportId: null }, { kind: 'stumble', x: s.x, y: floor, duration: 520 })
  const [choice, seed] = random(s)
  const ready = { ...s, randomState: seed }
  if (width <= 0 || height <= 0 || tickets.length === 0 && width <= half * 2) {
    const point = safePoint(ready.x, height, surfaces)
    return action({ ...ready, ...point }, { kind: 'idle', ...point, duration: 700 })
  }
  return chooseAction(ready, choice, { support, tickets, surfaces })
}

export function createMotion(seed: number, initial: { x: number; y: number } = { x: 0, y: 0 }): MotionState {
  const randomState = (Math.floor(finite(seed)) | 0) || 0x6d2b79f5
  const x = finite(initial.x)
  const y = finite(initial.y)
  return {
    x, y, facing: 'right', action: 'idle', progress: 0,
    randomState, elapsed: 0, duration: 650,
    fromX: x, fromY: y, toX: x, toY: y, jumpHeight: 0, targetId: null, supportId: null
  }
}

function supported(state: MotionState, surfaces: MotionSurfaces): boolean {
  if (!state.supportId || state.action === 'jump' || state.action === 'climb') return true
  const support = cleanTickets(surfaces).find((item) => item.id === state.supportId)
  if (!support) return false
  const half = dimensions(surfaces).half
  return Math.abs(state.y - support.y) <= 1 &&
    state.x >= support.x + half && state.x <= support.x + support.width - half &&
    state.toX >= support.x + half && state.toX <= support.x + support.width - half
}

function sideJumpValid(state: MotionState, ticket: MotionRect, surfaces: MotionSurfaces): boolean {
  const metrics = dimensions(surfaces)
  const { half, floor } = metrics
  return sideOf(ticket, state.toX, half) !== null &&
    Math.abs(ticket.y + ticket.height - state.toY) < 1 &&
    Math.abs(state.fromY - floor) < 1 && canClimb(ticket, metrics)
}

function topJumpValid(state: MotionState, ticket: MotionRect, surfaces: MotionSurfaces): boolean {
  const { half } = dimensions(surfaces)
  return Math.abs(ticket.y - state.toY) < 1 &&
    state.toX >= ticket.x + half - 1 && state.toX <= ticket.x + ticket.width - half + 1 &&
    state.fromY - ticket.y <= TOP_JUMP_REACH
}

function targetValid(state: MotionState, surfaces: MotionSurfaces): boolean {
  if (!state.targetId) return true
  const ticket = cleanTickets(surfaces).find((item) => item.id === state.targetId)
  if (!ticket) return false
  if (state.action === 'jump') return sideJumpValid(state, ticket, surfaces) || topJumpValid(state, ticket, surfaces)
  if (state.action === 'climb') return climbTargetValid(state, ticket, surfaces)
  return approachTargetValid(state, ticket, surfaces)
}

function climbTargetValid(state: MotionState, ticket: MotionRect, surfaces: MotionSurfaces): boolean {
  const metrics = dimensions(surfaces)
  const { half } = metrics
  return sideOf(ticket, state.fromX, half) !== null &&
    canClimb(ticket, metrics) && Math.abs(ticket.y - state.toY) < 1 &&
    Math.abs(state.fromY - (ticket.y + ticket.height)) < 1
}

function approachTargetValid(state: MotionState, ticket: MotionRect, surfaces: MotionSurfaces): boolean {
  const metrics = dimensions(surfaces)
  const { half, floor } = metrics
  return sideOf(ticket, state.toX, half) !== null &&
    canClimb(ticket, metrics) && Math.abs(state.toY - floor) < 1
}

function smoothstep(t: number): number { return t * t * (3 - 2 * t) }

function motionPoint(state: MotionState, t: number, surfaces: MotionSurfaces): { x: number; y: number } {
  let x = state.fromX + (state.toX - state.fromX) * smoothstep(t)
  let y = state.fromY + (state.toY - state.fromY) * smoothstep(t)
  if (state.action === 'climb') {
    x = state.fromX + (state.toX - state.fromX) * smoothstep(clamp((t - 0.78) / 0.22, 0, 1))
    y = state.fromY + (state.toY - state.fromY) * smoothstep(clamp(t / 0.78, 0, 1))
  }
  if (state.action === 'jump') {
    const flight = clamp((t - 0.14) / 0.72, 0, 1)
    const lateral = state.toY > state.fromY ? clamp(flight / 0.5, 0, 1) : flight
    x = state.fromX + (state.toX - state.fromX) * smoothstep(lateral)
    y = state.fromY + (state.toY - state.fromY) * smoothstep(flight) -
      Math.sin(Math.PI * flight) * state.jumpHeight
  }
  return safePoint(x, y, surfaces)
}

function completedAction(state: MotionState, surfaces: MotionSurfaces): MotionState {
  const ticket = state.targetId ? cleanTickets(surfaces).find((item) => item.id === state.targetId) : undefined
  if (ticket && state.action === 'climb') {
    return nextAction({ ...state, y: ticket.y, targetId: null, supportId: ticket.id }, surfaces)
  }
  if (ticket && state.action === 'jump') {
    if (sideOf(ticket, state.toX, dimensions(surfaces).half)) return climb(state, ticket, dimensions(surfaces).half)
    return nextAction({ ...state, targetId: null, supportId: ticket.id }, surfaces)
  }
  if (ticket && (state.action === 'walk' || state.action === 'run')) return sideJump(state, ticket)
  return nextAction(state, surfaces)
}

function prepareState(previous: MotionState, surfaces: MotionSurfaces): MotionState {
  const safe = safePoint(previous.x, previous.y, surfaces)
  const state: MotionState = {
    ...previous,
    ...safe,
    elapsed: Math.max(0, finite(previous.elapsed)),
    duration: Math.max(1, finite(previous.duration, 1)),
    randomState: previous.randomState | 0,
    progress: clamp(finite(previous.progress), 0, 1)
  }
  if (!state.supportId && (state.action === 'idle' || state.action === 'walk' || state.action === 'run')) {
    const floor = dimensions(surfaces).floor
    return { ...state, y: floor, fromY: floor, toY: floor }
  }
  return state
}

function advanceSequence(initial: MotionState, deltaMs: number, surfaces: MotionSurfaces): MotionState {
  let state = initial
  let remaining = clamp(finite(deltaMs), 0, 120_000)
  let transitions = 0
  while (remaining > 0 && transitions < 1024) {
    if (!supported(state, surfaces) || !targetValid(state, surfaces)) {
      state = action({ ...state, targetId: null, supportId: null }, {
        kind: 'stumble', x: state.x, y: dimensions(surfaces).floor, duration: 520
      })
      transitions += 1
      continue
    }
    const left = Math.max(0, state.duration - state.elapsed)
    const consumed = Math.min(left, remaining)
    state = { ...state, elapsed: state.elapsed + consumed }
    remaining -= consumed
    const t = clamp(state.elapsed / state.duration, 0, 1)
    state = { ...state, ...motionPoint(state, t, surfaces), progress: t }
    if (t >= 1) {
      state = completedAction(state, surfaces)
      transitions += 1
    }
  }
  const point = safePoint(state.x, state.y, surfaces)
  if (remaining > 0) state = action({ ...state, ...point }, { kind: 'idle', ...point, duration: 650 })
  return { ...state, ...point, progress: clamp(finite(state.progress), 0, 1) }
}

/** Advances seeded motion in CSS pixels. The mascot's full body stays within the viewport. */
export function stepMotion(previous: MotionState, deltaMs: number, surfaces: MotionSurfaces): MotionState {
  const state = prepareState(previous, surfaces)
  if (surfaces.viewport.width <= 0 || surfaces.viewport.height <= 0) {
    const point = safePoint(state.x, state.y, surfaces)
    return { ...action(state, { kind: 'idle', ...point, duration: 650 }), progress: 0, targetId: null }
  }
  return advanceSequence(state, deltaMs, surfaces)
}
