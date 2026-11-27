import type { CSSProperties } from 'react'
import mascotAtlas from '../assets/mascot/atlas.json'
import climbImage from '../assets/mascot/climb.png'
import drillImage from '../assets/mascot/drill.png'
import idleImage from '../assets/mascot/idle.png'
import jumpImage from '../assets/mascot/jump.png'
import runImage from '../assets/mascot/run.png'
import saluteImage from '../assets/mascot/salute.png'
import stumbleImage from '../assets/mascot/stumble.png'
import typeImage from '../assets/mascot/type.png'
import walkImage from '../assets/mascot/walk.png'
import type { MotionAction, MotionFacing } from './motion'

interface Point { x: number; y: number }
interface SpriteFrame { x: number; y: number; width: number; height: number; footAnchor?: Point }
export interface SpriteClip { fps: number; loop: boolean; renderScale: number; footAnchor: Point; frames: SpriteFrame[] }

/** One character's atlases: the shared 3×2-cell contract (`docs/mascot-sprites.md`) plus its sheet images. */
export interface SpriteSheet<A extends string> {
  atlas: { cell: { width: number; height: number }; actions: Record<A, SpriteClip> }
  images: Record<A, string>
  /** CSS pixels one atlas cell spans at scale 1, before the clip's render scale. */
  cellSize: number
  /** The way the art faces; the other way is drawn mirrored. */
  facing: MotionFacing
}

export type MascotAction = MotionAction | 'drill' | 'salute' | 'type'

export const MASCOT_SHEET: SpriteSheet<MascotAction> = {
  atlas: mascotAtlas,
  images: {
    idle: idleImage, walk: walkImage, run: runImage, jump: jumpImage, climb: climbImage,
    stumble: stumbleImage, drill: drillImage, salute: saluteImage, type: typeImage
  },
  cellSize: 100,
  facing: 'right'
}

const SHEET_COLUMNS = 3
const SHEET_ROWS = 2

interface FramePick { clip: SpriteClip; frame: SpriteFrame; index: number }

/** The frame to show: by clip rate, except that jump and stumble follow the movement's progress. */
export function frameForMotion(action: MascotAction, elapsed: number, progress: number): FramePick
export function frameForMotion<A extends string>(action: A, elapsed: number, progress: number,
  sheet: SpriteSheet<A>): FramePick
export function frameForMotion(action: string, elapsed: number, progress: number,
  sheet: SpriteSheet<string> = MASCOT_SHEET): FramePick {
  const clip = sheet.atlas.actions[action]!
  const count = clip.frames.length
  const elapsedIndex = Math.floor(Math.max(0, elapsed) * clip.fps / 1000)
  let index = clip.loop ? elapsedIndex % count : Math.min(count - 1, elapsedIndex)
  if (action === 'jump') {
    const p = Math.min(1, Math.max(0, progress))
    index = p < 0.14 ? 0 : p >= 0.86 ? 5 : 1 + Math.min(3, Math.floor((p - 0.14) / 0.72 * 4))
  }
  if (action === 'stumble') index = Math.min(count - 1, Math.floor(Math.max(0, progress) * count))
  return { clip, frame: clip.frames[index]!, index }
}

/** The placement makes the current frame's foot pixel equal the movement engine's (x,y). */
interface SpritePose<A extends string = MascotAction> {
  action: A
  elapsed: number
  progress: number
  facing: MotionFacing
  x: number
  y: number
  /** Extra size factor on top of the sheet's cell size (default 1). */
  scale?: number
}

interface SpritePlacement extends FramePick {
  image: string
  scale: number
  mirrored: boolean
  anchorX: number
  left: number
  top: number
  width: number
  height: number
  sheetWidth: number
  sheetHeight: number
}

export function spritePlacement(pose: SpritePose): SpritePlacement
export function spritePlacement<A extends string>(pose: SpritePose<A>, sheet: SpriteSheet<A>): SpritePlacement
export function spritePlacement(pose: SpritePose<string>, sheet: SpriteSheet<string> = MASCOT_SHEET): SpritePlacement {
  const { action, elapsed, progress, facing, x, y } = pose
  const { clip, frame, index } = frameForMotion(action, elapsed, progress, sheet)
  const { cell } = sheet.atlas
  const scale = sheet.cellSize / cell.width * clip.renderScale * (pose.scale ?? 1)
  const anchor = frame.footAnchor ?? clip.footAnchor
  const mirrored = facing !== sheet.facing
  const anchorX = (mirrored ? frame.width - anchor.x : anchor.x) * scale
  return {
    clip, frame, index, image: sheet.images[action]!, scale, mirrored, anchorX,
    left: x - anchorX, top: y - anchor.y * scale,
    width: frame.width * scale, height: frame.height * scale,
    sheetWidth: cell.width * SHEET_COLUMNS * scale, sheetHeight: cell.height * SHEET_ROWS * scale
  }
}

/** The inline style that shows a placement's frame from its sheet, mirrored when it faces the other way. */
export function spriteStyle(pose: SpritePlacement): CSSProperties {
  return {
    left: pose.left, top: pose.top, width: pose.width, height: pose.height,
    backgroundImage: `url("${pose.image}")`,
    backgroundSize: `${pose.sheetWidth}px ${pose.sheetHeight}px`,
    backgroundPosition: `${-pose.frame.x * pose.scale}px ${-pose.frame.y * pose.scale}px`,
    transform: pose.mirrored ? 'scaleX(-1)' : undefined
  }
}
