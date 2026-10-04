import atlas from '../assets/mascot/atlas.json'
import climbImage from '../assets/mascot/climb.png'
import drillImage from '../assets/mascot/drill.png'
import idleImage from '../assets/mascot/idle.png'
import jumpImage from '../assets/mascot/jump.png'
import runImage from '../assets/mascot/run.png'
import stumbleImage from '../assets/mascot/stumble.png'
import walkImage from '../assets/mascot/walk.png'
import type { MotionAction, MotionFacing } from './motion'

const CELL_SIZE = 100
const IMAGES: Record<MotionAction | 'drill', string> = {
  idle: idleImage, walk: walkImage, run: runImage,
  jump: jumpImage, climb: climbImage, stumble: stumbleImage, drill: drillImage
}

export function frameForMotion(action: MotionAction | 'drill', elapsed: number, progress: number) {
  const clip = atlas.actions[action]
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
interface SpritePose {
  action: MotionAction | 'drill'
  elapsed: number
  progress: number
  facing: MotionFacing
  x: number
  y: number
}

export function spritePlacement({ action, elapsed, progress, facing, x, y }: SpritePose) {
  const { clip, frame, index } = frameForMotion(action, elapsed, progress)
  const scale = CELL_SIZE / atlas.cell.width * clip.renderScale
  const anchor = frame.footAnchor ?? clip.footAnchor
  const mirrored = facing === 'left'
  const anchorX = (mirrored ? frame.width - anchor.x : anchor.x) * scale
  return {
    frame, index, image: IMAGES[action], scale, mirrored, anchorX,
    left: x - anchorX, top: y - anchor.y * scale,
    width: frame.width * scale, height: frame.height * scale,
    sheetWidth: atlas.cell.width * 3 * scale, sheetHeight: atlas.cell.height * 2 * scale
  }
}
