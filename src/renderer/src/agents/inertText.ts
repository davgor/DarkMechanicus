/** C0/C1 controls (ESC, BEL, CSI, OSC…) and bidirectional overrides: shown as visible marks, never acted on. */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/** `UNSAFE_CHARS` matches single UTF-16 code units, so the unit is the code point. */
function visibleMark(char: string): string {
  const code = char.charCodeAt(0)
  if (code < 0x20) return String.fromCodePoint(0x2400 + code)
  if (code === 0x7f) return '\u2421'
  return `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>`
}

/** Another agent's text as inert characters: escape sequences and direction overrides become visible marks. */
export function inertText(text: string): string {
  return text.replace(UNSAFE_CHARS, visibleMark)
}
