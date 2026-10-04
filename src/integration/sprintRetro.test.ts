/**
 * A checkpoint that reads as a sprint review and retrospective, end to end: the reporter writes a retro
 * naming tickets by display key, the server resolves them, adds the tier facts it computes from the
 * attempts (including an escalation and an orchestrator fallback), holds the sprint back until the retro
 * is there, and keeps all of it through a flush and a clone.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Workspace } from '../core/workspace'
import type { GateCondition, SprintReportView } from '../shared/domain/views'
import type { SprintRetroInput } from '../shared/domain/retro'
import { ORCHESTRATOR_FALLBACK_LABEL } from '../shared/domain/status'
import { hostCatalog, hostModel } from '../test/execution'
import { createHarness, type Harness } from '../test/workspaceHarness'

const EFFORTS = ['low', 'medium', 'high'] as const

interface Planned {
  epicId: string
  nodeId: string
  buildId: string
  docsId: string
  sprintId: string
}

interface Started extends Planned {
  runId: string
}

/** One sprint: a medium work ticket, a small one, and the acceptance node every new epic starts with. */
async function planSprint(agent: Workspace): Promise<Planned> {
  await agent.initializeRepository({ name: 'demo-repo', keyPrefix: 'DM' })
  const epic = await agent.createEpic({ title: 'Retro epic', successCriteria: ['The sprint is reviewed'] })
  const [node] = (await agent.getPlan({ epicId: epic.id, view: 'draft' })).bundle.tickets
  const nodeId = node?.id ?? ''
  const update = await agent.updatePlanDraft({
    epicId: epic.id,
    ops: [
      { op: 'add_ticket', ref: 'build', sprint: '1', ticket: { title: 'Build it', acceptanceCriteria: ['It builds'], size: 'medium' } },
      { op: 'add_ticket', ref: 'docs', sprint: '1', ticket: { title: 'Document it', acceptanceCriteria: ['It is documented'], size: 'small' } },
      {
        op: 'update_ticket',
        ticket: nodeId,
        patch: { acceptanceCriteria: [{ text: 'Build works', covers: 'build' }, { text: 'Docs read well', covers: 'docs' }] }
      }
    ]
  })
  await agent.savePlan({ epicId: epic.id, expectedDraftRevision: update.draftRevision })
  const plan = await agent.getPlan({ epicId: epic.id, view: 'saved' })
  return {
    epicId: epic.id,
    nodeId,
    buildId: update.refMap['build'] ?? '',
    docsId: update.refMap['docs'] ?? '',
    sprintId: plan.bundle.sprints[0]?.id ?? ''
  }
}

async function startRun(orchestrator: Workspace, planned: Planned): Promise<Started> {
  const catalog = await orchestrator.registerHost(
    hostCatalog([
      hostModel('small', { costTier: 'low', reasoningLevels: ['routine', 'multi_step'], efforts: [...EFFORTS] }),
      hostModel('big', { costTier: 'high', reasoningLevels: ['multi_step', 'deep'], efforts: [...EFFORTS] })
    ])
  )
  const run = await orchestrator.startRun({ epicId: planned.epicId, hostCatalogId: catalog.id })
  return { ...planned, runId: run.id }
}

async function claimAndSubmit(agent: Workspace, run: Started, ticketId: string, worker: { modelId?: string; effort?: (typeof EFFORTS)[number] }) {
  const claim = await agent.claimTicket({ runId: run.runId, ticketId, worker: { label: 'Claude Code', ...worker } })
  await agent.submitAttempt({ attemptId: claim.attempt.id, claimToken: claim.packet.claimToken, outputs: { summary: 'Done.' } })
  return claim
}

/** Build is rejected at the small model, then accepted at the big one; docs go to a model the catalog lacks, so the orchestrator collects them. */
async function workTheSprint(agent: Workspace, run: Started): Promise<void> {
  const first = await claimAndSubmit(agent, run, run.buildId, { modelId: 'small', effort: 'low' })
  await agent.rejectAttempt({ attemptId: first.attempt.id, reasons: ['Misses the edge cases'] })
  const second = await claimAndSubmit(agent, run, run.buildId, { modelId: 'big', effort: 'high' })
  await agent.acceptAttempt({ attemptId: second.attempt.id })
  const docs = await claimAndSubmit(agent, run, run.docsId, { modelId: 'ghost', effort: 'low' })
  expect(docs.attempt.worker.label).toBe(ORCHESTRATOR_FALLBACK_LABEL)
  await agent.acceptAttempt({ attemptId: docs.attempt.id })
}

const RETRO: SprintRetroInput = {
  delivered: [{ ticket: 'DM-2', demo: 'Run the build and open the report', evidence: 'commit 3f9a0d1' }],
  wentWell: ['The second attempt landed cleanly'],
  wentPoorly: ['The first attempt missed the edge cases'],
  actions: ['Start build tickets at the big model'],
  discoveries: [{ title: 'Cache the host catalog', body: 'Every claim reloads it', ticket: 'DM-2' }],
  leftovers: [],
  tierFit: [{ ticket: 'DM-2', verdict: 'undersized', note: 'Rejected once at the small model' }]
}

async function retroGate(agent: Workspace, runId: string): Promise<GateCondition | undefined> {
  return (await agent.getCheckpoint({ runId })).conditions.find((item) => item.id === 'retro')
}

