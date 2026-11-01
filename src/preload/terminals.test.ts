/**
 * `window.dm.terminals`: one `terminals:attach` or `agents:signIn` invoke, and, for a running terminal, a handle built
 * from the port main posted for that request (claimed by the id its answer names, whichever arrives first). Last, the
 * whole path: the preload over main's real handlers, session manager, sign-in terminals and ports.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  TERMINAL_ATTACH_CHANNEL,
  TERMINAL_PORT_CHANNEL,
  TERMINAL_SIGN_IN_CHANNEL,
  type TerminalAttachment,
  type TerminalAttachRequest,
  type TerminalAttachWire,
  type TerminalExit,
  type TerminalHandle,
  type TerminalsApi
} from '../shared/agents/terminalApi'
import type { CommandResult } from '../shared/desktop/api'
import { handlersRig, type HandlersRig } from '../main/terminals/__mocks__/terminalHandlersRig'
import { CUSTOM_AGENT, eventually, settle } from '../main/terminals/__mocks__/terminalSessionsRig'
import { createTerminalsApi, type RendererPort, type TerminalIpc } from './terminals'

type PortListener = Parameters<TerminalIpc['on']>[1]

/** `ipcRenderer` for the terminals: answers each invoke with what the test gives it, and lets the test post ports. */
class FakeIpc implements TerminalIpc {
  readonly requests: [string, TerminalAttachRequest | string][] = []
  private readonly pending: { resolve: (answer: CommandResult<TerminalAttachWire>) => void; reject: (error: Error) => void }[] = []
  private portListener: PortListener | null = null

  invoke(channel: string, request: TerminalAttachRequest | string): Promise<CommandResult<TerminalAttachWire>> {
    this.requests.push([channel, request])
    // Promise.withResolvers is outside the TypeScript lib this repo targets.
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }))
  }

  on(channel: string, listener: PortListener): void {
    expect(channel).toBe(TERMINAL_PORT_CHANNEL)
    this.portListener = listener
  }

  /** Answers the oldest invoke still waiting. */
  answer(answer: CommandResult<TerminalAttachWire>): void {
    this.pending.shift()?.resolve(answer)
  }

  /** Fails the oldest invoke still waiting, as an IPC failure does. */
  fail(error: Error): void {
    this.pending.shift()?.reject(error)
  }

  /** Main posting `ports` with `grant`, as `senderFrame.postMessage` does. */
  post(grant: unknown, ports: RendererPort[]): void {
    this.portListener?.({ ports }, grant)
  }
}

const channels: MessageChannel[] = []

/** A port pair like the one main makes: `main` stays in main, `renderer` is posted. */
function pair(): { main: MessagePort; renderer: MessagePort } {
  const channel = new MessageChannel()
  channels.push(channel)
  return { main: channel.port1, renderer: channel.port2 }
}

/** Everything that arrives on `port`. */
function heardOn(port: MessagePort): unknown[] {
  const messages: unknown[] = []
  port.addEventListener('message', (event) => messages.push(event.data))
  port.start()
  return messages
}

afterEach(() => {
  for (const channel of channels.splice(0)) {
    channel.port1.close()
    channel.port2.close()
  }
})

/** Whether `port`'s other end has been closed. */
function closedOn(port: MessagePort): { closed: boolean } {
  const flag = { closed: false }
  port.addEventListener('close', () => {
    flag.closed = true
  })
  port.start()
  return flag
}

const RUNNING: CommandResult<TerminalAttachWire> = { ok: true, data: { state: 'running', snapshot: '$ ', port: 'port-1' } }

describe('window.dm.terminals.attach', () => {
  it('invokes terminals:attach with the folder and the chat id, and nothing else', async () => {
    const ipc = new FakeIpc()
    const attaching = createTerminalsApi(ipc).attach('/repos/demo', 'chat_1')
    ipc.answer({ ok: true, data: { state: 'refused', message: 'No.' } })
    await attaching

    expect(ipc.requests).toEqual([[TERMINAL_ATTACH_CHANNEL, { folder: '/repos/demo', chatId: 'chat_1' }]])
  })

  it('asks for a new session only when the pane does, and sends no key otherwise', async () => {
    const ipc = new FakeIpc()
    const api = createTerminalsApi(ipc)
    const refused: CommandResult<TerminalAttachWire> = { ok: true, data: { state: 'refused', message: 'No.' } }
    const attaching = [api.attach('/repos/demo', 'chat_1', { newSession: true }), api.attach('/repos/demo', 'chat_1', { newSession: false }), api.attach('/repos/demo', 'chat_1')]
    ipc.answer(refused)
    ipc.answer(refused)
    ipc.answer(refused)
    await Promise.all(attaching)

    expect(ipc.requests.map(([, request]) => request)).toEqual([
      { folder: '/repos/demo', chatId: 'chat_1', newSession: true },
      { folder: '/repos/demo', chatId: 'chat_1' },
      { folder: '/repos/demo', chatId: 'chat_1' }
    ])
    expect(ipc.requests.slice(1).map(([, request]) => Object.keys(request))).toEqual([
      ['folder', 'chatId'],
      ['folder', 'chatId']
    ])
  })
})

