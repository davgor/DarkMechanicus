/**
 * Decides what removing an old-style `/board` workflow deletes: `board/` and the board-only skill
 * folders (`complete-ticket`, `collapse-epic` under `.claude/skills/` and `.cursor/skills/`), and which
 * instruction files still mention the board and must be edited by hand instead.
 *
 * Pure: it works on what the file layer (`../../main/desktop/boardRemovalFiles.ts`) found, walked
 * without following links, as repository-relative paths with forward slashes. A skill folder is a
 * candidate only when its name matches and its `SKILL.md` refers to the board. Links are never
 * candidates, and files outside the candidate folders never are, whatever they mention.
 */
import type { BoardKeptPathView, BoardMentionView, BoardRemovalView } from '../../shared/domain/views'

const BOARD_ROOT = 'board'
const BOARD_SKILL_NAMES = ['complete-ticket', 'collapse-epic'] as const

/** Where agent skills live; each folder is also searched for other skills that mention the board. */
export const SKILL_FOLDERS = ['.claude/skills', '.cursor/skills'] as const

/** Instruction files at the repository root that may still describe the board workflow. */
export const INSTRUCTION_FILES = ['README.md', '.ai-instructions.md', 'AGENTS.md', 'CLAUDE.md'] as const

/** Folders of editor rules (`.md` and `.mdc` files) that may still describe the board workflow. */
export const RULE_FOLDERS = ['.cursor/rules'] as const

/** The only folders the removal deletes from: `board/` and each board skill folder. */
export const REMOVAL_ROOTS: readonly string[] = [
  BOARD_ROOT,
  ...SKILL_FOLDERS.flatMap((folder) => BOARD_SKILL_NAMES.map((name) => `${folder}/${name}`))
]

/** The skill file a board skill folder is recognized by. */
export const SKILL_FILE = 'SKILL.md'

export const LINK_REASON = 'is a link; links are never followed or deleted'
const STRAY_REASON = 'is not one of the files to remove'
const UNCONFIRMED_REASON = 'was not on the confirmed list'

/** A path as `lstat` sees it: a link is reported as a link and never followed. */
export type RemovalEntryKind = 'file' | 'directory' | 'link' | 'other'

export interface RemovalEntry {
  path: string
  kind: RemovalEntryKind
}

interface RemovalText {
  path: string
  text: string
}

/** What the file layer found. */
export interface RemovalScan {
  /** Each removal root that exists and every entry below it, except below links. */
  entries: RemovalEntry[]
  /** Skill files of the removal roots, and instruction files that may mention the board. */
  texts: RemovalText[]
  /** Paths the file layer would not or could not look into, and why. */
  problems: BoardKeptPathView[]
}

interface BoardRemovalPlan extends BoardRemovalView {
  /** Folders of the removed roots, roots included, each before its parent: removed once empty. */
  folders: string[]
}

/** Text that refers to the board folder itself: `/board`, or one of `board/backlog|in-progress|done`. */
const REFERS_TO_BOARD = /\/board\b|\bboard\/(?:backlog|in-progress|done)\b/
/** Any mention of the board, such as "Board / TDD gate", but not "dashboard" or "onboarding". */
const MENTIONS_BOARD = /\bboard\b/i

/** Whether a skill's text refers to the `/board` folder, which marks it as a board-only skill. */
export function refersToBoard(text: string): boolean {
  return REFERS_TO_BOARD.test(text)
}

/** The 1-based numbers of the lines that mention the board. */
export function boardMentionLines(text: string): number[] {
  return text.split(/\r?\n/).flatMap((line, index) => (MENTIONS_BOARD.test(line) ? [index + 1] : []))
}

function isBelow(root: string, path: string): boolean {
  return path.startsWith(`${root}/`)
}

function byPath(a: { path: string }, b: { path: string }): number {
  if (a.path === b.path) {
    return 0
  }
  return a.path < b.path ? -1 : 1
}

