import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentChatAnswer, AgentChatApi, AgentChatEvent, AgentChatModelChoice, AgentChatSnapshot } from '../../../shared/agents/agentChat'
import type { ChatItem } from '../../../shared/agents/chat'
import type { ChatMailEntry } from '../../../shared/agents/chatApi'
import type { CommandResult } from '../../../shared/desktop/api'
import { AgentMailContext } from '../agents/useAgentMail'
import { browserScheduler, type Scheduler } from '../app/scheduler'
import { useClock, type Clock } from '../epic/clock'
import { agentChatState, reconcileAgentChatLifecycle, reduceAgentChat, type AgentChatState } from './agentChatModel'
import { withoutTodoCalls } from './todoPanelModel'

type SnapshotCall = () => Promise<CommandResult<AgentChatSnapshot>>
interface Options {
  folder: string | null
  chatId: string
  api?: AgentChatApi
  scheduler?: Scheduler
}

type ChatRef = Pick<Options, 'folder' | 'chatId'>

/** A rejected transition is not a process failure; initialization failures still are. */
function failedLoadState(baseline: AgentChatState, detail: string, preserve: boolean): AgentChatState {
  if (preserve) return baseline
  const failed = reduceAgentChat(baseline, { folder: null, chatId: '', type: 'status', status: 'failed', detail }, baseline.lastEventAt)
  return { ...failed, turnStartedAt: null }
}

type Config = { scheduler: Scheduler; clock: Clock }

/**
 * One chat's single push subscription, shared by every view that shows the chat: it subscribes once, reads once, and
 * publishes each state to all joined views. It ends when the last view leaves, so stale replies cannot publish into a
 * different chat or bridge. The first view's scheduler and clock serve every view of the chat.
 */
class ChatSubscription {
  private active = true
  private state = agentChatState()
  private initialized = false
  private request = 0
  private buffered: { event: AgentChatEvent; at: number }[] | null = null
  private cancelRender?: () => void
  private unsubscribe?: () => void
  private views = new Set<(state: AgentChatState) => void>()
  /** Joined views that may start the chat; a start-capable view joining while none is joined starts a stopped chat. */
  private autoStartViews = 0

  constructor(
    private identity: ChatRef,
    private api: AgentChatApi,
    private config: Config,
    private release: () => void
  ) {}

  /**
   * Adds a view and hands it the current state; returns its leave. The first view subscribes and reads. A view that may
   * start the chat, joining while no other such view is joined, reads it again and starts it when no session runs;
   * read-only views never start it.
   */
  join(onChange: (state: AgentChatState) => void, autoStart: boolean): () => void {
    const first = this.views.size === 0
    this.views.add(onChange)
    onChange(this.state)
    if (first) this.unsubscribe = this.api.onEvent((event) => this.receive(event))
    if (autoStart && this.autoStartViews++ === 0) {
      this.startWhenStopped()
    } else if (first) {
      void this.load(() => this.api.snapshot(this.identity)).catch(() => { /* load already exposed the failure. */ })
    }
    return () => {
      if (!this.views.delete(onChange)) return
      if (autoStart) this.autoStartViews--
      if (this.views.size > 0) return
      this.active = false
      this.unsubscribe?.()
      this.cancelRender?.()
      this.release()
    }
  }

  private startWhenStopped(): void {
    const sequence = this.request + 1
    void this.load(() => this.api.snapshot(this.identity)).then((result) => {
      if (!this.active || this.request !== sequence || this.state.surface !== 'gui') return
      const missing = !result.ok && result.error.code === 'not_found'
      if (this.state.status === 'exited' || this.state.status === null || (missing && this.state.status === 'failed')) {
        return this.load(() => this.api.start(this.identity))
      }
      return undefined
    }).catch(() => { /* load already exposed the transport failure in state. */ })
  }

  async load(call: SnapshotCall, preserveOnRefusal = false): Promise<CommandResult<AgentChatSnapshot>> {
    const sequence = ++this.request
    const baseline = this.state
    this.buffered = []
    try {
      const result = await call()
      if (this.active && sequence === this.request) {
        // Rebuild snapshot-backed data, not lifecycle history, from buffered pushes.
        const state = result.ok
          ? agentChatState(result.data, this.config.clock.now())
          : failedLoadState(baseline, result.error.message, preserveOnRefusal)
        this.complete(state)
      }
      return result
    } catch (error) {
      if (this.active && sequence === this.request) {
        const statusDetail = error instanceof Error ? error.message : 'Unable to load agent chat.'
        this.complete(failedLoadState(baseline, statusDetail, preserveOnRefusal))
      }
      throw error
    }
  }

