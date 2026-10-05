import { describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import { AGENT_KINDS } from '../../shared/desktop/agentKinds'
import type { AgentDownloadResult, AgentKind } from '../../shared/desktop/api'
import { agentKindSchema, createAgentHandlers } from './agentHandlers'
import type { AgentProbeResult } from './agentProbe'
import { createAgentRegistry, type AgentRegistry, type RegistryFs } from './agentRegistry'

function memoryFs(): RegistryFs {
  const files = new Map<string, string>()
  return {
    readFile(path) {
      const data = files.get(path)
      if (data === undefined) {
        throw new Error(`ENOENT: ${path}`)
      }
      return data
    },
    writeFile: (path, data) => files.set(path, data),
    rename(from, to) {
      files.set(to, files.get(from) ?? '')
      files.delete(from)
    },
    mkdirp() {}
  }
}

interface WorldOptions {
  /** Successive results of the native file dialog (null is a cancelled dialog). */
  picks?: (string | null)[]
  /** What the probe says about each picked executable; defaults to Claude Code 2.1.281. */
  probe?: (kind: AgentKind, path: string) => AgentProbeResult
}

interface World {
  registry: AgentRegistry
  handlers: ReturnType<typeof createAgentHandlers>
  /** The kind each file dialog was opened for. */
  dialogs: AgentKind[]
  /** Every executable the probe was asked to run. */
  probed: [AgentKind, string][]
  /** Every kind the installer was asked to download. */
  downloaded: AgentKind[]
}

function createWorld(options: WorldOptions = {}): World {
  const picks = [...(options.picks ?? [])]
  const registry = createAgentRegistry({ file: '/state/agents.json', fs: memoryFs(), now: () => '2026-01-01T00:00:00.000Z' })
  const world: World = { registry, dialogs: [], probed: [], downloaded: [], handlers: undefined as never }
  world.handlers = createAgentHandlers({
    agents: registry,
    pickExecutable: (kind) => {
      world.dialogs.push(kind)
      return Promise.resolve(picks.shift() ?? null)
    },
    probeAgent: (kind, path) => {
      world.probed.push([kind, path])
      return Promise.resolve(options.probe?.(kind, path) ?? { ok: true, version: '2.1.281' })
    },
    installAgent: (kind) => {
      world.downloaded.push(kind)
      return Promise.resolve({ outcome: 'cancelled' })
    }
  })
  return world
}

async function rejectionCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof DomainError ? error.code : 'unexpected'
  }
  return 'resolved'
}

const WRONG_PROGRAM: AgentProbeResult = {
  ok: false,
  code: 'wrong_program',
  reason: 'This is not the Codex CLI.'
}

describe('findAgent connects a verified pick', () => {
  it('stores the executable with the probed version, connected as found', async () => {
    const world = createWorld({ picks: ['/home/me/.local/bin/claude'] })

    const result = await world.handlers.findAgent('claude')

    const expected = {
      kind: 'claude',
      executablePath: '/home/me/.local/bin/claude',
      version: '2.1.281',
      connectedVia: 'found',
      connectedAt: '2026-01-01T00:00:00.000Z',
      lastProbed: '2026-01-01T00:00:00.000Z'
    }
    expect(result).toEqual({ outcome: 'connected', agent: expected })
    expect(world.registry.list()).toEqual([expected])
    expect(world.dialogs).toEqual(['claude'])
    expect(world.probed).toEqual([['claude', '/home/me/.local/bin/claude']])
  })

  it('replaces an earlier connection of the same kind', async () => {
    const world = createWorld({ picks: ['/old/claude', '/new/claude'] })

    await world.handlers.findAgent('claude')
    await world.handlers.findAgent('claude')

    expect(world.registry.list().map((agent) => agent.executablePath)).toEqual(['/new/claude'])
  })

  it('stores a connection that reported no version as null', async () => {
    const world = createWorld({ picks: ['/bin/codex'], probe: () => ({ ok: true, version: null }) })

    await world.handlers.findAgent('codex')

    expect(world.registry.list()[0]?.version).toBeNull()
  })
})

describe('findAgent stores nothing unless the pick is verified', () => {
  it('reports a cancelled dialog without probing', async () => {
    const world = createWorld({ picks: [null] })

    expect(await world.handlers.findAgent('codex')).toEqual({ outcome: 'cancelled' })
    expect(world.probed).toEqual([])
    expect(world.registry.list()).toEqual([])
  })

  it('returns the probe reason for a refused pick and stores nothing', async () => {
    const world = createWorld({ picks: ['/bin/claude'], probe: () => WRONG_PROGRAM })

    expect(await world.handlers.findAgent('codex')).toEqual({
      outcome: 'refused',
      code: 'wrong_program',
      reason: 'This is not the Codex CLI.'
    })
    expect(world.registry.list()).toEqual([])
  })

  it('keeps the existing connection when a later pick is refused', async () => {
    const results: AgentProbeResult[] = [{ ok: true, version: '0.46.0' }, WRONG_PROGRAM]
    const world = createWorld({ picks: ['/good/codex', '/bad/codex'], probe: () => results.shift() ?? WRONG_PROGRAM })

    await world.handlers.findAgent('codex')
    await world.handlers.findAgent('codex')

    expect(world.registry.list()).toMatchObject([{ kind: 'codex', executablePath: '/good/codex', version: '0.46.0' }])
  })
})

