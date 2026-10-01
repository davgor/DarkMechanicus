import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { TrackedFolderView } from '../shared/desktop/api'
import { createStubWorkspace } from '../test/stubWorkspace'
import { createDesktopHandlers } from './desktop/handlers'
import { registerDesktopIpc } from './desktop/ipc'
import { guardIpc, isTrustedSender, type SenderFrame } from './ipcGuard'

const PAGE = pathToFileURL('/opt/app/out/renderer/index.html').href
const DEV = 'http://localhost:5173'

const REFUSED = {
  ok: false,
  error: { code: 'unauthorized', message: 'Refused an IPC call that did not come from the Dark Mechanicus window.' }
}

function frameAt(url: string, overrides: Partial<SenderFrame> = {}): SenderFrame {
  return { url, parent: null, detached: false, isDestroyed: () => false, ...overrides }
}

/** A frame whose properties throw, like a WebFrameMain whose render frame was disposed mid-call. */
const DISPOSED: SenderFrame = {
  get url(): string {
    throw new Error('Render frame was disposed before WebFrameMain could be accessed')
  },
  parent: null,
  detached: false,
  isDestroyed: () => false
}

describe('isTrustedSender for the packaged page', () => {
  it('trusts the top-level frame showing the packaged renderer page', () => {
    expect(isTrustedSender(frameAt(PAGE), PAGE)).toBe(true)
  })

  it('treats a query or hash on the packaged page as the same page', () => {
    expect(isTrustedSender(frameAt(`${PAGE}?view=list`), PAGE)).toBe(true)
    expect(isTrustedSender(frameAt(`${PAGE}#/epic/1`), PAGE)).toBe(true)
  })

  it('compares the resolved path, never a prefix', () => {
    expect(isTrustedSender(frameAt(PAGE.replace('/renderer/index.html', '/renderer/../renderer/index.html')), PAGE)).toBe(true)
    expect(isTrustedSender(frameAt(`${PAGE}.html`), PAGE)).toBe(false)
    expect(isTrustedSender(frameAt(`${PAGE}/../../../../etc/passwd`), PAGE)).toBe(false)
  })

  it('refuses another file on the same scheme', () => {
    expect(isTrustedSender(frameAt(pathToFileURL('/opt/app/out/renderer/other.html').href), PAGE)).toBe(false)
    expect(isTrustedSender(frameAt(pathToFileURL('/tmp/index.html').href), PAGE)).toBe(false)
    expect(isTrustedSender(frameAt('file://evil.example/opt/app/out/renderer/index.html'), PAGE)).toBe(false)
  })

  it('refuses web origins, including the dev server outside development', () => {
    expect(isTrustedSender(frameAt('https://evil.example/'), PAGE)).toBe(false)
    expect(isTrustedSender(frameAt(`${DEV}/`), PAGE)).toBe(false)
  })
})

describe('isTrustedSender for the dev server', () => {
  it('trusts any page of the dev-server origin', () => {
    expect(isTrustedSender(frameAt(`${DEV}/`), DEV)).toBe(true)
    expect(isTrustedSender(frameAt(`${DEV}/#/epic/1`), DEV)).toBe(true)
  })

  it('refuses a foreign origin, another port, or a look-alike host', () => {
    expect(isTrustedSender(frameAt('https://evil.example/'), DEV)).toBe(false)
    expect(isTrustedSender(frameAt('http://localhost:5174/'), DEV)).toBe(false)
    expect(isTrustedSender(frameAt('http://localhost:5173.evil.example/'), DEV)).toBe(false)
    expect(isTrustedSender(frameAt(PAGE), DEV)).toBe(false)
  })
})

describe('isTrustedSender for unusable frames', () => {
  it('refuses subframes even when they show the app page', () => {
    expect(isTrustedSender(frameAt(PAGE, { parent: frameAt(PAGE) }), PAGE)).toBe(false)
    expect(isTrustedSender(frameAt(`${DEV}/`, { parent: frameAt(`${DEV}/`) }), DEV)).toBe(false)
  })

  it('refuses a missing, destroyed, detached, or disposed frame', () => {
    expect(isTrustedSender(null, PAGE)).toBe(false)
    expect(isTrustedSender(undefined, PAGE)).toBe(false)
    expect(isTrustedSender(frameAt(PAGE, { isDestroyed: () => true }), PAGE)).toBe(false)
    expect(isTrustedSender(frameAt(PAGE, { detached: true }), PAGE)).toBe(false)
    expect(isTrustedSender(DISPOSED, PAGE)).toBe(false)
  })

  it('refuses everything when the app URL is unknown', () => {
    expect(isTrustedSender(frameAt(PAGE), null)).toBe(false)
  })
})

type Listener = Parameters<IpcMain['handle']>[1]

/** Records handle() registrations and invokes them with an event from the given frame. */
function createFakeIpcMain(): {
  handle(channel: string, listener: Listener): void
  channels(): string[]
  invoke(channel: string, frame: SenderFrame | null, ...args: unknown[]): Promise<unknown>
} {
  const listeners = new Map<string, Listener>()
  return {
    handle(channel, listener) {
      listeners.set(channel, listener)
    },
    channels: () => [...listeners.keys()].sort(),
    invoke: async (channel, frame, ...args) =>
      listeners.get(channel)?.({ senderFrame: frame } as IpcMainInvokeEvent, ...args)
  }
}

