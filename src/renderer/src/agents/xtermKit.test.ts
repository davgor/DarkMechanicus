// @vitest-environment jsdom
import type { IDisposable, ITerminalOptions } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TerminalSize, TerminalView } from './terminalView'
import { createXtermKit, type XtermParts } from './xtermKit'

/** What happened to the fakes, in order. */
let log: string[]
let terminals: FakeXterm[]
let webgls: FakeWebgl[]
let observers: FakeResizeObserver[]
let proposed: TerminalSize | undefined

/** Adds a `<style>` the way xterm's viewport and DOM renderer do, and logs whether it came out a style element. */
function addStyle(parent: HTMLElement, who: string): void {
  const style = parent.ownerDocument.createElement('style')
  style.textContent = '.xterm { color: red; }'
  parent.append(style)
  log.push(`${who} style ${style instanceof HTMLStyleElement ? 'applied' : 'inert'}`)
}

class FakeXterm {
  cols = 80
  rows = 24
  element: HTMLElement | null = null
  readonly written: string[] = []
  readonly addons: { dispose(): void }[] = []
  readonly inputs: string[] = []
  readonly csi: { key: string; callback: (params: (number | number[])[]) => boolean }[] = []
  readonly parser = {
    registerCsiHandler: (id: { prefix?: string; final: string }, callback: (params: (number | number[])[]) => boolean): IDisposable => {
      this.csi.push({ key: `${id.prefix ?? ''}${id.final}`, callback })
      return { dispose: () => undefined }
    }
  }
  private readonly data = new Set<(data: string) => void>()
  keyHandler: ((event: KeyboardEvent) => boolean) | null = null

  constructor(readonly options: ITerminalOptions) {
    terminals.push(this)
  }

  loadAddon(addon: { activate(terminal: FakeXterm): void; dispose(): void }): void {
    this.addons.push(addon)
    addon.activate(this)
  }

  open(parent: HTMLElement): void {
    this.element = parent
    log.push('open')
    addStyle(parent, 'viewport')
  }

  write(data: string): void {
    this.written.push(data)
  }

  onData(listener: (data: string) => void): IDisposable {
    this.data.add(listener)
    return { dispose: () => this.data.delete(listener) }
  }

  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
    this.keyHandler = handler
  }

  input(data: string): void {
    this.inputs.push(data)
  }

  /** Runs the CSI handlers registered for `key` the way xterm's parser does, until one answers true. */
  feed(key: string, ...params: number[]): void {
    for (const handler of this.csi.filter((entry) => entry.key === key)) if (handler.callback(params)) return
  }

  private readonly titles = new Set<(title: string) => void>()

  onTitleChange(listener: (title: string) => void): IDisposable {
    this.titles.add(listener)
    return { dispose: () => this.titles.delete(listener) }
  }

  setTitle(title: string): void {
    for (const listener of this.titles) listener(title)
  }

  type(data: string): void {
    for (const listener of this.data) listener(data)
  }

  focus(): void {
    log.push('focus')
  }

  dispose(): void {
    log.push('dispose terminal')
    for (const addon of this.addons) addon.dispose()
  }
}

/** An addon that logs when it is loaded, and when it is disposed. */
const fakeAddon = (name: string): (new (...args: unknown[]) => { activate(terminal: FakeXterm): void; dispose(): void }) =>
  class {
    activate(terminal: FakeXterm): void {
      log.push(`${name} loaded ${terminal.element === null ? 'before open' : 'after open'}`)
    }
    dispose(): void {
      log.push(`${name} disposed`)
    }
  }

let opened: string[]
let copied: string[]

class FakeFit {
  activate(): void {}
  dispose(): void {}
  proposeDimensions(): TerminalSize | undefined {
    return proposed
  }
  fit(): void {
    const terminal = terminals.at(-1)
    if (terminal !== undefined && proposed !== undefined) {
      terminal.cols = proposed.cols
      terminal.rows = proposed.rows
    }
  }
}

class FakeWebgl {
  private lost: (() => void) | null = null
  private terminal: FakeXterm | null = null

  constructor() {
    webgls.push(this)
  }

  activate(terminal: FakeXterm): void {
    this.terminal = terminal
    log.push(`webgl ${webgls.indexOf(this)} loaded ${terminal.element === null ? 'before open' : 'after open'}`)
  }

  onContextLoss(listener: () => void): IDisposable {
    this.lost = listener
    return { dispose: () => (this.lost = null) }
  }

