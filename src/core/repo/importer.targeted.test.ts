/**
 * A reconcile reads only the records git reports as changed since the last one (plus conflicts, rejections and recent
 * exports), and leaves the database exactly as reading every record would.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ReconcileResultView } from '../../shared/domain/views'
import { makeBundle } from '../../test/bundles'
import { kanbanSessions, type KanbanSessions } from '../../test/kanbanFixtures'
import { flush, saveRevision } from '../../test/repoEnv'
import { idOf, insertComment, insertOutbox, insertProfile, insertRun } from '../../test/repoFixtures'
import { createSaveHook } from '../../test/repoFixtures'
import { comparedResult, comparedState, createTargetedWorld, disk, type Target, type TargetedWorld } from '../../test/targetedReconcileWorld'
import { createSequentialIds, createTestCtx } from '../../test/testContext'
import { getMeta, META_KEYS, readReconcileMarker, setMeta } from '../meta'
import { recordObservations, type ObservationInput } from '../services/observations'
import { createKanbanCard, updateKanbanCard } from '../services/kanban/cards'
import { flushOutbox } from './finalizer'
import { IMPORTER_VERSION } from './gitChanges'

const SOURCE_MACHINE = idOf('machine', 1)

const worlds: TargetedWorld[] = []
afterEach(() => {
  for (const world of worlds.splice(0)) world.cleanup()
})

function world(): TargetedWorld {
  const created = createTargetedWorld()
  worlds.push(created)
  return created
}

/** The source machine's records, written as it would export them. */
class Source {
  readonly sessions: KanbanSessions
  private readonly revisions = new Map<string, number>()
  private counter = 0

  constructor(readonly w: TargetedWorld) {
    this.sessions = kanbanSessions(w.source, { machineId: SOURCE_MACHINE })
  }

  private next(): number {
    this.counter += 1
    this.w.source.clock.advanceSeconds(1)
    return this.counter
  }

  epics(): string[] {
    return [...this.revisions.keys()]
  }

  saveEpic(epicId = idOf('epic', this.next())): string {
    const number = (this.revisions.get(epicId) ?? 0) + 1
    const n = this.next()
    const base = number === 1 ? null : this.w.source.db.get<{ current_revision_id: string }>('SELECT current_revision_id FROM epics WHERE id = ?', epicId)?.current_revision_id ?? null
    saveRevision(this.w.source, { epicId, revisionId: idOf('revision', n), number, bundle: makeBundle([[1, 2, 3 + (n % 3)]], [[1, 2]]), baseRevisionId: base })
    this.revisions.set(epicId, number)
    this.w.mirror()
    return epicId
  }

  comment(epicId: string): string {
    const commentId = idOf('comment', this.next())
    insertComment(this.w.source.db, { id: commentId, epicId, body: `Note ${commentId}` })
    insertOutbox(this.w.source.db, { kind: 'comment', epicId, entityId: commentId })
    this.flushAndMirror()
    return commentId
  }

  run(epicId: string): string {
    const runId = idOf('run', this.next())
    const revisionId = this.w.source.db.get<{ current_revision_id: string }>('SELECT current_revision_id FROM epics WHERE id = ?', epicId)?.current_revision_id ?? ''
    const number = (this.w.source.db.get<{ n: number }>('SELECT count(*) AS n FROM runs WHERE epic_id = ?', epicId)?.n ?? 0) + 1
    insertRun(this.w.source.db, { id: runId, epicId, revisionId, number, ownerMachineId: SOURCE_MACHINE, state: 'completed' })
    insertOutbox(this.w.source.db, { kind: 'run_history', epicId, runId })
    this.flushAndMirror()
    return runId
  }

  card(): string {
    this.next()
    const card = createKanbanCard(this.sessions.desktop, { title: `Card ${this.counter}`, acceptanceCriteria: ['It works'] })
    this.flushAndMirror()
    return card.id
  }

  editCard(cardId: string): void {
    const revision = this.w.source.db.get<{ revision: number }>('SELECT revision FROM kanban_cards WHERE id = ?', cardId)?.revision ?? 0
    this.next()
    updateKanbanCard(this.sessions.desktop, { cardId, expectedRevision: revision, title: `Card ${cardId} edit ${this.counter}` })
    this.flushAndMirror()
  }

  profile(name: string): void {
    const n = this.next()
    this.w.source.db.run('DELETE FROM profiles WHERE name = ?', name)
    insertProfile(this.w.source.db, { name, description: `Profile ${n}`, updatedAt: this.w.source.clock.nowIso() })
    insertOutbox(this.w.source.db, { kind: 'profile', entityId: name })
    this.flushAndMirror()
  }

