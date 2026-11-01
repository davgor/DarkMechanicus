/**
 * `agents:signIn`: the sign-in terminal, through the same guarded-attach model as a chat's. The sender guard answers
 * the app page's top frame only; the payload is an agent id and nothing else; main reads the agent from its own
 * registry and starts the registered executable with the CLI's `LOGIN_ARGS` in the home folder, with no grant. The
 * frame gets one end of a port that takes only input and sizes; closing it (Back) stops the sign-in.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TERMINAL_ATTACH_CHANNEL, TERMINAL_PORT_CHANNEL, TERMINAL_SIGN_IN_CHANNEL } from '../../shared/agents/terminalApi'
import { handlersRig, PAGE, signInRunning, type HandlersRig } from './__mocks__/terminalHandlersRig'
import { closedFlag, FakeFrame, received } from './__mocks__/terminalPorts'
import { CUSTOM_AGENT, eventually } from './__mocks__/terminalSessionsRig'

const REFUSED_SENDER = {
  ok: false,
  error: { code: 'unauthorized', message: 'Refused an IPC call that did not come from the Dark Mechanicus window.' }
}

let h: HandlersRig

beforeEach(() => {
  h = handlersRig()
})

afterEach(() => {
  h.cleanup()
})

describe('agents:signIn: the sender and the payload', () => {
  it('is registered beside terminals:attach, through the sender guard', () => {
    expect(h.ipc.channels()).toEqual([TERMINAL_SIGN_IN_CHANNEL, TERMINAL_ATTACH_CHANNEL].sort())
    expect(TERMINAL_SIGN_IN_CHANNEL).toBe('agents:signIn')
  })

  it('refuses a sender other than the app page in the top-level frame, and starts nothing', async () => {
    const foreign = new FakeFrame('https://evil.example/')
    const subframe = new FakeFrame(PAGE, new FakeFrame(PAGE))

    const answers = [await h.signIn('claude', foreign), await h.signIn('claude', subframe), await h.signIn('claude', null)]

    expect(answers).toEqual([REFUSED_SENDER, REFUSED_SENDER, REFUSED_SENDER])
    expect(await h.handlers.signIn(null, 'claude')).toEqual({ ok: false, error: { code: 'unauthorized', message: 'Refused a sign-in that came from no window.' } })
    expect(h.rig.host.spawns).toEqual([])
  })

  it('takes the agent id only: a program, arguments, a folder, an environment or a credential is refused before anything runs', async () => {
    const payloads = [
      { id: 'claude' },
      { kind: 'claude', executablePath: '/bin/sh' },
      { kind: 'claude', args: ['-c', 'touch /tmp/owned'] },
      { kind: 'claude', cwd: '/' },
      { kind: 'claude', apiKey: 'sk-ant-secret' },
      '/bin/sh',
      ['claude'],
      null,
      undefined
    ]

    const answers = await Promise.all(payloads.map((payload) => h.signIn(payload)))

    expect(answers.map((answer) => (answer.ok ? 'accepted' : answer.error.code))).toEqual(payloads.map(() => 'invalid_input'))
    expect(JSON.stringify(answers)).not.toContain('sk-ant-secret')
    expect([h.rig.host.spawns, h.frame.posted]).toEqual([[], []])
  })

  it('refuses an agent that is not connected, and a custom CLI, without starting anything', async () => {
    const missing = await h.signIn('codex')
    const custom = await h.signIn(CUSTOM_AGENT.id)

    expect(missing).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect(custom).toMatchObject({ ok: false, error: { code: 'invalid_input', message: expect.stringContaining('custom CLI') } })
    expect(h.rig.host.spawns).toEqual([])
  })
})

describe('agents:signIn: what runs', () => {
  it("starts the registered executable with the CLI's login command in the home folder, with no grant, and posts a port", async () => {
    const { answer } = await signInRunning(h, 'claude')

    const pty = h.rig.host.last()
    expect(answer).toEqual({ state: 'running', snapshot: '', port: 'port-1' })
    expect([pty.spec.file, pty.spec.args, pty.spec.cwd]).toEqual(['/bin/claude', ['auth', 'login'], h.rig.root])
    expect(pty.spec.env['DM_SESSION_TOKEN']).toBeUndefined()
    expect(h.rig.grantsAsked).toBe(0)
    expect(h.frame.posted.map((posted) => posted.channel)).toEqual([TERMINAL_PORT_CHANNEL])
  })

  it('carries input and output on the port, then the exit, and closes it', async () => {
    const { port } = await signInRunning(h, 'autonomous')
    const heard = received(port)
    const closed = closedFlag(port)
    const pty = h.rig.host.last()

    port.postMessage({ type: 'input', data: '1\r' })
    port.postMessage({ type: 'run', file: '/bin/sh' })
    await eventually(() => pty.written.length > 0, 'the input to arrive')
    pty.emitData('Signed in.\r\n')
    pty.exit({ exitCode: 0, signal: null })
    await eventually(() => closed.closed, 'the port to close')

    expect(pty.written).toEqual(['1\r'])
    expect(heard).toEqual([
      { type: 'output', data: 'Signed in.\r\n' },
      { type: 'exit', exitCode: 0, signal: null, message: null, resumed: false }
    ])
  })

  it('carries the size the pane sends on the port to the sign-in, clamped as a chat terminal’s is', async () => {
    const { port } = await signInRunning(h, 'claude')
    const pty = h.rig.host.last()

    port.postMessage({ type: 'resize', cols: 120, rows: 40 })
    port.postMessage({ type: 'resize', cols: 9_999, rows: 1 })
    await eventually(() => pty.sizes.length === 2, 'both sizes to arrive')

    expect(pty.sizes).toEqual([
      [120, 40],
      [500, 5]
    ])
  })

  it('stops the sign-in when its frame closes the port (Back)', async () => {
    const { port } = await signInRunning(h, 'claude')
    const pty = h.rig.host.last()

    port.close()
    await eventually(() => pty.kills > 0, 'the sign-in to be stopped')

    expect(pty.kills).toBe(1)
  })
})
