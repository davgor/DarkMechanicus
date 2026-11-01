/**
 * Builds the patch that commits only some lines of a file's working diff against HEAD, for `git apply --cached`.
 * Pure. The old side of every hunk is kept whole (it is HEAD), so only the new side changes: unselected additions
 * are dropped and unselected deletions stay as context.
 */
import { changedLineIndices, type DiffHunk, type FileDiff } from '../../shared/git/diff'

type TextDiff = Extract<FileDiff, { kind: 'text' }>

interface PatchLine {
  marker: ' ' | '-' | '+'
  text: string
  noNewlineAtEnd: boolean
}

const NO_NEWLINE = '\\ No newline at end of file'
const C_ESCAPES: Readonly<Record<string, string>> = { '\t': '\\t', '\n': '\\n', '\r': '\\r', '"': '\\"', '\\': '\\\\' }

function needsEscape(char: string): boolean {
  const code = char.charCodeAt(0)
  return char === '"' || char === '\\' || code < 0x20 || code === 0x7f
}

/** A path as git writes it in a patch: C-quoted (prefix inside the quotes) when it holds a quote, backslash or control character. */
function quotePath(prefix: string, path: string): string {
  const chars = [...`${prefix}${path}`]
  if (!chars.some(needsEscape)) {
    return chars.join('')
  }
  const escaped = chars.map((char) => (needsEscape(char) ? (C_ESCAPES[char] ?? `\\${char.charCodeAt(0).toString(8).padStart(3, '0')}`) : char))
  return `"${escaped.join('')}"`
}

/** A `---`/`+++` name; like git, a name holding a space ends with a tab. */
function sideName(prefix: string, path: string): string {
  return `${quotePath(prefix, path)}${path.includes(' ') ? '\t' : ''}`
}

/** The hunk's lines with the selection applied, or null when the hunk has no selected change. */
function selectLines(hunk: DiffHunk, indices: ReadonlyArray<number | null>, selected: ReadonlySet<number>): PatchLine[] | null {
  const out: PatchLine[] = []
  let chosenAny = false
  hunk.lines.forEach((line, at) => {
    const index = indices[at]
    const chosen = index !== null && selected.has(index)
    chosenAny ||= chosen
    if (line.kind === 'context' || (line.kind === 'delete' && !chosen)) {
      out.push({ marker: ' ', text: line.text, noNewlineAtEnd: line.noNewlineAtEnd })
    } else if (chosen) {
      out.push({ marker: line.kind === 'add' ? '+' : '-', text: line.text, noNewlineAtEnd: line.noNewlineAtEnd })
    }
  })
  return chosenAny ? withTerminatedContext(out) : null
}

/**
 * An old last line without a newline that stays as context cannot be followed by selected additions: the new side
 * needs it with a newline. It is deleted (keeping its marker) and added back terminated.
 */
function withTerminatedContext(lines: PatchLine[]): PatchLine[] {
  return lines.flatMap((line, at): PatchLine[] =>
    line.marker === ' ' && line.noNewlineAtEnd && at < lines.length - 1
      ? [{ ...line, marker: '-' }, { ...line, marker: '+', noNewlineAtEnd: false }]
      : [line]
  )
}

/** The hunk text with recomputed counts; `offset` is how many lines the earlier hunks added to the new side. */
function hunkText(oldStart: number, lines: PatchLine[], offset: number): { text: string; delta: number } {
  const oldLines = lines.filter((line) => line.marker !== '+').length
  const newLines = lines.filter((line) => line.marker !== '-').length
  // An empty range names the line before it, so the first line of each side is one past an empty range's start.
  const oldFirst = oldLines === 0 ? oldStart + 1 : oldStart
  const newFirst = oldFirst + offset
  const newStart = newLines === 0 ? newFirst - 1 : newFirst
  const body = lines.map((line) => `${line.marker}${line.text}\n${line.noNewlineAtEnd ? `${NO_NEWLINE}\n` : ''}`).join('')
  return { text: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@\n${body}`, delta: newLines - oldLines }
}

function modeLines(diff: TextDiff, createsFile: boolean, deletesFile: boolean): string[] {
  if (createsFile) {
    return [`new file mode ${diff.newMode}`]
  }
  if (deletesFile) {
    return [`deleted file mode ${diff.oldMode}`]
  }
  const changed = diff.oldMode !== null && diff.newMode !== null && diff.oldMode !== diff.newMode
  return changed ? [`old mode ${diff.oldMode}`, `new mode ${diff.newMode}`] : []
}

function headerText(diff: TextDiff, deletesFile: boolean): string {
  const oldPath = diff.oldPath ?? diff.path
  const createsFile = diff.oldMode === null && diff.newMode !== null
  const lines = [`diff --git ${quotePath('a/', oldPath)} ${quotePath('b/', diff.path)}`, ...modeLines(diff, createsFile, deletesFile)]
  if (diff.oldPath !== null) {
    lines.push(`rename from ${quotePath('', diff.oldPath)}`, `rename to ${quotePath('', diff.path)}`)
  }
  lines.push(`--- ${createsFile ? '/dev/null' : sideName('a/', oldPath)}`, `+++ ${deletesFile ? '/dev/null' : sideName('b/', diff.path)}`)
  return `${lines.join('\n')}\n`
}

/** A deleted file stays deleted only when every one of its lines is selected; otherwise it keeps the rest. */
function deletesWholeFile(diff: TextDiff, indices: ReadonlyArray<ReadonlyArray<number | null>>, selected: ReadonlySet<number>): boolean {
  if (diff.newMode !== null || diff.oldMode === null) {
    return false
  }
  return indices.every((hunk) => hunk.every((index) => index === null || selected.has(index)))
}

/**
 * The patch that applies only the `selected` changed lines (indices from `changedLineIndices`) to HEAD's version of
 * the file, written byte-exact from the diff's lines; null when no change is selected.
 */
export function buildPartialPatch(diff: TextDiff, selected: ReadonlySet<number>): string | null {
  const indices = changedLineIndices(diff)
  const hunks: string[] = []
  let offset = 0
  diff.hunks.forEach((hunk, at) => {
    const lines = selectLines(hunk, indices[at], selected)
    if (lines !== null) {
      const built = hunkText(hunk.oldStart, lines, offset)
      hunks.push(built.text)
      offset += built.delta
    }
  })
  if (hunks.length === 0) {
    return null
  }
  return `${headerText(diff, deletesWholeFile(diff, indices, selected))}${hunks.join('')}`
}