  observation(): void {
    const n = this.next()
    const input: ObservationInput = {
      observationId: idOf('metricObservation', n),
      metric: 'tokens_total',
      unit: 'tokens',
      scope: { level: 'project', epicId: null, sprintId: null, runId: null, ticketId: null, attemptId: null },
      source: { kind: 'host', actor: 'codex-adapter' },
      measurement: { state: 'missing', reason: 'host_unavailable' },
      accumulation: 'delta',
      sequence: null,
      observedAt: this.w.source.clock.nowIso(),
      attributes: { bucket: 'project_overhead' },
      evidence: []
    }
    recordObservations(createTestCtx({ db: this.w.source.db, clock: this.w.source.clock }), [input])
    this.flushAndMirror()
  }

  private flushAndMirror(): void {
    expect(flush(this.w.source).failed).toBe(0)
    this.w.mirror()
  }
}

function epicFiles(target: Target, epicId: string): string[] {
  return target.fs.reads.filter((path) => path.startsWith(`epics/${epicId}/`))
}

/** Reads of record bodies (everything but `project.json`, which every reconcile reads). */
function bodyReads(target: Target): string[] {
  return target.fs.reads.filter((path) => path !== 'project.json')
}

describe('the reconcile marker', () => {
  it('records the commit the status saw, the importer version and the paths it reported, only after an apply', () => {
    const w = world()
    const source = new Source(w)
    const epic = source.saveEpic()
    const head = w.commit()
    source.card()
    const target = w.target()
    expect(readReconcileMarker(target.db)).toEqual({ baseCommit: null, importerVersion: null, dirtyPaths: null })
    expect(target.reconcile().rejected).toEqual([])
    const marker = readReconcileMarker(target.db)
    expect(marker.baseCommit).toBe(head)
    expect(marker.importerVersion).toBe(IMPORTER_VERSION)
    expect(marker.dirtyPaths?.every((path) => path.startsWith('kanban/'))).toBe(true)
    expect(marker.dirtyPaths?.length).toBeGreaterThan(0)
    expect(target.db.get('SELECT id FROM epics WHERE id = ?', epic)).toEqual({ id: epic })
  })

  it('keeps the previous marker when the reconcile throws', () => {
    const w = world()
    new Source(w).saveEpic()
    const first = w.commit()
    const target = w.target()
    target.reconcile()
    new Source(w).saveEpic(idOf('epic', 900))
    w.commit()
    setMeta(target.db, META_KEYS.projectId, 'pj_00000000000000000000000999')
    expect(() => target.reconcile()).toThrow(/does not match/)
    expect(readReconcileMarker(target.db).baseCommit).toBe(first)
  })

  it('removes the marker when git cannot say where the checkout is, so the next reconcile reads everything', () => {
    const w = world()
    new Source(w).saveEpic()
    w.commit()
    const target = w.target()
    target.reconcile()
    target.reconcileWith((deps) => ({ ...deps, git: { ...deps.git, statusPaths: () => ({ ok: false, reason: 'git_failed' }) } }))
    expect(getMeta(target.db, META_KEYS.reconcileBaseCommit)).toBeNull()
  })
})

describe('a targeted reconcile reads only what changed', () => {
  it('reads no record body when nothing changed, and only the edited card after a commit that edits one card', () => {
    const w = world()
    const source = new Source(w)
    source.saveEpic()
    const cards = [source.card(), source.card(), source.card()]
    w.commit()
    const target = w.target()
    target.reconcile()
    const first = readReconcileMarker(target.db).baseCommit
    target.fs.reads.length = 0
    expect(target.reconcile().imported).toEqual([])
    expect(bodyReads(target)).toEqual([])

    source.editCard(cards[1] ?? '')
    const second = w.commit()
    target.fs.reads.length = 0
    expect(target.reconcile().imported).toEqual([`kanban:${cards[1]}`])
    expect(new Set(bodyReads(target).map((path) => path.split('/').slice(0, 2).join('/')))).toEqual(new Set([`kanban/${cards[1]}`]))
    expect(readReconcileMarker(target.db).baseCommit).toBe(second)
    expect(second).not.toBe(first)
  })

  it('after a commit touching one epic reads only that epic and the rejection it keeps re-checking', () => {
    const w = world()
    const source = new Source(w)
    const [a, b] = [source.saveEpic(), source.saveEpic()]
    disk.write(w, 'profiles/broken.json', '{ not json')
    w.commit()
    const target = w.target()
    expect(target.reconcile().rejected.map((rejection) => rejection.path)).toEqual(['.darkmechanicus/profiles/broken.json'])
    source.saveEpic(a)
    w.commit()
    target.fs.reads.length = 0
    const result = target.reconcile()
    expect(result.imported).toEqual([a])
    expect(result.rejected.map((rejection) => rejection.path)).toEqual(['.darkmechanicus/profiles/broken.json'])
    expect(epicFiles(target, b)).toEqual([])
    expect(bodyReads(target).filter((path) => !path.startsWith(`epics/${a}/`))).toEqual(['profiles/broken.json'])
  })
})