  loseContext(): void {
    this.lost?.()
  }

  listening(): boolean {
    return this.lost !== null
  }

  /** Disposing the addon puts xterm's DOM renderer back, which adds its style elements. */
  dispose(): void {
    log.push(`webgl ${webgls.indexOf(this)} disposed`)
    if (this.terminal?.element) addStyle(this.terminal.element, 'dom renderer')
  }
}

class FakeResizeObserver {
  readonly observed: Element[] = []
  disconnected = false
  constructor(readonly callback: () => void) {
    observers.push(this)
  }
  observe(target: Element): void {
    this.observed.push(target)
  }
  disconnect(): void {
    this.disconnected = true
  }
}

const PARTS = {
  Terminal: FakeXterm,
  FitAddon: FakeFit,
  WebglAddon: FakeWebgl,
  UnicodeGraphemesAddon: fakeAddon('graphemes'),
  WebLinksAddon: fakeAddon('web-links'),
  ClipboardAddon: fakeAddon('clipboard'),
  ResizeObserver: FakeResizeObserver,
  openLink: (url: string) => void opened.push(url),
  writeClipboard: (text: string) => Promise.resolve(void copied.push(text))
} as unknown as XtermParts
const THEME = { background: '#100d0c', foreground: '#ece6da' }

let host: HTMLElement

beforeEach(() => {
  log = []
  opened = []
  copied = []
  terminals = []
  webgls = []
  observers = []
  proposed = { cols: 120, rows: 40 }
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  document.body.innerHTML = ''
})

const create = (): TerminalView => createXtermKit(PARTS).create(host, { theme: THEME, fontFamily: 'Menlo' })

describe('xtermKit create', () => {
  it('opens a terminal in the host with the theme and face, the WebGL renderer loaded before open, and xterm’s styles inert', () => {
    create()
    expect(terminals).toHaveLength(1)
    expect(terminals[0]?.options).toMatchObject({ theme: THEME, fontFamily: 'Menlo' })
    expect(terminals[0]?.element).toBe(host)
    expect(log).toEqual([
      'graphemes loaded before open',
      'web-links loaded before open',
      'clipboard loaded before open',
      'webgl 0 loaded before open',
      'open',
      'viewport style inert'
    ])
    expect(document.querySelectorAll('style')).toHaveLength(0)
    expect(document.createElement('style')).toBeInstanceOf(HTMLStyleElement)
  })

})

describe('xtermKit addons', () => {
  it('loads the grapheme widths, link and clipboard addons on open and disposes each with the terminal', () => {
    const view = create()
    expect(terminals[0]?.options.allowProposedApi).toBe(true)
    log = []
    view.dispose()
    expect(log.filter((entry) => entry.endsWith(' disposed') || entry === 'dispose terminal')).toEqual([
      'dispose terminal',
      'graphemes disposed',
      'web-links disposed',
      'clipboard disposed',
      'webgl 0 disposed'
    ])
  })

  it('opens an OSC 8 link only on a Ctrl or Cmd click, and only through the app', () => {
    create()
    const handler = terminals[0]?.options.linkHandler
    handler?.activate(new MouseEvent('click'), 'https://example.com/a', { start: { x: 1, y: 1 }, end: { x: 2, y: 1 } })
    expect(opened).toEqual([])
    handler?.activate(new MouseEvent('click', { ctrlKey: true }), 'https://example.com/a', { start: { x: 1, y: 1 }, end: { x: 2, y: 1 } })
    handler?.activate(new MouseEvent('click', { metaKey: true }), 'mailto:a@b.c', { start: { x: 1, y: 1 }, end: { x: 2, y: 1 } })
    expect(opened).toEqual(['https://example.com/a', 'mailto:a@b.c'])
    expect(handler?.allowNonHttpProtocols).toBe(false)
  })

})

describe('xtermKit WebGL', () => {
  it('recreates the WebGL renderer when its context is lost, with the DOM renderer’s styles inert in between', () => {
    create()
    log = []
    webgls[0]?.loseContext()
    expect(log).toEqual(['webgl 0 disposed', 'dom renderer style inert', 'webgl 1 loaded after open'])
    expect(webgls[0]?.listening()).toBe(false)
    expect(webgls[1]?.listening()).toBe(true)

    log = []
    webgls[1]?.loseContext()
    expect(log).toEqual(['webgl 1 disposed', 'dom renderer style inert', 'webgl 2 loaded after open'])
    expect(document.querySelectorAll('style')).toHaveLength(0)
    expect(document.createElement('style')).toBeInstanceOf(HTMLStyleElement)
  })
})

