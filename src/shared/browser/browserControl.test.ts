import { describe, expect, it } from 'vitest'
import {
  BROWSER_CONTROL, BROWSER_KEYS, BrowserControlError, browserErrorCodeSchema, browserFailure, browserOperationSchema,
  browserReplySchema, browserRequestSchema, type BrowserOperation
} from './browserControl'
import { namingErrorCodeSchema } from '../agents/chatNaming'

const image = { id: 'ci_01h2xcejqtf2nbrexx3vqjhp41', width: 962, height: 602, bytes: 18_760, mime: 'image/png' }
const valid: BrowserOperation[] = [
  { op: 'browser_status', args: {} },
  { op: 'browser_navigate', args: { url: 'https://example.com/', as: 'Acolyte:DM-442' } },
  { op: 'browser_click', args: { ref: 'e12' } },
  { op: 'browser_type', args: { ref: 'e1', text: 'hello', submit: true } },
  { op: 'browser_press', args: { key: 'Enter' } },
  { op: 'browser_read', args: { mode: 'tree', maxChars: 4000 } },
  { op: 'browser_screenshot', args: { label: 'login page' } }
]
const accepts = (operation: unknown) => browserOperationSchema.safeParse(operation).success

describe('browser control limits', () => {
  it('declares the browser server its own bounds', () => {
    expect(BROWSER_CONTROL).toEqual({
      version: 1, requestBytes: 8192, responseBytes: 65_536, connections: 16, queuedPerChat: 4, frameMs: 2000, serverMs: 30_000, clientMs: 35_000
    })
  })
})

describe('browser operations', () => {
  it.each(valid)('accepts a valid $op and rejects an unknown key in its args or envelope', (operation) => {
    expect(browserOperationSchema.parse(operation)).toEqual(operation)
    expect(accepts({ ...operation, args: { ...operation.args, extra: 1 } })).toBe(false)
    expect(accepts({ ...operation, extra: 1 })).toBe(false)
  })

  it('takes an optional plain-text caller label of at most 40 characters on every op', () => {
    for (const operation of valid) {
      expect(accepts({ ...operation, args: { ...operation.args, as: 'x'.repeat(40) } })).toBe(true)
      expect(accepts({ ...operation, args: { ...operation.args, as: 'x'.repeat(41) } })).toBe(false)
      expect(accepts({ ...operation, args: { ...operation.args, as: 'Acolyte\nMagos' } })).toBe(false)
      expect(accepts({ ...operation, args: { ...operation.args, as: 'Magos\u202e' } })).toBe(false)
      expect(accepts({ ...operation, args: { ...operation.args, as: '' } })).toBe(false)
    }
  })

  it('bounds refs to e and one to six digits', () => {
    for (const ref of ['e0', 'e123456']) expect(accepts({ op: 'browser_click', args: { ref } })).toBe(true)
    for (const ref of ['e', 'e1234567', 'E1', 'e1a', ' e1', 'x1']) {
      expect(accepts({ op: 'browser_click', args: { ref } })).toBe(false)
      expect(accepts({ op: 'browser_type', args: { ref, text: 'a' } })).toBe(false)
    }
  })

  it('accepts only the listed keys', () => {
    for (const key of BROWSER_KEYS) expect(accepts({ op: 'browser_press', args: { key } })).toBe(true)
    expect(BROWSER_KEYS).toHaveLength(12)
    for (const key of ['enter', 'F5', 'Control', 'a', 'Delete']) expect(accepts({ op: 'browser_press', args: { key } })).toBe(false)
  })

  it('bounds maxChars to 1000-48000 integers', () => {
    for (const maxChars of [1000, 48_000]) expect(accepts({ op: 'browser_read', args: { mode: 'text', maxChars } })).toBe(true)
    for (const maxChars of [999, 48_001, 1000.5, '2000']) expect(accepts({ op: 'browser_read', args: { mode: 'text', maxChars } })).toBe(false)
    expect(accepts({ op: 'browser_read', args: { mode: 'html' } })).toBe(false)
  })

  it('bounds the URL to 2048 characters and typed text to 2000', () => {
    const url = 'https://a.example/' + 'p'.repeat(2048 - 18)
    expect(accepts({ op: 'browser_navigate', args: { url } })).toBe(true)
    expect(accepts({ op: 'browser_navigate', args: { url: url + 'p' } })).toBe(false)
    expect(accepts({ op: 'browser_type', args: { ref: 'e1', text: 't'.repeat(2000) } })).toBe(true)
    expect(accepts({ op: 'browser_type', args: { ref: 'e1', text: 't'.repeat(2001) } })).toBe(false)
  })
})

