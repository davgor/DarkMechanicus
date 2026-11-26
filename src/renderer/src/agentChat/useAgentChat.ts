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

/** One effect's lifetime: stale replies cannot publish into a different chat or bridge. */
class ChatSubscription {
  private active = true
  private state = agentChatState()
  private initialized = false
  private request = 0
  private buffered: { event: AgentChatEvent; at: number }[] | null = null
  private cancelRender?: () => void
  private unsubscribe?: () => void

  constructor(
    readonly identity: ChatRef,
    private api: AgentChatApi,
    private config: { scheduler: Scheduler; clock: Clock; autoStart: boolean },
    private onChange: (state: AgentChatState) => void
  ) {}

  attach(): void {
    this.publish()
    this.unsubscribe = this.api.onEvent((event) => this.receive(event))
    void this.load(() => this.api.snapshot(this.identity)).then((result) => {
      if (!this.config.autoStart || !this.active || this.request !== 1 || this.state.surface !== 'gui') return
      const missing = !result.ok && result.error.code === 'not_found'
      if (this.state.status === 'exited' || this.state.status === null || (missing && this.state.status === 'failed')) {
        return this.load(() => this.api.start(this.identity))
      }
      return undefined
    }).catch(() => { /* load already exposed the transport failure in state. */ })
  }

  dispose(): void {
    this.active = false
    this.unsubscribe?.()
    this.cancelRender?.()
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
    if (this.active) this.onChange(this.state)
  }
}

/**
 * Subscribe before reading; replay pushes over each in-flight snapshot in arrival order. With `autoStart: false` the
 * hook only reads: a stopped chat stays stopped, so a second view of the same chat never starts it.
 */
export function useAgentChat(
  { folder, chatId, api = window.dm.agentChat, scheduler = browserScheduler }: Options,
  { autoStart = true }: { autoStart?: boolean } = {}
) {
  const clock = useClock()
  const identity = useMemo(() => ({ folder, chatId }), [folder, chatId, api, scheduler, clock])
  const [view, setView] = useState<{ identity: typeof identity; state: AgentChatState }>(() => ({ identity, state: agentChatState() }))
  const refresh = useRef<ChatSubscription | null>(null)

  useEffect(() => {
    const subscription = new ChatSubscription(identity, api, { scheduler, clock, autoStart }, (state) => setView({ identity, state }))
    refresh.current = subscription
    subscription.attach()
    return () => {
      subscription.dispose()
      if (refresh.current === subscription) refresh.current = null
    }
  }, [api, identity, scheduler, clock, autoStart])

  const load = useCallback((call: SnapshotCall, preserveOnRefusal = false) => {
    return refresh.current?.identity === identity ? refresh.current.load(call, preserveOnRefusal) : call()
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