describe('guardIpc', () => {
  it('registers each channel once on the underlying ipcMain', () => {
    const ipc = createFakeIpcMain()
    const guarded = guardIpc(ipc, { appUrl: PAGE })

    guarded.handle('app:one', () => 1)
    guarded.handle('app:two', () => 2)

    expect(ipc.channels()).toEqual(['app:one', 'app:two'])
  })

  it('runs the handler for the app page with the event and every payload argument', async () => {
    const ipc = createFakeIpcMain()
    const seen: unknown[][] = []
    guardIpc(ipc, { appUrl: PAGE }).handle('app:echo', (event, ...args) => {
      seen.push([event.senderFrame?.url, ...args])
      return 'handled'
    })

    const result = await ipc.invoke('app:echo', frameAt(PAGE), 'a', 2)

    expect(result).toBe('handled')
    expect(seen).toEqual([[PAGE, 'a', 2]])
  })

  it('answers other senders with the unauthorized envelope and never runs the handler', async () => {
    const ipc = createFakeIpcMain()
    const refusals: string[][] = []
    let runs = 0
    guardIpc(ipc, { appUrl: PAGE, onRefused: (channel, url) => refusals.push([channel, url]) }).handle(
      'app:echo',
      () => {
        runs += 1
        return 'handled'
      }
    )

    const foreign = await ipc.invoke('app:echo', frameAt('https://evil.example/'))
    const gone = await ipc.invoke('app:echo', null)
    const disposed = await ipc.invoke('app:echo', DISPOSED)

    expect([foreign, gone, disposed]).toEqual([REFUSED, REFUSED, REFUSED])
    expect(runs).toBe(0)
    expect(refusals).toEqual([
      ['app:echo', 'https://evil.example/'],
      ['app:echo', '(no frame)'],
      ['app:echo', '(unreadable frame)']
    ])
  })
})

const FOLDER = '/repos/demo'

const FOLDER_VIEW: TrackedFolderView = {
  path: FOLDER,
  name: 'demo',
  displayPath: FOLDER,
  initialized: true,
  available: true,
  addedAt: '2026-01-01T00:00:00.000Z'
}

/** Desktop handlers over a registry that tracks every folder and a pool that records what it opens. */
function trustingDesktop() {
  const workspace = createStubWorkspace({ canned: { listEpics: [] } })
  const opened: string[] = []
  const handlers = createDesktopHandlers({
    registry: {
      list: () => [FOLDER_VIEW],
      track: () => ({ folder: FOLDER_VIEW, added: false }),
      untrack: () => [],
      resolve: (path) => path
    },
    pool: {
      get: (path) => {
        opened.push(path)
        return workspace
      },
      close: () => undefined
    },
    pickDirectory: async () => null,
    writeClipboard: () => undefined,
    openExternal: async () => undefined,
    mcpConfig: () => ({ command: 'node', args: [], env: {}, json: '{}', note: 'n' }),
    installSkills: () => ({ written: [] })
  })
  return { workspace, opened, handlers }
}

describe('guarded desktop channels', () => {
  it('never opens or calls the workspace for an untrusted sender', async () => {
    const ipc = createFakeIpcMain()
    const desktop = trustingDesktop()
    registerDesktopIpc(guardIpc(ipc, { appUrl: PAGE }), desktop.handlers)

    const refused = await ipc.invoke('dm:command', frameAt('https://evil.example/'), FOLDER, 'listEpics', undefined)
    const fromSubframe = await ipc.invoke('dm:command', frameAt(PAGE, { parent: frameAt(PAGE) }), FOLDER, 'listEpics')

    expect([refused, fromSubframe]).toEqual([REFUSED, REFUSED])
    expect(desktop.opened).toEqual([])
    expect(desktop.workspace.calls).toEqual([])
  })

  it('still serves the app page itself', async () => {
    const ipc = createFakeIpcMain()
    const desktop = trustingDesktop()
    registerDesktopIpc(guardIpc(ipc, { appUrl: PAGE }), desktop.handlers)

    const served = await ipc.invoke('dm:command', frameAt(PAGE), FOLDER, 'listEpics', undefined)

    expect(served).toEqual({ ok: true, data: [] })
    expect(desktop.opened).toEqual([FOLDER])
    expect(desktop.workspace.calls).toEqual([{ name: 'listEpics', input: undefined }])
  })

  it('refuses every dm channel for an untrusted sender', async () => {
    const ipc = createFakeIpcMain()
    registerDesktopIpc(guardIpc(ipc, { appUrl: DEV }), trustingDesktop().handlers)

    const answers = await Promise.all(ipc.channels().map((channel) => ipc.invoke(channel, frameAt(PAGE), FOLDER)))

    expect(ipc.channels()).toHaveLength(8)
    expect(answers).toEqual(ipc.channels().map(() => REFUSED))
  })
})

const MAIN_DIR = fileURLToPath(new URL('.', import.meta.url))

/** Every production source file of the main process, keyed by its path relative to src/main. */
function mainSources(): [string, string][] {
  return readdirSync(MAIN_DIR, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts'))
    .map((path): [string, string] => [path.split('\\').join('/'), readFileSync(join(MAIN_DIR, path), 'utf8')])
    .sort(([a], [b]) => a.localeCompare(b))
}

describe('main-process IPC registration', () => {
  it('registers every handler through the sender guard', () => {
    const sources = mainSources()
    const importers = sources
      .filter(([, text]) => /import\s*\{[^}]*\bipcMain\b[^}]*\}\s*from\s*'electron'/.test(text))
      .map(([path]) => path)
    const index = sources.find(([path]) => path === 'index.ts')?.[1] ?? ''

    expect(importers).toEqual(['index.ts'])
    expect(index.match(/\bipcMain\b/g)).toHaveLength(2)
    expect(index).toMatch(/guardIpc\(\s*ipcMain\b/)
    expect(sources.filter(([, text]) => /\.ipc\.(?:handle|handleOnce|on|once)\(/.test(text))).toEqual([])
  })
})
