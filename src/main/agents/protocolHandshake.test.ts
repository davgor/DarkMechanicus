import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentProtocol } from '../../shared/desktop/api'
import { customSpec } from './__mocks__/launchSpecs'
import type { TransportFactory, TransportSink } from './adapters/acpClient'
import { startClaudeProbe, type ClaudeQuery, type ClaudeQueryFactory } from './adapters/claude'
import { startCodexProbe, type CodexProbeDeps } from './adapters/codex'
import type { RpcTransport } from './adapters/codexRpc'
import type { ClaudeProcesses } from './adapters/claudeProcess'
import { fakeProcesses } from './adapters/__mocks__/fakeClaudeSdk'
import {
  acpExchange,
  createHandshakeFolders,
  HANDSHAKE_TIMEOUT_MS,
  runHandshake,
  type HandshakeDeps,
  type HandshakeOutcome,
  type ProtocolExchange,
  type StartExchange
} from './protocolHandshake'

const FOLDER = '/tmp/dm-handshake-abc'
const PROGRAM = '/opt/tools/my-agent'

type Message = Record<string, unknown>
/** What the fake CLI answers to one message it was sent; null says nothing. */
type Script = (message: Message, say: (reply: Message) => void, sink: { exit(detail: string): void }) => void

interface FakeCli {
  /** Every process started: its argv and folder. */
  starts: { file: string; args: readonly string[]; cwd: string }[]
  /** Every message the client wrote. */
  received: Message[]
  kills: number
}

interface World {
  cli: FakeCli
  /** What happened to folders: `made <path>` and `removed <path>`, in order. */
  folders: string[]
  deps(exchanges: Partial<Record<AgentProtocol, StartExchange>>, timeoutMs?: number): HandshakeDeps
}

function createWorld(): World {
  const world: World = {
    cli: { starts: [], received: [], kills: 0 },
    folders: [],
    deps: (exchanges, timeoutMs) => ({
      makeTempDir: () => {
        world.folders.push(`made ${FOLDER}`)
        return FOLDER
      },
      removeDir: (path) => {
        world.folders.push(`removed ${path}`)
      },
      exchanges: { acp: unused, codex: unused, claude: unused, ...exchanges },
      ...(timeoutMs === undefined ? {} : { timeoutMs })
    })
  }
  return world
}

const unused: StartExchange = () => {
  throw new Error('this protocol was not expected')
}

function fakeAcpTransport(cli: FakeCli, script: Script): TransportFactory {
  return (launch, cwd, sink: TransportSink) => {
    cli.starts.push({ file: launch.file, args: launch.args, cwd })
    const exit = { exit: (detail: string) => queueMicrotask(() => sink.closed(detail)) }
    return {
      write: (line) => {
        const message = JSON.parse(line) as Message
        cli.received.push(message)
        script(message, (reply) => queueMicrotask(() => sink.line(JSON.stringify(reply))), exit)
      },
      kill: () => {
        cli.kills += 1
        return Promise.resolve()
      }
    }
  }
}

function acp(cli: FakeCli, script: Script): StartExchange {
  return acpExchange({ transport: fakeAcpTransport(cli, script), platform: 'linux', inspect: () => 'ok', clientVersion: '9.9.9' })
}

const ACP_SPEC = customSpec('acp', PROGRAM, ['--acp', '{folder}'])

afterEach(() => {
  vi.useRealTimers()
})

