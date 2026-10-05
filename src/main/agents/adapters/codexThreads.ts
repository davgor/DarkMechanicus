/**
 * The subagent threads of a Codex chat. Codex runs a subagent as a thread of its own, and
 * `codex app-server` sends that thread's notifications and server requests on the chat's connection
 * with the subagent's `threadId`. Two ways to start one (https://github.com/openai/codex, tag
 * `rust-v0.160.0`, `codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts`, and
 * `codex-rs/core/src/tools/handlers/multi_agents*`; the shapes are read from the source, not from a
 * running Codex, see `__mocks__/codexSubagents.ts`):
 * - v1: a `collabAgentToolCall` item with `tool` `spawnAgent`. It starts with no receivers and completes
 *   with the new thread's id in `receiverThreadIds`. Its tool call is the thread's `parentItemId`.
 * - v2: a `subAgentActivity` item of kind `started`, sent whole (started and completed back to back)
 *   in the spawning thread, with `agentThreadId` and `agentPath`.
 * A `resumeAgent` call that brings back a subagent this process never saw (one from an earlier process)
 * opens a thread for it the same way, named "Subagent" since the call carries no task.
 *
 * Each becomes a `thread` item right after the spawn's tool call, in the thread of whoever spawned it
 * (a subagent's own spawn opens a thread inside its thread). The thread is `running` until the
 * subagent's turn ends (`done` when it completed, `failed` when it failed or was interrupted); a
 * later turn of the same subagent runs it again. A status reported for it by `wait`, `closeAgent` and
 * the other collab tools, and a v2 `completed` or `interrupted` activity, end it the same way. A thread
 * still running when the process is gone ends as `failed`.
 *
 * A subagent is known from the item that announced it, and an item that comes before that one is not
 * kept. The source suggests the announcement comes first (the spawn call completes as soon as the
 * subagent exists, and a subagent needs a model answer before it does anything worth showing); that is
 * not checked against a real Codex. A subagent this process never saw announced stays out of the
 * transcript until the agent resumes it.
 */
import type { ChatAdapterEvent, ChatItem } from '../../../shared/agents/chat'
import { asRecord, asText, clip, scopedId, type Phase } from './codexItems'

type ThreadItem = Extract<ChatItem, { kind: 'thread' }>
type ThreadState = ThreadItem['state']
type Fields = Record<string, unknown>

/** A subagent's thread as items and approval requests name it. */
export interface ThreadRef {
  id: string
  label: string
}

/** Where a thread item was sent: its phase and turn, and the thread of whoever sent it (undefined for the chat's own). */
interface Arrival {
  phase: Phase
  turnId: string
  inThread: string | undefined
}

/** A thread item as it arrived, with the id its tool call has in the transcript. */
interface Call extends Arrival {
  parentItemId: string
}

const MAX_LABEL_CHARS = 120
/** What a thread is called when neither the task nor the agent path says. */
const FALLBACK_LABEL = 'Subagent'

/** How a status Codex reports for a subagent (`CollabAgentStatus`) ends its thread; the others leave it alone. */
const AGENT_ENDS = new Map<string, ThreadState>([
  ['completed', 'done'],
  ['errored', 'failed'],
  ['interrupted', 'failed'],
  ['shutdown', 'failed'],
  ['notFound', 'failed']
])

/** How the end of a subagent's turn ends its thread. */
const TURN_ENDS = new Map<string, ThreadState>([
  ['completed', 'done'],
  ['failed', 'failed'],
  ['interrupted', 'failed']
])

/** How a v2 activity (`SubAgentActivityKind`) other than the start ends a thread. */
const ACTIVITY_ENDS = new Map<string, ThreadState>([
  ['completed', 'done'],
  ['interrupted', 'failed']
])

/** A thread's name: a line of text, trimmed and cut short, or the fallback when there is none. */
function lineOf(text: string | null | undefined): string {
  const line = (text ?? '').split(/\r?\n/).find((candidate) => candidate.trim() !== '')?.trim() ?? ''
  if (line === '') {
    return FALLBACK_LABEL
  }
  return clip(line, MAX_LABEL_CHARS)
}

/** The part of a v2 agent path (`/root/read_notes`) that names the agent. */
function agentName(path: unknown): string {
  return lineOf(asText(path)?.split('/').filter(Boolean).at(-1))
}

function receiversOf(item: Fields): string[] {
  const ids: unknown[] = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []
  return ids.flatMap((id) => asText(id) ?? [])
}

/** The same item, filed in a subagent's thread (the chat's own thread when `threadId` is undefined). */
export function inThread(item: ChatItem, threadId: string | undefined): ChatItem {
  return threadId === undefined ? item : { ...item, threadId }
}

export class CodexThreads {
  /** The thread items as last sent, by id. */
  private readonly items = new Map<string, ThreadItem>()
  /** The thread item of each Codex thread id a subagent was announced with. */
  private readonly byCodexId = new Map<string, string>()

