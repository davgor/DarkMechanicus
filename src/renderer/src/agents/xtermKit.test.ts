// @vitest-environment jsdom
import type { IDisposable, ITerminalOptions } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TerminalSize, TerminalView } from './terminalView'
import { createXtermKit, keyGoesToTerminal, type XtermParts } from './xtermKit'

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

  type(data: string): void {
    for (const listener of this.data) listener(data)
  }

  focus(): void {
    log.push('focus')
  }

  dispose(): void {
    log.push('dispose terminal')
  }
}

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

const PARTS = { Terminal: FakeXterm, FitAddon: FakeFit, WebglAddon: FakeWebgl, ResizeObserver: FakeResizeObserver } as unknown as XtermParts
const THEME = { background: '#100d0c', foreground: '#ece6da' }

let host: HTMLElement

beforeEach(() => {
  log = []
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
    expect(log).toEqual(['webgl 0 loaded before open', 'open', 'viewport style inert'])
    expect(document.querySelectorAll('style')).toHaveLength(0)
    expect(document.createElement('style')).toBeInstanceOf(HTMLStyleElement)
  })

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
    expect(log).toEqual(['focus', 'dispose terminal'])
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
    expect(handler).toBe(keyGoesToTerminal)
    const press = (init: KeyboardEventInit): boolean | undefined => handler?.(new KeyboardEvent('keydown', init))
    for (const key of ['c', 'v', 'w', 'q']) {
      expect(press({ key, metaKey: true })).toBe(false)
    }
    expect(press({ key: 'c', ctrlKey: true })).toBe(true)
    expect(press({ key: 'Escape' })).toBe(true)
    expect(press({ key: 'Tab' })).toBe(true)
  })
})
