export interface ShakeViewport {
  x: number
  y: number
  zoom: number
}

/** Immutable detector state; `detected` is a one-sample pulse. */
interface ShakeState {
  viewport: ShakeViewport | null
  timestamp: number | null
  direction: -1 | 0 | 1
  axis: 'x' | 'y' | null
  origin: ShakeViewport | null
  extreme: number | null
  reversals: number
  startedAt: number | null
  detected: boolean
  cooldownUntil: number
}

// A shake must move at least 24 CSS px per leg, with two reversals inside 650 ms.
const MIN_LEG_PX = 24
const WINDOW_MS = 650
const COOLDOWN_MS = 1200

export function createShakeState(): ShakeState {
  return { viewport: null, timestamp: null, direction: 0, axis: null, origin: null, extreme: null, reversals: 0,
    startedAt: null, detected: false, cooldownUntil: 0 }
}

/** Clear the current gesture and cooldown, for pause/hidden/reduced-motion transitions. */
export function resetShake(_state?: ShakeState): ShakeState {
  return createShakeState()
}

function clearGesture(state: ShakeState, viewport: ShakeViewport | null, timestamp: number): ShakeState {
  return { ...state, timestamp, viewport: viewport && { ...viewport }, direction: 0,
    axis: null, origin: viewport && { ...viewport }, extreme: null,
    reversals: 0, startedAt: null, detected: false }
}

function startLeg(state: ShakeState, viewport: ShakeViewport, timestamp: number): ShakeState {
    const origin = state.origin ?? state.viewport!
    const dx = viewport.x - origin.x
    const dy = viewport.y - origin.y
    const axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y'
    const delta = axis === 'x' ? dx : dy
    if (Math.abs(delta) < MIN_LEG_PX) return { ...state, viewport: { ...viewport }, timestamp, detected: false }
    return { ...state, viewport: { ...viewport }, timestamp, axis, origin,
      extreme: viewport[axis], direction: delta > 0 ? 1 : -1,
      reversals: 0, startedAt: timestamp, detected: false }
}

function eligibleMove(state: ShakeState, viewport: ShakeViewport, timestamp: number): ShakeState {
  if (state.startedAt !== null && timestamp - state.startedAt > WINDOW_MS) {
    return clearGesture(state, viewport, timestamp)
  }
  if (state.axis === null) return startLeg(state, viewport, timestamp)
  const position = viewport[state.axis]
  const extreme = state.extreme!
  const travel = (position - extreme) * state.direction
  const next = { ...state, viewport: { ...viewport }, timestamp, detected: false }
  if (travel > 0) return { ...next, extreme: position }
  if (travel > -MIN_LEG_PX) return next
  if (state.reversals === 1) return { ...next, direction: 0, axis: null,
    origin: { ...viewport }, extreme: null, reversals: 0, startedAt: null,
    detected: true, cooldownUntil: timestamp + COOLDOWN_MS }
  return { ...next, direction: state.direction === 1 ? -1 : 1,
    extreme: position, reversals: 1 }
}

export function stepShake(state: ShakeState, viewport: ShakeViewport | null,
  timestamp: number, userOrigin: boolean | null): ShakeState {
  if (!Number.isFinite(timestamp) || state.timestamp !== null && timestamp <= state.timestamp) {
    return { ...state, detected: false }
  }
  if (!userOrigin || !viewport || ![viewport.x, viewport.y, viewport.zoom].every(Number.isFinite)) {
    return clearGesture(state, viewport, timestamp)
  }
  if (state.viewport === null) return clearGesture(state, viewport, timestamp)
  if (timestamp < state.cooldownUntil) return { ...state, viewport: { ...viewport }, timestamp,
    direction: 0, axis: null, origin: { ...viewport }, extreme: null,
    reversals: 0, startedAt: null, detected: false }
  // Zoom and translation in the same gesture are intentionally ineligible.
  if (viewport.zoom !== state.viewport.zoom) return clearGesture(state, viewport, timestamp)
  return eligibleMove(state, viewport, timestamp)
}
