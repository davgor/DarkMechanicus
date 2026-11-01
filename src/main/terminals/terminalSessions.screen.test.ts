/**
 * The screen main keeps for each PTY, on the real `@xterm/headless` terminal: an attach answers with a snapshot
 * that paints what was written so far (text, colours, cursor, scrollback), the screen has the PTY's size, and
 * listeners hear exactly the output after the snapshot they were attached at.
 */
import { Terminal } from '@xterm/headless'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eventually, recorder, settle, startTerminal, terminalRig, type TerminalRig } from './__mocks__/terminalSessionsRig'
import type { TerminalEvent } from './terminalSessions'

let rig: TerminalRig

beforeEach(() => {
  rig = terminalRig()
})

afterEach(() => {
  rig.cleanup()
})

interface Painted {
  lines: string[]
  cursor: [number, number]
  cell: (row: number, col: number) => { char: string; red: boolean; bold: boolean }
}

/** What `text` paints on a fresh terminal of this size: every line (scrollback included), the cursor and cells. */
async function paint(text: string, cols = 80, rows = 24): Promise<Painted> {
  const terminal = new Terminal({ cols, rows, scrollback: 5_000, allowProposedApi: true })
  await new Promise<void>((resolve) => {
    terminal.write(text, resolve)
  })
  const buffer = terminal.buffer.active
  const lines = Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? '')
  while (lines.at(-1) === '') {
    lines.pop()
  }
  // Not disposed: `cell` reads the buffer after this returns.
  const painted: Painted = {
    lines,
    cursor: [buffer.baseY + buffer.cursorY, buffer.cursorX],
    cell: (row, col) => {
      const cell = buffer.getLine(row)?.getCell(col)
      return { char: cell?.getChars() ?? '', red: cell?.isFgPalette() === true && cell.getFgColor() === 1, bold: (cell?.isBold() ?? 0) !== 0 }
    }
  }
  return painted
}

function outputs(events: readonly TerminalEvent[]): string[] {
  return events.flatMap((event) => (event.kind === 'output' ? [event.data] : []))
}

describe('terminal sessions: the screen snapshot', () => {
  it('reproduces the output written so far, colours, bold and cursor included', async () => {
    const chat = rig.newChat()
    const { pty } = await startTerminal(rig, chat)
    const chunks = ['build \x1b[31mfai', 'led\x1b[0m\r\n', 'line two\r\n\x1b[1mbold\x1b[0m', ' and on']
    for (const chunk of chunks) {
      pty.emitData(chunk)
    }

    const answer = await rig.sessions.attach(chat)

    expect(answer.state).toBe('running')
    const snapshot = answer.state === 'running' ? answer.snapshot : ''
    const [fromSnapshot, fromOutput] = await Promise.all([paint(snapshot), paint(chunks.join(''))])
    expect(fromSnapshot.lines).toEqual(['build failed', 'line two', 'bold and on'])
    expect(fromSnapshot.lines).toEqual(fromOutput.lines)
    expect(fromSnapshot.cursor).toEqual(fromOutput.cursor)
    expect([fromSnapshot.cell(0, 6), fromSnapshot.cell(0, 0), fromSnapshot.cell(2, 0)]).toEqual([
      { char: 'f', red: true, bold: false },
      { char: 'b', red: false, bold: false },
      { char: 'b', red: false, bold: true }
    ])
  })

  it('keeps the output that scrolled off the screen', async () => {
    const chat = rig.newChat()
    const { pty } = await startTerminal(rig, chat)
    const lines = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`)
    pty.emitData(lines.join('\r\n'))

    const answer = await rig.sessions.attach(chat)

    expect((await paint(answer.state === 'running' ? answer.snapshot : '')).lines).toEqual(lines)
  })

  it('has the PTY size from the start, and follows a resize', async () => {
    const chat = rig.newChat()
    const { pty } = await startTerminal(rig, chat)
    // Row 30, column 100: clamped to the last cell of an 80 x 24 screen.
    pty.emitData('\x1b[30;100Hx')
    const before = await rig.sessions.attach(chat)

    rig.sessions.resize(chat.id, 120, 40)
    pty.emitData('\x1b[2J\x1b[30;100Hy')
    const after = await rig.sessions.attach(chat)

    expect([pty.spec.cols, pty.spec.rows, pty.sizes]).toEqual([80, 24, [[120, 40]]])
    expect((await paint(before.state === 'running' ? before.snapshot : '')).cell(23, 79).char).toBe('x')
    const resized = await paint(after.state === 'running' ? after.snapshot : '', 120, 40)
    expect(resized.lines.at(-1)).toBe(`${' '.repeat(99)}y`)
  })
})

describe('terminal sessions: output to listeners', () => {
  it('gives a listener exactly the output after its snapshot, once the attach has answered', async () => {
    const chat = rig.newChat()
    const { pty } = await startTerminal(rig, chat)
    pty.emitData('before ')
    const heard = recorder()

    const attaching = rig.sessions.attach(chat, heard.listener)
    pty.emitData('during ')
    const answer = await attaching
    const heardByThen = [...heard.events]
    pty.emitData('after')
    await eventually(() => outputs(heard.events).length === 2, 'the output after the snapshot')

    expect(heardByThen).toEqual([])
    expect(outputs(heard.events)).toEqual(['during ', 'after'])
    const [fromSnapshot, fromBefore] = await Promise.all([paint(answer.state === 'running' ? answer.snapshot : ''), paint('before ')])
    expect(fromSnapshot.lines).toEqual(fromBefore.lines)
    expect(fromSnapshot.lines.join('')).not.toContain('during')
  })

  it('fans the output out to every listener of the chat, and not to another chat', async () => {
    const chat = rig.newChat()
    const other = rig.newChat()
    const first = recorder()
    const second = recorder()
    const elsewhere = recorder()
    const { pty } = await startTerminal(rig, chat, first.listener)
    await startTerminal(rig, other, elsewhere.listener)
    await rig.sessions.attach(chat, second.listener)
    await settle()

    pty.emitData('hello')
    await eventually(() => outputs(second.events).length > 0, 'the output')

    expect([outputs(first.events), outputs(second.events), outputs(elsewhere.events)]).toEqual([['hello'], ['hello'], []])
  })

  it('stops giving a detached listener anything', async () => {
    const chat = rig.newChat()
    const heard = recorder()
    const { pty } = await startTerminal(rig, chat, heard.listener)
    await settle()

    rig.sessions.detach(chat.id, heard.listener)
    pty.emitData('unheard')
    await settle()

    expect(outputs(heard.events)).toEqual([])
  })

  it('sends input to the PTY as typed', async () => {
    const chat = rig.newChat()
    const { pty } = await startTerminal(rig, chat)

    rig.sessions.write(chat.id, 'ls\r')

    expect(pty.written).toEqual(['ls\r'])
  })
})
