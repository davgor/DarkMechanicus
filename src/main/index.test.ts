import type { BrowserWindowConstructorOptions } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const startup = vi.hoisted(() => ({
  ready: undefined as (() => void) | undefined,
  options: [] as BrowserWindowConstructorOptions[],
  dockIcons: [] as string[],
  loadedUrls: [] as string[],
  loadedFiles: [] as string[],
  hasDock: true,
  listeners: new Map<string, ((event: { preventDefault(): void }) => void)[]>(),
  quits: 0,
  liveChats: 0,
  events: [] as string[]
}))

vi.mock('electron', () => ({
  app: {
    whenReady: () => new Promise<void>((resolve) => { startup.ready = resolve }),
    get dock() {
      return startup.hasDock ? { setIcon: (icon: string) => startup.dockIcons.push(icon) } : undefined
    },
    on: (name: string, listener: (event: { preventDefault(): void }) => void) => {
      startup.listeners.set(name, [...(startup.listeners.get(name) ?? []), listener])
    },
    quit: () => {
      startup.quits += 1
    },
    getVersion: () => '0.6.0'
  },
  BrowserWindow: class {
    webContents = {}
    constructor(options: BrowserWindowConstructorOptions) { startup.options.push(options) }
    on(): void {}
    loadURL(url: string): void { startup.loadedUrls.push(url) }
    loadFile(file: string): void { startup.loadedFiles.push(file) }
  },
  ipcMain: { handle: () => {} },
  shell: {}
}))
vi.mock('./autoUpdate', () => ({ initAutoUpdate: () => {}, registerAutoUpdateHandlers: () => {} }))
vi.mock('./desktop/bootstrap', () => ({
  startDesktopBridge: () => ({
    chats: {
      liveCount: () => startup.liveChats,
      disposeAll: async () => {
        startup.events.push('dispose chats')
      }
    },
    close: () => {
      startup.events.push('close stores')
    }
  })
}))
vi.mock('./desktop/navigation', () => ({ resolveAppUrl: () => 'file:///app/index.html', hardenWebContents: () => {} }))
vi.mock('./ipcGuard', () => ({ guardIpc: () => ({ handle: () => {} }) }))
vi.mock('./logger', () => ({ setupGlobalErrorLogging: () => {}, logger: { warn: () => {}, error: () => {} } }))

beforeEach(() => {
  vi.resetModules()
  startup.ready = undefined
  startup.options = []
  startup.dockIcons = []
  startup.loadedUrls = []
  startup.loadedFiles = []
  startup.hasDock = true
  startup.listeners = new Map()
  startup.quits = 0
  startup.liveChats = 0
  startup.events = []
  vi.stubEnv('ELECTRON_RENDERER_URL', '')
})
afterEach(() => vi.unstubAllEnvs())

describe('desktop startup icon', () => {
  it('waits for Electron readiness and uses the bundled icon for the window and macOS Dock', async () => {
    await import('./index')
    expect(startup.options).toHaveLength(0)
    expect(startup.dockIcons).toHaveLength(0)
    expect(startup.ready).toBeTypeOf('function')
    startup.ready!()
    await Promise.resolve()
    expect(startup.options).toHaveLength(1)
    const options = startup.options[0]
    expect(options.icon).toEqual(expect.stringContaining('/build/icon.png'))
    expect(startup.dockIcons).toEqual([options.icon])
    expect(options.title).toBe('Dark Mechanicus')
    expect(options.webPreferences).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true })
    expect(startup.loadedFiles).toEqual([expect.stringContaining(join('renderer', 'index.html'))])
    expect(startup.loadedUrls).toHaveLength(0)
  })

  it('starts with the same window icon when the platform has no Dock', async () => {
    startup.hasDock = false
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
    await import('./index')
    startup.ready!()
    await Promise.resolve()
    expect(startup.options).toHaveLength(1)
    expect(startup.options[0].icon).toEqual(expect.stringContaining('/build/icon.png'))
    expect(startup.dockIcons).toHaveLength(0)
    expect(startup.loadedUrls).toEqual(['http://localhost:5173'])
    expect(startup.loadedFiles).toHaveLength(0)
  })
})

describe('desktop startup background', () => {
  it('paints the window in the theme --bg, so no other color shows before the page loads', async () => {
    const styles = readFileSync(join(__dirname, '..', 'renderer', 'src', 'styles.css'), 'utf8')
    const themeBg = /--bg:\s*(#[0-9a-f]{6});/i.exec(styles)?.[1]
    expect(themeBg).toMatch(/^#[0-9a-f]{6}$/i)
    await import('./index')
    startup.ready!()
    await Promise.resolve()
    expect(startup.options[0].backgroundColor?.toLowerCase()).toBe(themeBg?.toLowerCase())
  })
})

function emitBeforeQuit(): boolean {
  let prevented = false
  for (const listener of startup.listeners.get('before-quit') ?? []) {
    listener({ preventDefault: () => (prevented = true) })
  }
  return prevented
}

describe('desktop quit', () => {
  it('holds the quit until every agent chat is disposed, then closes the stores once and quits', async () => {
    startup.liveChats = 2
    await import('./index')
    startup.ready!()
    await Promise.resolve()

    const prevented = emitBeforeQuit()
    await new Promise((resolve) => setImmediate(resolve))
    emitBeforeQuit()

    expect([prevented, startup.events, startup.quits]).toEqual([true, ['dispose chats', 'close stores'], 1])
  })

  it('closes the stores once on a quit with no live chat', async () => {
    await import('./index')
    startup.ready!()
    await Promise.resolve()

    const prevented = emitBeforeQuit()
    emitBeforeQuit()

    expect([prevented, startup.events, startup.quits]).toEqual([false, ['dispose chats', 'close stores'], 0])
  })
})
