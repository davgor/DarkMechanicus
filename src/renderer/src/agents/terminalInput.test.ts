import { describe, expect, it } from 'vitest'
import { TERMINAL_INPUT_MAX_BYTES } from '../../../shared/agents/terminalApi'
import { inputChunks } from './terminalInput'

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')

describe('inputChunks', () => {
  it('sends typed input as one message', () => {
    expect(inputChunks('ls -la\r')).toEqual(['ls -la\r'])
    expect(inputChunks('\u001b')).toEqual(['\u001b'])
  })

  it('sends nothing for empty input', () => {
    expect(inputChunks('')).toEqual([])
  })

  it('keeps input of exactly the limit in one message', () => {
    const text = 'a'.repeat(TERMINAL_INPUT_MAX_BYTES)
    expect(inputChunks(text)).toEqual([text])
  })

  it('splits a paste over 64 KiB into messages of at most 64 KiB of UTF-8, in order', () => {
    const text = 'a'.repeat(TERMINAL_INPUT_MAX_BYTES * 2 + 5)
    const chunks = inputChunks(text)
    expect(chunks.map(bytes)).toEqual([TERMINAL_INPUT_MAX_BYTES, TERMINAL_INPUT_MAX_BYTES, 5])
    expect(chunks.join('')).toBe(text)
  })

  it('measures UTF-8 bytes, not UTF-16 units', () => {
    // é is two bytes: 40 000 of them are 80 000 bytes in 40 000 units.
    const text = 'é'.repeat(40_000)
    const chunks = inputChunks(text)
    expect(chunks.map(bytes)).toEqual([TERMINAL_INPUT_MAX_BYTES, 80_000 - TERMINAL_INPUT_MAX_BYTES])
    expect(chunks.join('')).toBe(text)
  })

  it('never splits a character across messages', () => {
    // One byte, then four-byte emoji (surrogate pairs): the limit falls inside the 16 385th emoji.
    const text = `a${'😀'.repeat(20_000)}`
    const chunks = inputChunks(text)
    expect(chunks.map(bytes)).toEqual([TERMINAL_INPUT_MAX_BYTES - 3, 80_001 - (TERMINAL_INPUT_MAX_BYTES - 3)])
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/)
      expect(bytes(chunk)).toBeLessThanOrEqual(TERMINAL_INPUT_MAX_BYTES)
    }
    expect(chunks.join('')).toBe(text)
  })

  it('counts three-byte characters, and a lone surrogate as the three bytes it is sent as', () => {
    const lone = '\uD800'
    expect(inputChunks(`${'€'.repeat(3)}${lone}`, 9)).toEqual(['€€€', lone])
    expect(inputChunks(`ab${lone}c`, 5)).toEqual([`ab${lone}`, 'c'])
  })

  it('sends a character larger than the limit on its own rather than an empty message', () => {
    expect(inputChunks('a😀b', 3)).toEqual(['a', '😀', 'b'])
  })
})
