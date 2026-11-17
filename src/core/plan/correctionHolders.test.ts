import { describe, expect, it } from 'vitest'
import type { EpicProvenance, PlanBundle } from '../../shared/domain/bundle'
import type { CrossRepoResultEvidence, RetroExperiment, SealedAssessmentRef } from '../../shared/domain/experiments'
import type { ScorecardSnapshot } from '../../shared/domain/spaceGrades'
import {
  bringBack,
  completedEpic,
  dmSourceEpic,
  type Machine,
  machine,
  MACHINE_B,
  planFollowUp,
  record,
  requestCorrection,
  sprintResult,
  workCorrection
} from '../../test/outcomeWorld'
import { snapshotHashOf } from '../space/snapshot'
import { type CorrectionHolder, correctionHolderProblem, crossRepoCorrectionKey, crossRepoEvidenceProblem, crossRepoSealOf } from './corrections'

const OTHER_PROJECT = 'pj_000000000000000000000000qq'

/** An epic as the holder check reads it: its provenance and the bundles of its saved revisions. */
function holderOf(m: Machine, epicId: string): CorrectionHolder {
  const provenance = JSON.parse(m.ctx.db.get<{ provenance_json: string | null }>('SELECT provenance_json FROM epics WHERE id = ?', epicId)?.provenance_json ?? 'null') as EpicProvenance | null
  const bundles = m.ctx.db.all<{ bundle_json: string }>('SELECT bundle_json FROM plan_revisions WHERE epic_id = ? ORDER BY number', epicId).map((row) => JSON.parse(row.bundle_json) as PlanBundle)
  return { epicId, provenance, bundles }
}

type CrossProvenance = Extract<EpicProvenance, { kind: string }>

describe("DM-191 c1 (DM-270 R8): this project's own correction epic holds an experiment's work; nothing else stands in for it", () => {
  it('accepts the epic the active repository made as its own target, and refuses every other provenance, key or bundle', () => {
    const self = machine()
    const source = dmSourceEpic(self)
    const own = workCorrection(self, requestCorrection(self, self, source).epicId, 14).epicId
    const shop = machine({ machineId: MACHINE_B, projectId: OTHER_PROJECT })
    const shopSource = dmSourceEpic(shop)
    const asked = workCorrection(self, requestCorrection(shop, self, shopSource).epicId, 10).epicId
    const experiment = source.experiment
    const project = self.ctx.projectId
    expect(shopSource.experiment.id).toBe(experiment.id)
    const real = holderOf(self, own)
    const provenance = real.provenance as CrossProvenance
    const edit = (patch: (p: CrossProvenance) => CrossProvenance): CorrectionHolder => ({ ...real, provenance: patch(structuredClone(provenance)) })
    const key = crossRepoCorrectionKey(experiment, project, project)
    const neither = (epicId: string): string => `epic ${epicId} is neither a follow-up of epic ${source.epicId} nor this project's own correction epic for experiment ${experiment.id}`
    const otherKey = (epicId: string): string => `epic ${epicId} holds work of experiment ${experiment.id} under another key than ${key}`
    const cases: [string, string | null, string][] = [
      ['without a project id (old callers)', correctionHolderProblem(real, experiment), neither(own)],
      ['asked for another project id', correctionHolderProblem(real, experiment, OTHER_PROJECT), neither(own)],
      ['source.projectId another project', correctionHolderProblem(edit((p) => ({ ...p, source: { ...p.source, projectId: OTHER_PROJECT } })), experiment, project), neither(own)],
      ['target.projectId another project', correctionHolderProblem(edit((p) => ({ ...p, target: { ...p.target, projectId: OTHER_PROJECT } })), experiment, project), neither(own)],
      ['source.experimentId another experiment', correctionHolderProblem(edit((p) => ({ ...p, source: { ...p.source, experimentId: 'xp_0000000000000000000000zzzz' } })), experiment, project), neither(own)],
      ['source.epicId another epic', correctionHolderProblem(edit((p) => ({ ...p, source: { ...p.source, epicId: asked } })), experiment, project), neither(own)],
      ['the key of another request (from the other project)', correctionHolderProblem(edit((p) => ({ ...p, key: crossRepoCorrectionKey(experiment, OTHER_PROJECT, project) })), experiment, project), neither(own)],
      ['a key naming another report', correctionHolderProblem(edit((p) => ({ ...p, key: p.key.replace(/^[^/]+/, 'rp_0000000000000000000000zzzz') })), experiment, project), neither(own)],
      ['no provenance', correctionHolderProblem({ ...real, provenance: null }, experiment, project), neither(own)],
      ['a follow-up provenance naming another epic', correctionHolderProblem({ ...real, provenance: { sourceEpicId: asked, note: '' } }, experiment, project), neither(own)],
      ["its provenance with the bundles of the epic the other project asked for (markers under that request's key)", correctionHolderProblem({ ...real, bundles: holderOf(self, asked).bundles }, experiment, project), otherKey(own)],
      ['its provenance without a saved bundle', correctionHolderProblem({ ...real, bundles: [] }, experiment, project), `no saved revision of epic ${own} holds corrective work of experiment ${experiment.id}`],
      ['the epic the other project asked for, as it is', correctionHolderProblem(holderOf(self, asked), experiment, project), neither(asked)],
      ["the epic the other project asked for, its provenance rewritten to claim this project's request", correctionHolderProblem({ ...holderOf(self, asked), provenance }, experiment, project), otherKey(asked)]
    ]
    expect(correctionHolderProblem(real, experiment, project)).toBeNull()
    for (const [label, problem, expected] of cases) expect({ label, problem }).toEqual({ label, problem: expected })
  })
})

