import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeBundle, sid, tid } from '../../test/bundles'
import { domainErrorOf, idOf, insertAttempt, insertCheckpoint, insertComment, insertOutbox, insertReport, insertRowCheck, insertRun, T0 } from '../../test/repoFixtures'
import {
  copyTracked,
  createRepoEnv,
  createStubGit,
  dumpDomain,
  flush,
  importerDeps,
  initProject,
  type RepoEnv,
  saveRevision
} from '../../test/repoEnv'
import { isWithin } from '../../test/memoryFs'
import { createSaveHook } from '../../test/repoFixtures'
import { createTempRepo, type TempRepo } from '../../test/tempRepo'
import { createSequentialIds, createTestClock, createTestCtx, createTestDb, type TestCtx, withRole } from '../../test/testContext'
import { contentHash, prettyJson } from '../canonical'
import { getMeta, setMeta } from '../meta'
import { resolveEpicConflict, type EpicRecordsAccess } from '../services/epicConflict'
import { cancelTransfer, queueTransfer, startTransfer } from '../services/transfers'
import { createFileHashCache } from './fileHashes'
import { flushOutbox } from './finalizer'
import { branchState, type ImporterDeps, reconcileRepository } from './importer'
import { initializeRepository } from './initialize'
import { resolveLayout } from './layout'
import { nodeFs } from './nodeFs'
import { ownedPaths } from './paths'
import { getStorageStatus } from './storage'
import { buildEpicStateRecord, epicStateRecord, parseRecord, trackedCommentHash, trackedEpicHash, trackedRunHash } from './portable'

const EPIC = idOf('epic', 1)
const R1 = idOf('revision', 1)
const R2 = idOf('revision', 2)
const R3 = idOf('revision', 3)
const RUN = idOf('run', 1)
const R9 = idOf('revision', 9)
const A1 = idOf('attempt', 1)
const A2 = idOf('attempt', 2)
const REPORT = idOf('report', 1)
const SOURCE_MACHINE = idOf('machine', 1)
const BUNDLE_1 = makeBundle([[1, 2]], [[1, 2]])
const BUNDLE_2 = makeBundle([[1, 2, 3]], [[1, 2]])
const BUNDLE_3 = makeBundle([[1, 2, 3, 4]], [[1, 2]])
const BRANCH = { repository: null, name: 'epic/demo', startCommit: 'abcdef1' }

/** The retro of the seeded report, as stored: tickets by id. None of its words appear in the other searched documents. */
const RETRO = {
  delivered: [{ ticket: tid(1), demo: 'Open the retrospective board', evidence: 'Screenshots of the board' }],
  wentWell: ['Pairing helped'],
  wentPoorly: ['Slow reviews'],
  actions: ['Review within a day'],
  discoveries: [{ title: 'Cache the catalog', body: 'Reloaded on every claim', ticket: tid(2) }],
  leftovers: [{ ticket: tid(3), reason: 'Waiting on a certificate' }],
  tierFit: [{ ticket: tid(1), verdict: 'oversized', note: 'A small model would do' }]
}

function seedRunHistory(source: RepoEnv): void {
  insertRun(source.db, { id: RUN, epicId: EPIC, revisionId: R2, ownerMachineId: SOURCE_MACHINE, activeSprintId: sid(1), autoContinue: true })
  insertAttempt(source.db, {
    id: A1,
    runId: RUN,
    ticketId: tid(1),
    revisionId: R2,
    outputs: { summary: 'Schema tables created' },
    decision: { outcome: 'accepted', notes: 'Verified by reviewer', reasons: [], decidedBy: 'desktop' }
  })
  insertAttempt(source.db, { id: A2, runId: RUN, ticketId: tid(2), revisionId: R2, state: 'running', claimSecret: 'secret', leaseExpiresAt: T0 })
  insertReport(source.db, { id: REPORT, runId: RUN, sprintId: sid(1), content: { summary: 'Sprint went well', risks: ['Flaky pipeline'], retro: RETRO } })
  insertCheckpoint(source.db, { id: idOf('checkpoint', 1), runId: RUN, sprintId: sid(1), reportId: REPORT })
  insertOutbox(source.db, { kind: 'run_history', epicId: EPIC, runId: RUN })
}

/** A repository with an epic saved twice, a status change, and a run with history, fully flushed. */
function buildSource(): RepoEnv {
  const source = createRepoEnv({ root: '/source' })
  initProject(source)
  saveRevision(source, { epicId: EPIC, revisionId: R1, number: 1, bundle: BUNDLE_1 })
  saveRevision(source, { epicId: EPIC, revisionId: R2, number: 2, bundle: BUNDLE_2, baseRevisionId: R1 })
  source.db.run("UPDATE ticket_status SET status = 'completed' WHERE ticket_id = ?", tid(1))
  source.db.run("UPDATE epics SET status = 'in_progress', branch_json = ? WHERE id = ?", JSON.stringify(BRANCH), EPIC)
  insertOutbox(source.db, { kind: 'epic_state', epicId: EPIC })
  seedRunHistory(source)
  flush(source)
  return source
}

function cloneOf(source: RepoEnv): RepoEnv {
  const target = createRepoEnv({ root: '/clone' })
  copyTracked(source, target)
  return target
}

describe('reconcileRepository reconstruction', () => {
  it('rebuilds epics, revisions, statuses, and run history from tracked records', () => {
    const target = cloneOf(buildSource())
    const result = reconcileRepository(importerDeps(target, createStubGit('main')))
    expect(result).toEqual({ imported: [EPIC, RUN], unchanged: [], conflicts: [], profileConflicts: [], kanbanConflicts: [], rejected: [], branchChanged: false, pausedRuns: [] })
    expect(target.db.all('SELECT id, title, status, current_revision_id, provenance_json, outcome_json FROM epics')).toEqual([
      { id: EPIC, title: 'Test epic', status: 'in_progress', current_revision_id: R2, provenance_json: null, outcome_json: null }
    ])
    expect(JSON.parse(target.db.get<{ branch_json: string }>('SELECT branch_json FROM epics')?.branch_json ?? 'null')).toEqual(BRANCH)
    expect(target.db.all('SELECT id, number, state, content_hash, base_revision_id FROM plan_revisions ORDER BY number')).toEqual([
      { id: R1, number: 1, state: 'saved', content_hash: contentHash(BUNDLE_1), base_revision_id: null },
      { id: R2, number: 2, state: 'saved', content_hash: contentHash(BUNDLE_2), base_revision_id: R1 }
    ])
    const bundle = target.db.get<{ bundle_json: string }>('SELECT bundle_json FROM plan_revisions WHERE id = ?', R2)
    expect(JSON.parse(bundle?.bundle_json ?? '{}')).toEqual(BUNDLE_2)
    expect(target.db.all('SELECT ticket_id, status FROM ticket_status ORDER BY ticket_id')).toEqual([
      { ticket_id: tid(1), status: 'completed' },
      { ticket_id: tid(2), status: 'backlog' },
      { ticket_id: tid(3), status: 'backlog' }
    ])
  })

  it('imports run history without local authority and keeps the owning machine', () => {
    const target = cloneOf(buildSource())
    reconcileRepository(importerDeps(target, createStubGit('main')))
    expect(target.db.get('SELECT state, owner_machine_id, auto_continue, orchestrator_session_id FROM runs WHERE id = ?', RUN)).toEqual({
      state: 'running',
      owner_machine_id: SOURCE_MACHINE,
      auto_continue: 0,
      orchestrator_session_id: null
    })
    expect(target.db.all('SELECT id, state, claim_secret, lease_expires_at, heartbeat_at FROM attempts ORDER BY id')).toEqual([
      { id: A1, state: 'accepted', claim_secret: null, lease_expires_at: null, heartbeat_at: null },
      { id: A2, state: 'lease_expired', claim_secret: null, lease_expires_at: null, heartbeat_at: null }
    ])
    expect(target.db.all('SELECT id, outputs_json, failure_json FROM attempts ORDER BY id')).toEqual([
      { id: A1, outputs_json: expect.stringContaining('Schema tables created'), failure_json: null },
      { id: A2, outputs_json: null, failure_json: null }
    ])
    expect(target.db.get('SELECT host_json FROM runs WHERE id = ?', RUN)).toEqual({ host_json: null })
    expect(target.db.all('SELECT id, sprint_id FROM sprint_reports')).toEqual([{ id: REPORT, sprint_id: sid(1) }])
    expect(target.db.all('SELECT report_id, approval_id FROM checkpoints')).toEqual([{ report_id: REPORT, approval_id: null }])
  })

})

describe('reconcileRepository and outcome.transfer', () => {
  it('imports an epic a Linear transfer completed with its outcome.transfer, and exports it back byte for byte', () => {
    const source = createRepoEnv({ root: '/source' })
    initProject(source)
    saveRevision(source, { epicId: EPIC, revisionId: R1, number: 1, bundle: BUNDLE_1 })
    const outcome = {
      summary: 'Transferred to Linear: https://linear.app/acme/project/demo-1a2b',
      successCriteria: [],
      recordedAt: T0,
      runId: null,
      transfer: {
        target: 'linear',
        projectUrl: 'https://linear.app/acme/project/demo-1a2b',
        revisionId: R1,
        packetHash: contentHash({ packet: 'demo' }),
        items: [
          { key: 'DM-1', identifier: 'ENG-1', url: 'https://linear.app/acme/issue/ENG-1' },
          { key: 'DM-2', identifier: 'ENG-2', url: null }
        ]
      }
    }
    source.db.run("UPDATE epics SET status = 'completed', completed_at = ?, outcome_json = ? WHERE id = ?", T0, JSON.stringify(outcome), EPIC)
    insertOutbox(source.db, { kind: 'epic_state', epicId: EPIC })
    flush(source)
    const exported = source.fs.get(ownedPaths(source.layout).epicStateFile(EPIC)) ?? ''
    const state = JSON.parse(exported) as { outcome: unknown; generation: number; updatedAt: string }
    expect(state.outcome).toEqual(outcome)

    const target = cloneOf(source)
    expect(reconcileRepository(importerDeps(target, createStubGit('main')))).toMatchObject({ imported: [EPIC], rejected: [] })
    const row = target.db.get<{ status: string; outcome_json: string }>('SELECT status, outcome_json FROM epics WHERE id = ?', EPIC)
    expect(row?.status).toBe('completed')
    expect(JSON.parse(row?.outcome_json ?? 'null')).toEqual(outcome)
    expect(prettyJson(buildEpicStateRecord(target.db, EPIC, { generation: state.generation, updatedAt: state.updatedAt }))).toBe(exported)
  })
})

