import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingPrompt } from '../../shared/agents/agentChat'
import type { ChatRecord } from '../../shared/agents/chat'
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings } from '../../shared/desktop/notificationSettings'
import { removeScratch } from '../../test/removeScratch'
import { builtInAgent } from '../agents/__mocks__/chatFixtures'
import { createChatStore } from '../agents/chatStore'
import type { ArbiterResult, startArbiter } from '../magos/arbiterRunner'
import { exclusionText, registerNeverArbitrate } from '../magos/arbitrationRules'
import { claudeInputClipped, createClaudeProtocolState, translateClaudeLine } from './claudeProtocol'
import { PendingPrompts } from './pendingPrompts'
import { createPromptArbitration } from './promptArbitration'

/** The app logger the main process passes in; the gate never imports one. */
const log = { info: vi.fn<Console['info']>(), warn: vi.fn<Console['warn']>() }

const TOO_LARGE = 'Input too large to review; decide this yourself.'
let root: string, folder: string, outside: string
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm prompt arbitration ')))
  folder = join(root, 'repo'); outside = join(root, 'elsewhere')
  mkdirSync(folder); mkdirSync(outside)
  log.info.mockClear()
})
afterEach(() => { vi.useRealTimers(); removeScratch(root) })

function chatOf(overrides: { role?: ChatRecord['role']; runId?: string; folder?: string | null } = {}): ChatRecord {
  const store = createChatStore({ root: join(root, 'chats') })
  const runId = 'runId' in overrides ? overrides.runId : 'rn_test'
  return store.createChat({ folder: overrides.folder === undefined ? folder : overrides.folder, agent: 'claude', model: null,
    role: overrides.role ?? 'orchestrator', allowSave: false, surface: 'gui', ...(runId === undefined ? {} : { runId }) })
}

function approval(id: string, input: Record<string, string> | null = { command: 'npm test' }, name = 'Bash'): PendingPrompt {
  return { id, kind: 'approval', title: `${name} ${id}`, detail: '', threadId: null, callsign: null, attributed: true,
    arbitration: { state: 'off', reason: null }, options: [{ id: 'allow_once', label: 'Allow once' }, { id: 'deny', label: 'Deny' }],
    ...(input === null ? {} : { tool: { name, input } }) }
}
function question(id: string): PendingPrompt {
  return { id, kind: 'question', title: 'Which database?', detail: '', threadId: null, callsign: null, attributed: true,
    arbitration: { state: 'off', reason: null }, options: [{ id: 'text', label: 'Answer' }] }
}

/** A stub runner: each start records its options and a verdict the test settles. */
function stubRunner() {
  const runs: { options: Parameters<typeof startArbiter>[0]; settle(result: ArbiterResult): void; cancel: ReturnType<typeof vi.fn> }[] = []
  const start = vi.fn((options: Parameters<typeof startArbiter>[0]) => {
    let settle!: (result: ArbiterResult) => void
    const result = new Promise<ArbiterResult>(resolve => { settle = resolve })
    const cancel = vi.fn(() => settle({ decision: 'escalate', cause: 'cancelled', reason: 'Arbiter cancelled.' }))
    runs.push({ options, settle, cancel })
    return { result, cancel }
  })
  return { start, runs }
}

type ReadContext = (input: { chat: ChatRecord; prompt: PendingPrompt }) => Promise<{ ticket: null; standards: string | null }>
function harness(options: { settings?: Pick<NotificationSettings, 'arbitration'>; agent?: 'claude' | 'omp'; readContext?: ReadContext } = {}) {
  const runner = stubRunner(), onAttention = vi.fn(), settings = vi.fn(() => options.settings ?? DEFAULT_NOTIFICATION_SETTINGS)
  const readContext = vi.fn<ReadContext>(options.readContext ?? (async () => ({ ticket: null, standards: null })))
  const arbitration = createPromptArbitration({
    settings, onAttention, readContext, platform: process.platform, env: { PATH: process.env.PATH }, arbiterRoot: join(root, 'arbiter'), startArbiter: runner.start, log
  })
  const agent = builtInAgent(options.agent ?? 'claude', { executablePath: join(root, 'claude.exe') })
  /** `clipped`: prompt ids whose tool input the translator recorded as cut. */
  const registry = (chat: ChatRecord, clipped: ReadonlySet<string> = new Set()) => {
    const publish = vi.fn(), answer = vi.fn()
    const prompts = new PendingPrompts({ publish, answer,
      arbitrate: prompt => arbitration.arbitrate({ ref: { folder: chat.folder, id: chat.id }, chat, agent, prompt, inputClipped: clipped.has(prompt.id) }) })
    return { prompts, publish, answer, chat }
  }
  return { runner, onAttention, settings, readContext, arbitration, registry }
}

