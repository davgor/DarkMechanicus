/**
 * Skitarii model catalogs: a live chat answers from its own session (`get_available_models` over the RPC stdin it
 * owns), a chat that is not running and an agent before any chat from `omp models --json` (argv only, 15 s timeout,
 * 10-minute cache per executable and version, explicit refresh). Both give the same normalized options.
 */
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { chatModelOptions, featuredModels } from '../../shared/agents/models'
import { builtInAgent } from '../agents/__mocks__/chatFixtures'
import type { ProbeLaunch, ProcessOutcome, ProcessRunner } from '../desktop/agentProbe'
import { runProcess } from '../desktop/agentProbeNode'
import { agentChatRig } from './__mocks__/agentChatRig'
import { createAgentChatHandlers } from './agentChatIpc'
import { CATALOG_CACHE_MS, CATALOG_TIMEOUT_MS, createOmpModels, type OmpModelsDeps } from './ompModels'

const HOST = JSON.parse(readFileSync(new URL('./__fixtures__/omp/models.json', import.meta.url), 'utf8')) as { models: Record<string, unknown>[] }
const EXPECTED = chatModelOptions(HOST)
const LATEST = ['Claude Fable 5.2', 'Claude Haiku 5.5', 'Claude Mythos 5.2', 'Claude Opus 5.5', 'Claude Sonnet 5.5', 'GPT-6 Astra', 'GPT-6 Luna', 'GPT-6.1 Sol', 'GPT-6.1 Terra']

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function liveRig() {
  const r = agentChatRig('omp')
  cleanups.push(r.cleanup)
  const runs: ProbeLaunch[] = []
  const models = createOmpModels({
    sessions: r.sessions, agentFor: id => r.deps.agentFor(id), chatAgent: ref => r.store.getChat(ref)?.agent ?? null,
    run: (launch, timeoutMs, maxOutputChars) => { runs.push(launch); return runProcess(launch, timeoutMs, maxOutputChars) },
    platform: process.platform, env: r.env
  })
  const handlers = createAgentChatHandlers({ registry: { resolve: path => path === r.repo ? path : null }, sessions: r.sessions, confirmTerminalStop: async () => false, models })
  return { ...r, models, handlers, runs }
}

describe('a live Skitarii chat', () => {
  it('answers agentChat:models from its own session: get_available_models on its RPC stdin, no process started', async () => {
    const r = liveRig(), chat = r.newChat()
    await r.sessions.start(chat)
    const before = r.writes.length
    const result = await r.handlers.models({ folder: r.repo, chatId: chat.id })
    expect(result).toEqual({ ok: true, data: EXPECTED })
    const sent = r.writes.slice(before).map(line => JSON.parse(line) as { type: string; id: string })
    expect(sent).toEqual([{ type: 'get_available_models', id: expect.any(String) }])
    expect(r.runs).toEqual([])
    expect(result.ok && featuredModels(result.data).featured.map(option => option.name)).toEqual(LATEST)
    // The reply is main's own: nothing of it reaches the transcript or the window.
    expect(r.pushes.some(event => JSON.stringify(event).includes('claude-opus-5-5'))).toBe(false)
  })

  it('has no session to ask before it starts or after it stops', async () => {
    const r = liveRig(), chat = r.newChat()
    expect(r.models.sessionModels(chat)).toBeNull()
    await r.sessions.start(chat)
    await r.sessions.stop(chat)
    expect(r.models.sessionModels(chat)).toBeNull()
  })

  it('gives the same options as the sessionless catalog, which a chat that is not running falls back to', async () => {
    const r = liveRig(), chat = r.newChat()
    const sessionless = await r.handlers.models({ folder: r.repo, chatId: chat.id })
    expect(r.runs).toHaveLength(1)
    await r.sessions.start(chat)
    const live = await r.handlers.models({ folder: r.repo, chatId: chat.id })
    expect(sessionless).toEqual({ ok: true, data: EXPECTED })
    expect(live).toEqual(sessionless)
  })
})

/** A sessionless rig whose runner answers `outcome` and records each launch with its timeout and output cap. */
function catalogRig(outcome: ProcessOutcome = { kind: 'exited', exitCode: 0, output: JSON.stringify(HOST) }, overrides: Partial<OmpModelsDeps> = {}) {
  const clock = { now: 1_000_000 }
  const runs: { launch: ProbeLaunch; timeoutMs: number; maxOutputChars?: number }[] = []
  const agents = { omp: builtInAgent('omp', { executablePath: '/opt/omp/bin/omp', version: '18.20.2' }) }
  const run: ProcessRunner = async (launch, timeoutMs, maxOutputChars) => { runs.push({ launch, timeoutMs, maxOutputChars }); return outcome }
  const models = createOmpModels({
    sessions: { ompRequest: () => null }, agentFor: id => (id === 'omp' ? agents.omp : id === 'claude' ? builtInAgent('claude') : null),
    chatAgent: () => 'omp', run, platform: 'linux', env: {}, now: () => clock.now, ...overrides
  })
  return { models, runs, clock, agents }
}

