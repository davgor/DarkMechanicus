import { describe, expect, it } from 'vitest'
import { CLAIM_TOKEN_MASK } from '../claimTokenMask'
import { ATTEMPT_ID, SECRET, cutInsideToken, leaksSecret, maskedThenCut } from '../__mocks__/claimTokenFixture'
import { describeApproval } from './codexApprovals'
import { clip, itemFor } from './codexItems'
import { CodexThreads } from './codexThreads'

const AT = '2026-10-03T12:00:00.000Z'
/** How much of the secret is left before a cut: too little for the mask to see it unless the text is masked first. */
const KEPT = [0, 5, 15]

const itemOf = (raw: unknown, phase: 'started' | 'completed' = 'completed') => itemFor(raw, phase, 't1', AT)

describe('Codex items: text that is cut is masked first', () => {
  it.each(KEPT)('masks a command cut at its token (%i characters before the cut)', (kept) => {
    const shown = itemOf({ type: 'commandExecution', id: 'c1', command: cutInsideToken(300, kept) }, 'started')

    expect(leaksSecret(shown)).toBe(false)
    expect(shown).toMatchObject({ input: { command: maskedThenCut(300, kept) } })
  })

  it.each(KEPT)('masks the output of a command cut at its token (%i characters before the cut)', (kept) => {
    const output = cutInsideToken(300, kept)

    const done = itemOf({ type: 'commandExecution', id: 'c1', command: 'make', status: 'completed', exitCode: 0, aggregatedOutput: output })

    expect(leaksSecret(done)).toBe(false)
    expect(done).toMatchObject({ resultSummary: `Exit code 0\n${maskedThenCut(300, kept)}` })
  })

  it.each(KEPT)('masks an argument that serializes past the limit with a token at the cut (%i characters before it)', (kept) => {
    const long = cutInsideToken(299, kept)

    const shown = itemOf({ type: 'mcpToolCall', id: 'm1', server: 's', tool: 't', arguments: { note: long, count: 1 } })

    expect(leaksSecret(shown)).toBe(false)
    expect(shown).toMatchObject({ input: { note: `"${maskedThenCut(299, kept)}`, count: 1 } })
  })

  it('masks arguments that are not an object, and an MCP result, that are cut at a token', () => {
    const text = cutInsideToken(300, 6)

    const bare = itemOf({ type: 'dynamicToolCall', id: 'd1', tool: 'lookup', arguments: text }, 'started')
    const result = itemOf({ type: 'mcpToolCall', id: 'm2', server: 's', tool: 't', status: 'completed', result: { content: [{ text }] } })

    expect(leaksSecret([bare, result])).toBe(false)
    expect(result).toMatchObject({ resultSummary: maskedThenCut(300, 6) })
  })

  it('masks a subagent prompt and what the subagents said, cut at a token', () => {
    const text = cutInsideToken(300, 8)
    const states = { thr_1: { status: 'completed', message: text } }

    const call = itemOf({ type: 'collabAgentToolCall', id: 'k1', tool: 'spawnAgent', status: 'completed', prompt: text, agentsStates: states })

    expect(leaksSecret(call)).toBe(false)
    expect(call).toMatchObject({ input: { prompt: maskedThenCut(300, 8) }, resultSummary: maskedThenCut(300, 8) })
  })

  it('masks a token already cut short at the end of a short text, and leaves text without tokens as it was', () => {
    expect(clip(`done ${ATTEMPT_ID}.${SECRET.slice(0, 3)}`, 300)).toBe(`done ${CLAIM_TOKEN_MASK}`)
    expect(clip('a'.repeat(301))).toBe(`${'a'.repeat(300)}…`)
    expect(clip('short', 300)).toBe('short')
  })
})

describe('Codex approvals and subagent labels: text that is cut is masked first', () => {
  it('masks the command of a command approval in its summary and in its input, each cut at its own limit', () => {
    const asked = (command: string) => describeApproval('item/commandExecution/requestApproval', { command, cwd: '/work' }, new Map())

    const summarized = asked(cutInsideToken(200, 4, 50))
    const stored = asked(cutInsideToken(300, 4))

    expect(leaksSecret([summarized, stored])).toBe(false)
    expect(summarized?.summary).toBe(`Run: ${maskedThenCut(200, 4, 50)}`)
    expect(stored?.input).toMatchObject({ command: maskedThenCut(300, 4), cwd: '/work' })
  })

  it('masks the message of a tool approval cut at a token', () => {
    const description = describeApproval('mcpServer/elicitation/request', { serverName: 'dm', message: cutInsideToken(200, 9) }, new Map())

    expect(leaksSecret(description)).toBe(false)
    expect(description?.summary).toBe(maskedThenCut(200, 9))
  })

  it.each(KEPT)('masks the first line of a subagent task used as its label (%i characters before the cut)', (kept) => {
    const threads = new CodexThreads(() => AT)
    const prompt = `${cutInsideToken(120, kept, 40)}\nsecond line`

    const events = threads.observe(
      { type: 'collabAgentToolCall', id: 's1', tool: 'spawnAgent', status: 'inProgress', prompt },
      { phase: 'started', turnId: 't1', inThread: undefined }
    )

    expect(leaksSecret(events)).toBe(false)
    expect(events).toContainEqual({
      type: 'item',
      item: expect.objectContaining({ kind: 'thread', label: maskedThenCut(120, kept, 40) })
    })
  })
})