describe('the ACP handshake', () => {
  it('starts the spec in the temp folder (as {folder} and the cwd) and takes the protocolVersion and the agent name and version', async () => {
    const world = createWorld()
    const exchange = acp(world.cli, (message, say) => {
      say({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentInfo: { name: 'mine', version: '0.3.1' } } })
    })

    expect(await runHandshake(ACP_SPEC, world.deps({ acp: exchange }))).toEqual({ ok: true, version: '0.3.1', reportedName: 'mine' })

    // The handshake is the only thing run: one start, of the confirmed program and arguments, and no `--version`.
    expect(world.cli.starts).toEqual([{ file: PROGRAM, args: ['--acp', FOLDER], cwd: FOLDER }])
    expect(world.cli.received[0]).toMatchObject({ method: 'initialize', params: { protocolVersion: 1, clientInfo: { version: '9.9.9' } } })
    expect(world.cli.kills).toBe(1)
    expect(world.folders).toEqual([`made ${FOLDER}`, `removed ${FOLDER}`])
  })

  it('reports no version or name when the agent names no version, or one that is not plain version text', async () => {
    const infos = [undefined, { version: 3 }, { version: '1.0\u202E' }, { version: 'x'.repeat(100) }, { name: 'mine' }, { name: 'mine', version: null }]
    for (const agentInfo of infos) {
      const world = createWorld()
      const exchange = acp(world.cli, (message, say) => {
        say({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentInfo } })
      })
      expect(await runHandshake(ACP_SPEC, world.deps({ acp: exchange }))).toEqual({ ok: true, version: null, reportedName: null })
    }
  })

  it.each([
    ['no protocolVersion', { agentCapabilities: {} }],
    ['a text protocolVersion', { protocolVersion: '1' }],
    ['a list', [1]],
    ['null', null]
  ])('refuses an initialize result with %s as wrong_program, and kills the tree', async (_label, result) => {
    const world = createWorld()
    const exchange = acp(world.cli, (message, say) => {
      say({ jsonrpc: '2.0', id: message.id, result })
    })

    expect(await runHandshake(ACP_SPEC, world.deps({ acp: exchange }))).toMatchObject({ ok: false, code: 'wrong_program' })
    expect(world.cli.kills).toBe(1)
    expect(world.folders.at(-1)).toBe(`removed ${FOLDER}`)
  })
})

describe('the ACP handshake: the agent name', () => {
  it('keeps the version alone when the agent names itself with no name, or one that is not plain text', async () => {
    const names = [undefined, 3, '', '   ', ' mine', 'mine ', 'mi\u202Ene', 'mi\nne', 'x'.repeat(65)]
    for (const name of names) {
      const world = createWorld()
      const exchange = acp(world.cli, (message, say) => {
        say({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentInfo: { name, version: '0.3.1' } } })
      })
      expect(await runHandshake(ACP_SPEC, world.deps({ acp: exchange }))).toEqual({ ok: true, version: '0.3.1', reportedName: null })
    }
  })

  it('keeps a name of words, digits and version punctuation, such as Autonomous or claude-code-acp', async () => {
    for (const name of ['Autonomous', 'claude-code-acp', 'Gemini CLI', '@zed/agent', 'x'.repeat(64)]) {
      const world = createWorld()
      const exchange = acp(world.cli, (message, say) => {
        say({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentInfo: { name, version: '18.11.2' } } })
      })
      expect(await runHandshake(ACP_SPEC, world.deps({ acp: exchange }))).toEqual({ ok: true, version: '18.11.2', reportedName: name })
    }
  })
})