/** Lets queued microtasks and promise chains run without a timer. */
async function settle(): Promise<void> {
  for (let index = 0; index < 10; index++) await Promise.resolve()
}

describe('exclusions (fix 7 mapping)', () => {
  const OFF = ['disabled', 'not_magos_chat', 'project_less', 'unsupported_kind'] as const
  for (const reason of OFF) it(`${reason} is off with no Magos line, still notifies and never spawns`, async () => {
    const h = harness({
      settings: reason === 'disabled' ? { arbitration: { ...DEFAULT_NOTIFICATION_SETTINGS.arbitration, enabled: false } } : undefined,
      agent: reason === 'unsupported_kind' ? 'omp' : 'claude'
    })
    const chat = chatOf(reason === 'not_magos_chat' ? { role: 'worker', runId: undefined } : reason === 'project_less' ? { folder: null } : {})
    const r = h.registry(chat)
    r.prompts.update([approval('p1')])
    await settle()
    expect(r.prompts.snapshot()?.arbitration).toEqual({ state: 'off', reason: null })
    expect(r.publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'p1', arbitration: { state: 'off', reason: null } }))
    expect(h.onAttention).toHaveBeenCalledExactlyOnceWith({ kind: 'approval_needed', ref: { folder: chat.folder, id: chat.id }, prompt: r.prompts.snapshot() })
    expect(h.runner.start).not.toHaveBeenCalled()
    expect(h.readContext).not.toHaveBeenCalled()
    expect(r.answer).not.toHaveBeenCalled()
  })

  it('disabled still notifies a question as a question (fix 27), reading settings fresh per prompt', async () => {
    let enabled = true
    const h = harness()
    h.settings.mockImplementation(() => ({ arbitration: { ...DEFAULT_NOTIFICATION_SETTINGS.arbitration, enabled } }))
    const r = h.registry(chatOf())
    enabled = false
    r.prompts.update([question('q1')])
    expect(r.prompts.snapshot()?.arbitration).toEqual({ state: 'off', reason: null })
    expect(h.onAttention).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'question', prompt: expect.objectContaining({ id: 'q1' }) }))
    enabled = true
    r.prompts.answer('q1', () => [approval('p2')])
    expect(r.prompts.snapshot()?.arbitration.state).toBe('deciding')
    expect(h.settings).toHaveBeenCalledTimes(2)
  })
})

describe('escalating exclusions (fix 7 mapping, requirement b)', () => {
  const escalated: [string, () => PendingPrompt, (() => () => void)?][] = [
    ['question', () => question('q1')],
    ['always_ask', () => approval('p1', { command: 'npm test' }, 'Bash')],
    ['outside_folder', () => approval('p1', { command: `type "${join(outside, 'secret.txt')}"` })],
    ['no_tool_input', () => approval('p1', null)],
    ['control_file', () => approval('p1', { file_path: join(folder, '.claude', 'settings.json'), content: '{}' }, 'Write')],
    ['never_arbitrate', () => approval('p1'), () => registerNeverArbitrate(() => true)]
  ]
  for (const [reason, prompt, register] of escalated) it(`${reason} escalates with its text and notifies without a spawn (requirement b)`, async () => {
    const unregister = register?.()
    try {
      const h = harness({ settings: reason === 'always_ask' ? { arbitration: { ...DEFAULT_NOTIFICATION_SETTINGS.arbitration, alwaysAsk: ['bash'] } } : undefined })
      const r = h.registry(chatOf())
      r.prompts.update([prompt()])
      await settle()
      expect(r.prompts.snapshot()?.arbitration).toEqual({ state: 'escalated', reason: exclusionText(reason as Parameters<typeof exclusionText>[0]) })
      expect(h.onAttention).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        kind: reason === 'question' ? 'question' : 'approval_needed', prompt: r.prompts.snapshot()
      }))
      expect(h.runner.start).not.toHaveBeenCalled()
    } finally { unregister?.() }
  })
})

