/**
 * What importing a parsed `/board` (`./parse.ts`) does, without the database or the file system:
 * which epics are open, the command inputs each open epic maps to, and how an earlier import of the
 * same board epic is recognized. Pure, like the parser and `./plan.ts`.
 *
 * Only open epics (their file in `board/backlog` or `board/in-progress`) are imported. Their
 * sub-tickets that already sit in `board/done` are named in the intent instead of becoming tickets,
 * so the draft holds only open work.
 *
 * A board epic is the same source across imports when it keeps its epic file name, whatever folder
 * the file moved to (`file:014-cross-host-release.md`); an epic without a file is named by its number
 * (`orphan:090`). Its ticket files name it too, so an import stays recognizable from its tickets'
 * references after the import note was edited out of the intent.
 */
import type { CreateEpicInput, DraftOp } from '../../shared/domain/api'
import type { BoardImportView, BoardOpenEpicView } from '../../shared/domain/views'
import { LIMITS } from '../schemas'
import type { BoardEpic, BoardParse, BoardTicket } from './parse'
import { boardEpicImport } from './plan'

type BoardTicketRef = BoardOpenEpicView['doneTickets'][number]

/** What one open board epic maps to: `create_epic` input, the draft ops, and the done sub-tickets it names. */
interface OpenBoardEpicImport {
  createEpic: CreateEpicInput
  ops: DraftOp[]
  doneTickets: BoardTicketRef[]
}

/** What became of one open epic: created now, created by an earlier import, or (in a preview) not yet. */
type BoardEpicOutcome = Pick<BoardOpenEpicView, 'state' | 'epicId'>

const DONE_HEADING = 'Already done on the board, so not imported as tickets:'
/** The import notes `./plan.ts` writes at the end of an imported epic's intent. */
const FILE_NOTE = /Imported from the \/board file `board\/[^`/]+\/([^`/]+)`/g
const ORPHAN_NOTE = /Imported from \/board epic (\d+), which has no epic file/g
const BOARD_LOCATION = /^board\/[^/]+\/([^/]+)$/

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function fileSource(name: string): string {
  return `file:${name}`
}

function isOpenBoardEpic(epic: BoardEpic): boolean {
  return epic.folder !== 'done'
}

/** Every key an earlier import of `epic` may be recorded under; the first is the epic's own. */
export function boardSourceKeys(epic: BoardEpic): string[] {
  const own = epic.sourcePath === null ? [`orphan:${epic.boardId}`] : []
  return [...new Set([...own, ...epic.sourcePaths.map((path) => fileSource(fileName(path)))])]
}

/** The source keys the import notes in an epic intent name. */
export function recordedBoardSources(intent: string): string[] {
  return [
    ...[...intent.matchAll(FILE_NOTE)].map((match) => fileSource(match[1] ?? '')),
    ...[...intent.matchAll(ORPHAN_NOTE)].map((match) => `orphan:${match[1] ?? ''}`)
  ]
}

/** The source key of a board ticket reference's location, or null for a location outside the board. */
export function boardReferenceSource(location: string): string | null {
  const match = BOARD_LOCATION.exec(location)
  return match === null ? null : fileSource(match[1] ?? '')
}

function ticketRef(ticket: BoardTicket): BoardTicketRef {
  return { boardId: ticket.boardId, title: ticket.title, sourcePath: ticket.sourcePath }
}

/** The done sub-tickets as a Markdown list of at most `room` characters, cut short with a count when needed. */
function doneSection(done: BoardTicket[], room: number): string {
  const lines = done.map((ticket) => `- ${ticket.boardId} ${ticket.title} (\`${ticket.sourcePath}\`)`)
  let used = DONE_HEADING.length + 1
  let shown = 0
  for (const line of lines) {
    const rest = lines.length - shown - 1
    const more = rest > 0 ? `\n- …and ${rest} more`.length : 0
    if (used + 1 + line.length + more > room) {
      break
    }
    used += 1 + line.length
    shown += 1
  }
  const more = shown < lines.length ? [`- …and ${lines.length - shown} more`] : []
  return [DONE_HEADING, '', ...lines.slice(0, shown), ...more].join('\n')
}

/**
 * `create_epic` input and `update_plan_draft` ops for an open board epic: its open tickets only, with
 * the sub-tickets already done named in the intent ahead of the import note.
 */
export function openBoardEpicImport(epic: BoardEpic): OpenBoardEpicImport {
  const open = epic.tickets.filter((ticket) => ticket.folder !== 'done')
  const done = epic.tickets.filter((ticket) => ticket.folder === 'done')
  const plain = boardEpicImport({ ...epic, tickets: open })
  if (done.length === 0) {
    return { ...plain, doneTickets: [] }
  }
  const room = LIMITS.markdown - (plain.createEpic.intent ?? '').length - 2
  const body = [epic.body, doneSection(done, room)].filter((part) => part !== '').join('\n\n')
  return { ...boardEpicImport({ ...epic, body, tickets: open }), doneTickets: done.map(ticketRef) }
}

function openView(epic: BoardEpic, outcome: BoardEpicOutcome): BoardOpenEpicView {
  return {
    boardId: epic.boardId,
    kind: epic.kind,
    title: epic.title,
    folder: epic.folder,
    sourcePath: epic.sourcePath,
    sourcePaths: epic.sourcePaths,
    ticketCount: epic.tickets.filter((ticket) => ticket.folder !== 'done').length,
    doneTickets: epic.tickets.filter((ticket) => ticket.folder === 'done').map(ticketRef),
    ...outcome
  }
}

/**
 * The board as an import sees it. `outcomeOf` is asked about each open epic in board order, and says
 * whether it is new, was imported earlier, or (during an import) has just been created.
 */
export function boardImportView(board: BoardParse, outcomeOf: (epic: BoardEpic) => BoardEpicOutcome): BoardImportView {
  return {
    open: board.epics.filter(isOpenBoardEpic).map((epic) => openView(epic, outcomeOf(epic))),
    done: board.epics
      .filter((epic) => !isOpenBoardEpic(epic))
      .map((epic) => ({
        boardId: epic.boardId,
        title: epic.title,
        sourcePath: epic.sourcePath,
        sourcePaths: epic.sourcePaths,
        ticketCount: epic.tickets.length
      })),
    skipped: board.skipped
  }
}
