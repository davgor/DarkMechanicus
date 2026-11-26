// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentAuthStatus } from '../../../shared/desktop/api'
import type { KanbanAttemptView, KanbanCardView, KanbanLearningReviewView, LearningSubmissionEvidence, VerifiedLearningManifest } from '../../../shared/domain/kanban'
import type { LearningDraft, LearningEvidenceItem, LearningEvidenceSnapshot, StagedLearningDraftsView } from '../../../shared/domain/learnings'
import { FakeDm } from '../__mocks__/fakeDm'
import { agentView } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import type { OrchestrationHost } from '../epic/orchestration'
import { cardView } from './__mocks__/fixtures'
import { KanbanCardPanel } from './KanbanCardPanel'

afterEach(cleanup)

const SIGNED_IN: AgentAuthStatus = { state: 'signed_in', reason: 'ok' }
const HASH = (char: string): string => `sha256:${char.repeat(64)}`
const RUN = 'rn_01m878vacn8sa165fkxx76jf0p'
const SPRINT = 'sp_01m877qfj65tcnpe1zcya3w8dn'
const REPORT = 'rp_01m877ym5kj3nydv11sna2t15f'

let dm: FakeDm
let cards: Record<string, KanbanCardView>
let staged: Record<string, StagedLearningDraftsView>

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
  cards = {}
  staged = {}
  dm.handlers.getKanbanCard = (input) => {
    const card = input !== null && typeof input === 'object' && 'cardId' in input && typeof input.cardId === 'string' ? cards[input.cardId] : undefined
    if (card === undefined) throw new Error('no such card')
    return card
  }
  dm.handlers.getStagedLearningDrafts = (input) => {
    const found = input !== null && typeof input === 'object' && 'attemptId' in input && typeof input.attemptId === 'string' ? staged[input.attemptId] : undefined
    if (found === undefined) throw new Error('Attempt staged no learning drafts.')
    return found
  }
  dm.handlers.listKanbanMessages = () => []
})

function host(): OrchestrationHost {
  return {
    agents: [agentView({ kind: 'claude' })],
    statuses: { claude: SIGNED_IN },
    chats: [],
    onChatsChanged: () => Promise.resolve(),
    onAddAgent: () => undefined,
    onAgentStatus: () => undefined,
    onOpenChat: () => undefined
  }
}

const panelFor = (cardId: string): JSX.Element => (
  <KanbanCardPanel folderPath="/a" folderKey="00000000000000000000000000000001" cardId={cardId} refreshToken={0} host={host()} onChanged={() => undefined} onClose={() => undefined} />
)

async function show(cardId = 'kc_l'): Promise<HTMLElement> {
  render(panelFor(cardId))
  await settle()
  return screen.getByRole('complementary')
}

const region = (panel: HTMLElement, name: string): HTMLElement => within(panel).getByRole('region', { name })

function item(sourceId: string, patch: { ticketKey?: string | null; reportId?: string | null; standing?: boolean } = {}): LearningEvidenceItem {
  const ticketKey = patch.ticketKey ?? null
  return {
    kind: 'failed_attempt',
    sourceId,
    contentHash: HASH('a'),
    fingerprint: HASH('f'),
    occurredAt: '2026-11-20T10:00:00.000Z',
    standing: patch.standing ?? true,
    provenance: {
      runId: RUN,
      sprintId: SPRINT,
      revisionId: 'rv_1',
      ticketId: null,
      ticketKey,
      attemptId: null,
      attemptNumber: null,
      rowCheckId: null,
      row: null,
      checkNumber: null,
      reportId: patch.reportId ?? null,
      reportRevision: null
    },
    repositories: [],
    paths: [],
    statements: [{ field: 'failure.message', text: `Statement of ${sourceId}` }]
  }
}

function snapshot(items: LearningEvidenceItem[], report: LearningEvidenceSnapshot['report'] = null): LearningEvidenceSnapshot {
  return { formatVersion: 1, runId: RUN, sprintId: SPRINT, sprintOrdinal: 3, revisionId: 'rv_1', report, items, contentHash: HASH('e') }
}

function review(patch: Partial<KanbanLearningReviewView> = {}): KanbanLearningReviewView {
  return {
    runId: RUN,
    sprintId: SPRINT,
    reportId: REPORT,
    revisionId: null,
    checkpointId: null,
    evidenceHash: HASH('e'),
    snapshot: null,
    branches: [],
    integration: null,
    publication: null,
    ...patch
  }
}

function attempt(id: string, learning: LearningSubmissionEvidence | null): KanbanAttemptView {
  return {
    id,
    cardId: 'kc_l',
    number: 2,
    state: 'submitted',
    machineId: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    progressNote: null,
    outputs: { summary: 'Codified learnings.', artifacts: [], commits: [], changedFiles: [], branch: null },
    evidence: learning === null ? { checks: [], criteria: [], notes: '' } : { checks: [], criteria: [], notes: '', learning },
    reviewComment: null,
    createdAt: '2026-11-21T10:00:00.000Z',
    submittedAt: '2026-11-21T11:00:00.000Z',
    decidedAt: null
  }
}

