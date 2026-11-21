import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { suppressTerminalQueryResponses } from './terminalQueryResponses'

const QUERIES = [
  ['primary device attributes', '\x1b[c'],
  ['secondary device attributes', '\x1b[>c'],
  ['device status', '\x1b[5n'],
  ['cursor position', '\x1b[6n'],
  ['private cursor position', '\x1b[?6n'],
  ['ANSI mode status', '\x1b[4$p'],
  ['DEC mode status', '\x1b[?2004$p'],
  ['status string', '\x1bP$qm\x1b\\'],
  ['window character size', '\x1b[18t']
] as const

async function parsed(terminal: Terminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(data, resolve))
}

describe('terminal query response ownership', () => {
  it.each(QUERIES)('suppresses only the frontend reply to %s, including split queries', async (_name, query) => {
    const backend = new Terminal({ allowProposedApi: true, windowOptions: { getWinSizeChars: true } })
    const frontend = new Terminal({ allowProposedApi: true, windowOptions: { getWinSizeChars: true } })
    const backendReplies: string[] = []
    const frontendReplies: string[] = []
    backend.onData((data) => backendReplies.push(data))
    frontend.onData((data) => frontendReplies.push(data))
    suppressTerminalQueryResponses(frontend.parser)
    try {
      await parsed(backend, query)
      await parsed(frontend, query.slice(0, -1))
      await parsed(frontend, query.slice(-1))
      expect(backendReplies).toHaveLength(1)
      expect(frontendReplies).toEqual([])
    } finally {
      backend.dispose()
      frontend.dispose()
    }
  })

  it('keeps rendering, bracketed paste, title stack controls and user input intact', async () => {
    const terminal = new Terminal({ allowProposedApi: true, windowOptions: { pushTitle: true, popTitle: true } })
    const inputs: string[] = []
    const titles: string[] = []
    terminal.onData((data) => inputs.push(data))
    terminal.onTitleChange((title) => titles.push(title))
    suppressTerminalQueryResponses(terminal.parser)
    try {
      await parsed(terminal, '\x1b]2;original\x07\x1b[22;2t\x1b]2;temporary\x07\x1b[23;2t\x1b[?2004h\x1b[31mred\x1b[2;4Htext')
      expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('red')
      expect(terminal.buffer.active.getLine(1)?.translateToString(true)).toBe('   text')
      expect(terminal.modes.bracketedPasteMode).toBe(true)
      expect(titles).toEqual(['original', 'temporary', 'original'])
      terminal.input('keyboard\r')
      terminal.input('\x1b[200~paste\rtext\x1b[201~')
      terminal.input('\x1b[6n')
      expect(inputs).toEqual(['keyboard\r', '\x1b[200~paste\rtext\x1b[201~', '\x1b[6n'])
    } finally {
      terminal.dispose()
    }
  })
})
