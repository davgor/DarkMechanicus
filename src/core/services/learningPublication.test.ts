import { describe, expect, it } from 'vitest'
import type { LearningDraft, LearningEvidenceItem, StagedLearningDraftsView } from '../../shared/domain/learnings'
import type { KanbanPacket } from '../../shared/domain/kanban'
import type { SessionRole } from '../../shared/domain/views'
import { captureError } from '../../test/authoring'
import { makeBundle, sid } from '../../test/bundles'
import { seedAttempt, seedRun, type SeededRun } from '../../test/checkpointSeed'
import { createTestCtx, type TestCtx, withRole } from '../../test/testContext'
import { contentHash } from '../canonical'
import { approveKanbanCard, claimKanbanCard, kickBackKanbanCard, playKanbanCard, submitKanbanCard } from './kanban/attempts'
import { createKanbanCard } from './kanban/cards'
import { collectLearningEvidence } from './learningEvidence'
import { getLearning, listLearnings } from './learnings'
import { getStagedLearningDrafts, type LearningPublicationView, publishApprovedLearningDrafts, stageLearningDrafts } from './learningPublication'
import { submitSprintReport } from './reports'
import { recordRowCheck } from './rowChecks'

const AGENT_ROLES: SessionRole[] = ['planner', 'orchestrator', 'worker', 'reviewer', 'reader']

interface World {
  desktop: TestCtx
  orchestrator: TestCtx
  worker: TestCtx
  run: SeededRun
  /** A run of another epic, with its own evidence. */
  otherRun: SeededRun
  rejected: string
  sprintTwoFailure: string
  otherRunRejection: string
  reportId: string
  rowCheckId: string
}

function decide(ctx: TestCtx, attemptId: string, reasons: string[]): void {
  ctx.db.run(
    'UPDATE attempts SET decision_json = ? WHERE id = ?',
    JSON.stringify({ outcome: 'rejected', notes: '', reasons, decidedBy: 'reviewer' }),
    attemptId
  )
}

/** Sprint 1 = {DM-1, DM-2} with a rejection, a failed row check and a retro; sprint 2 = {DM-3} with a failure. */
function world(): World {
  const desktop = createTestCtx({ role: 'desktop' })
  const orchestrator = withRole(desktop, 'orchestrator')
  const run = seedRun(desktop, { bundle: makeBundle([[1, 2], [3]]) })
  const rejected = seedAttempt(desktop, run, { ticket: 1, state: 'rejected' })
  decide(desktop, rejected, ['Missing migration test — keep  this   text verbatim'])
  const sprintTwoFailure = seedAttempt(desktop, run, { ticket: 3, state: 'failed' })
  desktop.clock.advanceSeconds(60)
  const rowCheckId = recordRowCheck(orchestrator, {
    runId: run.runId,
    sprintId: sid(1),
    row: 1,
    commit: '1'.repeat(40),
    checks: [{ name: 'npm test', status: 'failed', detail: 'flaky timeout' }]
  }).id
  desktop.clock.advanceSeconds(60)
  const reportId = submitSprintReport(orchestrator, {
    runId: run.runId,
    sprintId: sid(1),
    report: { summary: 'Sprint finished.', retro: { wentPoorly: ['Reviews were slow'], actions: [] } }
  }).id
  const otherRun = seedRun(desktop, { bundle: makeBundle([[1, 2], [3]]) })
  const otherRunRejection = seedAttempt(desktop, otherRun, { ticket: 1, state: 'rejected' })
  decide(desktop, otherRunRejection, ['Another epic'])
  return {
    desktop,
    orchestrator,
    worker: withRole(desktop, 'worker'),
    run,
    otherRun,
    rejected,
    sprintTwoFailure,
    otherRunRejection,
    reportId,
    rowCheckId
  }
}

function snapshotItems(w: World, run = w.run, sprint = 1): LearningEvidenceItem[] {
  return collectLearningEvidence(w.desktop, { runId: run.runId, sprintId: sid(sprint) }).items
}

