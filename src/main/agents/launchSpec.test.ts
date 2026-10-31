/**
 * One launch rule for every protocol: the executable, then the spec's arguments with each whole
 * `{folder}` replaced by the chat's folder, then the protocol's own arguments. A `{folder}` inside a
 * longer argument, or an argv the shell-free launcher refuses, starts nothing.
 */
import { spawn } from 'node:child_process'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ChatAdapter, ChatAdapterStartOptions } from '../../shared/agents/chat'
import type { AgentView } from '../../shared/desktop/api'
import { CLIENT_VERSION, DM_SERVER, FOLDER, newSession } from './__mocks__/cursorRecordings'
import { FakeChild } from './__mocks__/fakeChild'
import { agent, client, ReplayAcpAgents, type Frame } from './__mocks__/replayAcpAgent'
import { createAcpAdapter, type AcpDeps } from './adapters/acp/acpAdapter'
import { genericAcpFlavor } from './adapters/acp/genericAcpFlavor'
import { createClaudeAdapter, type ClaudeQueryFactory } from './adapters/claude'
import { createClaudeProcesses } from './adapters/claudeProcess'
import { createCodexAdapter } from './adapters/codex'
import { spawnCodexTransport } from './adapters/codexProcess'
import { launchSpecFor, withFolder } from './launchSpec'

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn()
}))
vi.mock('../desktop/agentProbeNode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../desktop/agentProbeNode')>()),
  inspectExecutable: (): 'ok' => 'ok'
}))

const PARTIAL = '--root={folder}'
const platform = Object.getOwnPropertyDescriptor(process, 'platform')

function startOptions(): ChatAdapterStartOptions {
  return {
    chatId: 'chat_1',
    folder: FOLDER,
    checkFolder: () => {},
    model: null,
    role: 'planner',
    allowSave: false,
    sessionId: null,
    darkMechanicus: DM_SERVER,
    instructions: 'Use the dm CLI.'
  }
}

function row(overrides: Partial<AgentView>): AgentView {
  return {
    id: 'codex',
    kind: 'codex',
    protocol: 'codex',
    displayName: 'Codex',
    executablePath: '/bin/codex',
    args: [],
    version: null,
    reportedName: null,
    connectedVia: 'found',
    connectedAt: 'then',
    lastProbed: 'then',
    ...overrides
  }
}

beforeEach(() => {
  vi.mocked(spawn).mockReset()
})

afterEach(() => {
  if (platform !== undefined) {
    Object.defineProperty(process, 'platform', platform)
  }
})

describe('launchSpecFor', () => {
  it('gives a built-in its preset arguments, whatever its row holds', () => {
    expect(launchSpecFor(row({ args: ['--evil'] })).args).toEqual(['app-server'])
    expect(launchSpecFor(row({ id: 'claude', kind: 'claude', protocol: 'claude', args: ['--evil'] })).args).toEqual([])
    expect(launchSpecFor(row({ id: 'cursor', kind: 'cursor', protocol: 'acp' })).args).toEqual([])
  })

  it('gives a custom CLI its own arguments, with its protocol, path and name', () => {
    const spec = launchSpecFor(row({ id: 'cu_1', kind: 'custom', protocol: 'acp', displayName: 'Mine', executablePath: '/opt/mine', args: ['serve', '{folder}'] }))

    expect(spec).toEqual({ kind: 'custom', displayName: 'Mine', protocol: 'acp', executablePath: '/opt/mine', args: ['serve', '{folder}'] })
  })
})

describe('withFolder', () => {
  it('replaces every argument that is exactly {folder}, and nothing else', () => {
    expect(withFolder(['--cwd', '{folder}', 'x', '{folder}'], FOLDER)).toEqual(['--cwd', FOLDER, 'x', FOLDER])
  })

  it('refuses {folder} inside a longer argument', () => {
    expect(() => withFolder([PARTIAL], FOLDER)).toThrow('{folder} must be an argument of its own')
    expect(() => withFolder(['{folder}/sub'], FOLDER)).toThrow('{folder}')
  })
})

// ---- Codex: the spec's arguments, nothing after them ----

function codexWith(args: readonly string[]): { promise: Promise<void>; child: FakeChild } {
  const child = new FakeChild()
  vi.mocked(spawn).mockReturnValue(child.asChild())
  const adapter = createCodexAdapter('/opt/my-codex', { connect: spawnCodexTransport, newId: () => 'n', now: () => 'now' }, args)
  const promise = adapter.start(startOptions(), () => {})
  return { promise, child }
}

describe('a custom Codex app-server CLI', () => {
  it('starts as the executable, then its arguments with {folder} replaced, in the chat folder', async () => {
    const { promise, child } = codexWith(['app-server', '--root', '{folder}'])

    expect(vi.mocked(spawn).mock.calls[0]?.[0]).toBe('/opt/my-codex')
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(['app-server', '--root', FOLDER])
    expect(vi.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({ cwd: FOLDER, shell: false })
    child.emit('close', 1, null)
    await expect(promise).rejects.toThrow()
  })

  it('starts nothing for {folder} inside a longer argument', async () => {
    await expect(codexWith(['app-server', PARTIAL]).promise).rejects.toThrow('{folder} must be an argument of its own')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('starts nothing for a Windows .cmd shim with a % argument', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const adapter = createCodexAdapter('C:\\tools\\my-codex.cmd', { connect: spawnCodexTransport, newId: () => 'n', now: () => 'now' }, ['app-server', '100%'])

    await expect(adapter.start(startOptions(), () => {})).rejects.toThrow()
    expect(spawn).not.toHaveBeenCalled()
  })
})

// ---- ACP: the spec's arguments, then the flavor's (none for the generic flavor) ----

const INITIALIZE: Frame[] = [
  client({
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'dark-mechanicus', version: CLIENT_VERSION }
    }
  }),
  agent({ id: 1, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } })
]

