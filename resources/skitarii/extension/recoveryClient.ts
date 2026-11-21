import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { basename, dirname, isAbsolute } from 'node:path'
import type { BoardContextBody } from './contextDelivery'
import type { DmCallResult, DmClientDeps } from './dmClient'

interface RecoveryIdentity { chatId: string; generation: string; address: string }
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
/** A private generation descriptor contains no grant, executable, repository or generic mailbox authority. */
async function identity(deps: DmClientDeps): Promise<RecoveryIdentity | null> {
  const path = deps.env.DM_SKITARII_CLIENT_DESCRIPTOR
  if (path === undefined || !isAbsolute(path)) return null
  const value: unknown = JSON.parse(await deps.readFile(path))
  if (!record(value) || value.version !== 1 || typeof value.chatId !== 'string' || typeof value.generation !== 'string' || typeof value.recoveryAddress !== 'string') return null
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value.chatId) || !/^[A-Za-z0-9_-]{1,128}$/.test(value.generation) ||
      basename(path) !== `${value.generation}.json` || basename(dirname(path)) !== 'dm-client' || basename(dirname(dirname(path))) !== value.chatId) return null
  return { chatId: value.chatId, generation: value.generation, address: value.recoveryAddress }
}
/** Direct authenticated local control, not a subprocess or a transferable cross-project token. */
export async function callRecovery(deps: DmClientDeps, args?: unknown, signal?: AbortSignal): Promise<DmCallResult<unknown>> {
  let bound: RecoveryIdentity | null
  try { bound = await identity(deps) } catch { return { ok: false, error: { source: 'client', code: 'context_unavailable', message: 'The recovery descriptor cannot be read.' } } }
  if (bound === null) return { ok: false, error: { source: 'client', code: 'descriptor_missing', message: 'This launch has no recovery context descriptor.' } }
  const token = deps.env.DM_SESSION_TOKEN
  if (token === undefined || token === '') return { ok: false, error: { source: 'client', code: 'no_grant', message: 'Recovery needs this live launch grant.' } }
  const requestId = randomUUID()
  const request = { version: 1, requestId, token, ...(args === undefined ? { op: 'recovery_context', args: { chatId: bound.chatId, generation: bound.generation } } : { op: 'recover_tooling', args }) }
  const wire = JSON.stringify(request) + '\n'
  if (Buffer.byteLength(wire) > 32_768) return { ok: false, error: { source: 'client', code: 'invalid_input', message: 'The recovery request exceeds its bound.' } }
  const { promise, resolve } = Promise.withResolvers<DmCallResult<unknown>>()
    const socket = createConnection(bound.address)
    const chunks: Buffer[] = []; let bytes = 0; let settled = false
    const finish = (answer: DmCallResult<unknown>): void => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.destroy(); resolve(answer)
    }
    const failure = (code: 'timeout' | 'cancelled' | 'malformed_output' | 'process_failed', message: string): void => finish({ ok: false, error: { source: 'client', code, message } })
    const abort = (): void => failure('cancelled', 'Recovery context was cancelled.')
    const timer = setTimeout(() => failure('timeout', 'Recovery control did not answer in time.'), 25_000)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) { abort(); return promise }
    socket.on('connect', () => socket.write(wire))
    socket.on('error', () => failure('process_failed', 'The desktop recovery control is unavailable.'))
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 32_768) { failure('malformed_output', 'Recovery reply exceeded its bound.'); return }
      chunks.push(chunk)
      if (chunk.at(-1) !== 10) return
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))
        const reply: unknown = JSON.parse(text)
        if (!record(reply) || reply.version !== 1 || reply.requestId !== requestId) throw new Error('invalid reply')
        if (reply.ok === true && 'data' in reply) finish({ ok: true, data: reply.data })
        else if (reply.ok === false && record(reply.error) && typeof reply.error.code === 'string' && typeof reply.error.message === 'string') {
          finish({ ok: false, error: { source: 'dm', code: reply.error.code, message: reply.error.message } })
        } else throw new Error('invalid envelope')
      } catch { failure('malformed_output', 'The recovery reply is invalid.') }
    })
    socket.on('close', () => { if (!settled) failure('process_failed', 'Recovery control closed before replying.') })
  return promise
}
export async function readRecoveryContext(deps: DmClientDeps): Promise<DmCallResult<BoardContextBody[]>> {
  const answer = await callRecovery(deps)
  if (!answer.ok) {
    // Old launches have no recovery descriptor; this is not a mailbox or a repair incident failure.
    return answer.error.code === 'descriptor_missing' ? { ok: true, data: [] } : answer
  }
  if (!record(answer.data) || !Array.isArray(answer.data.messages) || !answer.data.messages.every(value => record(value) && typeof value.id === 'string' && typeof value.text === 'string')) {
    return { ok: false, error: { source: 'client', code: 'malformed_output', message: 'Recovery context does not contain exact peer bodies.' } }
  }
  return { ok: true, data: answer.data.messages as BoardContextBody[] }
}
