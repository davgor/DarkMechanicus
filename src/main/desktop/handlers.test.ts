import { basename } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import type { Workspace } from '../../core/workspace'
import {
  DESKTOP_COMMANDS,
  type McpConfigView,
  type TrackedFolderView
} from '../../shared/desktop/api'
import { createDesktopHandlers, firstPickedDirectory, type DesktopHandlerDeps } from './handlers'

/** Commands that exist on a Workspace but are agent-only: the desktop must not reach them. */
const AGENT_ONLY_COMMANDS = [
  'registerHost',
  'matchCapabilities',
  'startRun',
  'claimTicket',
  'heartbeatAttempt',
  'submitAttempt',
  'failAttempt',
  'carryForwardTicket',
  'submitSprintReport'
]

const NOT_TRACKED = 'That folder is not tracked by Dark Mechanicus.'

function view(path: string): TrackedFolderView {
  return {
    path,
    name: basename(path),
    displayPath: path,
    initialized: true,
    available: true,
    addedAt: '2026-01-01T00:00:00.000Z'
  }
}

/** A workspace whose every command echoes what it was called with (and on which `this`). */
function echoWorkspace(repoRoot: string): Workspace {
  const workspace: Record<string, unknown> = { repoRoot }
  for (const name of [...DESKTOP_COMMANDS, ...AGENT_ONLY_COMMANDS]) {
    workspace[name] = function (this: { repoRoot: string }, input: unknown): Promise<unknown> {
      return Promise.resolve({ name, input, repoRoot: this.repoRoot })
    }
  }
  return workspace as unknown as Workspace
}

interface WorldOptions {
  tracked?: string[]
  /** Non-canonical spellings of tracked paths (symlinks, trailing separators). */
  aliases?: Record<string, string>
  workspace?: Workspace
  /** Thrown by pool.get. */
  openError?: Error
  /** Successive results of the native folder picker. */
  picks?: (string | null)[]
  externalFails?: boolean
}

interface World {
  deps: DesktopHandlerDeps
  tracked: string[]
  opened: string[]
  closed: string[]
  clipboard: string[]
  external: string[]
  mcpCalls: string[]
  installCalls: string[]
}

function createWorld(options: WorldOptions = {}): World {
  const tracked = [...(options.tracked ?? [])]
  const aliases = options.aliases ?? {}
  const picks = [...(options.picks ?? [])]
  const world: World = {
    tracked,
    opened: [],
    closed: [],
    clipboard: [],
    external: [],
    mcpCalls: [],
    installCalls: [],
    deps: {
      registry: {
        list: () => tracked.map(view),
        track(path) {
          const canonical = aliases[path] ?? path
          const added = !tracked.includes(canonical)
          if (added) {
            tracked.push(canonical)
          }
          return { folder: view(canonical), added }
        },
        untrack(path) {
          const index = tracked.indexOf(aliases[path] ?? path)
          if (index >= 0) {
            tracked.splice(index, 1)
          }
          return tracked.map(view)
        },
        resolve(path) {
          const canonical = aliases[path] ?? path
          return tracked.includes(canonical) ? canonical : null
        }
      },
      pool: {
        get(path) {
          world.opened.push(path)
          if (options.openError !== undefined) {
            throw options.openError
          }
          return options.workspace ?? echoWorkspace(path)
        },
        close(path) {
          world.closed.push(path)
        }
      },
      pickDirectory: () => Promise.resolve(picks.shift() ?? null),
      writeClipboard: (text) => {
        world.clipboard.push(text)
      },
      openExternal: (url) => {
        world.external.push(url)
        return options.externalFails === true
          ? Promise.reject(new Error('no handler for this URL'))
          : Promise.resolve()
      },
      mcpConfig: (repoPath): McpConfigView => {
        world.mcpCalls.push(repoPath)
        return { command: 'node', args: ['mcp.js', '--repo', repoPath], env: {}, json: '{}', note: 'test' }
      },
      installSkills: (repoPath) => {
        world.installCalls.push(repoPath)
        return { written: [`${repoPath}/.claude/skills/x/SKILL.md`] }
      }
    }
  }
  return world
}

