import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/src/styles.css'
import '../../src/renderer/src/graph/graph.css'
import './preview.css'
import { MascotSprite } from '../../src/renderer/src/mascot/MascotSprite'
import { createMotion, stepMotion, type MotionAction, type MotionState, type MotionSurfaces } from '../../src/renderer/src/mascot/motion'

const actions: MotionAction[] = ['idle', 'walk', 'run', 'jump', 'climb', 'stumble']
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

function Preview(): JSX.Element {
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
  return <main className="preview">
    <h1>Mascot action preview</h1>
    <p>Live atlas playback at the same scale as the ticket board. The lower board starts with a side jump, climbs the center ticket, then roams.</p>
    <section className="preview-actions" aria-label="Six sprite actions">
      {actions.map((action) => {
        const cycle = action === 'jump' ? 800 : action === 'stumble' ? 900 : 1200
        const elapsed = time % cycle
        return <div className="preview-action" key={action}>
          <strong>{action}</strong>
          <MascotSprite motion={{ ...createMotion(2, { x: 100, y: 140 }), action, elapsed, progress: elapsed / cycle }} playbackMs={time} />
        </div>
      })}
    </section>
    <h2>Multi-ticket climb route</h2>
    <div className="preview-board">
      {board.tickets.map((ticket) => <div key={ticket.id} className="preview-ticket" style={{ left: ticket.x, top: ticket.y, width: ticket.width, height: ticket.height }}>{ticket.id}</div>)}
      <MascotSprite motion={motion} playbackMs={time} />
      <span className="preview-state">{motion.action} · {motion.targetId ?? motion.supportId ?? 'floor'}</span>
    </div>
  </main>
}

createRoot(document.getElementById('root')!).render(<Preview />)
