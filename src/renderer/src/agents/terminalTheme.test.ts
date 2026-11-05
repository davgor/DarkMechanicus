// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { installRootTokens, tokenSource } from '../__mocks__/rootTokens'
import { chatTerminalTheme, rootTokens, terminalTheme, type TerminalTheme } from './terminalTheme'

/** A token of styles.css without its spaces: the browser serializes `rgba(1, 2, 3, 0.2)` without them. */
const token = (name: string): string => tokenSource(name).replace(/\s/g, '')
const squashed = (theme: TerminalTheme): Record<string, string> => Object.fromEntries(Object.entries(theme).map(([color, value]) => [color, value.replace(/\s/g, '')]))

afterEach(() => {
  document.head.innerHTML = ''
})

describe('terminalTheme', () => {
  it('takes every color from the :root tokens of styles.css', () => {
    installRootTokens()

    const theme = terminalTheme(rootTokens(document))

    expect(squashed(theme)).toEqual({
      background: token('--code-bg'),
      foreground: token('--ink'),
      cursor: token('--accent'),
      cursorAccent: token('--code-bg'),
      selectionBackground: token('--primary-soft'),
      black: token('--term-black'),
      red: token('--term-red'),
      green: token('--term-green'),
      yellow: token('--term-yellow'),
      blue: token('--term-blue'),
      magenta: token('--term-magenta'),
      cyan: token('--term-cyan'),
      white: token('--term-white'),
      brightBlack: token('--term-bright-black'),
      brightRed: token('--term-bright-red'),
      brightGreen: token('--term-bright-green'),
      brightYellow: token('--term-bright-yellow'),
      brightBlue: token('--term-bright-blue'),
      brightMagenta: token('--term-bright-magenta'),
      brightCyan: token('--term-bright-cyan'),
      brightWhite: token('--term-bright-white')
    })
    expect(Object.values(theme).every((value) => /^(#[0-9a-f]{6}|rgba\()/i.test(value))).toBe(true)
  })

  it('leaves a color whose token is missing to xterm', () => {
    const tokens: Record<string, string> = { '--code-bg': '#000000', '--ink': ' #ffffff ' }
    expect(terminalTheme((name) => (tokens[name] ?? '').trim())).toEqual({ background: '#000000', foreground: '#ffffff', cursorAccent: '#000000' })
  })
})

describe('chatTerminalTheme', () => {
  const OMP = { background: '#101820', foreground: '#e0e0e0', red: '#ff0033', brightBlack: '#667788' }

  it('lets an OMP chat take OMP\u2019s theme key by key, with every other key from the app tokens', () => {
    installRootTokens()
    const read = rootTokens(document)

    const theme = chatTerminalTheme(read, 'omp', OMP)

    expect(theme).toEqual({ ...terminalTheme(read), ...OMP })
    expect(theme.background).toBe('#101820')
    expect(theme.green).toBe(terminalTheme(read).green)
    expect(theme.cursor).toBe(terminalTheme(read).cursor)
  })

  it('keeps the app palette for an OMP chat with no theme, and for every other agent', () => {
    installRootTokens()
    const read = rootTokens(document)

    expect(chatTerminalTheme(read, 'omp', null)).toEqual(terminalTheme(read))
    expect(chatTerminalTheme(read, 'claude', OMP)).toEqual(terminalTheme(read))
    expect(chatTerminalTheme(read, 'cu_custom1', OMP)).toEqual(terminalTheme(read))
  })

  it('ignores a value that is not a #rrggbb color and a key xterm does not have', () => {
    const read = (name: string): string => (name === '--code-bg' ? '#000000' : '')

    const theme = chatTerminalTheme(read, 'omp', { background: 'url(x)', red: 'red', foreground: '#fff', nope: '#123456' } as TerminalTheme)

    expect(theme).toEqual({ background: '#000000', cursorAccent: '#000000' })
  })
})

describe('rootTokens', () => {
  it('reads a token of the document root, trimmed, and nothing for an unknown one', () => {
    const sheet = document.createElement('style')
    sheet.textContent = ':root { --font-mono: "IBM Plex Mono", monospace; }'
    document.head.append(sheet)
    const read = rootTokens(document)
    expect(read('--font-mono')).toBe('"IBM Plex Mono",monospace')
    expect(read('--nope')).toBe('')
  })
})