describe('window.dm.terminals.signIn', () => {
  it('invokes agents:signIn with the agent id and nothing else, and builds the terminal from the port main posted', async () => {
    const ipc = new FakeIpc()
    const { main, renderer } = pair()
    const signingIn = createTerminalsApi(ipc).signIn('claude')
    ipc.post({ port: 'port-1' }, [renderer])
    ipc.answer(RUNNING)
    const answer = await signingIn

    expect(ipc.requests).toEqual([[TERMINAL_SIGN_IN_CHANNEL, 'claude']])
    const heard = heardOn(main)
    terminalOf(answer).write('code-123\r')
    await eventually(() => heard.length > 0, 'the input to arrive')
    expect(heard).toEqual([{ type: 'input', data: 'code-123\r' }])
  })

  it('passes a refusal on as it is', async () => {
    const ipc = new FakeIpc()
    const refusal: CommandResult<TerminalAttachWire> = { ok: false, error: { code: 'invalid_input', message: 'My CLI is a custom CLI.' } }

    const signingIn = createTerminalsApi(ipc).signIn('cu_01m65kwqqeyajbj5bnq81gngrb')
    ipc.answer(refusal)

    expect(await signingIn).toEqual(refusal)
  })
})

describe('window.dm.terminals.attach: answers', () => {
  it('passes a refusal on as it is', async () => {
    const ipc = new FakeIpc()
    const refusal: CommandResult<TerminalAttachWire> = { ok: false, error: { code: 'not_found', message: 'No chat chat_1 in /repos/demo.' } }

    const attaching = createTerminalsApi(ipc).attach('/repos/demo', 'chat_1')
    ipc.answer(refusal)

    expect(await attaching).toEqual(refusal)
  })

  it('answers a terminal that is not running with its state and message, and no handle', async () => {
    const ipc = new FakeIpc()

    const attaching = createTerminalsApi(ipc).attach('/repos/demo', 'chat_1')
    ipc.answer({ ok: true, data: { state: 'signed_out', message: 'Claude Code is not signed in.' } })

    expect(await attaching).toEqual({ ok: true, data: { state: 'signed_out', message: 'Claude Code is not signed in.', terminal: null } })
  })

  it('answers a running terminal with its snapshot and a handle, the port id kept out of the answer', async () => {
    const ipc = new FakeIpc()
    const { renderer } = pair()

    const attaching = createTerminalsApi(ipc).attach('/repos/demo', 'chat_1')
    ipc.post({ port: 'port-1' }, [renderer])
    ipc.answer(RUNNING)
    const answer = await attaching

    expect(answer).toEqual({ ok: true, data: { state: 'running', snapshot: '$ ', terminal: expect.any(Object) } })
    expect(answer.ok ? Object.keys(answer.data.terminal ?? {}).sort() : []).toEqual(['close', 'onExit', 'onOutput', 'resize', 'write'])
  })

})

describe('window.dm.terminals.attach: claiming the port', () => {
  it('waits for a port that arrives after the answer', async () => {
    const ipc = new FakeIpc()
    const { main, renderer } = pair()
    const heard = heardOn(main)

    const attaching = createTerminalsApi(ipc).attach('/repos/demo', 'chat_1')
    ipc.answer(RUNNING)
    await Promise.resolve()
    ipc.post({ port: 'port-1' }, [renderer])
    terminalOf(await attaching).write('ls\r')
    await eventually(() => heard.length > 0, 'the input to arrive')

    expect(heard).toEqual([{ type: 'input', data: 'ls\r' }])
  })

  it('gives each of two attaches the port posted for it, by id, whatever order they arrive in', async () => {
    const ipc = new FakeIpc()
    const api = createTerminalsApi(ipc)
    const first = pair()
    const second = pair()
    const heard = [heardOn(first.main), heardOn(second.main)]

    const attaches = [api.attach('/repos/demo', 'chat_1'), api.attach('/repos/demo', 'chat_2')]
    ipc.post({ port: 'port-2' }, [second.renderer])
    ipc.post({ port: 'port-1' }, [first.renderer])
    ipc.answer(RUNNING)
    ipc.answer({ ok: true, data: { state: 'running', snapshot: '', port: 'port-2' } })
    const [one, two] = await Promise.all(attaches)
    terminalOf(one).write('to one')
    terminalOf(two).write('to two')
    await eventually(() => heard.every((messages) => messages.length > 0), 'the input to arrive')

    expect(heard).toEqual([[{ type: 'input', data: 'to one' }], [{ type: 'input', data: 'to two' }]])
  })

})

