import { DomainError } from '../../core/errors'
import type { PendingPrompt } from '../../shared/agents/agentChat'
import { maskAgentChatSecretsDeep as mask } from './secretMask'

export type ArbiterOutcome = { decision: 'allow_once' | 'deny' | 'escalate'; reason: string }
type Arbitration = { result: Promise<ArbiterOutcome>; cancel(): void }
type Decision = Extract<ArbiterOutcome['decision'], 'allow_once' | 'deny'>
type Dependencies = {
  publish(prompt: PendingPrompt | null): void
  arbitrate?: (prompt: PendingPrompt) => Arbitration
  answer(prompt: PendingPrompt, verdict: { decision: Decision; reason: string }): void
}

/** Per-process FIFO view of translator-held prompts. No deadline or remembered permission. */
export class PendingPrompts {
  private current: PendingPrompt | null = null
  private arbitration?: Arbitration
  private answering = false

  constructor(private readonly deps: Dependencies) {}

  snapshot(): PendingPrompt | null { return this.current }

  update(prompts: readonly PendingPrompt[]): void {
    const head = prompts[0]
    if (head?.id === this.current?.id) { this.restamp(head); return }
    this.cancel()
    this.current = head ? { ...head, arbitration: { state: this.deps.arbitrate ? 'deciding' : 'off', reason: null } } : null
    const current = this.current
    this.deps.publish(current)
    if (current && this.deps.arbitrate && this.current === current) this.decide(current)
  }

  /** The head carries the session manager's callsign; a later identity for the same prompt is re-published, not re-decided. */
  private restamp(head: PendingPrompt | undefined): void {
    if (!head || !this.current || JSON.stringify(head.callsign) === JSON.stringify(this.current.callsign)) return
    this.current = { ...this.current, callsign: head.callsign }
    this.deps.publish(this.current)
  }

  clear(): void {
    this.cancel()
    this.current = null
    this.deps.publish(null)
  }

  answer(promptId: string, apply: () => readonly PendingPrompt[]): void {
    if (this.answering || this.current?.id !== promptId) throw new DomainError('stale_prompt', 'This prompt is no longer pending.')
    this.answering = true
    try {
      // A rejected input/write leaves the held prompt and its arbitration intact.
      const next = apply()
      this.cancel()
      this.answering = false
      this.update(next)
    } finally { this.answering = false }
  }

  private cancel(): void {
    const running = this.arbitration
    this.arbitration = undefined
    // Cancellation cannot prevent the person's answer or process cleanup.
    try { running?.cancel() } catch { /* The handle fence still drops its late result. */ }
  }

  /**
   * The current prompt while `running` still decides it. Fenced on the arbitration handle (an answer, withdrawal or
   * replacement drops it, even for a reused id) and the prompt id, not object identity: a restamped callsign is the same prompt.
   */
  private decided(running: Arbitration, id: string): PendingPrompt | null {
    return this.arbitration === running && this.current?.id === id ? this.current : null
  }

  private escalate(prompt: PendingPrompt, reason: string): void {
    this.arbitration = undefined
    this.current = { ...prompt, arbitration: { state: 'escalated', reason: mask(reason).slice(0, 500) } }
    this.deps.publish(this.current)
  }

  private decide(current: PendingPrompt): void {
    let running: Arbitration
    try { running = this.deps.arbitrate!(current) }
    catch { if (this.current === current) this.escalate(current, 'Arbitration failed.'); return }
    if (this.current !== current) { try { running.cancel() } catch { /* Already withdrawn. */ } return }
    this.arbitration = running
    void running.result.then(verdict => {
      const live = this.decided(running, current.id)
      if (!live) return
      if (verdict.decision === 'escalate') { this.escalate(live, verdict.reason); return }
      if (live.kind !== 'approval' || !['allow_once', 'deny'].includes(verdict.decision)) {
        this.escalate(live, 'This prompt requires a person’s answer.'); return
      }
      this.deps.answer(live, { decision: verdict.decision, reason: mask(verdict.reason).slice(0, 500) })
    }).catch(() => {
      const live = this.decided(running, current.id)
      if (live) this.escalate(live, 'Arbitration failed.')
    })
  }
}
