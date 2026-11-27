import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { BrowserControlError } from '../../shared/browser/browserControl'
import axTree from './__fixtures__/axTree.json'
import { createBrowserDriver, OP_DEADLINE_MS, type DriverContents } from './browserDriver'

/** `DOM.describeNode` answers recorded from the fixture page (Electron 42); the password value attribute included. */
const DESCRIBED: Record<number, { localName: string; attributes: string[] }> = {
  9: { localName: 'input', attributes: ['id', 'text', 'aria-label', 'Name'] },
  11: { localName: 'input', attributes: ['id', 'pw', 'type', 'password', 'aria-label', 'Password', 'value', 'fixture-password-0123456789'] },
  13: { localName: 'input', attributes: ['id', 'pw2', 'TYPE', 'Password', 'placeholder', 'Empty password'] }
}
/** `DOM.getBoxModel` of the Name field, recorded from the same page. */
const NAME_CONTENT_QUAD = [129.7604217529297, 80.5, 291.76043701171875, 80.5, 291.76043701171875, 95.83333587646484, 129.7604217529297, 95.83333587646484]
const NAME_CENTRE = { x: (129.7604217529297 + 291.76043701171875) / 2, y: (80.5 + 95.83333587646484) / 2 }

const TREE_GOLDEN = [
  '[e1] heading "before"',
  '[e2] button "Change heading"',
  '[e3] textbox "Name"',
  '[e4] textbox (password)',
  '[e5] textbox (password)',
  '[e6] checkbox "Remember me"',
  '[e7] link "link"',
  '[e8] link "download"',
  '[e9] StaticText "First item"',
  '[e10] StaticText "Second item"'
].join('\n')
const TEXT_GOLDEN = ['before', 'Change heading', 'Name', 'Remember me', 'link', 'download', 'First item', 'Second item'].join('\n')
const REF_NODES = { e1: 7, e2: 8, e3: 9, e4: 11, e5: 13, e6: 24, e7: 18, e8: 19, e9: 33, e10: 35 }

type Handler = (params: Record<string, unknown> | undefined) => unknown

class FakeDebugger extends EventEmitter {
  attached = false
  attachVersions: string[] = []
  detachCalls = 0
  calls: { method: string; params?: Record<string, unknown> }[] = []
  handlers: Record<string, Handler> = {
    'Accessibility.getFullAXTree': () => structuredClone(axTree),
    'DOM.describeNode': (params) => ({ node: DESCRIBED[params?.backendNodeId as number] ?? { localName: 'div', attributes: [] } }),
    'DOM.getBoxModel': () => ({ model: { content: NAME_CONTENT_QUAD, width: 170, height: 21 } })
  }

  attach(version?: string): void { this.attachVersions.push(version ?? ''); this.attached = true }
  isAttached(): boolean { return this.attached }
  detach(): void {
    this.detachCalls += 1
    this.attached = false
    this.emit('detach', {}, 'target closed')
  }
  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push(params === undefined ? { method } : { method, params })
    return await this.handlers[method]?.(params) ?? {}
  }
  methods(): string[] { return this.calls.map((call) => call.method) }
}

class FakeContents extends EventEmitter {
  readonly debugger = new FakeDebugger()
  image = { isEmpty: () => false, toPNG: () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }
  capturePage = vi.fn(async () => this.image)
}

function rig(signal?: AbortSignal) {
  const contents = new FakeContents()
  const driver = createBrowserDriver(contents, signal === undefined ? {} : { signal })
  return { contents, dbg: contents.debugger, driver }
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => null, (failure: unknown) => failure)
  expect(error).toBeInstanceOf(BrowserControlError)
  return (error as BrowserControlError).code
}

afterEach(() => { vi.useRealTimers() })

describe('browser driver contents', () => {
  it('accepts a real WebContents', () => {
    expectTypeOf<WebContents>().toMatchTypeOf<DriverContents>()
    expect(OP_DEADLINE_MS).toBe(20_000)
  })
})

