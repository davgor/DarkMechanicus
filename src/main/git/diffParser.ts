/** Parses one file's unified diff, as `git diff` prints it, into the renderer-safe `FileDiff`. Pure. */
import { createHash } from 'node:crypto'
import type { DiffHunk, DiffLine, FileDiff } from '../../shared/git/diff'

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const QUOTE_ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', a: '\u0007', b: '\b', f: '\f', v: '\v' }

/** The bytes for the escape that starts at `body[at]` (a backslash), and how many characters it used. */
function readEscape(body: string, at: number): { bytes: number[]; used: number } {
  const octal = /^[0-7]{1,3}/.exec(body.slice(at + 1))
  if (octal !== null) {
    return { bytes: [parseInt(octal[0], 8)], used: 1 + octal[0].length }
  }
  const ch = body[at + 1] ?? ''
  return { bytes: [...Buffer.from(QUOTE_ESCAPES[ch] ?? ch, 'utf8')], used: 2 }
}

/** Git quotes a path holding unusual characters in C style: `"a\tb"`, with octal escapes for raw bytes. */
function unquote(path: string): string {
  if (!(path.length >= 2 && path.startsWith('"') && path.endsWith('"'))) {
    return path
  }
  const body = path.slice(1, -1)
  const bytes: number[] = []
  let at = 0
  while (at < body.length) {
    if (body[at] === '\\') {
      const escape = readEscape(body, at)
      bytes.push(...escape.bytes)
      at += escape.used
    } else {
      const char = String.fromCodePoint(body.codePointAt(at) ?? 0)
      bytes.push(...Buffer.from(char, 'utf8'))
      at += char.length
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/** `a/x` and `b/x` become `x`; `/dev/null` becomes null. */
function stripSide(raw: string): string | null {
  const path = unquote(raw.replace(/\t.*$/, ''))
  if (path === '/dev/null') {
    return null
  }
  return /^[ab]\//.test(path) ? path.slice(2) : path
}

/** The new path out of a `diff --git a/x b/x` line, for diffs that have no `---`/`+++` lines. */
function pathFromGitHeader(line: string): string | null {
  const rest = line.slice('diff --git '.length)
  const quoted = /^(?:.* )?("b\/(?:[^"\\]|\\.)*")$/.exec(rest)
  if (quoted !== null) {
    return stripSide(quoted[1])
  }
  // Both sides are the same path unless the file was renamed, which the `rename to` line then corrects.
  const half = (rest.length - 1) / 2
  if (Number.isInteger(half) && rest[half] === ' ' && rest.slice(2, half) === rest.slice(half + 3)) {
    return rest.slice(half + 3)
  }
  const at = rest.lastIndexOf(' b/')
  return at === -1 ? null : rest.slice(at + 3)
}

interface Collected {
  path: string | null
  oldPath: string | null
  oldMode: string | null
  newMode: string | null
  indexMode: string | null
  binary: boolean
  hunks: DiffHunk[]
}

type HeaderRule = readonly [RegExp, (found: Collected, value: string) => void]

/** The extended header lines, one rule each: a pattern whose first group is the value. */
const HEADER_RULES: readonly HeaderRule[] = [
  [/^(?:rename|copy) from (.*)$/, (found, value) => void (found.oldPath = unquote(value))],
  [/^(?:rename|copy) to (.*)$/, (found, value) => void (found.path = unquote(value))],
  [/^(?:old mode|deleted file mode) (\d+)/, (found, value) => void (found.oldMode ??= value)],
  [/^(?:new mode|new file mode) (\d+)/, (found, value) => void (found.newMode = value)],
  [/^index \S+ (\d{6})$/, (found, value) => void (found.indexMode = value)],
  [/^--- (.*)$/, (found, value) => void (found.path ??= stripSide(value))],
  [/^\+\+\+ (.*)$/, (found, value) => void (found.path = stripSide(value) ?? found.path)],
  [/^(Binary files .* differ|GIT binary patch)$/, (found) => void (found.binary = true)]
]

function readHeader(line: string, found: Collected): void {
  for (const [pattern, apply] of HEADER_RULES) {
    const match = pattern.exec(line)
    if (match !== null) {
      apply(found, match[1])
      return
    }
  }
}

/** A hunk being read: hands out line numbers and knows when the hunk's counts are used up. */
class HunkReader {
  private oldNumber: number
  private newNumber: number
  private oldLeft: number
  private newLeft: number

  constructor(readonly hunk: DiffHunk) {
    this.oldNumber = hunk.oldStart
    this.newNumber = hunk.newStart
    this.oldLeft = hunk.oldLines
    this.newLeft = hunk.newLines
  }

  get open(): boolean {
    return this.oldLeft > 0 || this.newLeft > 0
  }

  /** Takes a hunk body line; false when the line is not one. */
  add(line: string): boolean {
    const marker = line[0] ?? ' '
    const text = line.slice(1)
    const entry = this.entry(marker, text)
    if (entry === null) {
      return false
    }
    this.hunk.lines.push(entry)
    return true
  }

  private entry(marker: string, text: string): DiffLine | null {
    const oldNumber = this.oldNumber
    const newNumber = this.newNumber
    if (marker === ' ') {
      this.oldNumber += 1
      this.newNumber += 1
      this.oldLeft -= 1
      this.newLeft -= 1
      return { kind: 'context', text, oldNumber, newNumber, noNewlineAtEnd: false }
    }
    if (marker === '-') {
      this.oldNumber += 1
      this.oldLeft -= 1
      return { kind: 'delete', text, oldNumber, newNumber: null, noNewlineAtEnd: false }
    }
    if (marker === '+') {
      this.newNumber += 1
      this.newLeft -= 1
      return { kind: 'add', text, oldNumber: null, newNumber, noNewlineAtEnd: false }
    }
    return null
  }

  markNoNewline(): void {
    const last = this.hunk.lines[this.hunk.lines.length - 1]
    if (last !== undefined) {
      last.noNewlineAtEnd = true
    }
  }
}

function startHunk(line: string): HunkReader | null {
  const match = HUNK_HEADER.exec(line)
  if (match === null) {
    return null
  }
  return new HunkReader({
    header: line,
    oldStart: Number(match[1]),
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newLines: match[4] === undefined ? 1 : Number(match[4]),
    lines: []
  })
}

/** Splits on newlines only, so a trailing carriage return stays; the text after the final newline is not a line. */
function splitLines(raw: string): string[] {
  const lines = raw.split('\n')
  return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
}

function collect(raw: string): Collected & { headerPath: string | null } {
  const found: Collected & { headerPath: string | null } = { path: null, oldPath: null, oldMode: null, newMode: null, indexMode: null, binary: false, hunks: [], headerPath: null }
  let current: HunkReader | null = null
  for (const line of splitLines(raw)) {
    if (current?.open === true && current.add(line)) {
      continue
    }
    if (line.startsWith('\\') && current !== null) {
      current.markNoNewline()
      continue
    }
    const started = startHunk(line)
    if (started !== null) {
      found.hunks.push(started.hunk)
      current = started
      continue
    }
    current = null
    if (line.startsWith('diff --git ')) {
      found.headerPath ??= pathFromGitHeader(line)
    } else {
      readHeader(line, found)
    }
  }
  return found
}

export function parseUnifiedDiff(raw: string): FileDiff {
  const found = collect(raw)
  const path = found.path ?? found.headerPath ?? ''
  const hasModeHeader = found.oldMode !== null || found.newMode !== null
  const base = {
    path,
    oldPath: found.oldPath !== null && found.oldPath !== path ? found.oldPath : null,
    oldMode: hasModeHeader ? found.oldMode : found.indexMode,
    newMode: hasModeHeader ? found.newMode : found.indexMode,
    hash: createHash('sha1').update(raw).digest('hex')
  }
  if (found.binary) {
    return { ...base, kind: 'binary' }
  }
  return found.hunks.length > 0 ? { ...base, kind: 'text', hunks: found.hunks } : { ...base, kind: 'empty' }
}
