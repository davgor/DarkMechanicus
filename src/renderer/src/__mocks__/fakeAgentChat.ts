import type { AgentChatApi, AgentChatEvent, AgentChatSnapshot } from '../../../shared/agents/agentChat'
import type { CommandResult } from '../../../shared/desktop/api'
import type { DomainErrorShape } from '../../../shared/domain/errors'
import { deferred, type Deferred } from './deferred'

type Method = Exclude<keyof AgentChatApi, 'onEvent'>

/** Deterministic structured-chat bridge; holds delay one call, not the event stream. */
export class FakeAgentChat implements AgentChatApi {
  snapshotResult: CommandResult<AgentChatSnapshot> = {
    ok: true, data: { items: [], status: 'idle', pending: null, queued: 0, surface: 'gui', todos: [] }
  }
  failures: Partial<Record<Method, DomainErrorShape>> = {}
  calls: { method: Method; args: unknown[] }[] = []
  private holds: Partial<Record<Method, Deferred[]>> = {}
  private listeners = new Set<(event: AgentChatEvent) => void>()

  hold(method: Method): Deferred {
    const hold = deferred()
    this.holds[method] = [...(this.holds[method] ?? []), hold]
    return hold
  }

  callsOf(method: Method): unknown[][] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args)
  }

  subscribers(): number { return this.listeners.size }

  emit(event: AgentChatEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  onEvent(listener: (event: AgentChatEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  snapshot(request: Parameters<AgentChatApi['snapshot']>[0]) {
    const result = this.snapshotResult
    return this.call('snapshot', request, () => result)
  }

  start(request: Parameters<AgentChatApi['start']>[0]) {
    return this.call('start', request, () => {
      if (this.snapshotResult.ok) this.snapshotResult = { ok: true, data: { ...this.snapshotResult.data, status: 'idle' } }
      return this.snapshotResult
    })
  }

  send(request: Parameters<AgentChatApi['send']>[0]) {
    return this.call('send', request, () => ({ ok: true, data: null }))
  }

  interrupt(request: Parameters<AgentChatApi['interrupt']>[0]) {
    return this.call('interrupt', request, () => ({ ok: true, data: null }))
  }

  answer(request: Parameters<AgentChatApi['answer']>[0]) {
    return this.call('answer', request, () => ({ ok: true, data: null }))
  }

  setSurface(request: Parameters<AgentChatApi['setSurface']>[0]) {
    return this.call('setSurface', request, () => {
      if (this.snapshotResult.ok) this.snapshotResult = { ok: true, data: { ...this.snapshotResult.data, surface: request.surface } }
      return this.snapshotResult
    })
  }

  private async call<T>(method: Method, request: unknown, produce: () => CommandResult<T>): Promise<CommandResult<T>> {
    this.calls.push({ method, args: [request] })
    await this.holds[method]?.shift()?.promise
    const failure = this.failures[method]
    return failure ? { ok: false, error: failure } : produce()
  }
}
