import { createMotion, stepMotion, type MotionAction, type MotionFacing, type MotionState } from '../../mascot/motion'
import {
  advanceEffects, BEAM_MS, createBeam, createPacket, createRing, createSparks, drawRandom,
  type ChamberEffect, type EffectArrival, type PacketSpec, type Point
} from './effects'
import type { ChamberLayout } from './layout'

export type RunState = 'idle' | 'running' | 'paused' | 'ending' | 'ended' | 'killed'
/** An acolyte that finished leaving is removed from the chamber (gone). */
export type AcolyteMode = 'arriving' | 'wandering' | 'working' | 'saluting' | 'leaving'
export type AcolytePose = MotionAction | 'drill' | 'type' | 'salute'
export type MagosOneShot = 'chronicle' | 'order_all' | 'order_one' | 'summon' | 'speak'
export type MagosAction = MagosOneShot | 'petition' | 'idle'

/** Highest first: the Magos performs one action at a time and picks the highest one wanted. */
export const MAGOS_PRIORITY: readonly MagosAction[] =
  ['chronicle', 'petition', 'order_all', 'order_one', 'summon', 'speak', 'idle']
export const MAGOS_ID = 'magos'
export const BUBBLE_MIN_MS = 2500
export const BUBBLE_MAX_MS = 6000
export const BUBBLE_MAX_CHARS = 60
const WALK_SPEED = 110
const DROP_SPEED = 420

/** An atlas clip's playback rate and frame count; a one-shot lasts frames / fps seconds. */
export interface ClipTiming { fps: number; frames: number }
export type ChamberClipTimings = Record<'salute' | MagosOneShot, ClipTiming>

/** Six-frame clips, as every mascot atlas has; the renderer passes the real atlas timings. */
export const DEFAULT_CLIP_TIMINGS: ChamberClipTimings = {
  salute: { fps: 10, frames: 6 }, speak: { fps: 8, frames: 6 }, order_one: { fps: 8, frames: 6 },
  order_all: { fps: 8, frames: 6 }, summon: { fps: 8, frames: 6 }, chronicle: { fps: 6, frames: 6 }
}

export function clipDuration(clip: ClipTiming): number {
  return clip.fps > 0 && clip.frames > 0 ? clip.frames / clip.fps * 1000 : 0
}

export interface ChamberAcolyte {
  id: string
  mode: AcolyteMode
  /** The member's live work flag; working acolytes type at a console or, without one, drill. */
  working: boolean
  consoleId: string | null
  /** Feet position in room pixels. */
  x: number
  y: number
  facing: MotionFacing
  pose: AcolytePose
  poseElapsed: number
  /** Normalized progress of a motion-engine action (jump and stumble frames). */
  progress: number
  modeElapsed: number
  /** The seeded motion engine; it drives the acolyte while wandering. */
  motion: MotionState
}

export interface ChamberMagos {
  action: MagosAction
  elapsed: number
  oneShot: boolean
  queue: MagosOneShot[]
  busy: boolean
  petition: boolean
}

export interface ChamberBubble { text: string; age: number; pending: string | null }

export interface ChamberState {
  randomState: number
  clips: ChamberClipTimings
  runState: RunState
  stasis: boolean
  lightsDim: boolean
  blackout: boolean
  warning: boolean
  elapsed: number
  magos: ChamberMagos
  acolytes: ChamberAcolyte[]
  /** One bubble per actor, keyed by member id or `MAGOS_ID`. */
  bubbles: Record<string, ChamberBubble>
  effects: ChamberEffect[]
  nextEffectId: number
}

export type ChamberEvent =
  | { type: 'memberJoined'; id: string }
  | { type: 'memberLeft'; id: string }
  | { type: 'working'; id: string; on: boolean }
  | { type: 'bubble'; id: string; text: string }
  | { type: 'orderSent'; to: string; orderId: string }
  | { type: 'reportSent'; from: string }
  | { type: 'peerMail'; from: string; to: string }
  | { type: 'magosBusy'; on: boolean }
  | { type: 'petitionPending'; on: boolean }
  | { type: 'runState'; runState: RunState }
  | { type: 'lastMinute'; on: boolean }