describe('the sessionless catalog', () => {
  it('runs the registered executable with argv [models, --json] only, no shell quoting, a 15 s timeout and a catalog-sized output cap', async () => {
    const r = catalogRig()
    expect(await r.models.catalogModels('omp')).toEqual(EXPECTED)
    expect(r.runs).toEqual([{ launch: { file: '/opt/omp/bin/omp', args: ['models', '--json'], verbatimArguments: false }, timeoutMs: CATALOG_TIMEOUT_MS, maxOutputChars: 4 * 1024 * 1024 }])
    expect(CATALOG_TIMEOUT_MS).toBe(15_000)
  })

  it('reaches the fake OMP through its npm shim as the GUI launch does, the path with spaces as one argv entry', async () => {
    const r = liveRig()
    const launched = await r.models.catalogModels('omp')
    expect(launched).toEqual(EXPECTED)
    expect(r.runs[0].args.slice(-2)).toEqual(['models', '--json'])
    expect(r.runs[0].verbatimArguments).toBe(false)
    if (process.platform === 'win32') expect(r.runs[0].file.toLowerCase().endsWith('node.exe')).toBe(true)
  })

  it('fails with timeout when OMP does not answer in 15 s, and caches nothing', async () => {
    const r = catalogRig({ kind: 'timed_out' })
    await expect(r.models.catalogModels('omp')).rejects.toMatchObject({ code: 'timeout', message: 'OMP did not list its models within 15 seconds.' })
    await expect(r.models.catalogModels('omp')).rejects.toMatchObject({ code: 'timeout' })
    expect(r.runs).toHaveLength(2)
  })
})

describe('the sessionless catalog cache and answers', () => {
  it('caches for 10 minutes per executable and version, and a refresh runs it again', async () => {
    const r = catalogRig()
    await r.models.catalogModels('omp')
    r.clock.now += CATALOG_CACHE_MS - 1
    await r.models.catalogModels('omp')
    expect(r.runs).toHaveLength(1)
    await r.models.catalogModels('omp', { refresh: true })
    expect(r.runs).toHaveLength(2)
    r.clock.now += CATALOG_CACHE_MS
    await r.models.catalogModels('omp')
    expect(r.runs).toHaveLength(3)
    r.agents.omp = { ...r.agents.omp, version: '18.21.0' }
    await r.models.catalogModels('omp')
    r.agents.omp = { ...r.agents.omp, executablePath: '/elsewhere/omp' }
    await r.models.catalogModels('omp')
    expect(r.runs).toHaveLength(5)
    expect(CATALOG_CACHE_MS).toBe(600_000)
  })

  it('drops unsafe ids and tolerates a warning line around the document', async () => {
    const unsafe = [{ ...HOST.models[0], id: 'claude"&calc' }, { ...HOST.models[0], id: '--model' }, { ...HOST.models[0], provider: 'a/b' }]
    const output = `warning: something\n${JSON.stringify({ models: [...unsafe, ...HOST.models] })}\n`
    const r = catalogRig({ kind: 'exited', exitCode: 0, output })
    expect(await r.models.catalogModels('omp')).toEqual(EXPECTED)
  })

  it('refuses a failed run, an unreadable answer, an agent that is not OMP, and one that is not connected', async () => {
    await expect(catalogRig({ kind: 'exited', exitCode: 2, output: '' }).models.catalogModels('omp')).rejects.toMatchObject({ code: 'operation_unavailable' })
    await expect(catalogRig({ kind: 'exited', exitCode: 0, output: 'not json' }).models.catalogModels('omp')).rejects.toMatchObject({ code: 'operation_unavailable' })
    await expect(catalogRig({ kind: 'spawn_failed', code: 'ENOENT', message: 'gone' }).models.catalogModels('omp')).rejects.toMatchObject({ code: 'operation_unavailable' })
    const r = catalogRig()
    await expect(r.models.catalogModels('claude')).rejects.toMatchObject({ code: 'unsupported' })
    await expect(r.models.catalogModels('cursor')).rejects.toMatchObject({ code: 'not_found' })
    expect(r.runs).toEqual([])
  })
})

describe('the session path', () => {
  it('maps the reply with the same normalization and drops unsafe ids', async () => {
    const reply = { models: [{ ...HOST.models[0], id: 'a & b' }, ...HOST.models] }
    const r = catalogRig(undefined, { sessions: { ompRequest: () => Promise.resolve(reply) } })
    expect(await r.models.sessionModels({ folder: null, id: 'chat_1' })).toEqual(EXPECTED)
    expect(await r.models.chatModels({ folder: null, id: 'chat_1' })).toEqual(EXPECTED)
    expect(r.runs).toEqual([])
  })

  it('refuses a chat that is gone or whose agent is not OMP before asking anything', async () => {
    let asked = 0
    const sessions = { ompRequest: () => { asked++; return null } }
    await expect(catalogRig(undefined, { sessions, chatAgent: () => null }).models.chatModels({ folder: null, id: 'chat_1' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(catalogRig(undefined, { sessions, chatAgent: () => 'claude' }).models.chatModels({ folder: null, id: 'chat_1' })).rejects.toMatchObject({ code: 'unsupported' })
    expect(asked).toBe(0)
  })
})
