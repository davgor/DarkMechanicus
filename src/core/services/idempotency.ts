import { contentHash } from '../canonical'
import type { Ctx } from '../context'
import { fail } from '../errors'

interface IdempotencyRow {
  request_hash: string
  response_json: string
}

/**
 * Runs `execute` inside one transaction. With an idempotency key, a repeat of the same request
 * returns the originally stored response instead of executing again; reusing the key for a
 * different request is rejected.
 */
export function withIdempotency<T>(
  ctx: Ctx,
  scope: { command: string; key: string | undefined; request: unknown },
  execute: () => T
): T {
  return ctx.db.tx(() => {
    if (scope.key === undefined || scope.key === '') {
      return execute()
    }
    const requestHash = contentHash(scope.request)
    const existing = ctx.db.get<IdempotencyRow>(
      'SELECT request_hash, response_json FROM idempotency WHERE command = ? AND key = ?',
      scope.command,
      scope.key
    )
    if (existing) {
      if (existing.request_hash !== requestHash) {
        fail('idempotency_mismatch', `Idempotency key "${scope.key}" was already used for a different ${scope.command} request.`)
      }
      return JSON.parse(existing.response_json) as T
    }
    const response = execute()
    ctx.db.run(
      'INSERT INTO idempotency (command, key, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)',
      scope.command,
      scope.key,
      requestHash,
      JSON.stringify(response ?? null),
      ctx.clock.nowIso()
    )
    return response
  })
}

/** Strips the idempotency key so it does not take part in the request fingerprint. */
export function requestWithoutKey<T extends { idempotencyKey?: string }>(input: T): Omit<T, 'idempotencyKey'> {
  const { idempotencyKey: _ignored, ...rest } = input
  return rest
}
