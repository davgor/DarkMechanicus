import type {
  LearningDetailView,
  LearningHistoryEntryView,
  LearningView,
  ListLearningsInput,
  ReplaceLearningInput,
  ReplaceLearningResultView,
  RetireLearningInput
} from '../../../../shared/domain/learnings'
import type { FakeDm } from '../../__mocks__/fakeDm'

export const SOURCE = { runId: 'rn_src', sprintId: 'sp_src', cardId: 'kc_src', attemptId: 'ka_src' }

export function learningView(patch: Partial<LearningView> = {}): LearningView {
  return {
    formatVersion: 1,
    id: 'lr_1',
    title: 'Run the migration tests',
    rule: 'Run the migration upgrade tests before submitting a schema change.',
    check: 'The attempt evidence lists the migration test run.',
    applicability: { roles: ['worker'], events: ['ticket.claimed'], paths: ['src/core/db/**'] },
    evidence: [{ kind: 'rejected_attempt', sourceId: 'at_rejected', contentHash: `sha256:${'a'.repeat(64)}` }],
    replaces: null,
    source: SOURCE,
    state: 'active',
    replacedBy: null,
    createdAt: '2026-03-01T10:00:00.000Z',
    retiredAt: null,
    retiredReason: null,
    revision: 1,
    definitionHash: `sha256:${'b'.repeat(64)}`,
    ...patch
  }
}

export function historyEntry(patch: Partial<LearningHistoryEntryView> = {}): LearningHistoryEntryView {
  return {
    seq: 1,
    learningId: 'lr_1',
    kind: 'published',
    relatedId: null,
    reason: 'Approved learning card DM-9',
    revision: 1,
    actor: { role: 'desktop', label: 'Desktop' },
    source: SOURCE,
    at: '2026-03-01T10:00:00.000Z',
    ...patch
  }
}

/**
 * Learnings held in memory behind the four learning commands: list by state and query, read with history, and
 * retire or replace an active learning. A stale revision is a `dm.failures` entry, as the command bridge reports it.
 */
export class LearningStore {
  learnings: LearningView[]
  history: Record<string, LearningHistoryEntryView[]> = {}
  private nextId = 100

  constructor(dm: FakeDm, learnings: LearningView[]) {
    this.learnings = learnings
    // FakeDm hands each handler the input the renderer sent for that command.
    dm.handlers.listLearnings = (input) => this.list(input as ListLearningsInput)
    dm.handlers.getLearning = (input) => this.detail(input as { learningId: string })
    dm.handlers.retireLearning = (input) => this.retire(input as RetireLearningInput)
    dm.handlers.replaceLearning = (input) => this.replace(input as ReplaceLearningInput)
  }

  list({ state = 'active', query }: ListLearningsInput): LearningView[] {
    const words = (query ?? '').toLowerCase().split(/\s+/).filter((word) => word !== '')
    return this.learnings
      .filter((learning) => state === 'all' || learning.state === state)
      .filter((learning) => words.every((word) => `${learning.title} ${learning.rule}`.toLowerCase().includes(word)))
  }

  detail({ learningId }: { learningId: string }): LearningDetailView {
    const learning = this.learnings.find((candidate) => candidate.id === learningId)
    if (learning === undefined) throw new Error(`No learning ${learningId}`)
    return { learning, history: this.history[learningId] ?? [historyEntry({ learningId })] }
  }

  private retire({ learningId, reason }: RetireLearningInput, replacedBy: string | null = null): LearningView {
    const current = this.detail({ learningId }).learning
    const retired: LearningView = { ...current, state: 'retired', retiredAt: '2026-03-02T10:00:00.000Z', retiredReason: reason, replacedBy, revision: current.revision + 1 }
    this.learnings = this.learnings.map((learning) => (learning.id === learningId ? retired : learning))
    return retired
  }

  private replace(input: ReplaceLearningInput): ReplaceLearningResultView {
    const successorId = `lr_${this.nextId++}`
    const retired = this.retire(input, successorId)
    const replacement = learningView({ ...input.replacement, id: successorId, evidence: retired.evidence, source: retired.source, replaces: retired.id })
    this.learnings = [replacement, ...this.learnings]
    return { retired, replacement }
  }
}
