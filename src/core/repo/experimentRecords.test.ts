import { describe, expect, it } from 'vitest'
import { canonicalJson, contentHash, prettyJson } from '../canonical'
import { getExperiment, recordExperimentEvent } from '../services/experiments'
import { getSprintReport } from '../services/reports'
import type { ExperimentEvent, RetroExperiment } from '../../shared/domain/experiments'
import { delivered, portable, reported, submit, validExperiment, type World } from '../../test/experimentWorld'
import { copyTracked, createRepoEnv, createStubGit, dumpDomain, flush, importerDeps, type RepoEnv } from '../../test/repoEnv'
import { createTestCtx } from '../../test/testContext'
import { reconcileRepository } from './importer'
import { ownedPaths } from './paths'
import { buildRunHistoryRecord } from './portable'

interface RunJson {
  epicId: string
  experimentEvents?: ExperimentEvent[]
  reports: { id: string; reportRevision: number; contentHash: string; scorecard?: unknown; content: Record<string, unknown> & { summary: string; retro?: { experiments?: RetroExperiment[] } | null } }[]
}

const runFile = (env: RepoEnv, runId: string): string => ownedPaths(env.layout).runHistoryFile(runId)
const readRun = (env: RepoEnv, runId: string): RunJson => JSON.parse(env.fs.get(runFile(env, runId)) ?? '{}') as RunJson
const reconcile = (env: RepoEnv) => reconcileRepository(importerDeps(env, createStubGit()))

/** A fresh machine holding a copy of `from`'s tracked records. */
function cloneOf(from: World): RepoEnv {
  flush(from.env)
  const env = createRepoEnv()
  copyTracked(from.env, env)
  return env
}

/** Writes an edited run history onto `env` and reconciles it. */
function importEdited(env: RepoEnv, runId: string, edit: (run: RunJson) => void) {
  const run = readRun(env, runId)
  edit(run)
  env.fs.put(runFile(env, runId), prettyJson(run))
  return reconcile(env)
}

/** A run whose report carries an experiment and two later events, exported. */
function exportedExperiment() {
  const w = delivered({ acceptanceNode: false })
  portable(w)
  const report = submit(w, { summary: 'Sprint 1 with one experiment.', retro: { actions: ['Keep reviews short'], experiments: [validExperiment(w)] } })
  const experiment = report.report.retro?.experiments?.[0] as RetroExperiment
  recordExperimentEvent(w.orchestrator, { experimentId: experiment.id, event: { kind: 'status', status: 'selected', note: 'Chosen at the checkpoint' } })
  recordExperimentEvent(w.orchestrator, { experimentId: experiment.id, event: { kind: 'result', result: { value: 3_300_000, unit: 'milliseconds', evidence: [{ kind: 'run', id: w.runId }] } } })
  flush(w.env)
  return { w, report, experiment }
}

