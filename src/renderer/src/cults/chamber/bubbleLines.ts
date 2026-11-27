/**
 * What the chamber's speech bubbles say, in a Mechanicus voice: an acolyte's last tool call phrased by the tool's kind,
 * the first line of a mail, and seeded idle quips. Pure. Every line is plain text of at most `BUBBLE_MAX_CHARS`
 * characters; what it is given (main's reduced tool target, a mail body) is only trimmed and capped, never parsed, so
 * markup reads as typed. Raw tool input never reaches here: main reduces it to a target first (`memberActivity.ts`).
 */
import type { MemberActivity } from '../../../../shared/cults/cultApi'
import { BUBBLE_MAX_CHARS } from './chamberState'
import { drawRandom } from './effects'

type ToolKind = 'write' | 'read' | 'shell' | 'search'

/** Main's file, shell and search tools (`memberActivity.ts`), by the kind of rite each is. */
const TOOL_KINDS: Readonly<Record<string, ToolKind>> = {
  edit: 'write', write: 'write', multiedit: 'write', notebook_edit: 'write', create: 'write', delete: 'write',
  read: 'read', view: 'read', ls: 'read',
  bash: 'shell', shell: 'shell', exec: 'shell', sh: 'shell', powershell: 'shell', cmd: 'shell', terminal: 'shell',
  python: 'shell', eval: 'shell',
  grep: 'search', glob: 'search', find: 'search', search: 'search', rg: 'search', ast_grep: 'search',
  web_search: 'search'
}

const TEMPLATES: Readonly<Record<ToolKind, (target: string) => string>> = {
  write: (target) => `Sanctifying ${target}`,
  read: (target) => `Consulting the archive: ${target}`,
  shell: (target) => `Invoking the rite of ${target}`,
  search: (target) => `Scrying the noosphere for ${target}`
}

/** Said by an acolyte idle for a while; a seeded draw picks one. */
export const IDLE_QUIPS: readonly string[] = [
  'Praise the Omnissiah',
  '*whirr*',
  'Who touched my cogitator?',
  'The Machine Spirit is content',
  'Applying the sacred unguents',
  'Recalibrating the auspex',
  '*clicks in binaric approval*',
  'The flesh is weak',
  'Awaiting the word of the Magos',
  'Litany of ignition, verse three',
  'Incense levels nominal',
  'Has anyone seen my servo-skull?',
  '*hums a canticle of maintenance*',
  'From the weakness of the mind, deliver us'
]

/** An acolyte idle this long may quip. */
export const QUIP_IDLE_MS = 20_000
/** At most one quip per acolyte in this long. */
export const QUIP_GAP_MS = 30_000

// Control characters (a tab, a newline, an escape) would only garble the bubble; each becomes a space.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

/** One line of plain text: control characters and runs of spaces become one space; capped with an ellipsis. */
function plain(text: string): string {
  const characters = [...text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()]
  return characters.length > BUBBLE_MAX_CHARS
    ? `${characters.slice(0, BUBBLE_MAX_CHARS - 1).join('').trimEnd()}…` : characters.join('')
}

/** The bubble for a tool call: its kind's template with the target, or "Using {tool}" for another tool or no target. */
export function activityLine(tool: NonNullable<MemberActivity['tool']>): string {
  const kind = Object.hasOwn(TOOL_KINDS, tool.name) ? TOOL_KINDS[tool.name] : undefined
  const target = plain(tool.target)
  return plain(kind === undefined || target === '' ? `Using ${tool.name}` : TEMPLATES[kind](target))
}

/** A mail's bubble: its first non-empty line; null when it has none. */
export function mailLine(text: string): string | null {
  const line = text.split(/\r\n|\r|\n/).find((candidate) => candidate.trim() !== '')
  return line === undefined ? null : plain(line)
}

/** When an idle acolyte last started idling and last quipped (ms); `idleSince` is null while it works. */
export interface QuipTimer {
  idleSince: number | null
  lastQuipAt: number | null
}

/** Whether the acolyte has idled `QUIP_IDLE_MS` and not quipped for `QUIP_GAP_MS`. */
export function quipDue({ idleSince, lastQuipAt }: QuipTimer, now: number): boolean {
  return idleSince !== null && now - idleSince >= QUIP_IDLE_MS && (lastQuipAt === null || now - lastQuipAt >= QUIP_GAP_MS)
}

/** A quip drawn from `randomState`, with the state to draw the next one from. */
export function drawQuip(randomState: number): [string, number] {
  const [value, next] = drawRandom(randomState)
  return [IDLE_QUIPS[Math.floor(value * IDLE_QUIPS.length)]!, next]
}
