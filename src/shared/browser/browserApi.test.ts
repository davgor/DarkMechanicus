import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  BROWSER_CHANNELS, browserChatSchema, browserDecideOriginSchema, browserNavigateSchema, browserOpenSignInSchema,
  browserRemoveSiteSchema, browserSetEnabledSchema, browserSetViewSchema, browserSitesSchema, browserStateSchema, type BrowserState
} from './browserApi'

const chat = { folder: 'C:/repo', chatId: 'chat_1' }
const cases: [string, z.ZodType, Record<string, unknown>][] = [
  ['chat', browserChatSchema, chat],
  ['project-less chat', browserChatSchema, { folder: null, chatId: 'c-2' }],
  ['setView', browserSetViewSchema, { ...chat, bounds: { x: 37, y: 93.5, width: 641, height: 401 } }],
  ['setView hide', browserSetViewSchema, { ...chat, bounds: null }],
  ['navigate', browserNavigateSchema, { ...chat, url: 'https://example.com/' }],
  ['decideOrigin', browserDecideOriginSchema, { ...chat, promptId: 'p1', decision: 'always' }],
  ['openSignIn', browserOpenSignInSchema, { ...chat, url: 'https://accounts.example.com/' }],
  ['sites', browserSitesSchema, { folder: 'C:/repo' }],
  ['removeSite', browserRemoveSiteSchema, { folder: 'C:/repo', origin: 'http://127.0.0.1:5173' }],
  ['setEnabled', browserSetEnabledSchema, { enabled: false }]
]
const state: BrowserState = {
  ...chat, enabled: true, owner: 'agent', ownerLabel: 'Acolyte:DM-442',
  tab: { url: 'https://example.com/', title: 'Example', loading: true },
  signIn: { url: 'https://accounts.example.com/', title: 'Sign in' },
  pendingOrigin: { id: 'o1', origin: 'https://other.example', requestedBy: 'agent' }
}

describe('browser panel channels', () => {
  it('names every panel channel and the push under browser:', () => {
    expect(Object.keys(BROWSER_CHANNELS)).toEqual([
      'state', 'setView', 'navigate', 'back', 'forward', 'reload', 'stopAgent', 'takeControl', 'handBack',
      'decideOrigin', 'openSignIn', 'closeSignIn', 'capture', 'sites', 'removeSite', 'setEnabled', 'event'
    ])
    for (const [key, channel] of Object.entries(BROWSER_CHANNELS)) expect(channel).toBe(`browser:${key}`)
  })
})

describe('browser panel requests', () => {
  it.each(cases)('%s accepts a valid request and rejects an unknown key', (_name, schema, request) => {
    expect(schema.parse(request)).toEqual(request)
    expect(schema.safeParse({ ...request, extra: 1 }).success).toBe(false)
  })

  it('rejects out-of-range fields', () => {
    expect(browserChatSchema.safeParse({ ...chat, chatId: '../x' }).success).toBe(false)
    expect(browserSetViewSchema.safeParse({ ...chat, bounds: { x: 0, y: 0, width: -1, height: 1 } }).success).toBe(false)
    expect(browserSetViewSchema.safeParse({ ...chat, bounds: { x: 0, y: 0, width: 1, height: 1, z: 0 } }).success).toBe(false)
    expect(browserSetViewSchema.safeParse({ ...chat, bounds: { x: Number.NaN, y: 0, width: 1, height: 1 } }).success).toBe(false)
    expect(browserNavigateSchema.safeParse({ ...chat, url: '' }).success).toBe(false)
    expect(browserNavigateSchema.safeParse({ ...chat, url: 'h'.repeat(2049) }).success).toBe(false)
    expect(browserDecideOriginSchema.safeParse({ ...chat, promptId: 'p1', decision: 'forever' }).success).toBe(false)
    for (const origin of ['https://example.com/path', 'file:///C:/x', 'example.com', 'https://a b']) {
      expect(browserRemoveSiteSchema.safeParse({ folder: null, origin }).success).toBe(false)
    }
    expect(browserSetEnabledSchema.safeParse({ enabled: 'yes' }).success).toBe(false)
  })
})

describe('BrowserState', () => {
  it('round-trips through the push schema', () => {
    expect(browserStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state)
    const idle: BrowserState = { ...chat, enabled: false, owner: 'none', ownerLabel: null, tab: null, signIn: null, pendingOrigin: null }
    expect(browserStateSchema.parse(idle)).toEqual(idle)
  })

  it('accepts a page-raised origin ask (Fix 50) and rejects unknown requesters, owners and keys', () => {
    const page = { ...state, pendingOrigin: { ...state.pendingOrigin!, requestedBy: 'page' } }
    expect(browserStateSchema.parse(page)).toEqual(page)
    expect(browserStateSchema.safeParse({ ...state, pendingOrigin: { ...state.pendingOrigin!, requestedBy: 'magos' } }).success).toBe(false)
    expect(browserStateSchema.safeParse({ ...state, owner: 'page' }).success).toBe(false)
    expect(browserStateSchema.safeParse({ ...state, extra: 1 }).success).toBe(false)
    expect(browserStateSchema.safeParse({ ...state, tab: { ...state.tab!, favicon: 'x' } }).success).toBe(false)
    expect(browserStateSchema.safeParse({ ...state, signIn: { ...state.signIn!, cookies: [] } }).success).toBe(false)
    expect(browserStateSchema.safeParse({ ...state, ownerLabel: 'x'.repeat(41) }).success).toBe(false)
  })
})
