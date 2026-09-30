import { describe, expect, it } from 'vitest'
import { DomainError } from '../core/errors'
import { runTool, toolFailure, toolSuccess } from './result'

function parseText(result: { content: unknown[] }): unknown {
  const first = result.content[0] as { type: string; text: string }
  expect(first.type).toBe('text')
  return JSON.parse(first.text)
}

describe('toolSuccess', () => {
  it('wraps data in an ok payload, mirrored in text and structured content', () => {
    const result = toolSuccess({ answer: 42 })
    expect(result).toEqual({
      content: [{ type: 'text', text: '{"ok":true,"data":{"answer":42}}' }],
      structuredContent: { ok: true, data: { answer: 42 } }
    })
    expect(result.isError).toBeUndefined()
  })

  it('keeps null data explicit', () => {
    expect(toolSuccess(null).structuredContent).toEqual({ ok: true, data: null })
    expect(parseText(toolSuccess(null))).toEqual({ ok: true, data: null })
  })

  it('serializes lists as data', () => {
    expect(toolSuccess([1, 2]).structuredContent).toEqual({ ok: true, data: [1, 2] })
  })
})

describe('toolFailure', () => {
  it('flags the result as an error and mirrors the payload', () => {
    const result = toolFailure({ code: 'not_found', message: 'No such epic.' })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual({
      ok: false,
      error: { code: 'not_found', message: 'No such epic.' }
    })
    expect(parseText(result)).toEqual({
      ok: false,
      error: { code: 'not_found', message: 'No such epic.' }
    })
  })

  it('carries structured details when present', () => {
    const result = toolFailure({ code: 'gate_blocked', message: 'Blocked.', details: { unmet: ['approval'] } })
    expect(result.structuredContent).toEqual({
      ok: false,
      error: { code: 'gate_blocked', message: 'Blocked.', details: { unmet: ['approval'] } }
    })
  })
})

describe('runTool', () => {
  it('returns success for a resolved value', async () => {
    const result = await runTool(async () => ({ id: 'ep_1' }))
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({ ok: true, data: { id: 'ep_1' } })
  })

  it('accepts synchronous functions', async () => {
    const result = await runTool(() => 'plain')
    expect(result.structuredContent).toEqual({ ok: true, data: 'plain' })
  })

  it('maps a DomainError to its structured shape', async () => {
    const result = await runTool(async () => {
      throw new DomainError('branch_changed', 'Branch moved.', { current: 'main' })
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual({
      ok: false,
      error: { code: 'branch_changed', message: 'Branch moved.', details: { current: 'main' } }
    })
  })

  it('maps unexpected errors to internal', async () => {
    const result = await runTool(() => Promise.reject(new Error('disk on fire')))
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual({ ok: false, error: { code: 'internal', message: 'disk on fire' } })
  })

  it('maps non-Error throws to internal with their string form', async () => {
    const result = await runTool(() => Promise.reject('just text'))
    expect(result.structuredContent).toEqual({ ok: false, error: { code: 'internal', message: 'just text' } })
  })

  it('reports data that cannot be serialized as an internal failure', async () => {
    const result = await runTool(async () => ({ big: 10n }))
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: 'internal' } })
  })
})