describe('listAgents and removeAgent', () => {
  it('lists the connected agents', async () => {
    const world = createWorld({ picks: ['/bin/claude', '/bin/codex'] })
    await world.handlers.findAgent('claude')
    await world.handlers.findAgent('codex')

    expect((await world.handlers.listAgents()).map((agent) => agent.kind)).toEqual(['claude', 'codex'])
  })

  it('removes only the registry entry of that kind and returns what remains', async () => {
    const world = createWorld({ picks: ['/bin/claude', '/bin/codex'] })
    await world.handlers.findAgent('claude')
    await world.handlers.findAgent('codex')
    const dialogsBefore = world.dialogs.length

    const remaining = await world.handlers.removeAgent('claude')

    expect(remaining.map((agent) => agent.kind)).toEqual(['codex'])
    expect(world.dialogs).toHaveLength(dialogsBefore)
    expect(world.probed).toHaveLength(2)
  })

  it('treats removing an agent that is not connected as a no-op', async () => {
    const world = createWorld()

    expect(await world.handlers.removeAgent('cursor')).toEqual([])
  })
})

/** What a compromised renderer might send in place of a kind. */
const HOSTILE_INPUTS: [string, unknown][] = [
  ['a Windows path', 'C:\\Windows\\System32\\cmd.exe'],
  ['a POSIX path', '/bin/sh'],
  ['a shell command', 'claude; calc'],
  ['an object carrying a path', { kind: 'claude', executablePath: 'C:\\evil.exe' }],
  ['an object carrying only a path', { path: '/bin/sh' }],
  ['an array of kinds', ['claude']],
  ['an unknown kind', 'gemini'],
  ['a kind in the wrong case', 'Claude'],
  ['an empty string', ''],
  ['null', null],
  ['nothing', undefined],
  ['a number', 7]
]

describe('agent channel inputs accept a kind and nothing else', () => {
  it('is a closed set of exactly the supported kinds', () => {
    expect([...agentKindSchema.options]).toEqual([...AGENT_KINDS])
    for (const kind of AGENT_KINDS) {
      expect(agentKindSchema.safeParse(kind).success).toBe(true)
    }
  })

  it.each(HOSTILE_INPUTS)('findAgent rejects %s before any dialog opens or anything runs', async (_label, input) => {
    const world = createWorld({ picks: ['/bin/claude'] })

    expect(await rejectionCode(world.handlers.findAgent(input))).toBe('invalid_input')
    expect(world.dialogs).toEqual([])
    expect(world.probed).toEqual([])
    expect(world.registry.list()).toEqual([])
  })

  it.each(HOSTILE_INPUTS)('removeAgent rejects %s without touching the registry', async (_label, input) => {
    const world = createWorld({ picks: ['/bin/claude'] })
    await world.handlers.findAgent('claude')

    expect(await rejectionCode(world.handlers.removeAgent(input))).toBe('invalid_input')
    expect(world.registry.list()).toHaveLength(1)
  })

  it('only ever runs the executable the file dialog returned', async () => {
    const world = createWorld({ picks: ['/dialog/chose/this'] })

    await world.handlers.findAgent('claude')

    expect(world.probed).toEqual([['claude', '/dialog/chose/this']])
  })
})

describe('downloadAgent takes a kind and nothing else', () => {
  it.each(HOSTILE_INPUTS)('rejects %s before anything is downloaded', async (_label, input) => {
    const world = createWorld()

    expect(await rejectionCode(world.handlers.downloadAgent(input))).toBe('invalid_input')
    expect(world.downloaded).toEqual([])
    expect(world.registry.list()).toEqual([])
  })

  it.each(AGENT_KINDS)('hands %s to the installer, which owns the source, command and location', async (kind) => {
    const world = createWorld()

    expect(await world.handlers.downloadAgent(kind)).toEqual({ outcome: 'cancelled' })

    expect(world.downloaded).toEqual([kind])
  })

  it('returns whatever the installer reports', async () => {
    const failed: AgentDownloadResult = { outcome: 'failed', code: 'installer_failed', reason: 'nope', output: ['last line'] }
    const handlers = createAgentHandlers({
      agents: createAgentRegistry({ file: '/state/agents.json', fs: memoryFs() }),
      pickExecutable: () => Promise.resolve(null),
      probeAgent: () => Promise.resolve(WRONG_PROGRAM),
      installAgent: () => Promise.resolve(failed)
    })

    expect(await handlers.downloadAgent('codex')).toEqual(failed)
  })
})
