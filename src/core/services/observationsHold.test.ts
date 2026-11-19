import { afterEach, describe, expect, it } from 'vitest'
import { deliverEpic, type DeliveredEpic, plan, type Project, project } from '../../test/metricsProject'
import type { Db, SqlValue } from '../db/database'
import { deleteEpic } from './epicDeletion'
import { recordHumanFeedback } from './humanFeedback'
import { getMetricsSummary } from './metricsSummary'
import { listObservations, readingObservations } from './observations'

let opened: Project | null = null

afterEach(() => {
  opened?.harness.cleanup()
  opened = null
})

/** A project with one delivered, accepted and closed epic: its observations are stored and nothing is running. */
async function deliveredProject(): Promise<{ p: Project; epic: DeliveredEpic }> {
  const p = await project('Hold')
  opened = p
  const epic = await deliverEpic(p, { title: 'Held', tickets: ['measured'], accept: true })
  await p.orchestrator.cancelRun({ runId: epic.runId, reason: 'closing the run' })
  return { p, epic }
}

function rating(epic: DeliveredEpic) {
  return { target: { epicId: epic.epicId, ticketId: epic.ticketIds[0] ?? '' }, feedback: { kind: 'rating' as const, value: 4 } }
}

/**
 * The connection, with every observation list query it runs recorded (statement and parameters), and how often it asked
 * whether another connection committed (`data_version`).
 */
function recording(db: Db): { db: Db; lists: string[]; versionReads: () => number } {
  const lists: string[] = []
  let versionReads = 0
  const wrapped: Db = {
    path: db.path,
    get: <T>(sql: string, ...params: SqlValue[]): T | undefined => {
      if (sql.includes('data_version')) versionReads += 1
      return db.get<T>(sql, ...params)
    },
    all: <T>(sql: string, ...params: SqlValue[]): T[] => {
      if (sql.includes('SELECT observation_json FROM metric_observations')) lists.push(JSON.stringify([sql, params]))
      return db.all<T>(sql, ...params)
    },
    run: (sql, ...params) => db.run(sql, ...params),
    exec: (sql) => db.exec(sql),
    tx: (fn) => db.tx(fn),
    inTransaction: () => db.inTransaction(),
    close: () => db.close()
  }
  return { db: wrapped, lists, versionReads: () => versionReads }
}

const repeatedIn = (lists: readonly string[]): string[] => lists.filter((entry, n) => lists.indexOf(entry) !== n)

describe('readingObservations under writes', () => {
  it('serves a row another connection committed while the hold is open', async () => {
    const { p, epic } = await deliveredProject()
    const { db } = p.desktop.ctx()
    const other = p.harness.open('desktop', { allowSave: true }).ctx()
    expect(other.db).not.toBe(db)
    const counts = readingObservations(db, () => {
      const before = listObservations(db, { epicId: epic.epicId }).length
      other.db.tx(() => recordHumanFeedback(other, rating(epic)))
      return { before, after: listObservations(db, { epicId: epic.epicId }).length }
    })
    expect(counts.after).toBe(counts.before + 1)
  })

  it('serves nothing of an epic deleted on the same connection while the hold is open', async () => {
    const { p, epic } = await deliveredProject()
    const ctx = p.desktop.ctx()
    const counts = readingObservations(ctx.db, () => {
      const before = listObservations(ctx.db, { epicId: epic.epicId }).length
      deleteEpic(ctx, { epicId: epic.epicId }, () => [])
      return { before, after: listObservations(ctx.db, { epicId: epic.epicId }).length }
    })
    expect(counts.before).toBeGreaterThan(0)
    expect(counts.after).toBe(0)
  })

  it('never serves a row a nested transaction inserted and rolled back, and serves one it kept', async () => {
    const { p, epic } = await deliveredProject()
    const ctx = p.desktop.ctx()
    const counts = readingObservations(ctx.db, () => {
      const before = listObservations(ctx.db, { epicId: epic.epicId }).length
      expect(() =>
        ctx.db.tx(() => {
          recordHumanFeedback(ctx, rating(epic))
          // Read inside the transaction (the rating is there), then roll it back.
          expect(listObservations(ctx.db, { epicId: epic.epicId })).toHaveLength(before + 1)
          throw new Error('roll back')
        })
      ).toThrow('roll back')
      const afterRollback = listObservations(ctx.db, { epicId: epic.epicId }).length
      ctx.db.tx(() => recordHumanFeedback(ctx, rating(epic)))
      return { before, afterRollback, afterCommit: listObservations(ctx.db, { epicId: epic.epicId }).length }
    })
    expect([counts.afterRollback - counts.before, counts.afterCommit - counts.before]).toEqual([0, 1])
  })
})