export function createChamber(seed: number, clips: ChamberClipTimings = DEFAULT_CLIP_TIMINGS): ChamberState {
  return {
    randomState: (Math.floor(Number.isFinite(seed) ? seed : 0) | 0) || 0x6d2b79f5,
    clips, runState: 'idle', stasis: false, lightsDim: false, blackout: false, warning: false, elapsed: 0,
    magos: { action: 'idle', elapsed: 0, oneShot: false, queue: [], busy: false, petition: false },
    acolytes: [], bubbles: {}, effects: [], nextEffectId: 1
  }
}

function magosPoint(layout: ChamberLayout): Point {
  return { x: layout.magos.x, y: layout.magos.y - layout.magosSize.height * 0.6 }
}

function acolytePoint(acolyte: ChamberAcolyte, layout: ChamberLayout): Point {
  return { x: acolyte.x, y: acolyte.y - layout.spriteSize.height * 0.6 }
}

// ---- Magos -------------------------------------------------------------------------------------

function chooseMagos(magos: ChamberMagos): ChamberMagos {
  const wanted: MagosAction[] = [...magos.queue]
  if (magos.petition) wanted.push('petition')
  if (magos.busy) wanted.push('speak')
  const action = MAGOS_PRIORITY.find((candidate) => wanted.includes(candidate)) ?? 'idle'
  const oneShot = (magos.queue as MagosAction[]).includes(action)
  return { ...magos, action, elapsed: 0, oneShot,
    queue: oneShot ? magos.queue.filter((item) => item !== action) : magos.queue }
}

/** Re-picks a held pose (idle, speak, petition) at once; a playing one-shot finishes first. */
function settleMagos(magos: ChamberMagos): ChamberMagos {
  if (magos.oneShot) return magos
  const next = chooseMagos(magos)
  return next.action === magos.action && !next.oneShot ? { ...next, elapsed: magos.elapsed } : next
}

function requestMagos(magos: ChamberMagos, action: MagosOneShot): ChamberMagos {
  const already = magos.queue.includes(action) || magos.action === action && !magos.oneShot
  return settleMagos(already ? magos : { ...magos, queue: [...magos.queue, action] })
}

function stepMagos(magos: ChamberMagos, dt: number, clips: ChamberClipTimings): ChamberMagos {
  let next = { ...magos, elapsed: magos.elapsed + dt }
  for (let guard = 0; next.oneShot && guard < MAGOS_PRIORITY.length; guard += 1) {
    const duration = clipDuration(clips[next.action as MagosOneShot])
    if (next.elapsed < duration) break
    next = { ...chooseMagos(next), elapsed: next.elapsed - duration }
  }
  return next
}

// ---- Bubbles -----------------------------------------------------------------------------------

function capText(text: string): string {
  const characters = [...text.trim()]
  return characters.length > BUBBLE_MAX_CHARS
    ? `${characters.slice(0, BUBBLE_MAX_CHARS - 1).join('')}…` : characters.join('')
}

function stepBubble(bubble: ChamberBubble, dt: number): ChamberBubble | null {
  const age = bubble.age + dt
  if (bubble.pending !== null && age >= BUBBLE_MIN_MS) {
    const replaced = { text: bubble.pending, age: age - BUBBLE_MIN_MS, pending: null }
    return replaced.age >= BUBBLE_MAX_MS ? null : replaced
  }
  return age >= BUBBLE_MAX_MS ? null : { ...bubble, age }
}

function stepBubbles(bubbles: Record<string, ChamberBubble>, dt: number,
  present: Set<string>): Record<string, ChamberBubble> {
  const next: Record<string, ChamberBubble> = {}
  for (const [id, bubble] of Object.entries(bubbles)) {
    const stepped = present.has(id) ? stepBubble(bubble, dt) : null
    if (stepped) next[id] = stepped
  }
  return next
}

// ---- Acolytes ----------------------------------------------------------------------------------