describe('the ACP handshake: refusals', () => {
  it('refuses a JSON-RPC error answer as wrong_program', async () => {
    const world = createWorld()
    const exchange = acp(world.cli, (message, say) => {
      say({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
    })

    expect(await runHandshake(ACP_SPEC, world.deps({ acp: exchange }))).toEqual({
      ok: false,
      code: 'wrong_program',
      reason: expect.stringContaining('Method not found')
    })
  })

  it('answers what the agent asks during the handshake with method-not-found, so it is never left waiting', async () => {
    const world = createWorld()
    const exchange = acp(world.cli, (message, say) => {
      if (message.method === 'initialize') {
        say({ jsonrpc: '2.0', id: 'ask-1', method: 'fs/read_text_file', params: { path: '/etc/passwd' } })
        say({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
      }
    })

    expect((await runHandshake(ACP_SPEC, world.deps({ acp: exchange }))).ok).toBe(true)
    expect(world.cli.received).toContainEqual({ jsonrpc: '2.0', id: 'ask-1', error: { code: -32601, message: expect.any(String) } })
  })

  it('reports a CLI that exits before it answers as did_not_start, and still has its transport kill the tree', async () => {
    const world = createWorld()
    const exchange = acp(world.cli, (_message, _say, process) => {
      process.exit('exit code 2: unknown option --acp')
    })

    expect(await runHandshake(ACP_SPEC, world.deps({ acp: exchange }))).toEqual({
      ok: false,
      code: 'did_not_start',
      reason: expect.stringContaining('unknown option --acp')
    })
    expect(world.cli.kills).toBe(1)
    expect(world.folders.at(-1)).toBe(`removed ${FOLDER}`)
  })
})

describe('the ACP handshake: the time limit and the launch rules', () => {
  it('gives a CLI that never answers 20 seconds, then refuses it as timed_out and kills its tree', async () => {
    vi.useFakeTimers()
    const world = createWorld()
    const exchange = acp(world.cli, () => {})
    let outcome: HandshakeOutcome | null = null

    void runHandshake(ACP_SPEC, world.deps({ acp: exchange })).then((result) => {
      outcome = result
    })
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS - 1)
    expect(outcome).toBeNull()
    expect(world.cli.kills).toBe(0)
    await vi.advanceTimersByTimeAsync(1)

    expect(HANDSHAKE_TIMEOUT_MS).toBe(20_000)
    expect(outcome).toMatchObject({ ok: false, code: 'timed_out' })
    expect(world.cli.kills).toBe(1)
    expect(world.folders.at(-1)).toBe(`removed ${FOLDER}`)
  })

  it('refuses a program the launch rules refuse in the temp folder without starting anything', async () => {
    const world = createWorld()
    const exchange = acpExchange({ transport: fakeAcpTransport(world.cli, () => {}), platform: 'linux', inspect: () => 'not_a_file', clientVersion: '1' })

    expect(await runHandshake(ACP_SPEC, world.deps({ acp: exchange }))).toMatchObject({ ok: false, code: 'did_not_start' })
    expect(world.cli.starts).toEqual([])
    expect(world.folders).toEqual([`made ${FOLDER}`, `removed ${FOLDER}`])
  })
})

/** A Codex app-server stand-in over the line transport: JSON-RPC without the `jsonrpc` field. */
function fakeCodexConnect(cli: FakeCli, script: Script): CodexProbeDeps {
  return {
    connect: (executablePath, folder, _env, args) => {
      cli.starts.push({ file: executablePath, args, cwd: folder })
      let lineListener: (line: string) => void = () => {}
      let closeListener: (reason: string) => void = () => {}
      const exit = { exit: (detail: string) => queueMicrotask(() => closeListener(detail)) }
      const transport: RpcTransport = {
        write: (line) => {
          const message = JSON.parse(line) as Message
          cli.received.push(message)
          script(message, (reply) => queueMicrotask(() => lineListener(JSON.stringify(reply))), exit)
        },
        onLine: (listener) => {
          lineListener = listener
        },
        onClose: (listener) => {
          closeListener = listener
        },
        kill: () => {
          cli.kills += 1
          return Promise.resolve()
        }
      }
      return transport
    },
    clientVersion: '9.9.9'
  }
}

function codex(cli: FakeCli, script: Script): StartExchange {
  const deps = fakeCodexConnect(cli, script)
  return (spec, folder) => startCodexProbe(spec, folder, deps)
}

const CODEX_SPEC = customSpec('codex', PROGRAM, ['app-server', '--cd', '{folder}'])

const codexServer: Script = (message, say) => {
  if (message.method === 'initialize') {
    say({ id: message.id, result: { userAgent: 'codex_cli_rs/0.46.0 (Mac OS 15.0; arm64) dumb' } })
  } else if (message.method === 'model/list') {
    say({ id: message.id, result: { data: [{ id: 'gpt-5', model: 'gpt-5' }], nextCursor: null } })
  }
}

describe('the Codex handshake', () => {
  it('runs initialize, initialized and model/list in the temp folder and takes the name and version from the user agent', async () => {
    const world = createWorld()

    expect(await runHandshake(CODEX_SPEC, world.deps({ codex: codex(world.cli, codexServer) }))).toEqual({
      ok: true,
      version: '0.46.0',
      reportedName: 'codex_cli_rs'
    })

    expect(world.cli.starts).toEqual([{ file: PROGRAM, args: ['app-server', '--cd', FOLDER], cwd: FOLDER }])
    expect(world.cli.received.map((message) => message.method)).toEqual(['initialize', 'initialized', 'model/list'])
    expect(world.cli.kills).toBe(1)
    expect(world.folders).toEqual([`made ${FOLDER}`, `removed ${FOLDER}`])
  })

  it.each([
    ['a user agent with no product name', '0.46.0 (Mac OS 15.0; arm64)', '0.46.0', null],
    ['a user agent with no version', 'codex_cli_rs (Mac OS 15.0; arm64)', null, null],
    ['no user agent', undefined, null, null]
  ])('reads %s as the version alone or neither', async (_label, userAgent, version, reportedName) => {
    const world = createWorld()
    const server: Script = (message, say) => {
      say({ id: message.id, result: message.method === 'initialize' ? { userAgent } : { data: [] } })
    }

    expect(await runHandshake(CODEX_SPEC, world.deps({ codex: codex(world.cli, server) }))).toEqual({ ok: true, version, reportedName })
  })

  it.each([
    ['an initialize that is not an object', (message: Message, say: (reply: Message) => void) => say({ id: message.id, result: 'hello' })],
    [
      'a model/list without a data list',
      (message: Message, say: (reply: Message) => void) =>
        say({ id: message.id, result: message.method === 'initialize' ? { userAgent: 'x' } : { models: [] } })
    ],
    [
      'a model/list error',
      (message: Message, say: (reply: Message) => void) =>
        say(message.method === 'initialize' ? { id: message.id, result: {} } : { id: message.id, error: { code: -32601, message: 'nope' } })
    ]
  ])('refuses %s as wrong_program and kills the tree', async (_label, script) => {
    const world = createWorld()

    expect(await runHandshake(CODEX_SPEC, world.deps({ codex: codex(world.cli, script) }))).toMatchObject({ ok: false, code: 'wrong_program' })
    expect(world.cli.kills).toBe(1)
  })
})

describe('the Codex handshake: early exits and the time limit', () => {
  it('reports a server that exits early as did_not_start, and still stops its transport', async () => {
    const world = createWorld()
    const exchange = codex(world.cli, (_message, _say, process) => {
      process.exit('Codex exited with code 1: error: unrecognized subcommand')
    })

    expect(await runHandshake(CODEX_SPEC, world.deps({ codex: exchange }))).toEqual({
      ok: false,
      code: 'did_not_start',
      reason: expect.stringContaining('unrecognized subcommand')
    })
    expect(world.cli.kills).toBe(1)
  })

  it('refuses a server that never lists its models as timed_out after 20 seconds, and kills the tree', async () => {
    vi.useFakeTimers()
    const world = createWorld()
    const exchange = codex(world.cli, (message, say) => {
      if (message.method === 'initialize') {
        say({ id: message.id, result: {} })
      }
    })

    const outcome = runHandshake(CODEX_SPEC, world.deps({ codex: exchange }))
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS)

    expect(await outcome).toMatchObject({ ok: false, code: 'timed_out' })
    expect(world.cli.kills).toBe(1)
    expect(world.folders.at(-1)).toBe(`removed ${FOLDER}`)
  })

  it('reports a program that cannot be started at all as did_not_start, and removes the folder', async () => {
    const world = createWorld()
    const exchange: StartExchange = (spec, folder) =>
      startCodexProbe(spec, folder, {
        connect: () => {
          throw new Error('That file is not executable.')
        }
      })

    expect(await runHandshake(CODEX_SPEC, world.deps({ codex: exchange }))).toEqual({
      ok: false,
      code: 'did_not_start',
      reason: expect.stringContaining('not executable')
    })
    expect(world.folders).toEqual([`made ${FOLDER}`, `removed ${FOLDER}`])
  })
})

const MODELS: ModelInfo[] = [{ value: 'opus', displayName: 'Opus', description: '' }] as ModelInfo[]

type FakeProcesses = ClaudeProcesses & { killed: number }

interface ClaudeRig {
  exchange: StartExchange
  log: string[]
  options: Record<string, unknown>[]
  processes: FakeProcesses
}

function claudeRig(supportedModels: () => Promise<unknown>): ClaudeRig {
  const log: string[] = []
  const options: Record<string, unknown>[] = []
  const processes: FakeProcesses = fakeProcesses(log)
  const query: ClaudeQueryFactory = (params) => {
    options.push(params.options as Record<string, unknown>)
    const fake = {
      supportedModels,
      close: () => {
        log.push('close')
      },
      interrupt: () => Promise.resolve(),
      setModel: () => Promise.resolve(),
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) })
    }
    return fake as unknown as ClaudeQuery
  }
  return {
    exchange: (spec, folder) => startClaudeProbe(spec, folder, { query, createProcesses: () => processes, platform: 'linux' }),
    log,
    options,
    processes
  }
}

