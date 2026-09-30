import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeBundle, sid, tid } from '../../test/bundles'
import { domainErrorOf, idOf, insertAttempt, insertCheckpoint, insertComment, insertOutbox, insertReport, insertRun, T0 } from '../../test/repoFixtures'
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
import { createSaveHook } from '../../test/repoFixtures'
import { createTempRepo, type TempRepo } from '../../test/tempRepo'
import { createSequentialIds, createTestClock, createTestDb } from '../../test/testContext'
import { contentHash } from '../canonical'
import { getMeta, setMeta } from '../meta'
import { flushOutbox } from './finalizer'
import { branchState, reconcileRepository } from './importer'
import { initializeRepository } from './initialize'
import { resolveLayout } from './layout'
import { nodeFs } from './nodeFs'
import { ownedPaths } from './paths'
import { trackedCommentHash, trackedEpicHash, trackedRunHash } from './portable'

const EPIC = idOf('epic', 1)
const R1 = idOf('revision', 1)
const R2 = idOf('revision', 2)
const R3 = idOf('revision', 3)
const RUN = idOf('run', 1)
const A1 = idOf('attempt', 1)
const A2 = idOf('attempt', 2)
const REPORT = idOf('report', 1)
const SOURCE_MACHINE = idOf('machine', 1)
const BUNDLE_1 = makeBundle([[1, 2]], [[1, 2]])
const BUNDLE_2 = makeBundle([[1, 2, 3]], [[1, 2]])
const BUNDLE_3 = makeBundle([[1, 2, 3, 4]], [[1, 2]])
const BRANCH = { repository: null, name: 'epic/demo', startCommit: 'abcdef1' }

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
  insertReport(source.db, { id: REPORT, runId: RUN, sprintId: sid(1), content: { summary: 'Sprint went well', risks: ['Flaky pipeline'] } })
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
    expect(result).toEqual({ imported: [EPIC, RUN], unchanged: [], conflicts: [], rejected: [], branchChanged: false, pausedRuns: [] })
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
})

describe('reconcileRepository change detection', () => {
  it('treats an unchanged re-import as a quiet no-op', () => {
    const target = cloneOf(buildSource())
    const deps = importerDeps(target, createStubGit('main'))
    reconcileRepository(deps)
    const before = dumpDomain(target.db)
    const events = target.db.all('SELECT seq FROM events').length
    expect(reconcileRepository(deps)).toEqual({ imported: [], unchanged: [EPIC, RUN], conflicts: [], rejected: [], branchChanged: false, pausedRuns: [] })
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
    const target = { db: createTestDb(), layout: clone, fs: nodeFs, clock, machineId: idOf('machine', 5), git: createStubGit('main') }
    expect(reconcileRepository(target).imported).toEqual([EPIC])
    expect(target.db.get('SELECT current_revision_id FROM epics')).toEqual({ current_revision_id: R1 })
  })
})