describe('browser op names and request envelope', () => {
  it('rejects an unknown op', () => {
    expect(accepts({ op: 'browser_eval', args: {} })).toBe(false)
    expect(accepts({ op: 'name_chat', args: { title: 'x' } })).toBe(false)
  })

  it('wraps every op in the versioned, token-bound request envelope', () => {
    const authority = { version: 1, requestId: 'r-1', token: 'grant' }
    for (const operation of valid) expect(browserRequestSchema.safeParse({ ...operation, ...authority }).success).toBe(true)
    expect(browserRequestSchema.safeParse({ ...valid[0], ...authority, version: 2 }).success).toBe(false)
    expect(browserRequestSchema.safeParse({ ...valid[0], ...authority, requestId: 'r 1' }).success).toBe(false)
    expect(browserRequestSchema.safeParse({ ...valid[0], ...authority, extra: true }).success).toBe(false)
    expect(browserRequestSchema.safeParse({ ...valid[0], version: 1, requestId: 'r-1' }).success).toBe(false)
  })
})

describe('browser replies', () => {
  const ok = (data: unknown) => browserReplySchema.safeParse({ version: 1, requestId: 'r', ok: true, data }).success
  it('accepts each reply shape and rejects unknown keys', () => {
    const tab = { url: 'https://example.com/', title: 'Example', loading: false }
    const replies = [
      { enabled: true, owner: 'agent', tab, pendingOrigin: null },
      { enabled: false, owner: 'stopped', tab: null, pendingOrigin: 'https://other.example' },
      { url: tab.url, title: tab.title, untrusted: true, content: 'text', truncated: false },
      { image, url: tab.url },
      { tab }
    ]
    for (const data of replies) {
      expect(ok(data)).toBe(true)
      expect(ok({ ...data, extra: 1 })).toBe(false)
    }
    expect(ok({ url: tab.url, title: tab.title, untrusted: false, content: 'text', truncated: false })).toBe(false)
    expect(ok({ url: tab.url, title: tab.title, untrusted: true, content: 'c'.repeat(48_001), truncated: true })).toBe(false)
    expect(ok({ enabled: true, owner: 'magos', tab: null, pendingOrigin: null })).toBe(false)
    expect(ok({ image: { ...image, path: 'C:/x.png' }, url: tab.url })).toBe(false)
  })
})

describe('browser error codes', () => {
  it('extends the naming codes with the browser codes', () => {
    const browserCodes = [
      'browser_disabled', 'origin_blocked', 'paused_by_person', 'stopped', 'no_tab', 'stale_ref', 'invalid_url',
      'secret_refused', 'password_field', 'navigation_failed', 'stale_prompt', 'view_hidden'
    ]
    expect(browserErrorCodeSchema.options).toEqual([...namingErrorCodeSchema.options, ...browserCodes])
  })

  it('sends only a fixed message for each code', () => {
    const messages = new Set<string>()
    for (const code of browserErrorCodeSchema.options) {
      const failure = browserFailure('r-9', code)
      expect(browserReplySchema.parse(failure)).toEqual(failure)
      expect(failure.error.message).toBe(browserFailure('other', code).error.message)
      expect(new BrowserControlError(code).message).toBe(failure.error.message)
      messages.add(failure.error.message)
    }
    expect(messages.size).toBe(browserErrorCodeSchema.options.length)
    expect(browserFailure('r', 'view_hidden').error.message).toContain('browser view not visible')
    expect(browserFailure('r', 'stale_ref')).toEqual({
      version: 1, requestId: 'r', ok: false, error: { code: 'stale_ref', message: 'The element ref is no longer on the page; read the page again.' }
    })
    expect(browserReplySchema.safeParse({ version: 1, requestId: 'r', ok: false, error: { code: 'page_crashed', message: 'x' } }).success).toBe(false)
  })
})
