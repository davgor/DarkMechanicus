/**
 * DM-956: one human approval of a sprint learning card at the desktop, from the reviewed card to Done.
 *
 * The person approves the exact card, attempt and staged drafts hash they reviewed. Main asks the folder's own
 * workspace (its utility process, desktop session, `kanban.review`) to prepare the integration: it re-validates the
 * submission under review, its drafts and its verified manifests and creates one operation this machine owns (a
 * replay returns the same one). Native apply then prepares every repository, and before the first canonical change
 * the exact plan is stored machine-locally with the integration moved to `integrating`; each repository's receipt is
 * recorded (and flushed) before the next repository starts, and every core step re-checks this machine's authority
 * over the operation. Only after every repository succeeded is the card approved to Done, the drafts published once
 * and the operation marked published; the Done card is returned. A conflict records the failure on the operation and
 * the card, which stays in Ready for review with its isolated learnings branches untouched, and nothing is published.
 *
 * One approval runs per card at a time; an identical concurrent request joins it. Startup recovery continues each
 * operation this machine owns that stored a plan, from that plan and Git's actual heads, never starting a second
 * operation and never publishing twice. Untrack and quit abort at once and then wait for the whole workflow and every
 * Git process it started to exit before the workspace and its database are released. Ordinary cards keep using
 * `approveKanbanCard`.
 */
import { join } from 'node:path'
import { z } from 'zod'
import { DomainError } from '../../core/errors'
import { parseInput, stableId } from '../../core/schemas'
import type { LearningApprovalState } from '../../core/services/learningApproval'
import type { ApproveLearningCardRequest } from '../../shared/desktop/api'
import type { KanbanCardView } from '../../shared/domain/kanban'
import type {
  CleanCheckoutRequirement,
  LearningIntegrationReceipt,
  LearningIntegrationTargetInput
} from '../../shared/git/learningIntegration'
import type { ProjectWorkspace } from '../desktop/workspaceClient'
import { applyLearningIntegration, recoverLearningIntegration } from '../git/learningApply'
import { type LearningIntegrationDeps, LearningIntegrationError } from '../git/learningIntegration'
import type { GitRunner } from '../git/runner'
import { learningOperationRecord } from './learningOperationRecord'

/** The exact reviewed approval the renderer sends: the card, the attempt under review and its staged drafts hash. */
const approveLearningCardSchema: z.ZodType<ApproveLearningCardRequest> = z.strictObject({
  cardId: stableId,
  attemptId: stableId,
  draftsHash: z.string().regex(/^sha256:[0-9a-f]{64}$/, 'Expected a sha256 content hash')
})

/** What the coordinator uses of a project workspace: its root, storage status, card reads and the approval operations. */
type ApprovalWorkspace = Pick<ProjectWorkspace, 'repoRoot' | 'getStorageStatus' | 'getKanbanCard' | 'call'>

/** The shared runner wrapped so the coordinator knows when every Git process it started has actually exited. */
interface CountingRunner {
  runner: GitRunner
  exited(): Promise<void>
}

interface LearningApprovalDeps {
  /** The canonical tracked folder, or null when the folder is not tracked. */
  resolve(folder: string): string | null
  /** The desktop's own workspace of a tracked folder (`WorkspacePool.get`). */
  workspace(folder: string): ApprovalWorkspace
  /** The shared Git runner and Source control operation locks; the coordinator counts the processes it starts. */
  git: Pick<LearningIntegrationDeps, 'runner' | 'operations' | 'cards' | 'platform'>
}

export interface LearningApprovalController {
  /** The person's approval of a learning card in Ready for review; resolves to the Done card. */
  approve(folder: unknown, input: unknown): Promise<KanbanCardView>
  /** Continues every operation of the folder this machine owns that stored a plan (startup recovery). */
  recover(folder: string): Promise<void>
  /** Untrack: refuses new approvals of the folders, aborts theirs, and waits for them and their Git processes. */
  release(folders: readonly string[]): Promise<void>
  /** True while an approval or recovery runs. */
  busy(): boolean
  /** Quit: refuses new approvals, aborts every running one, and waits for every workflow and Git process to end. */
  dispose(): Promise<void>
}

interface Flight {
  folder: string
  key: string
  request: string
  abort: AbortController
  done: Promise<KanbanCardView | null>
}

/** The shared runner, counting every Git process from its request to its actual exit (`onExit`). */
function countingRunner(runner: GitRunner): CountingRunner {
  let live = 0
  let waiters: (() => void)[] = []
  const settle = (): void => {
    live -= 1
    if (live > 0) return
    for (const resolve of waiters.splice(0)) resolve()
  }
  return {
    runner: {
      run(request) {
        live += 1
        return runner.run({ ...request, onExit: () => (settle(), request.onExit?.()) })
      }
    },
    exited: () => (live === 0 ? Promise.resolve() : new Promise<void>((resolve) => void waiters.push(resolve)))
  }
}

/** A native refusal reaches the renderer as a domain error with its Git reason. */
function asDomainError(error: unknown): unknown {
  if (!(error instanceof LearningIntegrationError)) return error
  return new DomainError('conflict', error.message, { reason: error.code })
}

const targetsOf = (workspace: ApprovalWorkspace, state: LearningApprovalState): LearningIntegrationTargetInput[] =>
  state.targets.map(({ repository, branch }) => ({ repository, branch, checkout: repository === null ? workspace.repoRoot : join(workspace.repoRoot, repository) }))