function withPose(acolyte: ChamberAcolyte, pose: AcolytePose, dt: number): ChamberAcolyte {
  return { ...acolyte, pose, progress: 0, poseElapsed: acolyte.pose === pose ? acolyte.poseElapsed + dt : 0 }
}

/** Walks along the floor toward `targetX`, dropping to the floor first if on a platform. */
function walkToward(acolyte: ChamberAcolyte, targetX: number, dt: number,
  layout: ChamberLayout): { acolyte: ChamberAcolyte; arrived: boolean } {
  const half = layout.spriteSize.width / 2
  const target = Math.min(Math.max(targetX, half), Math.max(half, layout.size.width - half))
  const stride = WALK_SPEED * dt / 1000
  const dx = target - acolyte.x
  const x = Math.abs(dx) <= stride ? target : acolyte.x + Math.sign(dx) * stride
  const y = Math.min(layout.floorY, acolyte.y + DROP_SPEED * dt / 1000)
  const facing: MotionFacing = dx > 0 ? 'right' : dx < 0 ? 'left' : acolyte.facing
  const arrived = x === target && y === layout.floorY
  return { acolyte: { ...acolyte, x, y, facing }, arrived }
}

function enterBaseMode(acolyte: ChamberAcolyte): ChamberAcolyte {
  if (acolyte.working) return { ...acolyte, mode: 'working', modeElapsed: 0 }
  const { motion } = acolyte
  const fresh = motion.x === acolyte.x && motion.y === acolyte.y
  return { ...acolyte, mode: 'wandering', modeElapsed: 0,
    motion: fresh ? motion : createMotion(motion.randomState, { x: acolyte.x, y: acolyte.y }) }
}

function salute(acolyte: ChamberAcolyte, layout: ChamberLayout): ChamberAcolyte {
  if (acolyte.mode === 'leaving') return acolyte
  return { ...acolyte, mode: 'saluting', modeElapsed: 0, pose: 'salute', poseElapsed: 0, progress: 0,
    facing: layout.magos.x >= acolyte.x ? 'right' : 'left' }
}

function stepWandering(acolyte: ChamberAcolyte, dt: number, layout: ChamberLayout): ChamberAcolyte {
  const motion = stepMotion(acolyte.motion, dt, layout.surfaces)
  return { ...acolyte, motion, x: motion.x, y: motion.y, facing: motion.facing,
    pose: motion.action, poseElapsed: motion.elapsed, progress: motion.progress }
}

function stepWorking(acolyte: ChamberAcolyte, dt: number, layout: ChamberLayout): ChamberAcolyte {
  const station = layout.consoles.find((item) => item.id === acolyte.consoleId)
  const walked = walkToward(acolyte, station ? station.operatorX : acolyte.x, dt, layout)
  if (!walked.arrived) return withPose(walked.acolyte, 'walk', dt)
  if (!station) return withPose(walked.acolyte, 'drill', dt)
  return withPose({ ...walked.acolyte, facing: station.operatorFacing }, 'type', dt)
}

function stepTimed(acolyte: ChamberAcolyte, dt: number, limit: number): ChamberAcolyte {
  const modeElapsed = acolyte.modeElapsed + dt
  if (modeElapsed >= limit) return enterBaseMode(acolyte)
  const pose = acolyte.mode === 'saluting' ? 'salute' : 'idle'
  return { ...withPose(acolyte, pose, dt), modeElapsed }
}

/** One step for one acolyte; null once it has walked out of the door. */
function stepAcolyte(acolyte: ChamberAcolyte, dt: number, state: ChamberState,
  layout: ChamberLayout): ChamberAcolyte | null {
  switch (acolyte.mode) {
    case 'arriving': return stepTimed(acolyte, dt, BEAM_MS)
    case 'saluting': return stepTimed(acolyte, dt, clipDuration(state.clips.salute))
    case 'working': return stepWorking(acolyte, dt, layout)
    case 'wandering': return stepWandering(acolyte, dt, layout)
    case 'leaving': {
      const walked = walkToward(acolyte, layout.door.exitX, dt, layout)
      return walked.arrived ? null : withPose(walked.acolyte, 'walk', dt)
    }
  }
}

