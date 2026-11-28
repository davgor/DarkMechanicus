/**
 * The cult pipeline (`docs/design/cults.md` section 8): a run-wide, human-only, read-only timeline of every message
 * between the run's members and the run's `cult_events`, in one stable order the renderer pages by `afterSeq`.
 *
 * The members come from main's own records (the cult store and the chat records), never from the renderer. Each
 * member's inbox is read through the human read path (`readHumanAgentInbox`, through `mailRead`), which neither
 * acknowledges for the agent nor moves the person's seen cursor; a message counts only when its sender is a member of
 * the same run. Every sync merges the run's new events and its members' new mail by `(time, id)` and appends them to
 * `cult_pipeline` (app database v8) after everything already shown: what was paged never moves, so the order has no
 * gaps or duplicates. Message bodies are copied there, so the pipeline outlives mail retention and a member's
 * departure. An `order_all` comes back as one entry with its recipients, its messages folded into it. The order's
 * messages and its event are written in one `exclusive` step, so no sync reads the messages before the order exists.
 *
 * Bodies and summaries are inert task data: returned as text, a preview unless the whole body is asked for.
 */
import type { Db } from '../../core/db/database'
import { fail } from '../../core/errors'
import type { CultEventKind, CultOrderData, CultRunView } from '../../shared/cults/cult'
import type { CultPipelineEntry, CultPipelinePage, PipelineMember } from '../../shared/cults/cultApi'
import type { AgentInboxPage, AgentMailMessageView, AgentMailWindow } from '../../shared/domain/agentMail'
import type { CultStore } from './cultStore'

/** A message body longer than this comes back as its first characters unless the whole body is asked for. */
export const PIPELINE_PREVIEW_CHARS = 600
const INBOX_PAGE = 50
const EVENT_PAGE = 500

interface CultPipelineDeps {
  db: Db
  cults: Pick<CultStore, 'getRun' | 'listMembers' | 'pageEvents'>
  /** The member chat's mailbox endpoint, from main's chat records in the run's work folder; null while it has none. */
  endpointOf(run: CultRunView, chatId: string): string | null
  /** One page of a member's inbox (an endpoint from `endpointOf`) through the human read path: never acknowledges, never marks seen. */
  readInbox(run: CultRunView, endpointId: string, window: AgentMailWindow): Promise<AgentInboxPage>
  /** A member's inbox that could not be read this time (its folder untracked, say); the rest is still served. */
  onError?(error: unknown): void
}

export interface CultPipeline {
  /** Reads what is new into the pipeline, then one page after `afterSeq`; `not_found` for an unknown run. */
  page(runId: string, request: { afterSeq?: number; limit: number; full?: boolean }): Promise<CultPipelinePage>
  /** Runs `work` while no sync of the run's pipeline runs: one asked meanwhile waits until it has finished. */
  exclusive<T>(runId: string, work: () => Promise<T>): Promise<T>
}

interface Cursor {
  chatId: string
  endpointId: string
  throughSeq: number
}

/** One new pipeline row before it has its sequence: an event, or a message of a member's inbox. */
interface Arrival {
  at: string
  key: string
  eventSeq: number | null
  message: { id: string; sender: string; recipient: string; inReplyTo: string | null; body: string } | null
}

export function createCultPipeline(deps: CultPipelineDeps): CultPipeline {
  const chains = new Map<string, Promise<unknown>>()
  // One sync per run at a time: two would read the same cursors and append the same mail twice.
  const serialized = <T>(runId: string, work: () => Promise<T>): Promise<T> => {
    const next = (chains.get(runId) ?? Promise.resolve()).catch(() => {}).then(work)
    chains.set(runId, next)
    return next.finally(() => chains.get(runId) === next && chains.delete(runId))
  }
  return {
    page: async (runId, request) => {
      const run = deps.cults.getRun(runId) ?? fail('not_found', `No cult run ${runId}.`)
      return serialized(runId, async () => {
        await sync(deps, run)
        return readPage(deps, run.id, request)
      })
    },
    exclusive: (runId, work) => serialized(runId, work)
  }
}

// ---- Sync ----

async function sync(deps: CultPipelineDeps, run: CultRunView): Promise<void> {
  const events = newEvents(deps, run.id)
  const cursors = memberCursors(deps, run)
  const members = new Map(cursors.map((cursor) => [cursor.endpointId, cursor.chatId]))
  const mail: Arrival[] = []
  for (const cursor of cursors) {
    try {
      const read = await readSince(deps, run, cursor)
      cursor.throughSeq = read.throughSeq
      mail.push(...read.messages.flatMap((message) => arrivalOf(message, members, cursor.chatId)))
    } catch (error) {
      deps.onError?.(error)
    }
  }
  append(deps.db, run.id, [...events, ...mail].sort(byTimeThenKey), cursors)
}

