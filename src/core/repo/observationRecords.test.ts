/**
 * DM-170 c3 (and c4 across machines): metric observations export to portable record files and import on another
 * machine with their identity and provenance intact, recover from an interrupted outbox, and never carry
 * machine-local paths, credentials or transient claim secrets.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { MetricObservation, MetricScope } from '../../shared/domain/space'
import { makeBundle, sid, tid } from '../../test/bundles'
import { copyTracked, createRepoEnv, createStubGit, flush, importerDeps, initProject, type RepoEnv, saveRevision } from '../../test/repoEnv'
import { domainErrorOf, idOf, insertAttempt, insertOutbox, insertRun } from '../../test/repoFixtures'
import { createTestCtx, type TestCtx } from '../../test/testContext'
import { canonicalJson, prettyJson } from '../canonical'
import { encodeBase32, ID_PREFIXES, type IdGenerator } from '../ids'
import { adoptRevision } from '../services/adoption'
import { listObservations, type ObservationInput, recordObservations } from '../services/observations'
import { reconcileRepository } from './importer'
import { ownedPaths } from './paths'
import { buildObservationRecord } from './portable'

const LEGACY_DIR = fileURLToPath(new URL('./__mocks__/legacy/', import.meta.url))
const EPIC = 'ep_01m3txy30qavmd5wewct90804g'
const REVISION = 'rv_01m3txzpv9ws6fbj6p211ghkn9'
const RUN = 'rn_01m3txzt9wj79mxsq50f5ktf1q'
const ATTEMPT = 'at_01m7gh00000000000000000001'
const SECRET = 'Zq9xY2kLmN3pQr7sTu1vWx5yZa8bCd0e'
const CLAIM_TOKEN = `${ATTEMPT}.${SECRET}`

function legacyText(...parts: string[]): string {
  return readFileSync(join(LEGACY_DIR, ...parts), 'utf8').replace(/\r\n/g, '\n')
}

function legacyClone(root: string): RepoEnv {
  const env = createRepoEnv({ root })
  initProject(env)
  const paths = ownedPaths(env.layout)
  env.fs.put(join(env.layout.dmDir, 'project.json'), legacyText('project.json'))
  env.fs.put(paths.epicPointerFile(EPIC), legacyText('epics', EPIC, 'current.json'))
  env.fs.put(paths.epicStateFile(EPIC), legacyText('epics', EPIC, 'state.json'))
  env.fs.put(paths.snapshotFile(EPIC, REVISION), legacyText('epics', EPIC, 'snapshots', `${REVISION}.json`))
  env.fs.put(paths.runHistoryFile(RUN), legacyText('history', RUN, 'run.json'))
  return env
}

interface Machine {
  env: RepoEnv
  ctx: TestCtx
  base: ObservationInput
}

/** Machine A: the legacy repository reconciled, with a running attempt holding a live claim secret. */
function machineA(ids?: IdGenerator): Machine {
  const env = legacyClone('/machine-a')
  reconcileRepository(importerDeps(env, createStubGit()))
  env.clock.set('2026-11-15T12:00:00.000Z')
  const ctx = createTestCtx({ db: env.db, clock: env.clock, ...(ids === undefined ? {} : { ids }) })
  const ticketId = env.db.get<{ ticket_id: string }>('SELECT ticket_id FROM attempts ORDER BY id LIMIT 1')?.ticket_id ?? ''
  insertAttempt(env.db, { id: ATTEMPT, runId: RUN, ticketId, revisionId: REVISION, number: 9, state: 'running', claimSecret: SECRET })
  insertOutbox(env.db, { kind: 'run_history', epicId: EPIC, runId: RUN })
  const base: ObservationInput = {
    metric: 'tokens_input',
    unit: 'tokens',
    scope: { level: 'attempt', epicId: EPIC, sprintId: null, runId: RUN, ticketId, attemptId: ATTEMPT },
    source: { kind: 'host', actor: 'ss_01m7gh00000000000000000007' },
    measurement: { state: 'observed', value: 182000 },
    accumulation: 'cumulative',
    sequence: 4,
    observedAt: '2026-11-15T11:59:58.000Z',
    attributes: { provider: 'anthropic', includesCachedInput: true },
    evidence: [{ kind: 'attempt', id: ATTEMPT, detail: 'live claim' }],
    usage: { coverage: 'inclusive', parentActor: null }
  }
  return { env, ctx, base }
}

