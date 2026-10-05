import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChatItem, ChatRecord } from '../../shared/agents/chat'
import { AT, memoryChatFs, memoryChatStore, REPO, type MemoryChatFs } from './__mocks__/fakeChatAdapter'
import { ATTEMPT_A, ATTEMPT_B, ORCHESTRATOR_CHAT_ITEMS, RUN_ID, THREAD_A, THREAD_B } from './__mocks__/orchestratorChat'
import { createActivityBindings, type ActivityBinding, type ActivityBindings } from './activityBindings'
import type { ChatStore, NewChat } from './chatStore'

const FILE = resolve('/state/agents/activity-bindings.jsonl')
const OTHER_ATTEMPT = 'at_01k8zq6b3c4d5e6f7g8h9j0k1m'
const THIRD_ATTEMPT = 'at_01k8zq7c4d5e6f7g8h9j0k1m2n'
/** Made-up claim tokens of the real shape: the attempt id, a dot, a 32-character base64url secret. */
const SECRET_A = 'Qx7vT2mN9pL4kR8sW1yZ3bC6dF0gH5jA'
const SECRET_OTHER = 'pT4-wq_8NvXr2LsYb6KdE1hGc9MzUa3F'
const TOKEN_A = `${ATTEMPT_A}.${SECRET_A}`
const TOKEN_OTHER = `${OTHER_ATTEMPT}.${SECRET_OTHER}`
const SPAWN = 'claude_tool_toolu_spawn1'
const THREAD = 'claude_thread_toolu_spawn1'
const ORCHESTRATOR: NewChat = { folder: REPO, agent: 'claude', model: 'opus', role: 'orchestrator', allowSave: true }

type ToolCall = Extract<ChatItem, { kind: 'tool_call' }>

function bindingsOver(fs: MemoryChatFs): ActivityBindings {
  return createActivityBindings({ file: FILE, fs })
}

function bindingsFile(fs: MemoryChatFs): string {
  return fs.files.get(FILE) ?? ''
}

function lineCount(fs: MemoryChatFs): number {
  return bindingsFile(fs).split('\n').filter((line) => line.trim() !== '').length
}

/** Appends the fixture's lines through the store and reads the transcript back, as the app stores and replays it. */
function recorded(store: ChatStore, chat: ChatRecord, items: readonly ChatItem[] = ORCHESTRATOR_CHAT_ITEMS): { chat: ChatRecord; items: ChatItem[] } {
  for (const item of items) {
    store.appendItem(chat, item)
  }
  const transcript = store.readTranscript(chat)
  if (transcript === null) {
    throw new Error('The chat was not stored.')
  }
  return { chat: transcript.chat, items: transcript.items }
}

function where(binding: ActivityBinding): { chatId: string; threadId: string | null; role: string } {
  return { chatId: binding.chatId, threadId: binding.threadId, role: binding.role }
}

function workersOf(bindings: ActivityBindings, attemptId: string): ReturnType<typeof where>[] {
  return bindings
    .byAttempt(attemptId)
    .filter((binding) => binding.role === 'worker')
    .map(where)
}

/** A tool call the server already answered (`completed`), unless `extra` says otherwise. */
function call(name: string, input: ToolCall['input'], extra: Partial<ToolCall> = {}): ToolCall {
  return { id: `claude_tool_${name}_${Object.keys(input).join('_')}`, at: AT, kind: 'tool_call', name, input, status: 'completed', resultSummary: null, ...extra }
}

function spawnCall(prompt: string, extra: Partial<ToolCall> = {}): ToolCall {
  return { ...call('Agent', { description: 'Worker', subagent_type: 'general-purpose', prompt }), id: SPAWN, ...extra }
}

function threadOf(parentItemId = SPAWN, id = THREAD): ChatItem {
  return { id, at: AT, kind: 'thread', parentItemId, label: 'Worker', state: 'running' }
}

interface Observed {
  fs: MemoryChatFs
  bindings: ActivityBindings
  chat: ChatRecord
}

