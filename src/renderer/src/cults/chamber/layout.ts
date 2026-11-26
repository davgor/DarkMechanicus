import type { MotionFacing, MotionRect, MotionSurfaces } from '../../mascot/motion'

export interface Size { width: number; height: number }
export interface Rect { x: number; y: number; width: number; height: number }

/** A prop's flat standable top, in image pixels: the x range and the y of the surface. */
export interface StandTop { left: number; right: number; y: number }

/** A prop image's pixel size; `footY` is the image row that rests on the floor (defaults to the bottom). */
export interface PropImage { width: number; height: number; footY?: number }

/** Prop metrics shaped like the art ticket's `props.json`, in image pixels. */
export interface ChamberPropMetrics {
  helm: PropImage & { standTop: StandTop }
  console: PropImage & { standTop: StandTop }
  teleportPad: PropImage
  door: PropImage & { doorway: Rect }
  viewscreen: PropImage & { window: Rect }
}

export interface ChamberConsole {
  id: string
  rect: Rect
  /** The console's flat top as a motion-engine platform. */
  top: MotionRect
  /** Where a working acolyte stands to type, and which way it faces. */
  operatorX: number
  operatorFacing: MotionFacing
}

export interface ChamberLayout {
  size: Size
  floorY: number
  /** Scale from prop image pixels to room pixels. */
  propScale: number
  /** Acolyte sprite scale: 1 for up to 6 acolytes, falling linearly to 0.6 at 24. */
  spriteScale: number
  spriteSize: Size
  magosSize: Size
  helm: { rect: Rect; top: MotionRect }
  /** The Magos's feet, centred on the helm's standable top. */
  magos: { x: number; y: number }
  door: { rect: Rect; doorway: Rect; exitX: number }
  teleportPad: { rect: Rect; centerX: number }
  viewscreen: { rect: Rect; window: Rect }
  consoles: ChamberConsole[]
  /** Motion-engine surfaces: the floor line is the viewport bottom; console tops and the helm are platforms;
   * acolytes free-roam rather than seek the highest platform. */
  surfaces: MotionSurfaces
}

export const MAX_CONSOLES = 6
export const BACKDROP_HEIGHT = 1200
/** The floor line as a fraction of the room height. */
export const FLOOR_RATIO = 0.88
export const BASE_SPRITE: Readonly<Size> = { width: 52, height: 80 }
const MAGOS_FACTOR = 1.45
/** Free floor beside each console for its operator, in room pixels. */
const OPERATOR_ROOM = BASE_SPRITE.width
const FIXED_PROPS_SHARE = 0.7
const finite = (value: number): number => Number.isFinite(value) ? value : 0
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))

/** 1 for up to 6 acolytes, falling linearly to 0.6 at 24 and staying there. */
export function spriteScaleFor(headcount: number): number {
  const count = finite(headcount)
  if (count <= 6) return 1
  if (count >= 24) return 0.6
  return 1 - 0.4 * (count - 6) / 18
}

function placeOnFloor(prop: PropImage, x: number, floorY: number, scale: number): Rect {
  const footY = prop.footY ?? prop.height
  return { x, y: floorY - footY * scale, width: prop.width * scale, height: prop.height * scale }
}

function scaledRect(inner: Rect, outer: Rect, scale: number): Rect {
  return { x: outer.x + inner.x * scale, y: outer.y + inner.y * scale,
    width: inner.width * scale, height: inner.height * scale }
}

/** A standable top as a platform whose bottom sits just above the floor, so the engine can climb it. */
function platform(id: string, rect: Rect, top: StandTop, place: { scale: number; floorY: number }): MotionRect {
  const { scale, floorY } = place
  const y = rect.y + top.y * scale
  const x = rect.x + top.left * scale
  return { id, x, y, width: Math.max(0, (top.right - top.left) * scale), height: Math.max(1, floorY - y - 2) }
}

function propScaleFor(size: Size, props: ChamberPropMetrics): number {
  const fixedWidth = props.door.width + props.teleportPad.width + props.helm.width
  const byHeight = size.height / BACKDROP_HEIGHT
  const byWidth = fixedWidth > 0 ? size.width * FIXED_PROPS_SHARE / fixedWidth : byHeight
  return Math.max(0, Math.min(byHeight, byWidth))
}

