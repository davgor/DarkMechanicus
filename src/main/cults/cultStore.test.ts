import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type Db, openDatabase } from '../../core/db/database'
import { migrate } from '../../core/db/migrations'
import { DomainError } from '../../core/errors'
import type { CultInput } from '../../shared/cults/cult'
import { remainingMs } from '../../shared/cults/runState'
import { thrownBy } from '../../test/thrownBy'
import { APP_MIGRATIONS, openAppDatabase } from '../desktop/appDatabase'
import { createCultStore, type CultStore } from './cultStore'

const MIN = 60_000
const T0 = Date.parse('2026-03-01T00:00:00.000Z')
const tempDirs: string[] = []
const openDbs: Db[] = []

interface Harness {
  dir: string
  db: Db
  store: CultStore
  /** Moves the store's clock forward. */
  advance(ms: number): void
}

function storeOn(dir: string, clock = { ms: T0 }): Harness {
  const db = openAppDatabase(dir)
  openDbs.push(db)
  const store = createCultStore({ db, now: () => new Date(clock.ms).toISOString() })
  return { dir, db, store, advance: (ms) => void (clock.ms += ms) }
}

/** A real app.sqlite written at v4 (before cults), then opened by this build. */
function fromV4(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'dm-cults-test-'))
  tempDirs.push(dir)
  const raw = openDatabase(join(dir, 'app.sqlite'))
  migrate(raw, APP_MIGRATIONS.filter((migration) => migration.version <= 4))
  raw.run("INSERT INTO app_meta (key, value) VALUES ('kept', 'yes')")
  raw.close()
  return storeOn(dir)
}

function reopen(h: Harness): Harness {
  h.db.close()
  openDbs.splice(openDbs.indexOf(h.db), 1)
  return storeOn(h.dir)
}

const codeOf = (action: () => unknown): string | undefined => {
  const error = thrownBy(action)
  return error instanceof DomainError ? error.code : error === undefined ? undefined : `raw:${String(error)}`
}

const GENERAL: CultInput = {
  name: 'Gerry cult',
  charter: 'Build the shrine.',
  scope: 'sanctum',
  folderPath: null,
  archetype: 'general',
  magosName: 'Magos Vettius',
  magosModelId: null,
  defaultTimeLimitMs: 10 * MIN
}