const seated = (acolyte: ChamberAcolyte): boolean => acolyte.working && acolyte.mode !== 'leaving'

/** Workers keep their console; free consoles go to unseated workers in roster order; the rest drill. */
function assignConsoles(acolytes: ChamberAcolyte[], layout: ChamberLayout): ChamberAcolyte[] {
  const known = new Set(layout.consoles.map((item) => item.id))
  const held = new Set<string>()
  const kept = acolytes.map((acolyte) => {
    const id = acolyte.consoleId
    const keep = seated(acolyte) && id !== null && known.has(id) && !held.has(id)
    if (keep) held.add(id)
    return keep || id === null ? acolyte : { ...acolyte, consoleId: null }
  })
  const free = layout.consoles.map((item) => item.id).filter((id) => !held.has(id))
  return kept.map((acolyte) => seated(acolyte) && acolyte.consoleId === null && free.length > 0
    ? { ...acolyte, consoleId: free.shift()! } : acolyte)
}

// ---- Effects -----------------------------------------------------------------------------------

function addEffect(state: ChamberState, make: (id: number) => ChamberEffect): ChamberState {
  return { ...state, effects: [...state.effects, make(state.nextEffectId)], nextEffectId: state.nextEffectId + 1 }
}

function sendPacket(state: ChamberState, spec: PacketSpec, layout: ChamberLayout): ChamberState {
  return addEffect(state, (id) => createPacket(id, spec, layout))
}

/** In-flight packets follow their recipient. */
function trackPackets(effects: ChamberEffect[], acolytes: ChamberAcolyte[], layout: ChamberLayout): ChamberEffect[] {
  return effects.map((effect) => {
    if (effect.kind !== 'packet') return effect
    if (effect.to === MAGOS_ID) return { ...effect, toPoint: magosPoint(layout) }
    const recipient = acolytes.find((acolyte) => acolyte.id === effect.to)
    return recipient ? { ...effect, toPoint: acolytePoint(recipient, layout) } : effect
  })
}

function saluteMember(state: ChamberState, id: string, layout: ChamberLayout): ChamberState {
  return { ...state, acolytes: state.acolytes.map((acolyte) => acolyte.id === id ? salute(acolyte, layout) : acolyte) }
}

function react(state: ChamberState, arrival: EffectArrival, layout: ChamberLayout): ChamberState {
  if (arrival.kind === 'ring') return saluteMember(state, arrival.id, layout)
  const { packet } = arrival
  if (packet.purpose === 'order') return saluteMember(state, packet.to, layout)
  if (packet.purpose === 'report') return { ...state, magos: requestMagos(state.magos, 'speak') }
  return state
}

function dimWhenEmpty(state: ChamberState): ChamberState {
  const closing = state.runState === 'ending' || state.runState === 'ended'
  return closing && state.acolytes.length === 0 && !state.lightsDim ? { ...state, lightsDim: true } : state
}

/** Advances every actor, effect and bubble by `dtMs`. While paused it returns `state` itself. */
export function stepChamber(state: ChamberState, dtMs: number, layout: ChamberLayout): ChamberState {
  const dt = Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0
  if (state.stasis || dt === 0) return state
  const acolytes = assignConsoles(state.acolytes, layout)
    .map((acolyte) => stepAcolyte(acolyte, dt, state, layout))
    .filter((acolyte): acolyte is ChamberAcolyte => acolyte !== null)
  const present = new Set([MAGOS_ID, ...acolytes.map((acolyte) => acolyte.id)])
  const { effects, arrivals } = advanceEffects(trackPackets(state.effects, acolytes, layout), dt)
  const stepped: ChamberState = {
    ...state, elapsed: state.elapsed + dt, acolytes, effects,
    magos: stepMagos(state.magos, dt, state.clips), bubbles: stepBubbles(state.bubbles, dt, present)
  }
  return dimWhenEmpty(arrivals.reduce((next, arrival) => react(next, arrival, layout), stepped))
}

// ---- Events ------------------------------------------------------------------------------------

