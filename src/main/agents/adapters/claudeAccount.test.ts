/**
 * How the Claude adapter reports the states of the person's account that signing in cannot fix: one `error`
 * item that names the problem, a clean end of the turn, and the process left alone.
 *
 * The three error names come from the Agent SDK's own types (`SDKAssistantMessageError` in
 * @anthropic-ai/claude-agent-sdk 0.3.289: `oauth_org_not_allowed`, `account_on_hold`, `verification_required`),
 * which says an assistant message carries one as `error`. Only a signed-out turn could be recorded from a real
 * CLI (`__mocks__/claudeSignedOut.ts`), so these turns reuse its message shapes (a synthetic assistant message
 * with `error` set and the CLI's words as its text, then an error result) with the documented names. The
 * words are made up for the tests; the adapter must show whatever the CLI says.
 */
import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../../../shared/agents/chat'
import { CLAUDE_SIGNED_OUT_SESSION } from './__mocks__/claudeSignedOut'
import { NOW, assistant, failure, init, message, replay, startRig, success, text, toolResult, toolUse, uuid, type Rig } from './__mocks__/fakeClaudeSdk'

interface Case {
  /** What the SDK calls it. */
  sdkError: string
  /** What the transcript calls it. */
  problem: string
  words: string
}

const CASES: readonly Case[] = [
  { sdkError: 'oauth_org_not_allowed', problem: 'organization_not_allowed', words: 'Your organization has not allowed this application.' },
  { sdkError: 'account_on_hold', problem: 'account_on_hold', words: 'Your account is on hold. Contact support.' },
  { sdkError: 'verification_required', problem: 'verification_required', words: 'Verify your account to continue.' }
]

const turnWith = (sdkError: string, words: string): ReturnType<typeof assistant> =>
  assistant('msg_account', [text(words)], { error: sdkError, is_api_error_message: true })

const errorResult = (result: string): ReturnType<typeof success> =>
  message({ type: 'result', subtype: 'success', is_error: true, result, session_id: CLAUDE_SIGNED_OUT_SESSION, uuid: uuid() })

const errorItems = (rig: Rig): ChatItem[] => rig.items().filter((item) => item.kind === 'error')

describe.each(CASES)('Claude adapter: $sdkError', ({ sdkError, problem, words }) => {
  it('becomes one error item that names the problem and carries the CLI’s words, and ends the turn without a failure', async () => {
    const rig = await startRig({ plans: [replay(init(), turnWith(sdkError, words), errorResult(words))] })

    await expect(rig.adapter.send('hello')).resolves.toBeUndefined()

    expect(rig.items()).toEqual([{ id: expect.stringMatching(/^claude_account_/), at: NOW, kind: 'error', message: words, problem }])
    expect(rig.events.some((event) => event.type === 'assistant_delta')).toBe(false)
  })

  it('is no lost sign-in: no auth_required item, and the process is left running for the next turn', async () => {
    const rig = await startRig({
      plans: [{ script: ({ emit, index }) => emit(init(), ...(index === 0 ? [turnWith(sdkError, words), errorResult(words)] : [success('Back to work.')])) }]
    })
    await rig.adapter.send('one')

    await rig.adapter.send('two')

    expect(rig.items().some((item) => item.kind === 'auth_required')).toBe(false)
    expect(rig.sdk.launches).toHaveLength(1)
    expect(rig.sdk.launches[0]?.closed).toBe(false)
    expect(rig.processes.killed).toBe(0)
  })

  it('keeps what the turn did so far and reports the problem once, even when the CLI says it twice', async () => {
    const rig = await startRig({
      plans: [
        replay(
          init(),
          assistant('msg_1', [toolUse('toolu_1', 'Read', { file_path: '/work/repo/a.ts' })]),
          toolResult('toolu_1', 'contents'),
          turnWith(sdkError, words),
          turnWith(sdkError, words),
          errorResult(words)
        )
      ]
    })

    await expect(rig.adapter.send('go')).resolves.toBeUndefined()

    expect(rig.items().map((item) => item.kind)).toEqual(['tool_call', 'tool_call', 'error'])
    expect(errorItems(rig)).toEqual([expect.objectContaining({ message: words, problem })])
  })

})

describe.each(CASES)('Claude adapter: $sdkError, in other turns and places', ({ sdkError, problem, words }) => {
  it('says it in its own words when the CLI gave none', async () => {
    const rig = await startRig({ plans: [replay(init(), assistant('msg_account', [], { error: sdkError }), errorResult(''))] })

    await expect(rig.adapter.send('hello')).resolves.toBeUndefined()

    expect(errorItems(rig)).toEqual([expect.objectContaining({ problem, message: expect.stringContaining('Claude Code') })])
  })

  it('does not carry the problem over into the next turn: a failure there is a failure', async () => {
    const rig = await startRig({
      plans: [
        { script: ({ emit, index }) => emit(init(), ...(index === 0 ? [turnWith(sdkError, words), errorResult(words)] : [failure('error_during_execution', ['boom'])])) }
      ]
    })
    await rig.adapter.send('one')

    await expect(rig.adapter.send('two')).rejects.toThrow('boom')
  })

  it('leaves out a problem a subagent reports, as it does any error message in a thread', async () => {
    const rig = await startRig({
      plans: [replay(init(), assistant('msg_sub', [text(words)], { error: sdkError, parent_tool_use_id: 'toolu_agent' }), success('done'))]
    })

    await rig.adapter.send('go')

    expect(errorItems(rig)).toEqual([])
  })
})

describe('Claude adapter: errors that are not an account problem', () => {
  it('still reports a billing error once, through the failed turn', async () => {
    const rig = await startRig({ plans: [replay(init(), assistant('msg_e', [text('Credit balance is too low')], { error: 'billing_error' }), errorResult('Credit balance is too low'))] })

    await expect(rig.adapter.send('hi')).rejects.toThrow('Credit balance is too low')

    expect(rig.items()).toEqual([])
  })
})
