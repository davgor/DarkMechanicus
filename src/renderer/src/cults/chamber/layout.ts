import magosAtlas from '../../assets/magos/atlas.json'
import type { MotionFacing, MotionRect, MotionSurfaces } from '../../mascot/motion'

export interface Size { width: number; height: number }
export interface Rect { x: number; y: number; width: number; height: number }

/** A prop's flat standable top, in image pixels: the x range and the y of the surface. */
export interface StandTop { left: number; right: number; y: number }

/**
 * A prop image's pixel size; `footY` is the image row that rests on the floor (defaults to the bottom) and
 * `opaqueBounds` the painted part of the image (defaults to all of it). Props are spaced by their opaque part.
 */
export interface PropImage { width: number; height: number; footY?: number; opaqueBounds?: Rect }

/** A placed prop in room pixels: draw the whole image at `rect`; `bounds` is its opaque part. */
export interface PlacedProp { rect: Rect; bounds: Rect }

/** Prop metrics shaped like the art ticket's `props.json`, in image pixels. */
export interface ChamberPropMetrics {
  helm: PropImage & { standTop: StandTop }
  console: PropImage & { standTop: StandTop }
  teleportPad: PropImage
  door: PropImage & { doorway: Rect }
  viewscreen: PropImage & { window: Rect }
}

export interface ChamberConsole extends PlacedProp {
  id: string
  /** The console's flat top as a motion-engine platform. */
  top: MotionRect
  /** Where a working acolyte stands to type: right of the console at its keyboard deck, facing it. */
  operatorX: number
  operatorFacing: MotionFacing
}

export interface ChamberLayout {
  size: Size
  floorY: number
  /** Scale from prop image pixels to room pixels for the door, pad, helm and viewscreen. */
  propScale: number
  /** Scale for consoles, which are sized to the acolytes rather than to the room. */
  consoleScale: number
  /** Acolyte sprite scale: 1 for up to 6 acolytes, falling linearly to 0.6 at 24. */
  spriteScale: number
  spriteSize: Size
  magosSize: Size
  /** The Magos's 512 px atlas cell in room pixels, at render scale 1. */
  magosCell: number
  /** `reserve` is kept clear for the Magos: the helm plus his widest frame (the staff spans the whole cell). */
  helm: PlacedProp & { top: MotionRect; reserve: Rect }
  /** The Magos's feet, centred on the helm's standable top. */
  magos: { x: number; y: number }
  door: PlacedProp & { doorway: Rect; exitX: number }
  teleportPad: PlacedProp & { centerX: number }
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
/** The mascot's 512 px atlas cell is drawn this wide at sprite scale 1. */
export const SPRITE_CELL = 100
const MAGOS_FACTOR = 1.45
const MAGOS_CELL = SPRITE_CELL * MAGOS_FACTOR
/** Half the Magos's widest frame: his staff reaches nearly across the cell, at the largest render scale. */
const MAGOS_REACH = MAGOS_CELL * Math.max(...Object.values(magosAtlas.actions).map((clip) => clip.renderScale)) / 2
/** A console's opaque part stands as tall as an acolyte, which puts its keyboard deck at an acolyte's chest. */
const CONSOLE_HEIGHT = BASE_SPRITE.height
/** Free floor beside each console for its operator, in room pixels. */
const OPERATOR_ROOM = BASE_SPRITE.width
/** The room width the door, pad and helm (opaque parts) may take at most; consoles share the rest. */
const FIXED_PROPS_SHARE = 0.55
const finite = (value: number): number => Number.isFinite(value) ? value : 0
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))
const right = (rect: Rect): number => rect.x + rect.width

/** 1 for up to 6 acolytes, falling linearly to 0.6 at 24 and staying there. */
export function spriteScaleFor(headcount: number): number {
  const count = finite(headcount)
  if (count <= 6) return 1
  if (count >= 24) return 0.6
  return 1 - 0.4 * (count - 6) / 18
}

const opaqueOf = (prop: PropImage): Rect => prop.opaqueBounds ?? { x: 0, y: 0, width: prop.width, height: prop.height }

interface Placement { scale: number; floorY: number }

/** Stands a prop on the floor line with the left edge of its opaque part at room x `left`. */
function placeProp(prop: PropImage, left: number, place: Placement): PlacedProp {
  const { scale, floorY } = place
  const opaque = opaqueOf(prop)
  const rect = { x: left - opaque.x * scale, y: floorY - (prop.footY ?? prop.height) * scale,
    width: prop.width * scale, height: prop.height * scale }
  return { rect, bounds: scaledRect(opaque, rect, scale) }
}

function scaledRect(inner: Rect, outer: Rect, scale: number): Rect {
  return { x: outer.x + inner.x * scale, y: outer.y + inner.y * scale,
    width: inner.width * scale, height: inner.height * scale }
}

/** A standable top as a platform whose bottom sits just above the floor, so the engine can climb it. */
function platform(id: string, rect: Rect, top: StandTop, place: Placement): MotionRect {
  const { scale, floorY } = place
  const y = rect.y + top.y * scale
  const x = rect.x + top.left * scale
  return { id, x, y, width: Math.max(0, (top.right - top.left) * scale), height: Math.max(1, floorY - y - 2) }
}

function propScaleFor(size: Size, props: ChamberPropMetrics): number {
  const fixedWidth = opaqueOf(props.door).width + opaqueOf(props.teleportPad).width + opaqueOf(props.helm).width
  const byHeight = size.height / BACKDROP_HEIGHT
  const byWidth = fixedWidth > 0 ? size.width * FIXED_PROPS_SHARE / fixedWidth : byHeight
  return Math.max(0, Math.min(byHeight, byWidth))
}