type Handler<E> = (state: ChamberState, event: E, layout: ChamberLayout) => ChamberState
type Handlers = { [K in ChamberEvent['type']]: Handler<Extract<ChamberEvent, { type: K }>> }

const member = (state: ChamberState, id: string): ChamberAcolyte | undefined =>
  state.acolytes.find((acolyte) => acolyte.id === id)

function updateMember(state: ChamberState, id: string,
  change: (acolyte: ChamberAcolyte) => ChamberAcolyte): ChamberState {
  return { ...state, acolytes: state.acolytes.map((acolyte) => acolyte.id === id ? change(acolyte) : acolyte) }
}

function memberJoined(state: ChamberState, { id }: { id: string }, layout: ChamberLayout): ChamberState {
  if (member(state, id)) return state
  const [, seed] = drawRandom(state.randomState)
  const x = layout.teleportPad.centerX
  const acolyte: ChamberAcolyte = {
    id, mode: 'arriving', working: false, consoleId: null, x, y: layout.floorY, facing: 'left',
    pose: 'idle', poseElapsed: 0, progress: 0, modeElapsed: 0, motion: createMotion(seed, { x, y: layout.floorY })
  }
  const joined = { ...state, randomState: seed, acolytes: [...state.acolytes, acolyte],
    magos: requestMagos(state.magos, 'summon') }
  return addEffect(joined, (effectId) => createBeam(effectId, layout))
}

function workingChanged(state: ChamberState, { id, on }: { id: string; on: boolean },
  layout: ChamberLayout): ChamberState {
  const changed = updateMember(state, id, (acolyte) => {
    const flagged = { ...acolyte, working: on }
    const switches = on ? acolyte.mode === 'wandering' : acolyte.mode === 'working'
    return switches ? enterBaseMode(flagged) : flagged
  })
  return { ...changed, acolytes: assignConsoles(changed.acolytes, layout) }
}

function bubbleShown(state: ChamberState, { id, text }: { id: string; text: string }): ChamberState {
  const capped = capText(text)
  if (capped.length === 0 || id !== MAGOS_ID && !member(state, id)) return state
  const current = state.bubbles[id]
  const bubble = current && current.age < BUBBLE_MIN_MS
    ? { ...current, pending: capped } : { text: capped, age: 0, pending: null }
  return { ...state, bubbles: { ...state.bubbles, [id]: bubble } }
}

function orderSent(state: ChamberState, { to, orderId }: { to: string; orderId: string },
  layout: ChamberLayout): ChamberState {
  const origin = magosPoint(layout)
  if (to === 'all') {
    const targets = state.acolytes.filter((acolyte) => acolyte.mode !== 'leaving')
      .map((acolyte) => ({ id: acolyte.id, point: acolytePoint(acolyte, layout) }))
    const ordered = { ...state, magos: requestMagos(state.magos, 'order_all') }
    return addEffect(ordered, (id) => createRing(id, { orderId, origin, targets }, layout))
  }
  const target = member(state, to)
  if (!target || target.mode === 'leaving') return state
  return sendPacket({ ...state, magos: requestMagos(state.magos, 'order_one') },
    { purpose: 'order', from: MAGOS_ID, to, fromPoint: origin, toPoint: acolytePoint(target, layout) }, layout)
}

function reportSent(state: ChamberState, { from }: { from: string }, layout: ChamberLayout): ChamberState {
  const sender = member(state, from)
  if (!sender) return state
  return sendPacket(state, { purpose: 'report', from, to: MAGOS_ID,
    fromPoint: acolytePoint(sender, layout), toPoint: magosPoint(layout) }, layout)
}

function peerMail(state: ChamberState, { from, to }: { from: string; to: string },
  layout: ChamberLayout): ChamberState {
  const sender = member(state, from)
  const recipient = member(state, to)
  if (!sender || !recipient || from === to) return state
  return sendPacket(state, { purpose: 'mail', from, to,
    fromPoint: acolytePoint(sender, layout), toPoint: acolytePoint(recipient, layout) }, layout)
}

