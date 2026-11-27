import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentChatApi, AgentChatEvent, AgentChatSnapshot } from '../../../shared/agents/agentChat'
import type { CommandResult } from '../../../shared/desktop/api'
import { browserScheduler, type Scheduler } from '../app/scheduler'
import { useClock, type Clock } from '../epic/clock'
import { agentChatState, reconcileAgentChatLifecycle, reduceAgentChat, type AgentChatState } from './agentChatModel'

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
  private autoStart = false

  constructor(
    private identity: ChatRef,
    private api: AgentChatApi,
    private config: Config,
    private release: () => void
  ) {}

  /**
   * Adds a view and hands it the current state; returns its leave. The first view subscribes and reads. The first
   * view that may start the chat reads it again and starts it when no session runs; read-only views never start it.
   */
  join(onChange: (state: AgentChatState) => void, autoStart: boolean): () => void {
    const first = this.views.size === 0
    this.views.add(onChange)
    onChange(this.state)
    if (first) this.unsubscribe = this.api.onEvent((event) => this.receive(event))
    if (autoStart && !this.autoStart) {
      this.autoStart = true
      this.startWhenStopped()
    } else if (first) {
      void this.load(() => this.api.snapshot(this.identity)).catch(() => { /* load already exposed the failure. */ })
    }
    return () => {
      if (!this.views.delete(onChange) || this.views.size > 0) return
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
  const send = useCallback((text: string) => api.send({ ...identity, text }), [api, identity])
  const interrupt = useCallback(() => api.interrupt(identity), [api, identity])
  const answer = useCallback((promptId: string, optionId: string, text?: string) =>
    api.answer({ ...identity, promptId, optionId, ...(text === undefined ? {} : { text }) }), [api, identity])
  const setSurface = useCallback((surface: AgentChatSnapshot['surface']) =>
    load(() => api.setSurface({ ...identity, surface }), true), [api, identity, load])

  return { state: view.identity === identity ? view.state : agentChatState(), start, send, interrupt, answer, setSurface }
}
