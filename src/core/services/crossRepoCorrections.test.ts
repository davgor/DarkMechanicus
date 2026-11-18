import { describe, expect, it } from 'vitest'
import type { CorrectionProvenance, PlanBundle } from '../../shared/domain/bundle'
import type { CrossRepoTargetEpicView } from '../../shared/domain/crossRepoCorrections'
import { DM_PROJECT, correctionEpics, dmProject, historyOf, reportedSource, type ReportedSource } from '../../test/crossRepoWorld'
import { seedRevision, startedRun } from '../../test/execution'
import { thrownBy } from '../../test/thrownBy'
import { createTestCtx, withRole, type TestCtx } from '../../test/testContext'
import type { Ctx } from '../context'
import { parseJson } from '../db/database'
import { DomainError } from '../errors'
import { experimentEventSchema, restatementOf } from '../plan/experiments'
import { validatePlan } from '../plan/graph'
import { correctionProvenance } from '../repo/portable'
import { LIMITS, parseInput, sprintReportInput } from '../schemas'
import {
  beginCrossRepoCorrection,
  crossRepoCorrectionLink,
  crossRepoResults,
  discardCrossRepoCorrection,
  heldCorrection,
  listCrossRepoCorrections,
  materializeCrossRepoCorrection,
  previewCrossRepoSource,
  previewCrossRepoTarget,
  recordCrossRepoDelivery,
  recordCrossRepoFailure,
  recordCrossRepoResults,
  requestedCrossRepoCorrection
} from './crossRepoCorrections'
import { createCorrectionEpic } from './epics'
import { recordExperimentEvent } from './experiments'
import { loadDraftRow } from './plans'
import type { CarriedResults } from './experimentOutcomes'
import { submitSprintReport } from './reports'
import { getReportScorecard } from './scorecards'
import type { SprintReportInput } from '../../shared/domain/api'

const TARGET = { projectId: DM_PROJECT }

function request(src: ReportedSource, patch: Record<string, unknown> = {}): Parameters<typeof beginCrossRepoCorrection>[1] {
  return { reportId: src.report.id, experimentId: src.xp.dm.id, expectedTargetProjectId: DM_PROJECT, ...patch }
}

function domainError(action: () => unknown): DomainError {
  const error = thrownBy(action)
  if (!(error instanceof DomainError)) throw new Error(`expected a DomainError, got ${String(error)}`)
  return error
}

function draftOf(ctx: Ctx, epicId: string): PlanBundle {
  return JSON.parse(loadDraftRow(ctx, epicId)?.bundle_json ?? 'null') as PlanBundle
}