describe('DM-188 c1: a follow-up epic holds an experiment\'s work only under its provenance, the follow-up key and one payload hash', () => {
  it('accepts the saved follow-up and refuses another provenance, the same-epic key, two payload hashes or no saved revision', () => {
    const m = machine()
    const source = completedEpic(m)
    const plan = planFollowUp(m, source)
    const holder = holderOf(m, plan.epicId)
    const [bundle] = holder.bundles
    if (bundle === undefined) throw new Error('the follow-up has no saved revision')
    const experiment = source.experiment
    const neither = `epic ${plan.epicId} is neither a follow-up of epic ${source.epicId} nor this project's own correction epic for experiment ${experiment.id}`
    const sameEpicKey = JSON.parse(JSON.stringify(bundle).replaceAll(`/follow-up:${source.epicId}#`, `/epic:${source.epicId}#`)) as PlanBundle
    const twoHashes: PlanBundle = {
      ...bundle,
      tickets: bundle.tickets.map((ticket, index) => (index === 0 ? { ...ticket, references: ticket.references.map((ref) => ({ ...ref, hash: ref.hash === null ? null : `sha256:${'3'.repeat(64)}` })) } : ticket))
    }
    expect(correctionHolderProblem(holder, experiment)).toBeNull()
    expect(correctionHolderProblem({ ...holder, provenance: null }, experiment)).toBe(neither)
    expect(correctionHolderProblem({ ...holder, provenance: { sourceEpicId: 'ep_0000000000000000000000zzzz', note: '' } }, experiment)).toBe(neither)
    expect(correctionHolderProblem({ ...holder, bundles: [sameEpicKey] }, experiment)).toContain(`holds work of experiment ${experiment.id} under another key than ${source.report.id}/${experiment.id}/follow-up:${source.epicId}`)
    expect(correctionHolderProblem({ ...holder, bundles: [twoHashes] }, experiment)).toBe(`the correction markers of experiment ${experiment.id} in epic ${plan.epicId} do not carry one payload hash`)
    expect(correctionHolderProblem({ ...holder, bundles: [] }, experiment)).toBe(`no saved revision of epic ${plan.epicId} holds corrective work of experiment ${experiment.id}`)
  })
})

interface Carried {
  experiment: RetroExperiment
  carried: CrossRepoResultEvidence
  cited: SealedAssessmentRef
  projectId: string
  own: string[]
  /** The other report of the correction epic (its Sprint 1). */
  otherReportId: string
}

/** A result recorded from a correction epic's Sprint 2 grade in another project, as it carries that epic's evidence. */
function carriedResult(): Carried {
  const m = machine()
  const source = dmSourceEpic(m)
  const target = machine({ machineId: MACHINE_B, idStart: 100_000, projectId: OTHER_PROJECT })
  const requested = requestCorrection(m, target, source)
  const run = workCorrection(target, requested.epicId, 14)
  bringBack(m, target, requested, source.experiment.id)
  const event = record(m, source.experiment.id, sprintResult(run.cards[1], 'milliseconds', 'correction Sprint 2'))
  if (event.kind !== 'result' || event.result.crossRepo === undefined || event.result.assessment === null) throw new Error('the result carries no evidence')
  return { experiment: source.experiment, carried: event.result.crossRepo, cited: event.result.assessment, projectId: m.ctx.projectId, own: [source.epicId], otherReportId: run.reports[0].id }
}

const resealed = (carried: CrossRepoResultEvidence): CrossRepoResultEvidence => ({ ...carried, seal: crossRepoSealOf(carried) })
const resealedCard = (card: ScorecardSnapshot): ScorecardSnapshot => ({ ...card, snapshotHash: snapshotHashOf(card) })

