import { TERMINAL_COLOR, TERMINAL_COLOR_KEYS, type TerminalColors } from '../../../shared/agents/terminalColors'

/**
 * A chat terminal's colors and face (`docs/design/chat-shells.md`, "Theme"). xterm takes colors in JavaScript,
 * so they are read from the `:root` tokens of `styles.css`, which keeps the palette in that one block.
 */

/** Which `:root` token each of xterm's theme colors (`ITheme`) comes from. */
const THEME_TOKENS = {
  background: '--code-bg',
  foreground: '--ink',
  cursor: '--accent',
  cursorAccent: '--code-bg',
  selectionBackground: '--primary-soft',
  black: '--term-black',
  red: '--term-red',
  green: '--term-green',
  yellow: '--term-yellow',
  blue: '--term-blue',
  magenta: '--term-magenta',
  cyan: '--term-cyan',
  white: '--term-white',
  brightBlack: '--term-bright-black',
  brightRed: '--term-bright-red',
  brightGreen: '--term-bright-green',
  brightYellow: '--term-bright-yellow',
  brightBlue: '--term-bright-blue',
  brightMagenta: '--term-bright-magenta',
  brightCyan: '--term-bright-cyan',
  brightWhite: '--term-bright-white'
} as const

/** The token of the app's monospace face. */
export const TERMINAL_FONT_TOKEN = '--font-mono'

/** xterm's theme colors, as CSS colors. */
export type TerminalTheme = TerminalColors

/** The value of a `:root` token, or '' when there is none. */
export type TokenReader = (name: string) => string

/**
 * The terminal's colors from the tokens; a color whose token is missing is left to xterm's default. `override` (OMP's
 * theme) replaces the tokens key by key; it is data, so only known keys with a `#rrggbb` value count.
 */
export function terminalTheme(read: TokenReader, override: TerminalColors | null = null): TerminalTheme {
  const theme: TerminalTheme = {}
  for (const [color, name] of Object.entries(THEME_TOKENS) as [keyof TerminalTheme, string][]) {
    const value = read(name)
    if (value !== '') {
      theme[color] = value
    }
  }
  for (const key of TERMINAL_COLOR_KEYS) {
    const value = override?.[key]
    if (value !== undefined && TERMINAL_COLOR.test(value)) {
      theme[key] = value
    }
  }
  return theme
}

/** A chat's theme: an OMP chat takes OMP's theme over the tokens; any other agent keeps the app's palette. */
export function chatTerminalTheme(read: TokenReader, agent: string, omp: TerminalColors | null): TerminalTheme {
  return terminalTheme(read, agent === 'omp' ? omp : null)
}

/** Reads tokens as the document root computes them. */
export function rootTokens(doc: Document): TokenReader {
  const style = getComputedStyle(doc.documentElement)
  return (name) => style.getPropertyValue(name).trim()
}