describe('browser driver read', () => {
  it('lists the golden AX tree as untrusted [eN] role "name" lines', async () => {
    const { driver, dbg } = rig()
    const result = await driver.read({ mode: 'tree' })
    expect(result).toEqual({ untrusted: true, content: TREE_GOLDEN, truncated: false })
    expect(dbg.attachVersions).toEqual(['1.3'])
    expect(dbg.methods()).toEqual(['Accessibility.getFullAXTree', 'DOM.describeNode', 'DOM.describeNode', 'DOM.describeNode'])
  })

  it('maps every ref to the node backendDOMNodeId it was listed for', async () => {
    const { driver, dbg } = rig()
    await driver.read({ mode: 'tree' })
    for (const [ref, backendNodeId] of Object.entries(REF_NODES)) {
      dbg.calls = []
      await driver.click(ref)
      expect(dbg.calls[1]).toEqual({ method: 'DOM.getBoxModel', params: { backendNodeId } })
    }
  })

  it('keeps a node ref stable across reads of the same document', async () => {
    const { driver } = rig()
    await driver.read({ mode: 'tree' })
    expect((await driver.read({ mode: 'tree' })).content).toBe(TREE_GOLDEN)
  })
})

describe('browser driver read password descendants', () => {
  it('drops the text inside a password field even when Chromium does not flag it editable', async () => {
    const { driver, dbg } = rig()
    const variant = structuredClone(axTree) as { nodes: { nodeId: string; parentId?: string; name?: { value?: unknown }; properties?: { name: string }[] }[] }
    // Node 28 is the bullet StaticText under the password field's inner generic (11 -> 12 -> 28); its inline box is -1000000004.
    const inner = variant.nodes.filter((node) => node.nodeId === '28' || node.nodeId === '-1000000004')
    expect(inner).toHaveLength(2)
    for (const node of inner) {
      node.properties = []
      node.name = { value: 'fixture-password-0123456789' }
    }
    dbg.handlers['Accessibility.getFullAXTree'] = () => variant
    for (const mode of ['tree', 'text'] as const) {
      const { content } = await driver.read({ mode })
      expect(content).toBe(mode === 'tree' ? TREE_GOLDEN : TEXT_GOLDEN)
      expect(content).not.toContain('fixture-password')
    }
  })
})

describe('browser driver read redaction and clipping', () => {
  it('never returns a password value, its bullets or its length', async () => {
    const { driver } = rig()
    const fixture = JSON.stringify(axTree)
    expect(fixture).toContain('•'.repeat(27))
    for (const mode of ['tree', 'text'] as const) {
      const { content } = await driver.read({ mode })
      expect(content).not.toContain('•')
      expect(content).not.toContain('fixture-password')
      expect(content).not.toMatch(/\b27\b/)
      expect(content).not.toContain('Password')
    }
  })

  it('keeps only names and static text in text mode, with no refs', async () => {
    const { driver } = rig()
    expect(await driver.read({ mode: 'text' })).toEqual({ untrusted: true, content: TEXT_GOLDEN, truncated: false })
    expect(await codeOf(driver.click('e1'))).toBe('stale_ref')
  })

  it('clips to maxChars at a line boundary and marks the result truncated', async () => {
    const { driver } = rig()
    const lines = TREE_GOLDEN.split('\n')
    const firstThree = lines.slice(0, 3).join('\n')
    const clipped = await driver.read({ mode: 'tree', maxChars: firstThree.length + 5 })
    expect(clipped).toEqual({ untrusted: true, content: firstThree, truncated: true })
    expect(clipped.content.length).toBeLessThanOrEqual(firstThree.length + 5)
    expect(await driver.read({ mode: 'tree', maxChars: TREE_GOLDEN.length })).toMatchObject({ content: TREE_GOLDEN, truncated: false })
    expect(await driver.read({ mode: 'tree', maxChars: TREE_GOLDEN.length - 1 })).toMatchObject({ truncated: true })
  })

  it('shows a field whose DOM check fails as a password field', async () => {
    const { driver, dbg } = rig()
    dbg.handlers['DOM.describeNode'] = () => { throw new Error('No node found for given backend id') }
    const { content } = await driver.read({ mode: 'tree' })
    expect(content).toContain('[e3] textbox (password)')
    expect(content).not.toContain('"Name"')
  })
})

