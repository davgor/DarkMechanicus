import { describe, expect, it } from 'vitest'
import type { KanbanAttemptView, KanbanCardView, KanbanLearningReviewView } from '../../../shared/domain/kanban'
import type { LearningIntegrationSummaryView } from '../../../shared/domain/learnings'
import { cardView } from './__mocks__/fixtures'
import { learningCardStatus } from './learningCardStatus'

type Target = LearningIntegrationSummaryView['targets'][number]

const NOTHING_ACTIVE = 'No learning records from this card are active.'
const NOTHING_CHANGED = 'No target branch was changed.'

// The status reads only each attempt's state and the card's lane.
const attempt = (state: KanbanAttemptView['state']): KanbanAttemptView => ({ id: `ka_${state}`, number: 1, state }) as KanbanAttemptView

function card(lane: KanbanCardView['lane'], states: KanbanAttemptView['state'][]): KanbanCardView {
  return cardView({ id: 'kc_l', lane, attempts: states.map(attempt) })
}

function target(repository: string | null, state: Target['state']): Target {
  return { repository, branch: 'epic/x', baseCommit: 'a'.repeat(40), oldHead: null, newHead: state === 'integrated' ? 'f'.repeat(40) : null, state }
}

function integration(state: LearningIntegrationSummaryView['state'], targets: Target[], failure: string | null = null): LearningIntegrationSummaryView {
  return { operationId: 'li_1', state, failure: failure === null ? null : { code: state, message: failure }, targets }
}

function review(patch: Partial<KanbanLearningReviewView> = {}): KanbanLearningReviewView {
  return {
    runId: 'rn_1',
    sprintId: 'sp_1',
    reportId: 'rp_1',
    revisionId: null,
    checkpointId: null,
    evidenceHash: `sha256:${'e'.repeat(64)}`,
    snapshot: null,
    branches: [],
    integration: null,
    publication: null,
    ...patch
  }
}

const publication = (recordIds: string[]): KanbanLearningReviewView['publication'] => ({ attemptId: 'ka_1', draftsHash: 'sha256:d', recordIds, publishedAt: '2026-11-22T10:00:00.000Z' })

describe('learningCardStatus when published', () => {
  const done = card('done', ['accepted'])

  it('says no record is active and no repository was affected for an empty publication without integration', () => {
    expect(learningCardStatus(done, review({ publication: publication([]) }))).toEqual({
      tone: 'accepted',
      title: 'Done: approved, integrated and published',
      records: 'Published with no learning records: the approved review proposed none.',
      repositories: 'No repository was affected.',
      failure: null
    })
  })

  it('counts one record and one repository in the singular', () => {
    const status = learningCardStatus(done, review({ publication: publication(['lr_1']), integration: integration('published', [target(null, 'integrated')]) }))
    expect(status.records).toBe('1 learning record is active.')
    expect(status.repositories).toBe('Guardrail commits landed on the target branch of 1 repository.')
  })

  it('counts several records and repositories in the plural', () => {
    const status = learningCardStatus(done, review({ publication: publication(['lr_1', 'lr_2']), integration: integration('published', [target('api', 'integrated'), target('web', 'integrated')]) }))
    expect(status.records).toBe('2 learning records are active.')
    expect(status.repositories).toBe('Guardrail commits landed on the target branch of 2 repositories.')
  })

  it('treats an empty published integration as no repository affected', () => {
    expect(learningCardStatus(done, review({ publication: publication(['lr_1']), integration: integration('published', []) })).repositories).toBe('No repository was affected.')
  })
})

describe('learningCardStatus for an unpublished integration', () => {
  it('reports a conflict with the failure verbatim', () => {
    const status = learningCardStatus(card('ready_for_review', ['submitted']), review({ integration: integration('conflicted', [target(null, 'conflicted')], 'root repository: AGENTS.md') }))
    expect(status).toEqual({ tone: 'failed', title: 'Conflict: approval stopped, nothing published', records: NOTHING_ACTIVE, repositories: NOTHING_CHANGED, failure: 'root repository: AGENTS.md' })
  })

  it('reports an aborted integration, without a failure message when none was recorded', () => {
    const status = learningCardStatus(card('ready_for_review', ['submitted']), review({ integration: integration('aborted', [target(null, 'pending')]) }))
    expect(status).toEqual({ tone: 'failed', title: 'Integration aborted: nothing published', records: NOTHING_ACTIVE, repositories: NOTHING_CHANGED, failure: null })
  })

  it('reports an integration in progress over one repository in the singular', () => {
    const status = learningCardStatus(card('in_progress', ['accepted']), review({ integration: integration('integrating', [target(null, 'integrating')]) }))
    expect(status.tone).toBe('running')
    expect(status.title).toBe('Integration in progress: partially applied')
    expect(status.records).toBe(`${NOTHING_ACTIVE} They become active only after every repository is integrated.`)
    expect(status.repositories).toMatch(/^0 of 1 repository integrated\. Approve again/)
  })

  it('reports a closed integration of a card without attempts as current', () => {
    const status = learningCardStatus(card('in_progress', []), review({ integration: integration('aborted', [target(null, 'pending')], 'stopped') }))
    expect(status.title).toBe('Integration aborted: nothing published')
    expect(status.failure).toBe('stopped')
  })

  it('ignores a closed integration of an earlier attempt once the card was kicked back', () => {
    const status = learningCardStatus(card('in_progress', ['submitted', 'rejected']), review({ integration: integration('conflicted', [target(null, 'conflicted')], 'old conflict') }))
    expect(status).toEqual({ tone: 'waiting', title: 'Kicked back: nothing was published', records: NOTHING_ACTIVE, repositories: NOTHING_CHANGED, failure: null })
  })
})

describe('learningCardStatus before integration', () => {
  it('waits for review on a submitted card', () => {
    const status = learningCardStatus(card('ready_for_review', ['submitted']), review())
    expect(status.tone).toBe('review')
    expect(status.title).toBe('Ready for review: nothing published yet')
  })

  it('says a done card without publication published nothing', () => {
    expect(learningCardStatus(card('done', ['accepted']), review()).title).toBe('Done without publication')
  })

  it('says a card nobody submitted is not submitted yet', () => {
    expect(learningCardStatus(card('backlog', []), review())).toEqual({ tone: 'waiting', title: 'Not submitted yet: nothing published', records: NOTHING_ACTIVE, repositories: NOTHING_CHANGED, failure: null })
  })

  it('treats a finished published-state integration without publication as not yet published', () => {
    expect(learningCardStatus(card('in_progress', ['running']), review({ integration: integration('published', [target(null, 'integrated')]) })).title).toBe('Not submitted yet: nothing published')
  })
})
