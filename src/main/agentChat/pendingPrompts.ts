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
    if (prompts[0]?.id === this.current?.id) return
    this.cancel()
    const head = prompts[0]
    this.current = head ? { ...head, arbitration: { state: this.deps.arbitrate ? 'deciding' : 'off', reason: null } } : null
    const current = this.current
    this.deps.publish(current)
    if (current && this.deps.arbitrate && this.current === current) this.decide(current)
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
    try { running?.cancel() } catch { /* The identity fence still drops its late result. */ }
  }

  private escalate(current: PendingPrompt, reason: string): void {
    if (this.current !== current) return
    this.arbitration = undefined
    this.current = { ...current, arbitration: { state: 'escalated', reason: mask(reason).slice(0, 500) } }
    this.deps.publish(this.current)
  }

  private decide(current: PendingPrompt): void {
    let running: Arbitration
    try { running = this.deps.arbitrate!(current) }
    catch { this.escalate(current, 'Arbitration failed.'); return }
    if (this.current !== current) { try { running.cancel() } catch { /* Already withdrawn. */ } return }
    this.arbitration = running
    void running.result.then(verdict => {
      if (this.current !== current || this.arbitration !== running) return
      if (verdict.decision === 'escalate') { this.escalate(current, verdict.reason); return }
      if (current.kind !== 'approval' || !['allow_once', 'deny'].includes(verdict.decision)) {
        this.escalate(current, 'This prompt requires a person’s answer.'); return
      }
      this.deps.answer(current, { decision: verdict.decision, reason: mask(verdict.reason).slice(0, 500) })
    }).catch(() => this.escalate(current, 'Arbitration failed.'))
  }
}
