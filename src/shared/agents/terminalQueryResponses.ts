import type { IParser } from '@xterm/xterm'

const handled = (): boolean => true

/**
 * Main's persistent headless screen owns these xterm 6 query replies for the whole PTY generation.
 * Suppress only the corresponding frontend parser handlers, not keyboard/paste input or rendering.
 * Identifiers mirror xterm's InputHandler: DA/DA2, DSR/DEC DSR, DECRQM and DECRQSS.
 * Window reports remain default-disabled; if enabled, only the headless-supported character-size query
 * belongs to main. Pixel reports, OSC colors and clipboard need the foreground browser and stay there.
 * Registrations share the terminal's lifetime. Recheck this inventory when upgrading xterm.
 */
export function suppressTerminalQueryResponses(parser: Pick<IParser, 'registerCsiHandler' | 'registerDcsHandler'>): void {
  parser.registerCsiHandler({ final: 'c' }, handled)
  parser.registerCsiHandler({ prefix: '>', final: 'c' }, handled)
  parser.registerCsiHandler({ final: 'n' }, handled)
  parser.registerCsiHandler({ prefix: '?', final: 'n' }, handled)
  parser.registerCsiHandler({ intermediates: '$', final: 'p' }, handled)
  parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, handled)
  parser.registerDcsHandler({ intermediates: '$', final: 'q' }, handled)
  parser.registerCsiHandler({ final: 't' }, (params) => params[0] === 18)
}