describe('browser driver click', () => {
  it('scrolls the node into view and presses then releases the left button at the content quad centre', async () => {
    const { driver, dbg } = rig()
    await driver.read({ mode: 'tree' })
    dbg.calls = []
    await driver.click('e3')
    const mouse = { x: NAME_CENTRE.x, y: NAME_CENTRE.y, button: 'left', clickCount: 1 }
    expect(dbg.calls).toEqual([
      { method: 'DOM.scrollIntoViewIfNeeded', params: { backendNodeId: 9 } },
      { method: 'DOM.getBoxModel', params: { backendNodeId: 9 } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', ...mouse } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', ...mouse } }
    ])
  })
})

describe('browser driver type and press', () => {
  it('focuses the field and inserts the text, then presses Enter when submit is set', async () => {
    const { driver, dbg } = rig()
    await driver.read({ mode: 'tree' })
    dbg.calls = []
    await driver.type({ ref: 'e3', text: 'hello probe', submit: true })
    expect(dbg.calls).toEqual([
      { method: 'DOM.describeNode', params: { backendNodeId: 9 } },
      { method: 'DOM.focus', params: { backendNodeId: 9 } },
      { method: 'Input.insertText', params: { text: 'hello probe' } },
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' } },
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 } }
    ])
  })

  it('refuses a dmg_ grant token or a claim token with secret_refused before any command', async () => {
    const { driver, dbg } = rig()
    await driver.read({ mode: 'tree' })
    dbg.calls = []
    expect(await codeOf(driver.type({ ref: 'e3', text: `token dmg_${'ab12'.repeat(16)} here` }))).toBe('secret_refused')
    expect(await codeOf(driver.type({ ref: 'e3', text: `at_${'0'.repeat(26)}.${'Qz9'.repeat(11)}` }))).toBe('secret_refused')
    expect(dbg.calls).toEqual([])
  })

  it('refuses a password field, including one the page turned into a password field after the read', async () => {
    const { driver, dbg } = rig()
    await driver.read({ mode: 'tree' })
    dbg.calls = []
    expect(await codeOf(driver.type({ ref: 'e4', text: 'hunter2' }))).toBe('password_field')
    expect(await codeOf(driver.type({ ref: 'e5', text: 'hunter2' }))).toBe('password_field')
    expect(dbg.calls).toEqual([])
    dbg.handlers['DOM.describeNode'] = () => ({ node: { localName: 'input', attributes: ['type', 'password'] } })
    expect(await codeOf(driver.type({ ref: 'e3', text: 'hunter2' }))).toBe('password_field')
    expect(dbg.methods()).toEqual(['DOM.describeNode'])
  })

  it.each([
    ['Enter', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, { text: '\r' }],
    ['Tab', { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }, {}]
  ] as const)('presses %s as keyDown then keyUp from the key table', async (key, event, down) => {
    const { driver, dbg } = rig()
    await driver.press(key)
    expect(dbg.calls).toEqual([
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', ...event, ...down } },
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', ...event } }
    ])
  })
})

describe('browser driver stale refs', () => {
  it('fails old refs after a navigation with stale_ref and sends nothing', async () => {
    const { driver, dbg, contents } = rig()
    await driver.read({ mode: 'tree' })
    contents.emit('did-navigate')
    dbg.calls = []
    expect(await codeOf(driver.click('e3'))).toBe('stale_ref')
    expect(await codeOf(driver.type({ ref: 'e3', text: 'x' }))).toBe('stale_ref')
    expect(dbg.calls).toEqual([])
    await driver.read({ mode: 'tree' })
    expect(await codeOf(driver.click('e11'))).toBe('stale_ref')
  })

  it('maps a node the page removed to stale_ref', async () => {
    const { driver, dbg } = rig()
    await driver.read({ mode: 'tree' })
    dbg.handlers['DOM.scrollIntoViewIfNeeded'] = () => { throw new Error('Node is detached from document') }
    expect(await codeOf(driver.click('e2'))).toBe('stale_ref')
    dbg.handlers['DOM.scrollIntoViewIfNeeded'] = () => ({})
    dbg.handlers['DOM.getBoxModel'] = () => { throw new Error('Could not compute box model.') }
    expect(await codeOf(driver.click('e2'))).toBe('stale_ref')
    expect(dbg.methods()).not.toContain('Input.dispatchMouseEvent')
  })
})

