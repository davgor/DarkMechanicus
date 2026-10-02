/**
 * Parser for an old-style Markdown `/board`: `board/backlog`, `board/in-progress` and `board/done`
 * holding epic files (`NNN-slug.md`, `# EPIC: Title`), sub-tickets (`NNN.M-slug.md`, `# NNN.M — Title`),
 * collapsed done epics that keep their sub-tickets under `## Sub-tickets`, sub-tickets whose epic file
 * is missing, and standalone tickets (`NNN-slug.md`, `# NNN — Title`).
 *
 * Pure: it takes repository-relative paths and file contents, never touches the file system
 * (`../repo/boardFiles.ts` reads them), and is safe to run anywhere. Board text is data. Nothing in it
 * is evaluated or followed; only the title line, acceptance-criteria checklists, `## Sub-tickets`
 * sections and explicit "Depends on" lines are read for structure, and every other line stays in a
 * body as written. A file that cannot be read as part of the board is skipped with a reason and never
 * stops the others.
 */
import { LIMITS } from '../schemas'

export const BOARD_FOLDERS = ['backlog', 'in-progress', 'done'] as const
/** The folder a file sits in, which is its status on the board. */
type BoardFolder = (typeof BOARD_FOLDERS)[number]

/** Files one board may hold; any past this many (in path order) are skipped unread. */
export const MAX_BOARD_FILES = 3_000
/**
 * Per-file bound in UTF-8 bytes. Far below `LIMITS.markdown`, so any body taken from one file fits a
 * ticket body, or an epic intent together with its import note.
 */
export const MAX_BOARD_FILE_BYTES = 64 * 1024

export interface BoardFile {
  /** Repository-relative, with forward slashes: `board/done/013-checkpoints-and-recovery.md`. */
  path: string
  text: string
}

export interface BoardCriterion {
  text: string
  checked: boolean
}

export interface BoardTicket {
  /** `NNN.M` for a sub-ticket, `NNN` for a standalone ticket, as written in the board. */
  boardId: string
  title: string
  /** Every part of the ticket except its title and checklists, as written. */
  body: string
  criteria: BoardCriterion[]
  folder: BoardFolder
  /** The ticket's own file, or for a collapsed sub-ticket its epic's file. */
  sourcePath: string
  /** Board ids of other tickets of the same epic that a "Depends on" line names. */
  dependsOn: string[]
}

export interface BoardEpic {
  /** Epic number as written in its file names, such as `014`. */
  boardId: string
  /**
   * `epic`: an epic file (`# EPIC:`, or an `NNN` file the board has sub-tickets for). `standalone`: a
   * ticket with no epic, carried as an epic of that one ticket. `orphan`: sub-tickets with no epic file.
   */
  kind: 'epic' | 'standalone' | 'orphan'
  title: string
  body: string
  criteria: BoardCriterion[]
  /** The epic file's folder; for orphan sub-tickets the shared folder, or in-progress when they differ. */
  folder: BoardFolder
  /** The epic's own file; null for orphan sub-tickets. */
  sourcePath: string | null
  /** Every file the epic was read from, its own file first. */
  sourcePaths: string[]
  /** In sub-ticket number (`M`) order. */
  tickets: BoardTicket[]
}

export interface SkippedBoardFile {
  path: string
  /** Completes a sentence that starts with the path, such as "is not a text file". */
  reason: string
}

export interface BoardParse {
  epics: BoardEpic[]
  skipped: SkippedBoardFile[]
}

interface Heading {
  level: number
  text: string
}

interface Line {
  text: string
  /** Null for plain lines and for anything inside fenced code. */
  heading: Heading | null
  /** A fence line or a line inside fenced code. */
  code: boolean
}

/** Stands where structure was taken out of a body; rendering leaves one blank line there. */
const BREAK: Line = { text: '', heading: null, code: false }

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const CHECKBOX = /^\s*[-*+]\s+\[([ xX])\](?:\s+(.*))?$/
const CRITERIA_HEADING = /^acceptance criteria:?$/i
const SUBTICKETS_HEADING = /^sub-?tickets:?$/i
const FILE_NAME = /^(\d{1,9})(?:\.(\d{1,9}))?(?:-[^/\\]{0,200})?\.md$/i
const EPIC_TITLE = /^EPIC\s*[:—–-]\s*(.*)$/i
const NUMBERED_TITLE = /^(\d{1,9})\s*[—–:-]\s*(.*)$/
const SUB_TITLE = /^(\d{1,9})\.(\d{1,9})(?:\s*[—–:-]\s*|\s+)(.*)$/
const DEPENDS_ON = /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?)?(?:\*\*|__)?depends\s+on\b/i
const TICKET_ID = /\b(\d{1,9})\.(\d{1,9})\b/g