  constructor(private readonly now: () => string) {}

  /** The thread of a Codex thread id, or null when no subagent was announced with it. */
  find(codexThreadId: string): ThreadRef | null {
    const item = this.items.get(this.byCodexId.get(codexThreadId) ?? '')
    return item === undefined ? null : { id: item.id, label: item.label }
  }

  /** What a thread item (the start or end of a collab call or a subagent activity) does to the threads. */
  observe(raw: unknown, arrival: Arrival): ChatAdapterEvent[] {
    const item = asRecord(raw)
    const id = asText(item?.id)
    if (item === null || id === null) {
      return []
    }
    const events: ChatAdapterEvent[] = []
    const call: Call = { ...arrival, parentItemId: scopedId(arrival.turnId, id) }
    if (item.type === 'collabAgentToolCall') {
      this.onCollab(item, call, events)
    } else if (item.type === 'subAgentActivity' && arrival.phase === 'completed') {
      this.onActivity(item, call, events)
    }
    return events
  }

  /** A subagent's turn began: its thread is running (again). */
  turnStarted(codexThreadId: string): ChatAdapterEvent[] {
    const events: ChatAdapterEvent[] = []
    this.change(this.byCodexId.get(codexThreadId), 'running', events)
    return events
  }

  /** A subagent's turn ended (`turn` is the turn object of the notification). */
  turnEnded(codexThreadId: string, turn: unknown): ChatAdapterEvent[] {
    const events: ChatAdapterEvent[] = []
    this.settle(this.byCodexId.get(codexThreadId), TURN_ENDS.get(asText(asRecord(turn)?.status) ?? ''), events)
    return events
  }

  /** The process is gone and its subagents with it: every thread still running failed. */
  end(): ChatAdapterEvent[] {
    const events: ChatAdapterEvent[] = []
    for (const id of this.items.keys()) {
      this.settle(id, 'failed', events)
    }
    return events
  }

  private onCollab(item: Fields, call: Call, events: ChatAdapterEvent[]): void {
    const receivers = receiversOf(item)
    if (item.tool === 'spawnAgent') {
      this.onSpawn(item, receivers[0], call, events)
    } else if (item.tool === 'resumeAgent' && receivers[0] !== undefined && !this.byCodexId.has(receivers[0])) {
      // A subagent from before this process (a closed one the agent brings back) has no spawn to be known from.
      this.byCodexId.set(receivers[0], this.open(call, FALLBACK_LABEL, events).id)
    }
    const states = asRecord(item.agentsStates) ?? {}
    for (const child of receivers) {
      this.settle(this.byCodexId.get(child), AGENT_ENDS.get(asText(asRecord(states[child])?.status) ?? ''), events)
    }
  }

  private onSpawn(item: Fields, child: string | undefined, call: Call, events: ChatAdapterEvent[]): void {
    const thread = this.open(call, lineOf(asText(item.prompt)), events)
    if (child !== undefined) {
      this.byCodexId.set(child, thread.id)
    } else if (call.phase === 'completed') {
      // A spawn that finished without a subagent: there is nothing to wait for.
      this.settle(thread.id, 'failed', events)
    }
  }

  private onActivity(item: Fields, call: Call, events: ChatAdapterEvent[]): void {
    const child = asText(item.agentThreadId)
    if (child === null) {
      return
    }
    if (item.kind === 'started') {
      this.byCodexId.set(child, this.open(call, agentName(item.agentPath), events).id)
    } else {
      this.settle(this.byCodexId.get(child), ACTIVITY_ENDS.get(asText(item.kind) ?? ''), events)
    }
  }

  /** The thread of a spawn call, opened (and announced) the first time the call is seen. */
  private open({ parentItemId, inThread: inThreadId }: Call, label: string, events: ChatAdapterEvent[]): ThreadItem {
    const id = `codex_thread_${parentItemId}`
    const known = this.items.get(id)
    if (known !== undefined) {
      return known
    }
    const item: ThreadItem = {
      id,
      at: this.now(),
      kind: 'thread',
      parentItemId,
      label,
      state: 'running',
      ...(inThreadId === undefined ? {} : { threadId: inThreadId })
    }
    this.items.set(id, item)
    events.push({ type: 'item', item })
    return item
  }

  /** Ends a thread that is still running; one that already ended stays as it is. */
  private settle(id: string | undefined, state: ThreadState | undefined, events: ChatAdapterEvent[]): void {
    if (state !== undefined && id !== undefined && this.items.get(id)?.state === 'running') {
      this.change(id, state, events)
    }
  }

  private change(id: string | undefined, state: ThreadState, events: ChatAdapterEvent[]): void {
    const item = id === undefined ? undefined : this.items.get(id)
    if (item === undefined || item.state === state) {
      return
    }
    const next: ThreadItem = { ...item, state }
    this.items.set(item.id, next)
    events.push({ type: 'item', item: next })
  }
}
