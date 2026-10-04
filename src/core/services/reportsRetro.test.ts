import { describe, expect, it } from 'vitest'
import type { SprintRetro, SprintRetroInput } from '../../shared/domain/retro'
import { sid, tid } from '../../test/bundles'
import { errorOf, eventLog, runRow, seedRun, type SeedRunOptions } from '../../test/checkpointSeed'
import { idOf, insertReport } from '../../test/repoFixtures'
import { createTestCtx, type TestCtx } from '../../test/testContext'
import { contentHash } from '../canonical'
import { getSprintReport, submitSprintReport } from './reports'

function setup(options: SeedRunOptions = {}): { ctx: TestCtx; runId: string } {
  const ctx = createTestCtx()
  return { ctx, runId: seedRun(ctx, options).runId }
}

function submit(ctx: TestCtx, runId: string, retro?: SprintRetroInput | null) {
  return submitSprintReport(ctx, {
    runId,
    sprintId: sid(1),
    report: { summary: 'Sprint 1 delivered the parts.', ...(retro === undefined ? {} : { retro }) }
  })
}

/** What a reporter writes: tickets by display key, or by id. */
const WRITTEN: SprintRetroInput = {
  delivered: [{ ticket: 'DM-1', demo: 'Open the schema view and filter by tag', evidence: 'commit 3f9a0d1' }],
  wentWell: ['Pairing on the migration'],
  wentPoorly: ['The runner image drifted'],
  actions: ['Pin the runner image'],
  discoveries: [
    { title: 'Cache the host catalog', body: 'Every report reloads it.', ticket: 'DM-1' },
    { title: 'Document the ticket keys', body: '' }
  ],
  leftovers: [{ ticket: 'DM-2', reason: 'Waiting on a signing identity' }],
  tierFit: [
    { ticket: 'DM-1', verdict: 'oversized', note: 'A small model would have done' },
    { ticket: tid(2), verdict: 'undersized', note: 'Rejected twice at the first tier' }
  ]
}

/** What is stored and read back: the stable id of each ticket, and a null ticket where none was named. */
const STORED: SprintRetro = {
  delivered: [{ ticket: tid(1), demo: 'Open the schema view and filter by tag', evidence: 'commit 3f9a0d1' }],
  wentWell: ['Pairing on the migration'],
  wentPoorly: ['The runner image drifted'],
  actions: ['Pin the runner image'],
  discoveries: [
    { title: 'Cache the host catalog', body: 'Every report reloads it.', ticket: tid(1) },
    { title: 'Document the ticket keys', body: '', ticket: null }
  ],
  leftovers: [{ ticket: tid(2), reason: 'Waiting on a signing identity' }],
  tierFit: [
    { ticket: tid(1), verdict: 'oversized', note: 'A small model would have done' },
    { ticket: tid(2), verdict: 'undersized', note: 'Rejected twice at the first tier' }
  ]
}

describe('submitSprintReport with a retro', () => {
  it('stores delivered work, what went well and poorly, actions, discoveries, leftovers and tier-fit verdicts, and returns them', () => {
    const { ctx, runId } = setup()
    const view = submit(ctx, runId, WRITTEN)
    expect(view.report.retro).toEqual(STORED)
    expect(getSprintReport(ctx, { runId })?.report.retro).toEqual(STORED)
    expect(getSprintReport(ctx, { runId, sprintId: sid(1) })?.report.retro).toEqual(STORED)
  })

  it('stores each ticket as its stable id, whether it was written as a display key or as an id', () => {
    const { ctx, runId } = setup()
    const retro = submit(ctx, runId, WRITTEN).report.retro
    expect(retro?.tierFit.map((item) => item.ticket)).toEqual([tid(1), tid(2)])
    const stored = ctx.db.get<{ content_json: string }>('SELECT content_json FROM sprint_reports')?.content_json ?? ''
    expect(stored).not.toContain('DM-1')
    expect(stored).toContain(tid(1))
  })

  it('records the retro in the content hash, which the stored content matches', () => {
    const { ctx, runId } = setup()
    const withRetro = submit(ctx, runId, WRITTEN)
    const without = submit(ctx, runId)
    expect(withRetro.contentHash).toBe(contentHash(withRetro.report))
    expect(without.contentHash).not.toBe(withRetro.contentHash)
  })

  it.each([['no retro', undefined], ['a null retro', null]])('stores a report with %s as retro: null, which its hash covers', (_label, retro) => {
    const { ctx, runId } = setup()
    const view = submit(ctx, runId, retro)
    const stored = ctx.db.get<{ content_json: string }>('SELECT content_json FROM sprint_reports')?.content_json ?? ''
    expect(JSON.parse(stored)).toMatchObject({ retro: null })
    expect(view.contentHash).toBe(contentHash(JSON.parse(stored)))
    expect(view.report.retro).toBeNull()
  })

})