function depth(path: string): number {
  return path.split('/').length
}

/** Deepest first, so every folder comes before its parent; equally deep folders in path order. */
function deepestFirst(a: string, b: string): number {
  return depth(b) - depth(a) || byPath({ path: a }, { path: b })
}

/** Why `root` is not removed, or null when it is a candidate. */
function rootRefusal(root: string, kind: RemovalEntryKind, texts: ReadonlyMap<string, string>): string | null {
  if (kind === 'link') {
    return LINK_REASON
  }
  if (kind !== 'directory') {
    return 'is not a folder'
  }
  if (root === BOARD_ROOT) {
    return null
  }
  const skill = texts.get(`${root}/${SKILL_FILE}`)
  if (skill === undefined) {
    return `has no ${SKILL_FILE} to recognize it by`
  }
  return refersToBoard(skill) ? null : `its ${SKILL_FILE} does not refer to the board`
}

interface PlanParts {
  remove: string[]
  kept: BoardKeptPathView[]
  folders: string[]
}

function planRoot(parts: PlanParts, root: string, entries: readonly RemovalEntry[]): void {
  for (const entry of entries.filter((item) => isBelow(root, item.path))) {
    if (entry.kind === 'file') {
      parts.remove.push(entry.path)
    } else if (entry.kind === 'directory') {
      parts.folders.push(entry.path)
    } else {
      parts.kept.push({ path: entry.path, reason: entry.kind === 'link' ? LINK_REASON : 'is not a regular file' })
    }
  }
  parts.folders.push(root)
}

function mentions(texts: readonly RemovalText[], removedRoots: readonly string[]): BoardMentionView[] {
  return texts
    .filter(({ path }) => !removedRoots.some((root) => isBelow(root, path)))
    .map(({ path, text }) => ({ path, lines: boardMentionLines(text) }))
    .filter((mention) => mention.lines.length > 0)
    .sort(byPath)
}

/** Every file to delete, every path left in place and why, and the files to edit by hand. */
export function planBoardRemoval(scan: RemovalScan): BoardRemovalPlan {
  const kinds = new Map(scan.entries.map((entry) => [entry.path, entry.kind]))
  const texts = new Map(scan.texts.map((text) => [text.path, text.text]))
  const parts: PlanParts = { remove: [], kept: [...scan.problems], folders: [] }
  const removedRoots: string[] = []
  for (const root of REMOVAL_ROOTS) {
    const kind = kinds.get(root)
    if (kind === undefined) {
      continue
    }
    const refusal = rootRefusal(root, kind, texts)
    if (refusal === null) {
      removedRoots.push(root)
      planRoot(parts, root, scan.entries)
    } else {
      parts.kept.push({ path: root, reason: refusal })
    }
  }
  return {
    remove: parts.remove.sort(),
    kept: parts.kept.sort(byPath),
    editByHand: mentions(scan.texts, removedRoots),
    folders: parts.folders.sort(deepestFirst)
  }
}

/**
 * The files to delete now: those both confirmed and still in `plan`. A planned file that was not
 * confirmed (it appeared after the list was shown) and a confirmed path that is no file to remove are
 * left in place and reported, unless the plan already reports that path with its own reason.
 */
export function confirmedRemoval(
  plan: BoardRemovalView,
  confirmed: readonly string[]
): { remove: string[]; kept: BoardKeptPathView[] } {
  const wanted = new Set(confirmed)
  const planned = new Set(plan.remove)
  const reported = new Set(plan.kept.map((kept) => kept.path))
  const unconfirmed = plan.remove.filter((path) => !wanted.has(path)).map((path) => ({ path, reason: UNCONFIRMED_REASON }))
  const strays = [...wanted]
    .filter((path) => !planned.has(path) && !reported.has(path))
    .map((path) => ({ path, reason: STRAY_REASON }))
  return { remove: plan.remove.filter((path) => wanted.has(path)), kept: [...unconfirmed, ...strays].sort(byPath) }
}
