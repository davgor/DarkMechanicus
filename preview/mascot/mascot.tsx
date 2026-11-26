import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/src/styles.css'
import '../../src/renderer/src/graph/graph.css'
import './preview.css'
import { MascotSprite } from '../../src/renderer/src/mascot/MascotSprite'
import { createMotion, stepMotion, type MotionAction, type MotionState, type MotionSurfaces } from '../../src/renderer/src/mascot/motion'
import magosAtlas from '../../src/renderer/src/assets/magos/atlas.json'

const magosImages = import.meta.glob<string>('../../src/renderer/src/assets/magos/*.png', { eager: true, import: 'default' })
type MagosClip = (typeof magosAtlas.actions)['idle']
const MAGOS_SCALE = 150 / magosAtlas.cell.width

function MagosFrame({ name, clip, time }: { name: string; clip: MagosClip; time: number }): JSX.Element {
  const elapsed = clip.loop ? time : time % (clip.frames.length * 1000 / clip.fps + 800)
  const raw = Math.floor(elapsed * clip.fps / 1000)
  const frame = clip.frames[clip.loop ? raw % clip.frames.length : Math.min(clip.frames.length - 1, raw)]!
  const scale = MAGOS_SCALE * clip.renderScale
  return <div className="preview-action preview-magos" aria-label={`Magos ${name}`}>
    <strong>magos {name}</strong>
    <div style={{
      position: 'absolute', left: 100 - frame.footAnchor.x * scale, top: 150 - frame.footAnchor.y * scale,
      width: frame.width * scale, height: frame.height * scale,
      backgroundImage: `url("${magosImages[`../../src/renderer/src/assets/magos/${clip.image}`]}")`,
      backgroundSize: `${1536 * scale}px ${1024 * scale}px`,
      backgroundPosition: `${-frame.x * scale}px ${-frame.y * scale}px`
    }} />
  </div>
}
import { AcolyteLoop, ChamberComposition, type AcolyteAction } from './chamber'

const actions: Array<MotionAction | 'drill'> = ['idle', 'walk', 'run', 'jump', 'climb', 'stumble', 'drill']
const board: MotionSurfaces = {
  viewport: { width: 500, height: 320 }, mascotSize: { width: 52, height: 80 },
  tickets: [
    { id: 'ticket-a', x: 180, y: 150, width: 210, height: 72 },
    { id: 'ticket-b', x: 18, y: 40, width: 124, height: 66 },
    { id: 'ticket-c', x: 410, y: 38, width: 82, height: 68 }
  ]
}

function sideJump(): MotionState {
  return {
    ...createMotion(2, { x: 154, y: 320 }), action: 'jump', duration: 520,
    fromX: 154, fromY: 320, toX: 154, toY: 222,
    targetId: 'ticket-a', jumpHeight: 36
  }
}

/** Playback clock and roaming board motion, advanced once per animation frame. */
function usePlayback(): { time: number; motion: MotionState } {
  const [time, setTime] = useState(0)
  const [motion, setMotion] = useState(sideJump)
  useEffect(() => {
    let id = 0
    let last = 0
    const frame = (now: number) => {
      const delta = last === 0 ? 0 : Math.min(50, now - last)
      last = now
      setTime((value) => value + delta)
      setMotion((state) => stepMotion(state, delta, board))
      id = requestAnimationFrame(frame)
    }
    id = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(id)
  }, [])
  return { time, motion }
}

function Preview(): JSX.Element {
  const { time, motion } = usePlayback()
  return <main className="preview">
    <h1>Mascot action preview</h1>
    <p>Live atlas playback at the same scale as the ticket board. The lower board starts with a side jump, climbs the center ticket, then roams.</p>
    <section className="preview-actions" aria-label="Seven sprite actions">
      {actions.map((action) => {
        const cycle = action === 'jump' ? 800 : action === 'stumble' ? 900 : 1200
        const elapsed = time % cycle
        return <div className="preview-action" key={action}>
          <strong>{action}</strong>
          <MascotSprite motion={{ ...createMotion(2, { x: 100, y: 140 }), action: action === 'drill' ? 'idle' : action, elapsed, progress: elapsed / cycle, working: action === 'drill' }} playbackMs={time} />
        </div>
      })}
    </section>
    <h2>Magos actions</h2>
    <p>The cult chamber Magos atlases, looping one-shots after a short hold, beside the mascot&apos;s.</p>
    <section className="preview-actions" aria-label="Seven Magos actions">
      {Object.entries(magosAtlas.actions).map(([name, clip]) => <MagosFrame key={name} name={name} clip={clip} time={time} />)}
    </section>
    <h2>Resting drill pose</h2>
    <div className="preview-action" aria-label="Paused drill frame">
      <strong>fixed drill frame</strong>
      <MascotSprite motion={{ ...createMotion(2, { x: 100, y: 140 }), action: 'idle', elapsed: 250, working: true, resting: true }} playbackMs={time} />
    </div>
    <h2>Acolyte salute and type</h2>
    <section className="preview-actions" aria-label="Acolyte salute and type loops">
      {(['salute', 'type'] as AcolyteAction[]).map((action) => <div className="preview-action" key={action}>
        <strong>{action}</strong>
        <AcolyteLoop action={action} time={time} x={100} y={140} size={100} />
      </div>)}
    </section>
    <h2>Chamber composition (1280×800)</h2>
    <p>Backdrop and props placed by the chamber layout from the measured props.json: a typing acolyte beside each console, the saluting Magos on the helm, the door toggling open and closed. Outlines mark the measured stand tops, screen window and doorway.</p>
    <ChamberComposition time={time} outlines />
    <ChamberComposition time={time} outlines={false} />
    <h2>Multi-ticket climb route</h2>
    <div className="preview-board">
      {board.tickets.map((ticket) => <div key={ticket.id} className="preview-ticket" style={{ left: ticket.x, top: ticket.y, width: ticket.width, height: ticket.height }}>{ticket.id}</div>)}
      <MascotSprite motion={motion} playbackMs={time} />
      <span className="preview-state">{motion.action} · {motion.targetId ?? motion.supportId ?? 'floor'}</span>
    </div>
  </main>
}

createRoot(document.getElementById('root')!).render(<Preview />)