describe('submitSprintReport with a partial retro, or none', () => {
  it('fills the lists a partial retro leaves out with nothing', () => {
    const { ctx, runId } = setup()
    expect(submit(ctx, runId, { wentWell: ['Fine'] }).report.retro).toEqual({
      delivered: [],
      wentWell: ['Fine'],
      wentPoorly: [],
      actions: [],
      discoveries: [],
      leftovers: [],
      tierFit: []
    })
  })

  it('reads a report with no retro, or a null one, as retro: null', () => {
    const { ctx, runId } = setup()
    expect(submit(ctx, runId).report.retro).toBeNull()
    expect(submit(ctx, runId, null).report.retro).toBeNull()
    expect(getSprintReport(ctx, { runId })?.report.retro).toBeNull()
  })

  it('keeps only the latest revision as the report, so a revision without a retro reads as having none', () => {
    const { ctx, runId } = setup()
    submit(ctx, runId, WRITTEN)
    submit(ctx, runId)
    const latest = getSprintReport(ctx, { runId })
    expect([latest?.reportRevision, latest?.report.retro]).toEqual([2, null])
  })
})

describe('submitSprintReport with a retro naming an unknown ticket', () => {
  it.each([
    ['delivered', { delivered: [{ ticket: 'DM-99', demo: '', evidence: '' }] }, 'retro.delivered[0].ticket'],
    ['discoveries', { discoveries: [{ title: 't', body: '', ticket: 'DM-99' }] }, 'retro.discoveries[0].ticket'],
    ['leftovers', { leftovers: [{ ticket: 'DM-1', reason: '' }, { ticket: tid(99), reason: '' }] }, 'retro.leftovers[1].ticket'],
    ['tierFit', { tierFit: [{ ticket: 'dm-1', verdict: 'right_sized', note: '' }] }, 'retro.tierFit[0].ticket']
  ] as [string, SprintRetroInput, string][])('refuses an unknown ticket in %s, naming where, and stores nothing', (_field, retro, path) => {
    const { ctx, runId } = setup()
    const error = errorOf(() => submit(ctx, runId, retro))
    expect(error.code).toBe('invalid_input')
    expect(error.message).toContain(path)
    expect(ctx.db.all('SELECT id FROM sprint_reports')).toEqual([])
    expect(runRow(ctx, runId)?.state).toBe('running')
    expect(eventLog(ctx)).toEqual([])
  })

  it('accepts a ticket of another sprint of the same plan', () => {
    const { ctx, runId } = setup()
    expect(submit(ctx, runId, { leftovers: [{ ticket: 'DM-3', reason: 'Planned for sprint 2' }] }).report.retro?.leftovers).toEqual([
      { ticket: tid(3), reason: 'Planned for sprint 2' }
    ])
  })
})

describe('a report stored before retros', () => {
  const LEGACY = { summary: 'Written before retros', accepted: ['DM-1'], risks: ['Old risk'] }

  it('reads with retro: null and keeps the content hash it was stored with', () => {
    const { ctx, runId } = setup()
    insertReport(ctx.db, { id: idOf('report', 1), runId, sprintId: sid(1), content: LEGACY })
    const view = getSprintReport(ctx, { runId })
    expect(view?.report).toMatchObject({ summary: 'Written before retros', risks: ['Old risk'], retro: null })
    expect(view?.contentHash).toBe(contentHash(LEGACY))
  })

  it('gives way to a newer revision that has a retro', () => {
    const { ctx, runId } = setup()
    insertReport(ctx.db, { id: idOf('report', 1), runId, sprintId: sid(1), content: LEGACY })
    const view = submit(ctx, runId, WRITTEN)
    expect([view.reportRevision, view.report.retro]).toEqual([2, STORED])
  })
})

describe('a report with a retro in search', () => {
  const find = (ctx: TestCtx, query: string): string[] =>
    ctx.db.all<{ doc_id: string }>('SELECT doc_id FROM search_index WHERE search_index MATCH ?', query).map((row) => row.doc_id)

  it('indexes the text of every retro section, with the ticket keys, under the sprint report', () => {
    const { ctx, runId } = setup()
    const view = submit(ctx, runId, WRITTEN)
    for (const word of ['schema', 'pairing', 'drifted', 'pin', 'host', 'signing', 'oversized', 'rejected', 'DM']) {
      expect(find(ctx, word)).toEqual([view.id])
    }
    const body = ctx.db.get<{ body: string }>('SELECT body FROM search_index WHERE doc_id = ?', view.id)?.body ?? ''
    expect(body).toContain('DM-1')
    expect(body).toContain('DM-2')
    expect(body).not.toContain(tid(1))
  })

  it('stops finding the retro text once a later revision leaves the retro out', () => {
    const { ctx, runId } = setup()
    submit(ctx, runId, WRITTEN)
    const latest = submit(ctx, runId)
    expect(find(ctx, 'pairing')).toEqual([])
    expect(find(ctx, 'delivered')).toEqual([latest.id])
  })
})
