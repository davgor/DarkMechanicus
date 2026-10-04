import type { MotionState } from './motion'
import atlas from '../assets/mascot/atlas.json'
import { spritePlacement } from './sprite'

/** Decorative raster frame; its whole overlay is transparent to graph gestures. */
export function MascotSprite({ motion, playbackMs = motion.elapsed }: { motion: MotionState & { working?: boolean; resting?: boolean }; playbackMs?: number }): JSX.Element {
  const action = motion.working ? 'drill' : motion.action
  const elapsed = atlas.actions[action].loop && !motion.resting ? playbackMs : motion.elapsed
  const progress = motion.falling && action === 'stumble' ? Math.min(motion.progress, 0.49) : motion.progress
  const pose = spritePlacement({ ...motion, action, elapsed, progress })
  return <div
    className="pg-mascot-sprite"
    aria-hidden="true"
    data-action={action}
    data-frame={pose.index}
    style={{
      left: pose.left, top: pose.top, width: pose.width, height: pose.height,
      backgroundImage: `url("${pose.image}")`,
      backgroundSize: `${pose.sheetWidth}px ${pose.sheetHeight}px`,
      backgroundPosition: `${-pose.frame.x * pose.scale}px ${-pose.frame.y * pose.scale}px`,
      transform: pose.mirrored ? 'scaleX(-1)' : undefined
    }}
  />
}