/** A chat (an orchestrator Start run did not launch, by default) whose live items the bindings observe one by one. */
function observed(items: readonly ChatItem[], chat: Partial<NewChat> = {}): Observed {
  const fs = memoryChatFs()
  const record = memoryChatStore(fs).createChat({ ...ORCHESTRATOR, ...chat })
  const bindings = bindingsOver(fs)
  for (const item of items) {
    bindings.observe(record, item)
  }
  return { fs, bindings, chat: record }
}

describe('activity bindings: replaying a recorded orchestrator chat (c1)', () => {
  it('binds the main thread to the run and each worker subagent to its own attempt', () => {
    const fs = memoryChatFs()
    const store = memoryChatStore(fs)
    const transcript = recorded(store, store.createChat({ ...ORCHESTRATOR, runId: RUN_ID }))
    const bindings = bindingsOver(fs)

    bindings.observeChat(transcript.chat, transcript.items)

    const chatId = transcript.chat.id
    expect(bindings.byRun(RUN_ID)).toEqual([{ chatId, threadId: null, folder: REPO, role: 'orchestrator', kind: 'run', runId: RUN_ID }])
    expect(workersOf(bindings, ATTEMPT_A)).toEqual([{ chatId, threadId: THREAD_A, role: 'worker' }])
    expect(workersOf(bindings, ATTEMPT_B)).toEqual([{ chatId, threadId: THREAD_B, role: 'worker' }])
  })

  it('records the main thread as the orchestrator that claimed each attempt, from the claim results', () => {
    const fs = memoryChatFs()
    const store = memoryChatStore(fs)
    const transcript = recorded(store, store.createChat({ ...ORCHESTRATOR, runId: RUN_ID }))
    const bindings = bindingsOver(fs)

    bindings.observeChat(transcript.chat, transcript.items)

    const orchestrator = { chatId: transcript.chat.id, threadId: null, role: 'orchestrator' }
    expect(bindings.byAttempt(ATTEMPT_A).map(where)).toEqual([orchestrator, { ...orchestrator, threadId: THREAD_A, role: 'worker' }])
    expect(bindings.byAttempt(ATTEMPT_B).map(where)).toEqual([orchestrator, { ...orchestrator, threadId: THREAD_B, role: 'worker' }])
  })

  it('finds the run of a chat Start run did not launch from its start_run result', () => {
    const fs = memoryChatFs()
    const store = memoryChatStore(fs)
    const transcript = recorded(store, store.createChat(ORCHESTRATOR))
    const bindings = bindingsOver(fs)

    bindings.observeChat(transcript.chat, transcript.items)

    expect(bindings.byRun(RUN_ID).map(where)).toEqual([{ chatId: transcript.chat.id, threadId: null, role: 'orchestrator' }])
  })

  it('binds a chat Start run launched to its run before it has any item', () => {
    const fs = memoryChatFs()
    const chat = memoryChatStore(fs).createChat({ ...ORCHESTRATOR, runId: RUN_ID })
    const bindings = bindingsOver(fs)

    expect(bindings.observeChat(chat, []).map(where)).toEqual([{ chatId: chat.id, threadId: null, role: 'orchestrator' }])
    expect(bindings.byRun(RUN_ID)).toHaveLength(1)
  })
})

