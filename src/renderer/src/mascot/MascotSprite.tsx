import type { MotionState } from './motion'
import { MASCOT_SHEET, spritePlacement, spriteStyle, type MascotAction } from './sprite'

interface MascotSpriteProps {
  motion: MotionState & { working?: boolean; resting?: boolean }
  playbackMs?: number
  /** Plays this atlas instead of the one the motion selects (the chamber's salute and type poses). */
  action?: MascotAction
  /** Size factor on the 100 px sprite cell (default 1). */
  scale?: number
}

/** Decorative raster frame; its whole overlay is transparent to graph gestures. */
export function MascotSprite({ motion, playbackMs = motion.elapsed, action: override, scale }: MascotSpriteProps): JSX.Element {
  const action = override ?? (motion.working ? 'drill' : motion.action)
  const elapsed = MASCOT_SHEET.atlas.actions[action].loop && !motion.resting ? playbackMs : motion.elapsed
  const progress = motion.falling && action === 'stumble' ? Math.min(motion.progress, 0.49) : motion.progress
  const pose = spritePlacement({ ...motion, action, elapsed, progress, scale })
  return <div className="pg-mascot-sprite" aria-hidden="true" data-action={action} data-frame={pose.index}
    style={spriteStyle(pose)} />
}
