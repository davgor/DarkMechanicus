/**
 * Keys xterm cannot tell apart from a plainer one: Shift+Enter and Ctrl+Enter both send a bare carriage return.
 * A CLI that wants them separate (OMP's newline in its prompt) asks the terminal for a keyboard mode; this sends
 * the key the way that mode defines it. Kitty's protocol is not in xterm 6, so the CLI falls back to one of these.
 */

/** The keyboard modes a CLI has switched on, learned from the escape sequences it printed. */
export interface KeyModes {
  /** Win32 input mode, `CSI ? 9001 h`: key events as `CSI Vk ; Sc ; Uc ; Kd ; Cs ; Rc _` records (ConPTY's own form). */
  win32: boolean
  /** xterm's modifyOtherKeys level 2, `CSI > 4 ; 2 m`: modified keys as `CSI 27 ; modifier ; code ~`. */
  modifyOtherKeys: boolean
}

type EnterKey = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey' | 'type'>

const ENTER = 13
const ENTER_SCAN_CODE = 28
// ControlKeyState bits of a console key record.
const LEFT_ALT = 0x2
const LEFT_CTRL = 0x8
const SHIFT = 0x10

function isModifiedEnter(event: EnterKey): boolean {
  return event.type === 'keydown' && event.key === 'Enter' && !event.metaKey && (event.shiftKey || event.ctrlKey)
}

function win32Records(event: EnterKey): string {
  const state = (event.shiftKey ? SHIFT : 0) | (event.ctrlKey ? LEFT_CTRL : 0) | (event.altKey ? LEFT_ALT : 0)
  const record = (down: 0 | 1): string => `\x1b[${ENTER};${ENTER_SCAN_CODE};${ENTER};${down};${state};1_`
  return record(1) + record(0)
}

function modifyOtherKeysSequence(event: EnterKey): string {
  const modifier = 1 + (event.shiftKey ? 1 : 0) + (event.altKey ? 2 : 0) + (event.ctrlKey ? 4 : 0)
  return `\x1b[27;${modifier};${ENTER}~`
}

/** What to send for a modified Enter in the CLI's keyboard mode; null when xterm's own bytes are right. */
export function modifiedEnter(event: EnterKey, modes: KeyModes): string | null {
  if (!isModifiedEnter(event)) {
    return null
  }
  if (modes.win32) {
    return win32Records(event)
  }
  return modes.modifyOtherKeys ? modifyOtherKeysSequence(event) : null
}