const encoder = new TextEncoder()

function skip(reason: string): never {
  throw new Error(reason)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function byPath<T extends { path: string }>(a: T, b: T): number {
  if (a.path === b.path) {
    return 0
  }
  return a.path < b.path ? -1 : 1
}

function isBlank(line: Line): boolean {
  return line.text.trim() === ''
}

function headingOf(text: string): Heading | null {
  const match = HEADING.exec(text)
  return match ? { level: (match[1] ?? '').length, text: (match[2] ?? '').trim() } : null
}

function closesFence(text: string, fence: string): boolean {
  const trimmed = text.trim()
  return trimmed.length >= fence.length && trimmed === fence.charAt(0).repeat(trimmed.length)
}

/** Splits text into lines, marking headings outside fenced code. */
function scanLines(text: string): Line[] {
  const lines: Line[] = []
  let fence: string | null = null
  for (const raw of text.split('\n')) {
    if (fence !== null) {
      fence = closesFence(raw, fence) ? null : fence
      lines.push({ text: raw, heading: null, code: true })
      continue
    }
    fence = FENCE.exec(raw)?.[1] ?? null
    lines.push({ text: raw, heading: fence === null ? headingOf(raw) : null, code: fence !== null })
  }
  return lines
}

/** Index of the next heading at `level` or above after `start`, or the end. */
function sectionEnd(lines: Line[], start: number, level: number): number {
  for (let index = start + 1; index < lines.length; index += 1) {
    const heading = lines[index]?.heading
    if (heading && heading.level <= level) {
      return index
    }
  }
  return lines.length
}

/** Replaces each section whose heading matches with what `cut` returns for it (heading included). */
function cutSections(lines: Line[], isTarget: (heading: Heading) => boolean, cut: (section: Line[]) => Line[]): Line[] {
  const rest: Line[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line.heading !== null && isTarget(line.heading)) {
      const end = sectionEnd(lines, index, line.heading.level)
      rest.push(...cut(lines.slice(index, end)))
      index = end
    } else {
      rest.push(line)
      index += 1
    }
  }
  return rest
}

function lastContent(texts: string[]): number {
  let index = texts.length - 1
  while (index >= 0 && (texts[index] ?? '').trim() === '') {
    index -= 1
  }
  return index
}

/** Joins lines back into Markdown, one blank line at each break, without leading or trailing blanks. */
function render(lines: Line[]): string {
  const out: string[] = []
  let pendingBreak = false
  for (const line of lines) {
    if (line === BREAK || (pendingBreak && isBlank(line))) {
      pendingBreak = true
      continue
    }
    if (pendingBreak) {
      out.splice(lastContent(out) + 1)
      out.push('')
      pendingBreak = false
    }
    out.push(line.text)
  }
  const first = out.findIndex((text) => text.trim() !== '')
  return first < 0 ? '' : out.slice(first, lastContent(out) + 1).join('\n')
}

function isContinuation(line: Line): boolean {
  return !line.code && /^\s+\S/.test(line.text)
}

/** Moves a criteria section's checklist into `into`; anything else it holds stays in the body. */
function takeCriteria(section: Line[], into: BoardCriterion[]): Line[] {
  const kept: Line[] = [BREAK]
  let last: BoardCriterion | null = null
  for (const line of section.slice(1)) {
    const item = line.code ? null : CHECKBOX.exec(line.text)
    if (item) {
      last = { text: (item[2] ?? '').trim(), checked: item[1] !== ' ' }
      into.push(last)
    } else if (last !== null && isContinuation(line)) {
      last.text = `${last.text} ${line.text.trim()}`
    } else {
      last = null
      kept.push(line)
      continue
    }
    kept.push(BREAK)
  }
  return kept
}

function checkedCriteria(criteria: BoardCriterion[]): BoardCriterion[] {
  const kept = criteria.filter((criterion) => criterion.text !== '')
  if (kept.length > LIMITS.criteria) {
    skip(`has more than ${LIMITS.criteria} acceptance criteria`)
  }
  if (kept.some((criterion) => criterion.text.length > LIMITS.shortText)) {
    skip(`has an acceptance criterion longer than ${LIMITS.shortText} characters`)
  }
  return kept
}

/** Sub-ticket numbers of epic `epicNo` named on explicit "Depends on" lines. */
function statedDependencies(lines: Line[], epicNo: number): number[] {
  return lines
    .filter((line) => !line.code && DEPENDS_ON.test(line.text))
    .flatMap((line) => [...line.text.matchAll(TICKET_ID)])
    .filter((match) => Number(match[1]) === epicNo)
    .map((match) => Number(match[2]))
}

