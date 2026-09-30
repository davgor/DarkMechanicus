import { describe, expect, it } from 'vitest'
import { createTestCtx, type TestCtx } from '../../test/testContext'
import { enqueueOutbox } from './outbox'

interface OutboxRow {
  id: number
  kind: string
  epic_id: string | null
  run_id: string | null
  revision_id: string | null
  entity_id: string | null
  state: string
  attempts: number
  last_error: string | null
  created_at: string
  done_at: string | null
}

function rows(ctx: TestCtx): OutboxRow[] {
  return ctx.db.all<OutboxRow>('SELECT * FROM outbox ORDER BY id')
}

function setState(ctx: TestCtx, id: number, state: string): void {
  ctx.db.run('UPDATE outbox SET state = ? WHERE id = ?', state, id)
}

describe('enqueueOutbox row contents', () => {
  it('inserts a pending entry with the given references and the current time', () => {
    const ctx = createTestCtx()
    ctx.clock.set('2026-04-05T06:07:08.009Z')
    enqueueOutbox(ctx, { kind: 'snapshot', epicId: 'ep_1', revisionId: 'rv_1' })
    expect(rows(ctx)).toEqual([
      {
        id: 1,
        kind: 'snapshot',
        epic_id: 'ep_1',
        run_id: null,
        revision_id: 'rv_1',
        entity_id: null,
        state: 'pending',
        attempts: 0,
        last_error: null,
        created_at: '2026-04-05T06:07:08.009Z',
        done_at: null
      }
    ])
  })

  it('stores absent references as null', () => {
    const ctx = createTestCtx()
    enqueueOutbox(ctx, { kind: 'run_history', runId: 'rn_1' })
    expect(rows(ctx)[0]).toMatchObject({ kind: 'run_history', epic_id: null, run_id: 'rn_1', revision_id: null })
  })
})

describe('enqueueOutbox entity keys', () => {
  it('stores the entity id', () => {
    const ctx = createTestCtx()
    enqueueOutbox(ctx, { kind: 'run_history', runId: 'rn_1', entityId: 'key-1' })
    expect(rows(ctx)[0]).toMatchObject({ run_id: 'rn_1', entity_id: 'key-1' })
  })

  it('coalesces pending entries only when the entity id matches too', () => {
    const ctx = createTestCtx()
    enqueueOutbox(ctx, { kind: 'epic_state', epicId: 'ep_1', entityId: 'a' })
    enqueueOutbox(ctx, { kind: 'epic_state', epicId: 'ep_1', entityId: 'b' })
    enqueueOutbox(ctx, { kind: 'epic_state', epicId: 'ep_1', entityId: 'a' })
    enqueueOutbox(ctx, { kind: 'epic_state', epicId: 'ep_1' })
    expect(rows(ctx).map((row) => row.entity_id)).toEqual(['a', 'b', null])
  })
})

describe('enqueueOutbox snapshots', () => {
  it('never coalesces snapshot entries', () => {
    const ctx = createTestCtx()
    enqueueOutbox(ctx, { kind: 'snapshot', epicId: 'ep_1', revisionId: 'rv_1' })
    enqueueOutbox(ctx, { kind: 'snapshot', epicId: 'ep_1', revisionId: 'rv_1' })
    enqueueOutbox(ctx, { kind: 'snapshot', epicId: 'ep_1', revisionId: 'rv_2' })
    expect(rows(ctx).map((row) => row.revision_id)).toEqual(['rv_1', 'rv_1', 'rv_2'])
  })

  it('does not merge with pending state entries, nor they with it', () => {
    const ctx = createTestCtx()
    enqueueOutbox(ctx, { kind: 'epic_state', epicId: 'ep_1' })
    enqueueOutbox(ctx, { kind: 'snapshot', epicId: 'ep_1', revisionId: 'rv_1' })
    enqueueOutbox(ctx, { kind: 'epic_state', epicId: 'ep_1' })
    expect(rows(ctx).map((row) => row.kind)).toEqual(['epic_state', 'snapshot'])
  })
})

