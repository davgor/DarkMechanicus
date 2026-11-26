// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentAuthStatus, ApproveLearningCardRequest, CommandResult } from '../../../shared/desktop/api'
import type { KanbanAttemptView, KanbanCardView, KanbanLearningReviewView, LearningSubmissionEvidence } from '../../../shared/domain/kanban'
import type { LearningEvidenceItem, LearningIntegrationSummaryView, StagedLearningDraftsView } from '../../../shared/domain/learnings'
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
const DRAFTS_HASH = HASH('d')

let dm: FakeDm
let cards: Record<string, KanbanCardView>
let staged: Record<string, StagedLearningDraftsView>
let approvals: ApproveLearningCardRequest[]
let approvalAnswer: () => CommandResult<KanbanCardView>

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
  cards = {}
  staged = {}
  approvals = []
  approvalAnswer = () => ({ ok: false, error: { code: 'internal', message: 'unset' } })
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
  dm.approveLearningCard = (_folder, input) => {
    approvals.push(input)
    return Promise.resolve(approvalAnswer())
  }
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

async function show(cardId = 'kc_l'): Promise<HTMLElement> {
  render(<KanbanCardPanel folderPath="/a" folderKey="00000000000000000000000000000001" cardId={cardId} refreshToken={0} host={host()} onChanged={() => undefined} onClose={() => undefined} />)
  await settle()
  return screen.getByRole('complementary')
}

function item(kind: LearningEvidenceItem['kind'], sourceId: string, ticketKey: string | null, text: string): LearningEvidenceItem {
  return {
    kind,
    sourceId,
    contentHash: HASH('a'),
    fingerprint: HASH('f'),
    occurredAt: '2026-11-20T10:00:00.000Z',
    standing: true,
    provenance: {
      runId: RUN,
      sprintId: SPRINT,
      revisionId: 'rv_01m877ym5kj3nydv11sna2t15f',
      ticketId: null,
      ticketKey,
      attemptId: null,
      attemptNumber: ticketKey === null ? null : 2,
      rowCheckId: null,
      row: null,
      checkNumber: null,
      reportId: ticketKey === null ? 'rp_01m877ym5kj3nydv11sna2t15f' : null,
      reportRevision: ticketKey === null ? 1 : null
    },
    repositories: [],
    paths: [],
    statements: [{ field: 'decision.reasons', text }]
  }
}

const REJECTED = item('rejected_attempt', 'at_rejected:decision', 'DM-12', 'Missing migration upgrade test')
const ITEMS = [
  REJECTED,
  item('failed_attempt', 'at_failed:failure', 'DM-12', 'Lease expired during a long build'),
  item('retro_went_poorly', 'rp_report:wentPoorly:0', null, 'Flaky e2e test was rerun to green')
]

const LEARNING: LearningSubmissionEvidence = {
  snapshotHash: HASH('e'),
  draftsHash: DRAFTS_HASH,
  dispositions: [
    { kind: 'rejected_attempt', sourceId: 'at_rejected:decision', disposition: 'learning', reason: 'Schema changes keep missing upgrade tests.' },
    { kind: 'failed_attempt', sourceId: 'at_failed:failure', disposition: 'not_reusable', reason: 'A one-off host outage.' },
    { kind: 'retro_went_poorly', sourceId: 'rp_report:wentPoorly:0', disposition: 'duplicate', reason: 'Already covered by the flake rule.' }
  ],
  manifests: [{ repo: null, base: 'a'.repeat(40), branch: 'learnings/DM-50/root', commit: 'b'.repeat(40), passed: true, checks: [] }]
}

function review(patch: Partial<KanbanLearningReviewView> = {}): KanbanLearningReviewView {
  return {
    runId: RUN,
    sprintId: SPRINT,
    reportId: 'rp_01m877ym5kj3nydv11sna2t15f',
    revisionId: 'rv_01m877ym5kj3nydv11sna2t15f',
    checkpointId: 'ck_01m877ym5kj3nydv11sna2t15f',
    evidenceHash: HASH('e'),
    snapshot: {
      formatVersion: 1,
      runId: RUN,
      sprintId: SPRINT,
      sprintOrdinal: 1,
      revisionId: 'rv_01m877ym5kj3nydv11sna2t15f',
      report: { id: 'rp_01m877ym5kj3nydv11sna2t15f', reportRevision: 1, contentHash: HASH('9'), createdAt: '2026-11-20T10:00:00.000Z' },
      items: ITEMS,
      contentHash: HASH('e')
    },
    branches: [{ repo: null, base: { branch: 'epic/x', commit: 'a'.repeat(40), attemptId: 'at_acceptance' }, branch: 'learnings/DM-50/root' }],
    integration: null,
    publication: null,
    ...patch
  }
}

