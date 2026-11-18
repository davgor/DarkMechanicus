/**
 * Same-repository and cross-repository corrective work end to end on two real repositories (DM-193 c3): nothing is
 * saved, run, adopted or approved on the person's behalf; a completed source epic stays completed and unchanged; a
 * missing Dark Mechanicus checkout refuses the request and never redirects it to another folder; a write that stops
 * part way is finished by a retry without a duplicate; the work runs under the checkout's own epic and run. Each test
 * builds its own machine (`src/test/twoRepoMachine.ts`) in its own temp folder.
 */
import { renameSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandResult } from '../shared/desktop/api'
import { markerCheckout } from '../test/crossRepoWorld'
import { createGitRepo } from '../test/gitRepo'
import { complete, data, fail, report1, type Report1, sprint1, type Sprint1 } from '../test/spaceLoop'
import { type TwoRepoMachine, twoRepoMachine } from '../test/twoRepoMachine'

const machines: TwoRepoMachine[] = []

afterEach(() => {
  for (const m of machines.splice(0)) m.cleanup()
})

interface Reported {
  m: TwoRepoMachine
  s: Sprint1
  r: Report1
}

/** A machine whose project reported Sprint 1 with its two experiments; `completed` approves it as the epic's last. */
async function reported(options: { completed?: boolean; choose?: boolean } = {}): Promise<Reported> {
  const m = twoRepoMachine()
  machines.push(m)
  const s = await sprint1(m)
  const r = await report1(m, s, { final: options.completed === true })
  if (options.completed === true) await complete(m.project, s.ledger.runId, r.report.id)
  await m.dm.desktop.initializeRepository({ name: 'DarkMechanicus', keyPrefix: 'DM' })
  if (options.choose !== false) m.chooseCheckout()
  return { m, s, r }
}

const codeOf = (result: CommandResult<unknown>): string => (result.ok ? 'ok' : result.error.code)

/** The epics a project holds, by title. */
async function epicTitles(m: TwoRepoMachine, path: string): Promise<string[]> {
  return (await m.openAt(path, 'reader').listEpics()).map((epic) => epic.title).sort()
}

/** What a source epic shows of itself: status, revisions, its run and checkpoint, and its sealed Sprint 1 scorecard. */
async function sourceFacts({ m, s, r }: Reported): Promise<string> {
  const p = m.project.desktop
  const epic = await p.getEpic({ epicId: s.epicId })
  const run = await p.getRun({ runId: s.ledger.runId })
  const card = await p.getReportScorecard({ reportId: r.report.id })
  const saved = await p.getPlan({ epicId: s.epicId, view: 'saved' })
  return JSON.stringify({ epic: [epic.status, epic.revision, epic.currentRevisionId, epic.outcome], run: [run?.state, run?.activeSprintId], card, saved: saved.revisionId })
}

describe('no corrective work is executed or approved on the person\'s behalf (c3)', () => {
  it('leaves the same-repository draft unsaved and the cross-repository epic unsaved and unrun, with the source unchanged', async () => {
    const w = await reported()
    const { m, s, r } = w
    const before = await sourceFacts(w)
    const created = await m.project.orchestrator.createCorrections({ reportId: r.report.id, experimentIds: [r.xp.local.id] })
    expect(created).toMatchObject({ changed: true, validation: { errors: [] }, target: { kind: 'new_sprint', epicId: s.epicId } })
    // The draft holds the work; the saved plan, the run and the waiting checkpoint are as they were.
    expect(await sourceFacts(w)).toBe(before)
    expect((await m.project.desktop.getCheckpoint({ runId: s.ledger.runId })).approval).toBeNull()
    const crossed = data(await m.broker.createCrossRepoCorrection(m.project.path, { reportId: r.report.id, experimentId: r.xp.dm.id, expectedTargetProjectId: m.dm.desktop.ctx().projectId }), 'create')
    expect(crossed).toMatchObject({ progress: 'linked', changed: true })
    const epicId = crossed.target?.epicId ?? fail('no target epic')
    const target = await m.dm.desktop.getEpic({ epicId })
    expect([target.status, target.currentRevisionId, await m.dm.desktop.getRun({ epicId })]).toEqual(['backlog', null, null])
    expect(crossed.nextSteps.join(' ')).toMatch(/Save/)
    expect(await sourceFacts(w)).toBe(before)
  })
})

describe('a completed source epic stays completed and unchanged (c3)', () => {
  it('puts same-repository work into a follow-up epic and cross-repository work into the checkout, reopening nothing', async () => {
    const w = await reported({ completed: true })
    const { m, s, r } = w
    expect((await m.project.desktop.getEpic({ epicId: s.epicId })).status).toBe('completed')
    const before = await sourceFacts(w)
    const created = await m.project.orchestrator.createCorrections({ reportId: r.report.id, experimentIds: [r.xp.local.id] })
    expect(created.target).toMatchObject({ kind: 'follow_up_epic' })
    const followUp = await m.project.desktop.getEpic({ epicId: created.target.epicId ?? fail('no follow-up epic') })
    expect(followUp.provenance).toMatchObject({ sourceEpicId: s.epicId })
    const crossed = data(await m.broker.createCrossRepoCorrection(m.project.path, { reportId: r.report.id, experimentId: r.xp.dm.id, expectedTargetProjectId: m.dm.desktop.ctx().projectId }), 'create')
    expect(crossed.progress).toBe('linked')
    expect(await sourceFacts(w)).toBe(before)
    // A completed epic is read-only: its own plan cannot take the work.
    const refused = await m.bridge.command(m.project.path, 'createCorrections', { reportId: r.report.id, experimentIds: [r.xp.local.id], target: { kind: 'sprint', sprintId: s.sprintId } })
    expect(codeOf(refused)).toBe('completed_epic')
    expect(await sourceFacts(w)).toBe(before)
  })
})

