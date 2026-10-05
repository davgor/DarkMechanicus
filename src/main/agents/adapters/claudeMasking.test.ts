import { describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '../../../shared/agents/chat'
import { CLAIM_TOKEN_MASK } from '../claimTokenMask'
import { ATTEMPT_ID, SECRET, TOKEN, cutInsideToken, leaksSecret, maskedThenCut } from '../__mocks__/claimTokenFixture'
import { assistant, init, pendingApproval, replay, startRig, success, toolResult, toolUse } from './__mocks__/fakeClaudeSdk'

type ToolCall = Extract<ChatItem, { kind: 'tool_call' }>
type Thread = Extract<ChatItem, { kind: 'thread' }>

/** How much of the secret is left before a cut: too little for the mask to see it unless the text is masked first. */
const KEPT = [0, 5, 15]

const callsOf = (items: ChatItem[]): ToolCall[] => items.filter((item): item is ToolCall => item.kind === 'tool_call')

describe('the fixture token', () => {
  it('has the shape of a real claim token', () => {
    expect(ATTEMPT_ID).toMatch(/^at_[0-9a-hjkmnp-tv-z]{26}$/)
    expect(SECRET).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(leaksSecret(`before ${TOKEN}`)).toBe(true)
    expect(leaksSecret(cutInsideToken(1000, 5).slice(0, 1000))).toBe(true)
    expect(leaksSecret('no secret here')).toBe(false)
  })
})

describe('Claude adapter: tool text that is cut is masked first', () => {
  it.each(KEPT)('stores no part of a secret a long tool input is cut inside of (%i characters before the cut)', async (kept) => {
    const prompt = cutInsideToken(1000, kept)
    const rig = await startRig({ plans: [replay(init(), assistant('msg_1', [toolUse('toolu_p', 'Write', { file_path: 'a.txt', content: prompt })]), success('ok'))] })

    await rig.adapter.send('go')

    const [call] = callsOf(rig.items())
    expect(leaksSecret(rig.items())).toBe(false)
    expect(call?.input.content).toBe(maskedThenCut(1000, kept))
  })

  it.each(KEPT)('stores no part of a secret a long tool result is cut inside of (%i characters before the cut)', async (kept) => {
    const result = cutInsideToken(500, kept)
    const rig = await startRig({
      plans: [replay(init(), assistant('msg_2', [toolUse('toolu_r', 'Bash', { command: 'cat note' })]), toolResult('toolu_r', result), success('ok'))]
    })

    await rig.adapter.send('go')

    const done = callsOf(rig.items()).at(-1)
    expect(leaksSecret(rig.items())).toBe(false)
    expect(done?.resultSummary).toBe(maskedThenCut(500, kept))
  })

  it('masks a result sent as content blocks, and a token already cut short at the end of a short result', async () => {
    const rig = await startRig({
      plans: [
        replay(
          init(),
          assistant('msg_3', [toolUse('toolu_a', 'Bash', { command: 'one' }), toolUse('toolu_b', 'Bash', { command: 'two' })]),
          toolResult('toolu_a', [{ type: 'text', text: cutInsideToken(500, 3) }]),
          toolResult('toolu_b', `claimed ${ATTEMPT_ID}.${SECRET.slice(0, 4)}`),
          success('ok')
        )
      ]
    })

    await rig.adapter.send('go')

    const results = callsOf(rig.items()).flatMap((call) => (call.status === 'running' ? [] : [call.resultSummary]))
    expect(leaksSecret(rig.items())).toBe(false)
    expect(results[1]).toBe(`claimed ${CLAIM_TOKEN_MASK}`)
  })

})

describe('Claude adapter: subagent, approval and failure text that is cut is masked first', () => {
  it('masks a long Agent spawn prompt and a subagent label that are cut at a token', async () => {
    const spawn = toolUse('toolu_s', 'Agent', { description: cutInsideToken(120, 5, 40), prompt: cutInsideToken(1000, 7), subagent_type: 'worker' })
    const rig = await startRig({ plans: [replay(init(), assistant('msg_4', [spawn]), success('ok'))] })

    await rig.adapter.send('go')

    const thread = rig.items().find((item): item is Thread => item.kind === 'thread')
    expect(leaksSecret(rig.items())).toBe(false)
    expect(thread?.label).toBe(maskedThenCut(120, 5, 40))
    expect(callsOf(rig.items())[0]?.input).toMatchObject({ prompt: maskedThenCut(1000, 7) })
  })

  it('leaves a long input without tokens cut as before', async () => {
    const long = 'z'.repeat(5000)
    const rig = await startRig({ plans: [replay(init(), assistant('msg_5', [toolUse('toolu_l', 'Write', { file_path: 'a.txt', content: long })]), success('ok'))] })

    await rig.adapter.send('go')

    expect(callsOf(rig.items())[0]?.input.content).toBe(`${'z'.repeat(1000)}…`)
  })
  it('masks the command of an approval request that is cut at a token', async () => {
    const command = cutInsideToken(200, 4, 50)
    const rig = await startRig({ plans: [{ script: ({ ask }) => void ask('Bash', { command }) }] })

    void rig.adapter.send('go')
    const { request } = await pendingApproval(rig)

    expect(leaksSecret(request.summary)).toBe(false)
    expect(request.summary).toBe(`Run ${maskedThenCut(200, 4, 50)}`)
  })

  it('masks a token in the stderr that explains a failure, before that is cut to the last lines', async () => {
    const stderr = `${'x'.repeat(300)}${TOKEN}${'y'.repeat(590)}`
    const rig = await startRig({ plans: [{ script: ({ emit }) => emit(init()) }], stderr })
    const turn = rig.adapter.send('hi')
    await vi.waitFor(() => expect(rig.events).toHaveLength(1))

    rig.sdk.launches[0]?.finish(new Error('Claude Code process exited with code 1'))

    const failure = await turn.catch((error: unknown) => (error as Error).message)
    expect(leaksSecret(failure)).toBe(false)
    expect(failure).toContain('exited with code 1')
  })
})
