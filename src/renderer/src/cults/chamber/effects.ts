import type { ChamberLayout } from './layout'

export interface Point { x: number; y: number }

export const PACKET_MIN_MS = 600
export const PACKET_MAX_MS = 1200
/** Time for the noosphere ring to sweep from the helm to the room's farthest corner. */
export const RING_MS = 1600
export const BEAM_MS = 900
const SPARKS_MS = 1400
const SPARK_GRAVITY = 900

type PacketPurpose = 'order' | 'report' | 'mail'

interface EffectBase { id: number; elapsed: number; duration: number }

/** A binharic packet arcing from `from` to `to`; `toPoint` follows the recipient while it flies. */
export interface PacketEffect extends EffectBase {
  kind: 'packet'
  purpose: PacketPurpose
  from: string
  to: string
  fromPoint: Point
  toPoint: Point
  arcHeight: number
}

/** A noosphere ring; `targets` are the acolytes not yet reached, with their arrival times, nearest first. */
export interface RingEffect extends EffectBase {
  kind: 'ring'
  orderId: string
  origin: Point
  maxRadius: number
  targets: Array<{ id: string; at: number }>
}

export interface BeamEffect extends EffectBase { kind: 'beam'; x: number; y: number; height: number }

/** A spark's launch point and velocity in px/s; `sparkPoint` gives its position. */
interface Spark { x: number; y: number; vx: number; vy: number }
export interface SparksEffect extends EffectBase { kind: 'sparks'; sparks: Spark[] }

export type ChamberEffect = PacketEffect | RingEffect | BeamEffect | SparksEffect

/** What reached its recipient during a step: a packet, or the ring reaching one acolyte. */
export type EffectArrival =
  | { kind: 'packet'; packet: PacketEffect }
  | { kind: 'ring'; ring: RingEffect; id: string }

/** Seeded xorshift draw in [0, 1) and the next seed. */
export function drawRandom(seed: number): [number, number] {
  let next = seed | 0 || 0x6d2b79f5
  next ^= next << 13
  next ^= next >>> 17
  next ^= next << 5
  next |= 0
  return [((next >>> 0) % 1_000_000) / 1_000_000, next]
}

/** Between 600 and 1200 ms, linear in distance up to the room diagonal. */
export function packetDuration(from: Point, to: Point, layout: ChamberLayout): number {
  const reference = Math.hypot(layout.size.width, layout.floorY)
  const share = reference > 0 ? Math.min(1, Math.hypot(to.x - from.x, to.y - from.y) / reference) : 0
  return PACKET_MIN_MS + (PACKET_MAX_MS - PACKET_MIN_MS) * share
}

export interface PacketSpec { purpose: PacketPurpose; from: string; to: string; fromPoint: Point; toPoint: Point }

export function createPacket(id: number, spec: PacketSpec, layout: ChamberLayout): PacketEffect {
  const distance = Math.hypot(spec.toPoint.x - spec.fromPoint.x, spec.toPoint.y - spec.fromPoint.y)
  return { kind: 'packet', id, elapsed: 0, duration: packetDuration(spec.fromPoint, spec.toPoint, layout),
    ...spec, arcHeight: Math.min(160, 40 + distance * 0.2) }
}

/** The packet's position on its arc at its current elapsed time. */
export function packetPoint(packet: PacketEffect): Point {
  const t = packet.duration > 0 ? Math.min(1, packet.elapsed / packet.duration) : 1
  return {
    x: packet.fromPoint.x + (packet.toPoint.x - packet.fromPoint.x) * t,
    y: packet.fromPoint.y + (packet.toPoint.y - packet.fromPoint.y) * t - Math.sin(Math.PI * t) * packet.arcHeight
  }
}

interface RingSpec { orderId: string; origin: Point; targets: Array<{ id: string; point: Point }> }

/** A ring from `origin` that reaches each target when its radius passes the target's distance at send time. */
export function createRing(id: number, spec: RingSpec, layout: ChamberLayout): RingEffect {
  const { orderId, origin, targets } = spec
  const { width } = layout.size
  const maxRadius = Math.max(1, ...[[0, 0], [0, layout.floorY], [width, 0], [width, layout.floorY]]
    .map(([x, y]) => Math.hypot(x! - origin.x, y! - origin.y)))
  const reach = targets.map((target) => ({ id: target.id,
    at: Math.min(RING_MS, Math.hypot(target.point.x - origin.x, target.point.y - origin.y) / maxRadius * RING_MS) }))
  reach.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
  return { kind: 'ring', id, elapsed: 0, duration: RING_MS, orderId, origin, maxRadius, targets: reach }
}

export function ringRadius(ring: RingEffect): number {
  return ring.maxRadius * Math.min(1, ring.elapsed / ring.duration)
}

/** A beam-in column over the teleport pad. */
export function createBeam(id: number, layout: ChamberLayout): BeamEffect {
  return { kind: 'beam', id, elapsed: 0, duration: BEAM_MS, x: layout.teleportPad.centerX,
    y: layout.floorY, height: layout.floorY }
}

/** Seeded sparks bursting from each origin; returns the effect and the next seed. */
export function createSparks(id: number, origins: Point[], seed: number): [SparksEffect, number] {
  let next = seed
  const sparks: Spark[] = []
  for (const origin of origins) {
    for (let index = 0; index < 4; index += 1) {
      const [angle, afterAngle] = drawRandom(next)
      const [speed, afterSpeed] = drawRandom(afterAngle)
      next = afterSpeed
      const radians = Math.PI * (1.1 + angle * 0.8)
      const velocity = 120 + speed * 220
      sparks.push({ x: origin.x, y: origin.y, vx: Math.cos(radians) * velocity, vy: Math.sin(radians) * velocity })
    }
  }
  return [{ kind: 'sparks', id, elapsed: 0, duration: SPARKS_MS, sparks }, next]
}

export function sparkPoint(spark: Spark, elapsed: number): Point {
  const t = Math.max(0, elapsed) / 1000
  return { x: spark.x + spark.vx * t, y: spark.y + spark.vy * t + 0.5 * SPARK_GRAVITY * t * t }
}

function advanceRing(ring: RingEffect, elapsed: number, arrivals: EffectArrival[]): RingEffect | null {
  const reached = ring.targets.filter((target) => target.at <= elapsed)
  const next = { ...ring, elapsed, targets: ring.targets.slice(reached.length) }
  for (const target of reached) arrivals.push({ kind: 'ring', ring: next, id: target.id })
  return elapsed >= ring.duration && next.targets.length === 0 ? null : next
}

/**
 * Advances every effect by `dtMs`. Packets arrive at their duration; ring arrivals come nearest first.
 * Finished effects are removed.
 */
export function advanceEffects(effects: ChamberEffect[], dtMs: number):
  { effects: ChamberEffect[]; arrivals: EffectArrival[] } {
  const arrivals: EffectArrival[] = []
  const next: ChamberEffect[] = []
  for (const effect of effects) {
    const elapsed = Math.min(effect.duration, effect.elapsed + dtMs)
    if (effect.kind === 'ring') {
      const ring = advanceRing(effect, elapsed, arrivals)
      if (ring) next.push(ring)
      continue
    }
    if (elapsed < effect.duration) {
      next.push({ ...effect, elapsed })
      continue
    }
    if (effect.kind === 'packet') arrivals.push({ kind: 'packet', packet: { ...effect, elapsed } })
  }
  return { effects: next, arrivals }
}
