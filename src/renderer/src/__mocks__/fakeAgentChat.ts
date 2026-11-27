import type { AgentChatApi, AgentChatEvent, AgentChatSnapshot, AttentionItem } from '../../../shared/agents/agentChat'
import type { ChatImageRef } from '../../../shared/agents/chat'
import type { ChatModelOption } from '../../../shared/agents/models'
import type { CommandResult } from '../../../shared/desktop/api'
import type { DomainErrorShape } from '../../../shared/domain/errors'
import { deferred, type Deferred } from './deferred'

type Method = Exclude<keyof AgentChatApi, 'onEvent'>

/** Deterministic structured-chat bridge; holds delay one call, not the event stream. */
export class FakeAgentChat implements AgentChatApi {
  snapshotResult: CommandResult<AgentChatSnapshot> = {
    ok: true, data: { items: [], status: 'idle', pending: null, queued: 0, surface: 'gui', todos: [] }
  }
  attentionResult: CommandResult<AttentionItem[]> = { ok: true, data: [] }
  stageImageResult: CommandResult<{ image: ChatImageRef }> = {
    ok: true, data: { image: { id: 'ci_00000000000000000000000000', mime: 'image/png', width: 1, height: 1, bytes: 68 } }
  }
  attachEvidenceResult: CommandResult<{ commentId: string; attachmentId: string }> = {
    ok: true, data: { commentId: 'cm_1', attachmentId: 'im_1' }
  }
  modelsResult: CommandResult<ChatModelOption[]> = { ok: true, data: [] }
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

  attention(request: Parameters<AgentChatApi['attention']>[0]) {
    const result = this.attentionResult
    return this.call('attention', request, () => result)
  }

  /** The images later `stageImage` calls answer, one each and in order; `stageImageResult` once they run out. */
  stagedImages: ChatImageRef[] = []

  stageImage(request: Parameters<AgentChatApi['stageImage']>[0]) {
    const next = this.stagedImages.shift()
    const result: CommandResult<{ image: ChatImageRef }> = next === undefined ? this.stageImageResult : { ok: true, data: { image: next } }
    return this.call('stageImage', request, () => result)
  }

  attachEvidence(request: Parameters<AgentChatApi['attachEvidence']>[0]) {
    const result = this.attachEvidenceResult
    return this.call('attachEvidence', request, () => result)
  }

  models(request: Parameters<AgentChatApi['models']>[0]) {
    const result = this.modelsResult
    return this.call('models', request, () => result)
  }

  private async call<T>(method: Method, request: unknown, produce: () => CommandResult<T>): Promise<CommandResult<T>> {
    this.calls.push({ method, args: [request] })
    await this.holds[method]?.shift()?.promise
    const failure = this.failures[method]
    return failure ? { ok: false, error: failure } : produce()
  }
}
