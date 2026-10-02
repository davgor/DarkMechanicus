/**
 * Reads an old-style Markdown `/board` for the pure parser in `../board/parse.ts`. Read-only: it lists
 * `board/backlog`, `board/in-progress` and `board/done` and reads their `.md` files within the board
 * limits, ignoring dot entries such as `.gitkeep`. A link is refused, never followed, and so is a
 * folder or file that resolves outside `board/`. Each refusal is reported as a skipped file.
 */
import { join } from 'node:path'
import {
  BOARD_FOLDERS,
  type BoardFile,
  type BoardParse,
  MAX_BOARD_FILE_BYTES,
  parseBoard,
  type SkippedBoardFile
} from '../board/parse'
import { isStrictlyInside } from './paths'
import type { FsAdapter } from './types'

/** Entries one board folder may hold before it is refused unread; three such folders stay within `MAX_BOARD_FILES`. */
export const MAX_BOARD_FOLDER_ENTRIES = 1_000

const BOARD_DIR = 'board'

interface BoardRead {
  fs: FsAdapter
  /** Real path of `board/`, which every folder and file must resolve inside. */
  realBoard: string
  files: BoardFile[]
  skipped: SkippedBoardFile[]
}

/** Why `dir` cannot be listed as part of the board, or null when it can; `within` names `realBase`. */
function directoryProblem(fs: FsAdapter, dir: string, realBase: string, within: string): string | null {
  if (fs.isSymlink(dir)) {
    return 'is a link'
  }
  if (!fs.isDirectory(dir)) {
    return 'is not a directory'
  }
  return isStrictlyInside(realBase, fs.realpath(dir)) ? null : `resolves outside ${within}`
}

/** Why the folder entry `file` is not read, or null when it is a Markdown file to read. */
function entryProblem(read: BoardRead, file: string): string | null {
  if (read.fs.isSymlink(file)) {
    return 'is a link'
  }
  if (read.fs.isDirectory(file)) {
    return 'is a directory'
  }
  if (!file.toLowerCase().endsWith('.md')) {
    return 'is not a Markdown file'
  }
  if (!isStrictlyInside(read.realBoard, read.fs.realpath(file))) {
    return 'resolves outside the board folder'
  }
  return read.fs.fileSize(file) > MAX_BOARD_FILE_BYTES
    ? `is larger than the ${MAX_BOARD_FILE_BYTES / 1024} KiB board file limit`
    : null
}

function readEntry(read: BoardRead, file: string, shown: string): void {
  try {
    const problem = entryProblem(read, file)
    if (problem === null) {
      read.files.push({ path: shown, text: read.fs.readFile(file) })
    } else {
      read.skipped.push({ path: shown, reason: problem })
    }
  } catch {
    read.skipped.push({ path: shown, reason: 'could not be read' })
  }
}

function folderEntries(read: BoardRead, dir: string): string[] | string {
  const problem = directoryProblem(read.fs, dir, read.realBoard, 'the board folder')
  if (problem !== null) {
    return problem
  }
  const entries = read.fs
    .readdir(dir)
    .filter((entry) => !entry.startsWith('.'))
    .sort()
  return entries.length > MAX_BOARD_FOLDER_ENTRIES ? `holds more than ${MAX_BOARD_FOLDER_ENTRIES} entries` : entries
}

function readFolder(read: BoardRead, dir: string, shown: string): void {
  if (!read.fs.exists(dir) && !read.fs.isSymlink(dir)) {
    return
  }
  let entries: string[] | string
  try {
    entries = folderEntries(read, dir)
  } catch {
    entries = 'could not be listed'
  }
  if (typeof entries === 'string') {
    read.skipped.push({ path: shown, reason: entries })
    return
  }
  for (const entry of entries) {
    readEntry(read, join(dir, entry), `${shown}/${entry}`)
  }
}

function byPath(a: SkippedBoardFile, b: SkippedBoardFile): number {
  if (a.path === b.path) {
    return 0
  }
  return a.path < b.path ? -1 : 1
}

/**
 * The repository's `board/`, parsed into epics. Files this reader refuses and files the parser skips
 * are reported together in path order; a repository without a board has an empty one.
 */
export function readBoard(root: string, fs: FsAdapter): BoardParse {
  const board = join(root, BOARD_DIR)
  if (!fs.exists(board) && !fs.isSymlink(board)) {
    return { epics: [], skipped: [] }
  }
  let problem: string | null
  try {
    problem = directoryProblem(fs, board, fs.realpath(root), 'the repository')
  } catch {
    problem = 'could not be listed'
  }
  if (problem !== null) {
    return { epics: [], skipped: [{ path: BOARD_DIR, reason: problem }] }
  }
  const read: BoardRead = { fs, realBoard: fs.realpath(board), files: [], skipped: [] }
  for (const folder of BOARD_FOLDERS) {
    readFolder(read, join(board, folder), `${BOARD_DIR}/${folder}`)
  }
  const parsed = parseBoard(read.files)
  return { epics: parsed.epics, skipped: [...read.skipped, ...parsed.skipped].sort(byPath) }
}