describe('window.dm.terminals.attach: claiming the port by id', () => {
  it('gives each of two answered attaches the port posted for it, by id, when the ports come last and out of order', async () => {
    const ipc = new FakeIpc()
    const api = createTerminalsApi(ipc)
    const first = pair()
    const second = pair()
    const heard = [heardOn(first.main), heardOn(second.main)]

    const attaches = [api.attach('/repos/demo', 'chat_1'), api.attach('/repos/demo', 'chat_2')]
    ipc.answer(RUNNING)
    ipc.answer({ ok: true, data: { state: 'running', snapshot: '', port: 'port-2' } })
    await Promise.resolve()
    ipc.post({ port: 'port-2' }, [second.renderer])
    ipc.post({ port: 'port-1' }, [first.renderer])
    const [one, two] = await Promise.all(attaches)
    terminalOf(one).write('to one')
    terminalOf(two).write('to two')
    await eventually(() => heard.every((messages) => messages.length > 0), 'the input to arrive')

    expect(heard).toEqual([[{ type: 'input', data: 'to one' }], [{ type: 'input', data: 'to two' }]])
  })

  it('takes no port from a post without a port id, closing it, and still claims its own', async () => {
    const ipc = new FakeIpc()
    const numbered = pair()
    const unnamed = pair()
    const closed = [closedOn(numbered.main), closedOn(unnamed.main)]
    const own = pair()
    const heard = heardOn(own.main)

    const attaching = createTerminalsApi(ipc).attach('/repos/demo', 'chat_1')
    ipc.post({ port: 'port-1' }, [])
    ipc.post({ port: 7 }, [numbered.renderer])
    ipc.post(null, [unnamed.renderer])
    ipc.answer(RUNNING)
    ipc.post({ port: 'port-1' }, [own.renderer])
    terminalOf(await attaching).write('mine')
    await eventually(() => heard.length > 0 && closed.every((flag) => flag.closed), 'the input and both closes')

    expect(heard).toEqual([{ type: 'input', data: 'mine' }])
  })
})

describe('window.dm.terminals.attach: ports nothing claims', () => {
  it('closes a port that arrives while no attach of this page is waiting, so main stops sending to it', async () => {
    const ipc = new FakeIpc()
    createTerminalsApi(ipc)
    const stray = pair()
    const closed = closedOn(stray.main)

    // A port posted after a long attach to the page this frame showed before a reload.
    ipc.post({ port: 'port-9' }, [stray.renderer])
    await eventually(() => closed.closed, 'the stray port to close')

    expect(closed.closed).toBe(true)
  })

  it('closes a port no attach claimed once every waiting attach has its answer', async () => {
    const ipc = new FakeIpc()
    const api = createTerminalsApi(ipc)
    const stray = pair()
    const closed = closedOn(stray.main)

    const attaching = api.attach('/repos/demo', 'chat_1')
    ipc.post({ port: 'port-9' }, [stray.renderer])
    // A close in flight has time to arrive: there is no event for a port staying open.
    await settle()
    const stillOpen = closed.closed
    ipc.answer({ ok: true, data: { state: 'refused', message: 'No.' } })
    await attaching
    await eventually(() => closed.closed, 'the stray port to close')

    expect([stillOpen, closed.closed]).toEqual([false, true])
  })

  it('passes on an attach that failed in IPC, closing what it left unclaimed', async () => {
    const ipc = new FakeIpc()
    const api = createTerminalsApi(ipc)
    const stray = pair()
    const closed = closedOn(stray.main)

    const attaching = api.attach('/repos/demo', 'chat_1')
    ipc.post({ port: 'port-9' }, [stray.renderer])
    ipc.fail(new Error('Error invoking remote method'))

    await expect(attaching).rejects.toThrow('Error invoking remote method')
    await eventually(() => closed.closed, 'the stray port to close')
  })
})

/** The handle of a running attach; throws for any other answer. */
function terminalOf(answer: CommandResult<TerminalAttachment>): TerminalHandle {
  const terminal = answer.ok ? answer.data.terminal : null
  if (terminal === null) {
    throw new Error('The attach did not run.')
  }
  return terminal
}

/** A running attach's handle, over a fresh port pair; `main` is main's end. */
async function runningHandle(): Promise<{ main: MessagePort; terminal: TerminalHandle }> {
  const ipc = new FakeIpc()
  const { main, renderer } = pair()
  const attaching = createTerminalsApi(ipc).attach('/repos/demo', 'chat_1')
  ipc.post({ port: 'port-1' }, [renderer])
  ipc.answer(RUNNING)
  return { main, terminal: terminalOf(await attaching) }
}

