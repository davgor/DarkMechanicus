import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyAppUserModelId, applyColorProfile, loadRendererContent, onActivateCreateWindow, onLastWindowClosed, removeWindowMenuBar, routeAppLaunch } from './windowPolicy'

describe('loadRendererContent', () => {
  it('loads the dev-server URL when provided', () => {
    const urls: string[] = []
    let files = 0
    const mode = loadRendererContent(
      'http://localhost:5173',
      (url) => {
        urls.push(url)
      },
      () => {
        files += 1
      }
    )
    expect(mode).toBe('url')
    expect(urls).toEqual(['http://localhost:5173'])
    expect(files).toBe(0)
  })

  it('loads the packaged HTML file when no URL is set', () => {
    const urls: string[] = []
    let files = 0
    const mode = loadRendererContent(
      undefined,
      (url) => {
        urls.push(url)
      },
      () => {
        files += 1
      }
    )
    expect(mode).toBe('file')
    expect(urls).toEqual([])
    expect(files).toBe(1)
  })

  it('treats an empty URL as packaged file mode', () => {
    let files = 0
    expect(
      loadRendererContent(
        '',
        () => undefined,
        () => {
          files += 1
        }
      )
    ).toBe('file')
    expect(files).toBe(1)
  })
})

describe('onActivateCreateWindow', () => {
  it('creates a window only when none are open', () => {
    let created = 0
    const create = (): void => {
      created += 1
    }

    expect(onActivateCreateWindow(0, create)).toBe(true)
    expect(created).toBe(1)

    created = 0
    expect(onActivateCreateWindow(1, create)).toBe(false)
    expect(created).toBe(0)
    expect(onActivateCreateWindow(3, create)).toBe(false)
  })
})

describe('onLastWindowClosed', () => {
  it('keeps the app alive on macOS and quits elsewhere', () => {
    let quits = 0
    const quit = (): void => {
      quits += 1
    }

    expect(onLastWindowClosed('darwin', quit)).toBe(false)
    expect(quits).toBe(0)

    expect(onLastWindowClosed('win32', quit)).toBe(true)
    expect(quits).toBe(1)

    quits = 0
    expect(onLastWindowClosed('linux', quit)).toBe(true)
    expect(quits).toBe(1)
  })
})

describe('removeWindowMenuBar', () => {
  it('clears the menu on Windows and Linux and keeps the macOS system menu', () => {
    let clears = 0
    const clearMenu = (): void => {
      clears += 1
    }

    expect(removeWindowMenuBar('darwin', clearMenu)).toBe(false)
    expect(clears).toBe(0)

    expect(removeWindowMenuBar('win32', clearMenu)).toBe(true)
    expect(clears).toBe(1)

    clears = 0
    expect(removeWindowMenuBar('linux', clearMenu)).toBe(true)
    expect(clears).toBe(1)
  })
})

describe('applyColorProfile', () => {
  it('appends force-color-profile=srgb to the command line', () => {
    const switches: Array<[string, string | undefined]> = []
    applyColorProfile({
      appendSwitch: (name, value) => {
        switches.push([name, value])
      }
    })
    expect(switches).toEqual([['force-color-profile', 'srgb']])
  })
})

describe('packaged launch routing', () => {
  const bundledMcp = join(__dirname, 'mcp.js')

  it('serves a burst of MCP clients without acquiring the desktop lock or starting a window', () => {
    const sessions: number[] = []
    const unexpected = (): never => { throw new Error('MCP launch entered the desktop path') }
    for (let client = 1; client <= 75; client++) {
      routeAppLaunch(bundledMcp, bundledMcp, {
        serveMcp: () => { sessions.push(client) },
        claimDesktop: unexpected,
        startDesktop: unexpected,
        quit: unexpected
      })
    }
    expect(sessions).toEqual(Array.from({ length: 75 }, (_, i) => i + 1))
  })

  it('admits one desktop launch and quietly exits subsequent attempts, including unrelated script paths', () => {
    let windows = 0
    const events: string[] = []
    const actions = {
      serveMcp: () => { throw new Error('Unexpected MCP dispatch') },
      claimDesktop: () => { events.push('lock'); return windows === 0 },
      startDesktop: () => { windows++; events.push('window') },
      quit: () => { events.push('quit') }
    }
    routeAppLaunch(undefined, bundledMcp, actions)
    routeAppLaunch(join(__dirname, 'other', 'mcp.js'), bundledMcp, actions)
    routeAppLaunch(undefined, bundledMcp, actions)
    expect(windows).toBe(1)
    expect(events).toEqual(['lock', 'window', 'lock', 'quit', 'lock', 'quit'])
  })
})

describe('applyAppUserModelId', () => {
  it("sets the installer's app id (package.json build.appId) on win32 only", () => {
    const set: string[] = []
    for (const platform of ['darwin', 'linux', 'freebsd'] as const) expect(applyAppUserModelId(platform, id => set.push(id))).toBe(false)
    expect(set).toEqual([])
    expect(applyAppUserModelId('win32', id => set.push(id))).toBe(true)
    expect(set).toEqual(['com.davgor.darkmechanicus'])
    const { build } = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { build: { appId: string } }
    expect(set).toEqual([build.appId])
  })
})