async function submit(agent: Workspace, run: Started, retro?: SprintRetroInput): Promise<SprintReportView> {
  return agent.submitSprintReport({
    runId: run.runId,
    sprintId: run.sprintId,
    report: { summary: 'Sprint 1 built and documented it.', ...(retro === undefined ? {} : { retro }) }
  })
}

let harness: Harness
let orchestrator: Workspace
let run: Started

beforeEach(async () => {
  harness = createHarness()
  const planner = harness.open('planner')
  const planned = await planSprint(planner)
  orchestrator = harness.open('orchestrator')
  run = await startRun(orchestrator, planned)
})

afterEach(() => {
  harness.cleanup()
})

describe('the sprint report with a retro', () => {
  it('stores the retro with its tickets resolved to ids and returns it from get_sprint_report', async () => {
    await workTheSprint(orchestrator, run)
    const submitted = await submit(orchestrator, run, RETRO)
    const read = await orchestrator.getSprintReport({ runId: run.runId })
    expect(read?.id).toBe(submitted.id)
    expect(read?.report.retro).toEqual({
      ...RETRO,
      delivered: [{ ticket: run.buildId, demo: 'Run the build and open the report', evidence: 'commit 3f9a0d1' }],
      discoveries: [{ title: 'Cache the host catalog', body: 'Every claim reloads it', ticket: run.buildId }],
      tierFit: [{ ticket: run.buildId, verdict: 'undersized', note: 'Rejected once at the small model' }]
    })
  })

  it('refuses a retro that names a ticket the plan does not have', async () => {
    await expect(submit(orchestrator, run, { leftovers: [{ ticket: 'DM-99', reason: 'Gone' }] })).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('retro.leftovers[0].ticket')
    })
    expect(await orchestrator.getSprintReport({ runId: run.runId })).toBeNull()
  })

  it('adds the tier facts the server computes from the attempts: sizes, planned levels, models, efforts, counts, escalation', async () => {
    await workTheSprint(orchestrator, run)
    const facts = (await submit(orchestrator, run, RETRO)).tierFacts
    expect(facts.map((item) => item.key)).toEqual(['DM-2', 'DM-3', 'DM-1'])
    const [build, docs, node] = facts
    expect(build).toMatchObject({ ticketId: run.buildId, size: 'medium', plannedLevel: 'multi_step', plannedEffort: null })
    expect(build?.attempts.map((item) => [item.number, item.state, item.modelId, item.effort, item.fallback])).toEqual([
      [1, 'rejected', 'small', 'low', false],
      [2, 'accepted', 'big', 'high', false]
    ])
    expect([build?.attemptCount, build?.rejectionCount, build?.escalated]).toEqual([2, 1, true])
    expect(docs).toMatchObject({ size: 'small', attemptCount: 1, rejectionCount: 0, escalated: false })
    expect(docs?.attempts).toMatchObject([{ modelId: null, effort: null, label: ORCHESTRATOR_FALLBACK_LABEL, fallback: true }])
    expect(node).toMatchObject({ ticketId: run.nodeId, attemptCount: 0, escalated: false })
  })
})

describe('the retro gate at a checkpoint', () => {
  it('stays unmet until a report with a retro is submitted, and is unmet again when a revision leaves it out', async () => {
    await workTheSprint(orchestrator, run)
    expect(await retroGate(orchestrator, run.runId)).toMatchObject({ met: false, detail: 'No Sprint 1 report yet, so no retro' })
    await submit(orchestrator, run)
    expect(await retroGate(orchestrator, run.runId)).toMatchObject({ met: false, detail: expect.stringContaining('has no retro') })
    await submit(orchestrator, run, RETRO)
    expect(await retroGate(orchestrator, run.runId)).toMatchObject({ met: true })
    await submit(orchestrator, run)
    expect(await retroGate(orchestrator, run.runId)).toMatchObject({ met: false })
  })

  it('names the missing retro when it refuses to approve the sprint', async () => {
    await workTheSprint(orchestrator, run)
    const report = await submit(orchestrator, run)
    const desktop = harness.open('desktop')
    await expect(desktop.approveCheckpoint({ runId: run.runId, reportId: report.id })).rejects.toMatchObject({
      code: 'gate_blocked',
      message: expect.stringContaining('The Sprint 1 report has no retro')
    })
  })
})

describe('the retro in the repository', () => {
  it('survives a flush and a clone, with its tier facts read from the cloned attempts, and is found by search', async () => {
    await workTheSprint(orchestrator, run)
    const submitted = await submit(orchestrator, run, RETRO)
    await orchestrator.flushPortableState()
    const clone = harness.open('orchestrator', { root: harness.cloneTracked() })
    const read = await clone.getSprintReport({ runId: run.runId, sprintId: run.sprintId })
    expect(read?.report.retro).toEqual(submitted.report.retro)
    expect(read?.contentHash).toBe(submitted.contentHash)
    expect(read?.tierFacts.find((item) => item.ticketId === run.buildId)).toMatchObject({ attemptCount: 2, rejectionCount: 1 })
    const found = await clone.searchHistory({ query: 'edge' })
    expect(found.filter((item) => item.docType === 'report').map((item) => item.docId)).toEqual([submitted.id])
  })
})