const CLAUDE_SPEC = customSpec('claude', PROGRAM, ['--profile', '{folder}'])

describe('the Claude Code SDK handshake', () => {
  it('asks the SDK for the models in the temp folder, with no settings loaded, and reports no version', async () => {
    const world = createWorld()
    const rig = claudeRig(() => Promise.resolve(MODELS))

    expect(await runHandshake(CLAUDE_SPEC, world.deps({ claude: rig.exchange }))).toEqual({ ok: true, version: null, reportedName: null })

    expect(rig.options[0]).toMatchObject({ cwd: FOLDER, pathToClaudeCodeExecutable: PROGRAM, settingSources: [], persistSession: false })
    expect(rig.processes.killed).toBe(1)
    expect(rig.log).toContain('close')
    expect(world.folders).toEqual([`made ${FOLDER}`, `removed ${FOLDER}`])
  })

  it('puts the spec arguments, {folder} replaced by the temp folder, after the program it spawns', async () => {
    const world = createWorld()
    const rig = claudeRig(() => Promise.resolve(MODELS))
    await runHandshake(CLAUDE_SPEC, world.deps({ claude: rig.exchange }))

    const spawn = rig.options[0]?.spawnClaudeCodeProcess as ClaudeProcesses['spawn']
    spawn({ command: PROGRAM, args: ['--output-format', 'stream-json'], env: {}, signal: new AbortController().signal })

    expect(vi.mocked(rig.processes.spawn).mock.calls[0]?.[0]).toMatchObject({
      command: PROGRAM,
      args: ['--profile', FOLDER, '--output-format', 'stream-json']
    })
  })

  it('refuses an answer that is not a model list as wrong_program', async () => {
    const world = createWorld()
    const rig = claudeRig(() => Promise.resolve({ models: [] }))

    expect(await runHandshake(CLAUDE_SPEC, world.deps({ claude: rig.exchange }))).toMatchObject({ ok: false, code: 'wrong_program' })
    expect(rig.processes.killed).toBe(1)
  })

  it('reports a CLI the SDK could not talk to as did_not_start, and kills its processes', async () => {
    const world = createWorld()
    const rig = claudeRig(() => Promise.reject(new Error('Claude Code process exited with code 1')))

    expect(await runHandshake(CLAUDE_SPEC, world.deps({ claude: rig.exchange }))).toEqual({
      ok: false,
      code: 'did_not_start',
      reason: expect.stringContaining('exited with code 1')
    })
    expect(rig.processes.killed).toBe(1)
  })

  it('refuses a CLI that never answers as timed_out after 20 seconds, and kills its processes', async () => {
    vi.useFakeTimers()
    const world = createWorld()
    const rig = claudeRig(() => new Promise(() => {}))

    const outcome = runHandshake(CLAUDE_SPEC, world.deps({ claude: rig.exchange }))
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS)

    expect(await outcome).toMatchObject({ ok: false, code: 'timed_out' })
    expect(rig.processes.killed).toBe(1)
  })
})

