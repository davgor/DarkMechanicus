/**
 * A small, safe Markdown parser. It produces a plain tree that `Markdown.tsx` turns into React
 * elements; it never produces HTML, so raw HTML in the source is kept as text. Links keep only
 * allow-listed targets (`http:`, `https:`, `mailto:`). Every scan is bounded so hostile input
 * cannot make parsing quadratic or recurse without limit.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'break' }

export interface ListItem {
  task: 'open' | 'done' | null
  blocks: Block[]
}

export type Block =
  | { kind: 'heading'; level: number; children: Inline[] }
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'rule' }

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** Returns the normalized URL when its scheme is allow-listed, otherwise null. */
export function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw.trim())
    return ALLOWED_PROTOCOLS.has(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// Inline parsing

const MAX_INLINE_DEPTH = 6
const MAX_TARGET = 2048
const PUNCTUATION = /^[!-/:-@[-`{-~]$/
const URI = /^[a-z][a-z0-9+.-]{1,31}:[^\s<>]*$/i
const EMAIL = /^[\w.!#$%&'*+/=?^`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*$/i
const BREAK: Inline = { kind: 'break' }

interface Scan {
  text: string
  end: number
  depth: number
  /** Smallest start position from which a search for a key already failed. */
  failed: Map<string, number>
  /** Last successful search per key: any start in [from, index] finds the same index. */
  found: Map<string, { from: number; index: number }>
}

type Step = { next: number; node: Inline } | { next: number; text: string }
type Reader = (scan: Scan, pos: number) => Step | null

class InlineBuilder {
  private readonly nodes: Inline[] = []
  private buffer = ''

  add(step: Step): void {
    if ('node' in step) {
      this.flush()
      this.nodes.push(step.node)
    } else {
      this.buffer += step.text
    }
  }

  newline(): void {
    if (this.buffer.endsWith('  ')) {
      this.buffer = this.buffer.trimEnd()
      this.add({ next: 0, node: BREAK })
    } else {
      this.buffer += '\n'
    }
  }

  result(): Inline[] {
    this.flush()
    return this.nodes
  }

  private flush(): void {
    if (this.buffer !== '') {
      this.nodes.push({ kind: 'text', text: this.buffer })
      this.buffer = ''
    }
  }
}

export function parseInline(text: string): Inline[] {
  return parseRange(text, 0, text.length, 0)
}

function parseRange(text: string, start: number, end: number, depth: number): Inline[] {
  const scan: Scan = { text, end, depth, failed: new Map(), found: new Map() }
  const out = new InlineBuilder()
  let pos = start
  while (pos < end) {
    const ch = text.charAt(pos)
    if (ch === '\n') {
      out.newline()
      pos += 1
      continue
    }
    const step = READERS.get(ch)?.(scan, pos) ?? { next: pos + 1, text: ch }
    out.add(step)
    pos = step.next
  }
  return out.result()
}

function charAt(scan: Scan, index: number): string {
  return index < scan.end ? scan.text.charAt(index) : ''
}

function runLength(scan: Scan, pos: number, ch: string): number {
  let cursor = pos
  while (charAt(scan, cursor) === ch) {
    cursor += 1
  }
  return cursor - pos
}

function isSpace(ch: string): boolean {
  return /\s/.test(ch)
}

function isWordChar(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch)
}

/** Finds `ch` at or after `from` inside the scan, remembering failures and hits. */
function findChar(scan: Scan, from: number, ch: string): number {
  const hit = scan.found.get(ch)
  if (hit && from >= hit.from && from <= hit.index) {
    return hit.index
  }
  if ((scan.failed.get(ch) ?? Infinity) <= from) {
    return -1
  }
  const index = scan.text.indexOf(ch, from)
  if (index >= 0 && index < scan.end) {
    scan.found.set(ch, { from, index })
    return index
  }
  scan.failed.set(ch, from)
  return -1
}

function readEscape(scan: Scan, pos: number): Step | null {
  const next = charAt(scan, pos + 1)
  if (next === '\n') {
    return { next: pos + 2, node: BREAK }
  }
  return PUNCTUATION.test(next) ? { next: pos + 2, text: next } : null
}

function findBacktickRun(scan: Scan, from: number, size: number): number {
  const key = `\`${size}`
  if ((scan.failed.get(key) ?? Infinity) <= from) {
    return -1
  }
  let pos = scan.text.indexOf('`', from)
  while (pos >= 0 && pos < scan.end) {
    const run = runLength(scan, pos, '`')
    if (run === size) {
      return pos
    }
    pos = scan.text.indexOf('`', pos + run)
  }
  scan.failed.set(key, from)
  return -1
}

function codeText(raw: string): string {
  const flat = raw.replace(/\n/g, ' ')
  const padded = flat.startsWith(' ') && flat.endsWith(' ') && flat.trim() !== ''
  return padded ? flat.slice(1, -1) : flat
}

function readCodeSpan(scan: Scan, pos: number): Step {
  const run = runLength(scan, pos, '`')
  const close = findBacktickRun(scan, pos + run, run)
  if (close < 0) {
    return { next: pos + run, text: '`'.repeat(run) }
  }
  return { next: close + run, node: { kind: 'code', text: codeText(scan.text.slice(pos + run, close)) } }
}

function canOpen(scan: Scan, pos: number, run: number): boolean {
  const after = charAt(scan, pos + run)
  if (after === '' || isSpace(after)) {
    return false
  }
  return scan.text.charAt(pos) !== '_' || !isWordChar(scan.text.charAt(pos - 1))
}

/** A single delimiter never closes on a run of exactly two (that run belongs to nested strong text). */
function acceptsRun(run: number, size: number): boolean {
  return size === 2 ? run >= 2 : run !== 2
}

function closerAt(scan: Scan, pos: number, from: number, size: number): { close: number; next: number } {
  const ch = scan.text.charAt(pos)
  const run = runLength(scan, pos, ch)
  const close = pos + run - size
  const flanking = !isSpace(scan.text.charAt(pos - 1))
  const wordSafe = ch !== '_' || !isWordChar(charAt(scan, pos + run))
  const ok = acceptsRun(run, size) && close > from && flanking && wordSafe
  return { close: ok ? close : -1, next: pos + run }
}

function findCloser(scan: Scan, from: number, ch: string, size: number): number {
  const key = `${ch}${size}`
  if ((scan.failed.get(key) ?? Infinity) <= from) {
    return -1
  }
  let pos = from
  while (pos < scan.end) {
    const current = scan.text.charAt(pos)
    if (current === '\\') {
      pos += 2
      continue
    }
    const found = current === ch ? closerAt(scan, pos, from, size) : { close: -1, next: pos + 1 }
    if (found.close >= 0) {
      return found.close
    }
    pos = found.next
  }
  scan.failed.set(key, from)
  return -1
}

function wrap(scan: Scan, kind: 'em' | 'strong', range: { start: number; end: number }): Inline {
  return { kind, children: parseRange(scan.text, range.start, range.end, scan.depth + 1) }
}

function readEmphasis(scan: Scan, pos: number): Step {
  const ch = scan.text.charAt(pos)
  const run = runLength(scan, pos, ch)
  const literal: Step = { next: pos + run, text: ch.repeat(run) }
  if (scan.depth >= MAX_INLINE_DEPTH || !canOpen(scan, pos, run)) {
    return literal
  }
  if (run >= 2) {
    const close = findCloser(scan, pos + 2, ch, 2)
    return close < 0
      ? { next: pos + run - 1, text: ch.repeat(run - 1) }
      : { next: close + 2, node: wrap(scan, 'strong', { start: pos + 2, end: close }) }
  }
  const close = findCloser(scan, pos + 1, ch, 1)
  return close < 0 ? literal : { next: close + 1, node: wrap(scan, 'em', { start: pos + 1, end: close }) }
}

function skipSpaces(scan: Scan, pos: number): number {
  let cursor = pos
  while (cursor < scan.end && isSpace(scan.text.charAt(cursor))) {
    cursor += 1
  }
  return cursor
}

function readAngleTarget(scan: Scan, pos: number): { url: string; next: number } | null {
  const close = findChar(scan, pos + 1, '>')
  if (close < 0) {
    return null
  }
  const url = scan.text.slice(pos + 1, close)
  return url.includes('\n') ? null : { url, next: close + 1 }
}

function readBareTarget(scan: Scan, pos: number): { url: string; next: number } | null {
  const limit = Math.min(scan.end, pos + MAX_TARGET)
  let depth = 0
  let cursor = pos
  while (cursor < limit) {
    const ch = scan.text.charAt(cursor)
    if (isSpace(ch) || (ch === ')' && depth === 0)) {
      break
    }
    depth += ch === '(' ? 1 : 0
    depth -= ch === ')' ? 1 : 0
    cursor += 1
  }
  return cursor === pos || cursor === limit ? null : { url: scan.text.slice(pos, cursor), next: cursor }
}

/** Skips an optional quoted title; returns the position after it, or -1 when it is unterminated. */
function skipTitle(scan: Scan, pos: number): number {
  const quote = scan.text.charAt(pos)
  if (quote !== '"' && quote !== "'") {
    return pos
  }
  const close = scan.text.indexOf(quote, pos + 1)
  return close < 0 || close >= Math.min(scan.end, pos + MAX_TARGET) ? -1 : skipSpaces(scan, close + 1)
}

interface LinkParts {
  label: { start: number; end: number }
  href: string | null
  next: number
}

function readLinkParts(scan: Scan, pos: number): LinkParts | null {
  const close = findChar(scan, pos + 1, ']')
  if (close < 0 || charAt(scan, close + 1) !== '(') {
    return null
  }
  const start = skipSpaces(scan, close + 2)
  const target = charAt(scan, start) === '<' ? readAngleTarget(scan, start) : readBareTarget(scan, start)
  const after = target ? skipTitle(scan, skipSpaces(scan, target.next)) : -1
  if (!target || after < 0 || charAt(scan, after) !== ')') {
    return null
  }
  return { label: { start: pos + 1, end: close }, href: safeHref(target.url), next: after + 1 }
}

function readLink(scan: Scan, pos: number): Step | null {
  const parts = readLinkParts(scan, pos)
  if (!parts) {
    return null
  }
  const label = scan.text.slice(parts.label.start, parts.label.end)
  if (parts.href === null) {
    return { next: parts.next, text: label }
  }
  const children = parseRange(scan.text, parts.label.start, parts.label.end, scan.depth + 1)
  return { next: parts.next, node: { kind: 'link', href: parts.href, children } }
}

/** Images are never loaded: they render as a link to their target (or their alt text). */
function readImage(scan: Scan, pos: number): Step | null {
  const parts = charAt(scan, pos + 1) === '[' ? readLinkParts(scan, pos + 1) : null
  if (!parts) {
    return null
  }
  const alt: Inline = { kind: 'text', text: scan.text.slice(parts.label.start, parts.label.end) }
  return parts.href === null
    ? { next: parts.next, text: alt.text }
    : { next: parts.next, node: { kind: 'link', href: parts.href, children: [alt] } }
}

function autolinkHref(inner: string): string | null {
  if (inner.length > MAX_TARGET) {
    return null
  }
  if (EMAIL.test(inner)) {
    return safeHref(`mailto:${inner}`)
  }
  return URI.test(inner) ? safeHref(inner) : null
}

function readAutolink(scan: Scan, pos: number): Step | null {
  const close = findChar(scan, pos + 1, '>')
  const inner = close < 0 ? '' : scan.text.slice(pos + 1, close)
  const href = autolinkHref(inner)
  if (href === null) {
    return null
  }
  return { next: close + 1, node: { kind: 'link', href, children: [{ kind: 'text', text: inner }] } }
}

const READERS = new Map<string, Reader>([
  ['\\', readEscape],
  ['`', readCodeSpan],
  ['*', readEmphasis],
  ['_', readEmphasis],
  ['[', readLink],
  ['!', readImage],
  ['<', readAutolink]
])

// ---------------------------------------------------------------------------------------------
// Block parsing

const MAX_BLOCK_DEPTH = 6
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const QUOTE = /^ {0,3}> ?(.*)$/
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/
const TASK = /^\[([ xX])\][ \t]+/

interface BlockStep {
  block: Block | null
  next: number
}

type BlockReader = (lines: string[], index: number, depth: number) => BlockStep | null

interface Marker {
  bullet: string
  ordered: boolean
  start: number
  contentIndent: number
  text: string
}

export function parseMarkdown(source: string): Block[] {
  return parseBlocks(source.replace(/\r\n?/g, '\n').split('\n'), 0)
}

function parseBlocks(lines: string[], depth: number): Block[] {
  const blocks: Block[] = []
  let index = 0
  while (index < lines.length) {
    const step = readBlock(lines, index, depth)
    if (step.block) {
      blocks.push(step.block)
    }
    index = step.next
  }
  return blocks
}

function readBlock(lines: string[], index: number, depth: number): BlockStep {
  for (const reader of BLOCK_READERS) {
    const step = reader(lines, index, depth)
    if (step) {
      return step
    }
  }
  return readParagraph(lines, index)
}

function lineAt(lines: string[], index: number): string {
  return lines[index] ?? ''
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

function isBlank(line: string): boolean {
  return line.trim() === ''
}

function readBlank(lines: string[], index: number): BlockStep | null {
  return isBlank(lineAt(lines, index)) ? { block: null, next: index + 1 } : null
}

function headingText(raw: string): string {
  const trimmed = raw.trim()
  let cut = trimmed.length
  while (cut > 0 && trimmed.charAt(cut - 1) === '#') {
    cut -= 1
  }
  const closing = cut === 0 || /[ \t]/.test(trimmed.charAt(cut - 1))
  return closing ? trimmed.slice(0, cut).trim() : trimmed
}

function readHeading(lines: string[], index: number): BlockStep | null {
  const match = HEADING.exec(lineAt(lines, index))
  if (!match) {
    return null
  }
  const level = (match[1] ?? '#').length
  return { block: { kind: 'heading', level, children: parseInline(headingText(match[2] ?? '')) }, next: index + 1 }
}

function isRule(line: string): boolean {
  if (indentOf(line) > 3) {
    return false
  }
  const compact = line.replace(/[ \t]/g, '')
  return compact.length >= 3 && /^(?:-+|\*+|_+)$/.test(compact)
}

function readRule(lines: string[], index: number): BlockStep | null {
  return isRule(lineAt(lines, index)) ? { block: { kind: 'rule' }, next: index + 1 } : null
}

function isFenceClose(line: string, marker: string): boolean {
  const trimmed = line.trim()
  return trimmed.length >= marker.length && trimmed === marker.charAt(0).repeat(trimmed.length)
}

function openFence(line: string): { marker: string; info: string } | null {
  const match = FENCE_OPEN.exec(line)
  const marker = match?.[1] ?? ''
  const info = (match?.[2] ?? '').trim()
  return marker === '' || (marker.startsWith('`') && info.includes('`')) ? null : { marker, info }
}

function readFence(lines: string[], index: number): BlockStep | null {
  const fence = openFence(lineAt(lines, index))
  if (!fence) {
    return null
  }
  let end = index + 1
  while (end < lines.length && !isFenceClose(lineAt(lines, end), fence.marker)) {
    end += 1
  }
  const lang = fence.info.split(/\s+/)[0] ?? ''
  return { block: { kind: 'code', lang, text: lines.slice(index + 1, end).join('\n') }, next: end + 1 }
}

function readQuote(lines: string[], index: number, depth: number): BlockStep | null {
  if (depth >= MAX_BLOCK_DEPTH || !QUOTE.test(lineAt(lines, index))) {
    return null
  }
  const inner: string[] = []
  let cursor = index
  let match = QUOTE.exec(lineAt(lines, cursor))
  while (cursor < lines.length && match) {
    inner.push(match[1] ?? '')
    cursor += 1
    match = QUOTE.exec(lineAt(lines, cursor))
  }
  return { block: { kind: 'quote', blocks: parseBlocks(inner, depth + 1) }, next: cursor }
}

function parseMarker(line: string): Marker | null {
  const match = ITEM.exec(line)
  if (!match) {
    return null
  }
  const indent = (match[1] ?? '').length
  const token = match[2] ?? '-'
  const ordered = /\d/.test(token.charAt(0))
  return {
    bullet: ordered ? token.slice(-1) : token,
    ordered,
    start: ordered ? Number.parseInt(token, 10) : 1,
    contentIndent: indent + token.length + 1,
    text: match[3] ?? ''
  }
}

function startsBlock(line: string): boolean {
  return (
    openFence(line) !== null ||
    HEADING.test(line) ||
    isRule(line) ||
    QUOTE.test(line) ||
    parseMarker(line) !== null
  )
}

function nextNonBlank(lines: string[], from: number): number {
  let cursor = from
  while (cursor < lines.length && isBlank(lineAt(lines, cursor))) {
    cursor += 1
  }
  return cursor
}

/** Whether `line` still belongs to the current list item. */
function continuesItem(lines: string[], index: number, lazy: boolean): boolean {
  const line = lineAt(lines, index)
  if (isBlank(line)) {
    const next = nextNonBlank(lines, index)
    return next < lines.length && indentOf(lineAt(lines, next)) >= 2
  }
  if (indentOf(line) >= 2) {
    return true
  }
  return lazy && !startsBlock(line)
}

function itemEnd(lines: string[], start: number, marker: Marker): number {
  let cursor = start + 1
  let lazy = !isBlank(marker.text)
  while (cursor < lines.length && continuesItem(lines, cursor, lazy)) {
    lazy = !isBlank(lineAt(lines, cursor))
    cursor += 1
  }
  return cursor
}

function buildItem(marker: Marker, rest: string[], depth: number): ListItem {
  const task = TASK.exec(marker.text)
  const first = task ? marker.text.slice(task[0].length) : marker.text
  const dedented = rest.map((line) => line.slice(Math.min(marker.contentIndent, indentOf(line))))
  const state = task?.[1] === ' ' ? 'open' : 'done'
  return { task: task ? state : null, blocks: parseBlocks([first, ...dedented], depth + 1) }
}

function sameList(a: Marker, b: Marker | null): boolean {
  return b !== null && a.ordered === b.ordered && a.bullet === b.bullet
}

function readList(lines: string[], index: number, depth: number): BlockStep | null {
  const first = parseMarker(lineAt(lines, index))
  if (depth >= MAX_BLOCK_DEPTH || !first) {
    return null
  }
  const items: ListItem[] = []
  let cursor = index
  let marker: Marker | null = first
  while (marker) {
    const end = itemEnd(lines, cursor, marker)
    items.push(buildItem(marker, lines.slice(cursor + 1, end), depth))
    const next = nextNonBlank(lines, end)
    const following = parseMarker(lineAt(lines, next))
    marker = sameList(first, following) ? following : null
    cursor = marker ? next : end
  }
  return { block: { kind: 'list', ordered: first.ordered, start: first.start, items }, next: cursor }
}

function readParagraph(lines: string[], index: number): BlockStep {
  const collected = [lineAt(lines, index).trimStart()]
  let cursor = index + 1
  while (cursor < lines.length && !isBlank(lineAt(lines, cursor)) && !startsBlock(lineAt(lines, cursor))) {
    collected.push(lineAt(lines, cursor).trimStart())
    cursor += 1
  }
  return { block: { kind: 'paragraph', children: parseInline(collected.join('\n').trimEnd()) }, next: cursor }
}

const BLOCK_READERS: BlockReader[] = [readBlank, readFence, readHeading, readRule, readQuote, readList]