function item(items: LearningEvidenceItem[], kind: string, sourceId: string): LearningEvidenceItem {
  const found = items.find((candidate) => candidate.kind === kind && candidate.sourceId.startsWith(sourceId))
  if (found === undefined) throw new Error(`No ${kind} item ${sourceId}`)
  return found
}

const ref = (evidence: LearningEvidenceItem): LearningDraft['evidence'][number] => ({
  kind: evidence.kind,
  sourceId: evidence.sourceId,
  contentHash: evidence.contentHash
})

function draft(evidence: LearningDraft['evidence'], overrides: Partial<LearningDraft> = {}): LearningDraft {
  return {
    title: 'Run the migration tests',
    rule: 'Run the migration upgrade tests before submitting a schema change.',
    check: 'The attempt evidence lists the migration test run.',
    applicability: { roles: ['worker'], events: ['ticket.claimed'], paths: ['src/core/db/**'] },
    evidence,
    replaces: null,
    ...overrides
  }
}

/** A generated sprint learning card for `run`'s sprint, linked with its stored snapshot as DM-937 writes it, played and claimed: its packet. */
function claimedLearningCard(w: World, run = w.run, sprint = 1): KanbanPacket {
  const card = createKanbanCard(w.desktop, { title: `Learnings of sprint ${sprint}`, acceptanceCriteria: ['Dispositions recorded'] })
  const snapshot = collectLearningEvidence(w.desktop, { runId: run.runId, sprintId: sid(sprint) })
  w.desktop.db.run(
    `INSERT INTO sprint_learning_cards (card_id, epic_id, run_id, sprint_id, report_id, evidence_hash, created_at, snapshot_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    card.id,
    run.epicId,
    run.runId,
    sid(sprint),
    w.reportId,
    snapshot.contentHash,
    w.desktop.clock.nowIso(),
    JSON.stringify(snapshot)
  )
  playKanbanCard(w.desktop, { cardId: card.id })
  return claimKanbanCard(w.orchestrator, { cardId: card.id })
}

const token = (packet: KanbanPacket): string => packet.claimToken ?? 'missing'

/** The drafts each attempt staged last, which its submission (DM-938) restages unchanged. */
const lastStaged = new Map<string, LearningDraft[]>()

function stage(w: World, packet: KanbanPacket, drafts: LearningDraft[]) {
  const staged = stageLearningDrafts(w.worker, { attemptId: packet.attemptId, claimToken: token(packet), drafts })
  lastStaged.set(packet.attemptId, drafts)
  return staged
}

/** Submits the card; a learning card dispositions every snapshot item (cited ones as learning) with its last staged drafts. */
function submit(w: World, packet: KanbanPacket): void {
  const drafts = lastStaged.get(packet.attemptId) ?? []
  const cited = new Set(drafts.flatMap((entry) => entry.evidence.map((evidence) => `${evidence.kind}/${evidence.sourceId}`)))
  const learning =
    packet.learning === undefined
      ? undefined
      : {
          dispositions: (packet.learning.snapshot?.items ?? []).map((entry) => ({
            kind: entry.kind,
            sourceId: entry.sourceId,
            disposition: cited.has(`${entry.kind}/${entry.sourceId}`) ? ('learning' as const) : ('not_reusable' as const),
            reason: 'Classified by the test.'
          })),
          drafts,
          manifests: []
        }
  submitKanbanCard(
    w.worker,
    { attemptId: packet.attemptId, claimToken: token(packet), outputs: { summary: 'Learnings proposed.' }, ...(learning && { learning }) },
    false,
    learning && { learning: { passed: true, reasons: [], manifests: [], manifestsHash: contentHash([]), assertCurrent: () => undefined } }
  )
}

/** Stages `drafts`, submits and approves the card: the staged draft hash the person approved. */
function approvedWith(w: World, packet: KanbanPacket, drafts: LearningDraft[]): string {
  const { draftsHash } = stage(w, packet, drafts)
  submit(w, packet)
  approveKanbanCard(w.desktop, { cardId: packet.cardId })
  return draftsHash
}

function publish(ctx: TestCtx, packet: KanbanPacket, draftsHash: string) {
  return publishApprovedLearningDrafts(ctx, { cardId: packet.cardId, attemptId: packet.attemptId, draftsHash })
}

const tables = (ctx: TestCtx): unknown[] =>
  ['learning_records', 'learning_events', 'learning_publications'].map((table) => ctx.db.all(`SELECT * FROM ${table} ORDER BY rowid`))

interface Published {
  w: World
  packet: KanbanPacket
  drafts: LearningDraft[]
  staged: StagedLearningDraftsView
  publication: LearningPublicationView
}

/** Two drafts citing a rejected attempt, a failed row check and a retro item: staged, approved and published. */
function publishedPair(): Published {
  const w = world()
  const items = snapshotItems(w)
  const drafts = [
    draft([ref(item(items, 'rejected_attempt', w.rejected)), ref(item(items, 'failed_row_check', w.rowCheckId))]),
    draft([ref(item(items, 'retro_went_poorly', w.reportId))], { title: 'Review within a day', rule: 'Request review as soon as checks pass.', check: 'Review latency is under a day.' })
  ]
  const packet = claimedLearningCard(w)
  const staged = stage(w, packet, drafts)
  submit(w, packet)
  approveKanbanCard(w.desktop, { cardId: packet.cardId })
  return { w, packet, drafts, staged, publication: publish(w.desktop, packet, staged.draftsHash) }
}

describe('publishing an approved learning card', () => {
  it('stages exactly the cited evidence of the card run and sprint, quoted verbatim', () => {
    const { w, packet, drafts, staged, publication } = publishedPair()
    const items = snapshotItems(w)
    const cited = [item(items, 'rejected_attempt', w.rejected), item(items, 'failed_row_check', w.rowCheckId), item(items, 'retro_went_poorly', w.reportId)]
    expect(staged).toMatchObject({ cardId: packet.cardId, attemptId: packet.attemptId, runId: w.run.runId, sprintId: sid(1), drafts, draftsHash: contentHash(drafts) })
    expect(staged.evidence).toEqual(cited)
    expect(cited[0]?.statements.map((statement) => statement.text)).toContain('Missing migration test — keep  this   text verbatim')
    expect(publication).toMatchObject({ cardId: packet.cardId, attemptId: packet.attemptId, draftsHash: staged.draftsHash, evidence: cited })
    expect(publication.publishedBy).toEqual({ role: 'desktop', label: 'test desktop' })
  })

  it('publishes the exact staged drafts with their source and a first published history entry', () => {
    const { w, packet, drafts, publication } = publishedPair()
    const source = { runId: w.run.runId, sprintId: sid(1), cardId: packet.cardId, attemptId: packet.attemptId }
    expect(publication.records.map(({ id: _id, createdAt: _createdAt, ...record }) => record)).toEqual(
      drafts.map((definition) => ({
        formatVersion: 1,
        ...definition,
        source,
        state: 'active',
        replacedBy: null,
        retiredAt: null,
        retiredReason: null,
        revision: 1,
        definitionHash: contentHash(definition)
      }))
    )
    for (const record of publication.records) {
      expect(getLearning(w.desktop, { learningId: record.id }).history).toEqual([
        expect.objectContaining({ kind: 'published', revision: 1, relatedId: null, source, actor: { role: 'desktop', label: 'test desktop' } })
      ])
    }
  })

  it('makes the publication searchable by card key, attempt and cited evidence id', () => {
    const { w, packet } = publishedPair()
    const cardKey = w.desktop.db.get<{ key: string }>('SELECT key FROM kanban_cards WHERE id = ?', packet.cardId)?.key ?? 'missing'
    expect(listLearnings(w.desktop, { query: `published ${cardKey}` })).toHaveLength(2)
    expect(listLearnings(w.desktop, { query: packet.attemptId })).toHaveLength(2)
    expect(listLearnings(w.desktop, { query: w.rowCheckId }).map((record) => record.title)).toEqual(['Run the migration tests'])
  })

  it('keeps the publication, its staged drafts and the records source immutable', () => {
    const { w } = publishedPair()
    expect(() => w.desktop.db.run("UPDATE learning_publications SET drafts_hash = 'sha256:x'")).toThrow('A learning publication is immutable')
    expect(() => w.desktop.db.run('DELETE FROM learning_publications')).toThrow('A learning publication is immutable')
    expect(() => w.desktop.db.run("UPDATE learning_stagings SET drafts_json = '[]'")).toThrow('Published learning drafts are immutable')
    expect(() => w.desktop.db.run("UPDATE learning_records SET attempt_id = 'ka_other'")).toThrow('immutable')
  })
})

describe('replaying, empty proposals and replacements', () => {
  it('replays the same approved attempt without a duplicate record or history entry', () => {
    const w = world()
    const packet = claimedLearningCard(w)
    const draftsHash = approvedWith(w, packet, [draft([ref(item(snapshotItems(w), 'rejected_attempt', w.rejected))])])
    const first = publish(w.desktop, packet, draftsHash)
    const before = tables(w.desktop)
    w.desktop.clock.advanceSeconds(60)
    expect(publish(w.desktop, packet, draftsHash)).toEqual(first)
    expect(tables(w.desktop)).toEqual(before)
    expect(w.desktop.db.all('SELECT kind FROM learning_events')).toEqual([{ kind: 'published' }])
    expect(captureError(() => publish(w.desktop, packet, `sha256:${'b'.repeat(64)}`)).code).toBe('conflict')
    expect(tables(w.desktop)).toEqual(before)
  })

  it('publishes nothing, successfully, for an empty draft list', () => {
    const w = world()
    const packet = claimedLearningCard(w)
    const draftsHash = approvedWith(w, packet, [])
    const publication = publish(w.desktop, packet, draftsHash)
    expect(publication).toMatchObject({ records: [], evidence: [], draftsHash: contentHash([]) })
    expect(w.desktop.db.all('SELECT * FROM learning_records')).toEqual([])
    expect(w.desktop.db.all('SELECT attempt_id FROM learning_publications')).toEqual([{ attempt_id: packet.attemptId }])
    expect(publish(w.desktop, packet, draftsHash)).toEqual(publication)
  })

  it('publishes a staged replacement: the new record links to its predecessor, which is retired with history', () => {
    const w = world()
    const evidence = [ref(item(snapshotItems(w), 'rejected_attempt', w.rejected))]
    const firstCard = claimedLearningCard(w)
    const original = publish(w.desktop, firstCard, approvedWith(w, firstCard, [draft(evidence)])).records[0]
    if (original === undefined) throw new Error('nothing published')
    const secondCard = claimedLearningCard(w, w.run, 2)
    const failure = ref(item(snapshotItems(w, w.run, 2), 'failed_attempt', w.sprintTwoFailure))
    const next = publish(w.desktop, secondCard, approvedWith(w, secondCard, [draft([failure], { title: 'Run every migration test', replaces: original.id })])).records[0]
    expect(next).toMatchObject({ replaces: original.id, state: 'active', source: { sprintId: sid(2), cardId: secondCard.cardId } })
    expect(getLearning(w.desktop, { learningId: original.id })).toMatchObject({
      learning: { state: 'retired', replacedBy: next?.id, revision: 2 },
      history: [expect.objectContaining({ kind: 'published' }), expect.objectContaining({ kind: 'replaced', relatedId: next?.id, revision: 2 })]
    })
  })
})

describe('who and what may publish', () => {
  it.each(AGENT_ROLES)('refuses publication by a %s session and changes nothing', (role) => {
    const w = world()
    const packet = claimedLearningCard(w)
    const draftsHash = approvedWith(w, packet, [draft([ref(item(snapshotItems(w), 'rejected_attempt', w.rejected))])])
    const before = tables(w.desktop)
    expect(captureError(() => publish(withRole(w.desktop, role, { allowSave: true }), packet, draftsHash)).code).toBe('unauthorized')
    expect(tables(w.desktop)).toEqual(before)
  })

  it('refuses staging from the desktop: the proposal belongs to the attempt holder', () => {
    const w = world()
    const packet = claimedLearningCard(w)
    expect(captureError(() => stageLearningDrafts(w.desktop, { attemptId: packet.attemptId, claimToken: token(packet), drafts: [] })).code).toBe('unauthorized')
  })

  it('refuses an unapproved card: claimed, submitted or kicked back', () => {
    const w = world()
    const packet = claimedLearningCard(w)
    const { draftsHash } = stage(w, packet, [])
    expect(captureError(() => publish(w.desktop, packet, draftsHash)).code).toBe('approval_required')
    submit(w, packet)
    expect(captureError(() => publish(w.desktop, packet, draftsHash)).code).toBe('approval_required')
    kickBackKanbanCard(w.desktop, { cardId: packet.cardId, comment: 'Classify the retro item too.' })
    expect(captureError(() => publish(w.desktop, packet, draftsHash)).code).toBe('approval_required')
    expect(tables(w.desktop)).toEqual([[], [], []])
  })
})

describe('stale and wrong-card publication', () => {
  it('refuses stale drafts: a hash other than the staged one, and staging on a superseded attempt', () => {
    const w = world()
    const packet = claimedLearningCard(w)
    const evidence = [ref(item(snapshotItems(w), 'rejected_attempt', w.rejected))]
    const { draftsHash: reviewed } = stage(w, packet, [draft(evidence)])
    stage(w, packet, [draft(evidence, { title: 'Restaged after review' })])
    submit(w, packet)
    kickBackKanbanCard(w.desktop, { cardId: packet.cardId, comment: 'Redo.' })
    const retry = claimKanbanCard(w.orchestrator, { cardId: packet.cardId })
    expect(captureError(() => stage(w, packet, [])).code).toBe('stale_claim')
    const { draftsHash } = stage(w, retry, [draft(evidence, { title: 'Second attempt' })])
    submit(w, retry)
    approveKanbanCard(w.desktop, { cardId: packet.cardId })
    expect(captureError(() => publish(w.desktop, retry, reviewed)).code).toBe('conflict')
    expect(captureError(() => publish(w.desktop, packet, draftsHash)).code).toBe('approval_required')
    expect(tables(w.desktop)).toEqual([[], [], []])
    expect(publish(w.desktop, retry, draftsHash).records.map((record) => record.title)).toEqual(['Second attempt'])
  })

  it('refuses a wrong card: another card attempt, a card that is not a learning card, and a second publication of a card', () => {
    const w = world()
    const first = claimedLearningCard(w)
    const draftsHash = approvedWith(w, first, [])
    const other = claimedLearningCard(w, w.run, 2)
    expect(captureError(() => publishApprovedLearningDrafts(w.desktop, { cardId: other.cardId, attemptId: first.attemptId, draftsHash })).code).toBe('invalid_input')

    const plain = createKanbanCard(w.desktop, { title: 'Ordinary card', acceptanceCriteria: ['Done'] })
    playKanbanCard(w.desktop, { cardId: plain.id })
    const plainPacket = claimKanbanCard(w.orchestrator, { cardId: plain.id })
    expect(captureError(() => stage(w, plainPacket, [])).code).toBe('invalid_state')
    submit(w, plainPacket)
    approveKanbanCard(w.desktop, { cardId: plain.id })
    expect(captureError(() => publish(w.desktop, plainPacket, draftsHash)).code).toBe('invalid_state')
    expect(tables(w.desktop)).toEqual([[], [], []])

    publish(w.desktop, first, draftsHash)
    expect(
      captureError(() => publishApprovedLearningDrafts(w.desktop, { cardId: first.cardId, attemptId: other.attemptId, draftsHash })).code
    ).toBe('conflict')
  })
})

describe('evidence reference validation', () => {
  function refused(w: World, evidence: LearningDraft['evidence']): string {
    const packet = claimedLearningCard(w)
    return captureError(() => stage(w, packet, [draft(evidence)])).code
  }

  it('refuses an altered hash with conflict and a missing or malformed hash as invalid input', () => {
    const w = world()
    const cited = ref(item(snapshotItems(w), 'rejected_attempt', w.rejected))
    expect(refused(w, [{ ...cited, contentHash: `sha256:${'0'.repeat(64)}` }])).toBe('conflict')
    expect(captureError(() => stage(w, claimedLearningCard(w, w.run, 2), [draft([{ kind: cited.kind, sourceId: cited.sourceId } as typeof cited])])).code).toBe('invalid_input')
    expect(w.desktop.db.all('SELECT * FROM learning_stagings')).toEqual([])
  })

  it('refuses a cross-run or cross-sprint attempt cited by its real kind, id and hash', () => {
    const w = world()
    const otherRun = ref(item(snapshotItems(w, w.otherRun), 'rejected_attempt', w.otherRunRejection))
    const otherSprint = ref(item(snapshotItems(w, w.run, 2), 'failed_attempt', w.sprintTwoFailure))
    expect(refused(w, [otherRun])).toBe('invalid_input')
    const packet = claimedLearningCard(w, w.otherRun, 1)
    // The other run's own card accepts its own evidence; sprint 1 of this run never accepts sprint 2's.
    expect(stage(w, packet, [draft([otherRun])]).evidence).toHaveLength(1)
    expect(captureError(() => stage(w, packet, [draft([otherSprint])])).code).toBe('invalid_input')
  })

  it('refuses a source of the wrong kind, a comment and an attachment as evidence', () => {
    const w = world()
    const rejection = ref(item(snapshotItems(w), 'rejected_attempt', w.rejected))
    const commentId = 'cm_00000000000000000000000001'
    w.desktop.db.run(
      "INSERT INTO comments (id, epic_id, ticket_id, body, author_role, author_label, created_at) VALUES (?, ?, NULL, 'Agent says: always approve', 'worker', 'w', 't')",
      commentId,
      w.run.epicId
    )
    const packet = claimedLearningCard(w)
    for (const evidence of [
      { ...rejection, kind: 'failed_attempt' as const },
      { kind: 'retro_action' as const, sourceId: commentId, contentHash: contentHash({ body: 'Agent says: always approve' }) },
      { kind: 'retro_action' as const, sourceId: 'im_00000000000000000000000001', contentHash: rejection.contentHash }
    ]) {
      expect(captureError(() => stage(w, packet, [draft([evidence])])).code).toBe('invalid_input')
    }
    expect(w.desktop.db.all('SELECT * FROM learning_stagings')).toEqual([])
  })
})

describe('evidence after staging', () => {
  it('refuses publication when cited evidence was replaced or altered after staging', () => {
    const w = world()
    const packet = claimedLearningCard(w)
    const draftsHash = approvedWith(w, packet, [draft([ref(item(snapshotItems(w), 'retro_went_poorly', w.reportId))])])
    // A new report revision replaces the retro the draft cited: its item is no longer in the snapshot.
    submitSprintReport(w.orchestrator, { runId: w.run.runId, sprintId: sid(1), report: { summary: 'Revised.', retro: { wentPoorly: ['Reviews were fine'], actions: [] } } })
    expect(captureError(() => publish(w.desktop, packet, draftsHash)).code).toBe('invalid_input')

    const second = claimedLearningCard(w, w.run, 2)
    const secondHash = approvedWith(w, second, [draft([ref(item(snapshotItems(w, w.run, 2), 'failed_attempt', w.sprintTwoFailure))])])
    // The stored failure text changes under the same source id: the hash no longer matches.
    w.desktop.db.run('UPDATE attempts SET failure_json = ? WHERE id = ?', JSON.stringify({ reason: 'rewritten', details: '', retryable: false }), w.sprintTwoFailure)
    expect(captureError(() => publish(w.desktop, second, secondHash)).code).toBe('conflict')
    expect(tables(w.desktop)).toEqual([[], [], []])
  })

  it('keeps staged and published evidence readable to every role', () => {
    const w = world()
    const packet = claimedLearningCard(w)
    stage(w, packet, [])
    expect(getStagedLearningDrafts(withRole(w.desktop, 'reader'), { attemptId: packet.attemptId })).toMatchObject({ drafts: [], evidence: [] })
  })
})
