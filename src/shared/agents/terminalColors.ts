/** The colors of xterm's theme (`ITheme`) that a chat's pane sets, as CSS colors; shared by main (OMP's theme) and the renderer. */
export const TERMINAL_COLOR_KEYS = [
  'background',
  'foreground',
  'cursor',
  'cursorAccent',
  'selectionBackground',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const

export type TerminalColorKey = (typeof TERMINAL_COLOR_KEYS)[number]

/** A set of terminal colors; a key that is absent is left to the app's own palette. */
export type TerminalColors = Partial<Record<TerminalColorKey, string>>

/** The CSS colors OMP's theme can produce: `#rrggbb`, nothing else. */
export const TERMINAL_COLOR = /^#[0-9a-f]{6}$/i