describe('readingObservations holds', () => {
  it('keeps an absent filter field apart from a null one (project level)', async () => {
    const { p, epic } = await deliveredProject()
    const { db } = p.desktop.ctx()
    const outside = { all: listObservations(db, {}).length, project: listObservations(db, { epicId: null }).length }
    const inside = readingObservations(db, () => ({ project: listObservations(db, { epicId: null }).length, all: listObservations(db, { epicId: undefined }).length }))
    expect(inside).toEqual(outside)
    expect(inside.all).toBeGreaterThan(inside.project)
    expect(listObservations(db, { epicId: epic.epicId })).toHaveLength(inside.all - inside.project)
  })

  it('refuses a read that returns a promise, so the hold is never used across an await', async () => {
    const { p } = await deliveredProject()
    const { db } = p.desktop.ctx()
    let listed = -1
    expect(() =>
      readingObservations(db, async () => {
        listed = listObservations(db).length
        await Promise.resolve()
      })
    ).toThrow('readingObservations holds observations for a synchronous read only; the read returned a promise.')
    expect(listed).toBe(listObservations(db).length)
    // The refused read released the hold: a nested read inside a later hold refuses a promise too.
    expect(() => readingObservations(db, () => readingObservations(db, () => Promise.resolve(0)))).toThrow('synchronous read only')
  })

  it('lists each observation filter once over a whole summary read: the read writes nothing that drops the hold', async () => {
    const { p } = await deliveredProject()
    const ctx = p.desktop.ctx()
    const { db, lists } = recording(ctx.db)
    getMetricsSummary({ ...ctx, db }, {})
    expect(lists.length).toBeGreaterThan(0)
    expect(repeatedIn(lists)).toEqual([])
  })
})

describe('readingObservations shared and kept', () => {
  it('lets a nested read share the outer hold, which outlives the nested read', async () => {
    const { p, epic } = await deliveredProject()
    const { db, lists } = recording(p.desktop.ctx().db)
    const filter = { epicId: epic.epicId }
    readingObservations(db, () => {
      listObservations(db, filter)
      readingObservations(db, () => listObservations(db, filter))
      listObservations(db, filter)
    })
    expect(lists).toHaveLength(1)
    listObservations(db, filter)
    expect(lists).toHaveLength(2)
  })

  it('keeps the hold over a summary read that settles an expired lease, asking no other connection inside its transaction', async () => {
    const { p } = await deliveredProject()
    const { epicId, bundle } = await plan(p, 'Leased', 1, {})
    const run = await p.orchestrator.startRun({ epicId })
    const ticketId = bundle.tickets.find((ticket) => ticket.kind !== 'acceptance')?.id ?? ''
    await p.orchestrator.claimTicket({ runId: run.id, ticketId, worker: { label: 'test-worker' } })
    p.harness.clock.advanceSeconds(8 * 3600)
    const ctx = p.desktop.ctx()
    const { db, lists, versionReads } = recording(ctx.db)
    const changesBefore = ctx.db.get<{ n: number }>('SELECT total_changes() AS n')?.n ?? 0
    getMetricsSummary({ ...ctx, db }, {})
    // The read did write (it settled the lease), and still listed each filter once.
    expect(ctx.db.get<{ n: number }>('SELECT total_changes() AS n')?.n ?? 0).toBeGreaterThan(changesBefore)
    expect(lists.length).toBeGreaterThan(0)
    expect(repeatedIn(lists)).toEqual([])
    expect(versionReads()).toBe(0)
  })
})