describe('DM-184 c3: export and import keep experiment provenance and nothing machine-local', () => {
  it('exports the experiment exactly as stored with its frozen source, and its events beside the reports', () => {
    const { w, report, experiment } = exportedExperiment()
    const run = readRun(w.env, w.runId)
    expect(canonicalJson(run.reports.find((item) => item.id === report.id)?.content.retro?.experiments?.[0])).toBe(canonicalJson(experiment))
    expect(run.experimentEvents?.map((event) => [event.experimentId, event.number, event.source.reportId])).toEqual([
      [experiment.id, 1, report.id],
      [experiment.id, 2, report.id]
    ])
    expect(JSON.stringify(run.reports)).not.toContain('experimentHash')
  })

  it('writes no machine path, session or credential into any tracked file, and no machine id into an experiment or event', () => {
    const { w } = exportedExperiment()
    const tracked = [...cloneOf(w).fs.files()]
    expect(tracked.map(([path]) => path).filter((path) => path.endsWith('run.json'))).toHaveLength(1)
    const text = tracked.map(([, content]) => content).join('\n')
    // The root as written and as it would appear escaped inside JSON text.
    for (const needle of [w.env.root, JSON.stringify(w.env.root).slice(1, -1), w.ctx.projectRoot, w.ctx.session.id, w.orchestrator.session.id, 'claimToken', 'password']) {
      expect(text).not.toContain(needle)
    }
    const run = readRun(w.env, w.runId)
    const experimentText = JSON.stringify({ experiments: run.reports.map((report) => report.content.retro?.experiments ?? []), events: run.experimentEvents })
    expect(experimentText).not.toContain(w.ctx.machineId)
  })

  it('imports on another machine with the same experiment, events, report content, hash and scorecard, re-exports the same file and adds nothing again', () => {
    const { w, report, experiment } = exportedExperiment()
    // Content as canonical JSON: B stores it as written in the file (sorted keys), A in the order it was built.
    const row = (env: { db: RepoEnv['db'] }) => {
      const stored = env.db.get<{ content_json: string; content_hash: string; scorecard_json: string }>('SELECT content_json, content_hash, scorecard_json FROM sprint_reports WHERE id = ?', report.id)
      return stored === undefined ? undefined : { ...stored, content_json: canonicalJson(JSON.parse(stored.content_json)) }
    }
    const machineB = cloneOf(w)
    const imported = reconcile(machineB)
    expect(imported.rejected).toEqual([])
    expect(imported.imported).toContain(w.runId)
    expect(getExperiment(createTestCtx({ db: machineB.db, clock: machineB.clock }), { experimentId: experiment.id })).toEqual(getExperiment(w.ctx, { experimentId: experiment.id }))
    expect(row(machineB)).toEqual(row(w.env))
    expect(prettyJson(buildRunHistoryRecord(machineB.db, w.runId))).toBe(w.env.fs.get(runFile(w.env, w.runId)))
    expect(reconcile(machineB).rejected).toEqual([])
    expect(machineB.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM experiment_events')?.n).toBe(2)
  })
})

/**
 * Machine B holds a run whose second report revision carries an experiment drawn from the first revision's sealed
 * scorecard. The incoming history adds a third revision restating it with no scorecard of its own, its content hash
 * recomputed, so only the provenance check can tell an edit.
 */
function forged(edit: (experiment: RetroExperiment) => void) {
  const w = reported()
  portable(w)
  const valid = validExperiment(w)
  const second = submit(w, { summary: 'From the earlier scorecard.', retro: { experiments: [{ ...valid, source: { reportId: w.first.id, assessmentId: w.snapshot.sprint.assessmentId } }] } })
  const machineB = cloneOf(w)
  expect(reconcile(machineB).rejected).toEqual([])
  const before = dumpDomain(machineB.db)
  const third = 'rp_zzzzzzzzzzzzzzzzzzzzzzzzz3'
  const result = importEdited(machineB, w.runId, (run) => {
    const source = run.reports.find((item) => item.id === second.id)
    if (source === undefined) throw new Error('the second revision was not exported')
    const { scorecard: _scorecard, ...copy } = structuredClone(source)
    edit(copy.content.retro?.experiments?.[0] as RetroExperiment)
    run.reports.push({ ...copy, id: third, reportRevision: 3, contentHash: contentHash(copy.content) })
  })
  return { w, machineB, before, result, third, experiment: second.report.retro?.experiments?.[0] as RetroExperiment }
}

describe('DM-184 c3: edited experiment provenance is refused on import', () => {
  it('imports such a revision when its experiment still follows from the scorecard it cites (control)', () => {
    const { w, result, machineB, third } = forged(() => undefined)
    expect(result.rejected).toEqual([])
    expect(result.imported).toContain(w.runId)
    expect(machineB.db.get<{ id: string }>('SELECT id FROM sprint_reports WHERE id = ?', third)?.id).toBe(third)
  })

  it.each([
    ['an edited baseline value', (experiment: RetroExperiment) => void (experiment.baseline.value = 1_000), 'states a baseline T.actual_ms the assessment'],
    ['an edited baseline state', (experiment: RetroExperiment) => void (experiment.baseline.state = 'estimated'), 'states a baseline T.actual_ms the assessment'],
    ['another grade’s input hash', (experiment: RetroExperiment) => void (experiment.source.inputHash = `sha256:${'2'.repeat(64)}`), 'does not match the frozen assessment'],
    ['an edited snapshot seal', (experiment: RetroExperiment) => void (experiment.source.revision === 'earlier' && (experiment.source.snapshotHash = `sha256:${'1'.repeat(64)}`)), 'does not match the frozen assessment'],
    ['another epic', (experiment: RetroExperiment) => void (experiment.source.epicId = 'ep_01m452vt115eqccd1ypdd596fy'), 'cites epic ep_01m452vt115eqccd1ypdd596fy']
  ])('refuses %s, keeping everything this machine holds', (_label, edit, message) => {
    const { w, machineB, before, result, third, experiment } = forged(edit)
    expect(result.imported).not.toContain(w.runId)
    expect(result.rejected.map((entry) => entry.message).join(' | ')).toContain(`Experiment ${experiment.id} of report ${third} ${message}`)
    expect(dumpDomain(machineB.db)).toEqual(before)
  })
})

describe('DM-184 c3: an edited report is refused on import', () => {
  it('refuses a report whose content no longer hashes to its content hash, on a fresh machine', () => {
    const { w } = exportedExperiment()
    const result = importEdited(cloneOf(w), w.runId, (run) => {
      const target = run.reports[0]
      if (target !== undefined) target.content.summary = 'Rewritten after approval'
    })
    expect(result.imported).not.toContain(w.runId)
    expect(result.rejected.map((entry) => entry.message).join(' | ')).toContain('whose content does not hash to its contentHash')
  })

  it('refuses changed content for a report this machine holds, even re-hashed, and keeps its own', () => {
    const { w, report } = exportedExperiment()
    const machineB = cloneOf(w)
    reconcile(machineB)
    const before = dumpDomain(machineB.db)
    // Without a scorecard of its own (as an earlier build wrote it), only the stored copy can tell the edit.
    const result = importEdited(machineB, w.runId, (run) => {
      const target = run.reports.find((item) => item.id === report.id)
      if (target === undefined) return
      delete target.scorecard
      target.content.summary = 'Rewritten after approval'
      target.contentHash = contentHash(target.content)
    })
    expect(result.rejected.map((entry) => entry.message).join(' | ')).toContain(`Report ${report.id} differs from the revision stored here (content hash ${report.contentHash})`)
    expect(dumpDomain(machineB.db)).toEqual(before)
  })
})

describe('DM-184 c2: prose-only run history keeps its bytes', () => {
  it('writes no experiments or experimentEvents key, and another machine imports and re-exports identical bytes', () => {
    const w = delivered()
    portable(w)
    submit(w, { summary: 'Sprint 1 is over.', retro: { actions: ['Keep reviews short'] } })
    const machineB = cloneOf(w)
    const text = w.env.fs.get(runFile(w.env, w.runId)) ?? ''
    expect(text).not.toContain('"experiments"')
    expect(text).not.toContain('"experimentEvents"')
    expect(reconcile(machineB).rejected).toEqual([])
    expect(prettyJson(buildRunHistoryRecord(machineB.db, w.runId))).toBe(text)
  })

  it('refuses a hand-written empty experiments list', () => {
    const w = delivered()
    portable(w)
    submit(w, { summary: 'Sprint 1 is over.', retro: { actions: ['Keep reviews short'] } })
    const result = importEdited(cloneOf(w), w.runId, (run) => {
      const retro = run.reports[0]?.content.retro
      if (retro !== undefined && retro !== null) retro.experiments = []
    })
    expect(result.imported).not.toContain(w.runId)
    expect(result.rejected.map((entry) => entry.message).join(' | ')).toContain('reports.0.content.retro.experiments: Too small: expected array to have >=1 items')
  })
})

type ReportContent = RunJson['reports'][number]['content']

/**
 * Machine A's file rewritten as an earlier build wrote it (`write` reshapes the report's content; no scorecard, hashed
 * over that content), imported on B, re-exported by B and imported on C.
 */
function travel(report: Record<string, unknown>, write: (content: ReportContent) => ReportContent) {
  const w = delivered()
  portable(w)
  const view = submit(w, report)
  flush(w.env)
  const run = readRun(w.env, w.runId)
  const target = run.reports.find((item) => item.id === view.id)
  if (target === undefined) throw new Error('the report was not exported')
  delete target.scorecard
  target.content = write(target.content)
  target.contentHash = contentHash(target.content)
  w.env.fs.put(runFile(w.env, w.runId), prettyJson(run))

  const machineB = createRepoEnv()
  copyTracked(w.env, machineB)
  const onB = reconcile(machineB)
  const exported = buildRunHistoryRecord(machineB.db, w.runId)
  const machineC = createRepoEnv()
  copyTracked(machineB, machineC)
  machineC.fs.put(runFile(machineC, w.runId), prettyJson(exported))
  const onC = reconcile(machineC)
  return { w, written: target, onB, machineB, reexported: exported.reports.find((item) => item.id === view.id), onC, machineC }
}

describe('DM-184 c3: a report written by an earlier build travels A to B to C', () => {
  it('re-exports a report written without followUps exactly as written, so a third machine imports it', () => {
    const { w, written, onB, machineB, reexported, onC, machineC } = travel({ summary: 'Sprint 1 is over.', retro: { actions: ['Keep reviews short'] } }, (content) => {
      const { followUps: _followUps, ...rest } = content
      return rest as ReportContent
    })
    expect(onB.rejected).toEqual([])
    expect(reexported?.content).toEqual(written.content)
    expect(reexported?.contentHash).toBe(written.contentHash)
    expect(onC.rejected).toEqual([])
    expect(onC.imported).toContain(w.runId)
    expect(machineC.db.get<{ content_hash: string }>('SELECT content_hash FROM sprint_reports WHERE id = ?', written.id)?.content_hash).toBe(written.contentHash)
    expect(getSprintReport(createTestCtx({ db: machineB.db, clock: machineB.clock }), { runId: w.runId })?.report.followUps).toEqual([])
  })

  it('keeps a nested default the writer left out (a follow-up without its body), and readers still see it filled', () => {
    const { w, written, onB, machineB, reexported, onC } = travel({ summary: 'Sprint 1 is over.', followUps: [{ title: 'Index the scorecard', body: '' }] }, (content) => ({
      ...content,
      followUps: [{ title: 'Index the scorecard' }]
    }) as ReportContent)
    expect(onB.rejected).toEqual([])
    expect(reexported?.content).toEqual(written.content)
    expect(onC.rejected).toEqual([])
    expect(onC.imported).toContain(w.runId)
    const onBView = getSprintReport(createTestCtx({ db: machineB.db, clock: machineB.clock }), { runId: w.runId })
    expect(onBView?.report.followUps).toEqual([{ title: 'Index the scorecard', body: '' }])
    expect(onBView?.report.risks).toEqual([])
  })
})