function viewscreenRect(size: Size, floorY: number, props: ChamberPropMetrics, scale: number): Rect {
  const box = { x: size.width / 3, y: 0, width: size.width / 3, height: floorY / 3 }
  const { width, height } = props.viewscreen
  const fit = width > 0 && height > 0
    ? Math.min(scale, box.width * 0.9 / width, box.height * 0.9 / height) : 0
  return { x: box.x + (box.width - width * fit) / 2, y: box.y + (box.height - height * fit) / 2,
    width: width * fit, height: height * fit }
}

function layoutConsoles(span: { left: number; right: number }, props: ChamberPropMetrics,
  scale: number, floorY: number): ChamberConsole[] {
  const consoleWidth = props.console.width * scale
  const slotMinimum = consoleWidth + OPERATOR_ROOM
  const room = span.right - span.left
  const count = slotMinimum > 0 && room > 0 ? Math.min(MAX_CONSOLES, Math.floor(room / slotMinimum)) : 0
  const consoles: ChamberConsole[] = []
  for (let index = 0; index < count; index += 1) {
    const slot = room / count
    const x = span.left + index * slot + (slot - slotMinimum) / 2 + OPERATOR_ROOM
    const rect = placeOnFloor(props.console, x, floorY, scale)
    const id = `console-${index + 1}`
    consoles.push({ id, rect, top: platform(id, rect, props.console.standTop, { scale, floorY }),
      operatorX: rect.x - OPERATOR_ROOM / 2, operatorFacing: 'right' })
  }
  return consoles
}

/**
 * The chamber's geometry for a room of `size` CSS pixels: the floor line, the helm flush right,
 * the door at the left edge, the teleport pad left of the helm, the viewscreen in the back wall's
 * upper middle third, and up to six consoles spread evenly between door and pad.
 */
export function chamberLayout(size: Size, props: ChamberPropMetrics, headcount: number): ChamberLayout {
  const room = { width: Math.max(0, finite(size.width)), height: Math.max(0, finite(size.height)) }
  const floorY = room.height * FLOOR_RATIO
  const scale = propScaleFor(room, props)
  const gap = 16 * scale
  const helmRect = placeOnFloor(props.helm, room.width - props.helm.width * scale, floorY, scale)
  const helmTop = platform('helm', helmRect, props.helm.standTop, { scale, floorY })
  const doorRect = placeOnFloor(props.door, 0, floorY, scale)
  const doorway = scaledRect(props.door.doorway, doorRect, scale)
  const padRect = placeOnFloor(props.teleportPad,
    helmRect.x - gap - props.teleportPad.width * scale, floorY, scale)
  const spriteScale = spriteScaleFor(headcount)
  const spriteSize = { width: BASE_SPRITE.width * spriteScale, height: BASE_SPRITE.height * spriteScale }
  const half = spriteSize.width / 2
  const consoles = layoutConsoles({ left: doorRect.x + doorRect.width + gap, right: padRect.x - gap },
    props, scale, floorY)
  const viewRect = viewscreenRect(room, floorY, props, scale)
  const viewScale = props.viewscreen.width > 0 ? viewRect.width / props.viewscreen.width : 0
  return {
    size: room, floorY, propScale: scale, spriteScale, spriteSize,
    magosSize: { width: BASE_SPRITE.width * MAGOS_FACTOR, height: BASE_SPRITE.height * MAGOS_FACTOR },
    helm: { rect: helmRect, top: helmTop },
    magos: { x: helmTop.x + helmTop.width / 2, y: helmTop.y },
    door: { rect: doorRect, doorway,
      exitX: clamp(doorway.x + doorway.width / 2, half, Math.max(half, room.width - half)) },
    teleportPad: { rect: padRect,
      centerX: clamp(padRect.x + padRect.width / 2, half, Math.max(half, room.width - half)) },
    viewscreen: { rect: viewRect, window: scaledRect(props.viewscreen.window, viewRect, viewScale) },
    consoles,
    surfaces: {
      viewport: { width: room.width, height: floorY },
      mascotSize: spriteSize,
      tickets: [...consoles.map((item) => item.top), helmTop],
      freeRoam: true
    }
  }
}
