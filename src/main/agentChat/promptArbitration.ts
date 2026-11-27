/**
 * Routes each new pending prompt of a run's Magos chat through a short-lived arbiter before it needs the person.
 * Main-only: settings are read fresh from the main store per prompt, never from the renderer. Every failure, timeout,
 * refusal or exclusion leaves the prompt pending for the person, who can always answer first.
 */
import { mkdirSync } from 'node:fs'
import type { PendingPrompt } from '../../shared/agents/agentChat'
import type { ChatRecord } from '../../shared/agents/chat'
import type { AgentView } from '../../shared/desktop/api'
import type { NotificationSettings } from '../../shared/desktop/notificationSettings'
import type { ChatRef } from '../agents/chatStore'
import { arbiterLaunch } from '../magos/arbiterLaunch'
import { ARBITER_SYSTEM_PROMPT, buildArbiterRequest } from '../magos/arbiterPrompt'
import { startArbiter, type ArbiterLog, type ArbiterResult } from '../magos/arbiterRunner'
import { arbitrationExclusion, exclusionText, type ExclusionReason } from '../magos/arbitrationRules'
import type { ArbiterOutcome, ArbitrationGate, AttentionEvent } from './pendingPrompts'

const MAX_ARBITERS = 3
const ARBITER_TIMEOUT_MS = 60_000
/**
 * The longest `dispose` waits for cancelled runners' cleanup, inside the app's 5 s quit bound. A cancel already sends
 * the forced tree kill (`taskkill /t /f`, or SIGKILL to the process group); past this bound the quit goes on.
 */
const DISPOSE_TIMEOUT_MS = 4_000
/** Exclusions the person decides with no Magos line on the card; every other exclusion shows its reason. */
const OFF_REASONS: ReadonlySet<ExclusionReason> = new Set(['disabled', 'not_magos_chat', 'project_less', 'unsupported_kind'])
const TOO_LARGE = 'Input too large to review; decide this yourself.'
const CONTEXT_UNAVAILABLE = 'The Magos could not read the ticket or the Standards for this request; decide this yourself.'

type ArbiterTicket = Parameters<typeof buildArbiterRequest>[0]['ticket']
type Arbitration = Pick<NotificationSettings, 'arbitration'>
interface ArbiterContext { ticket: ArbiterTicket; standards: string | null }
type Cause = ExclusionReason | 'too_large' | 'context_unavailable' | 'cancelled' | Extract<ArbiterResult, { decision: 'escalate' }>['cause']

interface PromptArbitrationDeps {
  /** The main store's arbitration settings, read at the moment each prompt arrives. */
  settings(): Pick<NotificationSettings, 'arbitration'>
  /** The person must look at `prompt`: it was excluded, escalated, or the arbiter is off. */
  onAttention(event: Extract<AttentionEvent, { prompt: PendingPrompt }>): void
  /** The bound ticket and the epic's Standards section (DM-821 `readArbiterContext`); a rejection escalates, starting no arbiter. */
  readContext(input: { chat: ChatRecord; prompt: PendingPrompt }): Promise<ArbiterContext>
  /**
   * The chat folder's place in each registered worktree of its repository, read off the main thread. Wired by the
   * arbiter boot; omitted, only the folder is a root.
   */
  allowedRoots?(chat: ChatRecord): Promise<readonly string[]>
  platform: NodeJS.Platform
  env: Readonly<Record<string, string | undefined>>
  /** Where each arbiter's fresh working folder is made (`<userData>/agents/arbiter`, swept at startup by DM-821). */
  arbiterRoot: string
  /** Arbiter wall-clock bound; 60 s when omitted. */
  timeoutMs?: number
  /** The isolated runner; tests substitute a stub. */
  startArbiter?: typeof startArbiter
  /**
   * The app logger, passed in by the main process: each decision's one line, and the runner's own reports. Never
   * imported here, so loading the gate never loads Electron.
   */
  log: ArbiterLog
}

/** `inputClipped`: the translator recorded, at the cut, that the prompt's tool input is shorter than what the CLI runs. */
interface ArbitrateInput { ref: ChatRef; chat: ChatRecord; agent: AgentView; prompt: PendingPrompt; inputClipped: boolean }

interface PromptArbitration {
  /** The `arbitrate` seam of the GUI session manager. */
  arbitrate(input: ArbitrateInput): ArbitrationGate
  /**
   * Cancels every queued and running arbiter, and resolves once their runners have cleaned up or after
   * `DISPOSE_TIMEOUT_MS`, whichever comes first; it never rejects.
   */
  dispose(): Promise<void>
}

type Verdict = ArbiterResult | { decision: 'escalate'; cause: ExclusionReason | 'too_large' | 'context_unavailable'; reason: string }

function log(deps: PromptArbitrationDeps, input: ArbitrateInput, decision: string, cause: Cause | 'verdict'): void {
  try {
    deps.log.info('Magos arbitration:', { chatId: input.chat.id, promptId: input.prompt.id, decision, cause })
  } catch { /* Logging never changes an outcome. */ }
}

