import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserOperation } from '../../shared/browser/browserControl'
import type { ControlOperationContext } from '../control/controlServer'
import { createBrowserDispatcher, type BrowserControlBinding } from './browserDispatch'
import type { BrowserDriver } from './browserDriver'
import type { AgentTab, HostContents } from './browserHost'
import { createBrowserOwnership, type OwnerLabelChat } from './browserOwnership'
import { createBrowserShots } from './browserShots'

const FOLDER = join(tmpdir(), 'Dispatch Repo')
const REF = { folder: FOLDER, chatId: 'chat-a' }
const IMAGE = { id: 'img_1', width: 2, height: 1, bytes: 4, mime: 'image/png' as const }
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const GRANT = `dmg_${'ab12'.repeat(16)}`

const roots: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A tab whose paint is `ready`: resolved at once by default, or a promise that never settles. */
function fakeTab(ready: 'painted' | 'never' = 'painted') {
  const whenReady = vi.fn((signal?: AbortSignal) => ready === 'painted'
    ? Promise.resolve()
    : new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })))
  const tab: AgentTab = { contents: {} as HostContents, state: () => ({ url: 'https://a.example/', title: 'A', loading: false }), whenReady }
  return { tab, whenReady }
}

function fakeDriver() {
  return {
    attach: vi.fn(), detach: vi.fn(),
    read: vi.fn(async () => ({ untrusted: true as const, content: '[e1] link "Docs"', truncated: false })),
    click: vi.fn(async () => undefined), type: vi.fn(async () => undefined), press: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => PNG)
  } satisfies BrowserDriver
}