describe('DM-191 c2 (DM-270 R8): carried cross-repository evidence is bound to this request and its seals', () => {
  it('accepts the evidence as recorded, and refuses it unbound to this experiment, request, project, epic or report', () => {
    const c = carriedResult()
    const here = { projectId: c.projectId, own: c.own, regrade: true }
    const check = (carried: CrossRepoResultEvidence, patch: Partial<{ experiment: RetroExperiment; own: string[]; cited: SealedAssessmentRef | null }> = {}): string | null =>
      crossRepoEvidenceProblem(carried, patch.experiment ?? c.experiment, { ...here, own: patch.own ?? here.own }, patch.cited === undefined ? c.cited : patch.cited)
    const { carried } = c
    const card = carried.scorecard
    const key = crossRepoCorrectionKey(c.experiment, c.projectId, OTHER_PROJECT)
    expect(check(carried)).toBeNull()
    expect(check(carried, { experiment: { ...c.experiment, destination: { kind: 'source_repository', repository: null } } })).toBe(`carries a grade of another project, but experiment ${c.experiment.id} is not aimed at the Dark Mechanicus source`)
    expect(check(carried, { cited: null })).toBe('carries a grade of another project but cites none')
    expect(check(carried, { own: [...c.own, carried.epicId] })).toBe(`cites a grade of epic ${carried.epicId} of this project but carries one of another project`)
    expect(check(resealed({ ...carried, projectId: c.projectId }))).toBe(`carries a grade of project ${c.projectId}, which is this project`)
    const otherRequest = crossRepoCorrectionKey(c.experiment, 'pj_0000000000000000000000zzzz', OTHER_PROJECT)
    expect(check(resealed({ ...carried, key: otherRequest }))).toBe(`carries evidence of request ${otherRequest}, not of this project's request ${key}`)
    expect(check(carried, { cited: { ...c.cited, reportId: c.otherReportId } })).toBe(`cites epic ${carried.epicId} (report ${c.otherReportId}) but carries scorecard ${card.report.reportId} of epic ${carried.epicId}`)
    const foreignTicket = carried.corrections.map((ticket, index) => (index === 0 ? { ...ticket, epicId: 'ep_0000000000000000000000zzzz' } : ticket))
    expect(check(resealed({ ...carried, corrections: foreignTicket }))).toBe(`carries tickets or scope starts of an epic other than ${carried.epicId}`)
  })

  it("refuses scope starts for the cited scorecard's sprint other than those the scorecard holds, even resealed", () => {
    const c = carriedResult()
    const here = { projectId: c.projectId, own: c.own, regrade: true }
    const { carried } = c
    const card = carried.scorecard
    const ownEntry = (item: CrossRepoResultEvidence['starts'][number]): boolean => item.runId === card.runId && item.sprintId === card.sprintId
    const message = `carries scope starts for sprint ${card.sprintId} of run ${card.runId} that are not those its scorecard ${card.report.reportId} holds`
    const earlier = resealed({ ...carried, starts: carried.starts.map((item) => (ownEntry(item) ? { ...item, sprint: '2026-01-01T00:00:00.000Z' } : item)) })
    const dropped = resealed({ ...carried, starts: carried.starts.filter((item) => !ownEntry(item)) })
    const extra = resealed({ ...carried, starts: [...carried.starts, { ...(carried.starts.find(ownEntry) ?? carried.starts[0]!), run: '2026-01-01T00:00:00.000Z' }] })
    expect(carried.starts.filter(ownEntry)).toHaveLength(1)
    expect(crossRepoEvidenceProblem(earlier, c.experiment, here, c.cited)).toBe(message)
    expect(crossRepoEvidenceProblem(dropped, c.experiment, here, c.cited)).toBe(message)
    expect(crossRepoEvidenceProblem(extra, c.experiment, here, c.cited)).toBe(message)
  })

  it('refuses evidence or a scorecard edited without its seal, and a resealed scorecard that does not grade as sealed (on a write or import)', () => {
    const c = carriedResult()
    const here = { projectId: c.projectId, own: c.own, regrade: true }
    const { carried } = c
    const card = carried.scorecard
    const accepted = carried.corrections.map((ticket) => (ticket.accepted === null ? ticket : { ...ticket, accepted: { ...ticket.accepted, at: '2026-01-01T00:00:00.000Z' } }))
    const tamperedCard = { ...card, sprint: { ...card.sprint, result: { ...card.sprint.result, score: 1 } } }
    expect(crossRepoEvidenceProblem({ ...carried, corrections: accepted }, c.experiment, here, c.cited)).toBe('carries evidence that does not match its seal')
    expect(crossRepoEvidenceProblem(resealed({ ...carried, scorecard: tamperedCard }), c.experiment, here, c.cited)).toBe(`carries a scorecard of report ${card.report.reportId} that does not match its seal`)
    const regraded = resealed({ ...carried, scorecard: resealedCard(tamperedCard) })
    expect(crossRepoEvidenceProblem(regraded, c.experiment, here, c.cited)).toBe(`carries a scorecard of report ${card.report.reportId} that does not grade as sealed`)
    expect(crossRepoEvidenceProblem(regraded, c.experiment, { ...here, regrade: false }, c.cited)).toBeNull()
  })
})