function acpDeps(agents: ReplayAcpAgents, platformName = 'linux'): AcpDeps {
  return {
    platform: platformName,
    inspect: () => 'ok',
    transport: agents.factory,
    run: () => Promise.reject(new Error('no process runner in this test')),
    newId: () => 'id',
    now: () => 'now',
    timers: { set: () => 0, clear: () => {} },
    cancelGraceMs: 7_000,
    clientVersion: CLIENT_VERSION
  }
}

describe('a custom ACP CLI', () => {
  it('starts as the executable, then its arguments with {folder} replaced, in the chat folder, without signing in', async () => {
    const agents = new ReplayAcpAgents([...INITIALIZE, ...newSession(2, 'sess_custom')])
    const adapter = createAcpAdapter(genericAcpFlavor('My CLI'), '/opt/my-acp', acpDeps(agents), ['acp', '--workspace', '{folder}'])

    await adapter.start(startOptions(), () => {})

    expect(agents.problems).toEqual([])
    expect(agents.launches[0]?.launch.file).toBe('/opt/my-acp')
    expect(agents.launches[0]?.launch.args).toEqual(['acp', '--workspace', FOLDER])
    expect(agents.launches[0]?.cwd).toBe(FOLDER)
    expect(adapter.kind).toBe('custom')
    await expect(adapter.listModels()).resolves.toEqual([])
  })

  it('starts nothing for {folder} inside a longer argument', async () => {
    const agents = new ReplayAcpAgents([])
    const adapter = createAcpAdapter(genericAcpFlavor('My CLI'), '/opt/my-acp', acpDeps(agents), [PARTIAL])

    await expect(adapter.start(startOptions(), () => {})).rejects.toThrow('{folder} must be an argument of its own')
    expect(agents.launches).toEqual([])
  })

  it('starts nothing for a Windows .cmd shim with a % argument', async () => {
    const agents = new ReplayAcpAgents([])
    const adapter = createAcpAdapter(genericAcpFlavor('My CLI'), 'C:\\tools\\my-acp.cmd', acpDeps(agents, 'win32'), ['acp', '50%'])

    await expect(adapter.start(startOptions(), () => {})).rejects.toThrow()
    expect(agents.launches).toEqual([])
  })
})

// ---- Claude: the spec's arguments go before the SDK's flags ----

const SDK_FLAGS = ['--output-format', 'stream-json']

/** A query that has the SDK start its process the way the SDK does, then gives up. */
function spawningQuery(asScript: boolean): ClaudeQueryFactory {
  return ({ options }: { options?: Options }) => {
    const program = options?.pathToClaudeCodeExecutable ?? ''
    options?.spawnClaudeCodeProcess?.({
      command: asScript ? 'node' : program,
      args: asScript ? [program, ...SDK_FLAGS] : SDK_FLAGS,
      cwd: options.cwd,
      env: {},
      signal: new AbortController().signal
    })
    return Promise.reject(new Error('This test stops after the spawn.'))
  }
}

function claudeWith(program: string, args: readonly string[], asScript = false): { adapter: ChatAdapter; spawned: Mock } {
  const spawned = vi.fn(() => new FakeChild().asChild() as never)
  const adapter = createClaudeAdapter(
    program,
    {
      platform: 'linux',
      query: spawningQuery(asScript),
      createProcesses: () => createClaudeProcesses({ platform: 'linux', spawn: spawned, killTree: () => Promise.resolve(true) })
    },
    args
  )
  return { adapter, spawned }
}

describe('a custom Claude Code SDK CLI', () => {
  it('starts as the executable, then its arguments with {folder} replaced, then the SDK’s flags, in the chat folder', async () => {
    const { adapter, spawned } = claudeWith('/opt/my-claude', ['--plugin-dir', '{folder}'])
    await adapter.start(startOptions(), () => {})

    await adapter.send('hi').catch(() => {})

    expect(spawned.mock.calls[0]).toEqual(['/opt/my-claude', ['--plugin-dir', FOLDER, ...SDK_FLAGS], expect.objectContaining({ cwd: FOLDER })])
  })

  it('puts the arguments after the script when the SDK runs the program through node', async () => {
    const { adapter, spawned } = claudeWith('/opt/my-claude.js', ['{folder}'], true)
    await adapter.start(startOptions(), () => {})

    await adapter.send('hi').catch(() => {})

    expect(spawned.mock.calls[0]?.[1]).toEqual(['/opt/my-claude.js', FOLDER, ...SDK_FLAGS])
  })

  it('starts nothing for {folder} inside a longer argument', async () => {
    const { adapter, spawned } = claudeWith('/opt/my-claude', [PARTIAL])

    await expect(adapter.start(startOptions(), () => {})).rejects.toThrow('{folder} must be an argument of its own')
    await expect(adapter.send('hi')).rejects.toThrow()
    expect(spawned).not.toHaveBeenCalled()
  })
})