const byTimeThenKey = (a: Arrival, b: Arrival): number => (a.at === b.at ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.at < b.at ? -1 : 1)

/** The run's events after the last one the pipeline holds. */
function newEvents(deps: CultPipelineDeps, runId: string): Arrival[] {
  let afterSeq = deps.db.get<{ seq: number | null }>('SELECT MAX(event_seq) AS seq FROM cult_pipeline WHERE run_id = ?', runId)?.seq ?? 0
  const arrivals: Arrival[] = []
  for (;;) {
    const page = deps.cults.pageEvents(runId, { afterSeq, limit: EVENT_PAGE })
    arrivals.push(...page.events.map((event) => ({ at: event.at, key: `e:${String(event.seq).padStart(12, '0')}`, eventSeq: event.seq, message: null })))
    if (page.nextAfterSeq === null) return arrivals
    afterSeq = page.nextAfterSeq
  }
}

/** Every member with a mailbox and how far its inbox was read; a member's endpoint is kept once known. */
function memberCursors(deps: CultPipelineDeps, run: CultRunView): Cursor[] {
  const known = new Map(
    deps.db
      .all<{ chat_id: string; endpoint_id: string; through_seq: number }>('SELECT chat_id, endpoint_id, through_seq FROM cult_pipeline_cursors WHERE run_id = ?', run.id)
      .map((row) => [row.chat_id, { chatId: row.chat_id, endpointId: row.endpoint_id, throughSeq: row.through_seq }])
  )
  return deps.cults.listMembers(run.id).flatMap((member) => {
    const cursor = known.get(member.chatId)
    if (cursor !== undefined) return [cursor]
    const endpointId = deps.endpointOf(run, member.chatId)
    return endpointId === null ? [] : [{ chatId: member.chatId, endpointId, throughSeq: 0 }]
  })
}

/** The member's inbox after its cursor, every page up to the first page's horizon. */
async function readSince(deps: CultPipelineDeps, run: CultRunView, cursor: Cursor): Promise<{ messages: AgentMailMessageView[]; throughSeq: number }> {
  const messages: AgentMailMessageView[] = []
  let afterSeq = cursor.throughSeq
  let horizon: number | undefined
  for (;;) {
    const page = await deps.readInbox(run, cursor.endpointId, { afterSeq, throughSeq: horizon, limit: INBOX_PAGE })
    messages.push(...page.messages)
    horizon = page.snapshotHighWater
    if (!page.hasMore) return { messages, throughSeq: Math.max(afterSeq, horizon) }
    afterSeq = page.nextCursor
  }
}

/** A message for the pipeline only when a member of the run sent it (never an outsider's). */
function arrivalOf(message: AgentMailMessageView, members: ReadonlyMap<string, string>, recipient: string): Arrival[] {
  const sender = members.get(message.from.endpointId)
  if (sender === undefined) return []
  return [{
    at: message.acceptedAt, key: `m:${message.id}`, eventSeq: null,
    message: { id: message.id, sender, recipient, inReplyTo: message.inReplyTo, body: message.body }
  }]
}

/** A row's message columns: the message's, or all null for an event. */
function messageColumns(arrival: Arrival): (string | null)[] {
  const m = arrival.message
  return m === null ? [null, null, null, null, null] : [m.id, m.sender, m.recipient, m.inReplyTo, m.body]
}