function submittedAttempt(patch: Partial<KanbanAttemptView> = {}): KanbanAttemptView {
  return {
    id: 'ka_2',
    cardId: 'kc_l',
    number: 2,
    state: 'submitted',
    machineId: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    progressNote: null,
    outputs: { summary: 'Codified one learning.', artifacts: [], commits: [], changedFiles: [], branch: null },
    evidence: { checks: [], criteria: [], notes: '', learning: LEARNING },
    reviewComment: null,
    createdAt: '2026-11-21T10:00:00.000Z',
    submittedAt: '2026-11-21T11:00:00.000Z',
    decidedAt: null,
    ...patch
  }
}

function stage(attemptId = 'ka_2', drafts = [REJECTED]): void {
  staged[attemptId] = {
    cardId: 'kc_l',
    attemptId,
    runId: RUN,
    sprintId: SPRINT,
    snapshotHash: HASH('e'),
    drafts: drafts.map((cited) => ({
      title: 'Run the migration upgrade tests',
      rule: 'Run the migration upgrade tests before submitting a schema change.',
      check: 'The attempt evidence lists the migration test run.',
      applicability: { roles: ['worker'], events: ['ticket.claimed'], paths: ['src/core/db/**'] },
      evidence: [{ kind: cited.kind, sourceId: cited.sourceId, contentHash: cited.contentHash }],
      replaces: null
    })),
    draftsHash: DRAFTS_HASH,
    evidence: drafts,
    stagedBy: { role: 'worker', label: 'Acolyte' },
    stagedAt: '2026-11-21T11:00:00.000Z'
  }
}

function learningCard(patch: Partial<KanbanCardView> = {}): KanbanCardView {
  const card = cardView({
    id: 'kc_l',
    key: 'DM-50',
    title: 'Sprint 1 learnings',
    lane: 'ready_for_review',
    openAttempt: { number: 2, state: 'submitted' },
    attempts: [submittedAttempt()],
    learning: review(),
    ...patch
  })
  cards[card.id] = card
  return card
}

function integration(patch: Partial<LearningIntegrationSummaryView>): LearningIntegrationSummaryView {
  return {
    operationId: 'li_01m877ym5kj3nydv11sna2t15f',
    state: 'integrating',
    failure: null,
    targets: [{ repository: null, branch: 'epic/x', baseCommit: 'a'.repeat(40), oldHead: 'c'.repeat(40), newHead: null, state: 'integrating' }],
    ...patch
  }
}

const status = (panel: HTMLElement): HTMLElement => within(panel).getByRole('status', { name: 'Learning status' })

describe('LearningCardDetails evidence and dispositions', () => {
  it('shows provenance and every evidence item grouped by source with its disposition and reason', async () => {
    learningCard()
    stage()
    const panel = await show()
    const provenance = within(panel).getByRole('region', { name: 'Provenance' })
    expect(provenance.textContent).toContain(RUN)
    expect(provenance.textContent).toContain(`Sprint 1 · ${SPRINT}`)
    expect(provenance.textContent).toContain('rp_01m877ym5kj3nydv11sna2t15f r1')
    const evidence = within(panel).getByRole('region', { name: 'Sprint evidence' })
    expect(within(evidence).getByRole('heading', { name: 'SPRINT EVIDENCE (3)' })).toBeTruthy()
    const ticket = within(evidence).getByRole('region', { name: 'Ticket DM-12' })
    expect(within(ticket).getAllByRole('listitem').map((row) => row.getAttribute('aria-label'))).toEqual([
      'Rejected attempt at_rejected:decision',
      'Failed attempt at_failed:failure'
    ])
    const rejected = within(ticket).getByRole('listitem', { name: 'Rejected attempt at_rejected:decision' })
    expect(rejected.textContent).toContain('Missing migration upgrade test')
    expect(rejected.textContent).toContain('Learning')
    expect(rejected.textContent).toContain('Reason: Schema changes keep missing upgrade tests.')
    const failed = within(ticket).getByRole('listitem', { name: 'Failed attempt at_failed:failure' })
    expect(failed.textContent).toContain('Not reusable')
    expect(failed.textContent).toContain('Reason: A one-off host outage.')
    const report = within(evidence).getByRole('region', { name: 'Sprint report' })
    expect(report.textContent).toContain('Duplicate')
    expect(report.textContent).toContain('Already covered by the flake rule.')
  })

  it('traces each proposed learning to its evidence and shows each repository branch, commit and verification', async () => {
    learningCard()
    stage()
    const panel = await show()
    const rejected = within(panel).getByRole('listitem', { name: 'Rejected attempt at_rejected:decision' })
    expect(rejected.textContent).toContain('Cited by: Run the migration upgrade tests')
    const draft = within(panel).getByRole('listitem', { name: 'Proposed learning Run the migration upgrade tests' })
    expect(draft.textContent).toContain('Run the migration upgrade tests before submitting a schema change.')
    expect(draft.textContent).toContain('worker')
    expect(draft.textContent).toContain('ticket.claimed')
    expect(draft.textContent).toContain('src/core/db/**')
    const repos = within(panel).getByRole('region', { name: 'Repositories' })
    expect(repos.textContent).toContain('learnings/DM-50/root')
    expect(repos.textContent).toContain('bbbbbbb')
    expect(repos.textContent).toContain('Passed')
    expect(repos.textContent).toContain('Not started')
  })
})