function machineB(): RepoEnv {
  return legacyClone('/machine-b')
}

function idNo(n: number): string {
  return `mo_01m7gg${String(n).padStart(20, '0')}`
}

/** One attempt-level, one epic-level and one project-level (unknown) observation. */
function recordThree(a: Machine): void {
  recordObservations(a.ctx, [
    { ...a.base, observationId: idNo(1) },
    {
      ...a.base,
      observationId: idNo(2),
      metric: 'human_rating',
      unit: 'rating_1_5',
      accumulation: 'event',
      sequence: null,
      scope: { level: 'epic', epicId: EPIC, sprintId: null, runId: null, ticketId: null, attemptId: null },
      source: { kind: 'human', actor: 'desktop' },
      measurement: { state: 'observed', value: 4 },
      attributes: { question: 'confidence' },
      evidence: [],
      usage: undefined
    },
    {
      ...a.base,
      observationId: idNo(3),
      metric: 'tokens_total',
      accumulation: 'delta',
      sequence: null,
      scope: { level: 'project', epicId: null, sprintId: null, runId: null, ticketId: null, attemptId: null },
      source: { kind: 'host', actor: 'codex-adapter' },
      measurement: { state: 'missing', reason: 'host_unavailable' },
      attributes: { bucket: 'project_overhead' },
      evidence: [],
      usage: undefined
    }
  ])
}

function observationFiles(env: RepoEnv): [string, string][] {
  return [...env.fs.files()].filter(([path]) => path.split(/[\\/]/).includes('observations'))
}

/** Plants in B's epic folder a copy of A's observation 1 under id `n`, changed by `change`. */
function plant(a: Machine, b: RepoEnv, n: number, change: (o: MetricObservation) => object): void {
  const record = buildObservationRecord(a.env.db, idNo(1))
  const file = ownedPaths(b.layout).observationFile(EPIC, idNo(n))
  b.fs.put(file, prettyJson({ ...record, observation: change({ ...record.observation, observationId: idNo(n) }) }))
}

/** Ids that count down, so ids allocated later sort first unless the ledger orders them. */
function descendingIds(): IdGenerator {
  let counter = 1_000_000
  return {
    next(kind) {
      counter -= 1
      return `${ID_PREFIXES[kind]}_${encodeBase32(BigInt(counter), 26)}`
    },
    secret: () => 'secret'
  }
}