describe('reconcileRepository and a folder epic with repository branches and provenance', () => {
  it("imports each repository's bound branch and the provenance, and exports them back byte for byte", () => {
    const source = createRepoEnv({ root: '/source' })
    initProject(source)
    saveRevision(source, { epicId: EPIC, revisionId: R1, number: 1, bundle: BUNDLE_1 })
    const branch = { repository: null, name: 'epic/multi', startCommit: null }
    const repositoryBranches = [
      { repository: 'api', name: 'epic/multi', startCommit: 'a'.repeat(40) },
      { repository: 'web', name: 'epic/multi', startCommit: null }
    ]
    const provenance = { sourceEpicId: idOf('epic', 7), note: 'Split from the platform epic' }
    source.db.run(
      'UPDATE epics SET branch_json = ?, repository_branches_json = ?, provenance_json = ? WHERE id = ?',
      JSON.stringify(branch),
      JSON.stringify(repositoryBranches),
      JSON.stringify(provenance),
      EPIC
    )
    insertOutbox(source.db, { kind: 'epic_state', epicId: EPIC })
    flush(source)
    const exported = source.fs.get(ownedPaths(source.layout).epicStateFile(EPIC)) ?? ''
    const state = JSON.parse(exported) as { repositoryBranches: unknown; generation: number; updatedAt: string }
    expect(state.repositoryBranches).toEqual(repositoryBranches)

    const target = cloneOf(source)
    expect(reconcileRepository(importerDeps(target, createStubGit('main')))).toMatchObject({ imported: [EPIC], rejected: [] })
    const row = target.db.get<{ branch_json: string; repository_branches_json: string; provenance_json: string }>(
      'SELECT branch_json, repository_branches_json, provenance_json FROM epics WHERE id = ?',
      EPIC
    )
    expect(JSON.parse(row?.branch_json ?? 'null')).toEqual(branch)
    expect(JSON.parse(row?.repository_branches_json ?? 'null')).toEqual(repositoryBranches)
    expect(JSON.parse(row?.provenance_json ?? 'null')).toEqual(provenance)
    expect(prettyJson(buildEpicStateRecord(target.db, EPIC, { generation: state.generation, updatedAt: state.updatedAt }))).toBe(exported)
  })
})

describe('reconcileRepository bookkeeping', () => {
  it('records sync hashes, project identity, the branch, and a reconciled event', () => {
    const source = buildSource()
    const target = cloneOf(source)
    reconcileRepository(importerDeps(target, createStubGit('main')))
    const paths = ownedPaths(target.layout)
    const epicHash = trackedEpicHash(target.fs.get(paths.epicPointerFile(EPIC)) ?? '', target.fs.get(paths.epicStateFile(EPIC)) ?? '')
    const runHash = trackedRunHash(target.fs.get(paths.runHistoryFile(RUN)) ?? '')
    expect(target.db.all('SELECT kind, entity_id, exported_hash, imported_hash, conflict FROM sync_state ORDER BY kind')).toEqual([
      { kind: 'epic', entity_id: EPIC, exported_hash: epicHash, imported_hash: epicHash, conflict: null },
      { kind: 'run', entity_id: RUN, exported_hash: runHash, imported_hash: runHash, conflict: null }
    ])
    expect(target.db.get('SELECT generation FROM sync_state WHERE kind = ?', 'epic')).toEqual({ generation: 3 })
    expect([getMeta(target.db, 'project_name'), getMeta(target.db, 'key_prefix'), getMeta(target.db, 'checkout_branch')]).toEqual(['Demo', 'DEM', 'main'])
    expect(getMeta(target.db, 'project_id')).toMatch(/^pj_/)
    expect(getMeta(target.db, 'last_reconcile_at')).toBe(T0)
    const events = target.db.all<{ kind: string; session_id: string }>('SELECT kind, session_id FROM events')
    expect(events).toEqual([{ kind: 'repository.reconciled', session_id: 'ss_0000000000000000000000desk' }])
  })

  it('indexes tickets, attempts, and reports for search', () => {
    const target = cloneOf(buildSource())
    reconcileRepository(importerDeps(target, createStubGit('main')))
    const find = (query: string): string[] =>
      target.db.all<{ doc_id: string }>('SELECT doc_id FROM search_index WHERE search_index MATCH ? ORDER BY doc_id', query).map((row) => row.doc_id)
    expect(find('schema')).toEqual([A1])
    expect(find('flaky')).toEqual([REPORT])
    expect(find('ticket')).toEqual([tid(1), tid(2), tid(3)])
    expect(find('prove')).toEqual([EPIC])
    expect(target.db.get('SELECT title FROM search_index WHERE doc_id = ?', tid(1))).toEqual({ title: 'DM-1 Ticket 1' })
    expect(target.db.get('SELECT title FROM search_index WHERE doc_id = ?', A1)).toEqual({ title: 'DM-1 attempt 1' })
  })

  it('indexes the retro text of a report, with the ticket keys', () => {
    const target = cloneOf(buildSource())
    reconcileRepository(importerDeps(target, createStubGit('main')))
    const find = (query: string): string[] =>
      target.db.all<{ doc_id: string }>('SELECT doc_id FROM search_index WHERE search_index MATCH ? ORDER BY doc_id', query).map((row) => row.doc_id)
    for (const word of ['retrospective', 'screenshots', 'pairing', 'slow', 'catalog', 'certificate', 'oversized']) {
      expect(find(word)).toEqual([REPORT])
    }
    const body = target.db.get<{ body: string }>('SELECT body FROM search_index WHERE doc_id = ?', REPORT)?.body ?? ''
    expect(body).toContain('DM-1')
    expect(body).toContain('DM-3')
    expect(body).not.toContain(tid(1))
    expect(target.db.get('SELECT content_json FROM sprint_reports WHERE id = ?', REPORT)).toMatchObject({ content_json: expect.stringContaining(tid(2)) })
  })
})

describe('reconcileRepository change detection', () => {
  it('treats an unchanged re-import as a quiet no-op', () => {
    const target = cloneOf(buildSource())
    const deps = importerDeps(target, createStubGit('main'))
    reconcileRepository(deps)
    const before = dumpDomain(target.db)
    const events = target.db.all('SELECT seq FROM events').length
    expect(reconcileRepository(deps)).toEqual({ imported: [], unchanged: [EPIC, RUN], conflicts: [], profileConflicts: [], kanbanConflicts: [], rejected: [], branchChanged: false, pausedRuns: [] })
    expect(dumpDomain(target.db)).toEqual(before)
    expect(target.db.all('SELECT seq FROM events')).toHaveLength(events)
  })

  it('sees its own exports as unchanged', () => {
    const source = buildSource()
    const result = reconcileRepository(importerDeps(source, createStubGit('main')))
    expect(result.unchanged).toEqual([EPIC, RUN])
    expect(result.imported).toEqual([])
  })

  it('imports a newer saved revision pulled from another machine', () => {
    const source = buildSource()
    const target = cloneOf(source)
    const deps = importerDeps(target, createStubGit('main'))
    reconcileRepository(deps)
    saveRevision(source, { epicId: EPIC, revisionId: R3, number: 3, bundle: BUNDLE_3, baseRevisionId: R2 })
    copyTracked(source, target)
    expect(reconcileRepository(deps).imported).toEqual([EPIC])
    expect(target.db.get('SELECT current_revision_id, revision FROM epics WHERE id = ?', EPIC)).toEqual({ current_revision_id: R3, revision: 2 })
    expect(target.db.get('SELECT status FROM ticket_status WHERE ticket_id = ?', tid(4))).toEqual({ status: 'backlog' })
  })
})

describe('reconcileRepository run updates', () => {
  it('imports changed run history while its epic is unchanged', () => {
    const source = buildSource()
    const target = cloneOf(source)
    const deps = importerDeps(target, createStubGit('main'))
    reconcileRepository(deps)
    source.db.run("UPDATE runs SET state = 'completed', ended_at = ? WHERE id = ?", T0, RUN)
    insertOutbox(source.db, { kind: 'run_history', runId: RUN })
    flush(source)
    copyTracked(source, target)
    const result = reconcileRepository(deps)
    expect(result).toMatchObject({ imported: [RUN], unchanged: [EPIC], rejected: [], conflicts: [] })
    expect(target.db.get('SELECT state, ended_at, revision FROM runs WHERE id = ?', RUN)).toEqual({ state: 'completed', ended_at: T0, revision: 2 })
    const events = target.db.all<{ payload_json: string }>("SELECT payload_json FROM events WHERE kind = 'repository.reconciled' ORDER BY seq")
    expect(JSON.parse(events[1]?.payload_json ?? '{}')).toEqual({ imported: [RUN], unchanged: 1, conflicts: 0, rejected: 0, branchChanged: false, pausedRuns: [] })
  })
})

