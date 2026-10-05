/**
 * How the Claude adapter ends a turn whose sign-in was rejected: one `auth_required` item, a clean
 * end of the turn, and no process left running. The first recording is a real signed-out turn (see
 * `__mocks__/claudeSignedOut.ts`); the others reuse its message shapes for the cases it cannot show
 * (a login that goes in the middle of a turn, the turn after the person signed in again).
 */
import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../../../shared/agents/chat'
import { CLAUDE_SIGNED_OUT, CLAUDE_SIGNED_OUT_MESSAGE, CLAUDE_SIGNED_OUT_SESSION } from './__mocks__/claudeSignedOut'
import {
  NOW,
  assistant,
  failure,
  init,
  message,
  replay,
  startRig,
  success,
  text,
  toolResult,
  toolUse,
  uuid,
  type Rig
} from './__mocks__/fakeClaudeSdk'

const authFailed = (content = CLAUDE_SIGNED_OUT_MESSAGE): ReturnType<typeof assistant> =>
  assistant('msg_auth', [text(content)], { error: 'authentication_failed', is_api_error_message: true })

const errorResult = (result: string): ReturnType<typeof success> =>
  message({ type: 'result', subtype: 'success', is_error: true, result, session_id: CLAUDE_SIGNED_OUT_SESSION, uuid: uuid() })

function authItems(rig: Rig): ChatItem[] {
  return rig.items().filter((item) => item.kind === 'auth_required')
}

describe('Claude adapter: a rejected sign-in (real recording)', () => {
  it('turns a recorded signed-out turn into one auth_required item and ends the turn without an error', async () => {
    const rig = await startRig({ plans: [replay(...CLAUDE_SIGNED_OUT)] })

    await expect(rig.adapter.send('hello')).resolves.toBeUndefined()

    expect(rig.items()).toEqual([
      { id: expect.stringMatching(/^claude_auth_/), at: NOW, kind: 'auth_required', agent: 'claude', message: CLAUDE_SIGNED_OUT_MESSAGE }
    ])
  })

  it('leaves no process running for the turn: the query is closed and the whole process tree is killed', async () => {
    const rig = await startRig({ plans: [replay(...CLAUDE_SIGNED_OUT)] })

    await rig.adapter.send('hello')

    expect(rig.sdk.launches[0]?.closed).toBe(true)
    expect(rig.processes.killed).toBeGreaterThan(0)
  })

  it('starts a fresh process for the next turn, resuming the same session, once the person signed in', async () => {
    const rig = await startRig({
      plans: [replay(...CLAUDE_SIGNED_OUT), { script: ({ emit }) => emit(init(), success('Back in.')) }]
    })
    await rig.adapter.send('hello')

    await rig.adapter.send('hello again')

    expect(rig.sdk.launches).toHaveLength(2)
    expect(rig.sdk.launches[1]?.options.resume).toBe(CLAUDE_SIGNED_OUT_SESSION)
    expect(authItems(rig)).toHaveLength(1)
  })

  it('does not also report the failed turn as assistant text or as an error', async () => {
    const rig = await startRig({ plans: [replay(...CLAUDE_SIGNED_OUT)] })

    await rig.adapter.send('hello')

    expect(rig.items().map((item) => item.kind)).toEqual(['auth_required'])
    expect(rig.events.some((event) => event.type === 'assistant_delta')).toBe(false)
  })
})

describe('Claude adapter: a rejected sign-in in the middle of a turn', () => {
  it('keeps what the turn did so far and adds one auth_required item for the failure', async () => {
    const rig = await startRig({
      plans: [
        replay(
          init(),
          assistant('msg_1', [text('Reading the file.')]),
          assistant('msg_1', [toolUse('toolu_1', 'Read', { file_path: '/work/repo/a.ts' })]),
          toolResult('toolu_1', 'contents'),
          authFailed('OAuth token has expired · Please run /login'),
          errorResult('OAuth token has expired · Please run /login')
        )
      ]
    })

    await expect(rig.adapter.send('go')).resolves.toBeUndefined()

    expect(rig.items().map((item) => item.kind)).toEqual(['assistant_text', 'tool_call', 'tool_call', 'auth_required'])
    expect(authItems(rig)).toEqual([expect.objectContaining({ message: 'OAuth token has expired · Please run /login' })])
    expect(rig.processes.killed).toBeGreaterThan(0)
  })

  it('reports one item even when the CLI says it twice before the result', async () => {
    const rig = await startRig({ plans: [replay(init(), authFailed(), authFailed(), errorResult(CLAUDE_SIGNED_OUT_MESSAGE))] })

    await rig.adapter.send('go')

    expect(authItems(rig)).toHaveLength(1)
  })

  it('names a failure the CLI gave no text for', async () => {
    const rig = await startRig({ plans: [replay(init(), assistant('msg_auth', [], { error: 'authentication_failed' }), errorResult(''))] })

    await rig.adapter.send('go')

    expect(authItems(rig)).toEqual([expect.objectContaining({ message: expect.stringContaining('sign in') })])
  })

  it('reports an authentication failure in a later turn of the same process too', async () => {
    const rig = await startRig({
      plans: [{ script: ({ emit, index }) => emit(init(), ...(index === 0 ? [success('fine')] : [authFailed(), errorResult(CLAUDE_SIGNED_OUT_MESSAGE)])) }]
    })
    await rig.adapter.send('one')

    await rig.adapter.send('two')

    expect(authItems(rig)).toHaveLength(1)
    expect(rig.sdk.launches[0]?.closed).toBe(true)
  })
})

describe('Claude adapter: failures that are not a rejected sign-in', () => {
  it('still reports a rate limit once, through the failed turn', async () => {
    const rig = await startRig({
      plans: [replay(init(), assistant('msg_e', [text('Rate limited')], { error: 'rate_limit' }), errorResult('Rate limited'))]
    })

    await expect(rig.adapter.send('hi')).rejects.toThrow('Rate limited')

    expect(rig.items()).toEqual([])
    expect(rig.processes.killed).toBe(0)
  })

  it('still rejects an error result that no authentication failure came before', async () => {
    const rig = await startRig({ plans: [replay(init(), failure('error_during_execution', ['boom']))] })

    await expect(rig.adapter.send('hi')).rejects.toThrow('boom')
    expect(authItems(rig)).toEqual([])
  })

  it('does not carry an authentication failure over into the next turn', async () => {
    const rig = await startRig({
      plans: [
        replay(init(), authFailed(), errorResult(CLAUDE_SIGNED_OUT_MESSAGE)),
        { script: ({ emit }) => emit(init(), failure('error_during_execution', ['boom'])) }
      ]
    })
    await rig.adapter.send('one')

    await expect(rig.adapter.send('two')).rejects.toThrow('boom')
  })
})