describe('DM-190 c1: a distinct target-owned epic with a complete draft and portable provenance', () => {
  it('creates one backlog epic in the target holding the work tickets, a Fireguard ticket and a valid draft', () => {
    const src = reportedSource()
    const dm = dmProject()
    const begun = beginCrossRepoCorrection(src.desktop, request(src), TARGET)
    expect(begun.inserted).toBe(true)
    expect(begun.link.state).toBe('pending')
    const target = materializeCrossRepoCorrection(dm, begun.packet, { expected: null, closed: null })
    expect(target).toMatchObject({ projectId: DM_PROJECT, created: true, saved: false, status: 'backlog' })
    expect(target.ticketIds).toHaveLength(3)
    expect(target.epicId).not.toBe(src.epicId)
    expect(src.ctx.db.get('SELECT id FROM epics WHERE id = ?', target.epicId)).toBeUndefined()
    expect(dm.db.get('SELECT id FROM epics WHERE id = ?', src.epicId)).toBeUndefined()
    const bundle = draftOf(dm, target.epicId)
    const titles = bundle.tickets.map((ticket) => ticket.title)
    expect(titles).toEqual(expect.arrayContaining(['Put the importer context into the claim packet', 'Show the packet context in the ticket view']))
    expect(bundle.tickets.filter((ticket) => ticket.kind === 'acceptance')).toHaveLength(1)
    expect(validatePlan(bundle, { repositories: null }).errors).toEqual([])
  })

  it('carries portable provenance naming source and target projects, with no machine path', () => {
    const src = reportedSource()
    const dm = dmProject()
    const begun = beginCrossRepoCorrection(src.desktop, request(src), TARGET)
    const target = materializeCrossRepoCorrection(dm, begun.packet, { expected: null, closed: null })
    const [epic] = correctionEpics(dm)
    expect(epic?.id).toBe(target.epicId)
    const provenance = parseJson<CorrectionProvenance | null>(epic?.provenance_json ?? null, null)
    expect(correctionProvenance.safeParse(provenance).success).toBe(true)
    expect(provenance).toMatchObject({
      kind: 'cross_repo_correction',
      key: `${src.report.id}/${src.xp.dm.id}/from:${src.ctx.projectId}/to:${DM_PROJECT}`,
      source: { projectId: src.ctx.projectId, epicId: src.epicId, runId: src.runId, reportId: src.report.id, reportRevision: 1, experimentId: src.xp.dm.id },
      target: { projectId: DM_PROJECT }
    })
    const text = `${epic?.provenance_json ?? ''}${JSON.stringify(begun.packet)}`
    expect(text).not.toContain(src.ctx.projectRoot)
    expect(text).not.toMatch(/[A-Za-z]:\\|\/home\/|\/Users\//)
  })
})

describe('DM-190 c1: refusals before anything is created', () => {
  it('keeps no receipt for an experiment aimed at the source repository itself: it only comes back unsaved and closed', () => {
    const src = reportedSource()
    const begun = beginCrossRepoCorrection(src.desktop, request(src, { experimentId: src.xp.local.id }), TARGET)
    expect(begun).toMatchObject({ inserted: false, link: { state: 'pending', attempts: 0 } })
    expect(begun.closed).toContain("its destination is this project's repository")
    expect(begun.unsaved?.experimentId).toBe(src.xp.local.id)
    expect(src.ctx.db.all('SELECT key FROM correction_links')).toEqual([])
  })

  it('refuses a packet for another project in the target (project_mismatch) and writes nothing there', () => {
    const src = reportedSource()
    const other = dmProject('pj_000000000000000000000000x1')
    const begun = beginCrossRepoCorrection(src.desktop, request(src), TARGET)
    const error = domainError(() => materializeCrossRepoCorrection(other, begun.packet, { expected: null, closed: null }))
    expect(error.code).toBe('project_mismatch')
    expect(correctionEpics(other)).toEqual([])
  })

  it('needs the person: an orchestrator session cannot request or create cross-repository work', () => {
    const src = reportedSource()
    const dm = dmProject()
    expect(domainError(() => beginCrossRepoCorrection(withRole(src.ctx, 'orchestrator'), request(src), TARGET)).code).toBe('unauthorized')
    const begun = beginCrossRepoCorrection(src.desktop, request(src), TARGET)
    expect(domainError(() => materializeCrossRepoCorrection(withRole(dm as TestCtx, 'orchestrator'), begun.packet, { expected: null, closed: null })).code).toBe('unauthorized')
    expect(correctionEpics(dm)).toEqual([])
  })
})

describe('DM-190 c2: retries recover the same target ids; conflicting payloads fail', () => {
  it('a repeat of the same packet returns the epic created before (created false), never a second one', () => {
    const src = reportedSource()
    const dm = dmProject()
    const begun = beginCrossRepoCorrection(src.desktop, request(src), TARGET)
    const first = materializeCrossRepoCorrection(dm, begun.packet, { expected: null, closed: null })
    const again = beginCrossRepoCorrection(src.desktop, request(src), TARGET)
    expect(again.inserted).toBe(false)
    expect(again.link.key).toBe(begun.link.key)
    const second = materializeCrossRepoCorrection(dm, again.packet, { expected: first.epicId, closed: null })
    expect(second).toMatchObject({ epicId: first.epicId, ticketIds: first.ticketIds, keys: first.keys, created: false })
    expect(correctionEpics(dm)).toHaveLength(1)
  })

  it('refuses another payload under the same key in the receipt and in the target (idempotency_mismatch)', () => {
    const src = reportedSource()
    const dm = dmProject()
    const begun = beginCrossRepoCorrection(src.desktop, request(src), TARGET)
    materializeCrossRepoCorrection(dm, begun.packet, { expected: null, closed: null })
    const receipt = domainError(() => beginCrossRepoCorrection(src.desktop, request(src, { title: 'Another title' }), TARGET))
    expect(receipt.code).toBe('idempotency_mismatch')
    expect(receipt.details).toMatchObject({ key: begun.link.key, state: 'pending' })
    // Another machine with no receipt asks the target with another payload.
    const elsewhere = reportedSource()
    const otherPacket = beginCrossRepoCorrection(elsewhere.desktop, request(elsewhere, { title: 'Another title' }), TARGET).packet
    const target = domainError(() => materializeCrossRepoCorrection(dm, otherPacket, { expected: null, closed: null }))
    expect(target.code).toBe('idempotency_mismatch')
    expect(correctionEpics(dm)).toHaveLength(1)
  })
})

describe('DM-190 c2: partial progress and shared keys', () => {
  it('records a failed link step with the epic the target accepted, then a delivery links that very epic', () => {
    const src = reportedSource()
    const dm = dmProject()
    const begun = beginCrossRepoCorrection(src.desktop, request(src), TARGET)
    const target = materializeCrossRepoCorrection(dm, begun.packet, { expected: null, closed: null })
    const failed = recordCrossRepoFailure(src.desktop, begun.link.key, { step: 'link', code: 'internal', problem: null, target })
    expect(failed).toMatchObject({ state: 'pending', attempts: 1, lastError: { step: 'link', code: 'internal', problem: null }, target: { epicId: target.epicId, created: false } })
    const reached = failed.target?.epicId ?? null
    const found = materializeCrossRepoCorrection(dm, begun.packet, { expected: reached, closed: null })
    expect(found).toMatchObject({ epicId: target.epicId, created: false })
    const linked = recordCrossRepoDelivery(src.desktop, begun.link.key, found)
    expect(linked).toMatchObject({ state: 'linked', attempts: 2, lastError: null, target: { epicId: target.epicId } })
    expect(correctionEpics(dm)).toHaveLength(1)
  })

  it('refuses to create a new epic when the epic a request reached before is gone (target_missing)', () => {
    const src = reportedSource()
    const dm = dmProject()
    const begun = beginCrossRepoCorrection(src.desktop, request(src), TARGET)
    const error = domainError(() => materializeCrossRepoCorrection(dm, begun.packet, { expected: 'ep_00000000000000000000000zzz', closed: null }))
    expect(error.code).toBe('conflict')
    expect(error.details).toMatchObject({ problem: 'target_missing' })
    expect(correctionEpics(dm)).toEqual([])
  })

  it('holds the earliest epic when two epics share a key with different payloads (records from another checkout)', () => {
    const src = reportedSource()
    const dm = dmProject()
    const begun = beginCrossRepoCorrection(src.desktop, request(src), TARGET)
    const created = materializeCrossRepoCorrection(dm, begun.packet, { expected: null, closed: null })
    // Another checkout's records arrive: an epic under the same key with another payload, created earlier.
    const otherHash = `sha256:${'f'.repeat(64)}`
    const arrived = createCorrectionEpic(dm, begun.packet.epic, { ...begun.packet.provenance, payloadHash: otherHash })
    dm.db.run("UPDATE epics SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", arrived)
    expect(heldCorrection(dm, begun.link.key, created.epicId)).toEqual({ held: { epicId: arrived, payloadHash: otherHash }, holdsReached: true })
    const fresh = domainError(() => materializeCrossRepoCorrection(dm, begun.packet, { expected: null, closed: null }))
    expect(fresh.code).toBe('idempotency_mismatch')
    expect(fresh.details).toMatchObject({ epicId: arrived })
    // A request that reached the later epic still finds exactly that one.
    expect(materializeCrossRepoCorrection(dm, begun.packet, { expected: created.epicId, closed: null })).toMatchObject({ epicId: created.epicId, created: false })
  })
})

describe('DM-190 c3: source history unchanged; target state independent', () => {
  it('leaves every source record but its receipt byte-identical, and the target epic has its own lifecycle', () => {
    const src = reportedSource()
    const dm = dmProject()
    const own = startedRun(dm as TestCtx)
    const sourceBefore = historyOf(src.ctx)
    const targetRuns = JSON.stringify(dm.db.all('SELECT * FROM runs ORDER BY id'))
    const targetRevisions = JSON.stringify(dm.db.all('SELECT * FROM plan_revisions ORDER BY id'))
    const begun = beginCrossRepoCorrection(src.desktop, request(src), TARGET)
    const target = materializeCrossRepoCorrection(dm, begun.packet, { expected: null, closed: null })
    recordCrossRepoDelivery(src.desktop, begun.link.key, target)
    expect(historyOf(src.ctx)).toBe(sourceBefore)
    expect(JSON.stringify(dm.db.all('SELECT * FROM runs ORDER BY id'))).toBe(targetRuns)
    expect(JSON.stringify(dm.db.all('SELECT * FROM plan_revisions ORDER BY id'))).toBe(targetRevisions)
    expect(correctionEpics(dm)).toEqual([expect.objectContaining({ id: target.epicId, status: 'backlog', branch_json: null, current_revision_id: null })])
    expect(dm.db.all('SELECT id FROM runs WHERE epic_id = ?', target.epicId)).toEqual([])
    expect(target.epicId).not.toBe(own.epicId)
    expect(draftOf(dm, target.epicId).tickets.map((ticket) => ticket.id)).not.toEqual(expect.arrayContaining(own.bundle.tickets.map((ticket) => ticket.id)))
  })
})

describe('DM-191 review: the carried key limit agrees with the receipt key limit (200)', () => {
  function keyIssue(key: string): boolean {
    const parsed = experimentEventSchema.safeParse({ kind: 'result', result: { crossRepo: { key } } })
    return !parsed.success && parsed.error.issues.some((issue) => issue.path.join('.') === 'result.crossRepo.key')
  }

  it('accepts a 200-character carried key and refuses a 201-character one', () => {
    expect(keyIssue('k'.repeat(200))).toBe(false)
    expect(keyIssue('k'.repeat(201))).toBe(true)
  })
})

const OTHER_PROJECT = 'pj_000000000000000000000000x1'
const UNKNOWN_XP = 'xp_00000000000000000000000zzz'

function abandon(src: ReportedSource, experimentId: string): void {
  recordExperimentEvent(withRole(src.ctx, 'orchestrator'), { experimentId, event: { kind: 'status', status: 'abandoned', note: 'Not worth it' } })
}

/** The request delivered: its receipt, the epic created in `dm`, and the link recorded. */
function delivered(src: ReportedSource, dm: Ctx): { key: string; target: CrossRepoTargetEpicView } {
  const begun = beginCrossRepoCorrection(src.desktop, request(src), TARGET)
  const target = materializeCrossRepoCorrection(dm, begun.packet, { expected: null, closed: null })
  recordCrossRepoDelivery(src.desktop, begun.link.key, target)
  return { key: begun.link.key, target }
}

function receiptKeys(src: ReportedSource): unknown[] {
  return src.ctx.db.all('SELECT key FROM correction_links')
}

/** Submits the next revision of the source's Sprint 1 report holding `experiments`; returns its id. */
function restated(src: ReportedSource, experiments: unknown[]): string {
  const input = parseInput(sprintReportInput, { summary: 'Sprint 1, restated.', retro: { wentWell: ['Tickets 1-3 landed'], experiments } }, 'report') as SprintReportInput
  return submitSprintReport(withRole(src.ctx, 'orchestrator'), { runId: src.runId, sprintId: src.report.sprintId, report: input }).id
}

describe('DM-273: the edits of a request shape its draft and are checked before anything is written', () => {
  it('refuses an edit of another experiment, a work item edited twice and a prerequisite outside the experiment', () => {
    const src = reportedSource()
    const own = src.xp.dm.id
    const ask = (edits: unknown[]): DomainError => domainError(() => beginCrossRepoCorrection(src.desktop, request(src, { edits }), TARGET))
    const other = ask([{ experimentId: src.xp.local.id, index: 0, title: 'Elsewhere' }])
    expect(other.code).toBe('invalid_input')
    expect(other.message).toBe(`The edit of ${src.xp.local.id}#0 names another experiment: edit only the work of ${own}.`)
    const twice = ask([
      { experimentId: own, index: 0, title: 'First' },
      { experimentId: own, index: 0, title: 'Second' }
    ])
    expect(twice.message).toBe(`${own}#0 is edited twice: give one edit per work item.`)
    const ticket = ask([{ experimentId: own, index: 1, dependsOn: [{ ticket: 'DM-1' }] }])
    expect(ticket.message).toContain(`Invalid prerequisite of ${own}#1`)
    const foreign = ask([{ experimentId: own, index: 1, dependsOn: [{ work: { experimentId: src.xp.local.id, index: 0 } }] }])
    expect(foreign.details).toEqual({ ref: `${own}#1` })
    expect(receiptKeys(src)).toEqual([])
  })

  it('applies edits in work order, so the same edits in another order are the same request', () => {
    const src = reportedSource()
    const own = src.xp.dm.id
    const first = { experimentId: own, index: 0, title: 'Put the importer context in' }
    const second = { experimentId: own, index: 1, title: 'Show the importer context', dependsOn: [{ work: { experimentId: own, index: 0 } }] }
    const begun = beginCrossRepoCorrection(src.desktop, request(src, { edits: [second, first] }), TARGET)
    expect(begun.packet.items.map((item) => item.title)).toEqual(['Put the importer context in', 'Show the importer context'])
    expect(begun.packet.items[1]?.dependsOn).toEqual([{ work: { experimentId: own, index: 0 } }])
    const again = beginCrossRepoCorrection(src.desktop, request(src, { edits: [first, second] }), TARGET)
    expect(again).toMatchObject({ inserted: false, link: { key: begun.link.key, payloadHash: begun.link.payloadHash } })
  })

  it('clips a title made from a long issue summary to the title limit', () => {
    const src = reportedSource()
    const reportId = restated(src, [{ ...restatementOf(src.xp.dm), issue: { ...restatementOf(src.xp.dm).issue, summary: `The claim packet ${'lacks the importer context '.repeat(15)}` } }])
    const { packet } = beginCrossRepoCorrection(src.desktop, request(src, { reportId }), TARGET)
    expect(packet.epic.title).toHaveLength(LIMITS.title)
    expect(packet.epic.title.startsWith(`Correction from ${src.ctx.projectId}: The claim packet lacks`)).toBe(true)
    expect(packet.epic.title.endsWith('…')).toBe(true)
  })
})

describe('DM-273: the experiment of a request is requested once, for one target project', () => {
  it('refuses an experiment the report does not hold (not_found)', () => {
    const src = reportedSource()
    const error = domainError(() => beginCrossRepoCorrection(src.desktop, request(src, { experimentId: UNKNOWN_XP }), TARGET))
    expect(error.code).toBe('not_found')
    expect(error.details).toEqual({ experimentId: UNKNOWN_XP, reportId: src.report.id })
  })

  it('refuses the same experiment for another target project once it was requested (conflict)', () => {
    const src = reportedSource()
    const begun = beginCrossRepoCorrection(src.desktop, request(src), TARGET)
    const error = domainError(() => beginCrossRepoCorrection(src.desktop, request(src, { expectedTargetProjectId: OTHER_PROJECT }), { projectId: OTHER_PROJECT }))
    expect(error.code).toBe('conflict')
    expect(error.message).toContain(`already requested for project ${DM_PROJECT} (pending)`)
    expect(error.details).toEqual({ key: begun.link.key })
  })

  it("refuses another payload under a linked key, pointing at the target epic's draft", () => {
    const src = reportedSource()
    const { key } = delivered(src, dmProject())
    const error = domainError(() => beginCrossRepoCorrection(src.desktop, request(src, { title: 'Another title' }), TARGET))
    expect(error.code).toBe('idempotency_mismatch')
    expect(error.details).toEqual({ key, state: 'linked' })
    expect(error.message).toContain("(linked): edit the target epic's draft there.")
  })
})

describe('DM-273: a draft the target would refuse is refused in the source, with nothing kept', () => {
  it('refuses edited acceptance criteria that are blank once trimmed', () => {
    const src = reportedSource()
    const own = src.xp.dm.id
    const error = domainError(() => beginCrossRepoCorrection(src.desktop, request(src, { edits: [{ experimentId: own, index: 0, acceptanceCriteria: ['   '] }] }), TARGET))
    expect(error.code).toBe('conflict')
    expect(error.message).toBe(`Not requested: ${own} proposedWork[0] "Put the importer context into the claim packet" needs non-blank acceptance criteria.`)
    expect(receiptKeys(src)).toEqual([])
  })

  it('refuses an edited body that no longer fits a ticket once the experiment context is added', () => {
    const src = reportedSource()
    const sentence = 'Add the importer record files and their schema locations to the claim packet context section. '
    const body = sentence.repeat(Math.floor(LIMITS.markdown / sentence.length))
    const error = domainError(() => beginCrossRepoCorrection(src.desktop, request(src, { edits: [{ experimentId: src.xp.dm.id, index: 0, body }] }), TARGET))
    expect(error.code).toBe('conflict')
    expect(error.message).toContain('its draft does not fit a plan (items.0.body:')
    expect(receiptKeys(src)).toEqual([])
  })

  it('refuses unsized work with a blank edited criterion, asking for a restated experiment', () => {
    const src = reportedSource()
    const unsized = restatementOf(src.xp.dm).proposedWork.map(({ title, body }) => ({ title, body }))
    const reportId = restated(src, [{ ...restatementOf(src.xp.dm), proposedWork: unsized }])
    const edits = [{ experimentId: src.xp.dm.id, index: 0, acceptanceCriteria: [' '] }]
    const error = domainError(() => beginCrossRepoCorrection(src.desktop, request(src, { reportId, edits }), TARGET))
    expect(error.message).toContain(`proposedWork[0] "Put the importer context into the claim packet" has no size`)
    expect(error.message.endsWith(' Restate it in a new report revision (by its id, from its original { reportId, assessmentId }) with sized, specific work.')).toBe(true)
    expect(receiptKeys(src)).toEqual([])
  })
})

describe('DM-273: receipts are read, linked and removed only as they stand', () => {
  it('reads a receipt by key and refuses an unknown key (not_found)', () => {
    const src = reportedSource()
    const begun = beginCrossRepoCorrection(src.desktop, request(src), TARGET)
    expect(crossRepoCorrectionLink(src.desktop, { key: begun.link.key })).toMatchObject({ key: begun.link.key, state: 'pending', experimentId: src.xp.dm.id })
    const error = domainError(() => crossRepoCorrectionLink(src.desktop, { key: 'no-such-key' }))
    expect(error.code).toBe('not_found')
    expect(error.details).toEqual({ key: 'no-such-key' })
  })

  it('writes a lost receipt once when linking an epic the target already held for a closed experiment', () => {
    const src = reportedSource()
    const dm = dmProject()
    const first = beginCrossRepoCorrection(src.desktop, request(src), TARGET)
    const created = materializeCrossRepoCorrection(dm, first.packet, { expected: null, closed: null })
    discardCrossRepoCorrection(src.desktop, first.link.key, 'withdrawn')
    abandon(src, src.xp.dm.id)
    const again = beginCrossRepoCorrection(src.desktop, request(src), TARGET)
    expect(again.closed).toBe('it is abandoned')
    const found = materializeCrossRepoCorrection(dm, again.packet, { expected: null, closed: again.closed })
    expect(found).toMatchObject({ epicId: created.epicId, created: false })
    recordCrossRepoDelivery(src.desktop, again.link.key, found, again.unsaved)
    const twice = recordCrossRepoDelivery(src.desktop, again.link.key, found, again.unsaved)
    expect(twice).toMatchObject({ state: 'linked', attempts: 2, target: { epicId: created.epicId } })
    expect(receiptKeys(src)).toEqual([{ key: first.link.key }])
  })

  it('refuses a delivery to another project and never removes a linked receipt', () => {
    const src = reportedSource()
    const { key, target } = delivered(src, dmProject())
    const elsewhere = domainError(() => recordCrossRepoDelivery(src.desktop, key, { ...target, projectId: OTHER_PROJECT }))
    expect(elsewhere.code).toBe('project_mismatch')
    expect(elsewhere.message).toBe(`The receipt ${key} is for project ${DM_PROJECT}, not ${OTHER_PROJECT}.`)
    const kept = domainError(() => discardCrossRepoCorrection(src.desktop, key, 'withdrawn'))
    expect(kept.code).toBe('conflict')
    expect(crossRepoCorrectionLink(src.desktop, { key }).state).toBe('linked')
  })
})

describe('DM-273: retries and lists read the receipts as they stand now', () => {
  it('reports an experiment left out of a later report revision as closed on a retry', () => {
    const src = reportedSource()
    const begun = beginCrossRepoCorrection(src.desktop, request(src), TARGET)
    expect(requestedCrossRepoCorrection(src.desktop, { key: begun.link.key }).closed).toBeNull()
    restated(src, [])
    expect(requestedCrossRepoCorrection(src.desktop, { key: begun.link.key }).closed).toBe('a later revision of its sprint report left it out (withdrawn)')
  })

  it('lists the receipts of one report revision or one experiment, and refuses an unknown report', () => {
    const src = reportedSource()
    const begun = beginCrossRepoCorrection(src.desktop, request(src), TARGET)
    const keys = (filter: { reportId?: string; experimentId?: string }): string[] => listCrossRepoCorrections(src.desktop, filter).map((link) => link.key)
    expect(keys({})).toEqual([begun.link.key])
    expect(keys({ reportId: src.report.id })).toEqual([begun.link.key])
    expect(keys({ reportId: src.report.id, experimentId: src.xp.local.id })).toEqual([])
    expect(keys({ experimentId: src.xp.dm.id })).toEqual([begun.link.key])
    const unknown = 'sr_00000000000000000000000zzz'
    expect(domainError(() => listCrossRepoCorrections(src.desktop, { reportId: unknown })).details).toEqual({ reportId: unknown })
    expect(keys({ reportId: restated(src, []) })).toEqual([])
  })
})

describe('DM-273: the source preview shows the receipt as it stands', () => {
  it('previews without a chosen target: no packet, no receipt, ready', () => {
    const src = reportedSource()
    const preview = previewCrossRepoSource(src.desktop, { reportId: src.report.id, experimentId: src.xp.dm.id }, null)
    expect(preview).toMatchObject({ packet: null, link: null, state: 'ready', problems: [] })
    expect(preview.epic.successCriteria).toHaveLength(1)
  })

  it('shows a receipt for another target project, or with another payload, as a conflict', () => {
    const src = reportedSource()
    const begun = beginCrossRepoCorrection(src.desktop, request(src), TARGET)
    const input = { reportId: src.report.id, experimentId: src.xp.dm.id }
    const elsewhere = previewCrossRepoSource(src.desktop, input, { projectId: OTHER_PROJECT })
    expect(elsewhere).toMatchObject({ state: 'conflict', link: { key: begun.link.key } })
    expect(elsewhere.problems).toEqual([`already requested for project ${DM_PROJECT} under key ${begun.link.key} with another target project`])
    const retitled = previewCrossRepoSource(src.desktop, { ...input, title: 'Another title' }, TARGET)
    expect(retitled.problems).toEqual([`already requested for project ${DM_PROJECT} under key ${begun.link.key} with another payload`])
  })

  it('shows a pending receipt as pending and a linked one as created', () => {
    const src = reportedSource()
    const input = { reportId: src.report.id, experimentId: src.xp.dm.id }
    const begun = beginCrossRepoCorrection(src.desktop, request(src), TARGET)
    expect(previewCrossRepoSource(src.desktop, input, TARGET)).toMatchObject({ state: 'pending', problems: [], packet: { provenance: { key: begun.link.key } } })
    const target = materializeCrossRepoCorrection(dmProject(), begun.packet, { expected: null, closed: null })
    recordCrossRepoDelivery(src.desktop, begun.link.key, target)
    expect(previewCrossRepoSource(src.desktop, input, TARGET)).toMatchObject({ state: 'created', problems: [], link: { state: 'linked' } })
  })

  it('shows a pending receipt of an experiment abandoned since as blocked, until the target accepted it', () => {
    const src = reportedSource()
    const input = { reportId: src.report.id, experimentId: src.xp.dm.id }
    const begun = beginCrossRepoCorrection(src.desktop, request(src), TARGET)
    const target = materializeCrossRepoCorrection(dmProject(), begun.packet, { expected: null, closed: null })
    abandon(src, src.xp.dm.id)
    expect(previewCrossRepoSource(src.desktop, input, TARGET)).toMatchObject({ state: 'blocked', problems: ['it is abandoned'] })
    recordCrossRepoFailure(src.desktop, begun.link.key, { step: 'link', code: 'internal', problem: null, target })
    expect(previewCrossRepoSource(src.desktop, input, TARGET)).toMatchObject({ state: 'pending', problems: [] })
  })
})

describe('DM-273: the target checks a packet before it reads or writes', () => {
  it('refuses a malformed packet (invalid_input), naming where it is malformed', () => {
    const src = reportedSource()
    const dm = dmProject()
    const { packet } = beginCrossRepoCorrection(src.desktop, request(src), TARGET)
    const empty = domainError(() => materializeCrossRepoCorrection(dm, { ...packet, items: [] }, { expected: null, closed: null }))
    expect(empty.code).toBe('invalid_input')
    expect(empty.message.startsWith('The corrective draft is malformed at items: ')).toBe(true)
    const nothing = domainError(() => previewCrossRepoTarget(dm, null as unknown as typeof packet))
    expect(nothing.message.startsWith('The corrective draft is malformed at ?: ')).toBe(true)
    expect(correctionEpics(dm)).toEqual([])
  })

  it('previews the draft as ready, as created once the target holds the key, and as a conflict under another payload', () => {
    const src = reportedSource()
    const dm = dmProject()
    const { packet } = beginCrossRepoCorrection(src.desktop, request(src), TARGET)
    const ready = previewCrossRepoTarget(dm, packet)
    expect(ready).toMatchObject({ state: 'ready', existing: null, problems: [], validation: { errors: [] } })
    expect(ready.tickets.map((ticket) => ticket.title)).toEqual(expect.arrayContaining(['Put the importer context into the claim packet', 'Show the packet context in the ticket view']))
    const created = materializeCrossRepoCorrection(dm, packet, { expected: null, closed: null })
    expect(previewCrossRepoTarget(dm, packet)).toMatchObject({ state: 'created', existing: { epicId: created.epicId, created: false } })
    const elsewhere = reportedSource()
    const other = beginCrossRepoCorrection(elsewhere.desktop, request(elsewhere, { title: 'Another title' }), TARGET).packet
    const conflict = previewCrossRepoTarget(dm, other)
    expect(conflict).toMatchObject({ state: 'conflict', existing: null })
    expect(conflict.problems).toEqual([expect.stringContaining(`Epic ${created.epicId} of this project already holds the corrective work`)])
  })

  it('refuses a draft a folder of repositories cannot hold (invalid_graph) and keeps no epic', () => {
    const src = reportedSource()
    const folder = withRole(createTestCtx({ projectId: DM_PROJECT, repositories: ['app'] }), 'desktop')
    const { packet } = beginCrossRepoCorrection(src.desktop, request(src), TARGET)
    expect(previewCrossRepoTarget(folder, packet).validation.errors.map((issue) => issue.code)).toContain('missing_repo')
    const error = domainError(() => materializeCrossRepoCorrection(folder, packet, { expected: null, closed: null }))
    expect(error.code).toBe('invalid_graph')
    expect(error.message).toContain('The corrective draft would not be valid here: ')
    expect(correctionEpics(folder)).toEqual([])
  })
})

describe('DM-273: the epic holding the work is read from its draft, else its saved plan', () => {
  it('finds the work in the saved plan once the draft is gone', () => {
    const src = reportedSource()
    const dm = dmProject()
    const { packet } = beginCrossRepoCorrection(src.desktop, request(src), TARGET)
    const created = materializeCrossRepoCorrection(dm, packet, { expected: null, closed: null })
    seedRevision(dm, created.epicId, draftOf(dm, created.epicId))
    dm.db.run('DELETE FROM drafts WHERE epic_id = ?', created.epicId)
    const found = materializeCrossRepoCorrection(dm, packet, { expected: created.epicId, closed: null })
    expect(found).toMatchObject({ epicId: created.epicId, saved: true, draftRevision: null, ticketIds: created.ticketIds, sprintId: created.sprintId })
  })

  it('shows an epic holding neither a draft nor a saved plan with no tickets', () => {
    const src = reportedSource()
    const dm = dmProject()
    const { packet } = beginCrossRepoCorrection(src.desktop, request(src), TARGET)
    const created = materializeCrossRepoCorrection(dm, packet, { expected: null, closed: null })
    dm.db.run('DELETE FROM drafts WHERE epic_id = ?', created.epicId)
    const found = materializeCrossRepoCorrection(dm, packet, { expected: created.epicId, closed: null })
    expect(found).toMatchObject({ epicId: created.epicId, epicTitle: packet.epic.title, sprintId: '', ticketIds: [], keys: [], draftRevision: null, saved: false })
  })

  it('answers what the target holds under a key: nothing yet, then the epic and whether it holds the one reached', () => {
    const src = reportedSource()
    const dm = dmProject()
    const { packet } = beginCrossRepoCorrection(src.desktop, request(src), TARGET)
    const { key, payloadHash } = packet.provenance
    expect(heldCorrection(dm, key, 'ep_00000000000000000000000zzz')).toEqual({ held: null, holdsReached: false })
    const created = materializeCrossRepoCorrection(dm, packet, { expected: null, closed: null })
    expect(heldCorrection(dm, key)).toEqual({ held: { epicId: created.epicId, payloadHash }, holdsReached: false })
    expect(heldCorrection(dm, key, created.epicId)).toEqual({ held: { epicId: created.epicId, payloadHash }, holdsReached: true })
  })
})

function frozenCard(src: ReportedSource): CarriedResults['scorecards'][number] {
  const read = getReportScorecard(src.desktop, { reportId: src.report.id })
  if (read.state !== 'frozen') throw new Error(`report ${src.report.id} froze no scorecard`)
  return read.scorecard.snapshot
}

describe('DM-273: results are brought back only from the linked epic, as sealed', () => {
  it('refuses to read results of an epic the target does not hold under the key (target_missing)', () => {
    const src = reportedSource()
    const { key } = delivered(src, dmProject())
    const error = domainError(() => crossRepoResults(dmProject(), { key, epicId: 'ep_00000000000000000000000zzz', experimentId: src.xp.dm.id }))
    expect(error.code).toBe('conflict')
    expect(error.details).toEqual({ problem: 'target_missing', epicId: 'ep_00000000000000000000000zzz', key })
  })

  it('keeps what the linked epic holds, its tickets not yet accepted', () => {
    const src = reportedSource()
    const dm = dmProject()
    const { key, target } = delivered(src, dm)
    const read = crossRepoResults(dm, { key, epicId: target.epicId, experimentId: src.xp.dm.id })
    const link = recordCrossRepoResults(src.desktop, key, { ...read, readAt: src.ctx.clock.nowIso() })
    expect(link.results).toMatchObject({ epicId: target.epicId, grades: [] })
    expect(link.results?.tickets.map((ticket) => ticket.acceptedAt)).toEqual(target.keys.map(() => null))
  })

  it('refuses results of a pending request, of another epic, or with a scorecard that is not a sealed one of the epic', () => {
    const src = reportedSource()
    const dm = dmProject()
    const begun = beginCrossRepoCorrection(src.desktop, request(src), TARGET)
    const target = materializeCrossRepoCorrection(dm, begun.packet, { expected: null, closed: null })
    const read = { ...crossRepoResults(dm, { key: begun.link.key, epicId: target.epicId, experimentId: src.xp.dm.id }), readAt: src.ctx.clock.nowIso() }
    const keep = (carried: typeof read): DomainError => domainError(() => recordCrossRepoResults(src.desktop, begun.link.key, carried))
    expect(keep(read).message).toBe(`The request ${begun.link.key} is not linked to an epic of project ${DM_PROJECT} yet: finish it first.`)
    recordCrossRepoDelivery(src.desktop, begun.link.key, target)
    expect(keep({ ...read, epicId: src.epicId }).code).toBe('project_mismatch')
    const card = frozenCard(src)
    expect(keep({ ...read, scorecards: [card] }).code).toBe('invalid_input')
    expect(keep({ ...read, scorecards: [{ ...card, epicId: target.epicId }] }).message).toContain(`not a sealed scorecard of epic ${target.epicId}`)
    expect(crossRepoCorrectionLink(src.desktop, { key: begun.link.key }).results).toBeNull()
  })
})