describe('activity bindings: replays are idempotent and bindings outlive the app', () => {
  it('adds nothing when the same items are replayed again, by the same app or a restarted one', () => {
    const fs = memoryChatFs()
    const store = memoryChatStore(fs)
    const transcript = recorded(store, store.createChat({ ...ORCHESTRATOR, runId: RUN_ID }))
    const bindings = bindingsOver(fs)
    const first = bindings.observeChat(transcript.chat, transcript.items)
    const lines = lineCount(fs)

    expect(first).toHaveLength(5)
    expect(lines).toBe(5)
    expect(bindings.observeChat(transcript.chat, transcript.items)).toEqual([])
    expect(bindingsOver(fs).observeChat(transcript.chat, transcript.items)).toEqual([])
    expect(lineCount(fs)).toBe(lines)
  })

  it('keeps the role first bound, so a replay after the chat changed role adds nothing', () => {
    const heartbeat = call('mcp__darkmechanicus__heartbeat_attempt', { attemptId: ATTEMPT_A })
    const { bindings, chat, fs } = observed([heartbeat])

    expect(bindings.observeChat({ ...chat, role: 'worker' }, [heartbeat])).toEqual([])
    expect(bindings.byAttempt(ATTEMPT_A).map((binding) => binding.role)).toEqual(['orchestrator'])
    expect(lineCount(fs)).toBe(1)
  })

  it('answers lookups after a restart from what it stored', () => {
    const fs = memoryChatFs()
    const store = memoryChatStore(fs)
    const transcript = recorded(store, store.createChat({ ...ORCHESTRATOR, runId: RUN_ID }))
    bindingsOver(fs).observeChat(transcript.chat, transcript.items)

    const restarted = bindingsOver(fs)

    expect(restarted.byRun(RUN_ID).map(where)).toEqual([{ chatId: transcript.chat.id, threadId: null, role: 'orchestrator' }])
    expect(workersOf(restarted, ATTEMPT_A)).toEqual([{ chatId: transcript.chat.id, threadId: THREAD_A, role: 'worker' }])
    expect(restarted.byAttempt(OTHER_ATTEMPT)).toEqual([])
    expect(restarted.byRun('rn_01k8zq9z9z9z9z9z9z9z9z9z9z')).toEqual([])
  })
})

describe('activity bindings: lookups (c2)', () => {
  it('return the chat, its folder and the thread for an attempt and for a run', () => {
    const { bindings, chat } = observed([spawnCall(`attemptId: ${ATTEMPT_A}`), threadOf(), call('mcp__darkmechanicus__takeover_run', { runId: RUN_ID })])

    expect(bindings.byAttempt(ATTEMPT_A)).toEqual([{ chatId: chat.id, threadId: THREAD, folder: REPO, role: 'worker', kind: 'attempt', attemptId: ATTEMPT_A }])
    expect(bindings.byRun(RUN_ID)).toEqual([{ chatId: chat.id, threadId: null, folder: REPO, role: 'orchestrator', kind: 'run', runId: RUN_ID }])
  })

  it('return the bindings of every chat that acted on the same attempt', () => {
    const fs = memoryChatFs()
    const store = memoryChatStore(fs)
    const orchestrator = store.createChat(ORCHESTRATOR)
    const worker = store.createChat({ ...ORCHESTRATOR, role: 'worker' })
    const bindings = bindingsOver(fs)

    bindings.observe(orchestrator, call('mcp__darkmechanicus__fail_attempt', { attemptId: ATTEMPT_A, failure: { reason: 'blocked' } }))
    bindings.observe(worker, call('mcp__darkmechanicus__heartbeat_attempt', { attemptId: ATTEMPT_A, claimToken: TOKEN_A }))

    expect(bindings.byAttempt(ATTEMPT_A).map(where)).toEqual([
      { chatId: orchestrator.id, threadId: null, role: 'orchestrator' },
      { chatId: worker.id, threadId: null, role: 'worker' }
    ])
  })
})