describe('enqueueOutbox epic_state coalescing', () => {
  it('collapses repeated pending entries for the same epic', () => {
    const ctx = createTestCtx()
    for (let repeat = 0; repeat < 3; repeat += 1) {
      enqueueOutbox(ctx, { kind: 'epic_state', epicId: 'ep_1' })
    }
    expect(rows(ctx)).toHaveLength(1)
  })

  it('keeps entries for different epics apart', () => {
    const ctx = createTestCtx()
    enqueueOutbox(ctx, { kind: 'epic_state', epicId: 'ep_1' })
    enqueueOutbox(ctx, { kind: 'epic_state', epicId: 'ep_2' })
    enqueueOutbox(ctx, { kind: 'epic_state', epicId: 'ep_1' })
    expect(rows(ctx).map((row) => row.epic_id)).toEqual(['ep_1', 'ep_2'])
  })

  it('keeps the first entry when a later one is merged into it', () => {
    const ctx = createTestCtx()
    enqueueOutbox(ctx, { kind: 'epic_state', epicId: 'ep_1', revisionId: 'rv_first' })
    ctx.clock.advanceSeconds(10)
    enqueueOutbox(ctx, { kind: 'epic_state', epicId: 'ep_1', revisionId: 'rv_second' })
    expect(rows(ctx)).toHaveLength(1)
    expect(rows(ctx)[0]).toMatchObject({ revision_id: 'rv_first', created_at: '2026-01-01T00:00:00.000Z' })
  })

  it('starts a new entry once the earlier one is done or failed', () => {
    const ctx = createTestCtx()
    enqueueOutbox(ctx, { kind: 'epic_state', epicId: 'ep_1' })
    setState(ctx, 1, 'done')
    enqueueOutbox(ctx, { kind: 'epic_state', epicId: 'ep_1' })
    setState(ctx, 2, 'failed')
    enqueueOutbox(ctx, { kind: 'epic_state', epicId: 'ep_1' })
    enqueueOutbox(ctx, { kind: 'epic_state', epicId: 'ep_1' })
    expect(rows(ctx).map((row) => row.state)).toEqual(['done', 'failed', 'pending'])
  })

  it('coalesces entries with no epic and no run together', () => {
    const ctx = createTestCtx()
    enqueueOutbox(ctx, { kind: 'epic_state' })
    enqueueOutbox(ctx, { kind: 'epic_state', epicId: null, runId: null })
    expect(rows(ctx)).toHaveLength(1)
  })
})

describe('enqueueOutbox run_history coalescing', () => {
  it('collapses repeated pending entries for the same run', () => {
    const ctx = createTestCtx()
    enqueueOutbox(ctx, { kind: 'run_history', epicId: 'ep_1', runId: 'rn_1' })
    enqueueOutbox(ctx, { kind: 'run_history', epicId: 'ep_1', runId: 'rn_1' })
    expect(rows(ctx)).toHaveLength(1)
  })

  it('keeps different runs, and different epics for the same run, apart', () => {
    const ctx = createTestCtx()
    enqueueOutbox(ctx, { kind: 'run_history', epicId: 'ep_1', runId: 'rn_1' })
    enqueueOutbox(ctx, { kind: 'run_history', epicId: 'ep_1', runId: 'rn_2' })
    enqueueOutbox(ctx, { kind: 'run_history', epicId: 'ep_2', runId: 'rn_1' })
    expect(rows(ctx).map((row) => `${row.epic_id}/${row.run_id}`)).toEqual(['ep_1/rn_1', 'ep_1/rn_2', 'ep_2/rn_1'])
  })

  it('does not merge with an epic_state entry for the same epic', () => {
    const ctx = createTestCtx()
    enqueueOutbox(ctx, { kind: 'epic_state', epicId: 'ep_1' })
    enqueueOutbox(ctx, { kind: 'run_history', epicId: 'ep_1' })
    enqueueOutbox(ctx, { kind: 'run_history', epicId: 'ep_1' })
    expect(rows(ctx).map((row) => row.kind)).toEqual(['epic_state', 'run_history'])
  })

  it('starts a new entry once the earlier one is done', () => {
    const ctx = createTestCtx()
    enqueueOutbox(ctx, { kind: 'run_history', runId: 'rn_1' })
    setState(ctx, 1, 'done')
    enqueueOutbox(ctx, { kind: 'run_history', runId: 'rn_1' })
    expect(rows(ctx).map((row) => row.state)).toEqual(['done', 'pending'])
  })
})
