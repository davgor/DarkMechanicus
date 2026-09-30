import { describe, expect, it } from 'vitest'
import { createTestCtx, type TestCtx } from '../../test/testContext'
import { contentHash } from '../canonical'
import { DomainError } from '../errors'
import { getMeta, META_KEYS, setMeta } from '../meta'
import { requestWithoutKey, withIdempotency } from './idempotency'
import { thrownBy } from '../../test/thrownBy'

interface StoredRow {
  command: string
  key: string
  request_hash: string
  response_json: string
  created_at: string
}

function storedRows(ctx: TestCtx): StoredRow[] {
  return ctx.db.all<StoredRow>('SELECT * FROM idempotency ORDER BY command, key')
}

/** Runs `withIdempotency` and counts how often the command body executed. */
function counted(ctx: TestCtx, scope: { command: string; key?: string; request: unknown }): {
  run: () => { ok: number; runs: number }
  runs: () => number
} {
  let runs = 0
  const run = (): { ok: number; runs: number } =>
    withIdempotency(ctx, { command: scope.command, key: scope.key, request: scope.request }, () => {
      runs += 1
      return { ok: 1, runs }
    })
  return { run, runs: () => runs }
}

describe('withIdempotency without a key', () => {
  it('executes every time and stores nothing', () => {
    const ctx = createTestCtx()
    const command = counted(ctx, { command: 'save', request: { epicId: 'ep_1' } })
    expect(command.run().runs).toBe(1)
    expect(command.run().runs).toBe(2)
    expect(command.runs()).toBe(2)
    expect(storedRows(ctx)).toEqual([])
  })

  it('treats an empty key as no key', () => {
    const ctx = createTestCtx()
    const command = counted(ctx, { command: 'save', key: '', request: {} })
    command.run()
    command.run()
    expect(command.runs()).toBe(2)
    expect(storedRows(ctx)).toEqual([])
  })

  it('returns whatever the command returns', () => {
    const ctx = createTestCtx()
    const result = withIdempotency(ctx, { command: 'save', key: undefined, request: {} }, () => ['a', 'b'])
    expect(result).toEqual(['a', 'b'])
  })
})

describe('withIdempotency replays', () => {
  it('returns the stored response without executing again', () => {
    const ctx = createTestCtx()
    const command = counted(ctx, { command: 'save', key: 'k1', request: { epicId: 'ep_1' } })
    expect(command.run()).toEqual({ ok: 1, runs: 1 })
    expect(command.run()).toEqual({ ok: 1, runs: 1 })
    expect(command.run()).toEqual({ ok: 1, runs: 1 })
    expect(command.runs()).toBe(1)
  })

  it('records the command, key, request fingerprint, response and time', () => {
    const ctx = createTestCtx()
    ctx.clock.set('2026-05-06T07:08:09.010Z')
    const request = { epicId: 'ep_1', ops: [1, 2] }
    counted(ctx, { command: 'save', key: 'k1', request }).run()
    expect(storedRows(ctx)).toEqual([
      {
        command: 'save',
        key: 'k1',
        request_hash: contentHash(request),
        response_json: '{"ok":1,"runs":1}',
        created_at: '2026-05-06T07:08:09.010Z'
      }
    ])
  })

  it('returns a fresh copy of the stored response', () => {
    const ctx = createTestCtx()
    const scope = { command: 'save', key: 'k1', request: {} }
    const first = withIdempotency(ctx, scope, () => ({ list: [1, { deep: true }] }))
    const second = withIdempotency(ctx, scope, () => ({ list: ['never'] }))
    expect(second).toEqual({ list: [1, { deep: true }] })
    expect(second).not.toBe(first)
  })
})

describe('withIdempotency request fingerprints', () => {
  it('fingerprints requests independent of key order and undefined members', () => {
    const ctx = createTestCtx()
    const command = counted(ctx, { command: 'save', key: 'k1', request: { a: 1, b: { c: 2, d: 3 } } })
    command.run()
    const replay = counted(ctx, { command: 'save', key: 'k1', request: { b: { d: 3, c: 2 }, a: 1, e: undefined } })
    expect(replay.run()).toEqual({ ok: 1, runs: 1 })
    expect(replay.runs()).toBe(0)
  })

  it('keeps different keys and different commands independent', () => {
    const ctx = createTestCtx()
    const request = { epicId: 'ep_1' }
    const results = [
      counted(ctx, { command: 'save', key: 'k1', request }),
      counted(ctx, { command: 'save', key: 'k2', request }),
      counted(ctx, { command: 'advance', key: 'k1', request })
    ].map((command) => command.run().runs)
    expect(results).toEqual([1, 1, 1])
    expect(storedRows(ctx).map((row) => `${row.command}:${row.key}`)).toEqual(['advance:k1', 'save:k1', 'save:k2'])
  })
})

