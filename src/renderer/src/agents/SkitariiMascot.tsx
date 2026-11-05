import { useEffect, useRef, useState } from 'react'
import { MascotSprite } from '../mascot/MascotSprite'
import { createMotion } from '../mascot/motion'
import { useMotionPreference, usePageVisible } from '../mascot/motionGuards'

/** Where the mascot's feet stand in the 100 px sprite cell the stage draws. */
const FOOT = { x: 50, y: 90 }

interface SkitariiMascotProps {
  /** The terminal is receiving output: the mascot drills; otherwise it idles. */
  working: boolean
}

/**
 * The tech-priest beside a Skitarii chat's title, from the same sprite atlases the plan graph's mascot uses. It plays
 * the drill loop while `working` and the idle loop otherwise. It stands still for reduced motion and while the page is
 * hidden (as `GraphMascot` does); the pane's header says what is happening, so the mascot is decoration only.
 */
export function SkitariiMascot({ working }: SkitariiMascotProps): JSX.Element {
  const reduced = useMotionPreference()
  const visible = usePageVisible()
  const active = !reduced && visible
  const [playbackMs, setPlaybackMs] = useState(0)
  const playback = useRef(0)
  useEffect(() => {
    if (!active) return undefined
    let handle = 0
    let previous: number | null = null
    const frame = (time: number): void => {
      playback.current += previous === null ? 0 : Math.max(0, Math.min(time - previous, 50))
      previous = time
      setPlaybackMs(playback.current)
      handle = requestAnimationFrame(frame)
    }
    handle = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(handle)
  }, [active])
  const motion = { ...createMotion(0x5eed, FOOT), working }
  return (
    <div className="skitarii-mascot" data-animated={active} data-working={working}>
      <div className="skitarii-mascot-stage">
        <MascotSprite motion={motion} playbackMs={reduced ? 0 : playbackMs} />
      </div>
    </div>
  )
}
