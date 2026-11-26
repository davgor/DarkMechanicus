import { describe, expect, it } from 'vitest'
import { ompReadFrame, ompWriteFrame, type OmpFraming } from './ompFraming'

function framing(overrides: Partial<OmpFraming> = {}): OmpFraming {
  return { maxFrameBytes: 200, maxReassembledFrameBytes: 1_000, protocolVersion: 2, chunk: null, rejectedChunks: [], recoveringChunks: false, ...overrides }
}

/** `text` as the two `rpc_chunk` lines OMP would send for it. */
function chunks(text: string, chunkId = 'c1'): string[] {
  const bytes = Buffer.from(text)
  const half = Math.ceil(bytes.length / 2)
  return [bytes.subarray(0, half), bytes.subarray(half)].map((part, index) => JSON.stringify({
    type: 'rpc_chunk', chunkId, index, count: 2, byteLength: bytes.length, data: part.toString('base64')
  }))
}

describe('ompReadFrame outside a chunk sequence', () => {
  it('skips a line that is not JSON or not an object', () => {
    const state = framing()
    expect([ompReadFrame('not json', state), ompReadFrame('[1]', state), ompReadFrame('null', state)]).toEqual([{ skipped: true }, { skipped: true }, { skipped: true }])
  })

  it('refuses a whole frame over the frame limit and passes one within it', () => {
    const state = framing()
    expect(ompReadFrame(JSON.stringify({ type: 'x', pad: 'y'.repeat(300) }), state)).toEqual({ error: 'OMP frame exceeds maximum size' })
    expect(ompReadFrame('{"type":"x"}', state)).toEqual({ frame: { type: 'x' } })
  })
})

describe('ompReadFrame chunk sequences', () => {
  it('reassembles two chunks into their frame', () => {
    const state = framing()
    const [first, second] = chunks('{"type":"ok"}')
    expect([ompReadFrame(first, state), ompReadFrame(second, state)]).toEqual([{}, { frame: { type: 'ok' } }])
  })

  it('reports a reassembled array once, stays quiet for a nested chunk while recovering, then recovers on a whole frame', () => {
    const state = framing()
    const [array0, array1] = chunks('[1,2]')
    expect([ompReadFrame(array0, state), ompReadFrame(array1, state)]).toEqual([{}, { error: 'Invalid OMP chunk sequence' }])
    const [nested0, nested1] = chunks('{"type":"rpc_chunk"}', 'c2')
    expect([ompReadFrame(nested0, state), ompReadFrame(nested1, state)]).toEqual([{}, {}])
    expect(state.rejectedChunks).toEqual(['c1', 'c2'])
    expect(ompReadFrame('{"type":"ok"}', state)).toEqual({ frame: { type: 'ok' } })
    expect(state.recoveringChunks).toBe(false)
  })

  it('abandons an open sequence on a line that is not JSON or not an object', () => {
    for (const line of ['garbage', '[1]']) {
      const state = framing()
      ompReadFrame(chunks('{"type":"ok"}')[0], state)
      expect(ompReadFrame(line, state)).toEqual({ error: 'Invalid OMP chunk sequence' })
      expect(state.chunk).toBeNull()
    }
  })

  it('rejects a chunk line over the frame limit', () => {
    const state = framing({ maxFrameBytes: 50 })
    expect(ompReadFrame(chunks('{"type":"ok"}')[0], state)).toEqual({ error: 'Invalid OMP chunk sequence' })
    expect(state.rejectedChunks).toEqual(['c1'])
  })
})

describe('ompWriteFrame', () => {
  it('keeps a frame within the limit as one line, also when the given chunk size covers it', () => {
    expect(ompWriteFrame({ type: 'x' }, framing(), 'c1')).toEqual(['{"type":"x"}'])
    expect(ompWriteFrame({ type: 'x' }, framing(), 'c1', 50)).toEqual(['{"type":"x"}'])
  })

  it('splits an oversized frame into lines within the limit that read back as the frame', () => {
    const frame = { type: 'big', pad: 'z'.repeat(300) }
    const lines = ompWriteFrame(frame, framing(), 'c9')
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.every((line) => Buffer.byteLength(line) <= 200)).toBe(true)
    const reader = framing()
    expect(lines.map((line) => ompReadFrame(line, reader)).at(-1)).toEqual({ frame })
  })

  it('refuses a chunk id, chunk size, protocol or frame it cannot carry', () => {
    expect(() => ompWriteFrame({ type: 'x' }, framing(), '', 10)).toThrow('Invalid OMP chunk id')
    expect(() => ompWriteFrame({ type: 'x' }, framing(), 'c'.repeat(129), 10)).toThrow('Invalid OMP chunk id')
    expect(() => ompWriteFrame({ type: 'x' }, framing(), 'c1', 0)).toThrow('OMP frame limit cannot hold chunks')
    expect(() => ompWriteFrame({ type: 'x' }, framing({ protocolVersion: 1 }), 'c1', 10)).toThrow('OMP chunking requires protocol v2')
    expect(() => ompWriteFrame({ pad: 'y'.repeat(2_000) }, framing(), 'c1')).toThrow('OMP command exceeds reassembled limit')
  })
})