describe('withIdempotency mismatches', () => {
  it('rejects a reused key with a different request without executing', () => {
    const ctx = createTestCtx()
    counted(ctx, { command: 'save', key: 'k1', request: { epicId: 'ep_1' } }).run()
    const other = counted(ctx, { command: 'save', key: 'k1', request: { epicId: 'ep_2' } })
    const error = thrownBy(() => other.run())
    expect(error).toBeInstanceOf(DomainError)
    expect((error as DomainError).code).toBe('idempotency_mismatch')
    expect((error as DomainError).message).toBe(
      'Idempotency key "k1" was already used for a different save request.'
    )
    expect(other.runs()).toBe(0)
  })

  it('leaves the original stored response untouched after a mismatch', () => {
    const ctx = createTestCtx()
    const original = { command: 'save', key: 'k1', request: { epicId: 'ep_1' } }
    counted(ctx, original).run()
    thrownBy(() => counted(ctx, { ...original, request: { epicId: 'ep_2' } }).run())
    expect(counted(ctx, original).run()).toEqual({ ok: 1, runs: 1 })
    expect(storedRows(ctx)).toHaveLength(1)
  })

  it('treats a request that only differs by nesting as different', () => {
    const ctx = createTestCtx()
    counted(ctx, { command: 'save', key: 'k1', request: { a: [1, 2] } }).run()
    expect(() => counted(ctx, { command: 'save', key: 'k1', request: { a: [2, 1] } }).run()).toThrow(DomainError)
  })
})

describe('withIdempotency transactions', () => {
  it('runs the command inside a transaction with or without a key', () => {
    const ctx = createTestCtx()
    const seen: boolean[] = []
    withIdempotency(ctx, { command: 'a', key: undefined, request: {} }, () => seen.push(ctx.db.inTransaction()))
    withIdempotency(ctx, { command: 'a', key: 'k', request: {} }, () => seen.push(ctx.db.inTransaction()))
    expect(seen).toEqual([true, true])
    expect(ctx.db.inTransaction()).toBe(false)
  })

  it('commits the command writes together with the idempotency record', () => {
    const ctx = createTestCtx()
    withIdempotency(ctx, { command: 'save', key: 'k1', request: {} }, () => setMeta(ctx.db, META_KEYS.projectId, 'pj_1'))
    expect(getMeta(ctx.db, META_KEYS.projectId)).toBe('pj_1')
    expect(storedRows(ctx)).toHaveLength(1)
  })

  it('rolls everything back when the command throws, and lets a retry execute', () => {
    const ctx = createTestCtx()
    const scope = { command: 'save', key: 'k1', request: {} }
    const failure = new Error('disk full')
    const caught = thrownBy(() =>
      withIdempotency(ctx, scope, () => {
        setMeta(ctx.db, META_KEYS.projectId, 'pj_lost')
        throw failure
      })
    )
    expect(caught).toBe(failure)
    expect(getMeta(ctx.db, META_KEYS.projectId)).toBeNull()
    expect(storedRows(ctx)).toEqual([])
    expect(withIdempotency(ctx, scope, () => 'retried')).toBe('retried')
    expect(storedRows(ctx)).toHaveLength(1)
  })

  it('rolls back with an enclosing transaction', () => {
    const ctx = createTestCtx()
    thrownBy(() =>
      ctx.db.tx(() => {
        withIdempotency(ctx, { command: 'save', key: 'k1', request: {} }, () => 'done')
        throw new Error('outer failed')
      })
    )
    expect(storedRows(ctx)).toEqual([])
  })
})

describe('requestWithoutKey', () => {
  it('strips only the idempotency key', () => {
    const request = { epicId: 'ep_1', ops: [1], idempotencyKey: 'k1' }
    expect(requestWithoutKey(request)).toStrictEqual({ epicId: 'ep_1', ops: [1] })
  })

  it('leaves requests without a key equal to themselves', () => {
    const request: { epicId: string; idempotencyKey?: string } = { epicId: 'ep_1' }
    expect(requestWithoutKey(request)).toStrictEqual({ epicId: 'ep_1' })
  })

  it('drops an undefined key entirely and does not mutate the input', () => {
    const request: { a: number; idempotencyKey?: string } = { a: 1, idempotencyKey: undefined }
    const stripped = requestWithoutKey(request)
    expect('idempotencyKey' in stripped).toBe(false)
    expect('idempotencyKey' in request).toBe(true)
  })

  it('produces the same fingerprint for requests that differ only by key', () => {
    const one = requestWithoutKey({ epicId: 'ep_1', idempotencyKey: 'one' })
    const two = requestWithoutKey({ epicId: 'ep_1', idempotencyKey: 'two' })
    expect(contentHash(one)).toBe(contentHash(two))
  })
})