/** Graceful exit: each acolyte sends a report packet and marches for the door; the Magos chronicles. */
function beginExit(state: ChamberState, layout: ChamberLayout): ChamberState {
  let next: ChamberState = { ...state, magos: requestMagos(state.magos, 'chronicle') }
  for (const acolyte of state.acolytes.filter((item) => item.mode !== 'leaving')) {
    next = reportSent(next, { from: acolyte.id }, layout)
    next = updateMember(next, acolyte.id, (item) => ({ ...item, mode: 'leaving', modeElapsed: 0, consoleId: null }))
  }
  return dimWhenEmpty(next)
}

/** Kill: every acolyte vanishes at once, the room blacks out and the props throw sparks. */
function killChamber(state: ChamberState, layout: ChamberLayout): ChamberState {
  const origins = [...layout.consoles.map((item) => item.top), layout.helm.top]
    .map((top) => ({ x: top.x + top.width / 2, y: top.y }))
  const [sparks, randomState] = createSparks(state.nextEffectId, origins, state.randomState)
  const magos = settleMagos({ ...state.magos, action: 'idle', elapsed: 0, oneShot: false, queue: [] })
  const magosBubble = state.bubbles[MAGOS_ID]
  const bubbles: Record<string, ChamberBubble> = magosBubble ? { [MAGOS_ID]: magosBubble } : {}
  return { ...state, randomState, magos, bubbles, acolytes: [], effects: [sparks],
    nextEffectId: state.nextEffectId + 1, blackout: true }
}

function runStateChanged(state: ChamberState, { runState }: { runState: RunState },
  layout: ChamberLayout): ChamberState {
  const next: ChamberState = { ...state, runState, stasis: runState === 'paused' }
  const closing = (value: RunState): boolean => value === 'ending' || value === 'ended'
  if (runState === 'killed') return killChamber(next, layout)
  if (closing(runState) && !closing(state.runState)) return beginExit(next, layout)
  if (runState === 'running' && state.runState !== 'paused') return { ...next, lightsDim: false, blackout: false }
  return next
}

const HANDLERS: Handlers = {
  memberJoined,
  memberLeft: (state, { id }) => updateMember(state, id, (acolyte) =>
    ({ ...acolyte, mode: 'leaving', modeElapsed: 0, consoleId: null })),
  working: workingChanged,
  bubble: bubbleShown,
  orderSent,
  reportSent,
  peerMail,
  magosBusy: (state, { on }) => ({ ...state, magos: settleMagos({ ...state.magos, busy: on }) }),
  petitionPending: (state, { on }) => ({ ...state, magos: settleMagos({ ...state.magos, petition: on }) }),
  runState: runStateChanged,
  lastMinute: (state, { on }) => ({ ...state, warning: on })
}

export function applyChamberEvent(state: ChamberState, event: ChamberEvent, layout: ChamberLayout): ChamberState {
  return (HANDLERS[event.type] as Handler<ChamberEvent>)(state, event, layout)
}

/**
 * The reduced-motion view: the Magos at the helm, working acolytes at their consoles, the others in
 * an even row on the floor; no travel and no effects, with the same bubbles and flags.
 */
export function staticChamber(state: ChamberState, layout: ChamberLayout): ChamberState {
  const placed = assignConsoles(state.acolytes, layout)
  const stationOf = (acolyte: ChamberAcolyte) =>
    seated(acolyte) ? layout.consoles.find((item) => item.id === acolyte.consoleId) : undefined
  const row = placed.filter((acolyte) => !stationOf(acolyte))
  const left = layout.door.rect.x + layout.door.rect.width
  const slot = (layout.teleportPad.rect.x - left) / Math.max(1, row.length)
  const acolytes = placed.map((acolyte): ChamberAcolyte => {
    const station = stationOf(acolyte)
    const still = { ...acolyte, y: layout.floorY, poseElapsed: 0, progress: 0 }
    return station
      ? { ...still, x: station.operatorX, facing: station.operatorFacing, pose: 'type' }
      : { ...still, x: left + slot * (row.indexOf(acolyte) + 0.5), facing: 'right', pose: 'idle' }
  })
  return { ...state, acolytes, effects: [], magos: { ...state.magos, elapsed: 0 } }
}