describe('reconcileRepository conflicts', () => {
  it('reports tracked changes to an epic with pending local exports and applies nothing', () => {
    const source = buildSource()
    const target = cloneOf(source)
    const deps = importerDeps(target, createStubGit('main'))
    reconcileRepository(deps)
    insertOutbox(target.db, { kind: 'epic_state', epicId: EPIC })
    saveRevision(source, { epicId: EPIC, revisionId: R3, number: 3, bundle: BUNDLE_3, baseRevisionId: R2 })
    copyTracked(source, target)
    const before = dumpDomain(target.db)
    const result = reconcileRepository(deps)
    expect(result.conflicts).toEqual([{ epicId: EPIC, message: expect.stringContaining('waiting to be exported') }])
    expect(result.imported).toEqual([])
    expect(dumpDomain(target.db)).toEqual(before)
    const conflict = target.db.get<{ conflict: string }>('SELECT conflict FROM sync_state WHERE kind = ? AND entity_id = ?', 'epic', EPIC)
    expect(conflict?.conflict).toContain(EPIC)

    target.db.run("UPDATE outbox SET state = 'done'")
    expect(reconcileRepository(deps).imported).toEqual([EPIC])
    expect(target.db.get('SELECT conflict FROM sync_state WHERE kind = ? AND entity_id = ?', 'epic', EPIC)).toEqual({ conflict: null })
  })

  it('treats a pending local revision as an unexported change', () => {
    const source = buildSource()
    const target = cloneOf(source)
    const deps = importerDeps(target, createStubGit('main'))
    reconcileRepository(deps)
    target.db.run('INSERT INTO plan_revisions SELECT ?, epic_id, 9, NULL, content_hash, bundle_json, ?, created_at, NULL, NULL FROM plan_revisions WHERE id = ?', idOf('revision', 9), 'pending', R1)
    saveRevision(source, { epicId: EPIC, revisionId: R3, number: 3, bundle: BUNDLE_3, baseRevisionId: R2 })
    copyTracked(source, target)
    expect(reconcileRepository(deps).conflicts.map((conflict) => conflict.epicId)).toEqual([EPIC])
  })

  it('reports a run conflict when its history changed while local run changes are pending', () => {
    const source = buildSource()
    const target = cloneOf(source)
    const deps = importerDeps(target, createStubGit('main'))
    reconcileRepository(deps)
    insertOutbox(target.db, { kind: 'run_history', runId: RUN })
    source.db.run("UPDATE runs SET state = 'completed' WHERE id = ?", RUN)
    insertOutbox(source.db, { kind: 'run_history', runId: RUN })
    flush(source)
    copyTracked(source, target)
    const result = reconcileRepository(deps)
    expect(result.conflicts).toEqual([{ epicId: EPIC, message: expect.stringContaining(RUN) }])
    expect(target.db.get('SELECT state FROM runs WHERE id = ?', RUN)).toEqual({ state: 'running' })
    expect(target.db.all("SELECT seq FROM events WHERE kind = 'repository.reconciled'")).toHaveLength(2)
  })
})

type OpenStatus = 'queued' | 'in_progress'

interface Transferring {
  source: RepoEnv
  target: RepoEnv
  deps: ImporterDeps
  ctx: TestCtx
}

/** A clone that imported R1 and R2 (no run), then authorized a transfer of R2 and, optionally, started it. */
function transferring(status: OpenStatus | null): Transferring {
  const source = createRepoEnv({ root: '/source' })
  initProject(source)
  saveRevision(source, { epicId: EPIC, revisionId: R1, number: 1, bundle: BUNDLE_1 })
  saveRevision(source, { epicId: EPIC, revisionId: R2, number: 2, bundle: BUNDLE_2, baseRevisionId: R1 })
  const target = cloneOf(source)
  const deps = importerDeps(target, createStubGit('main'))
  expect(reconcileRepository(deps).imported).toEqual([EPIC])
  const ctx = createTestCtx({ db: target.db, clock: target.clock, role: 'desktop' })
  if (status !== null) {
    queueTransfer(ctx, { epicId: EPIC })
  }
  if (status === 'in_progress') {
    startTransfer(withRole(ctx, 'orchestrator'), { epicId: EPIC })
  }
  return { source, target, deps, ctx }
}

/** Another machine saves R3 and pulls it in. */
function pullNewerRevision(env: Transferring): void {
  saveRevision(env.source, { epicId: EPIC, revisionId: R3, number: 3, bundle: BUNDLE_3, baseRevisionId: R2 })
  copyTracked(env.source, env.target)
}

/** Another machine starts a run on `revisionId` and pulls it in. */
function pullRun(env: Transferring, revisionId: string): void {
  insertRun(env.source.db, { id: RUN, epicId: EPIC, revisionId, ownerMachineId: SOURCE_MACHINE })
  insertOutbox(env.source.db, { kind: 'run_history', epicId: EPIC, runId: RUN })
  flush(env.source)
  copyTracked(env.source, env.target)
}

function transferRow(env: Transferring): unknown {
  return env.target.db.get('SELECT * FROM transfers WHERE epic_id = ?', EPIC)
}

function epicConflict(env: Transferring): unknown {
  return env.target.db.get('SELECT conflict FROM sync_state WHERE kind = ? AND entity_id = ?', 'epic', EPIC)
}

async function storageConflicts(env: Transferring): Promise<unknown> {
  const { db, layout, fs, clock } = env.target
  return (await getStorageStatus({ db, layout, fs, git: createStubGit('main'), clock })).conflicts
}

const STATUS_WORDS: Record<OpenStatus, string> = { queued: 'is queued', in_progress: 'is in progress' }

describe('reconcileRepository while a Linear transfer is open', () => {
  it.each<OpenStatus>(['queued', 'in_progress'])('reports a newer saved revision as a conflict while the transfer is %s, and applies nothing', async (status) => {
    const env = transferring(status)
    pullNewerRevision(env)
    const before = dumpDomain(env.target.db)
    const transfer = transferRow(env)
    const result = reconcileRepository(env.deps)
    const message = expect.stringMatching(new RegExp(`${EPIC}.*saved revision ${R3}.*revision ${R2} ${STATUS_WORDS[status]}`))
    expect(result).toMatchObject({ imported: [], conflicts: [{ epicId: EPIC, message }], rejected: [] })
    expect(dumpDomain(env.target.db)).toEqual(before)
    expect(env.target.db.get('SELECT current_revision_id FROM epics WHERE id = ?', EPIC)).toEqual({ current_revision_id: R2 })
    expect(env.target.db.get('SELECT id FROM plan_revisions WHERE id = ?', R3)).toBeUndefined()
    expect(transferRow(env)).toEqual(transfer)
    expect(epicConflict(env)).toEqual({ conflict: message })
    expect(await storageConflicts(env)).toEqual([{ epicId: EPIC, message, resolvable: false }])
    // A heartbeat later the hold is still reported, and still nothing is applied.
    expect(reconcileRepository(env.deps).conflicts).toEqual([{ epicId: EPIC, message }])
    expect(dumpDomain(env.target.db)).toEqual(before)
  })

  it.each<OpenStatus>(['queued', 'in_progress'])('reports and refuses an incoming run while the transfer is %s', async (status) => {
    const env = transferring(status)
    pullRun(env, R2)
    const before = dumpDomain(env.target.db)
    const transfer = transferRow(env)
    const result = reconcileRepository(env.deps)
    const message = expect.stringMatching(new RegExp(`${EPIC}.*run ${RUN}.*revision ${R2} ${STATUS_WORDS[status]}`))
    expect(result).toMatchObject({ imported: [], unchanged: [EPIC], conflicts: [{ epicId: EPIC, message }], rejected: [] })
    expect(dumpDomain(env.target.db)).toEqual(before)
    expect(env.target.db.all('SELECT id FROM runs')).toEqual([])
    expect(transferRow(env)).toEqual(transfer)
    expect(await storageConflicts(env)).toEqual([{ epicId: EPIC, message, resolvable: false }])
  })

  it('names both a newer revision and a run that arrive together, in one conflict for the epic', () => {
    const env = transferring('queued')
    pullNewerRevision(env)
    pullRun(env, R3)
    const result = reconcileRepository(env.deps)
    expect(result.conflicts).toEqual([{ epicId: EPIC, message: expect.stringContaining(`saved revision ${R3} and run ${RUN}`) }])
    expect(result.imported).toEqual([])
  })
})

describe('reconcileRepository and other revisions during a Linear transfer', () => {
  it('holds a revision another machine saved from the same base, numbered like the transferred one', () => {
    const env = transferring('queued')
    saveRevision(env.source, { epicId: EPIC, revisionId: R3, number: 2, bundle: BUNDLE_3, baseRevisionId: R1 })
    copyTracked(env.source, env.target)
    const before = dumpDomain(env.target.db)
    const result = reconcileRepository(env.deps)
    expect(result).toMatchObject({ imported: [], conflicts: [{ epicId: EPIC, message: expect.stringContaining(`saved revision ${R3} `) }] })
    expect(dumpDomain(env.target.db)).toEqual(before)
  })

  it('holds a pointer that moves the current revision off the transferred one', () => {
    const env = transferring('queued')
    env.source.db.run('UPDATE epics SET current_revision_id = ? WHERE id = ?', R1, EPIC)
    insertOutbox(env.source.db, { kind: 'epic_state', epicId: EPIC })
    flush(env.source)
    copyTracked(env.source, env.target)
    const result = reconcileRepository(env.deps)
    expect(result).toMatchObject({ imported: [], conflicts: [{ epicId: EPIC, message: expect.stringContaining(`saved revision ${R1} `) }] })
    expect(env.target.db.get('SELECT current_revision_id FROM epics WHERE id = ?', EPIC)).toEqual({ current_revision_id: R2 })
  })
})