describe('activity bindings: the run tools of a main thread', () => {
  it('binds start_run by the run id in its result, once the call completed', () => {
    const result = `{"ok":true,"data":{"id":"${RUN_ID}","number":1,"epicId":"ep_01k8zq2a3b4c5d6e7f8g9h0j1k"`
    const running = call('mcp__darkmechanicus__start_run', { epicId: 'ep_01k8zq2a3b4c5d6e7f8g9h0j1k' }, { status: 'running' })
    const { bindings, chat } = observed([running])
    expect(bindings.byRun(RUN_ID)).toEqual([])

    bindings.observe(chat, { ...running, status: 'completed', resultSummary: result })
    expect(bindings.byRun(RUN_ID)).toHaveLength(1)
  })

  it('binds nothing for a start_run that failed or whose result names no single run', () => {
    const failed = call('mcp__darkmechanicus__start_run', {}, { status: 'failed', resultSummary: `{"ok":false,"error":{"details":{"runId":"${RUN_ID}"}}}` })
    const twoRuns = call('mcp__darkmechanicus__start_run', {}, { status: 'completed', resultSummary: `${RUN_ID} rn_01k8zq9z9z9z9z9z9z9z9z9z9z` })

    expect(observed([failed, twoRuns]).bindings.byRun(RUN_ID)).toEqual([])
  })

  it('binds takeover_run and claim_ticket by the run id in their input', () => {
    const takeover = observed([call('mcp__darkmechanicus__takeover_run', { runId: RUN_ID })])
    const claim = observed([call('mcp__darkmechanicus__claim_ticket', { runId: RUN_ID, ticketId: 'tk_01k8zq2m3n4p5q6r7s8t9v0w1x' })])

    expect(takeover.bindings.byRun(RUN_ID).map(where)).toEqual([{ chatId: takeover.chat.id, threadId: null, role: 'orchestrator' }])
    expect(claim.bindings.byRun(RUN_ID).map(where)).toEqual([{ chatId: claim.chat.id, threadId: null, role: 'orchestrator' }])
  })

  it('binds no run for run tools a subagent calls, or for ids that are not run ids', () => {
    const inThread = { threadId: THREAD }
    const { bindings, fs } = observed([
      call('mcp__darkmechanicus__takeover_run', { runId: RUN_ID }, inThread),
      call('mcp__darkmechanicus__claim_ticket', { runId: RUN_ID }, { ...inThread, status: 'completed', resultSummary: ATTEMPT_A }),
      call('mcp__darkmechanicus__start_run', {}, { ...inThread, status: 'completed', resultSummary: RUN_ID }),
      call('mcp__darkmechanicus__takeover_run', { runId: `${RUN_ID}x` }),
      call('mcp__darkmechanicus__takeover_run', { runId: ATTEMPT_A })
    ])

    expect(bindings.byRun(RUN_ID)).toEqual([])
    expect(bindings.byAttempt(ATTEMPT_A)).toEqual([])
    expect(lineCount(fs)).toBe(0)
  })

  it('reads the tool names Codex gives Dark Mechanicus calls, and ignores other servers', () => {
    const codex = observed([call('darkmechanicus.takeover_run', { runId: RUN_ID }), call('darkmechanicus.heartbeat_attempt', { attemptId: ATTEMPT_A }, { threadId: THREAD })])
    const other = observed([call('mcp__othermechanicus__takeover_run', { runId: RUN_ID }), call('takeover_run', { runId: RUN_ID })])

    expect(codex.bindings.byRun(RUN_ID)).toHaveLength(1)
    expect(codex.bindings.byAttempt(ATTEMPT_A).map(where)).toEqual([{ chatId: codex.chat.id, threadId: THREAD, role: 'worker' }])
    expect(other.bindings.byRun(RUN_ID)).toEqual([])
  })
})

