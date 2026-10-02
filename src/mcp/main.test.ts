import { EventEmitter } from 'node:events'
import { dirname, join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { describe, expect, it } from 'vitest'
import { DomainError } from '../core/errors'
import type { OpenWorkspaceOptions } from '../core/workspace'
import { createStubWorkspace, type StubWorkspaceOptions } from '../test/stubWorkspace'
import { MCP_USAGE } from './args'
import {
  canonicalRepoRoot,
  installWarningFilter,
  type McpHost,
  readPackageVersion,
  redirectConsoleToStderr,
  runIfEntry,
  runMcpMain,
  startMcpServer,
  type Scheduler
} from './main'

interface FakeJob {
  ms: number
  callback: () => void
  cancelled: boolean
}

function createFakeScheduler() {
  const jobs: FakeJob[] = []
  const scheduler: Scheduler = {
    every(ms, callback) {
      const job = { ms, callback, cancelled: false }
      jobs.push(job)
      return {
        cancel: () => {
          job.cancelled = true
        }
      }
    }
  }
  const tick = (): void => {
    for (const job of jobs.filter((candidate) => !candidate.cancelled)) {
      job.callback()
    }
  }
  return { jobs, scheduler, tick }
}

const PROJECT = { projectId: 'pj_x', name: 'Demo' }

async function startRig(argv: string[], workspaceOptions: StubWorkspaceOptions = {}) {
  const workspace = createStubWorkspace({ canned: { getProject: PROJECT }, ...workspaceOptions })
  const opened: OpenWorkspaceOptions[] = []
  const logs: string[] = []
  const closedWith: unknown[] = []
  const fake = createFakeScheduler()
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const handle = await startMcpServer({
    argv,
    env: {},
    cwd: '/cwd',
    open: (options) => {
      opened.push(options)
      return workspace
    },
    transport: serverTransport,
    log: (line) => logs.push(line),
    version: '1.2.3',
    scheduler: fake.scheduler,
    onClosed: (failure) => closedWith.push(failure)
  })
  return { handle, workspace, opened, logs, closedWith, serverTransport, clientTransport, ...fake }
}

describe('startMcpServer opening the workspace', () => {
  it('maps launch flags to the workspace session', async () => {
    const rig = await startRig(['--repo', '/r', '--role', 'planner', '--allow-save', '--label', 'Alice'])
    expect(rig.opened).toEqual([
      {
        repoRoot: resolve('/r'),
        role: 'planner',
        label: 'Alice',
        transport: 'stdio',
        allowSave: true,
        pid: process.pid,
        serverInfo: { name: 'darkmechanicus', version: '1.2.3' }
      }
    ])
  })

  it('defaults to the orchestrator without save permission in the working directory', async () => {
    const rig = await startRig([])
    expect(rig.opened[0]).toMatchObject({
      repoRoot: resolve('/cwd'),
      role: 'orchestrator',
      label: 'orchestrator via MCP',
      allowSave: false
    })
  })

  it('rejects bad arguments before opening anything', async () => {
    const opened: OpenWorkspaceOptions[] = []
    const [serverTransport] = InMemoryTransport.createLinkedPair()
    const attempt = startMcpServer({
      argv: ['--role', 'desktop'],
      env: {},
      cwd: '/cwd',
      open: (options) => {
        opened.push(options)
        return createStubWorkspace()
      },
      transport: serverTransport,
      log: () => undefined,
      version: '1.2.3'
    })
    await expect(attempt).rejects.toThrow(/desktop role is reserved/)
    expect(opened).toEqual([])
  })
})

describe('startMcpServer serving', () => {
  it('serves the tools over the transport against the opened workspace', async () => {
    const rig = await startRig([])
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(rig.clientTransport)
    expect(client.getServerVersion()).toMatchObject({ name: 'darkmechanicus', version: '1.2.3' })
    const result = await client.callTool({ name: 'get_project', arguments: {} })
    expect(result.structuredContent).toEqual({ ok: true, data: PROJECT })
    expect(rig.workspace.calls).toEqual([{ name: 'getProject', input: undefined }])
    await client.close()
    await rig.handle.close()
  })

  it('logs a ready line with the effective role, save permission, and session', async () => {
    const rig = await startRig(['--repo', '/r', '--role', 'planner', '--allow-save'], { repoRoot: '/canonical' })
    expect(rig.logs).toEqual(['darkmechanicus 1.2.3 ready: repo=/canonical role=planner save=allowed session=ss_stub'])
  })

  it('says that saving needs the desktop app when it was not allowed', async () => {
    const rig = await startRig([], { sessionId: null })
    expect(rig.logs[0]).toBe('darkmechanicus 1.2.3 ready: repo=/repo role=orchestrator save=not allowed session=none')
  })

  it('reports the effective save permission and explains an --allow-save that cannot apply', async () => {
    const reviewer = await startRig(['--role', 'reviewer', '--allow-save'])
    expect(reviewer.logs).toEqual([
      'darkmechanicus 1.2.3 ready: repo=/repo role=reviewer save=not allowed session=ss_stub',
      '--allow-save has no effect for the reviewer role: only planner and orchestrator sessions can save plans.'
    ])
    const orchestrator = await startRig(['--role', 'orchestrator', '--allow-save'])
    expect(orchestrator.logs).toEqual([
      'darkmechanicus 1.2.3 ready: repo=/repo role=orchestrator save=allowed session=ss_stub'
    ])
  })

  it('hints at initialize_repository only when the repository is not initialized', async () => {
    const fresh = await startRig([], { initialized: false })
    expect(fresh.logs).toHaveLength(2)
    expect(fresh.logs[1]).toContain('initialize_repository')
    const ready = await startRig([], { initialized: true })
    expect(ready.logs).toHaveLength(1)
  })

  it('logs transport errors to the diagnostics stream', async () => {
    const rig = await startRig([])
    rig.serverTransport.onerror?.(new Error('bad frame'))
    expect(rig.logs).toContain('MCP error: bad frame')
  })
})

/** The tool names a server started with `argv` lists to a client. */
async function listedTools(argv: string[]): Promise<string[]> {
  const rig = await startRig(argv)
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await client.connect(rig.clientTransport)
  const names = (await client.listTools()).tools.map((tool) => tool.name)
  await client.close()
  await rig.handle.close()
  return names
}

describe('startMcpServer tool list', () => {
  it('lists only the tools of the launch role, and save_plan only with --allow-save', async () => {
    const worker = await listedTools(['--role', 'worker', '--allow-save'])
    const planner = await listedTools(['--role', 'planner'])
    const saver = await listedTools(['--role', 'planner', '--allow-save'])

    expect([worker.length, planner.length, saver.length]).toEqual([28, 36, 37])
    expect([worker.includes('submit_attempt'), planner.includes('submit_attempt')]).toEqual([true, false])
    expect(saver.filter((name) => !planner.includes(name))).toEqual(['save_plan'])
  })
})

describe('startMcpServer heartbeat', () => {
  it('schedules one session heartbeat every 15 seconds', async () => {
    const rig = await startRig([])
    expect(rig.jobs.map((job) => job.ms)).toEqual([15_000])
    expect(rig.workspace.heartbeats).toBe(0)
    rig.tick()
    expect(rig.workspace.heartbeats).toBe(1)
    rig.tick()
    expect(rig.workspace.heartbeats).toBe(2)
  })

  it('logs a failed heartbeat and keeps beating', async () => {
    const rig = await startRig([], { heartbeatError: new Error('database is locked') })
    rig.tick()
    rig.tick()
    expect(rig.workspace.heartbeats).toBe(2)
    expect(rig.logs.filter((line) => line === 'Session heartbeat failed: database is locked')).toHaveLength(2)
  })

  it('uses real timers when no scheduler is injected and clears them on close', async () => {
    const workspace = createStubWorkspace()
    const [serverTransport] = InMemoryTransport.createLinkedPair()
    const handle = await startMcpServer({
      argv: [],
      env: {},
      cwd: '/cwd',
      open: () => workspace,
      transport: serverTransport,
      log: () => undefined,
      version: '1.2.3'
    })
    await handle.close()
    expect(workspace.closes).toBe(1)
    expect(workspace.heartbeats).toBe(0)
  })
})

describe('startMcpServer shutdown', () => {
  it('stops the heartbeat, closes the workspace, and reports a clean close once', async () => {
    const rig = await startRig([])
    await rig.handle.close()
    await rig.handle.close()
    expect(rig.jobs[0]?.cancelled).toBe(true)
    expect(rig.workspace.closes).toBe(1)
    expect(rig.closedWith).toEqual([undefined])
  })

  it('shuts down by itself when the client disconnects', async () => {
    const rig = await startRig([])
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(rig.clientTransport)
    await client.close()
    await rig.handle.close()
    expect(rig.workspace.closes).toBe(1)
    expect(rig.closedWith).toEqual([undefined])
  })

  it('still closes the workspace, reports the failure, and rejects when closing fails', async () => {
    const failure = new Error('disk gone')
    const rig = await startRig([], { closeError: failure })
    await expect(rig.handle.close()).rejects.toBe(failure)
    expect(rig.workspace.closes).toBe(1)
    expect(rig.closedWith).toEqual([failure])
    expect(rig.jobs[0]?.cancelled).toBe(true)
  })
})

describe('startMcpServer startup failures', () => {
  it('closes the workspace and rethrows when the transport cannot start', async () => {
    const workspace = createStubWorkspace()
    const fake = createFakeScheduler()
    const broken: Transport = {
      start: async () => {
        throw new Error('no stdio')
      },
      send: async () => undefined,
      close: async () => undefined
    }
    const attempt = startMcpServer({
      argv: [],
      env: {},
      cwd: '/cwd',
      open: () => workspace,
      transport: broken,
      log: () => undefined,
      version: '1.2.3',
      scheduler: fake.scheduler
    })
    await expect(attempt).rejects.toThrow('no stdio')
    expect(workspace.closes).toBe(1)
    expect(fake.jobs.every((job) => job.cancelled)).toBe(true)
  })
})

function createHost(overrides: Partial<McpHost> = {}, workspaceOptions: StubWorkspaceOptions = {}) {
  const workspace = createStubWorkspace({ canned: { getProject: PROJECT }, ...workspaceOptions })
  const record = {
    stdout: [] as string[],
    stderr: [] as string[],
    exits: [] as number[],
    listeners: [] as (() => void)[],
    opened: [] as OpenWorkspaceOptions[]
  }
  let markExited: () => void = () => undefined
  const exited = new Promise<void>((resolve) => {
    markExited = resolve
  })
  const fake = createFakeScheduler()
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  const host: McpHost = {
    argv: ['--repo', '/repo', '--role', 'planner'],
    env: {},
    cwd: '/cwd',
    version: '1.2.3',
    open: (options) => {
      record.opened.push(options)
      return workspace
    },
    createTransport: () => serverTransport,
    writeStdout: (text) => void record.stdout.push(text),
    writeStderr: (text) => void record.stderr.push(text),
    exit: (code) => {
      record.exits.push(code)
      markExited()
    },
    onShutdown: (listener) => void record.listeners.push(listener),
    scheduler: fake.scheduler,
    ...overrides
  }
  return { host, workspace, record, exited, clientTransport, ...fake }
}

describe('runMcpMain arguments', () => {
  it('prints usage on stdout for --help and starts nothing', async () => {
    const rig = createHost({ argv: ['--help'] })
    await runMcpMain(rig.host)
    expect(rig.record).toEqual({ stdout: [`${MCP_USAGE}\n`], stderr: [], exits: [], listeners: [], opened: [] })
  })

  it('reports bad arguments with the usage text and exits with code 2', async () => {
    const rig = createHost({ argv: ['--nope'] })
    await runMcpMain(rig.host)
    expect(rig.record.stderr).toHaveLength(1)
    expect(rig.record.stderr[0]).toMatch(/^darkmechanicus: Unknown option "--nope"\.\n\nUsage: /)
    expect(rig.record.exits).toEqual([2])
    expect(rig.record.opened).toEqual([])
    expect(rig.record.stdout).toEqual([])
  })
})

describe('runMcpMain startup', () => {
  it('starts serving, keeps stdout clean, and waits for a shutdown signal', async () => {
    const rig = createHost()
    await runMcpMain(rig.host)
    expect(rig.record.opened).toHaveLength(1)
    expect(rig.record.stderr).toEqual([
      'darkmechanicus 1.2.3 ready: repo=/repo role=planner save=not allowed session=ss_stub\n'
    ])
    expect(rig.record.stdout).toEqual([])
    expect(rig.record.exits).toEqual([])
    expect(rig.record.listeners).toHaveLength(1)
  })

  it('reports a workspace that cannot be opened and exits with code 1', async () => {
    const rig = createHost({
      open: () => {
        throw new DomainError('incompatible_schema', 'The database is newer than this build.')
      }
    })
    await runMcpMain(rig.host)
    expect(rig.record.stderr).toEqual(['darkmechanicus: incompatible_schema: The database is newer than this build.\n'])
    expect(rig.record.exits).toEqual([1])
    expect(rig.record.listeners).toEqual([])
  })

  it('reports plain startup errors by message', async () => {
    const rig = createHost({
      createTransport: () => {
        throw new Error('stdin is not readable')
      }
    })
    await runMcpMain(rig.host)
    expect(rig.record.stderr).toEqual(['darkmechanicus: stdin is not readable\n'])
    expect(rig.record.exits).toEqual([1])
    expect(rig.record.opened).toEqual([])
  })
})

describe('runMcpMain shutdown', () => {
  it('closes the workspace and exits 0 when a shutdown signal arrives', async () => {
    const rig = createHost()
    await runMcpMain(rig.host)
    rig.record.listeners[0]?.()
    await rig.exited
    expect(rig.workspace.closes).toBe(1)
    expect(rig.record.exits).toEqual([0])
    expect(rig.jobs[0]?.cancelled).toBe(true)
  })

  it('exits 0 as well when the client disconnects on its own', async () => {
    const rig = createHost()
    await runMcpMain(rig.host)
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(rig.clientTransport)
    await client.close()
    await rig.exited
    expect(rig.workspace.closes).toBe(1)
    expect(rig.record.exits).toEqual([0])
  })

  it('reports a failed shutdown and exits with code 1', async () => {
    const rig = createHost({}, { closeError: new Error('disk gone') })
    await runMcpMain(rig.host)
    rig.record.listeners[0]?.()
    await rig.exited
    expect(rig.record.stderr.at(-1)).toBe('darkmechanicus: shutdown failed: disk gone\n')
    expect(rig.record.exits).toEqual([1])
    expect(rig.workspace.closes).toBe(1)
  })
})

describe('installWarningFilter', () => {
  function experimental(message: string): Error {
    const warning = new Error(message)
    warning.name = 'ExperimentalWarning'
    return warning
  }

  it('replaces the default printer and drops the SQLite experimental warning', () => {
    const emitter = new EventEmitter()
    const printed: string[] = []
    const logged: string[] = []
    emitter.on('warning', (warning: Error) => printed.push(warning.message))
    installWarningFilter(emitter, (line) => logged.push(line))
    emitter.emit('warning', experimental('SQLite is an experimental feature and might change at any time'))
    expect(printed).toEqual([])
    expect(logged).toEqual([])
  })

  it('still reports other experimental warnings and other kinds of warning', () => {
    const emitter = new EventEmitter()
    const logged: string[] = []
    installWarningFilter(emitter, (line) => logged.push(line))
    emitter.emit('warning', experimental('Watch mode is experimental'))
    const deprecation = new Error('Buffer() is deprecated: SQLite')
    deprecation.name = 'DeprecationWarning'
    emitter.emit('warning', deprecation)
    expect(logged).toEqual([
      'ExperimentalWarning: Watch mode is experimental',
      'DeprecationWarning: Buffer() is deprecated: SQLite'
    ])
  })
})

describe('redirectConsoleToStderr', () => {
  it('sends log, info, and debug output to the error stream', () => {
    const written: string[] = []
    const fake = {
      log: (text: string) => written.push(`log:${text}`),
      info: (text: string) => written.push(`info:${text}`),
      debug: (text: string) => written.push(`debug:${text}`),
      error: (text: string) => written.push(`error:${text}`)
    }
    redirectConsoleToStderr(fake)
    fake.log('a')
    fake.info('b')
    fake.debug('c')
    fake.error('d')
    expect(written).toEqual(['error:a', 'error:b', 'error:c', 'error:d'])
  })
})

describe('canonicalRepoRoot', () => {
  it('returns the resolved real path', () => {
    expect(canonicalRepoRoot('/link/repo', (path) => path.replace('/link', '/real'))).toBe('/real/repo')
  })

  it('names the folder when it cannot be resolved', () => {
    const missing = (): string => {
      throw new Error('ENOENT')
    }
    expect(() => canonicalRepoRoot('/nope', missing)).toThrow('Repository folder not found or unreadable: /nope')
  })
})

describe('readPackageVersion', () => {
  const script = join('/app', 'out', 'main', 'mcp.js')

  it('reads the version from the package.json two folders above the script', () => {
    const asked: string[] = []
    const version = readPackageVersion(script, (path) => {
      asked.push(path)
      return '{"name":"x","version":"4.5.6"}'
    })
    expect(version).toBe('4.5.6')
    expect(asked).toEqual([join(dirname(script), '..', '..', 'package.json')])
  })

  it.each([
    ['a missing file', () => { throw new Error('ENOENT') }],
    ['invalid JSON', () => '{nope'],
    ['a JSON array', () => '[]'],
    ['no version field', () => '{"name":"x"}'],
    ['a non-string version', () => '{"version":7}']
  ])('falls back to 0.0.0 for %s', (_label, read) => {
    expect(readPackageVersion(script, read)).toBe('0.0.0')
  })
})

describe('runIfEntry', () => {
  function run(entry: string | undefined): string | undefined {
    let received: string | undefined
    const returned = runIfEntry(entry, (script) => {
      received = script
    })
    expect(returned).toBe(received !== undefined)
    return received
  }

  it('runs with the script path when the script is mcp.js, however the path is written', () => {
    expect(run('/opt/app/out/main/mcp.js')).toBe('/opt/app/out/main/mcp.js')
    const windows = 'C:\\Apps\\Dark\\resources\\app.asar\\out\\main\\mcp.js'
    expect(run(windows)).toBe(windows)
    expect(run('mcp.js')).toBe('mcp.js')
  })

  it('does not run for other scripts or when there is no script', () => {
    expect(run('/opt/app/out/main/index.js')).toBeUndefined()
    expect(run('/opt/app/out/main/notmcp.js')).toBeUndefined()
    expect(run('/opt/app/out/main/mcp.js.map')).toBeUndefined()
    expect(run(undefined)).toBeUndefined()
  })
})