// Size and clipping fixtures use short words. The path scan reads each word as a relative path, and a word over 255
// bytes is a name Linux refuses (ENAMETOOLONG) and Windows reports absent (ENOENT): Linux reads it, fail-closed, as
// outside the folder, an exclusion that is decided before size or the clip flag (see the precedence case below).
describe('oversized and clipped tool input (fix 17, requirement a)', () => {
  it('a 4,001-character Bash command escalates as too large with zero spawns', async () => {
    const h = harness(), r = h.registry(chatOf())
    r.prompts.update([approval('p1', { command: `echo ${'a '.repeat(1_998)}` })])
    expect(r.prompts.snapshot()?.tool?.input.command).toHaveLength(4_001)
    await settle()
    expect(r.prompts.snapshot()?.arbitration).toEqual({ state: 'escalated', reason: TOO_LARGE })
    expect(h.onAttention).toHaveBeenCalledOnce()
    expect(h.runner.start).not.toHaveBeenCalled()
  })

  it('a request whose masked input JSON exceeds 4,000 characters is refused by buildArbiterRequest without a spawn', async () => {
    const h = harness(), r = h.registry(chatOf())
    const input = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map(key => [key, 'x '.repeat(450)]))
    r.prompts.update([approval('p1', input, 'Lint')])
    expect(r.prompts.snapshot()?.arbitration.state).toBe('deciding')
    await settle()
    expect(r.prompts.snapshot()?.arbitration).toEqual({ state: 'escalated', reason: TOO_LARGE })
    expect(h.onAttention).toHaveBeenCalledOnce()
    expect(h.runner.start).not.toHaveBeenCalled()
  })

  it('the recorded clip flag, not the visible length, decides: a clipped input is never decided', async () => {
    const h = harness(), r = h.registry(chatOf(), new Set(['p1']))
    r.prompts.update([approval('p1', { command: 'echo short' })])
    await settle()
    expect(r.prompts.snapshot()?.arbitration).toEqual({ state: 'escalated', reason: TOO_LARGE })
    expect(h.runner.start).not.toHaveBeenCalled()
    r.prompts.answer('p1', () => [approval('p2', { command: `echo ${'a '.repeat(497)}a` })])
    await settle()
    expect(h.runner.start).toHaveBeenCalledOnce()
  })

  it('an exclusion outranks the clip flag: a clipped input naming an outside path escalates as outside the folder', async () => {
    const h = harness(), r = h.registry(chatOf(), new Set(['p1']))
    r.prompts.update([approval('p1', { command: `type "${join(outside, 'secret.txt')}"` })])
    await settle()
    expect(r.prompts.snapshot()?.arbitration).toEqual({ state: 'escalated', reason: exclusionText('outside_folder') })
    expect(h.onAttention).toHaveBeenCalledOnce()
    expect(h.runner.start).not.toHaveBeenCalled()
  })
})