describe('activity bindings: the attempt tools', () => {
  it('bind the thread that calls heartbeat_attempt, submit_attempt or fail_attempt to the attempt', () => {
    const { bindings, chat } = observed([
      call('mcp__darkmechanicus__heartbeat_attempt', { attemptId: ATTEMPT_A }, { threadId: 'thread_a' }),
      call('mcp__darkmechanicus__submit_attempt', { attemptId: ATTEMPT_B }, { threadId: 'thread_b' }),
      call('mcp__darkmechanicus__fail_attempt', { attemptId: OTHER_ATTEMPT }, { threadId: 'thread_c' })
    ])

    expect(bindings.byAttempt(ATTEMPT_A).map(where)).toEqual([{ chatId: chat.id, threadId: 'thread_a', role: 'worker' }])
    expect(bindings.byAttempt(ATTEMPT_B).map(where)).toEqual([{ chatId: chat.id, threadId: 'thread_b', role: 'worker' }])
    expect(bindings.byAttempt(OTHER_ATTEMPT).map(where)).toEqual([{ chatId: chat.id, threadId: 'thread_c', role: 'worker' }])
  })

  it('bind only once the server answered the call: not while it runs, nor when it failed or was denied', () => {
    const inThread = { threadId: 'thread_a' }
    const { bindings, fs } = observed([
      call('mcp__darkmechanicus__heartbeat_attempt', { attemptId: ATTEMPT_A }, { ...inThread, status: 'running' }),
      call('mcp__darkmechanicus__submit_attempt', { attemptId: ATTEMPT_A }, { ...inThread, status: 'failed', resultSummary: 'stale_claim' }),
      call('mcp__darkmechanicus__fail_attempt', { attemptId: ATTEMPT_A }, { ...inThread, status: 'denied' }),
      call('mcp__darkmechanicus__takeover_run', { runId: RUN_ID }, { status: 'running' }),
      call('mcp__darkmechanicus__claim_ticket', { runId: RUN_ID }, { status: 'failed', resultSummary: `{"ok":false,"error":{"code":"unauthorized"}}` })
    ])

    expect(bindings.byAttempt(ATTEMPT_A)).toEqual([])
    expect(bindings.byRun(RUN_ID)).toEqual([])
    expect(lineCount(fs)).toBe(0)
  })

  it('make the main thread of an orchestrator the orchestrator of the attempt, and of any other chat its worker', () => {
    const heartbeat = call('mcp__darkmechanicus__heartbeat_attempt', { attemptId: ATTEMPT_A })
    const orchestrator = observed([heartbeat])
    const worker = observed([heartbeat], { role: 'worker' })

    expect(orchestrator.bindings.byAttempt(ATTEMPT_A).map((binding) => binding.role)).toEqual(['orchestrator'])
    expect(worker.bindings.byAttempt(ATTEMPT_A).map((binding) => binding.role)).toEqual(['worker'])
  })

  it('take the attempt id only as an exact id: never from a token, a longer word or another tool', () => {
    const { bindings, fs } = observed([
      call('mcp__darkmechanicus__heartbeat_attempt', { attemptId: TOKEN_A }),
      call('mcp__darkmechanicus__submit_attempt', { attemptId: `x${ATTEMPT_A}` }),
      call('mcp__darkmechanicus__fail_attempt', { attemptId: ATTEMPT_A.slice(0, -1) }),
      call('mcp__darkmechanicus__get_ticket', { attemptId: ATTEMPT_A }),
      call('Bash', { command: `echo ${ATTEMPT_A}` })
    ])

    expect(bindings.byAttempt(ATTEMPT_A)).toEqual([])
    expect(lineCount(fs)).toBe(0)
  })
})

describe('activity bindings: worker subagents an orchestrator starts', () => {
  it('bind the thread to the one attempt id its spawn prompt carries', () => {
    const { bindings, chat } = observed([spawnCall(`Do the ticket. Your attempt is ${ATTEMPT_A}; heartbeat it.`), threadOf()])

    expect(bindings.byAttempt(ATTEMPT_A).map(where)).toEqual([{ chatId: chat.id, threadId: THREAD, role: 'worker' }])
  })

  it('take the attempt id, never the secret, from a prompt that carries a whole claim token', () => {
    const { bindings, fs } = observed([spawnCall(`Execution packet: {"claimToken":"${TOKEN_A}"}`), threadOf()])

    expect(bindings.byAttempt(ATTEMPT_A).map((binding) => binding.threadId)).toEqual([THREAD])
    expect(bindingsFile(fs)).toContain(ATTEMPT_A)
    expect(bindingsFile(fs)).not.toContain(SECRET_A)
  })

  it('follow a clearly labelled attempt id when the prompt names other attempts too', () => {
    const prompt = `Retry of ${OTHER_ATTEMPT}, which failed.\n{"attemptId":"${ATTEMPT_A}","claimToken":"${TOKEN_A}"}`
    const { bindings } = observed([spawnCall(prompt), threadOf()])

    expect(bindings.byAttempt(ATTEMPT_A).map((binding) => binding.threadId)).toEqual([THREAD])
    expect(bindings.byAttempt(OTHER_ATTEMPT)).toEqual([])
  })

  it('bind nothing when the prompt carries several different attempt ids and none is labelled alone', () => {
    const unlabelled = observed([spawnCall(`Compare ${ATTEMPT_A} with ${OTHER_ATTEMPT}; token ${TOKEN_OTHER}`), threadOf()])
    const twoLabels = observed([spawnCall(`attemptId: ${ATTEMPT_A}\nattempt_id = ${THIRD_ATTEMPT}`), threadOf()])

    for (const { bindings, fs } of [unlabelled, twoLabels]) {
      expect([ATTEMPT_A, OTHER_ATTEMPT, THIRD_ATTEMPT].flatMap((id) => bindings.byAttempt(id))).toEqual([])
      expect(lineCount(fs)).toBe(0)
    }
  })

  it('bind nothing for a prompt without a whole attempt id', () => {
    const { bindings, fs } = observed([spawnCall(`Partial: ${ATTEMPT_A.slice(0, -2)} and longer: ${ATTEMPT_A}z9 and prefixed: x${ATTEMPT_A}`), threadOf()])

    expect(bindings.byAttempt(ATTEMPT_A)).toEqual([])
    expect(lineCount(fs)).toBe(0)
  })

  it('leave subagents alone that a subagent starts, or that a chat starts which orchestrates nothing', () => {
    const nested = observed([spawnCall(`attemptId: ${ATTEMPT_A}`, { threadId: 'claude_thread_outer' }), { ...threadOf(), threadId: 'claude_thread_outer' }])
    const planner = observed([spawnCall(`attemptId: ${ATTEMPT_A}`), threadOf()], { role: 'planner' })

    expect(nested.bindings.byAttempt(ATTEMPT_A)).toEqual([])
    expect(planner.bindings.byAttempt(ATTEMPT_A)).toEqual([])
  })

  it('treat a chat Start run launched as an orchestrator, whatever its role says', () => {
    const { bindings } = observed([spawnCall(`attemptId: ${ATTEMPT_A}`), threadOf()], { role: 'planner', runId: RUN_ID })

    expect(bindings.byAttempt(ATTEMPT_A).map((binding) => binding.threadId)).toEqual([THREAD])
  })

  it('only bind a thread whose spawning call carried the id, not a thread of another call', () => {
    const { bindings } = observed([spawnCall(`attemptId: ${ATTEMPT_A}`), threadOf('claude_tool_toolu_other', 'claude_thread_toolu_other')])

    expect(bindings.byAttempt(ATTEMPT_A)).toEqual([])
  })
})

