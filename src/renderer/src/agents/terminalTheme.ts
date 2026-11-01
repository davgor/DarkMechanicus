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
export type TerminalTheme = Partial<Record<keyof typeof THEME_TOKENS, string>>

/** The value of a `:root` token, or '' when there is none. */
export type TokenReader = (name: string) => string

/** The terminal's colors from the tokens; a color whose token is missing is left to xterm's default. */
export function terminalTheme(read: TokenReader): TerminalTheme {
  const theme: TerminalTheme = {}
  for (const [color, name] of Object.entries(THEME_TOKENS) as [keyof TerminalTheme, string][]) {
    const value = read(name)
    if (value !== '') {
      theme[color] = value
    }
  }
  return theme
}

/** Reads tokens as the document root computes them. */
export function rootTokens(doc: Document): TokenReader {
  const style = getComputedStyle(doc.documentElement)
  return (name) => style.getPropertyValue(name).trim()
}