describe('clipping recorded at the cut (P1)', () => {
  for (const prefix of ['at_', 'ka_'] as const) for (const [tool, key, limit] of [['Bash', 'command', 1_000], ['Write', 'file_path', 4_096]] as const) {
    it(`a partial ${prefix} token ending at the ${limit}-character ${key} cut is recorded as clipped and never decided (P1)`, async () => {
      // The whole token is followed by a space, so the first mask pass keeps it; after the cut it ends the text, and
      // the second pass shrinks it below the limit: the visible length would look unclipped.
      const partial = `${prefix}${'0123456789abcdefghjkmnpqrs'}.abc`, length = limit - partial.length
      // A command uses short words, so the recorded clip decides its reason. A file path is one name however it is
      // built; past Linux's limits (255-byte names, 4,096-byte paths) the scan cannot resolve it and reads it as
      // outside the folder, so for a path only the escalated state is asserted, the same on every platform.
      const filler = key === 'command' ? `${'a '.repeat(length).slice(0, length - 1)} ` : 'a'.repeat(length)
      const value = `${filler}${partial} && type "${join(outside, 'secret.txt')}"`
      const translated = translateClaudeLine(JSON.stringify({ type: 'control_request', request_id: 'req_clip',
        request: { subtype: 'can_use_tool', tool_name: tool, input: { [key]: value, ...(tool === 'Write' ? { content: '{}' } : {}) } } }),
      createClaudeProtocolState(), new Date(0).toISOString())
      const [held] = [...translated.state.pending.values()].map(entry => entry.prompt)
      expect(held.tool?.input[key]).toHaveLength(limit - partial.length + '[claim token masked]'.length)
      expect(claudeInputClipped(translated.state, held.id)).toBe(true)
      const h = harness(), r = h.registry(chatOf(), new Set([held.id]))
      r.prompts.update([held])
      await settle()
      expect(r.prompts.snapshot()?.arbitration.state).toBe('escalated')
      if (key === 'command') expect(r.prompts.snapshot()?.arbitration.reason).toBe(TOO_LARGE)
      expect(h.onAttention).toHaveBeenCalledOnce()
      expect(h.runner.start).not.toHaveBeenCalled()
    })
  }

  it('an input exactly at its limit is not clipped, and an unknown prompt counts as clipped', () => {
    const translated = translateClaudeLine(JSON.stringify({ type: 'control_request', request_id: 'req_exact',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'a'.repeat(1_000) } } }), createClaudeProtocolState(), new Date(0).toISOString())
    expect(claudeInputClipped(translated.state, 'req_exact')).toBe(false)
    expect(claudeInputClipped(translated.state, 'unknown')).toBe(true)
  })
})

describe('verdicts', () => {
  for (const decision of ['allow_once', 'deny'] as const) it(`${decision} answers through the session path with the masked reason`, async () => {
    const h = harness({ readContext: async () => ({ ticket: null, standards: 'Keep tests green.\n## Detail\nNested stays.' }) })
    const r = h.registry(chatOf())
    r.prompts.update([approval('p1')])
    expect(r.publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ arbitration: { state: 'deciding', reason: null } }))
    await settle()
    expect(h.readContext).toHaveBeenCalledExactlyOnceWith({ chat: r.chat, prompt: expect.objectContaining({ id: 'p1' }) })
    const [run] = h.runner.runs
    expect(run.options).toMatchObject({ timeoutMs: 60_000, tempRoot: join(root, 'arbiter') })
    expect(run.options.input).toMatch(/^REQUEST:\n/)
    expect(JSON.parse(run.options.input.slice('REQUEST:\n'.length))).toMatchObject({ prompt: { tool: 'Bash', input: { command: 'npm test' } }, standards: expect.stringContaining('Keep tests green.') })
    expect(run.options.launch(join(root, 'arbiter temp'))).toMatchObject({ protocol: 'claude', cwd: join(root, 'arbiter temp'), args: expect.arrayContaining(['--safe-mode']) })
    run.settle({ decision, reason: `Routine dmg_${'a1'.repeat(32)}` })
    await settle()
    expect(r.answer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'p1' }), { decision, reason: expect.not.stringContaining('dmg_') })
    expect(h.onAttention).not.toHaveBeenCalled()
    const lines = log.info.mock.calls
    expect(lines).toEqual([['Magos arbitration:', { chatId: r.chat.id, promptId: 'p1', decision, cause: 'verdict' }]])
    expect(JSON.stringify(lines)).not.toMatch(/npm test|Routine/)
  })

  for (const cause of ['verdict', 'invalid', 'timeout', 'error'] as const) it(`an escalation (${cause}) keeps the prompt pending and notifies`, async () => {
    const h = harness(), r = h.registry(chatOf())
    r.prompts.update([approval('p1')])
    await settle()
    h.runner.runs[0].settle({ decision: 'escalate', cause, reason: `Escalated by ${cause}.` })
    await settle()
    expect(r.prompts.snapshot()).toMatchObject({ id: 'p1', arbitration: { state: 'escalated', reason: `Escalated by ${cause}.` } })
    expect(h.onAttention).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'approval_needed', prompt: r.prompts.snapshot() }))
    expect(r.answer).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenLastCalledWith('Magos arbitration:', expect.objectContaining({ decision: 'escalate', cause }))
  })

  it('a runner that throws on start, or failing context, still fails closed', async () => {
    const h = harness({ readContext: () => Promise.reject(new Error('board offline')) }), r = h.registry(chatOf())
    h.runner.start.mockImplementationOnce(() => { throw new Error('spawn refused') })
    r.prompts.update([approval('p1')])
    await settle()
    expect(h.readContext).toHaveBeenCalledOnce()
    expect(r.prompts.snapshot()?.arbitration).toEqual({ state: 'escalated', reason: 'Arbiter failed to start.' })
    expect(h.onAttention).toHaveBeenCalledOnce()
  })
})

