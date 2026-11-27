/**
 * The Cult page's data: the cult and its runs from `window.dm.cults`, kept current by the `cults:event` push; a
 * member's chat record (read through `chats.read` in its run's work folder, which main resolves for a tracked folder
 * and for a project-less cult's sanctum alike); and the chamber's event log derived from the run snapshots.
 */
import { useEffect, useRef, useState } from 'react'
import type { ChatRecord } from '../../../shared/agents/chat'
import type { CultRunDetail } from '../../../shared/cults/cultApi'
import type { RunState } from '../../../shared/cults/runState'
import type { ChamberEvent } from './chamber/chamberState'
import { applyRunEvent, type CultEntry } from './useCults'

type RoomState = Extract<ChamberEvent, { type: 'runState' }>

type Loaded<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: T }

const failed = (error: unknown): { status: 'error'; message: string } => ({ status: 'error', message: error instanceof Error ? error.message : String(error) })

async function loadEntry(cultId: string): Promise<CultEntry> {
  const [cult, runs] = await Promise.all([window.dm.cults.get(cultId), window.dm.cults.runs(cultId)])
  if (!cult.ok) throw new Error(cult.error.message)
  if (!runs.ok) throw new Error(runs.error.message)
  return { cult: cult.data, runs: runs.data }
}

/** The cult with its runs, newest first; `reload` fetches both again (after a Start, whose run is new). */
export function useCultEntry(cultId: string): { entry: Loaded<CultEntry>; reload(): void } {
  const [entry, setEntry] = useState<Loaded<CultEntry>>({ status: 'loading' })
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let current = true
    setEntry((previous) => (previous.status === 'ready' && previous.value.cult.id === cultId ? previous : { status: 'loading' }))
    loadEntry(cultId).then(
      (value) => current && setEntry({ status: 'ready', value }),
      (error: unknown) => current && setEntry(failed(error))
    )
    return () => {
      current = false
    }
  }, [cultId, version])
  useEffect(
    () =>
      window.dm.cults.onEvent((event) =>
        setEntry((previous) => {
          if (previous.status !== 'ready') return previous
          const [value] = applyRunEvent([previous.value], event)
          return { status: 'ready', value }
        })
      ),
    []
  )
  return { entry, reload: () => setVersion((n) => n + 1) }
}

/** A member's chat record, read in its run's work folder; null while it loads. */
export function useMemberChat(folder: string, chatId: string): Loaded<ChatRecord> {
  const [chat, setChat] = useState<Loaded<ChatRecord>>({ status: 'loading' })
  useEffect(() => {
    let current = true
    setChat({ status: 'loading' })
    window.dm.chats.read({ folder, chatId }).then(
      (result) => current && setChat(result.ok ? { status: 'ready', value: result.data.chat } : { status: 'error', message: result.error.message }),
      (error: unknown) => current && setChat(failed(error))
    )
    return () => {
      current = false
    }
  }, [folder, chatId])
  return chat
}

/** What of a run the chamber shows: who is in the room, who works, the run's state and whether a petition waits. */
interface RoomFacts {
  members: ReadonlySet<string>
  working: ReadonlySet<string>
  runState: RoomState
  petition: boolean
}

const CHAMBER_STATE: Readonly<Record<RunState, RoomState['runState']>> = {
  starting: 'running',
  running: 'running',
  paused: 'paused',
  shutting_down: 'ending',
  ended: 'ended'
}

function factsOf(run: CultRunDetail): RoomFacts {
  const live = run.members.filter((member) => member.role === 'acolyte' && member.leftAt === null)
  const runState = CHAMBER_STATE[run.run.state] === 'ended' && run.run.endReason === 'killed' ? 'killed' : CHAMBER_STATE[run.run.state]
  return {
    members: new Set(live.map((member) => member.chatId)),
    working: new Set(live.filter((member) => member.activity?.working === true).map((member) => member.chatId)),
    runState: { type: 'runState', runState },
    petition: run.petitions.some((petition) => petition.state === 'pending')
  }
}

const EMPTY_FACTS: RoomFacts = { members: new Set(), working: new Set(), runState: { type: 'runState', runState: 'idle' }, petition: false }

/** The events that take the chamber from what it showed to what the run is now. */
export function roomEvents(before: RoomFacts, after: RoomFacts): ChamberEvent[] {
  const joined = [...after.members].filter((id) => !before.members.has(id)).map((id): ChamberEvent => ({ type: 'memberJoined', id }))
  const left = [...before.members].filter((id) => !after.members.has(id)).map((id): ChamberEvent => ({ type: 'memberLeft', id }))
  const working = [...after.members].flatMap((id): ChamberEvent[] =>
    before.working.has(id) === after.working.has(id) && before.members.has(id) ? [] : [{ type: 'working', id, on: after.working.has(id) }])
  const state = before.runState.runState === after.runState.runState ? [] : [after.runState]
  const petition = before.petition === after.petition ? [] : [{ type: 'petitionPending' as const, on: after.petition }]
  return [...state, ...left, ...joined, ...working, ...petition]
}

/** The chamber's append-only event log for the run shown, derived from its snapshots; it starts afresh for another run. */
export function useChamberLog(run: CultRunDetail | null): readonly ChamberEvent[] {
  const log = useRef<{ runId: string | null; facts: RoomFacts; events: ChamberEvent[] }>({ runId: null, facts: EMPTY_FACTS, events: [] })
  const runId = run?.run.id ?? null
  if (log.current.runId !== runId) log.current = { runId, facts: EMPTY_FACTS, events: [] }
  if (run !== null) {
    const facts = factsOf(run)
    const added = roomEvents(log.current.facts, facts)
    if (added.length > 0) log.current = { runId, facts, events: [...log.current.events, ...added] }
  }
  return log.current.events
}

