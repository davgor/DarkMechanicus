// DM-273: host transcripts with sparse or unusual lines, and which host wrote a session file.
import { describe, expect, it } from 'vitest'
import { detectHost, readClaudeTranscript, readOmpTranscript } from './hostTranscripts'

const T0 = Date.parse('2026-11-15T09:00:00.000Z')
const iso = (min: number): string => new Date(T0 + min * 60_000).toISOString()
const jsonl = (lines: unknown[]): string => `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
const ATTEMPT = `at_${'0'.repeat(25)}a`
const RUN = `rn_${'0'.repeat(25)}a`
const USAGE = { input: 2, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 10 }
const SETTLE = 15 * 60_000

const omp = (lines: unknown[]) => readOmpTranscript({ name: 'main.jsonl', text: jsonl(lines) }, []).threads[0]
const claude = (lines: unknown[], asOf = T0 + 120 * 60_000) => readClaudeTranscript({ name: 'from-name.jsonl', text: jsonl(lines) }, [], { asOf, settleMs: SETTLE })

describe('DM-273: detectHost reads the first lines of a session file', () => {
  it.each([
    ['an OMP versioned session header', [{ type: 'session', version: 3, id: 's' }], 'omp'],
    ['a Claude Code line with uuid and session id', [{ type: 'user', uuid: 'u1', sessionId: 's' }], 'claude_code'],
    ['a session header without a version', [{ type: 'session', id: 's' }], null],
    ['a uuid without a session id', [{ type: 'user', uuid: 'u1' }], null],
    ['a Claude Code line after 20 foreign lines', [...Array.from({ length: 20 }, (_, n) => ({ n })), { uuid: 'u1', sessionId: 's' }], null]
  ])('%s', (_label, lines, host) => {
    expect(detectHost(jsonl(lines))).toBe(host)
  })

  it('an empty file names no host', () => {
    expect(detectHost('')).toBeNull()
  })
})

describe('DM-273: OMP lines with missing fields', () => {
  it('a session without a header starts at 0, and a custom message handing over a claim token binds it', () => {
    const thread = omp([{ type: 'custom_message', timestamp: iso(5), content: [{ type: 'text', text: `continue with ${ATTEMPT}.secretValue123` }] }])
    expect(thread?.startedAt).toBe(0)
    expect(thread?.claims).toEqual([{ at: T0 + 5 * 60_000, attemptId: ATTEMPT }])
  })

  it('a user message whose items carry content instead of text binds the claim; non-text content binds none', () => {
    const user = (content: unknown, m: number) => ({ type: 'message', timestamp: iso(m), message: { role: 'user', content } })
    const thread = omp([{ type: 'session', version: 3, id: 's', timestamp: iso(0) }, user(42, 1), user([{ type: 'text', content: `${ATTEMPT}.secretValue123` }], 2)])
    expect(thread?.claims).toEqual([{ at: T0 + 2 * 60_000, attemptId: ATTEMPT }])
  })

  it('an assistant message without completion time or content counts its usage at the line time', () => {
    const thread = omp([{ type: 'session', version: 3, id: 's', timestamp: iso(0) }, { type: 'message', id: 'e1', timestamp: iso(3), message: { role: 'assistant', model: 'm', usage: USAGE, content: 'plain text' } }])
    expect(thread?.usage.map((item) => [item.key, item.at, item.breakdown.total])).toEqual([['e1', T0 + 3 * 60_000, 10]])
    expect(thread?.activity).toEqual([])
  })

  it('a start_run call without arguments links the run its answer names; a tool start without its own time starts at the line; a wait is not activity', () => {
    const thread = omp([
      { type: 'session', version: 3, id: 's', timestamp: iso(0) },
      { type: 'message', id: 'e1', timestamp: iso(1), message: { role: 'assistant', usage: USAGE, content: [{ type: 'toolCall', id: 'c1', name: 'start_run' }] } },
      { type: 'custom', customType: 'tool_execution_start', timestamp: iso(2), data: { toolCallId: 'c1', toolName: 'start_run' } },
      { type: 'custom', customType: 'tool_execution_start', timestamp: iso(2), data: { toolCallId: 'c2', toolName: 'wait' } },
      { type: 'message', timestamp: iso(4), message: { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: `{"ok": true, "id": "${RUN}"}` }] } }
    ])
    expect(thread?.runLinks).toEqual([{ at: T0 + 4 * 60_000, runId: RUN }])
    expect(thread?.activity).toEqual([{ start: T0 + 2 * 60_000, end: T0 + 4 * 60_000 }])
  })
})

describe('DM-273: Claude Code lines with missing fields', () => {
  const line = (s: number, extra: Record<string, unknown>) => ({ uuid: `u${s}`, timestamp: new Date(T0 + s * 1000).toISOString(), ...extra })
  const usage = { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 9 }

  it('lines without a session id keep the file name; a sidechain without an agent id is one sidechain thread', () => {
    const transcript = claude([line(0, { type: 'user', isSidechain: true, message: { role: 'user', content: 'go' } })])
    expect(transcript.sessionId).toBe('from-name')
    expect(transcript.threads.map((thread) => [thread.name, thread.parent])).toEqual([['agent-sidechain', 'main']])
  })

  it('a message without an id is keyed by its line, and a call without input or a failed answer links nothing', () => {
    const transcript = claude([
      line(0, { type: 'user', sessionId: 's', message: { role: 'user', content: 'start' } }),
      line(2, { type: 'assistant', message: { role: 'assistant', usage, content: [{ type: 'tool_use', id: 't1', name: 'claim_ticket' }], stop_reason: 'tool_use' } }),
      line(4, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'note' }, { type: 'tool_result', tool_use_id: 'unknown', content: 'x' }, { type: 'tool_result', tool_use_id: 't1', is_error: true, content: RUN }] } }),
      line(6, { type: 'assistant', message: { id: 'm2', role: 'assistant', usage, content: 'done', stop_reason: 'end_turn' } })
    ])
    const [main] = transcript.threads
    expect(transcript.sessionId).toBe('s')
    expect(main?.usage.map((item) => item.key)).toEqual(['u2', 'm2'])
    expect(main?.runLinks).toEqual([])
  })

  it('a thread whose lines carry no time starts at 0 and reads nothing', () => {
    const [thread] = claude([{ type: 'assistant', uuid: 'u1', message: { id: 'm1', role: 'assistant', usage, content: [] } }], T0).threads
    expect(thread).toMatchObject({ name: 'main', startedAt: 0, usage: [], activity: [], pendingUsage: false })
  })
})
