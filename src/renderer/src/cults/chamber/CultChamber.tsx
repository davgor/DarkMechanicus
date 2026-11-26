import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { MascotSprite } from '../../mascot/MascotSprite'
import type { MotionState } from '../../mascot/motion'
import { useMotionPreference, usePageVisible } from '../../mascot/motionGuards'
import { CHAMBER_CLIPS, CHAMBER_PROPS, SCENERY_IMAGES } from './chamberArt'
import {
  applyChamberEvent, createChamber, staticChamber, stepChamber,
  type ChamberAcolyte, type ChamberEvent, type ChamberState
} from './chamberState'
import { chamberLayout, type ChamberLayout, type Rect, type Size } from './layout'
import { MagosSprite } from './MagosSprite'
import './chamber.css'

export interface ChamberMember {
  id: string
  name: string
  /** Robe tint as a hue rotation in degrees; 0 keeps the red robe. The name plate border takes the same hue. */
  hue: number
}

export interface CultChamberProps {
  /** An append-only log: entries past those already applied are applied once, in order. A shorter log starts afresh
   * from its end, replaying nothing. */
  events: readonly ChamberEvent[]
  /** Seeds the simulation once, at mount. */
  seed: number
  /** Shown inside the viewscreen's window; it stays outside the decorative scene so its controls remain reachable. */
  viewscreen?: ReactNode
  selectedMemberId?: string | null
  onSelectMember: (id: string) => void
  members: readonly ChamberMember[]
}

/** Frame deltas are clamped, as in GraphMascot, so a stalled tab never teleports anyone. */
const MAX_FRAME_MS = 50

const rectStyle = (rect: Rect): CSSProperties => ({ left: rect.x, top: rect.y, width: rect.width, height: rect.height })

/**
 * The backdrop scaled so its measured floor line lands on the room's floor line, at least covering the room, and
 * centred horizontally.
 */
export function backdropRect(layout: ChamberLayout, backdrop: { width: number; height: number; floorY: number }): Rect {
  const { width, height } = layout.size
  const below = backdrop.height - backdrop.floorY
  const scale = Math.max(width / backdrop.width, layout.floorY / backdrop.floorY,
    below > 0 ? (height - layout.floorY) / below : 0)
  return { x: (width - backdrop.width * scale) / 2, y: layout.floorY - backdrop.floorY * scale,
    width: backdrop.width * scale, height: backdrop.height * scale }
}

/** The door stands open while a departing acolyte is passing through it. */
export function doorOpen(state: ChamberState, layout: ChamberLayout): boolean {
  const reach = layout.door.bounds.x + layout.door.bounds.width + layout.spriteSize.width
  return state.acolytes.some((acolyte) => acolyte.mode === 'leaving' && acolyte.x <= reach)
}

/** A glowing conduit along the helm's top rim from the end of its standable top to the room's right edge. */
function conduitRect(layout: ChamberLayout): Rect {
  const { bounds, top } = layout.helm
  const thickness = Math.max(4, bounds.height * 0.04)
  const x = top.x + top.width
  return { x, y: top.y + thickness, width: Math.max(0, layout.size.width - x), height: thickness }
}

function useRoomSize(room: RefObject<HTMLElement>): Size {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const element = room.current
    if (!element) return
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [room])
  return size
}