async function rejectionOf(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise
  } catch (error) {
    if (error instanceof DomainError) {
      return { code: error.code, message: error.message }
    }
    return { code: 'unexpected', message: String(error) }
  }
  return { code: 'resolved', message: '' }
}

describe('listFolders', () => {
  it('returns the tracked folders', async () => {
    const world = createWorld({ tracked: ['/repos/a', '/repos/b'] })
    const handlers = createDesktopHandlers(world.deps)

    expect(await handlers.listFolders()).toEqual([view('/repos/a'), view('/repos/b')])
  })
})

describe('pickFolder', () => {
  it('reports a cancelled dialog without touching the registry', async () => {
    const world = createWorld({ picks: [null] })
    const handlers = createDesktopHandlers(world.deps)

    expect(await handlers.pickFolder()).toEqual({ folder: null, added: false })
    expect(world.tracked).toEqual([])
  })

  it('tracks a newly picked folder', async () => {
    const world = createWorld({ picks: ['/repos/new'] })
    const handlers = createDesktopHandlers(world.deps)

    expect(await handlers.pickFolder()).toEqual({ folder: view('/repos/new'), added: true })
    expect(world.tracked).toEqual(['/repos/new'])
  })

  it('selects an already tracked folder instead of adding it again', async () => {
    const world = createWorld({ tracked: ['/repos/a'], aliases: { '/link/a': '/repos/a' }, picks: ['/link/a'] })
    const handlers = createDesktopHandlers(world.deps)

    expect(await handlers.pickFolder()).toEqual({ folder: view('/repos/a'), added: false })
    expect(world.tracked).toEqual(['/repos/a'])
  })

  it('passes registry failures through to the caller', async () => {
    const world = createWorld({ picks: ['/repos/new'] })
    world.deps.registry = {
      ...world.deps.registry,
      track: () => {
        throw new DomainError('not_found', 'Folder not found')
      }
    }

    expect(await rejectionOf(createDesktopHandlers(world.deps).pickFolder())).toEqual({
      code: 'not_found',
      message: 'Folder not found'
    })
  })
})

describe('untrackFolder', () => {
  it('removes the entry, closes its workspace, and returns the remaining folders', async () => {
    const world = createWorld({ tracked: ['/repos/a', '/repos/b'] })
    const handlers = createDesktopHandlers(world.deps)

    expect(await handlers.untrackFolder('/repos/a')).toEqual([view('/repos/b')])
    expect(world.tracked).toEqual(['/repos/b'])
    expect(world.closed).toEqual(['/repos/a'])
  })

  it('resolves an alias to the canonical path first', async () => {
    const world = createWorld({ tracked: ['/repos/a'], aliases: { '/link/a': '/repos/a' } })
    const handlers = createDesktopHandlers(world.deps)

    expect(await handlers.untrackFolder('/link/a')).toEqual([])
    expect(world.closed).toEqual(['/repos/a'])
  })

  it('leaves everything alone for a folder that is not tracked', async () => {
    const world = createWorld({ tracked: ['/repos/a'] })
    const handlers = createDesktopHandlers(world.deps)

    expect(await handlers.untrackFolder('/repos/stranger')).toEqual([view('/repos/a')])
    expect(world.tracked).toEqual(['/repos/a'])
    expect(world.closed).toEqual([])
  })

  it('rejects malformed input', async () => {
    const handlers = createDesktopHandlers(createWorld({ tracked: ['/repos/a'] }).deps)

    expect((await rejectionOf(handlers.untrackFolder(42))).code).toBe('invalid_input')
    expect((await rejectionOf(handlers.untrackFolder(undefined))).code).toBe('invalid_input')
    expect((await rejectionOf(handlers.untrackFolder(''))).code).toBe('invalid_input')
  })
})

