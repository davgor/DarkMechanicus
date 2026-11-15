import { TextDecoder } from 'node:util'
import { NamingControlError } from '../../shared/agents/chatNaming'

/** Bounds raw bytes before buffering or decoding, including unterminated and fragmented input. */
export function createControlFrame(maxBytes: number): { push(chunk: Buffer): string | null; clear(): void } {
  let chunks: Buffer[] = []
  let bytes = 0
  let complete = false
  return {
    push(chunk) {
      if (complete || bytes + chunk.length > maxBytes) {
        throw new NamingControlError('invalid_request')
      }
      bytes += chunk.length
      const newline = chunk.indexOf(10)
      if (newline !== -1 && newline !== chunk.length - 1) {
        throw new NamingControlError('invalid_request')
      }
      chunks.push(chunk)
      if (newline === -1) {
        return null
      }
      complete = true
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes).subarray(0, bytes - 1))
      } catch {
        throw new NamingControlError('invalid_request')
      } finally {
        chunks = []
      }
    },
    clear() {
      chunks = []
      bytes = 0
      complete = true
    }
  }
}
