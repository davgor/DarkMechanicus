/**
 * The Cult page's data: the cult and its runs from `window.dm.cults`, kept current by the `cults:event` push; a
 * member's chat record (read through `chats.read` in its run's work folder, which main resolves for a tracked folder
 * and for a project-less cult's sanctum alike); and the live chamber's event log (`chamber/chamberFeed.ts`).
 */
import { useEffect, useRef, useState } from 'react'
import type { ChatRecord } from '../../../shared/agents/chat'
import type { CultPipelineEntry, CultRunDetail } from '../../../shared/cults/cultApi'
import { useNow } from '../epic/clock'
import { advanceFeed, startFeed, type ChamberFeed } from './chamber/chamberFeed'
import type { ChamberEvent } from './chamber/chamberState'
import { applyRunEvent, type CultEntry } from './useCults'

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

/**
 * The chamber's append-only event log for the run shown, from its snapshots and its pipeline entries (`chamberFeed`):
 * it opens on the run as it is now and adds each change once. The clock's tick lets idle quips and the last minute
 * come due between snapshots. Mount it once per run.
 */
export function useChamberLog(run: CultRunDetail, entries: readonly CultPipelineEntry[], seed: number): readonly ChamberEvent[] {
  const now = useNow()
  const log = useRef<{ feed: ChamberFeed; events: readonly ChamberEvent[] } | null>(null)
  const input = { run, entries, now }
  if (log.current === null) log.current = startFeed(input, seed)
  else {
    const { feed, events } = advanceFeed(log.current.feed, input)
    log.current = { feed, events: events.length === 0 ? log.current.events : [...log.current.events, ...events] }
  }
  return log.current.events
}