interface TicketContent {
  body: string
  criteria: BoardCriterion[]
  dependsOn: number[]
}

function readTicketContent(lines: Line[], epicNo: number): TicketContent {
  const criteria: BoardCriterion[] = []
  const rest = cutSections(
    lines,
    (heading) => CRITERIA_HEADING.test(heading.text),
    (section) => takeCriteria(section, criteria)
  )
  return { body: render(rest), criteria: checkedCriteria(criteria), dependsOn: statedDependencies(lines, epicNo) }
}

function checkedTitle(title: string): string {
  const trimmed = title.trim()
  if (trimmed === '') {
    skip('has an empty title')
  }
  if (trimmed.length > LIMITS.title) {
    skip(`has a title longer than ${LIMITS.title} characters`)
  }
  return trimmed
}

function isBoardFolder(value: string | undefined): value is BoardFolder {
  return (BOARD_FOLDERS as readonly string[]).includes(value ?? '')
}

interface Document {
  path: string
  folder: BoardFolder
  epicNo: number
  epicId: string
  /** The sub-ticket a `NNN.M` file holds; null for an `NNN` file. */
  sub: { no: number; id: string } | null
  /** The `# ` title line's text. */
  title: string
  /** Everything after the title line. */
  lines: Line[]
}

function decodeText(text: string): string {
  if (text.length > MAX_BOARD_FILE_BYTES || encoder.encode(text).byteLength > MAX_BOARD_FILE_BYTES) {
    skip(`is larger than the ${MAX_BOARD_FILE_BYTES / 1024} KiB board file limit`)
  }
  if (text.includes('\u0000')) {
    skip('is not a text file')
  }
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
}

/** Where a path sits on the board, from `board/<folder>/<NNN[.M]-slug>.md`. */
function locate(path: string): Pick<Document, 'path' | 'folder' | 'epicNo' | 'epicId' | 'sub'> {
  const [root, folder, name, ...deeper] = path.split('/')
  if (root !== 'board' || !isBoardFolder(folder) || name === undefined || deeper.length > 0) {
    skip('is not in board/backlog, board/in-progress or board/done')
  }
  const match = FILE_NAME.exec(name) ?? skip('is not named like a board ticket (NNN-slug.md or NNN.M-slug.md)')
  const epicId = match[1] ?? ''
  const sub = match[2] === undefined ? null : { no: Number(match[2]), id: `${epicId}.${match[2]}` }
  return { path, folder, epicNo: Number(epicId), epicId, sub }
}

function readDocument(file: BoardFile): Document {
  const location = locate(file.path)
  const lines = scanLines(decodeText(file.text))
  const first = lines.findIndex((line) => !isBlank(line))
  const heading = lines[first]?.heading
  if (heading?.level !== 1) {
    skip('does not start with a `# ` title line')
  }
  return { ...location, title: heading.text, lines: lines.slice(first + 1) }
}

function idMismatch(doc: Document): never {
  return skip(`has a title that does not start with its id ${doc.sub?.id ?? doc.epicId}`)
}

interface ParsedTicket {
  subNo: number
  boardId: string
  title: string
  content: TicketContent
  folder: BoardFolder
  sourcePath: string
}

interface ParsedEpicFile {
  doc: Document
  /** Titled `# EPIC:`; otherwise an epic only when the board has sub-tickets for it. */
  explicit: boolean
  title: string
  content: TicketContent
  collapsed: ParsedTicket[]
}

/** The title of an `NNN` file that is not `# EPIC:`: `# NNN — Title`, or any other plain title. */
function numberedTitle(doc: Document): string {
  if (SUB_TITLE.test(doc.title)) {
    idMismatch(doc)
  }
  const numbered = NUMBERED_TITLE.exec(doc.title)
  if (numbered === null) {
    return checkedTitle(doc.title)
  }
  return Number(numbered[1]) === doc.epicNo ? checkedTitle(numbered[2] ?? '') : idMismatch(doc)
}

/** A `### NNN.M Title` section under `## Sub-tickets`, or null for any other part of it. */
function collapsedTicket(chunk: Line[], owner: Document): ParsedTicket | null {
  const heading = chunk[0]?.heading
  const match = heading?.level === 3 ? SUB_TITLE.exec(heading.text) : null
  if (!match) {
    return null
  }
  const boardId = `${match[1]}.${match[2]}`
  if (Number(match[1]) !== owner.epicNo) {
    skip(`has sub-ticket ${boardId} under epic ${owner.epicId}`)
  }
  return {
    subNo: Number(match[2]),
    boardId,
    title: checkedTitle(match[3] ?? ''),
    content: readTicketContent(chunk.slice(1), owner.epicNo),
    folder: owner.folder,
    sourcePath: owner.path
  }
}