describe('conflicts and rejections are re-checked until their files are fixed', () => {
  it('clears a stored epic conflict once its file is fixed, without reading the other records', () => {
    const w = world()
    const source = new Source(w)
    const [a, b] = [source.saveEpic(), source.saveEpic()]
    w.commit()
    const target = w.target()
    target.reconcile()
    const good = disk.read(w, `epics/${a}/state.json`)
    // A pending local change and a changed tracked record: the epic is in conflict.
    insertOutbox(target.db, { kind: 'epic_state', epicId: a })
    disk.write(w, `epics/${a}/state.json`, good.replace('"title"', '"title" ').replace(/\n$/, ' \n'))
    expect(target.reconcile().conflicts.map((conflict) => conflict.epicId)).toEqual([a])
    target.db.run("DELETE FROM outbox WHERE kind = 'epic_state'")
    disk.write(w, `epics/${a}/state.json`, good)
    target.fs.reads.length = 0
    expect(target.reconcile().conflicts).toEqual([])
    expect(target.db.get("SELECT conflict FROM sync_state WHERE kind = 'epic' AND entity_id = ?", a)).toEqual({ conflict: null })
    expect(epicFiles(target, b)).toEqual([])
  })

  it('re-reads a rejected card until its file is fixed, then clears the rejection', () => {
    const w = world()
    const source = new Source(w)
    const [good, bad] = [source.card(), source.card()]
    w.commit()
    const card = disk.read(w, `kanban/${bad}/card.json`)
    disk.write(w, `kanban/${bad}/card.json`, '<<<<<<< HEAD\n')
    w.commit()
    const target = w.target()
    expect(target.reconcile().rejected.map((rejection) => rejection.path)).toEqual([`.darkmechanicus/kanban/${bad}`])
    target.fs.reads.length = 0
    expect(target.reconcile().rejected).toHaveLength(1)
    expect(bodyReads(target).every((path) => path.startsWith(`kanban/${bad}/`))).toBe(true)
    disk.write(w, `kanban/${bad}/card.json`, card)
    target.fs.reads.length = 0
    const fixed = target.reconcile()
    expect([fixed.rejected, fixed.imported]).toEqual([[], [`kanban:${bad}`]])
    expect(bodyReads(target).some((path) => path.startsWith(`kanban/${good}/`))).toBe(false)
  })
})

describe('falling back to a full reconcile', () => {
  it('reads everything when the marker is corrupt or history was rewritten, and converges', () => {
    const w = world()
    const source = new Source(w)
    const epics = [source.saveEpic(), source.saveEpic()]
    w.commit()
    const [target, twin] = [w.target(), w.target()]
    target.reconcile()
    twin.reconcile(true)
    setMeta(target.db, META_KEYS.reconcileDirtyPaths, '{"not":"a list"}')
    target.fs.reads.length = 0
    target.reconcile()
    for (const epicId of epics) expect(epicFiles(target, epicId).length).toBeGreaterThan(0)

    // Rewrite history: the marker's commit is no longer an ancestor of HEAD.
    source.saveEpic(epics[0])
    w.git_('add', '-A')
    w.git_('commit', '-q', '--amend', '-m', 'rewritten')
    target.fs.reads.length = 0
    const result = target.reconcile()
    expect(result.imported).toEqual([epics[0]])
    expect(comparedResult(result)).toEqual(comparedResult(twin.reconcile(true)))
    for (const epicId of epics) expect(epicFiles(target, epicId).length).toBeGreaterThan(0)
    expect(comparedState(target.db)).toEqual(comparedState(twin.db))
  })
})