describe('browser driver abort and deadline', () => {
  it('stops an op mid-way when ownership aborts: no further command is sent', async () => {
    const ownership = new AbortController()
    const { driver, dbg } = rig(ownership.signal)
    await driver.read({ mode: 'tree' })
    dbg.handlers['DOM.getBoxModel'] = () => {
      ownership.abort('stopped')
      return { model: { content: NAME_CONTENT_QUAD } }
    }
    dbg.calls = []
    expect(await codeOf(driver.click('e3'))).toBe('stopped')
    expect(dbg.methods()).toEqual(['DOM.scrollIntoViewIfNeeded', 'DOM.getBoxModel'])
  })

  it('rejects a pending command at once on a per-op abort and reports paused_by_person', async () => {
    const { driver, dbg } = rig()
    await driver.read({ mode: 'tree' })
    dbg.handlers['DOM.focus'] = () => new Promise(() => {})
    const lease = new AbortController()
    dbg.calls = []
    const typing = driver.type({ ref: 'e3', text: 'hello' }, { signal: lease.signal })
    await vi.waitFor(() => { expect(dbg.methods()).toContain('DOM.focus') })
    lease.abort('paused_by_person')
    expect(await codeOf(typing)).toBe('paused_by_person')
    expect(dbg.methods()).toEqual(['DOM.describeNode', 'DOM.focus'])
  })

  it('refuses every op, attach included, once the session signal is aborted', async () => {
    const ownership = new AbortController()
    ownership.abort('stopped')
    const { driver, dbg } = rig(ownership.signal)
    expect(await codeOf(driver.press('Tab'))).toBe('stopped')
    expect(await codeOf(driver.screenshot())).toBe('stopped')
    expect(() => { driver.attach() }).toThrow(BrowserControlError)
    expect(dbg.attachVersions).toEqual([])
    expect(dbg.calls).toEqual([])
  })

  it('fails with timeout after the 20 s op deadline and sends nothing more', async () => {
    vi.useFakeTimers()
    const { driver, dbg } = rig()
    dbg.handlers['Input.dispatchKeyEvent'] = () => new Promise(() => {})
    const pressing = codeOf(driver.press('Enter'))
    await vi.advanceTimersByTimeAsync(OP_DEADLINE_MS - 1)
    expect(dbg.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pressing).toBe('timeout')
    expect(dbg.calls).toHaveLength(1)
  })
})

describe('browser driver attach and detach', () => {
  it('re-attaches on the next op after a detach event', async () => {
    const { driver, dbg } = rig()
    await driver.press('Tab')
    await driver.press('Tab')
    expect(dbg.attachVersions).toEqual(['1.3'])
    dbg.attached = false
    dbg.emit('detach', {}, 'target closed')
    await driver.press('Enter')
    expect(dbg.attachVersions).toEqual(['1.3', '1.3'])
  })

  it('does not re-attach after a detach once ownership has stopped the agent', async () => {
    const ownership = new AbortController()
    const { driver, dbg } = rig(ownership.signal)
    await driver.press('Tab')
    ownership.abort('paused_by_person')
    driver.detach()
    expect(await codeOf(driver.press('Tab'))).toBe('paused_by_person')
    expect(dbg.attachVersions).toEqual(['1.3'])
  })

  it('detaches idempotently', () => {
    const { driver, dbg } = rig()
    driver.attach()
    driver.attach()
    driver.detach()
    driver.detach()
    expect(dbg.attachVersions).toEqual(['1.3'])
    expect(dbg.detachCalls).toBe(1)
  })
})

describe('browser driver screenshot', () => {
  it('returns the PNG bytes from capturePage', async () => {
    const { driver, contents } = rig()
    const png = await driver.screenshot()
    expect(contents.capturePage).toHaveBeenCalledTimes(1)
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  })

  it('fails an empty or failed capture with navigation_failed', async () => {
    const { driver, contents } = rig()
    contents.image = { isEmpty: () => true, toPNG: () => Buffer.alloc(0) }
    expect(await codeOf(driver.screenshot())).toBe('navigation_failed')
    contents.capturePage.mockRejectedValueOnce(new Error('UnknownVizError'))
    expect(await codeOf(driver.screenshot())).toBe('navigation_failed')
  })
})