describe('reconcileRepository after a held Linear transfer is canceled', () => {
  it('imports the held revision and run once the transfer is canceled, and clears the conflict', async () => {
    const env = transferring('in_progress')
    pullNewerRevision(env)
    pullRun(env, R3)
    expect(reconcileRepository(env.deps).conflicts).toHaveLength(1)
    cancelTransfer(env.ctx, { epicId: EPIC })
    const result = reconcileRepository(env.deps)
    expect(result).toMatchObject({ imported: [EPIC, RUN], conflicts: [], rejected: [] })
    expect(env.target.db.get('SELECT current_revision_id FROM epics WHERE id = ?', EPIC)).toEqual({ current_revision_id: R3 })
    expect(env.target.db.get('SELECT revision_id, state FROM runs WHERE id = ?', RUN)).toEqual({ revision_id: R3, state: 'running' })
    expect(epicConflict(env)).toEqual({ conflict: null })
    expect(await storageConflicts(env)).toEqual([])
  })

  it('clears the conflict of a held run once it imports after a cancel, though the epic files never changed', async () => {
    const env = transferring('queued')
    pullRun(env, R2)
    expect(reconcileRepository(env.deps).conflicts).toHaveLength(1)
    cancelTransfer(env.ctx, { epicId: EPIC })
    expect(reconcileRepository(env.deps)).toMatchObject({ imported: [RUN], unchanged: [EPIC], conflicts: [] })
    expect(epicConflict(env)).toEqual({ conflict: null })
    expect(await storageConflicts(env)).toEqual([])
  })
})

describe('a transfer hold and local exports of the epic', () => {
  it('refuses to write the epic state over held records, so the hold stays visible', () => {
    const env = transferring('queued')
    pullNewerRevision(env)
    const held = reconcileRepository(env.deps).conflicts
    expect(held).toHaveLength(1)
    const paths = ownedPaths(env.target.layout)
    const files = (): unknown[] => [env.target.fs.get(paths.epicPointerFile(EPIC)), env.target.fs.get(paths.epicStateFile(EPIC))]
    const before = files()
    env.target.db.run("UPDATE ticket_status SET status = 'completed' WHERE ticket_id = ?", tid(1))
    insertOutbox(env.target.db, { kind: 'epic_state', epicId: EPIC })
    expect(flush(env.target)).toMatchObject({ flushed: 0, failed: 1, errors: [expect.stringContaining('waiting for its Linear transfer')] })
    expect(files()).toEqual(before)
    expect(epicConflict(env)).toEqual({ conflict: held[0]?.message })
    expect(reconcileRepository(env.deps).conflicts).toEqual(held)
    // After a cancel the local change and the pulled records meet in the ordinary pending-export conflict.
    cancelTransfer(env.ctx, { epicId: EPIC })
    expect(reconcileRepository(env.deps).conflicts).toEqual([{ epicId: EPIC, message: expect.stringContaining('waiting to be exported') }])
    expect(env.target.db.get('SELECT current_revision_id FROM epics WHERE id = ?', EPIC)).toEqual({ current_revision_id: R2 })
  })
})

function trackedOf(env: RepoEnv): (string | undefined)[] {
  const paths = ownedPaths(env.layout)
  return [env.fs.get(paths.epicPointerFile(EPIC)), env.fs.get(paths.epicStateFile(EPIC))]
}

/** DM-311's path: a ticket status changed here while the transfer held a pulled R3, then the transfer was canceled. */
function changedDuringCanceledHold(): Transferring {
  const env = transferring('queued')
  pullNewerRevision(env)
  reconcileRepository(env.deps)
  env.target.db.run("UPDATE ticket_status SET status = 'completed' WHERE ticket_id = ?", tid(1))
  insertOutbox(env.target.db, { kind: 'epic_state', epicId: EPIC })
  flush(env.target)
  cancelTransfer(env.ctx, { epicId: EPIC })
  reconcileRepository(env.deps)
  return env
}

function recordsOf(env: Transferring): EpicRecordsAccess {
  return {
    layout: env.target.layout,
    fs: env.target.fs,
    reconcile: () => reconcileRepository(env.deps),
    flush: (scope) => flushOutbox(env.target, env.target.hook, scope)
  }
}

function ticketStatus(env: RepoEnv, ticketId: string): unknown {
  return env.db.get<{ status: string }>('SELECT status FROM ticket_status WHERE ticket_id = ?', ticketId)?.status
}

function currentRevision(env: RepoEnv): unknown {
  return env.db.get<{ current_revision_id: string }>('SELECT current_revision_id FROM epics WHERE id = ?', EPIC)?.current_revision_id
}

describe('a local epic change and pulled records of the epic', () => {
  it('a flush leaves the tracked files as pulled, and the conflict stays and names the choice', async () => {
    const env = changedDuringCanceledHold()
    const pulled = trackedOf(env.source)
    expect(flush(env.target)).toMatchObject({
      flushed: 0,
      failed: 1,
      errors: [expect.stringContaining(`Epic ${EPIC}'s tracked state and pointer hold records this machine has not imported`)]
    })
    expect(trackedOf(env.target)).toEqual(pulled)
    const conflicts = reconcileRepository(env.deps).conflicts
    expect(conflicts).toEqual([{ epicId: EPIC, message: expect.stringContaining(`Tracked records for epic ${EPIC} changed`) }])
    const message = conflicts[0]?.message ?? ''
    expect(message).toContain('keep the tracked records')
    expect(message).toContain('write local')
    expect(message).not.toMatch(/flush/i)
    expect(await storageConflicts(env)).toEqual([{ epicId: EPIC, message, resolvable: true }])
    expect([currentRevision(env.target), ticketStatus(env.target, tid(1))]).toEqual([R2, 'completed'])
    expect(trackedOf(env.target)).toEqual(pulled)
  })
})

describe("the person's choice between a local epic change and pulled records", () => {
  it('choosing to import keeps the pulled revision and drops the local change', async () => {
    const env = changedDuringCanceledHold()
    const pulled = trackedOf(env.source)
    expect(resolveEpicConflict(env.ctx, { epicId: EPIC, keep: 'tracked' }, recordsOf(env))).toEqual({
      epicId: EPIC,
      kept: 'tracked',
      abandonedRevisionIds: [],
      error: null
    })
    expect([currentRevision(env.target), ticketStatus(env.target, tid(1)), ticketStatus(env.target, tid(4))]).toEqual([R3, 'backlog', 'backlog'])
    expect(trackedOf(env.target)).toEqual(pulled)
    expect(epicConflict(env)).toEqual({ conflict: null })
    expect(await storageConflicts(env)).toEqual([])
    expect(flush(env.target)).toMatchObject({ flushed: 0, failed: 0 })
    expect(reconcileRepository(env.deps)).toMatchObject({ imported: [], unchanged: [EPIC], conflicts: [] })
    const events = env.target.db.all<{ payload_json: string }>("SELECT payload_json FROM events WHERE kind = 'repository.epic_conflict_resolved'")
    expect(events.map((event) => JSON.parse(event.payload_json))).toEqual([{ kept: 'tracked', abandonedRevisionIds: [] }])
  })

  it('choosing to overwrite writes local over the pulled records', async () => {
    const env = changedDuringCanceledHold()
    expect(resolveEpicConflict(env.ctx, { epicId: EPIC, keep: 'local' }, recordsOf(env))).toEqual({
      epicId: EPIC,
      kept: 'local',
      abandonedRevisionIds: [],
      error: null
    })
    const [pointer = '', state = ''] = trackedOf(env.target)
    expect(JSON.parse(pointer)).toMatchObject({ revisionId: R2 })
    expect(JSON.parse(state)).toMatchObject({ ticketStatuses: { [tid(1)]: 'completed' } })
    expect(env.target.db.get("SELECT exported_hash, imported_hash, conflict FROM sync_state WHERE kind = 'epic' AND entity_id = ?", EPIC)).toEqual({
      exported_hash: trackedEpicHash(pointer, state),
      imported_hash: null,
      conflict: null
    })
    // The pulled snapshot stays in the checkout; only the pointer and state are this machine's again.
    expect(env.target.fs.get(ownedPaths(env.target.layout).snapshotFile(EPIC, R3))).toBeDefined()
    expect(await storageConflicts(env)).toEqual([])
    expect(reconcileRepository(env.deps)).toMatchObject({ imported: [], unchanged: [EPIC], conflicts: [] })
    expect(currentRevision(env.target)).toBe(R2)
  })
})

describe("the person's choice while a local save waits to be written", () => {
  it('choosing to import drops a local save still waiting to be written, and its snapshot is never written', () => {
    const env = transferring(null)
    env.target.db.run(
      'INSERT INTO plan_revisions SELECT ?, epic_id, 3, ?, content_hash, bundle_json, ?, created_at, NULL, NULL FROM plan_revisions WHERE id = ?',
      R9,
      R2,
      'pending',
      R2
    )
    insertOutbox(env.target.db, { kind: 'snapshot', epicId: EPIC, revisionId: R9 })
    pullNewerRevision(env)
    expect(flush(env.target).failedRevisionIds).toEqual([R9])
    expect(reconcileRepository(env.deps).conflicts).toHaveLength(1)
    expect(resolveEpicConflict(env.ctx, { epicId: EPIC, keep: 'tracked' }, recordsOf(env)).abandonedRevisionIds).toEqual([R9])
    expect(env.target.db.get('SELECT state FROM plan_revisions WHERE id = ?', R9)).toEqual({ state: 'failed' })
    expect(currentRevision(env.target)).toBe(R3)
    expect(env.target.fs.get(ownedPaths(env.target.layout).snapshotFile(EPIC, R9))).toBeUndefined()
    expect(flush(env.target)).toMatchObject({ flushed: 0, failed: 0 })
  })
})