describe('command', () => {
  it('runs an allow-listed command on the tracked folder with its input', async () => {
    const world = createWorld({ tracked: ['/repos/a'] })
    const handlers = createDesktopHandlers(world.deps)

    const result = await handlers.command('/repos/a', 'getEpic', { epicId: 'ep_1' })

    expect(result).toEqual({
      ok: true,
      data: { name: 'getEpic', input: { epicId: 'ep_1' }, repoRoot: '/repos/a' }
    })
    expect(world.opened).toEqual(['/repos/a'])
  })

  it('opens the workspace by the canonical path when given an alias', async () => {
    const world = createWorld({ tracked: ['/repos/a'], aliases: { '/link/a': '/repos/a' } })
    const handlers = createDesktopHandlers(world.deps)

    const result = await handlers.command('/link/a', 'getProject', undefined)

    expect(result).toEqual({
      ok: true,
      data: { name: 'getProject', input: undefined, repoRoot: '/repos/a' }
    })
    expect(world.opened).toEqual(['/repos/a'])
  })

  it('allows every command in the shared desktop allow-list', async () => {
    const world = createWorld({ tracked: ['/repos/a'] })
    const handlers = createDesktopHandlers(world.deps)

    const results = await Promise.all(
      DESKTOP_COMMANDS.map((name) => handlers.command('/repos/a', name, { probe: name }))
    )

    expect(results).toEqual(
      DESKTOP_COMMANDS.map((name) => ({
        ok: true,
        data: { name, input: { probe: name }, repoRoot: '/repos/a' }
      }))
    )
  })

  it('refuses agent-only commands even though the workspace implements them', async () => {
    const world = createWorld({ tracked: ['/repos/a'] })
    const handlers = createDesktopHandlers(world.deps)

    const results = await Promise.all(AGENT_ONLY_COMMANDS.map((name) => handlers.command('/repos/a', name, {})))

    expect(results.map((result) => (result.ok ? 'allowed' : result.error.code))).toEqual(
      AGENT_ONLY_COMMANDS.map(() => 'unauthorized')
    )
    expect(world.opened).toEqual([])
  })

  it('refuses names that are not commands, including workspace internals', async () => {
    const world = createWorld({ tracked: ['/repos/a'] })
    const handlers = createDesktopHandlers(world.deps)
    const names = ['nope', 'close', 'heartbeat', 'repoRoot', 'constructor', '__proto__', 'toString', 'GETPROJECT']

    const results = await Promise.all(names.map((name) => handlers.command('/repos/a', name, {})))

    expect(results.map((result) => (result.ok ? 'allowed' : result.error.code))).toEqual(
      names.map(() => 'unauthorized')
    )
    expect(world.opened).toEqual([])
  })

  it('states which command was refused', async () => {
    const handlers = createDesktopHandlers(createWorld({ tracked: ['/repos/a'] }).deps)

    expect(await handlers.command('/repos/a', 'startRun', {})).toEqual({
      ok: false,
      error: { code: 'unauthorized', message: 'The desktop may not call "startRun".' }
    })
  })

  it('refuses folders that are not tracked and never opens a workspace for them', async () => {
    const world = createWorld({ tracked: ['/repos/a'] })
    const handlers = createDesktopHandlers(world.deps)

    expect(await handlers.command('/repos/stranger', 'getProject', undefined)).toEqual({
      ok: false,
      error: { code: 'unauthorized', message: NOT_TRACKED }
    })
    expect(world.opened).toEqual([])
  })

  it('rejects a folder or command name that is not a usable string', async () => {
    const world = createWorld({ tracked: ['/repos/a'] })
    const handlers = createDesktopHandlers(world.deps)
    const badFolders = [42, null, undefined, {}, ['/repos/a'], '', 'x'.repeat(32_768)]
    const badNames = [42, null, undefined, {}, ['getProject'], '', 'y'.repeat(65)]

    const folderResults = await Promise.all(badFolders.map((folder) => handlers.command(folder, 'getProject', {})))
    const nameResults = await Promise.all(badNames.map((name) => handlers.command('/repos/a', name, {})))

    expect(folderResults.map((result) => (result.ok ? 'allowed' : result.error.code))).toEqual(
      badFolders.map(() => 'invalid_input')
    )
    expect(nameResults.map((result) => (result.ok ? 'allowed' : result.error.code))).toEqual(
      badNames.map(() => 'invalid_input')
    )
    expect(world.opened).toEqual([])
  })

  it('accepts the longest permitted folder string as far as validation goes', async () => {
    const world = createWorld({ tracked: ['/repos/a'] })
    const handlers = createDesktopHandlers(world.deps)

    const result = await handlers.command('x'.repeat(32_767), 'getProject', {})

    expect(result).toEqual({ ok: false, error: { code: 'unauthorized', message: NOT_TRACKED } })
  })

  it('maps domain errors, keeping their code and details', async () => {
    const workspace = echoWorkspace('/repos/a')
    Object.assign(workspace, {
      savePlan: () =>
        Promise.reject(new DomainError('stale_draft', 'The draft moved on.', { expected: 3, actual: 4 }))
    })
    const handlers = createDesktopHandlers(createWorld({ tracked: ['/repos/a'], workspace }).deps)

    expect(await handlers.command('/repos/a', 'savePlan', { epicId: 'ep_1' })).toEqual({
      ok: false,
      error: { code: 'stale_draft', message: 'The draft moved on.', details: { expected: 3, actual: 4 } }
    })
  })

  it('maps unexpected failures, sync or async, to an internal error', async () => {
    const workspace = echoWorkspace('/repos/a')
    Object.assign(workspace, {
      getProject: () => {
        throw new Error('sync boom')
      },
      listEpics: () => Promise.reject(new Error('async boom'))
    })
    const handlers = createDesktopHandlers(createWorld({ tracked: ['/repos/a'], workspace }).deps)

    expect(await handlers.command('/repos/a', 'getProject', undefined)).toEqual({
      ok: false,
      error: { code: 'internal', message: 'sync boom' }
    })
    expect(await handlers.command('/repos/a', 'listEpics', undefined)).toEqual({
      ok: false,
      error: { code: 'internal', message: 'async boom' }
    })
  })

  it('maps a workspace that cannot be opened', async () => {
    const openError = new DomainError('incompatible_schema', 'Database is newer than this build.')
    const handlers = createDesktopHandlers(createWorld({ tracked: ['/repos/a'], openError }).deps)

    expect(await handlers.command('/repos/a', 'getProject', undefined)).toEqual({
      ok: false,
      error: { code: 'incompatible_schema', message: 'Database is newer than this build.' }
    })
  })

  it('never throws, even when the registry itself fails', async () => {
    const world = createWorld({ tracked: ['/repos/a'] })
    world.deps.registry = {
      ...world.deps.registry,
      resolve: () => {
        throw new Error('registry offline')
      }
    }

    expect(await createDesktopHandlers(world.deps).command('/repos/a', 'getProject', undefined)).toEqual({
      ok: false,
      error: { code: 'internal', message: 'registry offline' }
    })
  })
})

