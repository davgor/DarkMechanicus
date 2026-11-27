import { createHash } from 'node:crypto'
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
  const defaultHome = 'C:\\Users\\Ada\\.darkmechanicus'
  const idFor = (home: string): string[] => {
    const set: string[] = []
    expect(applyAppUserModelId('win32', id => set.push(id), { home, defaultHome })).toBe(true)
    return set
  }

  it("gives the default home the installer's app id (package.json build.appId)", () => {
    const { build } = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { build: { appId: string } }
    expect(idFor(defaultHome)).toEqual(['com.davgor.darkmechanicus'])
    expect(idFor(defaultHome)).toEqual([build.appId])
    expect(idFor('c:\\users\\ada\\.DarkMechanicus\\')).toEqual([build.appId])
  })

  it('gives an isolated home a stable id from the first 12 hex of the SHA-256 of its lower-cased path', () => {
    const digest = createHash('sha256').update('c:\\tmp\\e2e-profile').digest('hex').slice(0, 12)
    expect(idFor('C:\\tmp\\e2e-profile')).toEqual([`com.davgor.darkmechanicus.isolated.${digest}`])
    expect(idFor('C:\\tmp\\e2e-profile')).toEqual(idFor('C:\\tmp\\e2e-profile'))
  })

  it('gives the same isolated id to one home spelled in different case', () => {
    expect(idFor('C:\\TMP\\E2E-PROFILE')).toEqual(idFor('C:\\tmp\\e2e-profile'))
    expect(idFor('c:/tmp/e2e-profile/')).toEqual(idFor('C:\\tmp\\e2e-profile'))
  })

  it('gives different homes different isolated ids', () => {
    const [first] = idFor('C:\\tmp\\e2e-profile')
    const [second] = idFor('C:\\tmp\\packaged-profile')
    expect(first).toMatch(/^com\.davgor\.darkmechanicus\.isolated\.[0-9a-f]{12}$/)
    expect(second).toMatch(/^com\.davgor\.darkmechanicus\.isolated\.[0-9a-f]{12}$/)
    expect(first).not.toBe(second)
  })

  it('sets no id off Windows, for the default and isolated homes alike', () => {
    const set: string[] = []
    for (const platform of ['darwin', 'linux', 'freebsd'] as const) {
      for (const home of [defaultHome, 'C:\\tmp\\e2e-profile']) {
        expect(applyAppUserModelId(platform, id => set.push(id), { home, defaultHome })).toBe(false)
      }
    }
    expect(set).toEqual([])
  })
})