describe('LearningCardDetails keyboard, empty and loading states', () => {
  it('moves keyboard focus from a cited draft to the evidence item it rests on', async () => {
    learningCard()
    stage()
    const panel = await show()
    const cite = within(panel).getByRole('button', { name: 'Rejected attempt at_rejected:decision' })
    cite.focus()
    fireEvent.click(cite)
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Rejected attempt at_rejected:decision')
  })

  it('says plainly when the snapshot holds no evidence and the submission proposes no learning', async () => {
    const snapshot = review().snapshot
    learningCard({ learning: review({ snapshot: snapshot === null ? null : { ...snapshot, items: [] } }) })
    stage('ka_2', [])
    const panel = await show()
    expect(within(panel).getByRole('region', { name: 'Sprint evidence' }).textContent).toContain('The evidence snapshot is empty')
    expect(within(panel).getByRole('region', { name: 'Proposed learnings' }).textContent).toContain('approving publishes no records')
    expect(status(panel).textContent).toContain('No learning records from this card are active.')
  })

  it('announces loading of the proposed learnings, then an error it could not read', async () => {
    learningCard()
    const hold = dm.holdNext('getStagedLearningDrafts')
    const panel = await show()
    expect(within(panel).getByText('Loading the proposed learnings…').getAttribute('aria-busy')).toBe('true')
    expect((within(panel).getByRole('button', { name: 'Approve and publish' }) as HTMLButtonElement).disabled).toBe(true)
    hold.resolve()
    await settle()
    expect(within(panel).getByRole('alert').textContent).toContain('Could not read the proposed learnings')
  })
})

describe('LearningCardDetails approval and kick-back', () => {
  it('approves the exact reviewed card, attempt and drafts hash through the desktop coordinator', async () => {
    learningCard()
    stage()
    approvalAnswer = () => ({
      ok: true,
      data: learningCard({
        lane: 'done',
        openAttempt: null,
        attempts: [submittedAttempt({ state: 'accepted' })],
        summary: { outcome: 'Codified one learning.', commits: [], completedAt: '2026-11-22T10:00:00.000Z', approvedBy: 'Desktop' },
        learning: review({
          integration: integration({ state: 'published', targets: [{ repository: null, branch: 'epic/x', baseCommit: 'a'.repeat(40), oldHead: null, newHead: 'f'.repeat(40), state: 'integrated' }] }),
          publication: { attemptId: 'ka_2', draftsHash: DRAFTS_HASH, recordIds: ['lr_01m877ym5kj3nydv11sna2t15f'], publishedAt: '2026-11-22T10:00:00.000Z' }
        })
      })
    })
    const panel = await show()
    expect(status(panel).textContent).toContain('Ready for review: nothing published yet')
    expect(dm.callsOf('approveKanbanCard')).toEqual([])
    fireEvent.click(within(panel).getByRole('button', { name: 'Approve and publish' }))
    await settle()
    expect(approvals).toEqual([{ cardId: 'kc_l', attemptId: 'ka_2', draftsHash: DRAFTS_HASH }])
    expect(status(panel).textContent).toContain('Done: approved, integrated and published')
    expect(status(panel).textContent).toContain('1 learning record is active.')
    expect(status(panel).textContent).toContain('Guardrail commits landed on the target branch of 1 repository.')
    expect(within(panel).getByRole('region', { name: 'Repositories' }).textContent).toContain('Integrated ffffff')
    expect(within(panel).getByRole('region', { name: 'Publication' }).textContent).toContain('Published 1 learning record')
  })

  it('kicks back with a statement that nothing is published', async () => {
    learningCard()
    stage()
    const panel = await show()
    fireEvent.click(within(panel).getByRole('button', { name: 'Kick back' }))
    expect(within(panel).getByText(/Kicking back publishes nothing/).textContent).toContain('no target branch changes')
    learningCard({ lane: 'in_progress', openAttempt: null, playPending: true, attempts: [submittedAttempt({ state: 'rejected', reviewComment: 'Cite the retro item too.' })] })
    cleanup()
    const reopened = await show()
    expect(status(reopened).textContent).toContain('Kicked back: nothing was published')
    expect(status(reopened).textContent).toContain('No learning records from this card are active.')
    expect(status(reopened).textContent).toContain('No target branch was changed.')
  })
})