const PLAN_FORGE: CultInput = {
  ...GENERAL,
  name: 'Forge',
  scope: 'folder',
  folderPath: '/repos/dm',
  archetype: 'plan_forge',
  targetEpicId: 'ep_target'
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('cult store on a database migrated from v4', () => {
  it('migrates, keeps earlier rows and persists a cult and run across reopen', () => {
    const h = fromV4()
    expect(h.db.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(5)
    const cult = h.store.createCult(GENERAL)
    expect(cult.id).toMatch(/^ct_/)
    const run = h.store.startRun(cult.id, { workDir: '/tmp/work' })
    expect(run).toMatchObject({ id: expect.stringMatching(/^cr_/), state: 'starting', cap: 6, timeLimitMs: 10 * MIN })
    const again = reopen(h)
    expect(again.db.get('SELECT value FROM app_meta WHERE key = ?', 'kept')).toEqual({ value: 'yes' })
    expect(again.store.getCult(cult.id)).toEqual(cult)
    expect(again.store.getRun(run.id)).toEqual(run)
  })

  it('stores a null default time limit as unlimited and run overrides over the defaults', () => {
    const h = fromV4()
    const cult = h.store.createCult({ ...GENERAL, defaultTimeLimitMs: null })
    expect(cult).toMatchObject({ defaultTimeLimitMs: null, defaultCap: 6, acolyteGraceMs: 3 * MIN, magosWindowMs: 2 * MIN })
    const run = h.store.startRun(cult.id, { workDir: '/w', cap: 24, acolyteGraceMs: 30_000 })
    expect(run).toMatchObject({ timeLimitMs: null, cap: 24, acolyteGraceMs: 30_000, magosWindowMs: 2 * MIN })
    expect(codeOf(() => h.store.startRun(cult.id, { workDir: '/w', cap: 25 }))).toBe('invalid_input')
  })

  it('refuses a folder cult without a folder and a sanctum cult with one', () => {
    const h = fromV4()
    expect(codeOf(() => h.store.createCult({ ...GENERAL, scope: 'folder', folderPath: null }))).toBe('invalid_input')
    expect(codeOf(() => h.store.createCult({ ...GENERAL, folderPath: '/x' }))).toBe('invalid_input')
  })
})

describe('one active run per cult', () => {
  it('refuses a second active run until the first ends, and lists runs newest first', () => {
    const h = fromV4()
    const cult = h.store.createCult(GENERAL)
    const first = h.store.startRun(cult.id, { workDir: '/w' })
    expect(codeOf(() => h.store.startRun(cult.id, { workDir: '/w' }))).toBe('active_run_exists')
    h.store.transitionRun(first.id, { type: 'abort', reason: 'failed' })
    h.advance(MIN)
    const second = h.store.startRun(cult.id, { workDir: '/w' })
    expect(h.store.listRuns(cult.id).map((run) => run.id)).toEqual([second.id, first.id])
    expect(h.store.listRuns().map((run) => run.id)).toEqual([second.id, first.id])
  })

  it('is enforced by the partial unique index even for a raw insert', () => {
    const h = fromV4()
    const cult = h.store.createCult(GENERAL)
    h.store.startRun(cult.id, { workDir: '/w' })
    const insert = () =>
      h.db.run(
        `INSERT INTO cult_runs (id, cult_id, state, grace_ms, magos_window_ms, cap, work_dir, started_at)
         VALUES ('cr_raw', ?, 'paused', 60000, 60000, 6, '/w', 't')`,
        cult.id
      )
    expect(thrownBy(insert)).toBeInstanceOf(Error)
  })
})

describe('members', () => {
  it('refuses a duplicate display name regardless of case, and a chat joining twice', () => {
    const h = fromV4()
    const run = h.store.startRun(h.store.createCult(GENERAL).id, { workDir: '/w' })
    h.store.addMember(run.id, { chatId: 'c1', role: 'magos', displayName: 'Magos Vettius' })
    expect(codeOf(() => h.store.addMember(run.id, { chatId: 'c2', role: 'acolyte', displayName: 'magos VETTIUS' }))).toBe('conflict')
    expect(codeOf(() => h.store.addMember(run.id, { chatId: 'c1', role: 'acolyte', displayName: 'Other' }))).toBe('conflict')
    expect(h.store.listMembers(run.id).map((member) => member.displayName)).toEqual(['Magos Vettius'])
  })

  it('names unnamed members uniquely and records summoned and left events', () => {
    const h = fromV4()
    const run = h.store.startRun(h.store.createCult(GENERAL).id, { workDir: '/w' })
    const names = ['a', 'b', 'c', 'd'].map((chatId) => h.store.addMember(run.id, { chatId, role: 'acolyte' }).displayName)
    expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(4)
    h.advance(MIN)
    const left = h.store.updateMember(run.id, 'a', { state: 'concluded', tier: 'cheap', tierReason: 'small task' })
    expect(left).toMatchObject({ state: 'concluded', tier: 'cheap', leftAt: new Date(T0 + MIN).toISOString() })
    expect(codeOf(() => h.store.updateMember(run.id, 'a', { state: 'active' }))).toBe('invalid_state')
    const kinds = h.store.pageEvents(run.id).events.map((event) => event.kind)
    expect(kinds).toEqual(['summoned', 'summoned', 'summoned', 'summoned', 'concluded'])
  })
})

describe('cascade delete', () => {
  it('removes the cult with its slots, runs, members, petitions, events, reports and worker types', () => {
    const h = fromV4()
    const cult = h.store.createCult(PLAN_FORGE)
    const run = h.store.startRun(cult.id, { workDir: '/w' })
    h.store.addMember(run.id, { chatId: 'mg', role: 'magos' })
    h.store.addMember(run.id, { chatId: 'sec', role: 'acolyte', slotId: 'security' })
    h.store.submitReport(run.id, { memberChatId: 'sec', slotId: 'security', text: 'No issues.' })
    h.store.createWorkerType(run.id, 'mg', { displayName: 'Archivist', description: 'd', mission: 'm', rationale: 'r', requiredForConclusion: false })
    h.store.createPetition(run.id, { kind: 'allow_save', reason: 'save the plan' })
    expect(codeOf(() => h.store.deleteCult(cult.id))).toBe('active_run_exists')
    h.store.transitionRun(run.id, { type: 'abort', reason: 'killed' })
    h.store.deleteCult(cult.id)
    const tables = ['cults', 'cult_role_slots', 'cult_runs', 'cult_members', 'cult_petitions', 'cult_events', 'cult_specialist_reports', 'cult_run_worker_types']
    for (const table of tables) expect(h.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n).toBe(0)
    expect(h.store.getCult(cult.id)).toBeNull()
  })
})

describe('run transitions persist atomically', () => {
  it('banks running time across pause and resume, so paused time is excluded', () => {
    const h = fromV4()
    const run = h.store.startRun(h.store.createCult(GENERAL).id, { workDir: '/w' })
    h.store.transitionRun(run.id, { type: 'started' })
    h.advance(3 * MIN)
    h.store.transitionRun(run.id, { type: 'pause' })
    h.advance(60 * MIN)
    const resumed = h.store.transitionRun(run.id, { type: 'resume' })
    expect(resumed).toMatchObject({ state: 'running', accumulatedRunningMs: 3 * MIN })
    expect(remainingMs(resumed, new Date(T0 + 65 * MIN).toISOString())).toBe(5 * MIN)
    const kinds = h.store.pageEvents(run.id).events.map((event) => event.kind)
    expect(kinds).toEqual(['paused', 'resumed'])
  })

  it('refuses an illegal move and leaves the run and its events untouched', () => {
    const h = fromV4()
    const run = h.store.startRun(h.store.createCult(GENERAL).id, { workDir: '/w' })
    expect(codeOf(() => h.store.transitionRun(run.id, { type: 'resume' }))).toBe('invalid_state')
    expect(codeOf(() => h.store.transitionRun(run.id, { type: 'shutdown', reason: 'expired' }))).toBe('invalid_state')
    expect(h.store.getRun(run.id)).toEqual(run)
    expect(h.store.pageEvents(run.id).events).toEqual([])
  })

  it('rolls back the whole transition when its event cannot be written', () => {
    const h = fromV4()
    const run = h.store.startRun(h.store.createCult(GENERAL).id, { workDir: '/w' })
    h.store.transitionRun(run.id, { type: 'started' })
    const petition = h.store.createPetition(run.id, { kind: 'acolytes', additional: 2, reason: 'more hands' })
    h.db.exec("CREATE TEMP TRIGGER no_end BEFORE INSERT ON cult_events WHEN NEW.kind = 'ended' BEGIN SELECT RAISE(ABORT, 'boom'); END")
    expect(thrownBy(() => h.store.transitionRun(run.id, { type: 'abort', reason: 'killed' }))).toBeInstanceOf(Error)
    expect(h.store.getRun(run.id)?.state).toBe('running')
    expect(h.store.listPetitions(run.id)).toEqual([petition])
  })
})

describe('ending a run denies pending petitions', () => {
  it('denies every pending petition at the end, keeps decided ones, and records each denial', () => {
    const h = fromV4()
    const run = h.store.startRun(h.store.createCult(GENERAL).id, { workDir: '/w' })
    h.store.transitionRun(run.id, { type: 'started' })
    const approved = h.store.createPetition(run.id, { kind: 'acolytes', additional: 4, reason: 'scale' })
    h.store.decidePetition(approved.id, { approve: true, granted: 3 })
    const pending = h.store.createPetition(run.id, { kind: 'folder_access', folderPath: '/repos/other', reason: 'read it' })
    h.store.createPetition(run.id, { kind: 'allow_save', reason: 'save' })
    h.store.transitionRun(run.id, { type: 'shutdown', reason: 'stopped' })
    expect(h.store.listPetitions(run.id).filter((p) => p.state === 'pending')).toHaveLength(2)
    h.advance(MIN)
    const ended = h.store.transitionRun(run.id, { type: 'finish' })
    expect(ended).toMatchObject({ state: 'ended', endReason: 'stopped', cap: 9 })
    const petitions = h.store.listPetitions(run.id)
    expect(petitions.map((p) => [p.state, p.granted])).toEqual([['approved', 3], ['denied', null], ['denied', null]])
    expect(petitions[1]).toMatchObject({ id: pending.id, folderPath: '/repos/other', decidedAt: ended.endedAt })
    const kinds = h.store.pageEvents(run.id).events.map((event) => event.kind)
    expect(kinds.slice(-4)).toEqual(['shutdown_started', 'petition_denied', 'petition_denied', 'ended'])
    expect(codeOf(() => h.store.createPetition(run.id, { kind: 'allow_save', reason: 'late' }))).toBe('run_not_active')
  })

  it('never decides a petition twice and never raises the cap past 24', () => {
    const h = fromV4()
    const run = h.store.startRun(h.store.createCult(GENERAL).id, { workDir: '/w', cap: 22 })
    const petition = h.store.createPetition(run.id, { kind: 'acolytes', additional: 5, reason: 'more' })
    expect(h.store.decidePetition(petition.id, { approve: true }).granted).toBe(2)
    expect(h.store.getRun(run.id)?.cap).toBe(24)
    expect(codeOf(() => h.store.decidePetition(petition.id, { approve: false }))).toBe('invalid_state')
  })
})

describe('event paging and startup reconciliation', () => {
  it('pages events by sequence', () => {
    const h = fromV4()
    const run = h.store.startRun(h.store.createCult(GENERAL).id, { workDir: '/w' })
    for (let i = 1; i <= 5; i++) h.store.appendEvent(run.id, { kind: 'summoned', memberName: `M${i}`, summary: `event ${i}` })
    const first = h.store.pageEvents(run.id, { limit: 2 })
    expect(first.events.map((event) => event.seq)).toEqual([1, 2])
    expect(first.nextAfterSeq).toBe(2)
    const last = h.store.pageEvents(run.id, { afterSeq: 4, limit: 2 })
    expect(last).toMatchObject({ events: [{ seq: 5, summary: 'event 5', memberName: 'M5' }], nextAfterSeq: null })
    expect(codeOf(() => h.store.appendEvent(run.id, { kind: 'bogus' as 'summoned', summary: 'x' }))).toBe('invalid_input')
  })

  it('lists every run not yet ended for restart reconciliation, across reopen', () => {
    const h = fromV4()
    const ids = ['A', 'B', 'C'].map((name) => {
      const run = h.store.startRun(h.store.createCult({ ...GENERAL, name }).id, { workDir: '/w' })
      h.advance(MIN)
      return run.id
    })
    h.store.transitionRun(ids[1], { type: 'started' })
    h.store.transitionRun(ids[1], { type: 'pause' })
    h.store.transitionRun(ids[2], { type: 'abort', reason: 'failed' })
    expect(h.store.activeRunsOnStartup().map((run) => [run.id, run.state])).toEqual([[ids[0], 'starting'], [ids[1], 'paused']])
    expect(reopen(h).store.activeRunsOnStartup().map((run) => run.id)).toEqual([ids[0], ids[1]])
  })
})

describe('archetypes, slots and specialist reports', () => {
  it('persists the archetype, target epic and materialized Plan Forge slots across reopen', () => {
    const h = fromV4()
    const cult = h.store.createCult(PLAN_FORGE)
    expect(cult).toMatchObject({ archetype: 'plan_forge', targetEpicId: 'ep_target', scope: 'folder' })
    expect(cult.slots.map((slot) => slot.id)).toEqual(['ui_ux', 'implementation_engineering', 'delivery_scrum', 'security', 'quality', 'architecture_team_lead'])
    expect(reopen(h).store.getCult(cult.id)?.slots).toEqual(cult.slots)
  })

  it('rejects a Plan Forge without a target or outside a folder, and a cap below its six slots', () => {
    const h = fromV4()
    expect(codeOf(() => h.store.createCult({ ...PLAN_FORGE, targetEpicId: null }))).toBe('invalid_input')
    expect(codeOf(() => h.store.createCult({ ...PLAN_FORGE, scope: 'sanctum', folderPath: null }))).toBe('invalid_input')
    expect(codeOf(() => h.store.createCult({ ...PLAN_FORGE, defaultCap: 5 }))).toBe('invalid_input')
    expect(h.store.listCults()).toEqual([])
  })

  it('stores a member slot and worker type, and refuses duplicate coverage of a required slot', () => {
    const h = fromV4()
    const run = h.store.startRun(h.store.createCult(PLAN_FORGE).id, { workDir: '/w' })
    const sec = h.store.addMember(run.id, { chatId: 'sec', role: 'acolyte', slotId: 'security' })
    expect(sec).toMatchObject({ slotId: 'security', workerType: 'security', runWorkerTypeId: null })
    expect(codeOf(() => h.store.addMember(run.id, { chatId: 'sec2', role: 'acolyte', slotId: 'security' }))).toBe('conflict')
    expect(codeOf(() => h.store.addMember(run.id, { chatId: 'x', role: 'acolyte', slotId: 'nope' }))).toBe('invalid_input')
    h.store.updateMember(run.id, 'sec', { state: 'dismissed' })
    expect(h.store.addMember(run.id, { chatId: 'sec2', role: 'acolyte', slotId: 'security' }).workerType).toBe('security')
    const coverage = h.store.slotCoverage(run.id).find((slot) => slot.slotId === 'security')
    expect(coverage).toMatchObject({ required: true, liveMemberChatIds: ['sec2'], reportCount: 0 })
  })

  it('persists reports and refuses one from a member that does not hold the slot', () => {
    const h = fromV4()
    const run = h.store.startRun(h.store.createCult(PLAN_FORGE).id, { workDir: '/w' })
    h.store.addMember(run.id, { chatId: 'sec', role: 'acolyte', slotId: 'security' })
    h.store.addMember(run.id, { chatId: 'qa', role: 'acolyte', slotId: 'quality' })
    const report = h.store.submitReport(run.id, { memberChatId: 'sec', slotId: 'security', text: 'Threat model ok.', targetRevision: 'rv_1' })
    expect(report).toMatchObject({ slotId: 'security', memberChatId: 'sec', targetRevision: 'rv_1' })
    expect(codeOf(() => h.store.submitReport(run.id, { memberChatId: 'qa', slotId: 'security', text: 'x' }))).toBe('unauthorized')
    expect(codeOf(() => h.store.submitReport(run.id, { memberChatId: 'qa', slotId: 'quality', text: 'x'.repeat(32 * 1024 + 1) }))).toBe('invalid_input')
    const again = reopen(h)
    expect(again.store.listReports(run.id)).toEqual([report])
    expect(again.store.slotCoverage(run.id).find((slot) => slot.slotId === 'security')).toMatchObject({ reportCount: 1 })
  })

  it('materializes editable defaults so a cult keeps its roster through edits', () => {
    const h = fromV4()
    const cult = h.store.createCult({ ...GENERAL, archetype: 'delivery' })
    expect(cult.slots.map((slot) => slot.id)).toEqual(['architecture_team_lead', 'implementation_engineering', 'quality', 'delivery_scrum'])
    expect(h.store.updateCult(cult.id, { ...GENERAL, archetype: 'delivery', name: 'Renamed' }).slots).toEqual(cult.slots)
    expect(h.store.updateCult(cult.id, { ...GENERAL, name: 'General now' }).slots).toEqual([])
  })
})

const TYPE = { displayName: 'Archivist', description: 'Keeps records.', mission: 'Catalogue findings.', rationale: 'Many notes.', requiredForConclusion: false }

describe('run-scoped worker types', () => {
  it('persists types and events, and refuses built-in and duplicate names', () => {
    const h = fromV4()
    const run = h.store.startRun(h.store.createCult(GENERAL).id, { workDir: '/w' })
    h.store.addMember(run.id, { chatId: 'mg', role: 'magos' })
    const type = h.store.createWorkerType(run.id, 'mg', TYPE)
    expect(type).toMatchObject({ id: 'dyn_1', displayName: 'Archivist', creatorMemberId: 'mg', retiredAt: null })
    expect(codeOf(() => h.store.createWorkerType(run.id, 'mg', { ...TYPE, displayName: 'Security' }))).toBe('invalid_input')
    expect(codeOf(() => h.store.createWorkerType(run.id, 'mg', { ...TYPE, displayName: 'ARCHIVIST' }))).toBe('invalid_input')
    expect(codeOf(() => h.store.createWorkerType(run.id, 'ghost', { ...TYPE, displayName: 'Other' }))).toBe('not_found')
    const member = h.store.addMember(run.id, { chatId: 'ar', role: 'acolyte', runWorkerTypeId: 'dyn_1' })
    expect(member).toMatchObject({ runWorkerTypeId: 'dyn_1', slotId: null, workerType: null })
    const kinds = h.store.pageEvents(run.id).events.map((event) => event.kind)
    expect(kinds).toEqual(['summoned', 'worker_type_created', 'summoned', 'worker_type_assigned'])
  })

  it('refuses retiring a required or assigned type and a member holding both a slot and a type', () => {
    const h = fromV4()
    const run = h.store.startRun(h.store.createCult(PLAN_FORGE).id, { workDir: '/w' })
    h.store.addMember(run.id, { chatId: 'mg', role: 'magos' })
    h.store.createWorkerType(run.id, 'mg', TYPE)
    h.store.createWorkerType(run.id, 'mg', { ...TYPE, displayName: 'Gatekeeper', requiredForConclusion: true })
    h.store.addMember(run.id, { chatId: 'ar', role: 'acolyte', runWorkerTypeId: 'dyn_1' })
    expect(codeOf(() => h.store.retireWorkerType(run.id, 'dyn_2'))).toBe('invalid_state')
    h.store.updateMember(run.id, 'ar', { state: 'concluded' })
    expect(codeOf(() => h.store.retireWorkerType(run.id, 'dyn_1'))).toBe('invalid_state')
    expect(codeOf(() => h.store.retireWorkerType(run.id, 'dyn_9'))).toBe('not_found')
    const both = { chatId: 'b', role: 'acolyte' as const, slotId: 'quality', runWorkerTypeId: 'dyn_2' }
    expect(codeOf(() => h.store.addMember(run.id, both))).toBe('invalid_input')
  })

  it('keeps retired types so ids are never reused, and keeps them in history but out of the cult', () => {
    const h = fromV4()
    const cult = h.store.createCult(GENERAL)
    const run = h.store.startRun(cult.id, { workDir: '/w' })
    h.store.addMember(run.id, { chatId: 'mg', role: 'magos' })
    h.store.createWorkerType(run.id, 'mg', TYPE)
    const retired = h.store.retireWorkerType(run.id, 'dyn_1')
    expect(retired.retiredAt).not.toBeNull()
    expect(codeOf(() => h.store.retireWorkerType(run.id, 'dyn_1'))).toBe('invalid_state')
    expect(codeOf(() => h.store.addMember(run.id, { chatId: 'x', role: 'acolyte', runWorkerTypeId: 'dyn_1' }))).toBe('invalid_state')
    expect(h.store.createWorkerType(run.id, 'mg', { ...TYPE, displayName: 'Scribe' }).id).toBe('dyn_2')
    h.store.transitionRun(run.id, { type: 'shutdown', reason: 'completed' })
    h.store.transitionRun(run.id, { type: 'finish' })
    const again = reopen(h)
    expect(again.store.listWorkerTypes(run.id).map((type) => [type.id, type.retiredAt === null])).toEqual([['dyn_1', false], ['dyn_2', true]])
    expect(again.store.getCult(cult.id)?.slots).toEqual([])
    expect(again.store.pageEvents(run.id).events.map((event) => event.kind)).toContain('worker_type_retired')
  })
})
