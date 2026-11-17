import { z } from 'zod'

/** Layer a knowledge fact was loaded from. */
export type KnowledgeLayer = 'builtin' | 'overall' | 'repo'

interface KnowledgeOrigin {
  layer: KnowledgeLayer
  path: string
}

/** A problem found while reading a fact file; `message` names the line when one applies. */
export interface KnowledgeDiagnostic {
  layer: KnowledgeLayer
  path: string
  message: string
}

const FACT_TYPES = ['procedure', 'convention', 'decision', 'gotcha', 'command'] as const
const FACT_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{1,79}$/

const listSchema = z.array(z.string())

const frontmatterSchema = z
  .object({
    id: z.string().regex(FACT_ID_PATTERN, 'id must match ^[a-z0-9][a-z0-9.-]{1,79}$'),
    type: z.enum(FACT_TYPES),
    title: z.string().min(1).max(120),
    scope: z
      .object({
        roles: listSchema.default(['orchestrator']),
        events: listSchema.default([]),
        topics: listSchema.default([]),
        paths: listSchema.default([])
      })
      .strict()
      .default({ roles: ['orchestrator'], events: [], topics: [], paths: [] }),
    priority: z.number().int().min(0).max(100).default(50),
    supersedes: z.array(z.string().regex(FACT_ID_PATTERN)).default([]),
    anchors: listSchema.default([]),
    provenance: z.string().optional()
  })
  .strict()

type Frontmatter = z.infer<typeof frontmatterSchema>

export type KnowledgeFact = Frontmatter & {
  layer: KnowledgeLayer
  path: string
  body: string
  /** Rough token estimate: ceil((title + body) / 4). */
  tokens: number
}

type ParseFactResult =
  | { ok: true; fact: KnowledgeFact }
  | { ok: false; diagnostic: KnowledgeDiagnostic }

type ScalarValue = string | number | string[]

class LineError extends Error {
  constructor(
    readonly line: number,
    message: string
  ) {
    super(message)
  }
}

const KEY_PATTERN = /^([a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)?):(?:\s+(.*))?$/
const BARE_PATTERN = /^[^"'[\]{},:#&*!|>%@`\s][^"[\]{},]*$/

function parseQuoted(text: string, line: number): { value: string; rest: string } {
  let out = ''
  for (let i = 1; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') {
      const next = text[i + 1]
      if (next === '"' || next === '\\') {
        out += next
        i++
        continue
      }
      throw new LineError(line, 'unsupported escape in quoted string')
    }
    if (ch === '"') return { value: out, rest: text.slice(i + 1) }
    out += ch
  }
  throw new LineError(line, 'unterminated quoted string')
}

function parseString(text: string, line: number): string {
  if (text.startsWith('"')) {
    const { value, rest } = parseQuoted(text, line)
    if (rest.trim() !== '') throw new LineError(line, 'unexpected text after quoted string')
    return value
  }
  if (!BARE_PATTERN.test(text)) throw new LineError(line, `unsupported value "${text}"`)
  return text
}

/** Reads one list item from the start of `rest`; returns it and the remaining text (starting at "," or empty). */
function readListItem(rest: string, line: number): { item: string; rest: string } {
  if (rest.startsWith('"')) {
    const parsed = parseQuoted(rest, line)
    return { item: parsed.value, rest: parsed.rest.trim() }
  }
  const comma = rest.indexOf(',')
  const raw = (comma === -1 ? rest : rest.slice(0, comma)).trim()
  if (raw === '' || !BARE_PATTERN.test(raw)) throw new LineError(line, 'unsupported list item')
  return { item: raw, rest: comma === -1 ? '' : rest.slice(comma) }
}

function parseList(text: string, line: number): string[] {
  if (!text.endsWith(']')) throw new LineError(line, 'inline list must close on the same line')
  const items: string[] = []
  let rest = text.slice(1, -1).trim()
  while (rest !== '') {
    const next = readListItem(rest, line)
    items.push(next.item)
    rest = next.rest
    if (rest === '') break
    if (!rest.startsWith(',')) throw new LineError(line, 'expected "," between list items')
    rest = rest.slice(1).trim()
    if (rest === '') throw new LineError(line, 'trailing "," in list')
  }
  return items
}

function parseValue(text: string, line: number): ScalarValue {
  if (text.startsWith('[')) return parseList(text, line)
  if (/^-?\d+$/.test(text)) return Number(text)
  return parseString(text, line)
}

interface ParsedFrontmatter {
  values: Record<string, unknown>
  keyLines: Map<string, number>
}

/** Parses the strict YAML subset into a (one-level) nested record, recording each key's file line. `firstLine` is the 1-based file line of `lines[0]`. */
function parseFrontmatter(lines: string[], firstLine: number): ParsedFrontmatter {
  const result: Record<string, unknown> = {}
  const keyLines = new Map<string, number>()
  lines.forEach((raw, index) => {
    const line = firstLine + index
    const text = raw.trimEnd()
    if (text.trim() === '' || text.trimStart().startsWith('#')) return
    if (/^\s/.test(text)) throw new LineError(line, 'indented lines (nested maps or multi-line lists) are not supported')
    const match = KEY_PATTERN.exec(text)
    if (!match) throw new LineError(line, 'expected "key: value"')
    const key = match[1]
    const valueText = (match[2] ?? '').trim()
    if (valueText === '') throw new LineError(line, `"${key}" has no value (nested maps and multi-line lists are not supported)`)
    if (keyLines.has(key)) throw new LineError(line, `duplicate key "${key}"`)
    keyLines.set(key, line)
    assignKey(result, key, parseValue(valueText, line), line)
  })
  return { values: result, keyLines }
}

function assignKey(result: Record<string, unknown>, key: string, value: ScalarValue, line: number): void {
  const [head, sub] = key.split('.')
  const existing = result[head]
  const isGroup = typeof existing === 'object' && !Array.isArray(existing)
  if (existing !== undefined && (sub === undefined || !isGroup)) {
    throw new LineError(line, `"${key}" conflicts with "${head}"`)
  }
  if (sub === undefined) {
    result[head] = value
    return
  }
  result[head] = { ...(existing as Record<string, unknown> | undefined), [sub]: value }
}

/** Parses one knowledge fact file (frontmatter + Markdown body). No I/O. */
export function parseFact(source: string, origin: KnowledgeOrigin): ParseFactResult {
  const fail = (message: string): ParseFactResult => ({
    ok: false,
    diagnostic: { layer: origin.layer, path: origin.path, message }
  })
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return fail('line 1: expected opening "---"')
  const closing = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
  if (closing === -1) return fail(`line ${lines.length}: missing closing "---"`)

  let raw: ParsedFrontmatter
  try {
    raw = parseFrontmatter(lines.slice(1, closing), 2)
  } catch (error) {
    if (error instanceof LineError) return fail(`line ${error.line}: ${error.message}`)
    throw error
  }

  const parsed = frontmatterSchema.safeParse(raw.values)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const field = issue.path.filter((part) => typeof part === 'string').join('.')
    // Missing fields have no line of their own; report the closing "---" of the frontmatter.
    const line = raw.keyLines.get(field) ?? closing + 1
    return fail(`line ${line}: ${field || 'frontmatter'}: ${issue.message}`)
  }

  const body = lines.slice(closing + 1).join('\n').trim()
  if (body === '') return fail(`line ${closing + 1}: body is empty`)

  const front = parsed.data
  return {
    ok: true,
    fact: {
      ...front,
      layer: origin.layer,
      path: origin.path,
      body,
      tokens: Math.ceil((front.title.length + body.length) / 4)
    }
  }
}