describe('getMcpConfig', () => {
  it('builds the snippet for the canonical tracked path', async () => {
    const world = createWorld({ tracked: ['/repos/a'], aliases: { '/link/a': '/repos/a' } })
    const handlers = createDesktopHandlers(world.deps)

    expect(await handlers.getMcpConfig('/link/a')).toEqual({
      command: 'node',
      args: ['mcp.js', '--repo', '/repos/a'],
      env: {},
      json: '{}',
      note: 'test'
    })
    expect(world.mcpCalls).toEqual(['/repos/a'])
  })

  it('refuses untracked folders and malformed input', async () => {
    const world = createWorld({ tracked: ['/repos/a'] })
    const handlers = createDesktopHandlers(world.deps)

    expect(await rejectionOf(handlers.getMcpConfig('/repos/stranger'))).toEqual({
      code: 'unauthorized',
      message: NOT_TRACKED
    })
    expect((await rejectionOf(handlers.getMcpConfig(7))).code).toBe('invalid_input')
    expect(world.mcpCalls).toEqual([])
  })
})

describe('installSkills', () => {
  it('installs into the canonical tracked path and reports what was written', async () => {
    const world = createWorld({ tracked: ['/repos/a'], aliases: { '/link/a': '/repos/a' } })
    const handlers = createDesktopHandlers(world.deps)

    expect(await handlers.installSkills('/link/a')).toEqual({
      written: ['/repos/a/.claude/skills/x/SKILL.md']
    })
    expect(world.installCalls).toEqual(['/repos/a'])
  })

  it('never writes into a folder that is not tracked', async () => {
    const world = createWorld({ tracked: ['/repos/a'] })
    const handlers = createDesktopHandlers(world.deps)

    expect(await rejectionOf(handlers.installSkills('/etc'))).toEqual({
      code: 'unauthorized',
      message: NOT_TRACKED
    })
    expect((await rejectionOf(handlers.installSkills(null))).code).toBe('invalid_input')
    expect(world.installCalls).toEqual([])
  })
})