describe('DM-170 c3: machine-local paths, credentials and claim secrets never reach the ledger', () => {
  const attr = (a: Machine, attributes: ObservationInput['attributes']): ObservationInput => ({ ...a.base, attributes })
  const CASES: [string, (a: Machine) => ObservationInput][] = [
    ['an attribute holding the live claim token', (a) => attr(a, { note: CLAIM_TOKEN })],
    ['evidence detail holding the claim token', (a) => ({ ...a.base, evidence: [{ kind: 'attempt', id: ATTEMPT, detail: CLAIM_TOKEN }] })],
    ['an attribute named like a credential', (a) => attr(a, { apiKey: 'x' })],
    ['a provider key', (a) => attr(a, { provider: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA' })],
    ['a grant token', (a) => attr(a, { grant: `dmg_${'a'.repeat(64)}` })],
    ['a Windows path of this machine', (a) => attr(a, { log: 'C:\\Users\\dev\\.claude\\projects\\x.jsonl' })],
    ['a macOS home path', (a) => attr(a, { log: '/Users/dev/.codex/sessions/1.jsonl' })],
    ['a local path as the actor', (a) => ({ ...a.base, source: { kind: 'host', actor: '/home/dev/agent.sock' } })],
    ['a Git Bash drive path', (a) => attr(a, { log: '/c/Users/dev/.claude/x.jsonl' })],
    ['a $HOME path', (a) => attr(a, { log: '$HOME/.codex/log' })],
    ['a %USERPROFILE% path', (a) => attr(a, { log: '%USERPROFILE%\\.claude\\x' })],
    ['a password=… value', (a) => attr(a, { note: 'password=hunter2' })],
    ['a bare JWT', (a) => attr(a, { note: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl' })],
    ['a transcript attribute', (a) => attr(a, { transcript: 'user: hi' })],
    ['multi-line chat text', (a) => attr(a, { note: 'user: fix it\nassistant: done' })]
  ]

  it.each(CASES)('%s is invalid_input and nothing is stored', (_label, input) => {
    const a = machineA()
    expect(domainErrorOf(() => recordObservations(a.ctx, [input(a)])).code).toBe('invalid_input')
    expect(listObservations(a.env.db)).toEqual([])
  })

  it('ordinary text (a ratio, a rate, a public URL) is not mistaken for a path', () => {
    const a = machineA()
    const plain = recordObservations(a.ctx, [{ ...a.base, attributes: { note: 'ratio a:/b', unit: 'tokens/minute', docs: 'https://example.com/docs/usage' } }])
    expect(plain.created).toHaveLength(1)
  })
})

describe('DM-170 c3: exported record files keep identity and provenance only', () => {
  it('each file holds format, formatVersion and the observation, without secrets, the machine id or local paths', () => {
    const a = machineA()
    recordThree(a)
    expect(flush(a.env).failed).toBe(0)
    const files = observationFiles(a.env)
    const paths = ownedPaths(a.env.layout)
    expect(files.map(([path]) => path).sort()).toEqual([paths.observationFile(EPIC, idNo(1)), paths.observationFile(EPIC, idNo(2)), paths.observationFile(null, idNo(3))].sort())
    for (const [, text] of files) {
      expect(Object.keys(JSON.parse(text)).sort()).toEqual(['format', 'formatVersion', 'observation'])
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain(a.ctx.machineId)
      expect(text).not.toContain('machine-a')
    }
    const runText = a.env.fs.get(paths.runHistoryFile(RUN)) ?? ''
    expect(runText).toContain(ATTEMPT)
    expect(runText).not.toContain(SECRET)
  })
})

describe('DM-170 c3: interrupted-outbox recovery', () => {
  it('a failed write leaves no file and the entry pending; the retry exports it', () => {
    const a = machineA()
    recordThree(a)
    const file = ownedPaths(a.env.layout).observationFile(EPIC, idNo(1))
    a.env.fs.failOn({ op: 'rename', match: (path) => path === file })
    expect(flush(a.env).failed).toBe(1)
    const entry = a.env.db.get<{ state: string; attempts: number }>("SELECT state, attempts FROM outbox WHERE kind = 'metric_observation' AND entity_id = ?", idNo(1))
    expect(entry).toEqual({ state: 'pending', attempts: 1 })
    expect(a.env.fs.get(file)).toBeUndefined()
    expect(a.env.fs.get(ownedPaths(a.env.layout).observationFile(null, idNo(3)))).toBeDefined()
    expect(flush(a.env).failed).toBe(0)
    expect(a.env.fs.get(file)).toBe(prettyJson(buildObservationRecord(a.env.db, idNo(1))))
  })

  it('a crash after the write but before the commit completes over the file already written', () => {
    const a = machineA()
    recordObservations(a.ctx, [{ ...a.base, observationId: idNo(4) }])
    const file = ownedPaths(a.env.layout).observationFile(EPIC, idNo(4))
    a.env.fs.put(file, prettyJson(buildObservationRecord(a.env.db, idNo(4))))
    expect(flush(a.env).failed).toBe(0)
    const synced = a.env.db.get<{ exported_hash: string | null }>("SELECT exported_hash FROM sync_state WHERE kind = 'metric_observation' AND entity_id = ?", idNo(4))
    expect(typeof synced?.exported_hash).toBe('string')
  })

  it('a different file under the same id is never overwritten', () => {
    const a = machineA()
    recordObservations(a.ctx, [{ ...a.base, observationId: idNo(5) }])
    const file = ownedPaths(a.env.layout).observationFile(EPIC, idNo(5))
    const record = buildObservationRecord(a.env.db, idNo(5))
    const foreign = prettyJson({ ...record, observation: { ...record.observation, sequence: 99 } })
    a.env.fs.put(file, foreign)
    expect(flush(a.env).failed).toBe(1)
    expect(a.env.fs.get(file)).toBe(foreign)
  })
})

describe('DM-170 c3: another machine imports the same observations', () => {
  it('ids, recordedAt, scope, source, measurement and provenance are identical, and a second reconcile imports nothing', () => {
    const a = machineA()
    recordThree(a)
    flush(a.env)
    const b = machineB()
    copyTracked(a.env, b)
    const deps = importerDeps(b, createStubGit())
    const first = reconcileRepository(deps)
    expect(first.rejected).toEqual([])
    expect(first.imported).toEqual(expect.arrayContaining([idNo(1), idNo(2), idNo(3)]))
    expect(canonicalJson(listObservations(b.db))).toBe(canonicalJson(listObservations(a.env.db)))
    expect(listObservations(b.db).find((o) => o.observationId === idNo(3))?.measurement).toEqual({ state: 'missing', reason: 'host_unavailable' })
    expect(reconcileRepository(deps)).toMatchObject({ imported: [], rejected: [] })
  })

  it('hostile or conflicting files are each rejected and B keeps exactly what A recorded', () => {
    const a = machineA()
    recordThree(a)
    flush(a.env)
    const b = machineB()
    copyTracked(a.env, b)
    const deps = importerDeps(b, createStubGit())
    reconcileRepository(deps)
    plant(a, b, 60, (o) => ({ ...o, attributes: { note: CLAIM_TOKEN } }))
    plant(a, b, 61, (o) => ({ ...o, attributes: { log: '/Users/dev/.claude/projects/x.jsonl' } }))
    plant(a, b, 62, (o) => ({ ...o, attributes: { authToken: 'abc' } }))
    plant(a, b, 63, (o) => ({ ...o, scope: { ...o.scope, attemptId: 'at_01m7gh00000000000000000099' } }))
    const changedFile = ownedPaths(b.layout).observationFile(EPIC, idNo(2))
    const two = buildObservationRecord(a.env.db, idNo(2))
    b.fs.put(changedFile, prettyJson({ ...two, observation: { ...two.observation, measurement: { state: 'observed', value: 5 } } }))
    const hostile = reconcileRepository(deps)
    expect(hostile.rejected.map((item) => item.path).sort()).toEqual([2, 60, 61, 62, 63].map((n) => `.darkmechanicus/epics/${EPIC}/observations/${idNo(n)}.json`))
    expect(hostile.imported).toEqual([])
    expect(canonicalJson(listObservations(b.db))).toBe(canonicalJson(listObservations(a.env.db)))
  })
})

describe('DM-170 c3: imports never leave dangling or self citations', () => {
  it('an import never leaves a dangling or self citation, and cites across files in any order', () => {
    const a = machineA()
    recordThree(a)
    flush(a.env)
    const b = machineB()
    copyTracked(a.env, b)
    const deps = importerDeps(b, createStubGit())
    reconcileRepository(deps)
    plant(a, b, 70, (o) => ({ ...o, scope: { ...o.scope, attemptId: 'at_01m7gh00000000000000000098' } }))
    plant(a, b, 71, (o) => ({ ...o, evidence: [{ kind: 'observation', id: idNo(70), detail: null }] }))
    plant(a, b, 72, (o) => ({ ...o, evidence: [{ kind: 'observation', id: idNo(73), detail: null }] }))
    plant(a, b, 73, (o) => o)
    plant(a, b, 74, (o) => ({ ...o, evidence: [{ kind: 'observation', id: idNo(74), detail: null }] }))
    const result = reconcileRepository(deps)
    const rejected = result.rejected.map((item) => item.path.split(/[\\/]/).pop())
    expect(rejected.sort()).toEqual([idNo(70), idNo(71), idNo(74)].map((id) => `${id}.json`))
    expect(result.imported.sort()).toEqual([idNo(72), idNo(73)])
  })
})

describe('DM-170 c3: one observation id has one record across machines and folders', () => {
  it('one delivery recorded on both machines keeps each machine’s row and the first file', () => {
    const a = machineA()
    const b = machineB()
    reconcileRepository(importerDeps(b, createStubGit()))
    insertAttempt(b.db, { id: ATTEMPT, runId: RUN, ticketId: a.base.scope.ticketId ?? '', revisionId: REVISION, number: 9, state: 'running', claimSecret: SECRET })
    b.clock.set('2026-11-15T12:30:00.000Z')
    const delivery: ObservationInput = { ...a.base, observationId: idNo(80) }
    recordObservations(createTestCtx({ db: b.db, clock: b.clock }), [delivery])
    recordObservations(a.ctx, [delivery])
    expect(flush(a.env).failed).toBe(0)
    copyTracked(a.env, b)
    const pulled = reconcileRepository(importerDeps(b, createStubGit()))
    expect(pulled.rejected.filter((item) => item.path.includes(idNo(80)))).toEqual([])
    expect(listObservations(b.db).find((o) => o.observationId === idNo(80))?.recordedAt).toBe('2026-11-15T12:30:00.000Z')
    const file = ownedPaths(b.layout).observationFile(EPIC, idNo(80))
    expect(flush(b).failed).toBe(0)
    expect(b.fs.get(file)).toBe(a.env.fs.get(ownedPaths(a.env.layout).observationFile(EPIC, idNo(80))))
  })

  it('one id in two folders is a conflict on both files, and neither is stored', () => {
    const a = machineA()
    recordThree(a)
    flush(a.env)
    const b = machineB()
    copyTracked(a.env, b)
    const deps = importerDeps(b, createStubGit())
    reconcileRepository(deps)
    const project = buildObservationRecord(a.env.db, idNo(3))
    const atTop = ownedPaths(b.layout).observationFile(null, idNo(90))
    b.fs.put(atTop, prettyJson({ ...project, observation: { ...project.observation, observationId: idNo(90) } }))
    plant(a, b, 90, (o) => o)
    const twice = reconcileRepository(deps).rejected.filter((item) => item.path.includes(idNo(90)))
    expect(twice.map((item) => item.path).sort()).toEqual([`.darkmechanicus/epics/${EPIC}/observations/${idNo(90)}.json`, `.darkmechanicus/observations/${idNo(90)}.json`])
    for (const item of twice) {
      expect(item.message).toContain('one observation has one record')
      expect(item.message).not.toContain('UNIQUE')
    }
    expect(listObservations(b.db).filter((o) => o.observationId === idNo(90))).toEqual([])
  })
})

describe('DM-170 c3: same-call order and citations survive export and import', () => {
  it('server ids of one call, allocated in one instant, read back in call order on both machines', () => {
    const a = machineA(descendingIds())
    const step = (action: string, round: number): ObservationInput => ({
      ...a.base,
      metric: 'activity_volume',
      unit: 'count',
      accumulation: 'event',
      sequence: null,
      source: { kind: 'host', actor: 'claude-code-adapter' },
      measurement: { state: 'observed', value: 1 },
      attributes: { action, round },
      evidence: [],
      usage: undefined
    })
    recordObservations(a.ctx, [step('reported', 0), step('withdrawn', 0), step('reopened', 0)])
    recordObservations(a.ctx, [step('reported', 1), step('withdrawn', 1)])
    expect(flush(a.env).failed).toBe(0)
    const b = machineB()
    copyTracked(a.env, b)
    expect(reconcileRepository(importerDeps(b, createStubGit())).rejected).toEqual([])
    const expected = ['0:reported', '0:withdrawn', '0:reopened', '1:reported', '1:withdrawn']
    const readOrder = (env: RepoEnv) => listObservations(env.db).map((o) => `${String(o.attributes.round)}:${String(o.attributes.action)}`)
    expect(readOrder(a.env)).toEqual(expected)
    expect(readOrder(b)).toEqual(expected)
  })

  it('a forward citation chain of one call (each citing a later entry) imports cleanly on another machine', () => {
    const a = machineA()
    const ref = (n: number) => [{ kind: 'observation' as const, id: idNo(n), detail: 'later in the call' }]
    recordObservations(a.ctx, [
      { ...a.base, observationId: idNo(10), evidence: ref(11) },
      { ...a.base, observationId: idNo(11), evidence: ref(12) },
      { ...a.base, observationId: idNo(12) }
    ])
    expect(flush(a.env).failed).toBe(0)
    const b = machineB()
    copyTracked(a.env, b)
    const result = reconcileRepository(importerDeps(b, createStubGit()))
    expect(result.rejected).toEqual([])
    expect(result.imported.filter((id) => id.startsWith('mo_')).sort()).toEqual([idNo(10), idNo(11), idNo(12)])
    expect(canonicalJson(listObservations(b.db))).toBe(canonicalJson(listObservations(a.env.db)))
  })
})

const ADOPT = {
  epicId: idOf('epic', 1),
  r1: idOf('revision', 1),
  r2: idOf('revision', 2),
  runId: idOf('run', 1),
  rejectedTry: idOf('attempt', 2),
  supersededTry: idOf('attempt', 3)
}

/** A run on revision 1 (sprint 1 = {1, 2}, sprint 2 = {3}); ticket 2 rejected once, then accepted. */
function adoptionWorld(): { a: RepoEnv; ctx: TestCtx } {
  const { epicId, r1, runId } = ADOPT
  const a = createRepoEnv({ root: '/adopt-a' })
  initProject(a)
  const ctx = createTestCtx({ db: a.db, clock: a.clock })
  saveRevision(a, { epicId, revisionId: r1, number: 1, bundle: makeBundle([[1, 2], [3]]) })
  insertRun(a.db, { id: runId, epicId, revisionId: r1, state: 'awaiting_checkpoint', activeSprintId: sid(1), ownerMachineId: ctx.machineId })
  insertAttempt(a.db, { id: idOf('attempt', 1), runId, ticketId: tid(1), revisionId: r1, state: 'accepted' })
  insertAttempt(a.db, { id: ADOPT.rejectedTry, runId, ticketId: tid(2), revisionId: r1, number: 1, state: 'rejected' })
  insertAttempt(a.db, { id: ADOPT.supersededTry, runId, ticketId: tid(2), revisionId: r1, number: 2, state: 'accepted' })
  a.db.run("UPDATE ticket_status SET status = 'completed' WHERE ticket_id IN (?, ?)", tid(1), tid(2))
  insertOutbox(a.db, { kind: 'run_history', epicId, runId })
  return { a, ctx }
}

function ticketTwoScope(attemptId: string | null, sprint: number | null = 1): MetricScope {
  const level = attemptId === null ? 'ticket' : 'attempt'
  return { level, epicId: ADOPT.epicId, sprintId: sprint === null ? null : sid(sprint), runId: ADOPT.runId, ticketId: tid(2), attemptId }
}

function outputUsage(scope: MetricScope, value: number): ObservationInput {
  return {
    metric: 'tokens_output',
    unit: 'tokens',
    scope,
    source: { kind: 'host', actor: 'claude-code-adapter' },
    measurement: { state: 'observed', value },
    accumulation: 'delta',
    sequence: null,
    observedAt: '2026-01-01T00:00:00.000Z',
    attributes: {},
    evidence: []
  }
}

describe('DM-170 c4: work stays attributable after adopting a revision that removes its ticket', () => {
  it('rejected, superseded and ticket-level usage of the removed ticket is recorded and imports on another machine', () => {
    const { a, ctx } = adoptionWorld()
    const { rejectedTry, supersededTry } = ADOPT
    recordObservations(ctx, [outputUsage(ticketTwoScope(rejectedTry), 900), outputUsage(ticketTwoScope(supersededTry), 1500)])
    saveRevision(a, { epicId: ADOPT.epicId, revisionId: ADOPT.r2, number: 2, bundle: makeBundle([[1], [3]]), baseRevisionId: ADOPT.r1 })
    expect(adoptRevision(ctx, { reason: 'Test adoption: the plan changed mid-run.', runId: ADOPT.runId, revisionId: ADOPT.r2 }).superseded).toContain(tid(2))
    a.clock.advanceSeconds(60)
    const wait: ObservationInput = {
      ...outputUsage(ticketTwoScope(null), 0),
      metric: 'wait_ms',
      unit: 'milliseconds',
      accumulation: 'event',
      source: { kind: 'server', actor: null },
      measurement: { state: 'observed', value: 60000 },
      attributes: { waitKind: 'review' }
    }
    const after = recordObservations(ctx, [outputUsage(ticketTwoScope(rejectedTry), 300), outputUsage(ticketTwoScope(supersededTry), 200), wait])
    expect(after.created).toHaveLength(3)
    expect(flush(a).failed).toBe(0)

    const b = createRepoEnv({ root: '/adopt-b' })
    initProject(b)
    copyTracked(a, b)
    expect(reconcileRepository(importerDeps(b, createStubGit())).rejected).toEqual([])
    expect(canonicalJson(listObservations(b.db))).toBe(canonicalJson(listObservations(a.db)))
    expect(listObservations(b.db, { ticketId: tid(2) }).map((o) => o.scope.attemptId)).toEqual([rejectedTry, supersededTry, rejectedTry, supersededTry, null])
  })

  it('membership is still checked against the revision the attempt ran under, and against saved plans for ticket scope', () => {
    const { ctx } = adoptionWorld()
    expect(domainErrorOf(() => recordObservations(ctx, [outputUsage(ticketTwoScope(ADOPT.rejectedTry, 2), 1)])).code).toBe('invalid_input')
    const unknownTicket = { ...ticketTwoScope(null, null), ticketId: tid(9) }
    expect(domainErrorOf(() => recordObservations(ctx, [outputUsage(unknownTicket, 1)])).code).toBe('not_found')
  })
})