describe('LearningCardDetails conflict and recovery', () => {
  it('shows a conflict refusal, reads the card again and says nothing was published', async () => {
    learningCard()
    stage()
    approvalAnswer = () => {
      learningCard({ learning: review({ integration: integration({ state: 'conflicted', failure: { code: 'conflicted', message: 'root repository (refs/heads/epic/x): AGENTS.md' }, targets: [{ repository: null, branch: 'epic/x', baseCommit: 'a'.repeat(40), oldHead: null, newHead: null, state: 'conflicted' }] }) }) })
      return { ok: false, error: { code: 'conflict', message: 'The approved guardrails conflict with their target branches, so nothing was integrated or published.' } }
    }
    const panel = await show()
    const reads = dm.callsOf('getKanbanCard').length
    fireEvent.click(within(panel).getByRole('button', { name: 'Approve and publish' }))
    await settle()
    expect(within(panel).getByRole('alert').textContent).toContain('nothing was integrated or published')
    expect(dm.callsOf('getKanbanCard').length).toBeGreaterThan(reads)
    expect(status(panel).textContent).toContain('Conflict: approval stopped, nothing published')
    expect(status(panel).textContent).toContain('root repository (refs/heads/epic/x): AGENTS.md')
    expect(within(panel).getByRole('region', { name: 'Repositories' }).textContent).toContain('Conflicted')
    expect((within(panel).getByRole('button', { name: 'Approve and publish' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows a partially applied integration as in progress with nothing active yet', async () => {
    learningCard({
      learning: review({
        branches: [
          { repo: 'api', base: { branch: 'epic/x', commit: 'a'.repeat(40), attemptId: 'at_acceptance' }, branch: 'learnings/DM-50/api' },
          { repo: 'web', base: { branch: 'epic/x', commit: 'a'.repeat(40), attemptId: 'at_acceptance' }, branch: 'learnings/DM-50/web' }
        ],
        integration: integration({
          targets: [
            { repository: 'api', branch: 'epic/x', baseCommit: 'a'.repeat(40), oldHead: 'c'.repeat(40), newHead: 'e'.repeat(40), state: 'integrated' },
            { repository: 'web', branch: 'epic/x', baseCommit: 'a'.repeat(40), oldHead: 'c'.repeat(40), newHead: null, state: 'integrating' }
          ]
        })
      })
    })
    stage()
    const panel = await show()
    expect(status(panel).textContent).toContain('Integration in progress: partially applied')
    expect(status(panel).textContent).toContain('1 of 2 repositories integrated')
    expect(status(panel).textContent).toContain('They become active only after every repository is integrated.')
    const repos = within(panel).getByRole('region', { name: 'Repositories' })
    expect(within(repos).getByRole('listitem', { name: 'api' }).textContent).toContain('Integrated ccccccc → eeeeeee on epic/x')
    expect(within(repos).getByRole('listitem', { name: 'web' }).textContent).toContain('Integrating on epic/x')
  })
})

describe('ordinary cards', () => {
  it('render without any learning review and approve through approveKanbanCard', async () => {
    const card = cardView({ id: 'kc_o', key: 'DM-7', title: 'Fix the upload test', lane: 'ready_for_review', openAttempt: { number: 1, state: 'submitted' }, attempts: [submittedAttempt({ cardId: 'kc_o', id: 'ka_o', evidence: { checks: [], criteria: [], notes: '' } })] })
    cards[card.id] = card
    dm.handlers.approveKanbanCard = () => ({ ...card, lane: 'done', openAttempt: null })
    const panel = await show('kc_o')
    expect(within(panel).queryByLabelText('Learning review')).toBeNull()
    expect(within(panel).queryByRole('region', { name: 'Sprint evidence' })).toBeNull()
    expect(dm.callsOf('getStagedLearningDrafts')).toEqual([])
    fireEvent.click(within(panel).getByRole('button', { name: 'Approve' }))
    await settle()
    expect(dm.callsOf('approveKanbanCard').map((call) => call.input)).toEqual([{ cardId: 'kc_o' }])
    expect(approvals).toEqual([])
  })
})