interface Continuation {
  workspace: ApprovalWorkspace
  state: LearningApprovalState
  signal: AbortSignal
  cleanCheckout: CleanCheckoutRequirement
}

/** Applies a prepared operation (no plan yet) from preparation on; a conflict is recorded and refused. */
async function applyPrepared(git: LearningIntegrationDeps, { workspace, state, signal, cleanCheckout }: Continuation): Promise<void> {
  const id = state.integrationId
  const result = await applyLearningIntegration(git, {
    cardId: state.cardId,
    attemptId: state.attemptId,
    manifests: state.manifests,
    targets: targetsOf(workspace, state),
    persistPrepared: (plan) => workspace.call('recordLearningPlan', id, plan),
    onApplied: (receipt) => workspace.call('recordLearningReceipt', id, receipt),
    signal,
    cleanCheckout
  })
  if (result.state === 'conflicted') {
    const message = await workspace.call('recordLearningConflict', id, result.conflicts)
    throw new DomainError('conflict', message, { integrationId: id, conflicts: result.conflicts })
  }
}

/** Takes an operation from its current state to published and returns the Done card. */
async function complete(git: LearningIntegrationDeps, workspace: ApprovalWorkspace, state: LearningApprovalState, signal: AbortSignal): Promise<KanbanCardView> {
  if (state.state === 'published') return workspace.getKanbanCard({ cardId: state.cardId })
  const cleanCheckout = await learningOperationRecord(workspace, state.integrationId)
  if (state.plan === null) {
    await applyPrepared(git, { workspace, state, signal, cleanCheckout })
  } else {
    const onApplied = (receipt: LearningIntegrationReceipt) =>
      workspace.call('recordLearningReceipt', state.integrationId, receipt)
    await recoverLearningIntegration(git, { attemptId: state.attemptId, plan: state.plan, onApplied, signal, cleanCheckout })
  }
  return workspace.call('finishLearningApproval', state.integrationId)
}

class Coordinator implements LearningApprovalController {
  private readonly flights = new Map<string, Flight>()
  private readonly closed = new Set<string>()
  private stopping = false
  private readonly native: CountingRunner
  private readonly git: LearningIntegrationDeps

  constructor(private readonly deps: LearningApprovalDeps) {
    this.native = countingRunner(deps.git.runner)
    this.git = { ...deps.git, runner: this.native.runner }
  }

  async approve(folder: unknown, input: unknown): Promise<KanbanCardView> {
    const request = parseInput(approveLearningCardSchema, input, 'approval')
    const tracked = typeof folder === 'string' ? this.deps.resolve(folder) : null
    if (tracked === null) throw new DomainError('unauthorized', 'That folder is not tracked by Dark Mechanicus.')
    const card = await this.fly(tracked, request.cardId, JSON.stringify(request), async (signal) => {
      const workspace = this.deps.workspace(tracked)
      const state = await workspace.call('prepareLearningApproval', request)
      return complete(this.git, workspace, state, signal)
    })
    return card ?? Promise.reject(new DomainError('conflict', 'The approval was stopped before it finished.'))
  }

  async recover(folder: string): Promise<void> {
    if (this.stopping || this.closed.has(folder)) return
    const workspace = this.deps.workspace(folder)
    const pending = await workspace.call('pendingLearningApprovals')
    for (const state of pending.filter((operation) => operation.plan !== null)) {
      const request = JSON.stringify({ cardId: state.cardId, attemptId: state.attemptId, draftsHash: state.draftsHash })
      await this.fly(folder, state.cardId, request, (signal) => complete(this.git, workspace, state, signal))
    }
  }

  /** Runs `work` as the card's one flight; an identical request joins it, any other is refused while it runs. */
  private fly(folder: string, cardId: string, request: string, work: (signal: AbortSignal) => Promise<KanbanCardView>): Promise<KanbanCardView | null> {
    if (this.stopping || this.closed.has(folder)) return Promise.reject(new DomainError('conflict', 'This project is closing; approve the card after it reopens.'))
    const key = JSON.stringify([folder, cardId])
    const running = this.flights.get(key)
    if (running !== undefined) {
      if (running.request === request) return running.done
      return Promise.reject(new DomainError('conflict', `Another approval of card ${cardId} is running.`, { cardId }))
    }
    const abort = new AbortController()
    const done = work(abort.signal)
      .catch((error: unknown) => {
        throw asDomainError(error)
      })
      .finally(() => this.flights.delete(key))
    this.flights.set(key, { folder, key, request, abort, done })
    return done
  }

  /** Aborts the matching flights now, then waits for each to settle and for every Git process to exit. */
  private async drain(matching: (flight: Flight) => boolean): Promise<void> {
    const stopping: Promise<unknown>[] = []
    for (const flight of this.flights.values()) {
      if (!matching(flight)) continue
      flight.abort.abort()
      stopping.push(flight.done.catch(() => undefined))
    }
    await Promise.all(stopping)
    await this.native.exited()
  }

  async release(folders: readonly string[]): Promise<void> {
    for (const folder of folders) this.closed.add(folder)
    try {
      await this.drain((flight) => folders.includes(flight.folder))
    } finally {
      for (const folder of folders) this.closed.delete(folder)
    }
  }

  busy(): boolean {
    return this.flights.size > 0
  }

  dispose(): Promise<void> {
    this.stopping = true
    return this.drain(() => true)
  }
}

export function createLearningApprovals(deps: LearningApprovalDeps): LearningApprovalController {
  return new Coordinator(deps)
}