  private complete(state: AgentChatState): void {
    // Preserve receipt time across snapshot races; replay is not new agent activity.
    for (const { event, at } of this.buffered ?? []) state = reduceAgentChat(state, event, at)
    // receive() already advanced every initialized thread's history in arrival order.
    // Reconcile only final snapshot or failure changes against that authoritative state.
    this.state = this.initialized ? reconcileAgentChatLifecycle(state, this.state) : state
    this.buffered = null
    this.initialized = true
    this.publish()
  }

  private receive(event: AgentChatEvent): void {
    if (!this.active || event.folder !== this.identity.folder || event.chatId !== this.identity.chatId) return
    const at = this.config.clock.now()
    this.buffered?.push({ event, at })
    if (!this.initialized) return
    this.state = reduceAgentChat(this.state, event, at)
    if (event.type === 'delta') {
      this.cancelRender ??= this.config.scheduler.after(33, () => this.publish())
    } else this.publish()
  }

  private publish(): void {
    this.cancelRender?.()
    this.cancelRender = undefined
    if (this.active) for (const onChange of this.views) onChange(this.state)
  }
}

/** The live subscription of each chat, by bridge: every view of a chat joins the same one. */
const subscriptions = new WeakMap<AgentChatApi, Map<string, ChatSubscription>>()

function sharedSubscription(api: AgentChatApi, identity: ChatRef, config: Config): ChatSubscription {
  let chats = subscriptions.get(api)
  if (chats === undefined) subscriptions.set(api, chats = new Map())
  const key = JSON.stringify([identity.folder, identity.chatId])
  const existing = chats.get(key)
  if (existing !== undefined) return existing
  const created = new ChatSubscription(identity, api, config, () => {
    if (chats.get(key) === created) chats.delete(key)
  })
  chats.set(key, created)
  return created
}

/** A mail card's place in the transcript stream. It is never a `ChatItem`, so nothing stores it in the chat's jsonl. */
export interface MailLine {
  kind: 'mail'
  id: string
  at: string
  mail: ChatMailEntry
}

export type TranscriptLine = ChatItem | MailLine

/**
 * The chat's items in stored order with each mail card placed before the first top-level item stored after it was
 * accepted; a subagent's items stay with their thread, and cards accepted after everything come last.
 */
function withMail(items: readonly ChatItem[], mail: readonly ChatMailEntry[]): TranscriptLine[] {
  const out: TranscriptLine[] = []
  let next = 0
  // A null after the last item flushes the cards accepted after everything.
  for (const item of [...items, null]) {
    if (item === null || item.threadId === undefined) {
      for (; next < mail.length && (item === null || mail[next].acceptedAt < item.at); next++) {
        out.push({ kind: 'mail', id: `mail:${mail[next].id}`, at: mail[next].acceptedAt, mail: mail[next] })
      }
    }
    if (item !== null) out.push(item)
  }
  return out
}

const NO_MAIL: readonly ChatMailEntry[] = []

/**
 * The chat's received and sent Skitarii mail, on a page with the shell's mail store; none for a chat without a
 * mailbox (Claude) or a project-less one. Read again on every mail push of the folder (a peer's mailbox changes when
 * this chat sends). Showing received cards moves the person's seen cursor once per newly shown message; it never
 * acknowledges for the agent.
 */