describe('races and capacity', () => {
  it('the person answers first: the arbiter is cancelled and its late verdict stores nothing', async () => {
    const h = harness(), r = h.registry(chatOf())
    r.prompts.update([approval('p1')])
    await settle()
    const [run] = h.runner.runs
    r.prompts.answer('p1', () => [])
    expect(run.cancel).toHaveBeenCalledOnce()
    run.settle({ decision: 'allow_once', reason: 'Late verdict' })
    await settle()
    expect(r.answer).not.toHaveBeenCalled()
    expect(h.onAttention).not.toHaveBeenCalled()
    expect(r.prompts.snapshot()).toBeNull()
  })

  it('chat exit cancels its running arbiter and a queued one never starts', async () => {
    const h = harness(), chats = [1, 2, 3, 4].map(() => h.registry(chatOf()))
    for (const r of chats) r.prompts.update([approval('p1')])
    await settle()
    expect(h.runner.start).toHaveBeenCalledTimes(3)
    chats[0].prompts.clear()
    chats[3].prompts.clear()
    expect(h.runner.runs[0].cancel).toHaveBeenCalledOnce()
    await settle()
    expect(h.runner.start).toHaveBeenCalledTimes(3)
  })
})

describe('capacity', () => {
  it('the fourth concurrent arbiter waits in FIFO order until one finishes', async () => {
    const h = harness(), chats = [1, 2, 3, 4, 5].map(() => h.registry(chatOf()))
    for (const r of chats) r.prompts.update([approval('p1')])
    await settle()
    expect(h.runner.start).toHaveBeenCalledTimes(3)
    expect(chats.map(r => r.prompts.snapshot()?.arbitration.state)).toEqual(['deciding', 'deciding', 'deciding', 'deciding', 'deciding'])
    h.runner.runs[1].settle({ decision: 'deny', reason: 'No' })
    await settle()
    expect(h.runner.start).toHaveBeenCalledTimes(4)
    expect(h.readContext.mock.calls.map(([input]) => input.chat.id)).toEqual(chats.slice(0, 4).map(r => r.chat.id))
  })

  it('one chat runs one arbiter: a replaced prompt waits until the cancelled runner has cleaned up', async () => {
    const h = harness(), r = h.registry(chatOf())
    let cleaned!: (result: ArbiterResult) => void
    h.runner.start.mockImplementationOnce(() => ({ result: new Promise<ArbiterResult>(resolve => { cleaned = resolve }), cancel: vi.fn() }))
    r.prompts.update([approval('p1')])
    await settle()
    r.prompts.update([approval('p2')])
    await settle()
    expect(h.runner.start).toHaveBeenCalledOnce()
    cleaned({ decision: 'escalate', cause: 'cancelled', reason: 'Arbiter cancelled.' })
    await settle()
    expect(h.runner.start).toHaveBeenCalledTimes(2)
  })

  it('dispose cancels every queued and running arbiter', async () => {
    const h = harness(), chats = [1, 2, 3, 4].map(() => h.registry(chatOf()))
    for (const r of chats) r.prompts.update([approval('p1')])
    await settle()
    h.arbitration.dispose()
    expect(h.runner.runs.map(run => run.cancel.mock.calls.length)).toEqual([1, 1, 1])
    await settle()
    expect(h.runner.start).toHaveBeenCalledTimes(3)
    for (const r of chats) expect(r.answer).not.toHaveBeenCalled()
  })
})