describe('what a refusal says', () => {
  it('keeps no control characters and stays short, whatever the CLI printed', async () => {
    const world = createWorld()
    const noisy: StartExchange = (): ProtocolExchange => ({
      answer: Promise.reject(new Error(`\u001b[31mboom\u0007 ${'x'.repeat(2_000)}`)),
      stop: () => Promise.resolve()
    })

    const outcome = await runHandshake(ACP_SPEC, world.deps({ acp: noisy }))

    expect(outcome.ok).toBe(false)
    const reason = outcome.ok ? '' : outcome.reason
    expect(reason).not.toMatch(/\p{Cc}/u)
    expect(reason.length).toBeLessThanOrEqual(400)
    expect(reason).toContain('boom')
  })

  it('still answers, and removes the folder, when stopping the process fails', async () => {
    const world = createWorld()
    const failingStop: StartExchange = () => ({
      answer: Promise.resolve({ protocolVersion: 1 }),
      stop: () => Promise.reject(new Error('kill failed'))
    })

    expect(await runHandshake(ACP_SPEC, world.deps({ acp: failingStop }))).toEqual({ ok: true, version: null, reportedName: null })
    expect(world.folders.at(-1)).toBe(`removed ${FOLDER}`)
  })
})

describe('createHandshakeFolders', () => {
  it('makes a fresh, empty, canonical folder each time and removes it with its contents', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dm-handshake-test-')))
    try {
      const folders = createHandshakeFolders(root)
      const first = folders.makeTempDir()
      const second = folders.makeTempDir()

      expect(first).not.toBe(second)
      expect(realpathSync(first)).toBe(first)
      expect(readdirSync(first)).toEqual([])
      folders.removeDir(first)
      expect(existsSync(first)).toBe(false)
      expect(existsSync(second)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
