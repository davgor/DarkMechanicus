import { TERMINAL_INPUT_MAX_BYTES } from '../../../shared/agents/terminalApi'

/** UTF-8 bytes of a code point; a lone surrogate is sent as U+FFFD, which is three. */
function utf8Bytes(codePoint: number): number {
  if (codePoint < 0x80) {
    return 1
  }
  if (codePoint < 0x800) {
    return 2
  }
  return codePoint < 0x10000 ? 3 : 4
}

/**
 * Input for the CLI as the port messages it is sent in. Main drops any single `input` over
 * `TERMINAL_INPUT_MAX_BYTES` of UTF-8, so a long paste goes as several messages, in order, each at most that
 * long and none ending inside a character. The PTY reads one byte stream, so the CLI sees the same input.
 */
export function inputChunks(data: string, maxBytes = TERMINAL_INPUT_MAX_BYTES): string[] {
  // A UTF-16 unit is at most three bytes of UTF-8 (a surrogate pair is two units for four), so this fits unmeasured.
  if (data.length * 3 <= maxBytes) {
    return data === '' ? [] : [data]
  }
  const chunks: string[] = []
  let start = 0
  let bytes = 0
  let index = 0
  while (index < data.length) {
    const codePoint = data.codePointAt(index) ?? 0
    const size = utf8Bytes(codePoint)
    if (bytes > 0 && bytes + size > maxBytes) {
      chunks.push(data.slice(start, index))
      start = index
      bytes = 0
    }
    bytes += size
    index += codePoint > 0xffff ? 2 : 1
  }
  chunks.push(data.slice(start))
  return chunks
}