/** Whether any of the room is inside the viewport; assumed so where IntersectionObserver is missing. */
function useOnScreen(room: RefObject<HTMLElement>): boolean {
  const [onScreen, setOnScreen] = useState(true)
  useEffect(() => {
    const element = room.current
    if (!element || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      const latest = entries.at(-1)
      if (latest) setOnScreen(latest.isIntersecting)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [room])
  return onScreen
}

function drainEvents(state: ChamberState, log: readonly ChamberEvent[], cursor: { current: number },
  layout: ChamberLayout): ChamberState {
  if (log.length < cursor.current) cursor.current = log.length
  let next = state
  for (; cursor.current < log.length; cursor.current += 1) next = applyChamberEvent(next, log[cursor.current]!, layout)
  return next
}

/**
 * The chamber state. While `active`, one requestAnimationFrame loop applies new events and steps every actor;
 * otherwise new events are applied at once and nothing moves. Events wait until the room has a size.
 */
function useChamberSimulation(events: readonly ChamberEvent[], seed: number, layout: ChamberLayout,
  active: boolean): ChamberState {
  const stateRef = useRef<ChamberState | null>(null)
  stateRef.current ??= createChamber(seed, CHAMBER_CLIPS)
  const [view, setView] = useState(stateRef.current)
  const cursor = useRef(0)
  const eventsRef = useRef(events)
  eventsRef.current = events
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const ready = layout.size.width > 0 && layout.size.height > 0
  useEffect(() => {
    if (active || !ready) return
    stateRef.current = drainEvents(stateRef.current!, events, cursor, layout)
    setView(stateRef.current)
  }, [active, ready, events, layout])
  useEffect(() => {
    if (!active || !ready) return
    let handle = 0
    let previous: number | null = null
    const frame = (time: number): void => {
      const delta = previous === null ? 0 : Math.max(0, Math.min(time - previous, MAX_FRAME_MS))
      previous = time
      const drained = drainEvents(stateRef.current!, eventsRef.current, cursor, layoutRef.current)
      stateRef.current = stepChamber(drained, delta, layoutRef.current)
      setView(stateRef.current)
      handle = requestAnimationFrame(frame)
    }
    handle = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(handle)
  }, [active, ready])
  return view
}

function Prop({ src, rect, kind }: { src: string; rect: Rect; kind: string }): JSX.Element {
  return <img className="cc-prop" data-prop={kind} src={src} alt="" draggable={false} style={rectStyle(rect)} />
}

function Scenery({ layout, open }: { layout: ChamberLayout; open: boolean }): JSX.Element {
  return <>
    <img className="cc-backdrop" src={SCENERY_IMAGES.backdrop} alt="" draggable={false}
      style={rectStyle(backdropRect(layout, CHAMBER_PROPS.backdrop))} />
    <img className="cc-viewscreen" src={SCENERY_IMAGES.viewscreen} alt="" draggable={false}
      style={rectStyle(layout.viewscreen.rect)} />
    <div className="cc-props">
      <Prop kind={open ? 'door-open' : 'door-closed'} rect={layout.door.rect}
        src={open ? SCENERY_IMAGES.doorOpen : SCENERY_IMAGES.doorClosed} />
      <Prop kind="teleport-pad" rect={layout.teleportPad.rect} src={SCENERY_IMAGES.teleportPad} />
      {layout.consoles.map((item) => <Prop key={item.id} kind="console" rect={item.rect} src={SCENERY_IMAGES.console} />)}
      <Prop kind="helm" rect={layout.helm.rect} src={SCENERY_IMAGES.helm} />
      <div className="cc-conduit" style={rectStyle(conduitRect(layout))} />
    </div>
  </>
}

/** The acolyte's simulated pose as the mascot sprite reads it; only a wandering acolyte keeps its engine flags. */
function spriteMotion(acolyte: ChamberAcolyte): MotionState {
  const wandering = acolyte.mode === 'wandering'
  return { ...acolyte.motion, x: acolyte.x, y: acolyte.y, facing: acolyte.facing, progress: acolyte.progress,
    elapsed: acolyte.poseElapsed, falling: wandering && acolyte.motion.falling, resting: false }
}

interface AcolyteProps {
  acolyte: ChamberAcolyte
  member: ChamberMember | undefined
  scale: number
  selected: boolean
  onSelect: (id: string) => void
}

function Acolyte({ acolyte, member, scale, selected, onSelect }: AcolyteProps): JSX.Element {
  const tint = { '--member-hue': `${member?.hue ?? 0}deg` } as CSSProperties
  return <div className="cc-acolyte" data-member-id={acolyte.id} data-selected={selected} data-mode={acolyte.mode}
    style={tint} onClick={() => onSelect(acolyte.id)}>
    <MascotSprite motion={spriteMotion(acolyte)} action={acolyte.pose} playbackMs={acolyte.poseElapsed} scale={scale} />
    <span className="cc-nameplate" style={{ left: acolyte.x, top: acolyte.y + 2 }}>{member?.name ?? acolyte.id}</span>
  </div>
}

/**
 * The cult chamber: backdrop, viewscreen, props, the Magos at the helm and a tinted, name-plated acolyte per member,
 * driven by the chamber simulation. Decorative: the Cult page's roster carries every fact and control.
 */
export function CultChamber({ events, seed, viewscreen, selectedMemberId, onSelectMember, members }: CultChamberProps): JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const size = useRoomSize(root)
  const onScreen = useOnScreen(root)
  const reduced = useMotionPreference()
  const visible = usePageVisible()
  const layout = useMemo(() => chamberLayout(size, CHAMBER_PROPS, members.length), [size, members.length])
  const active = !reduced && visible && onScreen
  const state = useChamberSimulation(events, seed, layout, active)
  const shown = useMemo(() => reduced ? staticChamber(state, layout) : state, [reduced, state, layout])
  const roster = useMemo(() => new Map(members.map((member) => [member.id, member])), [members])
  const ready = size.width > 0 && size.height > 0
  return <div ref={root} className="cc-chamber" data-animated={active && ready}
    style={{ '--cc-sprite-scale': layout.spriteScale } as CSSProperties}>
    {ready && <>
      <div className="cc-scene" aria-hidden="true">
        <Scenery layout={layout} open={doorOpen(shown, layout)} />
        <MagosSprite magos={shown.magos} layout={layout} />
        <div className="cc-actors">
          {shown.acolytes.map((acolyte) => <Acolyte key={acolyte.id} acolyte={acolyte} member={roster.get(acolyte.id)}
            scale={layout.spriteScale} selected={acolyte.id === selectedMemberId} onSelect={onSelectMember} />)}
        </div>
        <div className="cc-effects" />
      </div>
      <div className="cc-viewscreen-window" style={rectStyle(layout.viewscreen.window)}>{viewscreen}</div>
    </>}
  </div>
}