describe('a missing target refuses the request and never redirects it (c3)', () => {
  it('refuses with no checkout chosen, keeps a request pending while the chosen one is gone, and writes to no other folder', async () => {
    const w = await reported({ choose: false })
    const { m, r } = w
    // Another folder that is also a Dark Mechanicus checkout, tracked and set up, but not the chosen one.
    const decoy = createGitRepo({ root: join(m.root, 'dm-decoy') })
    markerCheckout(decoy.root, { git: false, projectId: null })
    const decoyPath = m.registry.track(decoy.root).folder.path
    await m.openAt(decoyPath, 'desktop').initializeRepository({ name: 'DarkMechanicus decoy', keyPrefix: 'DD' })
    const input = { reportId: r.report.id, experimentId: r.xp.dm.id }
    const projectId = m.dm.desktop.ctx().projectId
    expect(codeOf(await m.broker.createCrossRepoCorrection(m.project.path, { ...input, expectedTargetProjectId: projectId }))).toBe('not_found')
    m.chooseCheckout()
    m.close()
    renameSync(m.dm.path, join(m.root, 'dm-away'))
    const pending = data(await m.broker.createCrossRepoCorrection(m.project.path, { ...input, expectedTargetProjectId: projectId }), 'create while away')
    expect(pending).toMatchObject({ progress: 'pending', target: null, failure: { step: 'target', retryable: true, error: { code: 'not_found' } } })
    expect(pending.link.lastError).toMatchObject({ step: 'target', code: 'not_found', problem: 'missing' })
    expect(await epicTitles(m, decoyPath)).toEqual([])
    m.close()
    renameSync(join(m.root, 'dm-away'), m.dm.path)
    const retried = data(await m.broker.retryCrossRepoCorrection(m.project.path, pending.link.key), 'retry')
    expect(retried).toMatchObject({ progress: 'linked', target: { created: true } })
    expect(await epicTitles(m, m.dm.path)).toHaveLength(1)
    expect(await epicTitles(m, decoyPath)).toEqual([])
  })
})

describe('a write that stops part way is finished without a duplicate (c3)', () => {
  it('reports target_created when the source link write fails, then the retry links the one epic and a repeat changes nothing', async () => {
    const { m, r } = await reported()
    const input = { reportId: r.report.id, experimentId: r.xp.dm.id, expectedTargetProjectId: m.dm.desktop.ctx().projectId }
    m.faults.link = 1
    const first = data(await m.broker.createCrossRepoCorrection(m.project.path, input), 'create')
    expect(first).toMatchObject({ progress: 'target_created', changed: true, failure: { step: 'link', retryable: true } })
    const epicId = first.target?.epicId ?? fail('no target epic')
    const retried = data(await m.broker.retryCrossRepoCorrection(m.project.path, first.link.key), 'retry')
    expect(retried).toMatchObject({ progress: 'linked', changed: true, failure: null, target: { epicId, created: false } })
    const repeated = data(await m.broker.createCrossRepoCorrection(m.project.path, input), 'repeat')
    expect(repeated).toMatchObject({ progress: 'linked', changed: false, target: { epicId, created: false } })
    expect((await m.dm.desktop.listEpics()).map((epic) => epic.id)).toEqual([epicId])
    expect(m.unexpected).toHaveLength(1)
  })
})

describe('the target runs the work under its own identity (c3)', () => {
  it('keeps the checkout\'s epic, plan and run in its own project, linked to the source only by the receipt', async () => {
    const { m, s, r } = await reported()
    const created = data(await m.broker.createCrossRepoCorrection(m.project.path, { reportId: r.report.id, experimentId: r.xp.dm.id, expectedTargetProjectId: m.dm.desktop.ctx().projectId }), 'create')
    const epicId = created.target?.epicId ?? fail('no target epic')
    const draft = await m.dm.desktop.getPlan({ epicId, view: 'draft' })
    const saved = await m.dm.desktop.savePlan({ epicId, expectedDraftRevision: draft.draftRevision ?? fail('no draft') })
    expect(saved.status).toBe('saved')
    m.dm.repo.branch('epic/retry-review-notes')
    const run = await m.dm.orchestrator.startRun({ epicId })
    const [source, target] = [m.project.desktop.ctx().projectId, m.dm.desktop.ctx().projectId]
    expect(source).not.toBe(target)
    expect(created.link).toMatchObject({ targetProjectId: target, sourceEpicId: s.epicId, state: 'linked' })
    expect([run.id === s.ledger.runId, run.epicId]).toEqual([false, epicId])
    expect((await m.project.desktop.listEpics()).map((epic) => epic.id)).not.toContain(epicId)
    expect((await m.dm.desktop.getEpic({ epicId })).provenance).toMatchObject({ kind: 'cross_repo_correction', source: { projectId: source, epicId: s.epicId } })
  })
})