function attention(deps: PromptArbitrationDeps, input: ArbitrateInput, prompt: PendingPrompt): void {
  deps.onAttention({ kind: prompt.kind === 'question' ? 'question' : 'approval_needed', ref: input.ref, prompt })
}

type Excluded = { state: 'off' | 'escalated'; reason: string | null }

function excluded(deps: PromptArbitrationDeps, input: ArbitrateInput, { state, reason }: Excluded, cause: Cause): ArbitrationGate {
  log(deps, input, state, cause)
  return { state, reason, awaitingPerson: prompt => attention(deps, input, prompt) }
}

function exclusionOf(deps: PromptArbitrationDeps, input: ArbitrateInput, settings: Arbitration, allowedRoots: readonly string[]): { reason: ExclusionReason } | null {
  const { chat, agent, prompt } = input
  return arbitrationExclusion({ chat, agentKind: agent.kind, prompt, folder: chat.folder, settings, platform: deps.platform, allowedRoots })
}

/**
 * The person decides at once: an exclusion (fix 7 mapping), or a tool input clipped before it reached the prompt.
 * `exclusion` counts only the folder as a root: a path outside it may lie in a registered worktree, which the job
 * reads asynchronously and checks before any arbiter starts.
 */
function exclusionGate(deps: PromptArbitrationDeps, input: ArbitrateInput, exclusion: { reason: ExclusionReason } | null): ArbitrationGate | null {
  if (exclusion !== null) {
    // Decided by the job once the worktrees are read; it also applies the clip flag, which an exclusion outranks.
    if (exclusion.reason === 'outside_folder' && deps.allowedRoots !== undefined) return null
    const { reason } = exclusion
    return OFF_REASONS.has(reason)
      ? excluded(deps, input, { state: 'off', reason: null }, reason)
      : excluded(deps, input, { state: 'escalated', reason: exclusionText(reason) }, reason)
  }
  // The prompt shows a clipped input but the CLI runs the whole one: nothing past the cut was scanned.
  if (input.inputClipped || input.prompt.tool === undefined) return excluded(deps, input, { state: 'escalated', reason: TOO_LARGE }, 'too_large')
  return null
}

/**
 * One arbiter for one prompt: is admitted once the worktree roots are checked (when the folder alone left a path
 * outside, `checkRoots`), then waits for a slot, reads context and runs until its verdict, cancellation or dispose.
 */
class ArbiterJob {
  /** Its outcome is out (verdict or cancellation); a running runner may still be cleaning up. */
  private settled = false
  private cancelRunner?: () => void
  private complete!: (outcome: ArbiterOutcome) => void
  readonly result = new Promise<ArbiterOutcome>(resolve => { this.complete = resolve })

  constructor(
    private readonly deps: PromptArbitrationDeps, readonly input: ArbitrateInput,
    private readonly settings: Arbitration, private readonly checkRoots: boolean
  ) {}

  get waiting(): boolean { return !this.settled }

  cancel(): void {
    if (this.settled) return
    this.settled = true
    log(this.deps, this.input, 'dropped', 'cancelled')
    this.complete({ decision: 'escalate', reason: 'Arbiter cancelled.' })
    try { this.cancelRunner?.() } catch { /* The runner's own fence still drops its result. */ }
  }

  /**
   * Whether the job may wait for a slot: false once it is settled, here by the worktree-roots exclusion or the clip
   * flag it outranks. Needs no slot, so a prompt that escalates anyway never waits behind running arbiters.
   */
  async admit(): Promise<boolean> {
    try {
      const escalation = await this.rootsExclusion()
      if (escalation !== null) this.finish(escalation)
    } catch {
      this.finish({ decision: 'escalate', cause: 'error', reason: 'The Magos could not check this request; decide this yourself.' })
    }
    return this.waiting
  }

  /** Resolves once the runner has settled, process cleanup included. */
  async start(): Promise<void> {
    try {
      const request = await this.request()
      if (this.settled) return
      if (typeof request !== 'string') { this.finish(request); return }
      const { deps } = this, { agent } = this.input
      // The runner makes its fresh folder inside; an existing root is one stat.
      mkdirSync(deps.arbiterRoot, { recursive: true })
      const runner = (deps.startArbiter ?? startArbiter)({
        launch: tempDir => arbiterLaunch({ agent, platform: deps.platform, baseEnv: deps.env, tempDir, systemPrompt: ARBITER_SYSTEM_PROMPT }),
        input: request, tempRoot: deps.arbiterRoot, log: deps.log, timeoutMs: deps.timeoutMs ?? ARBITER_TIMEOUT_MS
      })
      this.cancelRunner = runner.cancel
      this.finish(await runner.result)
    } catch {
      this.finish({ decision: 'escalate', cause: 'error', reason: 'Arbiter failed to start.' })
    }
  }