describe('xtermKit view', () => {
  it('writes to the terminal, and hands on what is typed until unsubscribed', () => {
    const view = create()
    view.write('hello')
    const typed: string[] = []
    const stop = view.onInput((data) => typed.push(data))
    terminals[0]?.type('a')
    stop()
    terminals[0]?.type('b')
    expect(terminals[0]?.written).toEqual(['hello'])
    expect(typed).toEqual(['a'])
  })

  it('fits the grid to the host and answers its size', () => {
    const view = create()
    expect(view.fit()).toEqual({ cols: 120, rows: 40 })
  })

  it('answers null without fitting while the host has no size', () => {
    const view = create()
    proposed = undefined
    expect(view.fit()).toBeNull()
    proposed = { cols: Number.NaN, rows: Number.NaN }
    expect(view.fit()).toBeNull()
    proposed = { cols: 0, rows: 10 }
    expect(view.fit()).toBeNull()
    expect(terminals[0]?.cols).toBe(80)
  })

  it('focuses and disposes the terminal', () => {
    const view = create()
    log = []
    view.focus()
    view.dispose()
    expect(log.slice(0, 2)).toEqual(['focus', 'dispose terminal'])
  })
})

describe('xtermKit observeSize', () => {
  it('watches the element and stops when asked', () => {
    let changes = 0
    const stop = createXtermKit(PARTS).observeSize(host, () => (changes += 1))
    expect(observers[0]?.observed).toEqual([host])
    observers[0]?.callback()
    expect(changes).toBe(1)
    stop()
    expect(observers[0]?.disconnected).toBe(true)
  })
})

describe('xtermKit keys', () => {
  it('leaves every Cmd combination to the app menu, and hands Ctrl+C, Escape and Tab to the CLI', () => {
    create()
    const handler = terminals[0]?.keyHandler
    const press = (init: KeyboardEventInit): boolean | undefined => handler?.(new KeyboardEvent('keydown', init))
    for (const key of ['c', 'v', 'w', 'q']) {
      expect(press({ key, metaKey: true })).toBe(false)
    }
    expect(press({ key: 'c', ctrlKey: true })).toBe(true)
    expect(press({ key: 'Escape' })).toBe(true)
    expect(press({ key: 'Tab' })).toBe(true)
  })

  it('sends Shift+Enter as the CLI’s keyboard mode defines it, once the CLI has switched the mode on', () => {
    create()
    const terminal = terminals[0]
    const handler = terminal?.keyHandler
    const shiftEnter = (): boolean | undefined => handler?.(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }))
    expect(shiftEnter()).toBe(true)
    terminal?.feed('?h', 9001)
    expect(shiftEnter()).toBe(false)
    expect(terminal?.inputs).toEqual(['[13;28;13;1;16;1_[13;28;13;0;16;1_'])
    terminal?.feed('?l', 9001)
    expect(shiftEnter()).toBe(true)
    terminal?.feed('>m', 4, 2)
    expect(shiftEnter()).toBe(false)
    expect(terminal?.inputs.at(-1)).toBe('[27;2;13~')
    terminal?.feed('>m', 4)
    expect(shiftEnter()).toBe(true)
    expect(handler?.(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(true)
  })

  it('only watches the mode switches: xterm’s own handlers still get every one of them', () => {
    create()
    const terminal = terminals[0]
    const reached: string[] = []
    for (const key of ['?h', '?l', '>m']) {
      terminal?.parser.registerCsiHandler({ prefix: key.slice(0, 1), final: key.slice(1) }, () => {
        reached.push(key)
        return false
      })
    }
    terminal?.feed('?h', 9001)
    terminal?.feed('?l', 9001)
    terminal?.feed('>m', 4, 2)
    expect(reached).toEqual(['?h', '?l', '>m'])
  })

})

describe('xtermKit title', () => {
  it('hands on the title the terminal reports until the subscription is stopped', () => {
    const view = create()
    const heard: string[] = []
    const stop = view.onTitleChange((title) => heard.push(title))
    terminals[0]?.setTitle('Skitarii · work')
    stop()
    terminals[0]?.setTitle('later')
    expect(heard).toEqual(['Skitarii · work'])
  })
})
