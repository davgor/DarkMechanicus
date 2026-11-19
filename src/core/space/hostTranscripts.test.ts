import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readClaudeTranscript, readOmpTranscript } from './hostTranscripts'

const fixture = (path: string): string => readFileSync(new URL(`./fixtures/usage/${path}`, import.meta.url), 'utf8')
const CLAUDE = '6f1c2a4e-9b3d-4c8a-a1e2-3f4b5c6d7e8f'
const CLAUDE_MAIN = { name: `${CLAUDE}.jsonl`, text: fixture(`claude/${CLAUDE}.jsonl`) }
const CLAUDE_SUB = { name: 'agent-a1b2c3.jsonl', text: fixture(`claude/${CLAUDE}/subagents/agent-a1b2c3.jsonl`) }
const CLAUDE_LAST_LINE = Date.parse('2026-11-15T11:06:42.000Z')
const SETTLE = 15 * 60_000

const T0 = Date.parse('2026-11-15T09:00:00.000Z')
const iso = (min: number): string => new Date(T0 + min * 60_000).toISOString()
const jsonl = (lines: unknown[]): string => `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
const RUN_A = `rn_${'0'.repeat(25)}a`
const RUN_B = `rn_${'0'.repeat(25)}b`
const ATTEMPT_A = `at_${'0'.repeat(25)}a`
const ATTEMPT_B = `at_${'0'.repeat(25)}b`

/** An OMP main session whose one bash call ran `command` and was answered with `answer`. */
function ompMain(command: string, answer: string, isError = false): string {
  return jsonl([
    { type: 'session', version: 3, id: 'sess-1', timestamp: iso(0) },
    { type: 'message', id: 'e1', timestamp: iso(1), message: { role: 'assistant', model: 'm', usage: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 10 }, timestamp: T0 + 50_000, completedAt: T0 + 60_000, content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command } }] } },
    { type: 'message', id: 'e2', timestamp: iso(2), message: { role: 'toolResult', toolCallId: 'c1', isError, content: [{ type: 'text', text: answer }] } }
  ])
}

function mainLinks(command: string, answer: string, isError = false): string[] {
  const transcript = readOmpTranscript({ name: 'main.jsonl', text: ompMain(command, answer, isError) }, [])
  return transcript.threads[0]?.runLinks.map((link) => link.runId) ?? []
}

describe('DM-173 c2: session links drawn from the transcript', () => {
  it('a start_run answer citing another run id links only the run it started', () => {
    const answer = JSON.stringify({ ok: true, data: { id: RUN_A, tickets: [{ body: `continues the work of ${RUN_B}` }] } })
    expect(mainLinks(`dm call start_run '{"epicId":"ep"}'`, answer)).toEqual([RUN_A])
  })

  it('a claim_ticket answer citing another run id links only the run its arguments name', () => {
    const answer = JSON.stringify({ ok: true, data: { ticket: { body: `see run ${RUN_B}` } } })
    expect(mainLinks(`dm call claim_ticket '{"runId":"${RUN_A}"}'`, answer)).toEqual([RUN_A])
  })

  it('a refused run call links nothing', () => {
    expect(mainLinks(`dm call claim_ticket '{"runId":"${RUN_A}"}'`, '{"ok": false, "error": {"code": "conflict"}}')).toEqual([])
    expect(mainLinks(`dm call claim_ticket '{"runId":"${RUN_A}"}'`, '{"ok": true}', true)).toEqual([])
  })

  it('a spawn prompt with one claim token binds its attempt, never keeping the secret; one naming two attempts binds none', () => {
    const sub = (task: string) =>
      readOmpTranscript({ name: 'main.jsonl', text: ompMain('ls', 'ok') }, [
        { name: 'W.jsonl', text: jsonl([{ type: 'session', version: 3, id: 'sess-2', timestamp: iso(3), parentSession: 'C:\\x\\main.jsonl' }, { type: 'session_init', id: 'i', timestamp: iso(3), task }]) }
      ]).threads[1]
    const one = sub(`claimToken ${ATTEMPT_A}.secretValue123`)
    expect(one?.claims).toEqual([{ at: T0 + 3 * 60_000, attemptId: ATTEMPT_A }])
    expect(JSON.stringify(one)).not.toContain('secretValue123')
    expect(sub(`${ATTEMPT_A}.secretValue123 and ${ATTEMPT_B}.otherSecret456`)?.claims).toEqual([])
  })
})

describe('DM-173 c1: Claude Code recorded fixture', () => {
  it('a message streamed as several lines counts once (3 + 2048 + 12000 + 410 = 14461)', () => {
    const main = readClaudeTranscript(CLAUDE_MAIN, [CLAUDE_SUB], { asOf: CLAUDE_LAST_LINE + 60_000, settleMs: SETTLE }).threads.find((thread) => thread.name === 'main')
    expect(main?.usage[0]?.breakdown.total).toBe(14_461)
    expect(main?.usage.map((item) => item.breakdown.total)).toEqual([14_461, 14_573, 14_445])
  })

  it('the last message still being written waits (pending, 3 samples) until the thread settles (4 samples)', () => {
    const early = readClaudeTranscript(CLAUDE_MAIN, [CLAUDE_SUB], { asOf: CLAUDE_LAST_LINE + 60_000, settleMs: SETTLE }).threads.find((thread) => thread.name === 'main')
    const late = readClaudeTranscript(CLAUDE_MAIN, [CLAUDE_SUB], { asOf: CLAUDE_LAST_LINE + SETTLE, settleMs: SETTLE }).threads.find((thread) => thread.name === 'main')
    expect(early?.pendingUsage).toBe(true)
    expect(early?.usage).toHaveLength(3)
    expect(late?.pendingUsage).toBe(false)
    expect(late?.usage.map((item) => item.breakdown.total)).toEqual([14_461, 14_573, 14_445, 14_457])
  })

  it('the sidechain is its own child thread of main, holding the spawn claim', () => {
    const sub = readClaudeTranscript(CLAUDE_MAIN, [CLAUDE_SUB], { asOf: CLAUDE_LAST_LINE + SETTLE, settleMs: SETTLE }).threads.find((thread) => thread.name === 'agent-a1b2c3')
    expect(sub?.parent).toBe('main')
    expect(sub?.usage.map((item) => item.breakdown.total)).toEqual([5904, 7602])
    expect(new Set(sub?.claims.map((item) => item.attemptId))).toEqual(new Set([`at_${'0'.repeat(25)}a`]))
  })

  it('a tool running past the settle time keeps its span open until its result', () => {
    const line = (s: number, extra: Record<string, unknown>) => ({ sessionId: 's', uuid: `u${s}`, timestamp: new Date(T0 + s * 1000).toISOString(), isSidechain: false, ...extra })
    const lines = [
      line(0, { type: 'user', message: { role: 'user', content: 'Run the tests.' } }),
      line(2, { type: 'assistant', message: { id: 'm1', role: 'assistant', usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 9 }, content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }], stop_reason: 'tool_use' } })
    ]
    const during = readClaudeTranscript({ name: 's.jsonl', text: jsonl(lines) }, [], { asOf: T0 + 40 * 60_000, settleMs: SETTLE }).threads[0]
    expect(during?.activity).toContainEqual({ start: T0 + 2000, end: null })
    const done = line(45 * 60, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } })
    const after = readClaudeTranscript({ name: 's.jsonl', text: jsonl([...lines, done]) }, [], { asOf: T0 + 90 * 60_000, settleMs: SETTLE }).threads[0]
    expect(after?.activity.some((interval) => interval.end === null)).toBe(false)
    expect(after?.activity).toContainEqual({ start: T0 + 2000, end: T0 + 45 * 60_000 })
  })
})