describe('refusing a choice between local and pulled epic records', () => {
  it('refuses either choice during a transfer hold, and changes nothing', () => {
    const env = transferring('queued')
    pullNewerRevision(env)
    env.target.db.run("UPDATE ticket_status SET status = 'completed' WHERE ticket_id = ?", tid(1))
    insertOutbox(env.target.db, { kind: 'epic_state', epicId: EPIC })
    const held = reconcileRepository(env.deps).conflicts
    const before = dumpDomain(env.target.db)
    const files = trackedOf(env.target)
    for (const keep of ['tracked', 'local'] as const) {
      const refused = domainErrorOf(() => resolveEpicConflict(env.ctx, { epicId: EPIC, keep }, recordsOf(env)))
      expect(refused.code).toBe('conflict')
      expect(refused.message).toContain('waiting for its Linear transfer')
      expect([dumpDomain(env.target.db), trackedOf(env.target), epicConflict(env)]).toEqual([before, files, { conflict: held[0]?.message }])
    }
  })

  it('refuses when there is nothing to choose, and to any session but the desktop', () => {
    const env = transferring(null)
    insertOutbox(env.target.db, { kind: 'epic_state', epicId: EPIC })
    const nothing = domainErrorOf(() => resolveEpicConflict(env.ctx, { epicId: EPIC, keep: 'local' }, recordsOf(env)))
    expect(nothing).toMatchObject({ code: 'conflict', message: expect.stringContaining('nothing to choose') })
    pullNewerRevision(env)
    expect(domainErrorOf(() => resolveEpicConflict(withRole(env.ctx, 'orchestrator'), { epicId: EPIC, keep: 'local' }, recordsOf(env))).code).toBe(
      'unauthorized'
    )
    expect(trackedOf(env.target)).toEqual(trackedOf(env.source))
  })
})

describe('a choice whose follow-up write or import fails', () => {
  it('keeps the choice to write local when the write fails, reports why, and writes on the next flush', () => {
    const env = changedDuringCanceledHold()
    env.target.fs.failOn({ op: 'rename', match: (path) => path.endsWith('current.json') })
    const result = resolveEpicConflict(env.ctx, { epicId: EPIC, keep: 'local' }, recordsOf(env))
    expect(result.error).toContain('Injected rename fault')
    expect(trackedOf(env.target)).toEqual(trackedOf(env.source))
    expect(flush(env.target)).toMatchObject({ failed: 0 })
    const [pointer = ''] = trackedOf(env.target)
    expect(JSON.parse(pointer)).toMatchObject({ revisionId: R2 })
    expect(reconcileRepository(env.deps)).toMatchObject({ unchanged: [EPIC], conflicts: [] })
  })

  it('writes no file of any epic when keeping the tracked records is refused', () => {
    const env = changedDuringCanceledHold()
    const other = idOf('epic', 2)
    saveRevision(env.target, { epicId: other, revisionId: idOf('revision', 8), number: 1, bundle: BUNDLE_1 })
    const otherState = env.target.fs.get(ownedPaths(env.target.layout).epicStateFile(other))
    insertOutbox(env.target.db, { kind: 'epic_state', epicId: other })
    env.target.fs.put(ownedPaths(env.target.layout).epicStateFile(EPIC), '{"format":"broken"}')
    const before = dumpDomain(env.target.db)
    expect(domainErrorOf(() => resolveEpicConflict(env.ctx, { epicId: EPIC, keep: 'tracked' }, recordsOf(env))).code).toBe('conflict')
    expect(dumpDomain(env.target.db)).toEqual(before)
    expect(env.target.fs.get(ownedPaths(env.target.layout).epicStateFile(other))).toBe(otherState)
    expect(flush(env.target).errors.filter((error) => error.includes(other))).toEqual([])
  })
})

function putTracked(env: RepoEnv, texts: (string | undefined)[]): void {
  const paths = ownedPaths(env.layout)
  env.fs.put(paths.epicPointerFile(EPIC), texts[0] ?? '')
  env.fs.put(paths.epicStateFile(EPIC), texts[1] ?? '')
}

function trackedStatus(env: RepoEnv, ticketId: string): unknown {
  return parseRecord(epicStateRecord, trackedOf(env)[1] ?? '', 'state').ticketStatuses[ticketId]
}

describe('an earlier export of this machine after the checkout moved on', () => {
  it.each([
    ['', false],
    [', even when removing its export intent failed after the commit', true]
  ])('does not write over its own export from another branch once that branch reconciled other records%s', (_label, removalFails) => {
    const env = transferring(null)
    const main = trackedOf(env.target)
    // On feat: ticket 1 completed and exported.
    env.target.db.run("UPDATE ticket_status SET status = 'completed' WHERE ticket_id = ?", tid(1))
    insertOutbox(env.target.db, { kind: 'epic_state', epicId: EPIC })
    if (removalFails) {
      env.target.fs.failOn({ op: 'remove', match: (path) => path === ownedPaths(env.target.layout).exportIntentFile(EPIC) })
    }
    expect(flush(env.target)).toMatchObject({ flushed: 1, failed: 0 })
    expect(env.target.fs.get(ownedPaths(env.target.layout).exportIntentFile(EPIC)) !== undefined).toBe(removalFails)
    const feat = trackedOf(env.target)
    // On main: its records are reconciled in.
    putTracked(env.target, main)
    expect(reconcileRepository(env.deps).imported).toEqual([EPIC])
    expect(ticketStatus(env.target, tid(1))).toBe('backlog')
    // Back on feat, with an agent's change waiting.
    putTracked(env.target, feat)
    env.target.db.run("UPDATE ticket_status SET status = 'in_progress' WHERE ticket_id = ?", tid(2))
    insertOutbox(env.target.db, { kind: 'epic_state', epicId: EPIC })
    expect(reconcileRepository(env.deps).conflicts).toEqual([{ epicId: EPIC, message: expect.stringContaining('neither was applied') }])
    expect(flush(env.target)).toMatchObject({ flushed: 0, failed: 1 })
    expect([trackedOf(env.target), trackedStatus(env.target, tid(1))]).toEqual([feat, 'completed'])
    expect(reconcileRepository(env.deps).conflicts).toHaveLength(1)
  })
})

describe('an uncommitted export of this machine after a stash and pop', () => {
  it('does not write over its own uncommitted export popped back after a reconcile imported the stashed-away records', () => {
    const env = createRepoEnv()
    initProject(env)
    saveRevision(env, { epicId: EPIC, revisionId: R1, number: 1, bundle: BUNDLE_1 })
    const deps = importerDeps(env, createStubGit('main'))
    expect(reconcileRepository(deps).unchanged).toEqual([EPIC])
    const committed = trackedOf(env)
    saveRevision(env, { epicId: EPIC, revisionId: R2, number: 2, bundle: BUNDLE_2, baseRevisionId: R1 })
    const stashed = trackedOf(env)
    // git stash: the checkout holds the committed records again, and a reconcile imports them.
    putTracked(env, committed)
    expect(reconcileRepository(deps).imported).toEqual([EPIC])
    expect(currentRevision(env)).toBe(R1)
    // git stash pop, then an agent's change before any reconcile.
    putTracked(env, stashed)
    env.db.run("UPDATE ticket_status SET status = 'completed' WHERE ticket_id = ?", tid(1))
    insertOutbox(env.db, { kind: 'epic_state', epicId: EPIC })
    expect(flush(env)).toMatchObject({ flushed: 0, failed: 1 })
    expect(trackedOf(env)).toEqual(stashed)
    expect(JSON.parse(trackedOf(env)[0] ?? '{}')).toMatchObject({ revisionId: R2 })
  })
})

describe('a local epic change over tracked records this machine imported', () => {
  it('exports a local change over tracked records it imported unchanged, as before', () => {
    const env = transferring(null)
    env.target.db.run("UPDATE ticket_status SET status = 'completed' WHERE ticket_id = ?", tid(1))
    insertOutbox(env.target.db, { kind: 'epic_state', epicId: EPIC })
    expect(flush(env.target)).toMatchObject({ flushed: 1, failed: 0 })
    const [pointer = '', state = ''] = trackedOf(env.target)
    expect(JSON.parse(state)).toMatchObject({ generation: 3, ticketStatuses: { [tid(1)]: 'completed' } })
    expect(JSON.parse(pointer)).toMatchObject({ revisionId: R2, generation: 3 })
    expect(env.target.db.get("SELECT exported_hash FROM sync_state WHERE kind = 'epic' AND entity_id = ?", EPIC)).toEqual({
      exported_hash: trackedEpicHash(pointer, state)
    })
  })
})

describe('reconcileRepository and Linear transfers that hold nothing', () => {
  it('still imports epic state that adds no newer revision while the transfer is open', () => {
    const env = transferring('queued')
    env.source.db.run("UPDATE ticket_status SET status = 'completed' WHERE ticket_id = ?", tid(1))
    insertOutbox(env.source.db, { kind: 'epic_state', epicId: EPIC })
    flush(env.source)
    copyTracked(env.source, env.target)
    expect(reconcileRepository(env.deps)).toMatchObject({ imported: [EPIC], conflicts: [], rejected: [] })
    expect(env.target.db.get('SELECT status FROM ticket_status WHERE ticket_id = ?', tid(1))).toEqual({ status: 'completed' })
  })

  it.each([
    ['no transfer', (): Transferring => transferring(null)],
    [
      'a canceled transfer',
      (): Transferring => {
        const env = transferring('queued')
        cancelTransfer(env.ctx, { epicId: EPIC })
        return env
      }
    ],
    [
      'a verified transfer',
      (): Transferring => {
        const env = transferring('in_progress')
        env.target.db.run("UPDATE transfers SET status = 'verified' WHERE epic_id = ?", EPIC)
        return env
      }
    ]
  ])('imports a newer revision and a run as before for an epic with %s', (_label, setup) => {
    const env = setup()
    pullNewerRevision(env)
    pullRun(env, R3)
    expect(reconcileRepository(env.deps)).toMatchObject({ imported: [EPIC, RUN], conflicts: [], rejected: [] })
    expect(env.target.db.get('SELECT current_revision_id FROM epics WHERE id = ?', EPIC)).toEqual({ current_revision_id: R3 })
    expect(env.target.db.get('SELECT id FROM runs WHERE id = ?', RUN)).toEqual({ id: RUN })
    expect(epicConflict(env)).toEqual({ conflict: null })
  })
})