describe('copyText', () => {
  it('copies text up to the size limit', async () => {
    const world = createWorld()
    const handlers = createDesktopHandlers(world.deps)
    const atLimit = 'a'.repeat(100_000)

    await handlers.copyText('hello')
    await handlers.copyText('')
    await handlers.copyText(atLimit)

    expect(world.clipboard).toEqual(['hello', '', atLimit])
  })

  it('rejects text over the limit and non-strings without touching the clipboard', async () => {
    const world = createWorld()
    const handlers = createDesktopHandlers(world.deps)

    expect((await rejectionOf(handlers.copyText('a'.repeat(100_001)))).code).toBe('invalid_input')
    expect((await rejectionOf(handlers.copyText(42))).code).toBe('invalid_input')
    expect((await rejectionOf(handlers.copyText(undefined))).code).toBe('invalid_input')
    expect((await rejectionOf(handlers.copyText({ text: 'x' }))).code).toBe('invalid_input')
    expect(world.clipboard).toEqual([])
  })
})

describe('openExternal', () => {
  it('opens http, https, and mailto links using the normalized URL', async () => {
    const world = createWorld()
    const handlers = createDesktopHandlers(world.deps)

    expect(await handlers.openExternal('https://Example.com')).toBe(true)
    expect(await handlers.openExternal('http://example.com/a b')).toBe(true)
    expect(await handlers.openExternal('mailto:a@b.co')).toBe(true)
    expect(world.external).toEqual(['https://example.com/', 'http://example.com/a%20b', 'mailto:a@b.co'])
  })

  it('refuses everything else without opening anything', async () => {
    const world = createWorld()
    const handlers = createDesktopHandlers(world.deps)
    const refused = [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,hi',
      'ftp://example.com',
      '/relative',
      'not a url',
      '',
      42,
      null,
      undefined,
      { href: 'https://example.com' },
      `https://example.com/${'a'.repeat(4_096)}`
    ]

    const results = await Promise.all(refused.map((url) => handlers.openExternal(url)))

    expect(results).toEqual(refused.map(() => false))
    expect(world.external).toEqual([])
  })

  it('accepts a URL exactly at the length limit', async () => {
    const world = createWorld()
    const handlers = createDesktopHandlers(world.deps)
    const url = `https://example.com/${'a'.repeat(4_096 - 'https://example.com/'.length)}`

    expect(url).toHaveLength(4_096)
    expect(await handlers.openExternal(url)).toBe(true)
    expect(world.external).toEqual([url])
  })

  it('reports false when the system cannot open the link', async () => {
    const world = createWorld({ externalFails: true })
    const handlers = createDesktopHandlers(world.deps)

    expect(await handlers.openExternal('mailto:a@b.co')).toBe(false)
    expect(world.external).toEqual(['mailto:a@b.co'])
  })
})

describe('firstPickedDirectory', () => {
  it('returns the first chosen path, or null when cancelled or empty', () => {
    expect(firstPickedDirectory({ canceled: false, filePaths: ['/repos/a', '/repos/b'] })).toBe('/repos/a')
    expect(firstPickedDirectory({ canceled: true, filePaths: ['/repos/a'] })).toBeNull()
    expect(firstPickedDirectory({ canceled: false, filePaths: [] })).toBeNull()
  })
})