describe('activity bindings: no claim token is ever stored (c3)', () => {
  it('stores bindings without the secret of any token the live items carried', () => {
    const { fs } = observed([
      spawnCall(`{"attemptId":"${ATTEMPT_A}","claimToken":"${TOKEN_A}"}`),
      threadOf(),
      call('mcp__darkmechanicus__heartbeat_attempt', { attemptId: ATTEMPT_A, claimToken: TOKEN_A }, { threadId: THREAD }),
      call('mcp__darkmechanicus__claim_ticket', { runId: RUN_ID }, { status: 'completed', resultSummary: `{"attempt":{"id":"${OTHER_ATTEMPT}"},"packet":{"claimToken":"${TOKEN_OTHER}"}}` })
    ])

    expect(lineCount(fs)).toBe(3)
    expect(bindingsFile(fs)).not.toContain(SECRET_A)
    expect(bindingsFile(fs)).not.toContain(SECRET_OTHER)
    expect(bindingsFile(fs)).not.toMatch(/at_[0-9a-hjkmnp-tv-z]{26}\.[A-Za-z0-9_-]/)
  })

  it('masks a token in a thread id the way the chat store masks the item, so the two still match', () => {
    const fs = memoryChatFs()
    const store = memoryChatStore(fs)
    const chat = store.createChat(ORCHESTRATOR)
    const item = call('mcp__darkmechanicus__heartbeat_attempt', { attemptId: ATTEMPT_A }, { threadId: `thread_${TOKEN_A}` })
    const stored = store.appendItem(chat, item)

    bindingsOver(fs).observe(chat, item)

    expect(bindingsFile(fs)).not.toContain(SECRET_A)
    expect(bindingsOver(fs).byAttempt(ATTEMPT_A).map((binding) => binding.threadId)).toEqual([stored.threadId])
  })

  it('skips stored lines that are not bindings or that carry a token, and appends cleanly after a cut-off line', () => {
    const fs = memoryChatFs()
    const chat = memoryChatStore(fs).createChat(ORCHESTRATOR)
    const planted = { chatId: chat.id, threadId: `t_${TOKEN_A}`, folder: REPO, role: 'worker', kind: 'attempt', attemptId: ATTEMPT_A }
    fs.files.set(FILE, `not json\n{"kind":"attempt"}\n${JSON.stringify(planted)}\n{"chatId":"cut`)
    const bindings = bindingsOver(fs)

    expect(bindings.byAttempt(ATTEMPT_A)).toEqual([])
    bindings.observe(chat, call('mcp__darkmechanicus__takeover_run', { runId: RUN_ID }))

    expect(bindingsOver(fs).byRun(RUN_ID)).toHaveLength(1)
    expect(bindingsFile(fs).endsWith('\n')).toBe(true)
  })
})

