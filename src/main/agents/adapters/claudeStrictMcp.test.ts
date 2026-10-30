import type { ModelInfo, Options } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../../logger'
import { builtInSpec, customSpec } from '../__mocks__/launchSpecs'
import { HANDSHAKE_TIMEOUT_MS, runHandshake, type HandshakeDeps } from '../protocolHandshake'
import { createClaudeAdapterDefinition, CURATED_CLAUDE_MODELS, startClaudeProbe, type ClaudeQueryFactory } from './claude'
import type { ClaudeProcesses } from './claudeProcess'
import { EXECUTABLE, FakeQuery, fakeProcesses } from './__mocks__/fakeClaudeSdk'

vi.mock('../../logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))

/** What Claude Code 2.1.291 prints on stderr before it exits 1, when an enterprise MCP config is present. */
const REFUSAL = 'You cannot use --strict-mcp-config when an enterprise MCP config is present\n'
/** The SDK's error for that exit (it spawns through our hook, so it has no stderr tail of its own to add). */
const exitedWith = (code: number): Error => new Error(`Claude Code process exited with code ${code}`)

const INFOS = [{ value: 'opus', displayName: 'Opus', description: '' }] as ModelInfo[]
const FOLDER = '/tmp/dm-handshake-strict'
const PROGRAM = '/opt/tools/my-claude'

type FakeProcesses = ClaudeProcesses & { killed: number }

/** One probe launch: what `supportedModels` does, and what its process printed on stderr. */
interface Launch {
  models: () => Promise<ModelInfo[]>
  stderr?: string
}

interface ProbeWorld {
  query: ClaudeQueryFactory
  createProcesses: () => ClaudeProcesses
  /** The options of every query started, in order. */
  launches: Options[]
  /** The process trackers created, in order. */
  created: FakeProcesses[]
  log: string[]
}

function probeWorld(plan: Launch[]): ProbeWorld {
  const world: ProbeWorld = { query: () => undefined as never, createProcesses: () => undefined as never, launches: [], created: [], log: [] }
  world.createProcesses = () => {
    const processes = fakeProcesses(world.log, plan[world.created.length]?.stderr ?? '')
    world.created.push(processes)
    return processes
  }
  world.query = ({ prompt, options }) => {
    const launch = plan[world.launches.length]
    world.launches.push(options)
    const query = new FakeQuery(options, {}, prompt, world.log)
    query.supportedModels = launch?.models ?? (() => Promise.reject(new Error('an unplanned probe was started')))
    return query
  }
  return world
}

const refused = (): Launch => ({ models: () => Promise.reject(exitedWith(1)), stderr: REFUSAL })
const answers = (): Launch => ({ models: () => Promise.resolve(INFOS) })
const never = (): Launch => ({ models: () => new Promise<never>(() => {}) })
const after = (ms: number, outcome: () => Promise<ModelInfo[]>, stderr?: string): Launch => ({
  models: () => new Promise<void>((resolve) => setTimeout(resolve, ms)).then(outcome),
  ...(stderr === undefined ? {} : { stderr })
})

function withoutHooks(options: Options | undefined): Record<string, unknown> {
  const { spawnClaudeCodeProcess: _spawn, strictMcpConfig: _strict, ...rest } = options ?? {}
  return rest
}

function listBuiltIn(world: ProbeWorld): Promise<unknown> {
  const definition = createClaudeAdapterDefinition({ query: world.query, createProcesses: world.createProcesses, platform: 'linux' })
  return definition.listModels(builtInSpec('claude', EXECUTABLE))
}

function handshakeDeps(world: ProbeWorld, folders: string[]): HandshakeDeps {
  return {
    makeTempDir: () => {
      folders.push(`made ${FOLDER}`)
      return FOLDER
    },
    removeDir: (path) => {
      folders.push(`removed ${path}`)
    },
    exchanges: {
      acp: () => {
        throw new Error('not expected')
      },
      codex: () => {
        throw new Error('not expected')
      },
      claude: (spec, folder) => startClaudeProbe(spec, folder, { query: world.query, createProcesses: world.createProcesses, platform: 'linux' })
    }
  }
}

const CLAUDE_SPEC = customSpec('claude', PROGRAM, ['--profile', '{folder}'])

afterEach(() => {
  vi.useRealTimers()
  vi.mocked(logger.info).mockClear()
})

describe('the Claude model probe under an enterprise MCP config', () => {
  it('asks again once without --strict-mcp-config when Claude refuses it, keeping every other option, and lists what it reports', async () => {
    const world = probeWorld([refused(), answers()])

    expect(await listBuiltIn(world)).toEqual([{ id: 'opus', label: 'Opus' }])

    expect(world.launches).toHaveLength(2)
    expect(world.launches[0]).toMatchObject({ strictMcpConfig: true, settingSources: [] })
    expect(world.launches[1]).not.toHaveProperty('strictMcpConfig')
    expect(world.launches[1]).toMatchObject({ settingSources: [], persistSession: false, permissionMode: 'default' })
    expect(withoutHooks(world.launches[1])).toEqual(withoutHooks(world.launches[0]))
    expect(world.launches[1]?.spawnClaudeCodeProcess).toBe(world.created[1]?.spawn)
    expect(world.created.map((processes) => processes.killed)).toEqual([1, 1])
    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logger.info).mock.calls[0]?.[0]).toContain('--strict-mcp-config')
  })

  it('does not retry any other failure', async () => {
    const others: Launch[] = [
      { models: () => Promise.reject(exitedWith(1)), stderr: 'Error: not signed in\n' },
      { models: () => Promise.reject(exitedWith(2)), stderr: REFUSAL },
      { models: () => Promise.reject(new Error('Claude Code process aborted by user')), stderr: REFUSAL },
      { models: () => Promise.reject(new Error('Claude Code process exited with code 10')), stderr: REFUSAL },
      { models: () => Promise.reject(REFUSAL), stderr: REFUSAL },
      { models: () => Promise.resolve([]), stderr: REFUSAL }
    ]
    for (const other of others) {
      const world = probeWorld([other, answers()])

      expect(await listBuiltIn(world)).toEqual(CURATED_CLAUDE_MODELS)
      expect(world.launches).toHaveLength(1)
      expect(world.created.map((processes) => processes.killed)).toEqual([1])
    }
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('retries only once: a second refusal falls back to the curated list', async () => {
    const world = probeWorld([refused(), refused(), answers()])

    expect(await listBuiltIn(world)).toEqual(CURATED_CLAUDE_MODELS)
    expect(world.launches).toHaveLength(2)
    expect(world.launches[1]).not.toHaveProperty('strictMcpConfig')
    expect(world.created.map((processes) => processes.killed)).toEqual([1, 1])
    expect(logger.info).toHaveBeenCalledTimes(1)
  })

  it('keeps the built-in listing time limit over both probes', async () => {
    vi.useFakeTimers()
    const world = probeWorld([after(15_000, () => Promise.reject(exitedWith(1)), REFUSAL), after(10_000, () => Promise.resolve(INFOS))])

    const models = listBuiltIn(world)
    await vi.advanceTimersByTimeAsync(20_000)

    expect(await models).toEqual(CURATED_CLAUDE_MODELS)
    expect(world.launches).toHaveLength(2)
    expect(world.created.map((processes) => processes.killed)).toEqual([1, 1])
  })
})

describe('the Claude Code SDK handshake under an enterprise MCP config', () => {
  it('passes through the retry, in the temp folder, and kills both process trees', async () => {
    const folders: string[] = []
    const world = probeWorld([refused(), answers()])

    expect(await runHandshake(CLAUDE_SPEC, handshakeDeps(world, folders))).toEqual({ ok: true, version: null })

    expect(world.launches.map((options) => options.cwd)).toEqual([FOLDER, FOLDER])
    expect(world.launches[0]?.strictMcpConfig).toBe(true)
    expect(world.launches[1]).not.toHaveProperty('strictMcpConfig')
    expect(world.launches[1]?.settingSources).toEqual([])
    expect(world.created.map((processes) => processes.killed)).toEqual([1, 1])
    expect(world.log.filter((entry) => entry === 'close')).toHaveLength(2)
    expect(folders).toEqual([`made ${FOLDER}`, `removed ${FOLDER}`])
    expect(logger.info).toHaveBeenCalledTimes(1)
  })

  it('passes when the retry still answers within the 20 second limit', async () => {
    vi.useFakeTimers()
    const world = probeWorld([after(15_000, () => Promise.reject(exitedWith(1)), REFUSAL), after(4_000, () => Promise.resolve(INFOS))])

    const outcome = runHandshake(CLAUDE_SPEC, handshakeDeps(world, []))
    await vi.advanceTimersByTimeAsync(19_000)

    expect(await outcome).toEqual({ ok: true, version: null })
    expect(world.created.map((processes) => processes.killed)).toEqual([1, 1])
  })
})

describe('the Claude Code SDK handshake under an enterprise MCP config: the time limit', () => {
  it('times out at 20 seconds for both probes together, and kills both process trees', async () => {
    vi.useFakeTimers()
    const world = probeWorld([after(15_000, () => Promise.reject(exitedWith(1)), REFUSAL), after(10_000, () => Promise.resolve(INFOS))])

    const outcome = runHandshake(CLAUDE_SPEC, handshakeDeps(world, []))
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS)

    expect(await outcome).toMatchObject({ ok: false, code: 'timed_out' })
    expect(world.launches).toHaveLength(2)
    expect(world.created.map((processes) => processes.killed)).toEqual([1, 1])
  })

  it('times out when the retry never answers, and kills both process trees', async () => {
    vi.useFakeTimers()
    const world = probeWorld([refused(), never()])

    const outcome = runHandshake(CLAUDE_SPEC, handshakeDeps(world, []))
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS)

    expect(await outcome).toMatchObject({ ok: false, code: 'timed_out' })
    expect(world.created.map((processes) => processes.killed)).toEqual([1, 1])
  })

  it('starts no retry once the handshake has been stopped', async () => {
    vi.useFakeTimers()
    const world = probeWorld([after(HANDSHAKE_TIMEOUT_MS + 1_000, () => Promise.reject(exitedWith(1)), REFUSAL), answers()])

    const outcome = runHandshake(CLAUDE_SPEC, handshakeDeps(world, []))
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS + 2_000)

    expect(await outcome).toMatchObject({ ok: false, code: 'timed_out' })
    expect(world.launches).toHaveLength(1)
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('does not retry a CLI that fails for another reason', async () => {
    const world = probeWorld([{ models: () => Promise.reject(exitedWith(1)), stderr: 'Error: unknown option --profile\n' }, answers()])

    expect(await runHandshake(CLAUDE_SPEC, handshakeDeps(world, []))).toMatchObject({ ok: false, code: 'did_not_start' })
    expect(world.launches).toHaveLength(1)
    expect(world.created.map((processes) => processes.killed)).toEqual([1])
  })
})
