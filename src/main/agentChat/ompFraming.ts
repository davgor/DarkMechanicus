import { TextDecoder } from 'node:util'
import { z } from 'zod'

export interface OmpFraming {
  maxFrameBytes: number
  maxReassembledFrameBytes: number
  protocolVersion: number
  chunk: { id: string; count: number; byteLength: number; parts: Uint8Array[]; size: number } | null
  rejectedChunks: string[]
  recoveringChunks: boolean
}
const chunkSchema = z.object({
  type: z.literal('rpc_chunk'), chunkId: z.string().min(1).max(128),
  index: z.number().int().nonnegative(), count: z.number().int().min(2),
  byteLength: z.number().int().positive(),
  data: z.string().min(1).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
})
type FrameResult = { frame?: unknown; error?: string; skipped?: boolean }

function reject(state: OmpFraming, id: string | null): FrameResult {
  // Two bounded IDs retain the abandoned/offending pair. Recovery ignores all orphan tails,
  // so further interleaved IDs cannot grow state or multiply errors for the same incident.
  const ids = [state.chunk?.id, id].filter((value): value is string => typeof value === 'string' && value.length <= 128)
  state.rejectedChunks = [...new Set([...state.rejectedChunks, ...ids])].slice(-2)
  state.chunk = null
  const result = state.recoveringChunks ? {} : { error: 'Invalid OMP chunk sequence' }
  state.recoveringChunks = true
  return result
}
function decodeChunk(state: OmpFraming, chunk: NonNullable<OmpFraming['chunk']>): FrameResult {
  if (chunk.size !== chunk.byteLength) return reject(state, chunk.id)
  state.chunk = null
  try {
    const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunk.parts)))
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return reject(state, chunk.id)
    if ('type' in decoded && decoded.type === 'rpc_chunk') return reject(state, chunk.id)
    state.recoveringChunks = false
    return { frame: decoded }
  } catch { return reject(state, chunk.id) }
}
function collectChunk(state: OmpFraming, value: Record<string, unknown>): FrameResult {
  const parsed = chunkSchema.safeParse(value)
  if (!parsed.success) return reject(state, typeof value.chunkId === 'string' ? value.chunkId : null)
  const frame = parsed.data
  if (frame.index >= frame.count || frame.byteLength < frame.count || frame.byteLength > state.maxReassembledFrameBytes) return reject(state, frame.chunkId)
  const bytes = Buffer.from(frame.data, 'base64')
  if (bytes.toString('base64') !== frame.data) return reject(state, frame.chunkId)
  if (!state.chunk) {
    if (frame.index !== 0) return reject(state, frame.chunkId)
    state.chunk = { id: frame.chunkId, count: frame.count, byteLength: frame.byteLength, parts: [], size: 0 }
  }
  return appendChunk(state, frame, bytes)
}
function appendChunk(state: OmpFraming, frame: z.infer<typeof chunkSchema>, bytes: Buffer): FrameResult {
  const chunk = state.chunk
  if (!chunk) return reject(state, frame.chunkId)
  if (chunk.id !== frame.chunkId || chunk.count !== frame.count || chunk.byteLength !== frame.byteLength ||
      chunk.parts.length !== frame.index || chunk.size + bytes.length > frame.byteLength) return reject(state, frame.chunkId)
  chunk.parts.push(bytes)
  chunk.size += bytes.length
  return frame.index + 1 === frame.count ? decodeChunk(state, chunk) : {}
}
export function ompReadFrame(line: string, state: OmpFraming): FrameResult {
  let frame: unknown
  try { frame = JSON.parse(line) } catch {
    return state.chunk ? reject(state, state.chunk.id) : { skipped: true }
  }
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return state.chunk ? reject(state, state.chunk.id) : { skipped: true }
  return readObject(line, frame as Record<string, unknown>, state)
}
function readObject(line: string, frame: Record<string, unknown>, state: OmpFraming): FrameResult {
  if (frame.type !== 'rpc_chunk') {
    if (state.chunk) return reject(state, state.chunk.id)
    if (Buffer.byteLength(line) > state.maxFrameBytes) return { error: 'OMP frame exceeds maximum size' }
    state.recoveringChunks = false
    return { frame }
  }
  if (typeof frame.chunkId !== 'string') return reject(state, null)
  // During recovery, only a new index-zero candidate can resynchronize. Any frame
  // interrupting that candidate rejects it, until a complete uninterrupted frame succeeds.
  if (!state.chunk && frame.index !== 0 && (state.recoveringChunks || state.rejectedChunks.includes(frame.chunkId))) return {}
  if (Buffer.byteLength(line) > state.maxFrameBytes) return reject(state, frame.chunkId)
  return collectChunk(state, frame)
}
function chunkSize(state: OmpFraming, bytes: Buffer, chunkId: string, override?: number): number {
  if (state.protocolVersion !== 2) throw new Error('OMP chunking requires protocol v2')
  if (!chunkId.length || chunkId.length > 128) throw new Error('Invalid OMP chunk id')
  const overhead = Buffer.byteLength(JSON.stringify({ type: 'rpc_chunk', chunkId, index: bytes.length, count: bytes.length, byteLength: bytes.length, data: '' }))
  const capacity = Math.floor((state.maxFrameBytes - overhead) / 4) * 3
  const size = override ?? capacity
  if (!Number.isSafeInteger(size) || size < 1 || size > capacity) throw new Error('OMP frame limit cannot hold chunks')
  return size
}
/** chunkBytes is an explicit transport override for deterministic, small golden frames. */
export function ompWriteFrame(frame: Record<string, unknown>, state: OmpFraming, chunkId: string, chunkBytes?: number): string[] {
  const line = JSON.stringify(frame)
  const bytes = Buffer.from(line)
  if (bytes.length > state.maxReassembledFrameBytes) throw new Error('OMP command exceeds reassembled limit')
  if (bytes.length <= state.maxFrameBytes && chunkBytes === undefined) return [line]
  const size = chunkSize(state, bytes, chunkId, chunkBytes)
  const count = Math.ceil(bytes.length / size)
  if (count < 2) return [line]
  return Array.from({ length: count }, (_, index) => JSON.stringify({
    type: 'rpc_chunk', chunkId, index, count, byteLength: bytes.length,
    data: bytes.subarray(index * size, (index + 1) * size).toString('base64')
  }))
}
