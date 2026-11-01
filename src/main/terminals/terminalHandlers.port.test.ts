/**
 * The port main hands an attaching frame: it takes only `input` strings of at most 64 KiB and whole-number
 * `resize`s, clamped to 20-500 × 5-200, and drops anything else; it carries the chat's output and exit to the
 * frames that attached to that chat, and to no one else.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TERMINAL_INPUT_MAX_BYTES } from '../../shared/agents/terminalApi'
import { attachRunning, handlersRig, PAGE, type HandlersRig } from './__mocks__/terminalHandlersRig'
import { closedFlag, FakeFrame, received } from './__mocks__/terminalPorts'
import { CUSTOM_AGENT, eventually, settle } from './__mocks__/terminalSessionsRig'
import { parsePortRequest } from './terminalHandlers'

describe('parsePortRequest: input', () => {
  it('accepts a string of input, empty or up to 64 KiB of UTF-8', () => {
    const ascii = 'a'.repeat(TERMINAL_INPUT_MAX_BYTES)
    // Two bytes each in UTF-8: exactly 64 KiB.
    const accented = 'é'.repeat(TERMINAL_INPUT_MAX_BYTES / 2)

    expect([parsePortRequest({ type: 'input', data: 'ls\r' }), parsePortRequest({ type: 'input', data: '' })]).toEqual([
      { type: 'input', data: 'ls\r' },
      { type: 'input', data: '' }
    ])
    expect(parsePortRequest({ type: 'input', data: ascii })).toEqual({ type: 'input', data: ascii })
    expect(parsePortRequest({ type: 'input', data: accented })).toEqual({ type: 'input', data: accented })
  })

  it('drops input over 64 KiB of UTF-8, however few characters it has', () => {
    expect(parsePortRequest({ type: 'input', data: 'a'.repeat(TERMINAL_INPUT_MAX_BYTES + 1) })).toBeNull()
    expect(parsePortRequest({ type: 'input', data: `${'é'.repeat(TERMINAL_INPUT_MAX_BYTES / 2)}a` })).toBeNull()
    // 32 769 characters, 65 538 bytes.
    expect(parsePortRequest({ type: 'input', data: 'é'.repeat(TERMINAL_INPUT_MAX_BYTES / 2 + 1) })).toBeNull()
  })

  it('drops input that is not a string, and an input message with any other key', () => {
    for (const data of [7, null, undefined, ['ls'], { text: 'ls' }, new Uint8Array([108, 115])]) {
      expect(parsePortRequest({ type: 'input', data })).toBeNull()
    }
    expect(parsePortRequest({ type: 'input' })).toBeNull()
    expect(parsePortRequest({ type: 'input', data: 'ls', file: '/bin/sh' })).toBeNull()
  })
})

describe('parsePortRequest: resize', () => {
  it('keeps whole sizes inside 20-500 × 5-200 as they are, the bounds included', () => {
    expect([
      parsePortRequest({ type: 'resize', cols: 120, rows: 40 }),
      parsePortRequest({ type: 'resize', cols: 20, rows: 5 }),
      parsePortRequest({ type: 'resize', cols: 500, rows: 200 })
    ]).toEqual([
      { type: 'resize', cols: 120, rows: 40 },
      { type: 'resize', cols: 20, rows: 5 },
      { type: 'resize', cols: 500, rows: 200 }
    ])
  })

  it('clamps whole sizes outside the bounds to them', () => {
    expect([
      parsePortRequest({ type: 'resize', cols: 19, rows: 4 }),
      parsePortRequest({ type: 'resize', cols: 501, rows: 201 }),
      parsePortRequest({ type: 'resize', cols: 0, rows: -3 }),
      parsePortRequest({ type: 'resize', cols: 1_000_000_000, rows: Number.MAX_SAFE_INTEGER }),
      parsePortRequest({ type: 'resize', cols: 10, rows: 300 })
    ]).toEqual([
      { type: 'resize', cols: 20, rows: 5 },
      { type: 'resize', cols: 500, rows: 200 },
      { type: 'resize', cols: 20, rows: 5 },
      { type: 'resize', cols: 500, rows: 200 },
      { type: 'resize', cols: 20, rows: 200 }
    ])
  })

  it('drops sizes that are not whole numbers, a missing size, and any other key', () => {
    const sizes: unknown[][] = [
      [80.5, 24],
      [80, 24.5],
      [Number.NaN, 24],
      [80, Number.POSITIVE_INFINITY],
      [Number.NEGATIVE_INFINITY, 24],
      [2 ** 60, 24],
      ['80', 24],
      [80, null],
      [80, undefined]
    ]
    for (const [cols, rows] of sizes) {
      expect(parsePortRequest({ type: 'resize', cols, rows })).toBeNull()
    }
    expect(parsePortRequest({ type: 'resize', cols: 80, rows: 24, cwd: '/' })).toBeNull()
  })
})

describe('parsePortRequest: anything else', () => {
  it('drops every other message', () => {
    for (const message of [
      null,
      undefined,
      'ls\r',
      42,
      ['input', 'ls'],
      {},
      { type: 'Input', data: 'ls' },
      { type: 'spawn', file: '/bin/sh', args: [] },
      { type: 'kill' },
      { type: 'exit', exitCode: 0 },
      { data: 'ls' }
    ]) {
      expect(parsePortRequest(message)).toBeNull()
    }
  })
})

let h: HandlersRig

beforeEach(() => {
  h = handlersRig()
})

afterEach(() => {
  h.cleanup()
})

describe('the port of a running attach: what it carries', () => {
  it('writes input and clamped sizes to the chat it was given for, and nothing it drops', async () => {
    const chat = h.rig.newChat(CUSTOM_AGENT.id)
    const { port } = await attachRunning(h, chat)
    const pty = h.rig.host.last()

    port.postMessage({ type: 'input', data: 'ls\r' })
    port.postMessage({ type: 'input', data: 'a'.repeat(TERMINAL_INPUT_MAX_BYTES + 1) })
    port.postMessage({ type: 'resize', cols: 9_999, rows: 1 })
    port.postMessage({ type: 'resize', cols: 80.5, rows: 24 })
    port.postMessage({ type: 'input', data: 'pwd\r', chatId: 'ch_other' })
    port.postMessage({ type: 'input', data: 'exit\r' })
    await eventually(() => pty.written.length >= 2, 'the input to arrive')

    expect([pty.written, pty.sizes]).toEqual([['ls\r', 'exit\r'], [[500, 5]]])
  })

  it('carries output to every frame attached to the chat, and none to another chat or a refused attach', async () => {
    const one = h.rig.newChat(CUSTOM_AGENT.id)
    const two = h.rig.newChat(CUSTOM_AGENT.id)
    const otherWindow = new FakeFrame(PAGE)
    const first = await attachRunning(h, one)
    const second = await attachRunning(h, one, otherWindow)
    const elsewhere = await attachRunning(h, two)
    const refusedFrame = new FakeFrame(PAGE)
    await h.attach({ folder: h.rig.repo, chatId: h.rig.newChat('codex').id }, refusedFrame)
    const heard = [received(first.port), received(second.port), received(elsewhere.port)]
    const [ptyOne, ptyTwo] = h.rig.host.spawns

    ptyOne?.emitData('one says hi\r\n')
    ptyTwo?.emitData('two says hi\r\n')
    await eventually(() => heard.every((messages) => messages.length > 0), 'the output to arrive')
    await settle()

    expect(heard).toEqual([
      [{ type: 'output', data: 'one says hi\r\n' }],
      [{ type: 'output', data: 'one says hi\r\n' }],
      [{ type: 'output', data: 'two says hi\r\n' }]
    ])
    expect(refusedFrame.posted).toEqual([])
  })

})

describe('the port of a running attach: its end', () => {
  it('reports a write or resize that throws in main and keeps taking messages', async () => {
    h.cleanup()
    const failure = new Error('ioctl(2) failed, EBADF')
    h = handlersRig({
      sessions: (sessions) => ({
        ...sessions,
        resize: () => {
          throw failure
        }
      })
    })
    const chat = h.rig.newChat(CUSTOM_AGENT.id)
    const { port } = await attachRunning(h, chat)
    const pty = h.rig.host.last()

    port.postMessage({ type: 'resize', cols: 80, rows: 24 })
    port.postMessage({ type: 'input', data: 'still typing' })
    await eventually(() => pty.written.length > 0, 'the input to arrive')

    expect([h.errors, pty.written]).toEqual([[failure], ['still typing']])
  })

  it('stops carrying output to a port its frame closed, and stops listening for it', async () => {
    const chat = h.rig.newChat(CUSTOM_AGENT.id)
    const kept = await attachRunning(h, chat)
    const closed = await attachRunning(h, chat)
    const heard = received(kept.port)
    const pty = h.rig.host.last()

    closed.port.close()
    await eventually(() => h.detached.length === 1, 'the closed port to be detached')
    pty.emitData('still here\r\n')
    await eventually(() => heard.length > 0, 'the output to arrive')

    expect(h.detached).toEqual([h.attached[1]])
    expect(heard).toEqual([{ type: 'output', data: 'still here\r\n' }])
  })

  it('carries the exit after the last output, then closes the port and takes no more input', async () => {
    const chat = h.rig.newChat(CUSTOM_AGENT.id)
    const { port } = await attachRunning(h, chat)
    const heard = received(port)
    const closed = closedFlag(port)
    const pty = h.rig.host.last()

    pty.emitData('bye\r\n')
    pty.exit({ exitCode: 3, signal: null })
    await eventually(() => closed.closed, 'the port to close')

    expect(heard).toEqual([
      { type: 'output', data: 'bye\r\n' },
      { type: 'exit', exitCode: 3, signal: null, message: null, resumed: false }
    ])
    expect(h.detached).toEqual(h.attached)
  })

})

describe('the port of a running attach: how the terminal ended or started', () => {
  it('carries why main stopped the terminal, as the exit message', async () => {
    const chat = h.rig.newChat(CUSTOM_AGENT.id)
    const { port } = await attachRunning(h, chat)
    const heard = received(port)
    const closed = closedFlag(port)
    const pty = h.rig.host.last()

    const deleting = h.rig.sessions.deleteChat(chat, async () => {})
    pty.exit({ exitCode: 0, signal: 15 })
    await deleting
    await eventually(() => closed.closed, 'the port to close')

    expect(heard).toEqual([{ type: 'exit', exitCode: 0, signal: 15, message: 'The chat was deleted, so its terminal was stopped.', resumed: false }])
  })

  it('says on the exit that the terminal resumed an earlier session, and starts a new one when the attach asks', async () => {
    const chat = h.rig.newChat('autonomous')
    h.rig.store.updateChat(chat, { sessionStarted: true })
    const { port } = await attachRunning(h, chat)
    const heard = received(port)
    const closed = closedFlag(port)
    h.rig.host.last().exit({ exitCode: 1, signal: 0 })
    await eventually(() => closed.closed, 'the port to close')
    expect(heard).toEqual([{ type: 'exit', exitCode: 1, signal: 0, message: null, resumed: true }])

    const again = await h.attach({ folder: chat.folder, chatId: chat.id, newSession: true })

    expect(again.ok && again.data.state).toBe('running')
    expect((h.rig.host.last().spec.args as string[]).slice(0, 2)).toEqual(['start', h.rig.repo])
    expect(h.rig.reopenedStore().getChat(chat)?.sessionStarted).toBe(false)
  })

  it('gives an attach that waited out the sign-in check an empty screen, and what the CLI prints on its port', async () => {
    const held = h.rig.holdAuth()
    const chat = h.rig.newChat('claude')

    const attaching = attachRunning(h, chat)
    await eventually(() => h.rig.steps.includes('auth'), 'the sign-in check')
    held.open({ state: 'signed_in', reason: 'Signed in.' })
    const { answer, port } = await attaching
    const heard = received(port)
    h.rig.host.last().emitData('Welcome to Claude Code\r\n')
    await eventually(() => heard.length > 0, 'the output to arrive')

    expect(answer).toEqual({ state: 'running', snapshot: '', port: 'port-1' })
    expect(heard).toEqual([{ type: 'output', data: 'Welcome to Claude Code\r\n' }])
  })
})
