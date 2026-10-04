import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { Node, Viewport } from '@xyflow/react'
import { usePersistentState } from '../app/usePersistentState'
import { ticketSurfaces } from './geometry'
import { MascotSprite } from './MascotSprite'
import { createMotion, stepMotion, type MotionState, type MotionSurfaces } from './motion'

const SIZE = { width: 52, height: 80 }
const PREFERENCE_KEY = 'mascotMotionPaused'
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'

function useBoardSize(board: RefObject<HTMLElement>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const element = board.current
    if (!element) return
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [board])
  return size
}

function useMotionPreference(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!media) return
    const changed = () => setReduced(media.matches)
    media.addEventListener('change', changed)
    return () => media.removeEventListener('change', changed)
  }, [])
  return reduced
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => !document.hidden)
  useEffect(() => {
    const changed = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])
  return visible
}

function useMascotMotion(surfaces: MotionSurfaces, active: boolean): { motion: MotionState; playbackMs: number } {
  const [display, setDisplay] = useState(() => ({ motion: createMotion(0x5eed), playbackMs: 0 }))
  const motionRef = useRef(display.motion)
  const playbackRef = useRef(0)
  const initialized = useRef(false)
  const surfacesRef = useRef(surfaces)
  surfacesRef.current = surfaces
  useEffect(() => {
    if (surfaces.viewport.width <= 0 || surfaces.viewport.height <= 0) return
    const next = initialized.current
      ? stepMotion(motionRef.current, 0, surfaces)
      : createMotion(0x5eed, { x: surfaces.viewport.width / 2, y: surfaces.viewport.height })
    initialized.current = true
    motionRef.current = next
    setDisplay({ motion: next, playbackMs: playbackRef.current })
  }, [surfaces.viewport.width, surfaces.viewport.height])
  useEffect(() => {
    if (!active || surfaces.viewport.width <= 0 || surfaces.viewport.height <= 0) return
    let handle = 0
    let previousTime: number | null = null
    const frame = (time: number) => {
      const current = surfacesRef.current
      const delta = previousTime === null ? 0 : Math.max(0, Math.min(time - previousTime, 50))
      motionRef.current = stepMotion(motionRef.current, delta, current)
      playbackRef.current += delta
      previousTime = time
      setDisplay({ motion: motionRef.current, playbackMs: playbackRef.current })
      handle = requestAnimationFrame(frame)
    }
    handle = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(handle)
  }, [active, surfaces.viewport.width, surfaces.viewport.height])
  return display
}

export function GraphMascot({ board, nodes, viewport }: {
  board: RefObject<HTMLElement>
  nodes: Node[]
  viewport: Viewport
}): JSX.Element {
  const size = useBoardSize(board)
  const [paused, setPaused] = usePersistentState(PREFERENCE_KEY, false, isBoolean)
  const reduced = useMotionPreference()
  const visible = usePageVisible()
  const surfaces: MotionSurfaces = useMemo(() => ({
    viewport: size, mascotSize: SIZE, tickets: ticketSurfaces(nodes, viewport)
  }), [size, nodes, viewport])
  const active = !paused && !reduced && visible
  const { motion, playbackMs } = useMascotMotion(surfaces, active)
  const displayed = reduced ? createMotion(0x5eed, { x: size.width / 2, y: size.height }) : motion
  return <>
    <div className="pg-mascot-layer" data-animated={active}>
      {size.width > 0 && size.height > 0 && <MascotSprite motion={displayed} playbackMs={reduced ? 0 : playbackMs} />}
    </div>
    <button
      type="button"
      className="pg-mascot-toggle"
      aria-label={paused ? 'Resume mascot animation' : 'Pause mascot animation'}
      aria-pressed={paused}
      onClick={() => setPaused((value) => !value)}
    >{paused ? '▶ Mascot' : 'Ⅱ Mascot'}</button>
  </>
}