function setup(options: { ready?: 'painted' | 'never'; shown?: boolean; window?: boolean; chat?: OwnerLabelChat | null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dm-dispatch-'))
  roots.push(root)
  const { tab, whenReady } = fakeTab(options.ready)
  const ownership = createBrowserOwnership()
  const ends = vi.fn()
  const begin = ownership.beginAgentOp.bind(ownership)
  ownership.beginAgentOp = (chatId) => {
    const lease = begin(chatId)
    return lease.ok ? { ...lease, end: () => { ends(); lease.end() } } : lease
  }
  let enabled = true
  let agentTab: AgentTab | null = null
  const host = {
    ensureAgentTab: vi.fn(() => (agentTab = tab)), agentTab: vi.fn(() => agentTab),
    agentPendingOrigin: vi.fn((): string | null => null),
    navigate: vi.fn(async () => ({ ok: true }) as const), isShown: vi.fn(() => options.shown ?? true), refresh: vi.fn()
  }
  const driver = fakeDriver()
  const images = { put: vi.fn(async () => IMAGE) }
  const keys = { value: new Set<string>() }
  const dispatcher = createBrowserDispatcher({
    host, ownership, driverFor: () => driver, settings: { enabled: () => enabled }, shots: createBrowserShots({ root }), images,
    hasWindow: () => options.window ?? true, chatFor: () => (options.chat === undefined ? { role: 'worker', title: 'Fix the docs' } : options.chat),
    boundTicketKeys: async () => keys.value
  })
  const cancel = new AbortController()
  const context = { binding: { folder: FOLDER, chatId: REF.chatId }, signal: cancel.signal } as unknown as ControlOperationContext<BrowserControlBinding>
  const run = (operation: BrowserOperation) => dispatcher.dispatch(operation, context) as Promise<Record<string, unknown>>
  return { dispatcher, run, host, tab, whenReady, driver, images, ownership, ends, keys, root, setEnabled: (value: boolean) => { enabled = value } }
}

describe('browser dispatch routes each op to the chat tab', () => {
  it('navigates through the host as the agent, waits for the paint with the op signal, and answers the tab', async () => {
    const fake = setup()
    expect(await fake.run({ op: 'browser_navigate', args: { url: 'https://a.example/' } })).toEqual({ tab: fake.tab.state() })
    expect(fake.host.navigate).toHaveBeenCalledWith(REF, 'https://a.example/', 'agent')
    expect(fake.whenReady).toHaveBeenCalledWith(expect.any(AbortSignal))
    fake.host.navigate.mockResolvedValueOnce({ ok: false, code: 'origin_blocked' } as never)
    await expect(fake.run({ op: 'browser_navigate', args: { url: 'https://b.example/' } })).rejects.toMatchObject({ code: 'origin_blocked' })
  })

  it('reads, clicks, types and presses through the driver with the op signal', async () => {
    const fake = setup()
    expect(await fake.run({ op: 'browser_read', args: { mode: 'tree', maxChars: 2000 } }))
      .toEqual({ url: 'https://a.example/', title: 'A', untrusted: true, content: '[e1] link "Docs"', truncated: false })
    expect(fake.driver.read).toHaveBeenCalledWith({ mode: 'tree', maxChars: 2000 }, { signal: expect.any(AbortSignal) })
    await fake.run({ op: 'browser_click', args: { ref: 'e1' } })
    expect(fake.driver.click).toHaveBeenCalledWith('e1', { signal: expect.any(AbortSignal) })
    await fake.run({ op: 'browser_type', args: { ref: 'e2', text: 'hello', submit: true } })
    expect(fake.driver.type).toHaveBeenCalledWith({ ref: 'e2', text: 'hello', submit: true }, { signal: expect.any(AbortSignal) })
    expect(await fake.run({ op: 'browser_press', args: { key: 'Enter' } })).toEqual({ tab: fake.tab.state() })
    expect(fake.driver.press).toHaveBeenCalledWith('Enter', { signal: expect.any(AbortSignal) })
    expect(fake.ends).toHaveBeenCalledTimes(4)
  })

  it('masks grant tokens in a reply', async () => {
    const fake = setup()
    fake.driver.read.mockResolvedValueOnce({ untrusted: true, content: `token ${GRANT}`, truncated: false })
    expect(JSON.stringify(await fake.run({ op: 'browser_read', args: { mode: 'text' } }))).not.toContain(GRANT)
  })
})

describe('browser dispatch screenshots', () => {
  it('keeps the PNG as a chat image and writes a copy in a fresh dm-browser-shot- folder', async () => {
    const fake = setup()
    const reply = await fake.run({ op: 'browser_screenshot', args: {} })
    expect(fake.images.put).toHaveBeenCalledWith(REF, PNG)
    expect(reply).toEqual({ image: IMAGE, url: 'https://a.example/', path: expect.any(String) })
    const path = reply.path as string
    expect(dirname(dirname(path))).toBe(fake.root)
    expect(basename(dirname(path))).toMatch(/^dm-browser-shot-/)
    expect(statSync(path).size).toBe(PNG.length)
  })

  it.skipIf(process.platform === 'win32')('writes the copy 0600 in a 0700 folder', async () => {
    const path = (await setup().run({ op: 'browser_screenshot', args: {} })).path as string
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
  })

  it('refuses a view not shown on the window with view_hidden, capturing nothing', async () => {
    const fake = setup({ shown: false })
    await expect(fake.run({ op: 'browser_screenshot', args: {} })).rejects.toMatchObject({ code: 'view_hidden' })
    expect(fake.driver.screenshot).not.toHaveBeenCalled()
    expect(fake.images.put).not.toHaveBeenCalled()
  })
})

const AGENT_OPS: BrowserOperation[] = [
  { op: 'browser_navigate', args: { url: 'https://a.example/' } }, { op: 'browser_read', args: { mode: 'text' } },
  { op: 'browser_click', args: { ref: 'e1' } }, { op: 'browser_type', args: { ref: 'e1', text: 'x' } },
  { op: 'browser_press', args: { key: 'Tab' } }, { op: 'browser_screenshot', args: {} }
]

describe('browser dispatch gates', () => {
  it.each(AGENT_OPS)('refuses $op with browser_disabled while the browser is off, touching nothing', async (operation) => {
    const fake = setup()
    fake.setEnabled(false)
    await expect(fake.run(operation)).rejects.toMatchObject({ code: 'browser_disabled' })
    expect(fake.host.ensureAgentTab).not.toHaveBeenCalled()
    expect(fake.ownership.owner(REF.chatId)).toBe('none')
  })

  it('passes stopped and paused_by_person through, and answers no_tab with no window', async () => {
    const fake = setup()
    fake.ownership.stop(REF.chatId)
    await expect(fake.run({ op: 'browser_click', args: { ref: 'e1' } })).rejects.toMatchObject({ code: 'stopped' })
    fake.ownership.takeControl(REF.chatId)
    await expect(fake.run({ op: 'browser_click', args: { ref: 'e1' } })).rejects.toMatchObject({ code: 'paused_by_person' })
    expect(fake.driver.click).not.toHaveBeenCalled()
    await expect(setup({ window: false }).run({ op: 'browser_read', args: { mode: 'text' } })).rejects.toMatchObject({ code: 'no_tab' })
  })

  it('aborts an op waiting for the paint at once when the person stops the agent', async () => {
    const fake = setup({ ready: 'never' })
    const pending = fake.run({ op: 'browser_click', args: { ref: 'e1' } })
    await vi.waitFor(() => expect(fake.whenReady).toHaveBeenCalled())
    fake.ownership.stop(REF.chatId)
    await expect(pending).rejects.toMatchObject({ code: 'stopped' })
    expect(fake.ends).toHaveBeenCalledOnce()
  })
})

describe('browser dispatch status (Fix 47)', () => {
  it('reports the owner with no transition and never creates a tab', async () => {
    const fake = setup()
    expect(await fake.run({ op: 'browser_status', args: {} })).toEqual({ enabled: true, owner: 'none', tab: null, pendingOrigin: null })
    expect(fake.ownership.owner(REF.chatId)).toBe('none')
    expect(fake.host.ensureAgentTab).not.toHaveBeenCalled()
    fake.ownership.stop(REF.chatId)
    expect(await fake.run({ op: 'browser_status', args: {} })).toMatchObject({ owner: 'stopped' })
  })

  it("reports enabled:false while off, and only the agent tab's state and prompt", async () => {
    const fake = setup()
    await fake.run({ op: 'browser_read', args: { mode: 'text' } })
    fake.host.agentPendingOrigin.mockReturnValue('https://new.example')
    fake.setEnabled(false)
    expect(await fake.run({ op: 'browser_status', args: {} }))
      .toEqual({ enabled: false, owner: 'agent', tab: fake.tab.state(), pendingOrigin: 'https://new.example' })
    expect(fake.host.agentPendingOrigin).toHaveBeenCalledWith(REF)
  })
})

describe('browser dispatch deadline (R19-7)', () => {
  it('fails a click on a never-painting view within its 20 s scope, releases its slot and clicks nothing', async () => {
    vi.useFakeTimers()
    const fake = setup({ ready: 'never' })
    const outcome = fake.run({ op: 'browser_click', args: { ref: 'e1' } }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(19_999)
    expect(fake.ends).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await outcome).toMatchObject({ code: 'timeout' })
    expect(fake.ends).toHaveBeenCalledOnce()
    expect(fake.driver.click).not.toHaveBeenCalled()
  })

  it('fails a read on a hidden view that never paints (throttled) within the scope', async () => {
    vi.useFakeTimers()
    const fake = setup({ ready: 'never', shown: false })
    const outcome = fake.run({ op: 'browser_read', args: { mode: 'text' } }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await outcome).toMatchObject({ code: 'timeout' })
    expect(fake.driver.read).not.toHaveBeenCalled()
    expect(fake.ends).toHaveBeenCalledOnce()
  })
})

/** The reply as the pipe would encode it, with the longest request id. */
const replyBytes = (data: unknown) => Buffer.byteLength(JSON.stringify({ version: 1, requestId: 'r'.repeat(128), ok: true, data }))

describe('browser_read fits its reply (R19-5)', () => {
  it.each([
    ['Cyrillic', 'Ж'.repeat(48_000)],
    ['CJK', '漢'.repeat(48_000)],
    ['an astral page', '😀'.repeat(24_000)],
    ['a tree full of quotes and newlines', '[e1] button "\\"q\\""\n'.repeat(2_400).slice(0, 48_000)]
  ])('cuts a 48,000-character %s page to 61,440 bytes, marked truncated', async (_name, content) => {
    const fake = setup()
    fake.driver.read.mockResolvedValueOnce({ untrusted: true, content, truncated: false })
    const reply = await fake.run({ op: 'browser_read', args: { mode: 'tree' } })
    expect(replyBytes(reply)).toBeLessThanOrEqual(61_440)
    expect(replyBytes(reply)).toBeGreaterThan(61_000)
    expect(reply.truncated).toBe(true)
    expect(content.startsWith(reply.content as string)).toBe(true)
    expect(reply.content as string).not.toMatch(/[\uD800-\uDBFF]$/)
  })

  it('leaves a reply that fits untouched', async () => {
    const reply = await setup().run({ op: 'browser_read', args: { mode: 'text' } })
    expect(reply.truncated).toBe(false)
  })
})

describe('browser owner labels (R19-2)', () => {
  it("names a bound ticket's Acolyte, else the chat's own name; a Magos chat is Magos; the person is You", async () => {
    const fake = setup()
    fake.keys.value = new Set(['DM-442'])
    await fake.run({ op: 'browser_click', args: { ref: 'e1', as: 'Acolyte:DM-442' } })
    expect(fake.dispatcher.ownerLabel(REF, 'agent')).toBe('Acolyte:DM-442')
    expect(fake.host.refresh).toHaveBeenCalledWith(REF)
    fake.keys.value = new Set()
    await fake.run({ op: 'browser_click', args: { ref: 'e1', as: 'Acolyte:DM-442' } })
    expect(fake.dispatcher.ownerLabel(REF, 'agent')).toBe('Fix the docs')
    expect(fake.dispatcher.ownerLabel(REF, 'person')).toBe('You')
    const magos = setup({ chat: { role: 'orchestrator', runId: 'rn_01', title: 'Run chat' } })
    await magos.run({ op: 'browser_click', args: { ref: 'e1', as: 'Magos' } })
    expect(magos.dispatcher.ownerLabel(REF, 'agent')).toBe('Magos')
  })
})