function useChatMailEntries(folder: string | null, chatId: string): readonly ChatMailEntry[] {
  const store = useContext(AgentMailContext)
  const [mail, setMail] = useState<{ key: string; entries: readonly ChatMailEntry[] }>({ key: '', entries: NO_MAIL })
  const key = JSON.stringify([folder, chatId])
  useEffect(() => {
    if (store === null || folder === null) return undefined
    const api = window.dm.chats.mail
    let alive = true
    let reading = false
    let again = false
    let asked = 0
    const markSeen = (entries: readonly ChatMailEntry[]): void => {
      const shown = entries.reduce((highest, entry) => Math.max(highest, entry.seq ?? 0), 0)
      if (shown <= Math.max(asked, store.view(folder, chatId).state?.humanSeenSeq ?? 0)) return
      asked = shown
      void api.markSeen({ folder, chatId, throughSeq: shown }).then((result) => {
        if (alive && result.ok) store.apply(result.data)
      }, () => undefined)
    }
    const read = async (): Promise<void> => {
      if (reading) {
        again = true
        return
      }
      reading = true
      do {
        again = false
        const result = await api.conversation({ folder, chatId }).catch(() => null)
        if (!alive) return
        const entries = result?.ok === true ? result.data.entries : NO_MAIL
        setMail({ key, entries })
        markSeen(entries)
      } while (again)
      reading = false
    }
    const stop = api.onEvent((event) => {
      if ((event.type === 'mail_state' ? event.state.folder : event.folder) === folder) void read()
    })
    void read()
    return () => {
      alive = false
      stop()
    }
  }, [store, folder, chatId, key])
  return mail.key === key ? mail.entries : NO_MAIL
}

/**
 * The open chat's transcript stream: its items without to-do calls, with its mail cards placed by time. Only the
 * chat's own open view (`AgentChat`) calls this, so opening the transcript is what reads mail and marks it seen;
 * rail rows, feeds and cards that only follow the chat through `useAgentChat` never read or mark mail.
 */
export function useMailTranscript(folder: string | null, chatId: string, items: ChatItem[]): readonly TranscriptLine[] {
  const mail = useChatMailEntries(folder, chatId)
  return useMemo(() => withMail(withoutTodoCalls(items), mail), [items, mail])
}

/**
 * Subscribe before reading; replay pushes over each in-flight snapshot in arrival order. Every view of one chat shares
 * one push subscription. With `autoStart: false` the hook only reads: a stopped chat stays stopped, so a second view of
 * the same chat never starts it.
 */
export function useAgentChat(
  { folder, chatId, api = window.dm.agentChat, scheduler = browserScheduler }: Options,
  { autoStart = true }: { autoStart?: boolean } = {}
) {
  const clock = useClock()
  const identity = useMemo(() => ({ folder, chatId }), [folder, chatId, api, scheduler, clock])
  const [view, setView] = useState<{ identity: typeof identity; state: AgentChatState }>(() => ({ identity, state: agentChatState() }))
  const refresh = useRef<{ identity: ChatRef; subscription: ChatSubscription } | null>(null)

  useEffect(() => {
    const subscription = sharedSubscription(api, identity, { scheduler, clock })
    const joined = { identity, subscription }
    refresh.current = joined
    const leave = subscription.join((state) => setView({ identity, state }), autoStart)
    return () => {
      leave()
      if (refresh.current === joined) refresh.current = null
    }
  }, [api, identity, scheduler, clock, autoStart])

  const load = useCallback((call: SnapshotCall, preserveOnRefusal = false) => {
    const joined = refresh.current
    return joined?.identity === identity ? joined.subscription.load(call, preserveOnRefusal) : call()
  }, [identity])
  const start = useCallback(() => load(() => api.start(identity)), [api, identity, load])
  const send = useCallback(({ text, imageIds = [] }: { text: string; imageIds?: readonly string[] }) =>
    api.send({ ...identity, text, ...(imageIds.length === 0 ? {} : { imageIds: [...imageIds] }) }), [api, identity])
  const stageImage = useCallback((data: string) => api.stageImage({ ...identity, data }), [api, identity])
  const interrupt = useCallback(() => api.interrupt(identity), [api, identity])
  const answer = useCallback((request: AgentChatAnswer) => api.answer({ ...identity, ...request }), [api, identity])
  const setSurface = useCallback((surface: AgentChatSnapshot['surface']) =>
    load(() => api.setSurface({ ...identity, surface }), true), [api, identity, load])
  const models = useCallback(() => api.models(identity), [api, identity])
  // A refused switch keeps the chat as it was; its snapshot carries the switched model and effort into every view.
  const setModel = useCallback((choice: AgentChatModelChoice) =>
    load(() => api.setModel({ ...identity, ...choice }), true), [api, identity, load])

  return {
    state: view.identity === identity ? view.state : agentChatState(), start, send, stageImage, interrupt, answer, setSurface, models, setModel
  }
}