describe('activity bindings: forgetting a deleted chat', () => {
  it('removes every binding of the chat from memory and disk, and keeps the other chats', () => {
    const fs = memoryChatFs()
    const store = memoryChatStore(fs)
    const doomed = store.createChat({ ...ORCHESTRATOR, runId: RUN_ID })
    const kept = store.createChat({ ...ORCHESTRATOR, runId: RUN_ID })
    const bindings = bindingsOver(fs)
    bindings.observeChat(doomed, recorded(store, doomed).items)
    bindings.observeChat(kept, [])

    bindings.forgetChat(doomed)

    expect(bindings.byRun(RUN_ID).map((binding) => binding.chatId)).toEqual([kept.id])
    expect(bindings.byAttempt(ATTEMPT_A)).toEqual([])
    expect(bindingsFile(fs)).not.toContain(`"chatId":"${doomed.id}"`)
    expect(bindingsOver(fs).byRun(RUN_ID).map((binding) => binding.chatId)).toEqual([kept.id])
  })

  it('forgets the spawn calls it remembered for the chat', () => {
    const { bindings, chat, fs } = observed([spawnCall(`attemptId: ${ATTEMPT_A}`)])
    bindings.forgetChat(chat)

    bindings.observe(chat, threadOf())

    expect(bindings.byAttempt(ATTEMPT_A)).toEqual([])
    expect(lineCount(fs)).toBe(0)
  })
})

describe('activity bindings: lookups by chat', () => {
  it('return every binding of one chat in the order bound, and nothing of another chat', () => {
    const fs = memoryChatFs()
    const store = memoryChatStore(fs)
    const transcript = recorded(store, store.createChat({ ...ORCHESTRATOR, runId: RUN_ID }))
    const other = store.createChat({ ...ORCHESTRATOR, runId: RUN_ID })
    const bindings = bindingsOver(fs)
    bindings.observeChat(transcript.chat, transcript.items)
    bindings.observeChat(other, [])

    const own = bindings.byChat(transcript.chat)

    expect(own.map((binding) => [binding.threadId, binding.kind, binding.role])).toEqual([
      [null, 'run', 'orchestrator'],
      [null, 'attempt', 'orchestrator'],
      [null, 'attempt', 'orchestrator'],
      [THREAD_A, 'attempt', 'worker'],
      [THREAD_B, 'attempt', 'worker']
    ])
    expect(own.every((binding) => binding.chatId === transcript.chat.id)).toBe(true)
    expect(bindings.byChat(other).map((binding) => binding.kind)).toEqual(['run'])
  })

  it('answer none for a chat that never acted, and after a restart from what was stored', () => {
    const fs = memoryChatFs()
    const store = memoryChatStore(fs)
    const transcript = recorded(store, store.createChat({ ...ORCHESTRATOR, runId: RUN_ID }))
    const quiet = store.createChat(ORCHESTRATOR)
    bindingsOver(fs).observeChat(transcript.chat, transcript.items)

    const restarted = bindingsOver(fs)

    expect(restarted.byChat(quiet)).toEqual([])
    expect(restarted.byChat(transcript.chat)).toHaveLength(5)
  })

  it('give copies, so a caller cannot change what is bound', () => {
    const { bindings, chat } = observed([call('mcp__darkmechanicus__takeover_run', { runId: RUN_ID })])

    const first = bindings.byChat(chat)
    first.splice(0, 1, ...first.map((binding) => ({ ...binding, role: 'worker' as const })))
    first.pop()

    expect(bindings.byChat(chat).map((binding) => binding.role)).toEqual(['orchestrator'])
  })
})
