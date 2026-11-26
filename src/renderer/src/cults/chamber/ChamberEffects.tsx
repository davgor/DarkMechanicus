import type { CSSProperties } from 'react'
import {
  packetPoint, ringRadius, sparkPoint, type BeamEffect, type ChamberEffect, type PacketEffect, type RingEffect,
  type SparksEffect
} from './effects'

const TRAIL_STEPS = 4
const TRAIL_MS = 40

const share = (effect: ChamberEffect): number => effect.duration > 0 ? Math.min(1, effect.elapsed / effect.duration) : 1

/** A glowing binharic dot on its arc with a short trail of earlier positions that fade. */
function Packet({ packet }: { packet: PacketEffect }): JSX.Element {
  const head = packetPoint(packet)
  const trail = Array.from({ length: TRAIL_STEPS }, (_, index) =>
    packetPoint({ ...packet, elapsed: Math.max(0, packet.elapsed - (index + 1) * TRAIL_MS) }))
  return <g className="cc-packet" data-effect="packet" data-purpose={packet.purpose}>
    {trail.map((point, index) => <circle key={index} className="cc-packet-trail" cx={point.x} cy={point.y}
      r={4 - index * 0.7} opacity={0.5 - index * 0.11} />)}
    <circle className="cc-packet-dot" cx={head.x} cy={head.y} r={5} />
  </g>
}

/** An expanding ellipse from the helm across the floor plane, fading as it grows. */
function Ring({ ring }: { ring: RingEffect }): JSX.Element {
  const radius = ringRadius(ring)
  return <ellipse className="cc-ring" data-effect="ring" cx={ring.origin.x} cy={ring.origin.y} rx={radius}
    ry={radius * 0.28} opacity={1 - share(ring)} />
}

/** A light column over the teleport pad that fades. */
function Beam({ beam }: { beam: BeamEffect }): JSX.Element {
  return <rect className="cc-beam" data-effect="beam" x={beam.x - 28} y={beam.y - beam.height} width={56}
    height={beam.height} opacity={1 - share(beam)} />
}

function Sparks({ sparks }: { sparks: SparksEffect }): JSX.Element {
  return <g className="cc-sparks" data-effect="sparks" opacity={1 - share(sparks)}>
    {sparks.sparks.map((spark, index) => {
      const point = sparkPoint(spark, sparks.elapsed)
      return <circle key={index} className="cc-spark" cx={point.x} cy={point.y} r={2.2} />
    })}
  </g>
}

function Effect({ effect }: { effect: ChamberEffect }): JSX.Element {
  switch (effect.kind) {
    case 'packet': return <Packet packet={effect} />
    case 'ring': return <Ring ring={effect} />
    case 'beam': return <Beam beam={effect} />
    case 'sparks': return <Sparks sparks={effect} />
  }
}

export interface ChamberEffectsProps {
  effects: readonly ChamberEffect[]
  width: number
  height: number
  /** The room's run-state flags; the warning edge lights are drawn here. */
  warning: boolean
  stasis: boolean
}

/** The effects layer: every packet, ring, beam and spark burst from the chamber state, plus the run-state overlays. */
export function ChamberEffects({ effects, width, height, warning, stasis }: ChamberEffectsProps): JSX.Element {
  const style: CSSProperties = { width, height }
  return <div className="cc-effects">
    <svg className="cc-effects-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={style}>
      {effects.map((effect) => <Effect key={effect.id} effect={effect} />)}
    </svg>
    {warning && <div className="cc-warning-lights" data-effect="warning" />}
    {stasis && <div className="cc-stasis-overlay"><span className="cc-stasis-plate">STASIS</span></div>}
  </div>
}
