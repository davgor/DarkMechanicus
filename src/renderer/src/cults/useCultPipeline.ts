/**
 * A run's pipeline (`window.dm.cults.pipeline`): every page in order once, then, while the run is live, what arrives
 * after the last entry shown. A `cults:event` change of the run or a mail push for one of its member chats asks at
 * once; both are only hints, so a slow poll recovers a missed one. Entries are kept by their `seq`, so a page asked twice
 * never shows an entry twice, and an `order_all` replaces any of its messages that was shown alone before it was
 * recorded. The live chamber reads each entry's `seq`, kind, sender, recipients and `orderId` from here too.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { MAX_PIPELINE_PAGE, type CultPipelineEntry } from '../../../shared/cults/cultApi'
import type { CommandResult } from '../../../shared/desktop/api'
import type { Scheduler } from '../app/scheduler'

/** The recovery poll while a run is live: slower than the mail monitor's own 2 s sweep that feeds it. */
export const PIPELINE_POLL_MS = 5_000

type CultPipelineState =
  | { status: 'loading'; entries: CultPipelineEntry[] }
  | { status: 'ready'; entries: CultPipelineEntry[] }
  | { status: 'error'; entries: CultPipelineEntry[]; message: string }

interface CultPipelineModel {
  state: CultPipelineState
  /** The whole body of a message entry shown as a preview; null when it could not be read. */
  fullText(seq: number): Promise<string | null>
}

interface PipelineOptions {
  /** Polls and listens while set (a live run); a past run is read once. */
  live: Scheduler | null
  /** The run's member chats, whose mail pushes are hints. */
  memberChatIds: readonly string[]
}

const unwrap = <T>(result: CommandResult<T>): T => {
  if (result.ok) return result.data
  throw new Error(result.error.message)
}

/** The entries with `incoming` after them; nothing is shown twice, and an order hides its messages shown alone. */
export function mergeEntries(current: readonly CultPipelineEntry[], incoming: readonly CultPipelineEntry[]): CultPipelineEntry[] {
  const last = current.at(-1)?.seq ?? 0
  const fresh = incoming.filter((entry) => entry.seq > last)
  const grouped = new Set(fresh.filter((entry) => entry.kind === 'order_all').flatMap((entry) => entry.messageIds))
  const kept = grouped.size === 0 ? current : current.filter((entry) => entry.kind !== 'message' || !entry.messageIds.some((id) => grouped.has(id)))
  return fresh.length === 0 ? [...kept] : [...kept, ...fresh]
}

/** One reader per run: a fetch asked while one runs runs once more after it, never beside it. */
function createReader(runId: string, apply: (incoming: CultPipelineEntry[] | Error) => void) {
  let cursor = 0
  let running = false
  let again = false
  let stopped = false
  const drain = async (): Promise<void> => {
    for (;;) {
      const page = unwrap(await window.dm.cults.pipeline(runId, { afterSeq: cursor, limit: MAX_PIPELINE_PAGE }))
      if (stopped) return
      cursor = page.nextAfterSeq
      apply(page.entries)
      if (!page.hasMore) return
    }
  }
  const read = async (): Promise<void> => {
    if (running) {
      again = true
      return
    }
    running = true
    do {
      again = false
      await drain().catch((error: unknown) => stopped || apply(error instanceof Error ? error : new Error(String(error))))
    } while (again && !stopped)
    running = false
  }
  return { read, stop: () => void (stopped = true) }
}

export function useCultPipeline(runId: string, { live, memberChatIds }: PipelineOptions): CultPipelineModel {
  const [state, setState] = useState<CultPipelineState>({ status: 'loading', entries: [] })
  const members = useRef(memberChatIds)
  members.current = memberChatIds

  useEffect(() => {
    setState({ status: 'loading', entries: [] })
    const reader = createReader(runId, (incoming) =>
      setState((previous) =>
        incoming instanceof Error
          ? { status: 'error', entries: previous.entries, message: incoming.message }
          : { status: 'ready', entries: mergeEntries(previous.entries, incoming) }
      )
    )
    void reader.read()
    if (live === null) return reader.stop
    const stopPoll = live.every(PIPELINE_POLL_MS, () => void reader.read())
    const stopCults = window.dm.cults.onEvent((event) => event.snapshot.run.id === runId && void reader.read())
    const stopMail = window.dm.chats.mail.onEvent((event) => {
      const chatId = event.type === 'mail_state' ? event.state.chatId : event.chatId
      if (members.current.includes(chatId)) void reader.read()
    })
    return () => {
      reader.stop()
      stopPoll()
      stopCults()
      stopMail()
    }
  }, [runId, live])

  const fullText = useCallback(async (seq: number): Promise<string | null> => {
    const result = await window.dm.cults.pipeline(runId, { afterSeq: seq - 1, limit: 1, full: true })
    const entry = result.ok ? result.data.entries[0] : undefined
    return entry?.seq === seq ? entry.text : null
  }, [runId])

  return { state, fullText }
}