/** Moves the collapsed sub-tickets of a `## Sub-tickets` section into `into`; other text stays. */
function takeSubTickets(section: Line[], owner: Document, into: ParsedTicket[]): Line[] {
  const kept: Line[] = [BREAK]
  const content = section.slice(1)
  let index = 0
  while (index < content.length) {
    const end = sectionEnd(content, index, 3)
    const chunk = content.slice(index, end)
    const ticket = collapsedTicket(chunk, owner)
    if (ticket === null) {
      kept.push(...chunk)
    } else if (into.some((item) => item.subNo === ticket.subNo)) {
      skip(`has sub-ticket ${ticket.boardId} twice`)
    } else {
      into.push(ticket)
    }
    index = end
  }
  return kept
}

function readEpicFile(doc: Document): ParsedEpicFile {
  const epic = EPIC_TITLE.exec(doc.title)
  const title = epic ? checkedTitle(epic[1] ?? '') : numberedTitle(doc)
  const collapsed: ParsedTicket[] = []
  const lines = cutSections(
    doc.lines,
    (heading) => heading.level === 2 && SUBTICKETS_HEADING.test(heading.text),
    (section) => takeSubTickets(section, doc, collapsed)
  )
  return { doc, explicit: epic !== null, title, content: readTicketContent(lines, doc.epicNo), collapsed }
}

function readSubTicketFile(doc: Document, sub: { no: number; id: string }): ParsedTicket {
  const match = SUB_TITLE.exec(doc.title)
  if (match === null || Number(match[1]) !== doc.epicNo || Number(match[2]) !== sub.no) {
    idMismatch(doc)
  }
  return {
    subNo: sub.no,
    boardId: sub.id,
    title: checkedTitle(match[3] ?? ''),
    content: readTicketContent(doc.lines, doc.epicNo),
    folder: doc.folder,
    sourcePath: doc.path
  }
}

type ParsedFile =
  | { kind: 'epic'; epic: ParsedEpicFile }
  | { kind: 'ticket'; epicNo: number; epicId: string; ticket: ParsedTicket }

function readBoardFile(file: BoardFile): ParsedFile {
  const doc = readDocument(file)
  if (doc.sub === null) {
    return { kind: 'epic', epic: readEpicFile(doc) }
  }
  return { kind: 'ticket', epicNo: doc.epicNo, epicId: doc.epicId, ticket: readSubTicketFile(doc, doc.sub) }
}

interface Group {
  epicNo: number
  epicId: string
  epicFile: ParsedEpicFile | null
  tickets: Map<number, ParsedTicket>
}

function groupOf(groups: Map<number, Group>, epicNo: number, epicId: string): Group {
  const existing = groups.get(epicNo)
  if (existing !== undefined) {
    return existing
  }
  const group: Group = { epicNo, epicId, epicFile: null, tickets: new Map() }
  groups.set(epicNo, group)
  return group
}

function addEpicFile(group: Group, file: ParsedEpicFile, skipped: SkippedBoardFile[]): void {
  if (group.epicFile !== null) {
    skipped.push({ path: file.doc.path, reason: `repeats epic ${group.epicId}, already read from ${group.epicFile.doc.path}` })
    return
  }
  group.epicFile = file
  for (const ticket of file.collapsed) {
    group.tickets.set(ticket.subNo, ticket)
  }
}

function addTicketFile(group: Group, ticket: ParsedTicket, skipped: SkippedBoardFile[]): void {
  const existing = group.tickets.get(ticket.subNo)
  if (existing !== undefined) {
    skipped.push({ path: ticket.sourcePath, reason: `repeats sub-ticket ${ticket.boardId}, already read from ${existing.sourcePath}` })
    return
  }
  group.tickets.set(ticket.subNo, ticket)
}

/** Groups by epic number: epic files first, so their collapsed sub-tickets win over loose copies. */
function groupFiles(parsed: ParsedFile[], skipped: SkippedBoardFile[]): Group[] {
  const groups = new Map<number, Group>()
  for (const item of parsed) {
    if (item.kind === 'epic') {
      addEpicFile(groupOf(groups, item.epic.doc.epicNo, item.epic.doc.epicId), item.epic, skipped)
    }
  }
  for (const item of parsed) {
    if (item.kind === 'ticket') {
      addTicketFile(groupOf(groups, item.epicNo, item.epicId), item.ticket, skipped)
    }
  }
  return [...groups.values()].sort((a, b) => a.epicNo - b.epicNo)
}