  /**
   * The exclusion once the registered worktrees are roots too, then the clip flag it outranks, as an escalation; null
   * when neither applies.
   */
  private async rootsExclusion(): Promise<Verdict | null> {
    if (!this.checkRoots || this.deps.allowedRoots === undefined) return null
    const roots = await this.deps.allowedRoots(this.input.chat)
    const exclusion = exclusionOf(this.deps, this.input, this.settings, roots)
    if (exclusion !== null) return { decision: 'escalate', cause: exclusion.reason, reason: exclusionText(exclusion.reason) }
    return this.input.inputClipped ? { decision: 'escalate', cause: 'too_large', reason: TOO_LARGE } : null
  }

  /** The masked stdin request, or the escalation when the context cannot be read or the request is too large (fix 17). */
  private async request(): Promise<string | Verdict> {
    const { chat, prompt } = this.input
    let context: ArbiterContext
    try {
      context = await this.deps.readContext({ chat, prompt })
    } catch {
      return { decision: 'escalate', cause: 'context_unavailable', reason: CONTEXT_UNAVAILABLE }
    }
    const request = buildArbiterRequest({
      prompt, callsign: prompt.callsign, ticket: context.ticket,
      // buildArbiterRequest re-extracts a Standards section; an extracted section holds no level-1 heading, so this is lossless.
      intent: context.standards === null ? null : `# Standards\n${context.standards}`,
      autoHandle: this.deps.settings().arbitration.autoHandleNotes
    })
    return typeof request === 'string' ? request : { decision: 'escalate', cause: 'too_large', reason: TOO_LARGE }
  }

  private finish(verdict: Verdict): void {
    if (this.settled) return
    this.settled = true
    log(this.deps, this.input, verdict.decision, verdict.decision === 'escalate' ? verdict.cause : 'verdict')
    this.complete({ decision: verdict.decision, reason: verdict.reason })
  }
}

/**
 * FIFO, at most one per chat and `MAX_ARBITERS` app-wide; a cancelled runner holds its slot until its cleanup ends. A
 * job joins the FIFO only once admitted.
 */
class ArbiterQueue {
  private readonly queue: ArbiterJob[] = []
  /** Jobs whose worktree roots are still being checked, before they join the FIFO. */
  private readonly admitting = new Set<ArbiterJob>()
  /** Each running job with its start, which settles once its runner has cleaned up. */
  private readonly running = new Map<ArbiterJob, Promise<void>>()

  add(job: ArbiterJob): void {
    this.admitting.add(job)
    // admit() never rejects, and resolves after the gate returns, so the prompt is published as deciding first.
    void job.admit().then(admitted => {
      this.admitting.delete(job)
      if (!admitted) return
      this.queue.push(job)
      this.pump()
    })
  }

  /** Cancels every job; resolves once the running ones' runners have cleaned up. */
  cancelAll(): Promise<void> {
    for (const job of this.admitting) job.cancel()
    for (const job of this.queue) job.cancel()
    for (const job of this.running.keys()) job.cancel()
    return Promise.all(this.running.values()).then(() => undefined)
  }

  private pump(): void {
    let index = 0
    while (index < this.queue.length && this.running.size < MAX_ARBITERS) {
      const job = this.queue[index]
      if (!job.waiting) { this.queue.splice(index, 1); continue }
      if (this.busy(job.input.chat.id)) { index++; continue }
      this.queue.splice(index, 1)
      // start() never rejects: every failure finishes the job as an escalation.
      this.running.set(job, job.start().finally(() => { this.running.delete(job); this.pump() }))
    }
  }

  private busy(chatId: string): boolean {
    for (const job of this.running.keys()) if (job.input.chat.id === chatId) return true
    return false
  }
}

/** Resolves when `work` settles or after `ms`, whichever comes first; never rejects. */
function atMost(work: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  // The repository's ES library predates Promise.withResolvers.
  const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, ms) })
  return Promise.race([work.catch(() => undefined), timeout]).finally(() => clearTimeout(timer))
}

export function createPromptArbitration(deps: PromptArbitrationDeps): PromptArbitration {
  const queue = new ArbiterQueue()
  const decide = (input: ArbitrateInput, settings: Arbitration, checkRoots: boolean): ArbitrationGate => {
    const job = new ArbiterJob(deps, input, settings, checkRoots)
    queue.add(job)
    return { state: 'deciding', result: job.result, cancel: () => job.cancel(), awaitingPerson: prompt => attention(deps, input, prompt) }
  }
  return {
    arbitrate: input => {
      try {
        const settings = deps.settings()
        const exclusion = exclusionOf(deps, input, settings, [])
        // Past the gate, a remaining exclusion is a path outside the folder alone: the job checks it with the worktrees.
        return exclusionGate(deps, input, exclusion) ?? decide(input, settings, exclusion !== null)
      } catch {
        return excluded(deps, input, { state: 'escalated', reason: 'The Magos could not check this request; decide this yourself.' }, 'error')
      }
    },
    dispose: () => atMost(queue.cancelAll(), DISPOSE_TIMEOUT_MS)
  }
}