describe('reconcileRepository branch changes', () => {
  it('pauses active runs once when the checkout branch changes, then stays quiet', () => {
    const target = cloneOf(buildSource())
    const git = createStubGit('main')
    const deps = importerDeps(target, git)
    reconcileRepository(deps)
    git.setBranch('feature/x')
    const changed = reconcileRepository(deps)
    expect(changed).toMatchObject({ branchChanged: true, pausedRuns: [RUN] })
    expect(target.db.get('SELECT state, pause_reason FROM runs WHERE id = ?', RUN)).toEqual({ state: 'paused', pause_reason: 'branch_changed' })
    const paused = target.db.all<{ kind: string; run_id: string; payload_json: string }>("SELECT kind, run_id, payload_json FROM events WHERE kind = 'run.paused'")
    expect(paused).toEqual([{ kind: 'run.paused', run_id: RUN, payload_json: '{"reason":"branch_changed"}' }])
    expect(getMeta(target.db, 'checkout_branch')).toBe('feature/x')
    expect(branchState(target.db, 'feature/x')).toEqual({ recorded: 'feature/x', changed: false })

    const events = target.db.all('SELECT seq FROM events').length
    expect(reconcileRepository(deps)).toMatchObject({ branchChanged: false, pausedRuns: [], imported: [] })
    expect(target.db.all('SELECT seq FROM events')).toHaveLength(events)
  })

  it('records a detached HEAD as no branch without reporting a change', () => {
    const target = cloneOf(buildSource())
    const git = createStubGit(null)
    const deps = importerDeps(target, git)
    reconcileRepository(deps)
    expect(getMeta(target.db, 'checkout_branch')).toBe('')
    expect(branchState(target.db, null)).toEqual({ recorded: null, changed: false })
    expect(reconcileRepository(deps).branchChanged).toBe(false)
    expect(branchState(target.db, 'main')).toEqual({ recorded: null, changed: true })
  })

  it('reports no change before any branch was recorded', () => {
    expect(branchState(createTestDb(), 'main')).toEqual({ recorded: null, changed: false })
  })
})

describe('reconcileRepository project identity', () => {
  it('refuses a repository whose project differs from the database', () => {
    const target = cloneOf(buildSource())
    setMeta(target.db, 'project_id', idOf('project', 99))
    const error = domainErrorOf(() => reconcileRepository(importerDeps(target, createStubGit('main'))))
    expect(error.code).toBe('project_mismatch')
    expect(target.db.all('SELECT id FROM epics')).toEqual([])
    expect(getMeta(target.db, 'checkout_branch')).toBeNull()
  })

  it('requires an initialized repository', () => {
    const empty = createRepoEnv({ root: '/empty' })
    expect(domainErrorOf(() => reconcileRepository(importerDeps(empty, createStubGit('main')))).code).toBe('not_initialized')
  })

  it('keeps the recorded project name once the project is known', () => {
    const target = cloneOf(buildSource())
    const project = JSON.parse(target.fs.get(target.layout.projectFile) ?? '{}') as { projectId: string }
    setMeta(target.db, 'project_id', project.projectId)
    setMeta(target.db, 'project_name', 'Local name')
    reconcileRepository(importerDeps(target, createStubGit('main')))
    expect(getMeta(target.db, 'project_name')).toBe('Local name')
    expect(getMeta(target.db, 'key_prefix')).toBeNull()
  })
})

describe('reconcileRepository run validation', () => {
  it('rejects a second active run for an epic without touching the first', () => {
    const source = buildSource()
    const target = cloneOf(source)
    const otherRun = idOf('run', 2)
    source.db.run("UPDATE runs SET state = 'completed' WHERE id = ?", RUN)
    insertRun(source.db, { id: otherRun, epicId: EPIC, revisionId: R2, state: 'queued' })
    insertOutbox(source.db, { kind: 'run_history', runId: otherRun })
    flush(source)
    const clone = createRepoEnv({ root: '/clone2' })
    copyTracked(source, clone)
    clone.fs.put(ownedPaths(clone.layout).runHistoryFile(RUN), target.fs.get(ownedPaths(target.layout).runHistoryFile(RUN)) ?? '')
    const result = reconcileRepository(importerDeps(clone, createStubGit('main')))
    expect(result.imported).toEqual([EPIC, RUN])
    expect(result.rejected).toEqual([{ path: `.darkmechanicus/history/${otherRun}/run.json`, message: expect.stringContaining('Could not be applied') }])
    expect(clone.db.all('SELECT id FROM runs')).toEqual([{ id: RUN }])
  })

  it('rejects a run whose epic is unknown', () => {
    const target = cloneOf(buildSource())
    target.fs.setReaddir(target.layout.epicsDir, [])
    const result = reconcileRepository(importerDeps(target, createStubGit('main')))
    expect(result.rejected).toEqual([{ path: `.darkmechanicus/history/${RUN}/run.json`, message: `Run ${RUN} belongs to unknown epic ${EPIC}.` }])
    expect(target.db.all('SELECT id FROM runs')).toEqual([])
  })

  it('skips the runs of a rejected epic', () => {
    const target = cloneOf(buildSource())
    target.fs.remove(ownedPaths(target.layout).epicPointerFile(EPIC))
    const result = reconcileRepository(importerDeps(target, createStubGit('main')))
    expect(result.rejected).toEqual([
      { path: `.darkmechanicus/epics/${EPIC}`, message: `.darkmechanicus/epics/${EPIC}/current.json is missing.` }
    ])
    expect(result.imported).toEqual([])
    expect(target.db.all('SELECT id FROM runs')).toEqual([])
  })
})

const C1 = idOf('comment', 1)
const C2 = idOf('comment', 2)
const C3 = idOf('comment', 3)

/** Adds comments (one on ticket 1, one on the epic) to the source and exports them. */
function withComments(source: RepoEnv): RepoEnv {
  insertComment(source.db, { id: C1, epicId: EPIC, ticketId: tid(1), body: 'Blocked on the **keychain** fixture' })
  insertComment(source.db, { id: C2, epicId: EPIC, body: 'Decision: ship behind a flag', role: 'desktop', label: 'Ada' })
  insertOutbox(source.db, { kind: 'comment', epicId: EPIC, entityId: C1 })
  insertOutbox(source.db, { kind: 'comment', epicId: EPIC, entityId: C2 })
  expect(flush(source).failed).toBe(0)
  return source
}

function commentFileText(env: RepoEnv, commentId: string): string {
  return env.fs.get(ownedPaths(env.layout).commentFile(EPIC, commentId)) ?? ''
}

describe('reconcileRepository comments', () => {
  it('reconstructs comments, their sync hashes, and their search documents', () => {
    const source = withComments(buildSource())
    const target = cloneOf(source)
    const result = reconcileRepository(importerDeps(target, createStubGit('main')))
    expect(result).toMatchObject({ imported: [EPIC, RUN, C1, C2], conflicts: [], rejected: [] })
    expect(target.db.all('SELECT * FROM comments ORDER BY id')).toEqual(source.db.all('SELECT * FROM comments ORDER BY id'))
    expect(target.db.all("SELECT entity_id, exported_hash, imported_hash, conflict FROM sync_state WHERE kind = 'comment' ORDER BY entity_id")).toEqual(
      [C1, C2].map((id) => {
        const hash = trackedCommentHash(commentFileText(target, id))
        return { entity_id: id, exported_hash: hash, imported_hash: hash, conflict: null }
      })
    )
    expect(target.db.all("SELECT doc_id, epic_id, ticket_id, title FROM search_index WHERE doc_type = 'comment' AND search_index MATCH 'keychain'")).toEqual([
      { doc_id: C1, epic_id: EPIC, ticket_id: tid(1), title: 'Comment by worker-1' }
    ])
  })

  it('imports a pulled comment for an unchanged epic once, and sees its own exports as unchanged', () => {
    const source = withComments(buildSource())
    const target = cloneOf(source)
    const deps = importerDeps(target, createStubGit('main'))
    reconcileRepository(deps)
    insertComment(source.db, { id: C3, epicId: EPIC, body: 'Pulled later' })
    insertOutbox(source.db, { kind: 'comment', epicId: EPIC, entityId: C3 })
    flush(source)
    copyTracked(source, target)
    expect(reconcileRepository(deps)).toMatchObject({ imported: [C3], unchanged: [EPIC, RUN], rejected: [], conflicts: [] })
    const events = target.db.all('SELECT seq FROM events').length
    expect(reconcileRepository(deps)).toMatchObject({ imported: [], rejected: [], conflicts: [] })
    expect(target.db.all('SELECT seq FROM events')).toHaveLength(events)
    expect(reconcileRepository(importerDeps(source, createStubGit('main')))).toMatchObject({ imported: [], conflicts: [], rejected: [] })
  })

  it('imports a pulled epic change while one of its comments waits to be exported', () => {
    const source = buildSource()
    const target = cloneOf(source)
    const deps = importerDeps(target, createStubGit('main'))
    reconcileRepository(deps)
    insertComment(target.db, { id: C1, epicId: EPIC })
    insertOutbox(target.db, { kind: 'comment', epicId: EPIC, entityId: C1, state: 'failed' })
    saveRevision(source, { epicId: EPIC, revisionId: R3, number: 3, bundle: BUNDLE_3, baseRevisionId: R2 })
    copyTracked(source, target)
    expect(reconcileRepository(deps)).toMatchObject({ imported: [EPIC], conflicts: [] })
  })
})

