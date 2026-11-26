import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/src/styles.css'
import '../../src/renderer/src/graph/graph.css'
import './preview.css'
import { CultChamber, type ChamberMember } from '../../src/renderer/src/cults/chamber/CultChamber'
import type { ChamberEvent, RunState } from '../../src/renderer/src/cults/chamber/chamberState'

const NAMES = ['Vexa-9', 'Orlok Teth', 'Kryz', 'Amaranth-3', 'Dorn Vel', 'Ixia', 'Thessaly', 'Corvax-7', 'Mordent',
  'Sable Quill', 'Hexa', 'Tarsis-2', 'Velk', 'Oriel', 'Brask', 'Nyx-4', 'Calder', 'Ferrum', 'Lumen', 'Gorrin',
  'Ostra-5', 'Pell', 'Rhune', 'Zeta Kahl', 'Ulric-8', 'Wyx']
const COUNTS = [6, 12, 24] as const
const DEMO_MS = 2200
const params = new URLSearchParams(window.location.search)

/** Member hues walk the colour wheel by the golden angle, so neighbours never share a robe. */
const memberFor = (index: number): ChamberMember =>
  ({ id: `acolyte-${index + 1}`, name: NAMES[index % NAMES.length]!, hue: Math.round(index * 137.5) % 360 })

function opening(count: number): { members: ChamberMember[]; events: ChamberEvent[] } {
  const members = Array.from({ length: count }, (_, index) => memberFor(index))
  return { members, events: [
    { type: 'runState', runState: 'running' },
    ...members.map((member): ChamberEvent => ({ type: 'memberJoined', id: member.id })),
    ...members.filter((_, index) => index % 2 === 1).map((member): ChamberEvent => ({ type: 'working', id: member.id, on: true }))
  ] }
}

interface Feed {
  members: ChamberMember[]
  present: string[]
  working: Set<string>
  events: ChamberEvent[]
}

function startFeed(count: number): Feed {
  const { members, events } = opening(count)
  return { members, present: members.map((member) => member.id),
    working: new Set(members.filter((_, index) => index % 2 === 1).map((member) => member.id)), events }
}

const pick = (ids: string[], turn: number): string | undefined => ids[(turn * 7 + 3) % Math.max(1, ids.length)]

/** One scripted beat of the demo feed: orders, reports, mail and work changes in turn. */
function demoBeat(feed: Feed, turn: number): ChamberEvent[] {
  const id = pick(feed.present, turn)
  const other = pick(feed.present, turn + 1)
  if (!id) return []
  switch (turn % 5) {
    case 0: return [{ type: 'orderSent', to: id, orderId: `demo-${turn}` }]
    case 1: return [{ type: 'reportSent', from: id }]
    case 2: return other && other !== id ? [{ type: 'peerMail', from: id, to: other }] : []
    case 3: return [{ type: 'working', id, on: !feed.working.has(id) }]
    default: return turn % 15 === 4 ? [{ type: 'orderSent', to: 'all', orderId: `demo-all-${turn}` }] : []
  }
}

function applyLocal(feed: Feed, added: ChamberEvent[]): Feed {
  const working = new Set(feed.working)
  let present = feed.present
  for (const event of added) {
    if (event.type === 'working' && event.on) working.add(event.id)
    if (event.type === 'working' && !event.on) working.delete(event.id)
    if (event.type === 'memberLeft') present = present.filter((id) => id !== event.id)
    if (event.type === 'memberJoined' && !present.includes(event.id)) present = [...present, event.id]
  }
  return { ...feed, present, working, events: [...feed.events, ...added] }
}

interface FeedControls {
  feed: Feed
  setFeed: React.Dispatch<React.SetStateAction<Feed>>
  send: (...events: ChamberEvent[]) => void
}

function useFeed(count: number, demo: boolean): FeedControls {
  const [feed, setFeed] = useState(() => startFeed(count))
  const turn = useRef(0)
  useEffect(() => setFeed(startFeed(count)), [count])
  useEffect(() => {
    if (!demo) return
    const timer = window.setInterval(() => {
      turn.current += 1
      setFeed((current) => applyLocal(current, demoBeat(current, turn.current)))
    }, DEMO_MS)
    return () => window.clearInterval(timer)
  }, [demo])
  const send = (...events: ChamberEvent[]) => setFeed((current) => applyLocal(current, events))
  return { feed, setFeed, send }
}

function addAcolyte(feed: Feed): Feed {
  const member = memberFor(feed.members.length)
  return applyLocal({ ...feed, members: [...feed.members, member] }, [{ type: 'memberJoined', id: member.id }])
}

function Button({ label, onClick, pressed }: { label: string; onClick: () => void; pressed?: boolean }): JSX.Element {
  return <button type="button" className="preview-button" aria-pressed={pressed} onClick={onClick}>{label}</button>
}

function Controls({ feed, send, setFeed, selected }: FeedControls & { selected: string | null }): JSX.Element {
  const target = selected && feed.present.includes(selected) ? selected : feed.present.at(-1)
  const run = (runState: RunState) => send({ type: 'runState', runState })
  const [lastMinute, setLastMinute] = useState(false)
  return <div className="preview-controls">
    <Button label="+ acolyte" onClick={() => setFeed(addAcolyte)} />
    <Button label="− acolyte" onClick={() => target && send({ type: 'memberLeft', id: target })} />
    <Button label="toggle working" onClick={() => target && send({ type: 'working', id: target, on: !feed.working.has(target) })} />
    <Button label="order one" onClick={() => target && send({ type: 'orderSent', to: target, orderId: `o-${Date.now()}` })} />
    <Button label="order all" onClick={() => send({ type: 'orderSent', to: 'all', orderId: `all-${Date.now()}` })} />
    <Button label="report" onClick={() => target && send({ type: 'reportSent', from: target })} />
    <Button label="pause" onClick={() => run('paused')} />
    <Button label="resume" onClick={() => run('running')} />
    <Button label="end" onClick={() => run('ending')} />
    <Button label="kill" onClick={() => run('killed')} />
    <Button label="last minute" pressed={lastMinute} onClick={() => {
      send({ type: 'lastMinute', on: !lastMinute })
      setLastMinute(!lastMinute)
    }} />
  </div>
}

function Viewscreen(): JSX.Element {
  return <div className="preview-viewscreen"><span>SHRINE</span><small>No offering yet</small></div>
}

function Preview(): JSX.Element {
  const [count, setCount] = useState<number>(Number(params.get('count')) || 6)
  const [demo, setDemo] = useState(params.get('demo') !== 'off')
  const [selected, setSelected] = useState<string | null>(null)
  const state = useFeed(count, demo)
  return <main className="preview">
    <h1>Cult chamber</h1>
    <p>CultChamber with a scripted demo feed. Click an acolyte to select it; the buttons act on the selection.</p>
    <div className="preview-controls">
      {COUNTS.map((value) => <Button key={value} label={`${value} acolytes`} pressed={count === value}
        onClick={() => setCount(value)} />)}
      <Button label="demo feed" pressed={demo} onClick={() => setDemo(!demo)} />
      <span className="preview-state">{state.feed.present.length} present · selected {selected ?? 'none'}</span>
    </div>
    <Controls {...state} selected={selected} />
    <div className="preview-room">
      <CultChamber key={count} events={state.feed.events} seed={count * 101} members={state.feed.members}
        selectedMemberId={selected} onSelectMember={setSelected} viewscreen={<Viewscreen />} />
    </div>
  </main>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><Preview /></React.StrictMode>)