function boardTicket(ticket: ParsedTicket, group: Group): BoardTicket {
  const dependsOn = [...new Set(ticket.content.dependsOn)]
    .filter((subNo) => subNo !== ticket.subNo)
    .map((subNo) => group.tickets.get(subNo)?.boardId)
    .filter((boardId) => boardId !== undefined)
  const { body, criteria } = ticket.content
  return { boardId: ticket.boardId, title: ticket.title, body, criteria, folder: ticket.folder, sourcePath: ticket.sourcePath, dependsOn }
}

function sourcePathsOf(epicPath: string | null, tickets: BoardTicket[]): string[] {
  return [...new Set([...(epicPath === null ? [] : [epicPath]), ...tickets.map((ticket) => ticket.sourcePath)])]
}

function folderOf(tickets: BoardTicket[]): BoardFolder {
  const [first, ...others] = tickets.map((ticket) => ticket.folder)
  return first !== undefined && others.every((folder) => folder === first) ? first : 'in-progress'
}

function standaloneEpic(file: ParsedEpicFile): BoardEpic {
  const { doc, title, content } = file
  const ticket: BoardTicket = {
    boardId: doc.epicId,
    title,
    body: content.body,
    criteria: content.criteria,
    folder: doc.folder,
    sourcePath: doc.path,
    dependsOn: []
  }
  const shared = { folder: doc.folder, sourcePath: doc.path, sourcePaths: [doc.path] }
  return { boardId: doc.epicId, kind: 'standalone', title, body: '', criteria: [], ...shared, tickets: [ticket] }
}

function buildEpic(group: Group): BoardEpic {
  const ordered = [...group.tickets.values()].sort((a, b) => a.subNo - b.subNo)
  const tickets = ordered.map((ticket) => boardTicket(ticket, group))
  const file = group.epicFile
  if (file === null) {
    const shared = { folder: folderOf(tickets), sourcePath: null, sourcePaths: sourcePathsOf(null, tickets) }
    return { boardId: group.epicId, kind: 'orphan', title: `Board epic ${group.epicId}`, body: '', criteria: [], ...shared, tickets }
  }
  if (!file.explicit && tickets.length === 0) {
    return standaloneEpic(file)
  }
  const { body, criteria } = file.content
  const shared = { folder: file.doc.folder, sourcePath: file.doc.path, sourcePaths: sourcePathsOf(file.doc.path, tickets) }
  return { boardId: group.epicId, kind: 'epic', title: file.title, body, criteria, ...shared, tickets }
}

/**
 * Whether the epic's import fits one `update_plan_draft` request: one edit for the sprint goal, one
 * per ticket and one per dependency (see `./plan.ts`). Otherwise every file of the epic is skipped.
 */
function fitsOneRequest(epic: BoardEpic, skipped: SkippedBoardFile[]): boolean {
  const edits = epic.tickets.reduce((sum, ticket) => sum + 1 + ticket.dependsOn.length, 1)
  if (edits <= LIMITS.opsPerRequest) {
    return true
  }
  const reason = `belongs to board epic ${epic.boardId}, which needs ${edits} plan edits to import; one request holds at most ${LIMITS.opsPerRequest}`
  skipped.push(...epic.sourcePaths.map((path) => ({ path, reason })))
  return false
}

function readFiles(files: BoardFile[], skipped: SkippedBoardFile[]): ParsedFile[] {
  const parsed: ParsedFile[] = []
  for (const file of files) {
    try {
      parsed.push(readBoardFile(file))
    } catch (error: unknown) {
      skipped.push({ path: file.path, reason: messageOf(error) })
    }
  }
  return parsed
}

/**
 * Parses board files into epics (in epic number order) and the files it skipped (in path order).
 * Each file is read on its own: one that is oversized, malformed or not a board ticket is skipped with
 * a reason, and the rest of the board still parses.
 */
export function parseBoard(files: BoardFile[]): BoardParse {
  const ordered = [...files].sort(byPath)
  const skipped: SkippedBoardFile[] = ordered
    .slice(MAX_BOARD_FILES)
    .map((file) => ({ path: file.path, reason: `is beyond the ${MAX_BOARD_FILES}-file board limit` }))
  const groups = groupFiles(readFiles(ordered.slice(0, MAX_BOARD_FILES), skipped), skipped)
  const epics = groups.map(buildEpic).filter((epic) => fitsOneRequest(epic, skipped))
  return { epics, skipped: skipped.sort(byPath) }
}