describe('reconcileRepository comment conflicts', () => {
  it('reports a comment whose file differs from the local one, keeps the local text, and clears it once restored', () => {
    const source = withComments(buildSource())
    const target = cloneOf(source)
    const deps = importerDeps(target, createStubGit('main'))
    reconcileRepository(deps)
    const file = ownedPaths(target.layout).commentFile(EPIC, C1)
    const original = target.fs.get(file) ?? ''
    target.fs.put(file, original.replace('Blocked on the **keychain** fixture', 'Rewritten history'))
    const result = reconcileRepository(deps)
    const shown = `.darkmechanicus/epics/${EPIC}/comments/${C1}.json`
    expect(result).toMatchObject({ imported: [], rejected: [] })
    expect(result.conflicts).toEqual([{ epicId: EPIC, message: `Comment ${C1} already exists with different content; ${shown} was not imported.` }])
    expect(target.db.get('SELECT body FROM comments WHERE id = ?', C1)).toEqual({ body: 'Blocked on the **keychain** fixture' })
    const conflict = (): unknown => target.db.get("SELECT conflict FROM sync_state WHERE kind = 'comment' AND entity_id = ?", C1)
    expect(conflict()).toEqual({ conflict: result.conflicts[0]?.message })
    target.fs.put(file, original)
    expect(reconcileRepository(deps)).toMatchObject({ imported: [], conflicts: [], rejected: [] })
    expect(conflict()).toEqual({ conflict: null })
  })
})

interface ReconciledPayload {
  imported: string[]
  rejected: number
  branchChanged: boolean
}

function reconciledEvents(env: RepoEnv): ReconciledPayload[] {
  return env.db
    .all<{ payload_json: string }>("SELECT payload_json FROM events WHERE kind = 'repository.reconciled' ORDER BY seq")
    .map((row) => JSON.parse(row.payload_json) as ReconciledPayload)
}

const BAD_EPIC = { path: '.darkmechanicus/epics/ep_bad', message: 'Refusing to build a repository path from an invalid epic id.' }

describe('reconcileRepository reconciled events', () => {
  it('records a rejection that persists across heartbeats once, and again when it comes back', () => {
    const target = cloneOf(buildSource())
    const deps = importerDeps(target, createStubGit('main'))
    reconcileRepository(deps)
    target.fs.setReaddir(target.layout.epicsDir, [EPIC, 'ep_bad'])
    for (let round = 0; round < 3; round += 1) {
      expect(reconcileRepository(deps).rejected).toEqual([BAD_EPIC])
    }
    target.fs.setReaddir(target.layout.epicsDir, [EPIC])
    expect(reconcileRepository(deps).rejected).toEqual([])
    target.fs.setReaddir(target.layout.epicsDir, [EPIC, 'ep_bad'])
    expect(reconcileRepository(deps).rejected).toEqual([BAD_EPIC])
    expect(reconciledEvents(target).map((event) => [event.imported, event.rejected])).toEqual([
      [[EPIC, RUN], 0],
      [[], 1],
      [[], 1]
    ])
  })

  it('still records imports and branch changes while the same rejection persists', () => {
    const source = withComments(buildSource())
    const target = cloneOf(source)
    const git = createStubGit('main')
    const deps = importerDeps(target, git)
    reconcileRepository(deps)
    target.fs.setReaddir(target.layout.epicsDir, [EPIC, 'ep_bad'])
    reconcileRepository(deps)
    insertComment(source.db, { id: C3, epicId: EPIC })
    insertOutbox(source.db, { kind: 'comment', epicId: EPIC, entityId: C3 })
    flush(source)
    copyTracked(source, target)
    reconcileRepository(deps)
    git.setBranch('feature')
    reconcileRepository(deps)
    reconcileRepository(deps)
    expect(reconciledEvents(target).map((event) => [event.imported, event.rejected, event.branchChanged])).toEqual([
      [[EPIC, RUN, C1, C2], 0, false],
      [[], 1, false],
      [[C3], 1, false],
      [[], 1, true]
    ])
  })
})

describe('reconcileRepository comment text', () => {
  it('imports a comment whose body puts marker-like text between U+2028 and U+2029 separators', () => {
    const source = buildSource()
    const body = 'Decision ======= Use the v2 schema <<<<<<< HEAD done'
    insertComment(source.db, { id: C3, epicId: EPIC, body })
    insertOutbox(source.db, { kind: 'comment', epicId: EPIC, entityId: C3 })
    expect(flush(source).failed).toBe(0)
    const target = cloneOf(source)
    expect(reconcileRepository(importerDeps(target, createStubGit('main')))).toMatchObject({ imported: [EPIC, RUN, C3], rejected: [] })
    expect(target.db.get('SELECT body FROM comments WHERE id = ?', C3)).toEqual({ body })
  })
})

describe('reconcileRepository unchanged comment files', () => {
  it('does not read comment files again while they are unchanged', () => {
    const target = cloneOf(withComments(buildSource()))
    const deps = importerDeps(target, createStubGit('main'))
    expect(reconcileRepository(deps).imported).toEqual([EPIC, RUN, C1, C2])
    const dir = ownedPaths(target.layout).commentsDir(EPIC)
    target.fs.failOn({ op: 'readFile', match: (path) => isWithin(dir, path) })
    expect(reconcileRepository(deps)).toMatchObject({ imported: [], conflicts: [], rejected: [] })
    expect(() => target.fs.readFile(ownedPaths(target.layout).commentFile(EPIC, C1))).toThrow('Injected readFile fault')
  })

  it('reads a comment file again once it changed at the same size, and keeps reporting the conflict', () => {
    const target = cloneOf(withComments(buildSource()))
    const deps = importerDeps(target, createStubGit('main'))
    reconcileRepository(deps)
    const file = ownedPaths(target.layout).commentFile(EPIC, C1)
    target.fs.put(file, (target.fs.get(file) ?? '').replace('**keychain**', '**KEYCHAIN**'))
    const conflict = { epicId: EPIC, message: `Comment ${C1} already exists with different content; .darkmechanicus/epics/${EPIC}/comments/${C1}.json was not imported.` }
    expect(reconcileRepository(deps).conflicts).toEqual([conflict])
    expect(reconcileRepository(deps).conflicts).toEqual([conflict])
    expect(target.db.get('SELECT body FROM comments WHERE id = ?', C1)).toEqual({ body: 'Blocked on the **keychain** fixture' })
  })
})

describe('reconcileRepository leaves drafts alone', () => {
  it('keeps a local draft while importing a newer revision', () => {
    const source = buildSource()
    const target = cloneOf(source)
    const deps = importerDeps(target, createStubGit('main'))
    reconcileRepository(deps)
    target.db.run(
      'INSERT INTO drafts (epic_id, base_revision_id, draft_revision, bundle_json, created_at, updated_at) VALUES (?, ?, 4, ?, ?, ?)',
      EPIC,
      R2,
      JSON.stringify(BUNDLE_2),
      T0,
      T0
    )
    const draft = target.db.all('SELECT * FROM drafts')
    saveRevision(source, { epicId: EPIC, revisionId: R3, number: 3, bundle: BUNDLE_3, baseRevisionId: R2 })
    copyTracked(source, target)
    expect(reconcileRepository(deps).imported).toEqual([EPIC])
    expect(target.db.all('SELECT * FROM drafts')).toEqual(draft)
  })
})

describe('reconcileRepository on disk', () => {
  let repo: TempRepo | undefined

  afterEach(() => {
    repo?.cleanup()
    repo = undefined
  })

  it('reconstructs a clone copied without local/', () => {
    repo = createTempRepo()
    const clock = createTestClock()
    const db = createTestDb()
    const ids = createSequentialIds()
    initializeRepository({ layout: repo.layout, fs: nodeFs, ids, clock }, { name: 'Disk' })
    const env = { db, layout: repo.layout, fs: nodeFs, clock }
    db.run('INSERT INTO epics (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', EPIC, 'Disk epic', 'backlog', T0, T0)
    db.run(
      "INSERT INTO plan_revisions (id, epic_id, number, content_hash, bundle_json, state, created_at) VALUES (?, ?, 1, ?, ?, 'pending', ?)",
      R1,
      EPIC,
      contentHash(BUNDLE_1),
      JSON.stringify(BUNDLE_1),
      T0
    )
    insertOutbox(db, { kind: 'snapshot', epicId: EPIC, revisionId: R1 })
    expect(flushOutbox(env, createSaveHook(db, clock)).savedRevisionIds).toEqual([R1])

    const cloneRoot = join(repo.outside, 'clone')
    mkdirSync(cloneRoot)
    const dmDir = repo.layout.dmDir
    cpSync(dmDir, join(cloneRoot, '.darkmechanicus'), { recursive: true, filter: (path) => relative(dmDir, path).split(sep)[0] !== 'local' })
    const clone = resolveLayout(cloneRoot)
    expect(existsSync(clone.localDir)).toBe(false)
    const target = { db: createTestDb(), layout: clone, fs: nodeFs, clock, machineId: idOf('machine', 5), git: createStubGit('main'), fileHashes: createFileHashCache() }
    expect(reconcileRepository(target).imported).toEqual([EPIC])
    expect(target.db.get('SELECT current_revision_id FROM epics')).toEqual({ current_revision_id: R1 })
  })
})

