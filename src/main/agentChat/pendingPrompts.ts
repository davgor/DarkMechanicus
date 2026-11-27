import { DomainError } from '../../core/errors'
import type { PendingPrompt } from '../../shared/agents/agentChat'
import type { ChatRef } from '../agents/chatStore'
import { maskAgentChatSecretsDeep as mask } from './secretMask'

export type ArbiterOutcome = { decision: 'allow_once' | 'deny' | 'escalate'; reason: string }
/**
 * What the person must look at, for one OS notifier: a prompt waiting on them (the Magos gate, `promptArbitration.ts`),
 * or a run's Magos chat busy and silent too long (`run_stalled`, from the GUI session manager), which carries only the
 * chat ref and the silence.
 */
export type AttentionEvent =
  | { kind: 'approval_needed' | 'question'; ref: ChatRef; prompt: PendingPrompt }
  | { kind: 'run_stalled'; ref: ChatRef; silentMs: number }
/**
 * The arbiter gate's answer for a newly exposed head: an excluded prompt goes to the person at once (`off` shows no
 * Magos line, `escalated` shows its reason); otherwise the arbiter decides it. `awaitingPerson` is told, once, after
 * the prompt is published waiting for the person: at once when excluded, or when an escalation is applied.
 */
export type ArbitrationGate = { awaitingPerson(prompt: PendingPrompt): void } & (
  | { state: 'off' | 'escalated'; reason: string | null }
  | { state: 'deciding'; result: Promise<ArbiterOutcome>; cancel(): void })
type Arbitration = Extract<ArbitrationGate, { state: 'deciding' }>
type Decision = Extract<ArbiterOutcome['decision'], 'allow_once' | 'deny'>
type Dependencies = {
  publish(prompt: PendingPrompt | null): void
  arbitrate?: (prompt: PendingPrompt) => ArbitrationGate
  answer(prompt: PendingPrompt, verdict: { decision: Decision; reason: string }): void
  /** The queue or the head's arbitration may have changed (`queue()`); called after the head is published, never deduplicated. */
  changed?(): void
}

/** The published arbitration state of a new head; the gate's own reason is masked and bounded like every reason. */
function arbitrationOf(gate: ArbitrationGate | null | 'failed'): PendingPrompt['arbitration'] {
  if (gate === null) return { state: 'off', reason: null }
  if (gate === 'failed') return { state: 'escalated', reason: 'Arbitration failed.' }
  if (gate.state === 'deciding' || gate.reason === null) return { state: gate.state, reason: null }
  return { state: gate.state, reason: mask(gate.reason).slice(0, 500) }
}

/** Per-process FIFO view of translator-held prompts. No deadline or remembered permission. */
export class PendingPrompts {
  private current: PendingPrompt | null = null
  /** The held prompts behind the head, as last given; their arbitration stays the translator's until they lead. */
  private waiting: readonly PendingPrompt[] = []
  private arbitration?: Arbitration
  private answering = false

  constructor(private readonly deps: Dependencies) {}

  snapshot(): PendingPrompt | null { return this.current }

  /** The head (with its arbitration state) followed by every prompt queued behind it. */
  queue(): readonly PendingPrompt[] { return this.current ? [this.current, ...this.waiting] : [] }

  update(prompts: readonly PendingPrompt[]): void {
    this.waiting = prompts.slice(1)
    this.lead(prompts[0])
    this.deps.changed?.()
  }

  private lead(head: PendingPrompt | undefined): void {
    if (head?.id === this.current?.id) { this.restamp(head); return }
    this.cancel()
    this.current = null
    if (!head) { this.deps.publish(null); return }
    const gate = this.gate(head)
    const current: PendingPrompt = { ...head, arbitration: arbitrationOf(gate) }
    this.current = current
    if (gate !== null && gate !== 'failed') this.start(gate, current)
    else this.deps.publish(current)
  }

  /** No gate: the person decides (`off`). A gate that throws never decides either: the person does (`escalated`). */
  private gate(head: PendingPrompt): ArbitrationGate | null | 'failed' {
    try { return this.deps.arbitrate?.(head) ?? null }
    catch { return 'failed' }
  }

  /** Publishes `current`, then lets the arbiter decide it or tells the gate it waits for the person. */
  private start(gate: ArbitrationGate, current: PendingPrompt): void {
    if (gate.state === 'deciding') this.arbitration = gate
    this.deps.publish(current)
    if (gate.state !== 'deciding') { if (this.current === current) gate.awaitingPerson(current) }
    else if (this.arbitration === gate) this.decide(gate, current.id)
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
    this.waiting = []
    this.deps.publish(null)
    this.deps.changed?.()
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

  private escalate(running: Arbitration, prompt: PendingPrompt, reason: string): void {
    this.arbitration = undefined
    const current: PendingPrompt = { ...prompt, arbitration: { state: 'escalated', reason: mask(reason).slice(0, 500) } }
    this.current = current
    this.deps.publish(current)
    this.deps.changed?.()
    if (this.current === current) running.awaitingPerson(current)
  }

  private decide(running: Arbitration, id: string): void {
    void running.result.then(verdict => {
      const live = this.decided(running, id)
      if (!live) return
      if (verdict.decision === 'escalate') { this.escalate(running, live, verdict.reason); return }
      if (live.kind !== 'approval' || !['allow_once', 'deny'].includes(verdict.decision)) {
        this.escalate(running, live, 'This prompt requires a person’s answer.'); return
      }
      this.deps.answer(live, { decision: verdict.decision, reason: mask(verdict.reason).slice(0, 500) })
    }).catch(() => {
      const live = this.decided(running, id)
      if (live) this.escalate(running, live, 'Arbitration failed.')
    })
  }
}