describe('the terminal handle', () => {
  it('writes input and sizes as the two messages main accepts', async () => {
    const { main, terminal } = await runningHandle()
    const heard = heardOn(main)

    terminal.write('ls\r')
    terminal.resize(120, 40)
    await eventually(() => heard.length === 2, 'both messages to arrive')

    expect(heard).toEqual([
      { type: 'input', data: 'ls\r' },
      { type: 'resize', cols: 120, rows: 40 }
    ])
  })

  it('tells output and the exit to their listeners, output sent before the first listener included, until unsubscribed', async () => {
    const { main, terminal } = await runningHandle()
    main.postMessage({ type: 'output', data: 'before\r\n' })
    const output: string[] = []
    const exits: TerminalExit[] = []
    const later: string[] = []

    const stop = terminal.onOutput((data) => output.push(data))
    terminal.onExit((exit) => exits.push(exit))
    const stopLater = terminal.onOutput((data) => later.push(data))
    stopLater()
    main.postMessage({ type: 'output', data: 'after\r\n' })
    await eventually(() => output.length === 2, 'the output to arrive')
    stop()
    main.postMessage({ type: 'output', data: 'unheard\r\n' })
    main.postMessage({ type: 'exit', exitCode: 0, signal: null, message: 'The app is quitting, so the terminal was stopped.', resumed: true })
    await eventually(() => exits.length > 0, 'the exit to arrive')

    expect([output, later]).toEqual([['before\r\n', 'after\r\n'], []])
    expect(exits).toEqual([{ exitCode: 0, signal: null, message: 'The app is quitting, so the terminal was stopped.', resumed: true }])
  })

  it('closes its end of the port, so main hears the close', async () => {
    const { main, terminal } = await runningHandle()
    let closed = false
    main.addEventListener('close', () => {
      closed = true
    })
    main.start()

    terminal.close()
    await eventually(() => closed, 'main to hear the close')

    expect(closed).toBe(true)
  })
})

/** The preload over main's real handlers in `rig`: its invokes go to the rig's channels, and the rig's frame delivers the ports it posts. */
function apiOverMain(rig: HandlersRig): TerminalsApi {
  let portListener: PortListener = () => {}
  const api = createTerminalsApi({
    invoke: (channel: string, request: unknown) => (channel === TERMINAL_SIGN_IN_CHANNEL ? rig.signIn(request, rig.frame) : rig.attach(request, rig.frame)),
    on: (_channel, listener) => {
      portListener = listener
    }
  })
  rig.frame.deliver = (posted) => {
    portListener({ ports: posted.transfer.filter((port) => port instanceof MessagePort) }, posted.message)
  }
  return api
}

describe('window.dm.terminals over main', () => {
  let h: HandlersRig | null = null

  afterEach(() => {
    h?.cleanup()
    h = null
  })

  it('types into the chat CLI and hears its output and exit, through main’s own handlers and ports', async () => {
    const rig = handlersRig()
    h = rig
    const chat = rig.rig.newChat(CUSTOM_AGENT.id)
    const api = apiOverMain(rig)

    const answer = await api.attach(rig.rig.repo, chat.id)
    const terminal = terminalOf(answer)
    const output: string[] = []
    const exits: TerminalExit[] = []
    terminal.onOutput((data) => output.push(data))
    terminal.onExit((exit) => exits.push(exit))
    terminal.write('ls\r')
    terminal.resize(10, 1_000)
    const pty = rig.rig.host.last()
    await eventually(() => pty.sizes.length > 0, 'the input and the size to arrive')
    pty.emitData('README.md\r\n')
    pty.exit({ exitCode: 0, signal: null })
    await eventually(() => exits.length > 0, 'the exit to arrive')

    expect(answer.ok ? answer.data.state : answer.error.code).toBe('running')
    expect([pty.written, pty.sizes]).toEqual([['ls\r'], [[20, 200]]])
    expect([output, exits]).toEqual([['README.md\r\n'], [{ exitCode: 0, signal: null, message: null, resumed: false }]])
  })

  it("runs the agent's login through main's own handlers and ports, and stops it when the view closes the terminal (Back)", async () => {
    const rig = handlersRig()
    h = rig
    const api = apiOverMain(rig)

    const terminal = terminalOf(await api.signIn('claude'))
    const pty = rig.rig.host.last()
    terminal.write('y\r')
    await eventually(() => pty.written.length > 0, 'the input to arrive')
    terminal.close()
    await eventually(() => pty.kills > 0, 'the sign-in to be stopped')

    expect([pty.spec.args, pty.spec.cwd, pty.written]).toEqual([['auth', 'login'], rig.rig.root, ['y\r']])
  })
})