/** The helm with its opaque right edge flush with the room, moved left only if the Magos's staff would leave it. */
function placeHelm(helmProp: ChamberPropMetrics['helm'], roomWidth: number, place: Placement) {
  const standCentre = (helmProp.standTop.left + helmProp.standTop.right) / 2
  const flush = placeProp(helmProp, roomWidth - opaqueOf(helmProp).width * place.scale, place)
  const overhang = Math.max(0, flush.rect.x + standCentre * place.scale + MAGOS_REACH - roomWidth)
  const helm = placeProp(helmProp, flush.bounds.x - overhang, place)
  const top = platform('helm', helm.rect, helmProp.standTop, place)
  const magos = { x: top.x + top.width / 2, y: top.y }
  const left = Math.min(helm.bounds.x, magos.x - MAGOS_REACH)
  const upper = Math.min(helm.bounds.y, magos.y - 2 * MAGOS_REACH)
  const reserve = { x: left, y: upper, width: Math.max(right(helm.bounds), magos.x + MAGOS_REACH) - left,
    height: place.floorY - upper }
  return { helm: { ...helm, top, reserve }, magos }
}

function viewscreenRect(size: Size, floorY: number, props: ChamberPropMetrics, scale: number): Rect {
  const box = { x: size.width / 3, y: 0, width: size.width / 3, height: floorY / 3 }
  const { width, height } = props.viewscreen
  const fit = width > 0 && height > 0
    ? Math.min(scale, box.width * 0.9 / width, box.height * 0.9 / height) : 0
  return { x: box.x + (box.width - width * fit) / 2, y: box.y + (box.height - height * fit) / 2,
    width: width * fit, height: height * fit }
}

/** Up to six consoles spread evenly over `span`, each with its operator's spot on its keyboard (right) side. */
function layoutConsoles(span: { left: number; right: number }, prop: ChamberPropMetrics['console'],
  floorY: number): ChamberConsole[] {
  const opaque = opaqueOf(prop)
  const place = { scale: opaque.height > 0 ? CONSOLE_HEIGHT / opaque.height : 0, floorY }
  const deskWidth = opaque.width * place.scale
  const slotMinimum = deskWidth + OPERATOR_ROOM
  const room = span.right - span.left
  const count = slotMinimum > 0 && room > 0 ? Math.min(MAX_CONSOLES, Math.floor(room / slotMinimum)) : 0
  const slot = count > 0 ? room / count : 0
  return Array.from({ length: count }, (_, index): ChamberConsole => {
    const placed = placeProp(prop, span.left + index * slot + (slot - slotMinimum) / 2, place)
    const id = `console-${index + 1}`
    return { id, ...placed, top: platform(id, placed.rect, prop.standTop, place),
      operatorX: placed.bounds.x + deskWidth + OPERATOR_ROOM / 2, operatorFacing: 'left' }
  })
}

/**
 * The chamber's geometry for a room of `size` CSS pixels: the floor line, the helm flush right (with room for
 * the Magos's staff), the door at the left edge, the teleport pad left of the helm, the viewscreen in the back
 * wall's upper middle third, and up to six acolyte-sized consoles spread evenly between door and pad.
 */
export function chamberLayout(size: Size, props: ChamberPropMetrics, headcount: number): ChamberLayout {
  const room = { width: Math.max(0, finite(size.width)), height: Math.max(0, finite(size.height)) }
  const floorY = room.height * FLOOR_RATIO
  const place = { scale: propScaleFor(room, props), floorY }
  const gap = 16 * place.scale
  const { helm, magos } = placeHelm(props.helm, room.width, place)
  const door = placeProp(props.door, 0, place)
  const doorway = scaledRect(props.door.doorway, door.rect, place.scale)
  const pad = placeProp(props.teleportPad,
    helm.reserve.x - gap - opaqueOf(props.teleportPad).width * place.scale, place)
  const spriteScale = spriteScaleFor(headcount)
  const spriteSize = { width: BASE_SPRITE.width * spriteScale, height: BASE_SPRITE.height * spriteScale }
  const half = spriteSize.width / 2
  const consoles = layoutConsoles({ left: right(door.bounds) + gap, right: pad.bounds.x - gap }, props.console, floorY)
  const viewRect = viewscreenRect(room, floorY, props, place.scale)
  const viewScale = props.viewscreen.width > 0 ? viewRect.width / props.viewscreen.width : 0
  const consoleOpaque = opaqueOf(props.console)
  return {
    size: room, floorY, propScale: place.scale, spriteScale, spriteSize,
    consoleScale: consoleOpaque.height > 0 ? CONSOLE_HEIGHT / consoleOpaque.height : 0,
    magosSize: { width: BASE_SPRITE.width * MAGOS_FACTOR, height: BASE_SPRITE.height * MAGOS_FACTOR },
    magosCell: MAGOS_CELL, helm, magos,
    door: { ...door, doorway,
      exitX: clamp(doorway.x + doorway.width / 2, half, Math.max(half, room.width - half)) },
    teleportPad: { ...pad,
      centerX: clamp(pad.bounds.x + pad.bounds.width / 2, half, Math.max(half, room.width - half)) },
    viewscreen: { rect: viewRect, window: scaledRect(props.viewscreen.window, viewRect, viewScale) },
    consoles,
    surfaces: {
      viewport: { width: room.width, height: floorY },
      mascotSize: spriteSize,
      tickets: [...consoles.map((item) => item.top), helm.top],
      freeRoam: true
    }
  }
}
