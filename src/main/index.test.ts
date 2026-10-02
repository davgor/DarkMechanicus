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
  hasDock: true
}))

vi.mock('electron', () => ({
  app: {
    whenReady: () => new Promise<void>((resolve) => { startup.ready = resolve }),
    get dock() {
      return startup.hasDock ? { setIcon: (icon: string) => startup.dockIcons.push(icon) } : undefined
    },
    on: () => {},
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
vi.mock('./desktop/bootstrap', () => ({ startDesktopBridge: () => {} }))
vi.mock('./desktop/navigation', () => ({ resolveAppUrl: () => 'file:///app/index.html', hardenWebContents: () => {} }))
vi.mock('./ipcGuard', () => ({ guardIpc: () => ({ handle: () => {} }) }))
vi.mock('./logger', () => ({ setupGlobalErrorLogging: () => {}, logger: { warn: () => {} } }))

beforeEach(() => {
  vi.resetModules()
  startup.ready = undefined
  startup.options = []
  startup.dockIcons = []
  startup.loadedUrls = []
  startup.loadedFiles = []
  startup.hasDock = true
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
