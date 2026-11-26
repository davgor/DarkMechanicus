import type { KanbanCardView, KanbanLearningReviewView } from '../../../shared/domain/kanban'
import type { LearningIntegrationSummaryView } from '../../../shared/domain/learnings'

/** What a learning card's review panel says about its outcome: whether records and repository changes are active. */
interface LearningCardStatus {
  tone: 'review' | 'running' | 'failed' | 'accepted' | 'waiting'
  title: string
  /** Whether the card's learning records are active guidance. */
  records: string
  /** Whether the card's guardrail commits are on the target branches. */
  repositories: string
  /** The failure Git or the integration reported, verbatim; null when none. */
  failure: string | null
}

const NOTHING_ACTIVE = 'No learning records from this card are active.'
const NOTHING_CHANGED = 'No target branch was changed.'

/** Published: the integration landed everywhere and the approved drafts are active records. */
function published(review: KanbanLearningReviewView): LearningCardStatus {
  const records = review.publication?.recordIds.length ?? 0
  const targets = review.integration?.targets.length ?? 0
  return {
    tone: 'accepted',
    title: 'Done: approved, integrated and published',
    records: records === 0 ? 'Published with no learning records: the approved review proposed none.' : `${records} learning record${records === 1 ? ' is' : 's are'} active.`,
    repositories: targets === 0 ? 'No repository was affected.' : `Guardrail commits landed on the target branch of ${targets === 1 ? '1 repository' : `${targets} repositories`}.`,
    failure: null
  }
}

/** An integration operation that has not been published yet, by its state. */
function integrationStatus(integration: LearningIntegrationSummaryView): LearningCardStatus {
  const failure = integration.failure?.message ?? null
  if (integration.state === 'conflicted') {
    return { tone: 'failed', title: 'Conflict: approval stopped, nothing published', records: NOTHING_ACTIVE, repositories: NOTHING_CHANGED, failure }
  }
  if (integration.state === 'aborted') {
    return { tone: 'failed', title: 'Integration aborted: nothing published', records: NOTHING_ACTIVE, repositories: NOTHING_CHANGED, failure }
  }
  const done = integration.targets.filter((target) => target.state === 'integrated').length
  const total = integration.targets.length
  return {
    tone: 'running',
    title: 'Integration in progress: partially applied',
    records: `${NOTHING_ACTIVE} They become active only after every repository is integrated.`,
    repositories: `${done} of ${total} ${total === 1 ? 'repository' : 'repositories'} integrated. Approve again, or reopen the app on this computer, to resume from where it stopped.`,
    failure
  }
}

/** Before any integration: waiting for review, kicked back, or not yet submitted. */
function beforeIntegration(card: KanbanCardView): LearningCardStatus {
  const latest = card.attempts.at(-1)
  if (card.lane === 'ready_for_review') {
    return {
      tone: 'review',
      title: 'Ready for review: nothing published yet',
      records: `${NOTHING_ACTIVE} Approving publishes the proposed learnings below once every repository is integrated.`,
      repositories: `${NOTHING_CHANGED} Approving integrates each learnings branch onto its target branch first.`,
      failure: null
    }
  }
  if (latest?.state === 'rejected') {
    return { tone: 'waiting', title: 'Kicked back: nothing was published', records: NOTHING_ACTIVE, repositories: NOTHING_CHANGED, failure: null }
  }
  if (card.lane === 'done') {
    return { tone: 'waiting', title: 'Done without publication', records: NOTHING_ACTIVE, repositories: NOTHING_CHANGED, failure: null }
  }
  return { tone: 'waiting', title: 'Not submitted yet: nothing published', records: NOTHING_ACTIVE, repositories: NOTHING_CHANGED, failure: null }
}

/** The one plain statement of where a learning card stands. */
export function learningCardStatus(card: KanbanCardView, review: KanbanLearningReviewView): LearningCardStatus {
  if (review.publication !== null) return published(review)
  if (review.integration !== null && review.integration.state !== 'published') {
    const latest = card.attempts.at(-1)
    // A closed integration of an earlier attempt says nothing about a newer submission.
    const current = latest === undefined || review.integration.state === 'integrating' || card.lane === 'ready_for_review'
    if (current) return integrationStatus(review.integration)
  }
  return beforeIntegration(card)
}
