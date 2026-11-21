import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { basename, dirname, isAbsolute } from 'node:path'
import type { BoardContextBody } from './contextDelivery'
import { DESKTOP_CONTROL_LIMITS, serializedCredentialWithinBound } from './controlLimits'
import type { DmCallResult, DmClientDeps, DmClientError } from './dmClient'

interface RecoveryIdentity { chatId: string; generation: string; address: string }
interface RecoveryDescriptor { version: 1; chatId: string; generation: string; recoveryAddress: string }
type ClientCode = Extract<DmClientError, { source: 'client' }>['code']
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const failure = (code: ClientCode, message: string): DmCallResult<never> => ({ ok: false, error: { source: 'client', code, message } })

function recoveryDescriptor(value: unknown): value is RecoveryDescriptor {
  if (!record(value) || value.version !== 1 || typeof value.chatId !== 'string' || typeof value.generation !== 'string' || typeof value.recoveryAddress !== 'string') return false
  return /^[A-Za-z0-9_-]{1,128}$/.test(value.chatId) && /^[A-Za-z0-9_-]{1,128}$/.test(value.generation)
}
function boundDescriptor(path: string, value: RecoveryDescriptor): boolean {
  return basename(path) === `${value.generation}.json` && basename(dirname(path)) === 'dm-client' && basename(dirname(dirname(path))) === value.chatId
}
/** A private generation descriptor contains no grant, executable, repository or generic mailbox authority. */
async function identity(deps: DmClientDeps): Promise<RecoveryIdentity | null> {
  const path = deps.env.DM_SKITARII_CLIENT_DESCRIPTOR
  if (path === undefined || !isAbsolute(path)) return null
  const value: unknown = JSON.parse(await deps.readFile(path))
  if (!recoveryDescriptor(value) || !boundDescriptor(path, value)) return null
  return { chatId: value.chatId, generation: value.generation, address: value.recoveryAddress }
}
function replyError(error: unknown): DmCallResult<unknown> {
  if (!record(error) || typeof error.code !== 'string' || typeof error.message !== 'string') return failure('malformed_output', 'The recovery reply is invalid.')
  return { ok: false, error: { source: 'dm', code: error.code, message: error.message } }
}
function parseReply(bytes: Buffer, requestId: string): DmCallResult<unknown> {
  try {
    const reply: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!record(reply) || reply.version !== 1 || reply.requestId !== requestId) return failure('malformed_output', 'The recovery reply is invalid.')
    if (reply.ok === true && 'data' in reply) return { ok: true, data: reply.data }
    if (reply.ok === false) return replyError(reply.error)
  } catch { /* Only complete, correctly encoded and correlated envelopes are usable. */ }
  return failure('malformed_output', 'The recovery reply is invalid.')
}
function transport(bound: RecoveryIdentity, wire: string, requestId: string, signal?: AbortSignal): Promise<DmCallResult<unknown>> {
  return new Promise(resolve => {
    const socket = createConnection(bound.address)
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    const finish = (answer: DmCallResult<unknown>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      socket.destroy()
      resolve(answer)
    }
    const abort = (): void => finish(failure('cancelled', 'Recovery context was cancelled.'))
    const timer = setTimeout(() => finish(failure('timeout', 'Recovery control did not answer in time.')), 25_000)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) { abort(); return }
    socket.on('connect', () => socket.write(wire))
    socket.on('error', () => finish(failure('process_failed', 'The desktop recovery control is unavailable.')))
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > DESKTOP_CONTROL_LIMITS.responseBytes) { finish(failure('malformed_output', 'Recovery reply exceeded its bound.')); return }
      chunks.push(chunk)
      const newline = chunk.indexOf(10)
      if (newline < 0) return
      if (newline !== chunk.length - 1) { finish(failure('malformed_output', 'The recovery reply is invalid.')); return }
      finish(parseReply(Buffer.concat(chunks, bytes), requestId))
    })
    socket.on('close', () => { if (!settled) finish(failure('process_failed', 'Recovery control closed before replying.')) })
  })
}
/** Direct authenticated local control reuses the launch grant, never transfers source/project authority. */
export async function callRecovery(deps: DmClientDeps, args?: unknown, signal?: AbortSignal): Promise<DmCallResult<unknown>> {
  let bound: RecoveryIdentity | null
  try { bound = await identity(deps) } catch { return failure('context_unavailable', 'The recovery descriptor cannot be read.') }
  if (bound === null) return failure('descriptor_missing', 'This launch has no recovery context descriptor.')
  const token = deps.env.DM_SESSION_TOKEN
  if (token === undefined || token === '') return failure('no_grant', 'Recovery needs this live launch grant.')
  if (token.length > 1024 || !serializedCredentialWithinBound(token)) return failure('invalid_input', 'The recovery credential exceeds its independent bound.')
  const requestId = randomUUID()
  const request = { version: 1, requestId, token, ...(args === undefined ? { op: 'recovery_context', args: { chatId: bound.chatId, generation: bound.generation } } : { op: 'recover_tooling', args }) }
  const wire = JSON.stringify(request) + '\n'
  if (Buffer.byteLength(wire) > DESKTOP_CONTROL_LIMITS.requestBytes) return failure('invalid_input', 'The recovery request exceeds its bound.')
  return transport(bound, wire, requestId, signal)
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
