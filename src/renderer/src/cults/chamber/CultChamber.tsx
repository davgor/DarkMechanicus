import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { MascotSprite } from '../../mascot/MascotSprite'
import type { MotionState } from '../../mascot/motion'
import { useMotionPreference, usePageVisible } from '../../mascot/motionGuards'
import { ChamberEffects } from './ChamberEffects'
import { CHAMBER_CLIPS, CHAMBER_PROPS, SCENERY_IMAGES } from './chamberArt'
import {
  applyChamberEvent, createChamber, MAGOS_ID, staticChamber, stepChamber,
  type ChamberAcolyte, type ChamberEvent, type ChamberState
} from './chamberState'
import type { ChamberEffect } from './effects'
import { chamberLayout, type ChamberLayout, type Rect, type Size } from './layout'
import { MagosSprite } from './MagosSprite'
import { layoutPlates, plateMetrics, type PlatePlacement } from './plates'
import { layoutBubbles, SpeechBubble, type BubbleInput } from './SpeechBubble'
import './chamber.css'

export interface ChamberMember {
  id: string
  name: string
  /** Robe tint as a hue rotation in degrees; 0 keeps the red robe. The name plate border takes the same hue. */
  hue: number
}

interface CultChamberProps {
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
  /** No active run: the empty room with its lights off; no Magos, no acolytes, and nothing moves. */
  dark?: boolean
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
function doorOpen(state: ChamberState, layout: ChamberLayout): boolean {
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
  plate: PlatePlacement | undefined
  rowHeight: number
  outlined: boolean
  onSelect: (id: string) => void
}

function Acolyte({ acolyte, member, scale, selected, plate, rowHeight, outlined, onSelect }: AcolyteProps): JSX.Element {
  const tint = { '--member-hue': `${member?.hue ?? 0}deg` } as CSSProperties
  const row = plate?.row ?? 0
  return <div className="cc-acolyte" data-member-id={acolyte.id} data-selected={selected} data-mode={acolyte.mode}
    style={tint} onClick={() => onSelect(acolyte.id)}>
    <MascotSprite motion={spriteMotion(acolyte)} action={acolyte.pose} playbackMs={acolyte.poseElapsed} scale={scale} />
    <span className="cc-nameplate" data-row={row} data-hidden={plate?.hidden ?? false} data-outlined={outlined}
      style={{ left: acolyte.x, top: acolyte.y + 2 + row * rowHeight, maxWidth: plate?.width }}>
      {member?.name ?? acolyte.id}
    </span>
  </div>
}

export const OUTLINE_MS = 1600

/** Recipients of the orders among `effects` newer than `seen`: a packet's target, or every target of a ring. */
function orderRecipients(effects: readonly ChamberEffect[], seen: number): string[] {
  return effects.filter((effect) => effect.id > seen).flatMap((effect) => {
    if (effect.kind === 'ring') return effect.targets.map((target) => target.id)
    return effect.kind === 'packet' && effect.purpose === 'order' ? [effect.to] : []
  })
}

/**
 * Reduced motion replaces order packets and rings with a brief outline on the recipients' name plates. New orders
 * are read from the (unstepped) chamber state's effects; each outline clears after OUTLINE_MS.
 */
function useOrderOutlines(effects: readonly ChamberEffect[], reduced: boolean): ReadonlySet<string> {
  const [outlined, setOutlined] = useState<ReadonlySet<string>>(new Set())
  const seen = useRef(Number.POSITIVE_INFINITY)
  const newest = effects.reduce((most, effect) => Math.max(most, effect.id), 0)
  useEffect(() => {
    if (!reduced) {
      seen.current = Number.POSITIVE_INFINITY
      return
    }
    const fresh = Number.isFinite(seen.current) ? orderRecipients(effects, seen.current) : []
    seen.current = Math.max(Number.isFinite(seen.current) ? seen.current : 0, newest)
    if (fresh.length === 0) return
    setOutlined(new Set(fresh))
    const timer = window.setTimeout(() => setOutlined(new Set()), OUTLINE_MS)
    return () => window.clearTimeout(timer)
  }, [effects, newest, reduced])
  return reduced ? outlined : new Set()
}

interface BubbleContext {
  layout: ChamberLayout
  roster: ReadonlyMap<string, ChamberMember>
  selectedMemberId: string | null | undefined
}

/** Each shown bubble at its speaker's head, in the member colour or, for the Magos, brass. */
function bubbleInputs(state: ChamberState, { layout, roster, selectedMemberId }: BubbleContext): BubbleInput[] {
  return Object.entries(state.bubbles).flatMap(([id, bubble]): BubbleInput[] => {
    if (id === MAGOS_ID) {
      return [{ id, text: bubble.text, x: layout.magos.x, headY: layout.magos.y - layout.magosSize.height,
        color: 'var(--accent)', priority: true }]
    }
    const acolyte = state.acolytes.find((item) => item.id === id)
    if (!acolyte) return []
    return [{ id, text: bubble.text, x: acolyte.x, headY: acolyte.y - layout.spriteSize.height,
      color: `hsl(${roster.get(id)?.hue ?? 0} 70% 58%)`, priority: id === selectedMemberId }]
  })
}

interface SceneProps extends BubbleContext {
  state: ChamberState
  reduced: boolean
  outlined: ReadonlySet<string>
  onSelectMember: (id: string) => void
}

/** The decorative scene; its root carries the run-state theatrics as classes. */
function Scene({ state, layout, roster, selectedMemberId, reduced, outlined, onSelectMember }: SceneProps): JSX.Element {
  const plates = layoutPlates(state.acolytes.map((acolyte) => ({ id: acolyte.id, x: acolyte.x,
    name: roster.get(acolyte.id)?.name ?? acolyte.id,
    priority: outlined.has(acolyte.id) || acolyte.id in state.bubbles, forced: acolyte.id === selectedMemberId })),
  layout.spriteScale)
  const { rowHeight } = plateMetrics(layout.spriteScale)
  const bubbles = layoutBubbles(bubbleInputs(state, { layout, roster, selectedMemberId }), layout.size.width)
  const theatrics = ['cc-scene', state.stasis && 'cc-stasis', state.lightsDim && 'cc-lights-dim',
    state.blackout && 'cc-blackout', state.warning && 'cc-warning'].filter(Boolean).join(' ')
  return <div className={theatrics} aria-hidden="true" data-reduced={reduced}>
    <div className="cc-world">
      <Scenery layout={layout} open={doorOpen(state, layout)} />
      <MagosSprite magos={state.magos} layout={layout} />
      <div className="cc-actors">
        {state.acolytes.map((acolyte) => <Acolyte key={acolyte.id} acolyte={acolyte} member={roster.get(acolyte.id)}
          scale={layout.spriteScale} selected={acolyte.id === selectedMemberId} plate={plates.get(acolyte.id)}
          rowHeight={rowHeight} outlined={outlined.has(acolyte.id)} onSelect={onSelectMember} />)}
      </div>
      <div className="cc-bubbles">{bubbles.map((bubble) => <SpeechBubble key={bubble.id} bubble={bubble} />)}</div>
    </div>
    <div className="cc-shade" />
    <ChamberEffects effects={reduced ? [] : state.effects} width={layout.size.width} height={layout.size.height}
      warning={state.warning} stasis={state.stasis} />
  </div>
}

/** The room with no run: its scenery only, under the lights-off shade. */
function DarkScene({ layout }: { layout: ChamberLayout }): JSX.Element {
  return <div className="cc-scene cc-lights-off" aria-hidden="true">
    <div className="cc-world"><Scenery layout={layout} open={false} /></div>
    <div className="cc-shade" />
  </div>
}

/**
 * The cult chamber: backdrop, viewscreen, props, the Magos at the helm and a tinted, name-plated acolyte per member,
 * with speech bubbles, order and report effects and the run-state theatrics, all driven by the chamber simulation.
 * Decorative: the Cult page's roster carries every fact and control.
 */
export function CultChamber({ events, seed, viewscreen, selectedMemberId, onSelectMember, members, dark = false }: CultChamberProps): JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const size = useRoomSize(root)
  const onScreen = useOnScreen(root)
  const reduced = useMotionPreference()
  const visible = usePageVisible()
  const layout = useMemo(() => chamberLayout(size, CHAMBER_PROPS, members.length), [size, members.length])
  const active = !dark && !reduced && visible && onScreen
  const state = useChamberSimulation(events, seed, layout, active)
  const shown = useMemo(() => reduced ? staticChamber(state, layout) : state, [reduced, state, layout])
  const outlined = useOrderOutlines(state.effects, reduced)
  const roster = useMemo(() => new Map(members.map((member) => [member.id, member])), [members])
  const ready = size.width > 0 && size.height > 0
  return <div ref={root} className="cc-chamber" data-animated={active && ready}
    style={{ '--cc-sprite-scale': layout.spriteScale } as CSSProperties}>
    {ready && <>
      {dark ? <DarkScene layout={layout} /> : <Scene state={shown} layout={layout} roster={roster}
        selectedMemberId={selectedMemberId} reduced={reduced} outlined={outlined} onSelectMember={onSelectMember} />}
      <div className="cc-viewscreen-window" style={rectStyle(layout.viewscreen.window)}>{viewscreen}</div>
    </>}
  </div>
}