describe('a reverted export', () => {
  it('re-reads a card this database exported and someone reverted before the next reconcile', () => {
    const w = world()
    const source = new Source(w)
    const cardId = source.card()
    w.commit()
    const targets = [w.target(), w.target()]
    for (const target of targets) target.reconcile(true)
    for (const target of targets) {
      // The same edit on both, exported over the same file.
      const ctx = createTestCtx({ db: target.db, clock: target.clock, role: 'desktop', machineId: 'mc_0000000000000000000000000t', ids: createSequentialIds() })
      updateKanbanCard(ctx, { cardId, expectedRevision: 1, title: 'Edited here' })
      flushOutbox({ db: target.db, layout: w.layout, fs: target.fs, clock: target.clock }, createSaveHook(target.db, target.clock))
    }
    w.git_('checkout', '--', '.')
    const [targeted, full] = targets as [Target, Target]
    expect(comparedResult(targeted.reconcile())).toEqual(comparedResult(full.reconcile(true)))
    expect(comparedState(targeted.db)).toEqual(comparedState(full.db))
  })
})

/** A small deterministic generator (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Step = (source: Source, w: TargetedWorld, pick: <T>(items: T[]) => T | undefined) => string

const STEPS: Step[] = [
  (source) => `new epic ${source.saveEpic()}`,
  (source, _w, pick) => {
    const epicId = pick(source.epics())
    return epicId === undefined ? 'no epic to edit' : `edit epic ${source.saveEpic(epicId)}`
  },
  (source, _w, pick) => {
    const epicId = pick(source.epics())
    return epicId === undefined ? 'no epic to comment' : `comment ${source.comment(epicId)}`
  },
  (source, _w, pick) => {
    const epicId = pick(source.epics())
    return epicId === undefined ? 'no epic to run' : `run ${source.run(epicId)}`
  },
  (source) => `new card ${source.card()}`,
  (source, _w, pick) => {
    const cardId = pick(source.w.source.db.all<{ id: string }>('SELECT id FROM kanban_cards ORDER BY id').map((row) => row.id))
    if (cardId === undefined) return 'no card to edit'
    source.editCard(cardId)
    return `edit card ${cardId}`
  },
  (source, _w, pick) => {
    const name = pick(['alpha', 'beta', 'gamma']) ?? 'alpha'
    source.profile(name)
    return `profile ${name}`
  },
  (source) => {
    source.observation()
    return 'observation'
  },
  (source, w, pick) => {
    const epicId = pick(source.epics())
    if (epicId === undefined) return 'no epic to delete'
    disk.remove(w, `epics/${epicId}`)
    return `delete epic folder ${epicId}`
  },
  (source, w, pick) => {
    const cardId = pick(source.w.source.db.all<{ id: string }>('SELECT id FROM kanban_cards ORDER BY id').map((row) => row.id))
    if (cardId === undefined) return 'no card to delete'
    disk.remove(w, `kanban/${cardId}`)
    return `delete card folder ${cardId}`
  },
  (source, w, pick) => {
    const epicId = pick(source.epics())
    if (epicId === undefined) return 'no epic to rename'
    const renamed = idOf('epic', 9_000 + source.epics().length)
    disk.rename(w, `epics/${epicId}`, `epics/${renamed}`)
    return `rename epic ${epicId} to ${renamed}`
  },
  (_source, w) => {
    disk.write(w, 'profiles/injected.json', '{"name": "injected", ')
    return 'invalid profile file'
  },
  (_source, w) => {
    disk.remove(w, 'profiles/injected.json')
    return 'fix invalid profile file'
  },
  (_source, w) => {
    w.commit('step')
    return 'commit'
  },
  (_source, w) => {
    w.git_('checkout', '--', '.')
    return 'revert uncommitted edits'
  }
]

const SEEDS = [1, 7, 42, 2026, 961]
const STEPS_PER_SEED = 50

describe('targeted and full reconciles agree', () => {
  for (const seed of SEEDS) {
    it(`leaves the database exactly as a full reconcile after every step (seed ${seed})`, () => {
      const w = world()
      const source = new Source(w)
      const next = random(seed)
      const pick = <T,>(items: T[]): T | undefined => items[Math.floor(next() * items.length)]
      const [targeted, full] = [w.target(), w.target()]
      // The full side needs no marker, so it skips git's status: half the git processes per step.
      const reconcileFull = (): ReconcileResultView =>
        full.reconcileWith((deps) => ({ ...deps, git: { ...deps.git, statusPaths: () => ({ ok: false, reason: 'git_failed' }) } }), true)
      const log: string[] = []
      for (let step = 0; step < STEPS_PER_SEED; step += 1) {
        const action = pick(STEPS) ?? STEPS[0]
        log.push(action?.(source, w, pick) ?? '')
        const context = `seed ${seed}, step ${step}: ${log.join(' | ')}`
        expect(comparedResult(targeted.reconcile()), context).toEqual(comparedResult(reconcileFull()))
        expect(comparedState(targeted.db), context).toEqual(comparedState(full.db))
      }
    })
  }
})