const evidence = (patch: Partial<LearningSubmissionEvidence> = {}): LearningSubmissionEvidence => ({ snapshotHash: HASH('e'), draftsHash: HASH('d'), dispositions: [], manifests: [], ...patch })

function learningCard(id: string, learningReview: KanbanLearningReviewView, attempts: KanbanAttemptView[]): KanbanCardView {
  const card = cardView({ id, key: 'DM-50', title: 'Sprint 3 learnings', lane: 'ready_for_review', openAttempt: null, attempts, learning: learningReview })
  cards[id] = card
  return card
}

function draft(patch: Partial<LearningDraft> = {}): LearningDraft {
  return {
    title: 'Pin the build cache',
    rule: 'Pin the build cache key to the lockfile hash.',
    check: 'The build log names the lockfile hash.',
    applicability: { roles: ['worker'], events: [], paths: [] },
    evidence: [],
    replaces: null,
    ...patch
  }
}

function stage(attemptId: string, drafts: LearningDraft[]): void {
  staged[attemptId] = {
    cardId: 'kc_l',
    attemptId,
    runId: RUN,
    sprintId: SPRINT,
    snapshotHash: HASH('e'),
    drafts,
    draftsHash: HASH('d'),
    evidence: [],
    stagedBy: { role: 'worker', label: 'Acolyte' },
    stagedAt: '2026-11-21T11:00:00.000Z'
  }
}

describe('LearningCardDetails provenance and evidence edge states', () => {
  it('shows a pre-snapshot card by its stored ids and says no evidence snapshot exists', async () => {
    learningCard('kc_l', review(), [])
    const panel = await show()
    const provenance = region(panel, 'Provenance')
    expect(within(provenance).getByText('Sprint', { selector: 'dt' }).nextElementSibling?.textContent).toBe(SPRINT)
    expect(within(provenance).getByText('Report', { selector: 'dt' }).nextElementSibling?.textContent).toBe(REPORT)
    expect(within(provenance).queryByText('Checkpoint', { selector: 'dt' })).toBeNull()
    const section = region(panel, 'Sprint evidence')
    expect(within(section).getByRole('heading', { name: 'SPRINT EVIDENCE (0)' })).toBeTruthy()
    expect(section.textContent).toContain('This card was generated before evidence snapshots were stored.')
    expect(section.textContent).not.toContain('The evidence snapshot is empty')
  })

  it('names the sprint ordinal but not a report revision when the snapshot holds no report, and shows the checkpoint', async () => {
    learningCard('kc_l', review({ checkpointId: 'ck_1', snapshot: snapshot([item('at_x:failure', { ticketKey: 'DM-12' })]) }), [])
    const provenance = region(await show(), 'Provenance')
    expect(within(provenance).getByText('Sprint', { selector: 'dt' }).nextElementSibling?.textContent).toBe(`Sprint 3 · ${SPRINT}`)
    expect(within(provenance).getByText('Report', { selector: 'dt' }).nextElementSibling?.textContent).toBe(REPORT)
    expect(within(provenance).getByText('Checkpoint', { selector: 'dt' }).nextElementSibling?.textContent).toBe('ck_1')
  })

  it('groups run-level items under Run and marks superseded and unclassified items', async () => {
    const items = [item('rk_run:failure'), item('rp_report:retro', { reportId: REPORT, standing: false })]
    learningCard('kc_l', review({ snapshot: snapshot(items) }), [attempt('ka_2', evidence())])
    stage('ka_2', [])
    const panel = await show()
    const run = within(region(panel, 'Sprint evidence')).getByRole('region', { name: 'Run' })
    const runItem = within(run).getByRole('listitem', { name: 'Failed attempt rk_run:failure' })
    expect(runItem.textContent).toContain('Not classified')
    expect(runItem.textContent).not.toContain('superseded')
    expect(runItem.textContent).not.toContain('Reason:')
    expect(runItem.querySelector('.lc-disposition')?.className).toBe('lc-disposition is-missing')
    const report = within(region(panel, 'Sprint evidence')).getByRole('region', { name: 'Sprint report' })
    expect(within(report).getByRole('listitem', { name: 'Failed attempt rp_report:retro' }).textContent).toContain('superseded')
  })
})

describe('LearningCardDetails drafts', () => {
  it('says no learnings were submitted when no attempt carries a learning block', async () => {
    learningCard('kc_l', review(), [attempt('ka_1', null)])
    const panel = await show()
    expect(region(panel, 'Proposed learnings').textContent).toContain('No learnings were submitted yet.')
    expect(dm.callsOf('getStagedLearningDrafts')).toEqual([])
  })

  it('shows what a draft replaces, any event and any path, and leaves focus alone for a citation outside the snapshot', async () => {
    learningCard('kc_l', review({ snapshot: snapshot([]) }), [attempt('ka_2', evidence())])
    stage('ka_2', [draft({ replaces: 'lr_old', evidence: [{ kind: 'failed_attempt', sourceId: 'at_elsewhere:failure', contentHash: HASH('a') }] })])
    const panel = await show()
    const card = within(panel).getByRole('listitem', { name: 'Proposed learning Pin the build cache' })
    const value = (label: string): string | null | undefined => within(card).getByText(label, { selector: 'dt' }).nextElementSibling?.textContent
    expect(value('Events')).toBe('Any event')
    expect(value('Paths')).toBe('Any path')
    expect(value('Replaces')).toBe('lr_old')
    const cite = within(card).getByRole('button', { name: 'Failed attempt at_elsewhere:failure' })
    cite.focus()
    fireEvent.click(cite)
    expect(document.activeElement).toBe(cite)
  })
})

