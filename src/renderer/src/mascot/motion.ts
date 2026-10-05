export type MotionAction = 'idle' | 'walk' | 'run' | 'jump' | 'climb' | 'stumble'
export type MotionFacing = 'left' | 'right'

export interface MotionRect {
  id: string
  x: number
  y: number
  width: number
  height: number
  inProgress?: boolean
}

export interface MotionSurfaces {
  viewport: { width: number; height: number }
  mascotSize: { width: number; height: number }
  tickets: MotionRect[]
  shakeId?: number
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
  working?: boolean
  resting?: boolean
  falling?: boolean
  lastShakeId?: number
  supportRect?: MotionRect
  targetRect?: MotionRect
  restAt?: number
  restRemaining?: number
  slipAt?: number
  descending?: boolean
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
  return ascentVariation(action({ ...state, supportId: null }, {
    kind: 'jump', x: state.x, y: ticket.y + ticket.height,
    duration: 520, targetId: ticket.id, jumpHeight: 36
  }))
}

function climb(state: MotionState, ticket: MotionRect, half: number): MotionState {
  const facing = sideOf(ticket, state.x, half)
  const landingX = facing === 'right' ? ticket.x + half + 2 : ticket.x + ticket.width - half - 2
  const next = action(state, {
    kind: 'climb', x: landingX, y: ticket.y,
    duration: Math.max(450, (state.y - ticket.y) / 95 * 1000), targetId: ticket.id
  })
  return ascentVariation({ ...next, facing: facing ?? state.facing })
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

function ascentVariation(state: MotionState): MotionState {
  const [restDraw, seed1] = random(state)
  const [slipDraw, seed2] = random({ ...state, randomState: seed1 })
  const [timing, seed3] = random({ ...state, randomState: seed2 })
  return { ...state, randomState: seed3,
    restAt: state.action === 'climb' && restDraw < 0.28 ? 0.22 + timing * 0.34 : undefined,
    slipAt: slipDraw < 0.14 ? 0.52 + timing * 0.23 : undefined }
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
    progress: 0,
    working: false, resting: false, falling: false, descending: false,
    restAt: undefined, restRemaining: undefined, slipAt: undefined
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

function routeEdge(from: MotionRect | undefined, to: MotionRect, surfaces: MotionSurfaces): boolean {
  const { floor, half, width } = dimensions(surfaces)
  if (to.width < half * 2 + 4) return false
  const target = landingInterval(to, half, width)
  if (!target) return false
  const sourceY = from?.y ?? floor
  const rise = sourceY - to.y
  if (rise <= 8) return false
  if (!from) return rise <= TOP_JUMP_REACH || floorClimbRoute(to, surfaces)
  if (rise > TOP_JUMP_REACH) return false
  const source = landingInterval(from, half, width)
  return source ? intervalsReach(source, target) : false
}

function intervalsReach(source: { min: number; max: number }, target: { min: number; max: number }): boolean {
  return target.min - source.max <= 180 && source.min - target.max <= 180
}

function landingInterval(ticket: MotionRect, half: number, width: number): { min: number; max: number } | null {
  const min = Math.max(half, ticket.x + half)
  const max = Math.min(width - half, ticket.x + ticket.width - half)
  return min <= max ? { min, max } : null
}

function floorClimbRoute(ticket: MotionRect, surfaces: MotionSurfaces): boolean {
  const { half, width } = dimensions(surfaces)
  return canClimb(ticket, dimensions(surfaces)) &&
    (ticket.x - half >= half || ticket.x + ticket.width + half <= width - half)
}

interface Route { support: MotionRect | undefined; path: MotionRect[]; cost: number }

function candidateRoute(current: Route, ticket: MotionRect, best: Map<string, Route>,
  surfaces: MotionSurfaces): Route | null {
  if (!routeEdge(current.support, ticket, surfaces)) return null
  const cost = current.cost + routeCost(current.support, ticket, surfaces)
  if (cost >= (best.get(ticket.id)?.cost ?? Number.POSITIVE_INFINITY)) return null
  return { support: ticket, path: [...current.path, ticket], cost }
}

function staleRoute(route: Route, best: Map<string, Route>): boolean {
  return Boolean(route.support && best.get(route.support.id) !== route)
}

function routeCost(from: MotionRect | undefined, to: MotionRect, surfaces: MotionSurfaces): number {
  const rise = (from?.y ?? dimensions(surfaces).floor) - to.y
  return !from && rise > TOP_JUMP_REACH ? 1 + (rise - TOP_JUMP_REACH) / 80 : 1
}

function reachableRoutes(state: MotionState, tickets: MotionRect[], surfaces: MotionSurfaces): Route[] {
  const start = state.supportId ? tickets.find((ticket) => ticket.id === state.supportId) : undefined
  const queue: Route[] = [{ support: start, path: [], cost: 0 }]
  const best = new Map<string, Route>()
  if (start) best.set(start.id, queue[0]!)
  while (queue.length > 0) {
    queue.sort((a, b) => a.cost - b.cost)
    const current = queue.shift()!
    if (staleRoute(current, best)) continue
    for (const ticket of tickets) {
      const route = candidateRoute(current, ticket, best, surfaces)
      if (!route) continue
      best.set(ticket.id, route)
      queue.push(route)
    }
  }
  if (start) best.delete(start.id)
  return [...best.values()]
}

function routeToGoal(state: MotionState, tickets: MotionRect[], surfaces: MotionSurfaces): MotionRect[] {
  const routes = reachableRoutes(state, tickets, surfaces)
  const active = routes.filter((route) => route.support?.inProgress)
  const candidates = active.length > 0 ? active : routes
  candidates.sort((a, b) => a.support!.y - b.support!.y || a.cost - b.cost ||
    a.support!.id.localeCompare(b.support!.id))
  return candidates[0]?.path ?? []
}

function groundClimbAction(state: MotionState, ticket: MotionRect, surfaces: MotionSurfaces): MotionState | null {
  const { half, width, floor } = dimensions(surfaces)
  const sides = [ticket.x - half, ticket.x + ticket.width + half]
    .filter((x) => x >= half && x <= width - half)
    .sort((a, b) => Math.abs(a - state.x) - Math.abs(b - state.x))
  const sideX = sides[0]
  if (sideX === undefined) return null
  if (Math.abs(state.x - sideX) <= 1) return sideJump(state, ticket)
  return action(state, { kind: Math.abs(state.x - sideX) > width * 0.55 ? 'run' : 'walk',
    x: sideX, y: floor, duration: Math.max(280, Math.abs(state.x - sideX) / 110 * 1000),
    targetId: ticket.id })
}

function jumpLandingX(ticket: MotionRect, source: MotionRect | undefined, half: number, width: number): number {
  const targetInterval = landingInterval(ticket, half, width)!
  const sourceInterval = source ? landingInterval(source, half, width) : null
  return clamp(ticket.x + ticket.width / 2,
    Math.max(targetInterval.min, (sourceInterval?.min ?? half) - 180),
    Math.min(targetInterval.max, (sourceInterval?.max ?? width - half) + 180))
}

function topJumpAction(state: MotionState, ticket: MotionRect, support: MotionRect | undefined,
  surfaces: MotionSurfaces): MotionState {
  const { half, width, floor } = dimensions(surfaces)
  const sourceY = support?.y ?? floor
  const targetX = jumpLandingX(ticket, support, half, width)
  const launchX = support
    ? clamp(targetX, landingInterval(support, half, width)!.min, landingInterval(support, half, width)!.max)
    : clamp(targetX, state.x - 180, state.x + 180)
  if (Math.abs(state.x - launchX) > 2) {
    return action(state, { kind: Math.abs(state.x - launchX) > 150 ? 'run' : 'walk',
      x: launchX, y: sourceY, duration: Math.max(280, Math.abs(state.x - launchX) / 120 * 1000),
      targetId: null })
  }
  return ascentVariation(action({ ...state, supportId: null }, { kind: 'jump', x: targetX, y: ticket.y,
    duration: 640, targetId: ticket.id, jumpHeight: Math.max(56, sourceY - ticket.y) }))
}

function descentAction(state: MotionState, support: MotionRect, goal: MotionRect,
  surfaces: MotionSurfaces): MotionState | null {
  const { width, half } = dimensions(surfaces)
  const exits = [support.x - half, support.x + support.width + half]
    .filter((x) => x >= half && x <= width - half)
    .sort((a, b) => Math.abs(a - (goal.x + goal.width / 2)) -
      Math.abs(b - (goal.x + goal.width / 2)))
  const exitX = exits[0]
  if (exitX === undefined) return null
  return { ...action({ ...state, supportId: null }, {
    kind: 'jump', x: exitX, y: state.y, duration: 420,
    jumpHeight: 24
  }), descending: true }
}

function guidedAction(state: MotionState, support: MotionRect | undefined, tickets: MotionRect[],
  surfaces: MotionSurfaces): MotionState | null {
  const path = routeToGoal(state, tickets, surfaces)
  const descentGoal = support ? goalBelow(state, { support, path, tickets, surfaces }) : undefined
  if (support && descentGoal) return descentAction(state, support, descentGoal, surfaces)
  if (support?.inProgress && !higherActive(path, support)) {
    const [draw, seed] = random(state)
    return { ...action({ ...state, randomState: seed }, {
      kind: 'idle', x: state.x, y: state.y, duration: 1300 + draw * 1600
    }), working: true, supportId: support.id }
  }
  const ticket = path[0]
  if (!ticket) return null
  if (!support && dimensions(surfaces).floor - ticket.y > TOP_JUMP_REACH) {
    return groundClimbAction(state, ticket, surfaces)
  }
  return topJumpAction(state, ticket, support, surfaces)
}

function higherActive(path: MotionRect[], support: MotionRect): boolean {
  const goal = path.at(-1)
  return Boolean(goal?.inProgress && goal.y < support.y)
}

function goalBelow(state: MotionState, context: { support: MotionRect; path: MotionRect[];
  tickets: MotionRect[]; surfaces: MotionSurfaces }): MotionRect | undefined {
  const globalGoal = routeToGoal({ ...state, supportId: null }, context.tickets, context.surfaces).at(-1)
  const localGoal = context.path.at(-1)
  if (!globalGoal?.inProgress || globalGoal.id === context.support.id) return undefined
  return !localGoal?.inProgress || globalGoal.y < localGoal.y ? globalGoal : undefined
}

function nextAction(state: MotionState, surfaces: MotionSurfaces): MotionState {
  const { width, height, half } = dimensions(surfaces)
  const tickets = visibleTickets(surfaces)
  const s = nextRandom(state)
  const support = state.supportId ? tickets.find((ticket) => ticket.id === state.supportId) : undefined
  if (state.supportId && !support) return startFall(s, surfaces)
  const [choice, seed] = random(s)
  const ready = { ...s, randomState: seed }
  if (width <= 0 || height <= 0 || tickets.length === 0 && width <= half * 2) {
    const point = safePoint(ready.x, height, surfaces)
    return action({ ...ready, ...point }, { kind: 'idle', ...point, duration: 700 })
  }
  const [guideDraw, guideSeed] = random(ready)
  if (guideDraw < 0.88) {
    const guided = guidedAction({ ...ready, randomState: guideSeed }, support, tickets, surfaces)
    if (guided) return guided
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
  const { half } = dimensions(surfaces)
  return sideOf(ticket, state.toX, half) !== null &&
    Math.abs(ticket.y + ticket.height - state.toY) < 1 &&
    ticket.width >= half * 2 + 4
}

function topJumpValid(state: MotionState, ticket: MotionRect, surfaces: MotionSurfaces): boolean {
  const { half } = dimensions(surfaces)
  return Math.abs(ticket.y - state.toY) < 1 &&
    state.toX >= ticket.x + half - 1 && state.toX <= ticket.x + ticket.width - half + 1
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
  const { half } = dimensions(surfaces)
  return sideOf(ticket, state.fromX, half) !== null &&
    ticket.width >= half * 2 + 4 && Math.abs(ticket.y - state.toY) < 1 &&
    Math.abs(state.fromY - (ticket.y + ticket.height)) < 1
}

function approachTargetValid(state: MotionState, ticket: MotionRect, surfaces: MotionSurfaces): boolean {
  const { half, floor } = dimensions(surfaces)
  return sideOf(ticket, state.toX, half) !== null &&
    ticket.width >= half * 2 + 4 && Math.abs(state.toY - floor) < 1
}

function smoothstep(t: number): number { return t * t * (3 - 2 * t) }

const FALL_ACCELERATION = 1300

function startFall(state: MotionState, surfaces: MotionSurfaces): MotionState {
  const floor = dimensions(surfaces).floor
  if (floor - state.y <= 1) return action({ ...state, supportId: null, targetId: null }, {
    kind: 'stumble', x: state.x, y: floor, duration: 480
  })
  const distance = Math.max(1, floor - state.y)
  return { ...action({ ...state, supportId: null, targetId: null }, {
    kind: 'stumble', x: state.x, y: floor,
    duration: Math.sqrt(2 * distance / FALL_ACCELERATION) * 1000
  }), falling: true }
}

function landingBetween(state: MotionState, nextY: number, surfaces: MotionSurfaces): MotionRect | undefined {
  const half = dimensions(surfaces).half
  return visibleTickets(surfaces)
    .filter((ticket) => ticket.y > state.y + 0.01 && ticket.y <= nextY + 0.01 &&
      state.x >= ticket.x + half && state.x <= ticket.x + ticket.width - half)
    .sort((a, b) => a.y - b.y || a.id.localeCompare(b.id))[0]
}

function land(state: MotionState, ticket: MotionRect | undefined, surfaces: MotionSurfaces): MotionState {
  const y = ticket?.y ?? dimensions(surfaces).floor
  const grounded = { ...state, y, supportId: ticket?.id ?? null, falling: false }
  return { ...action(grounded, { kind: 'stumble', x: grounded.x, y, duration: 480 }),
    supportId: grounded.supportId }
}

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

function completedTicketAction(state: MotionState, ticket: MotionRect, surfaces: MotionSurfaces): MotionState {
  if (state.action === 'climb') {
    return nextAction({ ...state, y: ticket.y, targetId: null, supportId: ticket.id }, surfaces)
  }
  if (state.action === 'jump') {
    if (sideOf(ticket, state.toX, dimensions(surfaces).half)) return climb(state, ticket, dimensions(surfaces).half)
    return nextAction({ ...state, targetId: null, supportId: ticket.id }, surfaces)
  }
  if (state.action === 'walk' || state.action === 'run') return sideJump(state, ticket)
  return nextAction(state, surfaces)
}

function completedAction(state: MotionState, surfaces: MotionSurfaces): MotionState {
  if (state.falling) return land(state, undefined, surfaces)
  if (state.descending) return startFall(state, surfaces)
  if (state.working) return action(state, { kind: 'idle', x: state.x, y: state.y, duration: 480 })
  const ticket = state.targetId ? cleanTickets(surfaces).find((item) => item.id === state.targetId) : undefined
  return ticket ? completedTicketAction(state, ticket, surfaces) : nextAction(state, surfaces)
}

function rebaseOnRect(state: MotionState, oldRect: MotionRect, rect: MotionRect,
  surfaces: MotionSurfaces): MotionState {
  const scale = rect.width / oldRect.width
  if (!Number.isFinite(scale) || scale <= 0) return state
  const mapX = (value: number): number => rect.x + (value - oldRect.x) * scale
  const mapY = (value: number): number => rect.y + (value - oldRect.y) * scale
  const point = safePoint(mapX(state.x), mapY(state.y), surfaces)
  return { ...state, ...point, fromX: mapX(state.fromX), fromY: mapY(state.fromY),
    toX: mapX(state.toX), toY: mapY(state.toY) }
}

function sidePosition(ticket: MotionRect, side: MotionFacing, half: number): number {
  return side === 'right' ? ticket.x - half : ticket.x + ticket.width + half
}

function rebaseSideFlight(state: MotionState, oldRect: MotionRect, rect: MotionRect,
  surfaces: MotionSurfaces): MotionState | null {
  const half = dimensions(surfaces).half
  const side = sideOf(oldRect, state.action === 'climb' ? state.fromX : state.toX, half)
  if (!side) return null
  const oldSide = sidePosition(oldRect, side, half)
  const newSide = sidePosition(rect, side, half)
  const vertical = rebaseOnRect(state, oldRect, rect, surfaces)
  if (state.action === 'jump') {
    const dx = newSide - oldSide
    return { ...vertical, x: safePoint(state.x + dx, vertical.y, surfaces).x,
      fromX: state.fromX + dx, toX: state.toX + dx }
  }
  const newToX = side === 'right' ? rect.x + half + 2 : rect.x + rect.width - half - 2
  const fraction = (state.x - state.fromX) / (state.toX - state.fromX)
  return { ...vertical,
    x: safePoint(newSide + fraction * (newToX - newSide), vertical.y, surfaces).x,
    fromX: newSide, toX: newToX }
}

function rebaseSupport(state: MotionState, surfaces: MotionSurfaces): MotionState {
  const currentSupport = state.supportId ? cleanTickets(surfaces).find((item) => item.id === state.supportId) : undefined
  if (!currentSupport || !state.supportRect) return state
  const rebased = rebaseOnRect(state, state.supportRect, currentSupport, surfaces)
  const interval = landingInterval(currentSupport, dimensions(surfaces).half, dimensions(surfaces).width)
  if (!interval) return rebased
  return { ...rebased, x: clamp(rebased.x, interval.min, interval.max),
    fromX: clamp(rebased.fromX, interval.min, interval.max),
    toX: clamp(rebased.toX, interval.min, interval.max) }
}

function rebaseTarget(state: MotionState, surfaces: MotionSurfaces): MotionState {
  if (!state.targetId || !state.targetRect || state.supportId) return state
  const target = cleanTickets(surfaces).find((item) => item.id === state.targetId)
  if (!target) return state
  if (state.action === 'climb' || state.action === 'jump') {
    return rebaseFlightTarget(state, target, surfaces)
  }
  if (state.action === 'walk' || state.action === 'run') {
    return rebaseApproach(state, target, surfaces)
  }
  return state
}

function rebaseFlightTarget(state: MotionState, target: MotionRect, surfaces: MotionSurfaces): MotionState {
  const side = rebaseSideFlight(state, state.targetRect!, target, surfaces)
  if (side) return side
  const rebased = rebaseOnRect(state, state.targetRect!, target, surfaces)
  const interval = landingInterval(target, dimensions(surfaces).half, dimensions(surfaces).width)
  return state.action === 'jump' && interval
    ? { ...rebased, toX: clamp(rebased.toX, interval.min, interval.max) } : rebased
}

function rebaseApproach(state: MotionState, target: MotionRect, surfaces: MotionSurfaces): MotionState {
  const old = state.targetRect!
  const half = dimensions(surfaces).half
  const side = sideOf(old, state.toX, half)
  const toX = side ? sidePosition(target, side, half) : state.toX + target.x - old.x
  return { ...state, toX }
}

function prepareState(previous: MotionState, surfaces: MotionSurfaces): MotionState {
  const safe = safePoint(previous.x, previous.y, surfaces)
  const sanitized: MotionState = {
    ...previous, ...safe,
    elapsed: Math.max(0, finite(previous.elapsed)),
    duration: Math.max(1, finite(previous.duration, 1)),
    randomState: previous.randomState | 0,
    progress: clamp(finite(previous.progress), 0, 1)
  }
  const state = rebaseTarget(rebaseSupport(sanitized, surfaces), surfaces)
  if (!state.supportId && (state.action === 'idle' || state.action === 'walk' || state.action === 'run')) {
    const floor = dimensions(surfaces).floor
    const targetId = previous.fromY !== floor && state.action !== 'idle' ? null : state.targetId
    return { ...state, y: floor, fromY: floor, toY: floor, targetId }
  }
  return state
}

interface AdvanceResult { state: MotionState; consumed: number; transitioned: boolean }

function advanceFall(state: MotionState, remaining: number, surfaces: MotionSurfaces): AdvanceResult {
  const consumed = Math.min(Math.max(0, state.duration - state.elapsed), remaining)
  const elapsed = state.elapsed + consumed
  const nextY = Math.min(dimensions(surfaces).floor,
    state.fromY + 0.5 * FALL_ACCELERATION * (elapsed / 1000) ** 2)
  const ticket = landingBetween(state, nextY, surfaces)
  if (ticket) {
    const hitTime = Math.sqrt(2 * (ticket.y - state.fromY) / FALL_ACCELERATION) * 1000
    return { state: land(state, ticket, surfaces), consumed: Math.max(0, hitTime - state.elapsed), transitioned: true }
  }
  const next = { ...state, y: nextY, elapsed, progress: clamp(elapsed / state.duration, 0, 1) }
  return next.progress >= 1
    ? { state: land(next, undefined, surfaces), consumed, transitioned: true }
    : { state: next, consumed, transitioned: false }
}

function workNeedsRetarget(state: MotionState, surfaces: MotionSurfaces): boolean {
  if (!state.working) return false
  const tickets = visibleTickets(surfaces)
  const support = tickets.find((ticket) => ticket.id === state.supportId)
  if (!support?.inProgress) return true
  const destination = routeToGoal(state, tickets, surfaces).at(-1)
  return Boolean(destination?.inProgress && destination.y < support.y)
}

function advanceRest(state: MotionState, remaining: number): AdvanceResult {
  const consumed = Math.min(remaining, state.restRemaining ?? 0)
  const restRemaining = Math.max(0, (state.restRemaining ?? 0) - consumed)
  return { state: { ...state, restRemaining: restRemaining || undefined,
    resting: restRemaining > 0 }, consumed, transitioned: false }
}

function nextPoseEvent(state: MotionState): number {
  const events = [state.restAt, state.slipAt]
    .filter((event): event is number => event !== undefined && event * state.duration > state.elapsed + 0.001)
  return events.length > 0 ? Math.min(...events) * state.duration - state.elapsed : state.duration - state.elapsed
}

function advancePose(state: MotionState, remaining: number, surfaces: MotionSurfaces): AdvanceResult {
  const consumed = Math.min(Math.max(0, state.duration - state.elapsed), remaining, nextPoseEvent(state))
  const elapsed = state.elapsed + consumed
  const t = clamp(elapsed / state.duration, 0, 1)
  const next = { ...state, elapsed, ...motionPoint(state, t, surfaces), progress: t }
  if (next.restAt !== undefined && t >= next.restAt - 0.000001) {
    return { state: { ...next, resting: true, restRemaining: 250 + next.restAt * 600,
      restAt: undefined }, consumed, transitioned: false }
  }
  if (next.slipAt !== undefined && t >= next.slipAt - 0.000001) {
    return { state: startFall(next, surfaces), consumed, transitioned: true }
  }
  return t >= 1
    ? { state: completedAction(next, surfaces), consumed, transitioned: true }
    : { state: next, consumed, transitioned: false }
}

function needsFall(state: MotionState, surfaces: MotionSurfaces): boolean {
  return !state.falling && (!supported(state, surfaces) || !targetValid(state, surfaces))
}

function advanceSequence(initial: MotionState, deltaMs: number, surfaces: MotionSurfaces): MotionState {
  let state = initial
  let remaining = clamp(finite(deltaMs), 0, 120_000)
  let transitions = 0
  while (remaining > 0 && transitions < 1024) {
    if (needsFall(state, surfaces)) {
      state = startFall(state, surfaces)
      transitions += 1
      continue
    }
    if (workNeedsRetarget(state, surfaces)) {
      state = nextAction({ ...state, working: false }, surfaces)
      transitions += 1
      continue
    }
    const result = state.falling ? advanceFall(state, remaining, surfaces)
      : state.resting ? advanceRest(state, remaining) : advancePose(state, remaining, surfaces)
    state = result.state
    remaining -= result.consumed
    if (result.transitioned) transitions += 1
  }
  const point = safePoint(state.x, state.y, surfaces)
  if (remaining > 0) state = action({ ...state, ...point }, { kind: 'idle', ...point, duration: 650 })
  return { ...state, ...point, progress: clamp(finite(state.progress), 0, 1) }
}

/** Advances seeded motion in CSS pixels. The mascot's full body stays within the viewport. */
export function stepMotion(previous: MotionState, deltaMs: number, surfaces: MotionSurfaces): MotionState {
  let state = prepareState(previous, surfaces)
  const newShake = surfaces.shakeId !== undefined && surfaces.shakeId !== state.lastShakeId &&
    (state.lastShakeId !== undefined || surfaces.shakeId !== 0)
  if (newShake) {
    state = { ...(state.falling ? state : startFall(state, surfaces)), lastShakeId: surfaces.shakeId }
  } else if (surfaces.shakeId !== undefined && state.lastShakeId === undefined) {
    state = { ...state, lastShakeId: surfaces.shakeId }
  }
  if (surfaces.viewport.width <= 0 || surfaces.viewport.height <= 0) {
    const point = safePoint(state.x, state.y, surfaces)
    return { ...action(state, { kind: 'idle', ...point, duration: 650 }), progress: 0, targetId: null }
  }
  const next = advanceSequence(state, deltaMs, surfaces)
  const tickets = cleanTickets(surfaces)
  return {
    ...next,
    supportRect: tickets.find((item) => item.id === next.supportId),
    targetRect: tickets.find((item) => item.id === next.targetId)
  }
}