describe('reconcileRepository worker efforts', () => {
  it('keeps the effort a worker ran at, and adds none to a worker recorded before efforts existed', () => {
    const source = createRepoEnv({ root: '/source' })
    initProject(source)
    saveRevision(source, { epicId: EPIC, revisionId: R1, number: 1, bundle: BUNDLE_1 })
    insertRun(source.db, { id: RUN, epicId: EPIC, revisionId: R1, ownerMachineId: SOURCE_MACHINE })
    insertAttempt(source.db, { id: A1, runId: RUN, ticketId: tid(1), revisionId: R1, worker: { label: 'w', modelId: 'm', effort: 'medium' } })
    insertAttempt(source.db, { id: A2, runId: RUN, ticketId: tid(2), revisionId: R1, worker: { label: 'old', modelId: 'm' } })
    insertOutbox(source.db, { kind: 'run_history', epicId: EPIC, runId: RUN })
    flush(source)
    const target = cloneOf(source)
    reconcileRepository(importerDeps(target, createStubGit('main')))
    const efforts = target.db
      .all<{ id: string; worker_json: string }>('SELECT id, worker_json FROM attempts ORDER BY id')
      .map((row) => [row.id, (JSON.parse(row.worker_json) as { effort?: string }).effort])
    expect(efforts).toEqual([[A1, 'medium'], [A2, undefined]])
  })
})

describe('reconcileRepository row checks', () => {
  const RK1 = idOf('rowCheck', 1)
  const RK2 = idOf('rowCheck', 2)
  const ROW_CHECK_COLUMNS = 'SELECT id, run_id, number, sprint_id, row_no, commit_ref, checks_json, recorded_by, created_at FROM row_checks ORDER BY number'

  function exportRowChecks(source: RepoEnv): void {
    insertOutbox(source.db, { kind: 'run_history', epicId: EPIC, runId: RUN })
    expect(flush(source).failed).toBe(0)
  }

  it('imports the row checks of a run exactly as they were recorded', () => {
    const source = buildSource()
    insertRowCheck(source.db, { id: RK1, runId: RUN, sprintId: sid(1), number: 1, checks: [{ name: 'tests', status: 'failed', detail: '2 failed' }] })
    insertRowCheck(source.db, { id: RK2, runId: RUN, sprintId: sid(1), number: 2, row: 2, recordedBy: null })
    exportRowChecks(source)
    const target = cloneOf(source)
    const result = reconcileRepository(importerDeps(target, createStubGit('main')))
    expect(result).toMatchObject({ imported: [EPIC, RUN], rejected: [], conflicts: [] })
    expect(target.db.all(ROW_CHECK_COLUMNS)).toEqual(source.db.all(ROW_CHECK_COLUMNS))
    expect(target.db.all(ROW_CHECK_COLUMNS)).toHaveLength(2)
  })

  it('brings in a check recorded after the first import and keeps the earlier ones', () => {
    const source = buildSource()
    insertRowCheck(source.db, { id: RK1, runId: RUN, sprintId: sid(1), number: 1 })
    exportRowChecks(source)
    const target = cloneOf(source)
    const deps = importerDeps(target, createStubGit('main'))
    reconcileRepository(deps)
    insertRowCheck(source.db, { id: RK2, runId: RUN, sprintId: sid(1), number: 2, checks: [{ name: 'tests', status: 'failed', detail: '' }] })
    exportRowChecks(source)
    copyTracked(source, target)
    expect(reconcileRepository(deps)).toMatchObject({ imported: [RUN], rejected: [] })
    expect(target.db.all<{ id: string }>(ROW_CHECK_COLUMNS).map((row) => row.id)).toEqual([RK1, RK2])
  })

  it('rejects a run that lists a row check another run already owns, and changes nothing', () => {
    const source = buildSource()
    const target = cloneOf(source)
    const deps = importerDeps(target, createStubGit('main'))
    reconcileRepository(deps)
    const other = idOf('run', 2)
    insertRun(target.db, { id: other, epicId: EPIC, revisionId: R2, state: 'completed' })
    insertRowCheck(target.db, { id: RK1, runId: other, sprintId: sid(1), number: 1 })
    insertRowCheck(source.db, { id: RK1, runId: RUN, sprintId: sid(1), number: 1 })
    exportRowChecks(source)
    copyTracked(source, target)
    const before = dumpDomain(target.db)
    const result = reconcileRepository(deps)
    expect(result.rejected).toEqual([{ path: `.darkmechanicus/history/${RUN}/run.json`, message: `Row check ${RK1} already belongs to another run.` }])
    expect(dumpDomain(target.db)).toEqual(before)
  })
})

const FAILED_VERDICT = {
  branch: 'epic/demo',
  commit: 'c'.repeat(40),
  parent: null,
  base: { kind: 'epic_start', commit: 'abcdef1' },
  passed: false,
  reasons: ['Commit ccccccc has 2 parents (a merge commit).'],
  checks: [{ name: 'One parent', status: 'failed', detail: 'Commit ccccccc has 2 parents (a merge commit).' }],
  verifiedAt: T0
}
const PASSED_VERDICT = { ...FAILED_VERDICT, commit: 'd'.repeat(40), parent: 'e'.repeat(40), passed: true, reasons: [], checks: [] }

/** Stores `verdict` on attempt A1 of the source and exports the run history. */
function exportVerdict(source: RepoEnv, verdict: unknown): void {
  source.db.run('UPDATE attempts SET increment_json = ? WHERE id = ?', JSON.stringify(verdict), A1)
  insertOutbox(source.db, { kind: 'run_history', epicId: EPIC, runId: RUN })
  expect(flush(source).failed).toBe(0)
}

describe('reconcileRepository sprint increments', () => {
  const COLUMNS = 'SELECT id, increment_json FROM attempts ORDER BY id'

  it('imports the verdict of the attempt that named an increment, and leaves the others empty', () => {
    const source = buildSource()
    exportVerdict(source, FAILED_VERDICT)
    const target = cloneOf(source)
    expect(reconcileRepository(importerDeps(target, createStubGit('main')))).toMatchObject({ imported: [EPIC, RUN], rejected: [], conflicts: [] })
    expect(target.db.all(COLUMNS)).toEqual([
      { id: A1, increment_json: expect.any(String) },
      { id: A2, increment_json: null }
    ])
    expect(JSON.parse(target.db.get<{ increment_json: string }>('SELECT increment_json FROM attempts WHERE id = ?', A1)?.increment_json ?? 'null')).toEqual(FAILED_VERDICT)
  })

  it('brings in a verdict that changed after the first import', () => {
    const source = buildSource()
    exportVerdict(source, FAILED_VERDICT)
    const target = cloneOf(source)
    const deps = importerDeps(target, createStubGit('main'))
    reconcileRepository(deps)
    exportVerdict(source, PASSED_VERDICT)
    copyTracked(source, target)
    expect(reconcileRepository(deps)).toMatchObject({ imported: [RUN], rejected: [] })
    expect(JSON.parse(target.db.get<{ increment_json: string }>('SELECT increment_json FROM attempts WHERE id = ?', A1)?.increment_json ?? 'null')).toEqual(PASSED_VERDICT)
  })

  it('exports the imported verdict back unchanged', () => {
    const source = buildSource()
    exportVerdict(source, PASSED_VERDICT)
    const target = cloneOf(source)
    reconcileRepository(importerDeps(target, createStubGit('main')))
    insertOutbox(target.db, { kind: 'run_history', epicId: EPIC, runId: RUN })
    expect(flush(target).failed).toBe(0)
    const written = JSON.parse(target.fs.get(ownedPaths(target.layout).runHistoryFile(RUN)) ?? '{}') as {
      attempts: { id: string; increment?: unknown }[]
    }
    expect(written.attempts.find((item) => item.id === A1)?.increment).toEqual(PASSED_VERDICT)
    expect(written.attempts.find((item) => item.id === A2)).not.toHaveProperty('increment')
  })
})

describe('reconcileRepository for a database-only project', () => {
  it('imports nothing and reports nothing, because no record file is tracked', () => {
    const env = createRepoEnv({ mode: 'db' })
    const result = reconcileRepository(importerDeps(env, createStubGit('main')))
    expect(result).toEqual({
      imported: [],
      unchanged: [],
      conflicts: [],
      profileConflicts: [],
      kanbanConflicts: [],
      rejected: [],
      branchChanged: false,
      pausedRuns: []
    })
  })

  it('touches no file at all, rather than scanning directories that are never written', () => {
    const env = createRepoEnv({ mode: 'db' })
    const before = { reads: env.fs.reads.length, writes: env.fs.writes.length }
    reconcileRepository(importerDeps(env, createStubGit('main')))
    expect(env.fs.reads.slice(before.reads)).toEqual([])
    expect(env.fs.writes.slice(before.writes)).toEqual([])
  })

  it('records no checkout branch, so moving the checkout never blocks a save or pauses a run', () => {
    const env = createRepoEnv({ mode: 'db' })
    const git = createStubGit('main')
    reconcileRepository(importerDeps(env, git))
    git.setBranch('feature/other')
    expect(reconcileRepository(importerDeps(env, git)).branchChanged).toBe(false)
    expect(getMeta(env.db, 'checkout_branch')).toBeNull()
    expect(branchState(env.db, 'feature/other')).toEqual({ recorded: null, changed: false })
  })

  it('hands every caller its own result, so one cannot change what a later reconcile reports', () => {
    const env = createRepoEnv({ mode: 'db' })
    const first = reconcileRepository(importerDeps(env, createStubGit('main')))
    first.imported.push('poisoned')
    expect(reconcileRepository(importerDeps(env, createStubGit('main'))).imported).toEqual([])
  })
})