describe('LearningCardDetails repositories and publication', () => {
  const branch = (repo: string): KanbanLearningReviewView['branches'][number] => ({ repo, base: { branch: 'epic/x', commit: 'a'.repeat(40), attemptId: 'at_acceptance' }, branch: `learnings/DM-50/${repo}` })
  const manifest = (repo: string, passed: boolean, checks: VerifiedLearningManifest['checks']): VerifiedLearningManifest => ({ repo, base: 'a'.repeat(40), branch: `learnings/DM-50/${repo}`, commit: 'b'.repeat(40), passed, checks })

  it('shows the failed checks of a manifest that did not verify', async () => {
    const checks: VerifiedLearningManifest['checks'] = [
      { name: 'base', status: 'passed', detail: 'base matches' },
      { name: 'scope', status: 'failed', detail: 'touches src/app.ts' },
      { name: 'tip', status: 'failed', detail: 'tip not on branch' }
    ]
    learningCard('kc_l', review({ branches: [branch('api')] }), [attempt('ka_2', evidence({ manifests: [manifest('api', false, checks)] }))])
    stage('ka_2', [])
    const repo = within(region(await show(), 'Repositories')).getByRole('listitem', { name: 'api' })
    expect(within(repo).getByText('Verified', { selector: 'dt' }).nextElementSibling?.textContent).toBe('Failed: touches src/app.ts; tip not on branch')
  })

  it('says no repository is affected without recorded branches, and publishes zero records without listing ids', async () => {
    const publication = { attemptId: 'ka_2', draftsHash: HASH('d'), recordIds: [], publishedAt: '2026-11-22T10:00:00.000Z' }
    learningCard('kc_l', review({ publication }), [attempt('ka_2', evidence())])
    stage('ka_2', [])
    const panel = await show()
    expect(region(panel, 'Repositories').textContent).toContain('No completed increment was recorded, so no repository is affected.')
    const published = region(panel, 'Publication')
    expect(published.textContent).toBe('PUBLICATIONPublished 0 learning records on 2026-11-22.')
  })

  it('lists every published record id', async () => {
    const publication = { attemptId: 'ka_2', draftsHash: HASH('d'), recordIds: ['lr_a', 'lr_b'], publishedAt: '2026-11-22T10:00:00.000Z' }
    learningCard('kc_l', review({ publication }), [attempt('ka_2', evidence())])
    stage('ka_2', [])
    const published = region(await show(), 'Publication')
    expect(published.textContent).toContain('Published 2 learning records on 2026-11-22.')
    expect(published.textContent).toContain('lr_a · lr_b')
  })
})

describe('LearningCardDetails switching cards mid-load', () => {
  it('ignores staged drafts that arrive after the person opened another card', async () => {
    learningCard('kc_l', review(), [attempt('ka_old', evidence())])
    learningCard('kc_m', review(), [attempt('ka_new', evidence())])
    stage('ka_old', [draft({ title: 'Stale draft' })])
    stage('ka_new', [draft({ title: 'Current draft' })])
    const hold = dm.holdNext('getStagedLearningDrafts')
    const { rerender } = render(panelFor('kc_l'))
    await settle()
    rerender(panelFor('kc_m'))
    await settle()
    hold.resolve()
    await settle()
    const drafts = region(screen.getByRole('complementary'), 'Proposed learnings')
    expect(within(drafts).getByRole('listitem', { name: 'Proposed learning Current draft' })).toBeTruthy()
    expect(within(drafts).queryByRole('listitem', { name: 'Proposed learning Stale draft' })).toBeNull()
  })

  it('ignores a read failure that arrives after the person opened another card', async () => {
    learningCard('kc_l', review(), [attempt('ka_old', evidence())])
    learningCard('kc_m', review(), [attempt('ka_new', evidence())])
    stage('ka_new', [draft({ title: 'Current draft' })])
    const hold = dm.holdNext('getStagedLearningDrafts')
    const { rerender } = render(panelFor('kc_l'))
    await settle()
    rerender(panelFor('kc_m'))
    await settle()
    hold.resolve()
    await settle()
    const panel = screen.getByRole('complementary')
    expect(within(panel).queryByRole('alert')).toBeNull()
    expect(within(region(panel, 'Proposed learnings')).getByRole('listitem', { name: 'Proposed learning Current draft' })).toBeTruthy()
  })
})