/** Appends the batch after the run's last row and moves the cursors, in one transaction. */
function append(db: Db, runId: string, arrivals: readonly Arrival[], cursors: readonly Cursor[]): void {
  db.tx(() => {
    let seq = db.get<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM cult_pipeline WHERE run_id = ?', runId)?.seq ?? 0
    for (const arrival of arrivals) {
      seq += 1
      db.run(
        `INSERT INTO cult_pipeline (run_id, seq, at, event_seq, message_id, sender_chat_id, recipient_chat_id, in_reply_to, body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        runId, seq, arrival.at, arrival.eventSeq, ...messageColumns(arrival)
      )
    }
    for (const cursor of cursors) {
      db.run(
        `INSERT INTO cult_pipeline_cursors (run_id, chat_id, endpoint_id, through_seq) VALUES (?, ?, ?, ?)
         ON CONFLICT (run_id, chat_id) DO UPDATE SET through_seq = excluded.through_seq`,
        runId, cursor.chatId, cursor.endpointId, cursor.throughSeq
      )
    }
  })
}

// ---- Read ----

interface PipelineRow {
  seq: number
  at: string
  event_seq: number | null
  message_id: string | null
  sender_chat_id: string | null
  recipient_chat_id: string | null
  in_reply_to: string | null
  body: string | null
  kind: CultEventKind | null
  member_name: string | null
  summary: string | null
  data: string | null
}

/** Rows after `afterSeq`, an order's own messages left out (its event stands for them). */
const PAGE_SQL = `
  SELECT p.seq, p.at, p.event_seq, p.message_id, p.sender_chat_id, p.recipient_chat_id, p.in_reply_to, p.body,
         e.kind, e.member_name, e.summary, e.data
  FROM cult_pipeline p LEFT JOIN cult_events e ON e.run_id = p.run_id AND e.seq = p.event_seq
  WHERE p.run_id = ? AND p.seq > ?
    AND (p.message_id IS NULL OR p.message_id NOT IN (
      SELECT j.value FROM cult_events o, json_each(o.data, '$.messageIds') j WHERE o.run_id = ? AND o.kind = 'order_all'))
  ORDER BY p.seq LIMIT ?`

interface Reader {
  db: Db
  runId: string
  full: boolean
  byChat: ReadonlyMap<string, PipelineMember>
  byName: ReadonlyMap<string, PipelineMember>
}

function readPage(deps: CultPipelineDeps, runId: string, request: { afterSeq?: number; limit: number; full?: boolean }): CultPipelinePage {
  const afterSeq = request.afterSeq ?? 0
  const members: PipelineMember[] = deps.cults.listMembers(runId).map(({ chatId, displayName, role }) => ({ chatId, displayName, role }))
  const reader: Reader = {
    db: deps.db, runId, full: request.full === true,
    byChat: new Map(members.map((member) => [member.chatId, member])),
    byName: new Map(members.map((member) => [member.displayName, member]))
  }
  const rows = deps.db.all<PipelineRow>(PAGE_SQL, runId, afterSeq, runId, request.limit + 1)
  const entries = rows.slice(0, request.limit).map((row) => entryOf(reader, row))
  return { entries, nextAfterSeq: entries.at(-1)?.seq ?? afterSeq, hasMore: rows.length > request.limit }
}

function textOf(body: string, full: boolean): { text: string; truncated: boolean } {
  return full || body.length <= PIPELINE_PREVIEW_CHARS ? { text: body, truncated: false } : { text: body.slice(0, PIPELINE_PREVIEW_CHARS), truncated: true }
}

function entryOf(reader: Reader, row: PipelineRow): CultPipelineEntry {
  if (row.message_id !== null) return messageEntry(reader, row, row.message_id)
  const base = { seq: row.seq, at: row.at, orderId: null, inReplyTo: null }
  const sender = row.member_name === null ? null : (reader.byName.get(row.member_name) ?? null)
  if (row.kind === 'order_all' && row.data !== null) return orderEntry(reader, { ...base, sender }, JSON.parse(row.data) as CultOrderData, row.summary ?? '')
  return { ...base, kind: 'event', eventKind: row.kind, sender, recipients: [], messageIds: [], truncated: false, text: row.summary ?? '' }
}

/** One message, its sender and recipient named from main's member records. */
function messageEntry(reader: Reader, row: PipelineRow, messageId: string): CultPipelineEntry {
  const sender = row.sender_chat_id === null ? undefined : reader.byChat.get(row.sender_chat_id)
  const recipient = row.recipient_chat_id === null ? undefined : reader.byChat.get(row.recipient_chat_id)
  return {
    seq: row.seq, at: row.at, kind: 'message', eventKind: null, sender: sender ?? null, recipients: recipient === undefined ? [] : [recipient],
    orderId: null, messageIds: [messageId], inReplyTo: row.in_reply_to, ...textOf(row.body ?? '', reader.full)
  }
}

/** One `order_all`: its recipients by name and the one body its messages share (the summary until they are read). */
function orderEntry(reader: Reader, base: Pick<CultPipelineEntry, 'seq' | 'at' | 'sender' | 'inReplyTo'>, order: CultOrderData, summary: string): CultPipelineEntry {
  const first = order.messageIds[0]
  const body = first === undefined ? undefined : reader.db.get<{ body: string }>('SELECT body FROM cult_pipeline WHERE run_id = ? AND message_id = ?', reader.runId, first)?.body
  const recipients = order.recipients.map((name) => reader.byName.get(name) ?? { chatId: '', displayName: name, role: 'acolyte' as const })
  return {
    ...base, kind: 'order_all', eventKind: 'order_all', recipients, orderId: order.orderId, messageIds: order.messageIds,
    ...(body === undefined ? { text: summary, truncated: false } : textOf(body, reader.full))
  }
}
