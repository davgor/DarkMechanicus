/**
 * OMP's `ask` tool over RPC (OMP 18.18.3+, observed on 18.20.2): the agent writes one HTML `<form>`, and an RPC host,
 * which has no form dialog, is asked field by field through `select` (a checkbox group as a loop of toggles ending in
 * "Done selecting", a radio group as one pick), `input` and `editor` requests. Main shows the whole form as one
 * prompt, parsed inertly from the tool call's `html`, and after the person's one Submit answers each of those
 * requests from the held answers. A request that does not match the next expected field stops the answering at once.
 */
import type { FormFieldAnswer, PromptForm } from './pendingPrompts'

type ObjectValue = Record<string, unknown>
type AskChoice = { value: string; label: string; checked: boolean }
/** One named control of the form, as OMP asks for it: `options` are the enabled ones, labelled as OMP sends them. */
export interface AskField {
  name: string
  question: string
  kind: 'choice' | 'text'
  multi: boolean
  /** OMP adds an "Other (type your own)" free-text choice. */
  other: boolean
  required: boolean
  options: AskChoice[]
  /** A text field's initial value; OMP asks with `editor` (prefilled) when it has one or is multiline. */
  value: string
  multiline: boolean
}
/** The held answer of one field: chosen option indexes and free text (Other, or a text field's value). */
type AskDesired = { chosen: number[]; text?: string }
/** Main-private state of one OMP ask form, from its tool call until its last request is answered. */
export interface OmpAskDrive {
  /** The `ask` tool call it came from; null for a lone checkbox `select` shown as a one-field form. */
  toolCallId: string | null
  fields: AskField[]
  /** The request the form prompt answers first, as OMP sent it; set once that prompt is held. */
  wireId: string | null
  request: ObjectValue | null
  /** The person's answers; null until the Submit. */
  desired: AskDesired[] | null
  position: number
  /** `select` rounds answered for the current field; a checkbox loop may take at most its markable options + 1. */
  rounds: number
  /** Other was chosen: the next request is the `input` for its text. */
  awaitingOther: boolean
}
type DriveStep = { frame: ObjectValue; done: boolean } | { diverged: string }
type Step = { value: string } | { diverged: string }

const ASK_HTML_MAX_BYTES = 64 * 1024
const OTHER_LABEL = 'Other (type your own)'
const DONE_SUFFIX = 'Done selecting'
const SKIPPED = new Set(['button', 'head', 'iframe', 'link', 'meta', 'noscript', 'script', 'style', 'template', 'title'])
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const BLOCKS = new Set(['address', 'article', 'aside', 'blockquote', 'dd', 'details', 'div', 'dl', 'dt', 'figure', 'figcaption', 'footer', 'header', 'li', 'main', 'nav', 'p', 'section'])
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'summary'])
/** Elements that end a text block in OMP's parser. */
const BREAKS = new Set([...BLOCKS, ...HEADINGS, 'legend', 'ul', 'ol', 'hr'])
/** Elements whose text never joins a label or legend. */
const LABEL_SKIPPED = new Set([...SKIPPED, 'select', 'textarea', 'svg'])
const CONTROLS = new Set(['input', 'select', 'textarea'])
const IGNORED_INPUTS = new Set(['button', 'file', 'image', 'reset', 'submit', 'hidden'])
/** Blocks OMP renders as non-text: main declines a form with controls inside them. */
const UNSUPPORTED = new Set(['table', 'pre', 'img', 'svg'])
/** Raw-text elements: the tokenizer keeps a textarea's value and drops the rest. */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title'])

type Open = { kind: 'open'; name: string; attrs: Map<string, string>; selfClosing: boolean }
type Token = { kind: 'text'; text: string } | Open | { kind: 'close'; name: string }
/** One control as the parser meets it: its tag, its token range, name and label. */
type Control = { token: Open; index: number; end: number; name: string; label: string; required: boolean }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
function entity(match: string, name: string): string {
  const lower = name.toLowerCase()
  if (!lower.startsWith('#')) return Object.hasOwn(ENTITIES, lower) ? ENTITIES[lower] : match
  const code = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10)
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
}
const decode = (text: string): string => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+[0-9]*);/gi, entity)
const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()

function attributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>()
  for (const attr of raw.matchAll(/([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g)) {
    const key = attr[1].toLowerCase()
    if (!attrs.has(key)) attrs.set(key, decode(attr[2] ?? attr[3] ?? attr[4] ?? ''))
  }
  return attrs
}
function tagToken(match: RegExpExecArray): Token | null {
  if (match[1]) return { kind: 'close', name: match[1].toLowerCase() }
  if (!match[2]) return null
  const raw = match[3] ?? ''
  return { kind: 'open', name: match[2].toLowerCase(), attrs: attributes(raw), selfClosing: /\/\s*$/.test(raw) }
}
/** Consumes a raw-text element's body up to its close tag; returns where the close tag starts. */
function rawText(html: string, from: number, name: string, tokens: Token[]): number {
  const end = html.toLowerCase().indexOf(`</${name}`, from)
  const stop = end < 0 ? html.length : end
  if (stop > from) tokens.push({ kind: 'text', text: name === 'textarea' ? decode(html.slice(from, stop)) : '' })
  return stop
}
/** Inert tokens: no DOM, no script, no network. Raw-text elements (script, style, …) keep only their close tag. */
function tokenize(html: string): Token[] {
  const tokens: Token[] = []
  const pattern = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^>]*>|<\?[^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g
  let last = 0
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    if (match.index > last) tokens.push({ kind: 'text', text: decode(html.slice(last, match.index)) })
    last = pattern.lastIndex
    const token = tagToken(match)
    if (!token) continue
    tokens.push(token)
    if (token.kind === 'open' && RAW_TEXT.has(token.name)) pattern.lastIndex = last = rawText(html, last, token.name, tokens)
  }
  if (last < html.length) tokens.push({ kind: 'text', text: decode(html.slice(last)) })
  return tokens
}
const opens = (token: Token): token is Open => token.kind === 'open' && !token.selfClosing && !VOID.has(token.name)
/** The index of the close token matching the open token at `start`, or the end; the start itself for a void tag. */
function closing(tokens: Token[], start: number): number {
  const first = tokens[start]
  if (!opens(first)) return start
  let depth = 0
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index]
    if (opens(token) && token.name === first.name) depth++
    if (token.kind === 'close' && token.name === first.name && --depth === 0) return index
  }
  return tokens.length
}
const isControl = (token: Token): token is Open => token.kind === 'open' && CONTROLS.has(token.name)
/** How a token moves the label-text skip depth: into and out of a skipped element. */
function skipChange(token: Token, skip: number): number {
  if (token.kind === 'text' || !LABEL_SKIPPED.has(token.name)) return 0
  if (token.kind === 'open') return opens(token) ? 1 : 0
  return skip ? -1 : 0
}
function tokenText(token: Token): string {
  if (token.kind === 'text') return token.text
  if (token.kind === 'close') return ''
  if (token.name === 'img') return token.attrs.get('alt') ?? ''
  return BLOCKS.has(token.name) || HEADINGS.has(token.name) || token.name === 'br' ? ' ' : ''
}
/** Text of a label or legend without its controls' own text. */
function textOf(tokens: Token[], from: number, to: number): string {
  let text = '', skip = 0
  for (let index = from; index < to; index++) {
    const change = skipChange(tokens[index], skip)
    if (change) skip += change
    else if (!skip) text += tokenText(tokens[index])
  }
  return collapse(text)
}
type RawChoice = AskChoice & { disabled: boolean }
function enabled(options: RawChoice[]): AskChoice[] {
  return options.filter(option => !option.disabled).map(({ value, label, checked }) => ({ value, label: collapse(label) || value, checked }))
}

/** Walks the form's tokens as OMP's `html-form/parse.ts` does, as far as main needs: fields, labels, defaults. */
class FormParser {
  readonly fields: AskField[] = []
  /** Every radio/checkbox group's choices, disabled ones included, until the form is built. */
  readonly choices = new Map<AskField, RawChoice[]>()
  unsupported = false
  private readonly groups = new Map<string, AskField>()
  private readonly forLabels = new Map<string, string>()
  private readonly forLabelStarts = new Set<number>()
  private title = ''
  private pending = ''
  private previous = ''
  private fieldsetDepth = 0

  constructor(private readonly tokens: Token[]) {
    const ids = new Set(tokens.filter(isControl).map(token => token.attrs.get('id')).filter(id => !!id))
    tokens.forEach((token, index) => {
      const target = token.kind === 'open' && token.name === 'label' ? token.attrs.get('for') : undefined
      if (!target || !ids.has(target) || this.forLabels.has(target)) return
      this.forLabels.set(target, textOf(tokens, index + 1, closing(tokens, index)))
      this.forLabelStarts.add(index)
    })
  }
  /** A block boundary: the text since the last one becomes the preceding text block. */
  private flush(): void {
    const text = collapse(this.pending)
    this.pending = ''
    if (text) this.previous = text
  }
  walk(from: number, to: number): void {
    for (let index = from; index < to && !this.unsupported; index++) {
      const token = this.tokens[index]
      if (token.kind === 'text') this.pending += token.text
      else if (token.kind === 'close') { if (BLOCKS.has(token.name) || HEADINGS.has(token.name)) this.flush() }
      else index = this.element(token, index)
    }
  }
  /** Handles one open tag; returns the index of the last token it consumed. */
  private element(token: Open, index: number): number {
    const end = closing(this.tokens, index)
    if (SKIPPED.has(token.name)) return end
    if (UNSUPPORTED.has(token.name) || (token.name === 'ul' || token.name === 'ol') && !this.hasControl(index, end)) return this.textless(token, index, end)
    if (CONTROLS.has(token.name)) { this.control(token, index, end, undefined); return end }
    if (token.name === 'label') return this.label(index, end)
    if (token.name === 'fieldset') { this.fieldset(index, end); return end }
    this.inline(token.name)
    return index
  }
  /** A line break joins the pending text; a block or heading ends it. */
  private inline(name: string): void {
    if (name === 'br') this.pending += '\n'
    else if (BREAKS.has(name)) this.flush()
  }
  private hasControl(index: number, end: number): boolean { return this.tokens.slice(index, end).some(isControl) }
  /** A non-text block ends the preceding text; one holding controls makes the form unsupported. */
  private textless(token: Open, index: number, end: number): number {
    if (UNSUPPORTED.has(token.name) && this.hasControl(index, end)) this.unsupported = true
    this.flush()
    this.previous = ''
    return end
  }
  private label(index: number, end: number): number {
    if (this.forLabelStarts.has(index)) return end
    if (!this.hasControl(index + 1, end)) return index
    this.flush()
    const text = textOf(this.tokens, index + 1, end)
    for (let at = index + 1; at < end; at++) {
      const token = this.tokens[at]
      if (!isControl(token)) continue
      const close = closing(this.tokens, at)
      this.control(token, at, close, text)
      at = close
    }
    return end
  }
  private fieldset(index: number, end: number): void {
    this.flush()
    const legendAt = this.tokens.findIndex((token, at) => at > index && at < end && token.kind === 'open' && token.name === 'legend')
    const legendEnd = legendAt < 0 ? -1 : closing(this.tokens, legendAt)
    this.enterFieldset(legendAt < 0 ? '' : textOf(this.tokens, legendAt + 1, legendEnd))
    if (legendAt < 0) this.walk(index + 1, end)
    else { this.walk(index + 1, legendAt); this.walk(legendEnd + 1, end) }
    this.flush()
    if (--this.fieldsetDepth === 0) { this.title = ''; this.previous = '' }
  }
  /** A top-level fieldset's legend titles its section; a nested one's is a text block. */
  private enterFieldset(legend: string): void {
    if (this.fieldsetDepth === 0) { this.title = legend; this.previous = '' }
    else if (legend) this.previous = legend
    this.fieldsetDepth++
  }
  private ownLabel(token: Open, wrapping: string | undefined): string {
    if (wrapping) return wrapping
    const id = token.attrs.get('id')
    const forLabel = id ? this.forLabels.get(id) : undefined
    if (forLabel) return forLabel
    return collapse(token.attrs.get('aria-label') ?? token.attrs.get('title') ?? '')
  }
  private question(label: string): string {
    return collapse(label || this.previous || this.title)
  }
  private add(field: AskField): void {
    this.fields.push(field)
    this.previous = ''
  }
  private control(token: Open, index: number, end: number, wrapping: string | undefined): void {
    this.flush()
    const control = { token, index, end, name: token.attrs.get('name') ?? '', label: this.ownLabel(token, wrapping), required: token.attrs.has('required') }
    if (token.name === 'select') this.select(control)
    else if (token.name === 'textarea') this.textarea(control)
    else this.input(control)
  }
  private select(control: Control): void {
    const options: RawChoice[] = []
    for (let at = control.index + 1; at < control.end; at++) {
      const option = this.tokens[at]
      if (option.kind !== 'open' || option.name !== 'option') continue
      const text = textOf(this.tokens, at + 1, Math.min(closing(this.tokens, at), control.end))
      options.push({ value: option.attrs.get('value') ?? text, label: text, checked: option.attrs.has('selected'), disabled: option.attrs.has('disabled') })
    }
    const multi = control.token.attrs.has('multiple')
    const first = options.find(option => !option.disabled)
    if (!multi && first && !options.some(option => option.checked)) first.checked = true
    this.add({ name: control.name, question: this.question(control.label) || control.name, kind: 'choice', multi, other: false, required: control.required, options: enabled(options), value: '', multiline: false })
  }
  private textarea(control: Control): void {
    const body = this.tokens[control.index + 1]
    const value = body?.kind === 'text' ? body.text.replace(/^\r?\n/, '') : ''
    this.add({ name: control.name, question: this.question(control.label || control.name.replace(/[_-]+/g, ' ')) || control.name, kind: 'text', multi: false, other: false, required: control.required, options: [], value, multiline: true })
  }
  private input(control: Control): void {
    const type = (control.token.attrs.get('type') ?? 'text').toLowerCase()
    if (IGNORED_INPUTS.has(type)) return
    const value = control.token.attrs.get('value')
    if (type === 'radio' || type === 'checkbox') { this.choice(control, type, value); return }
    this.add({ name: control.name, question: this.question(control.label || control.name.replace(/[_-]+/g, ' ')) || control.name, kind: 'text', multi: false, other: false, required: control.required, options: [], value: value ?? '', multiline: false })
  }
  /** Radios and checkboxes sharing a name are one field, titled by the text before its first control. */
  private choice(control: Control, type: string, value: string | undefined): void {
    const choice = { value: value ?? 'on', label: control.label || value || control.name, checked: control.token.attrs.has('checked'), disabled: control.token.attrs.has('disabled') }
    const key = `${type}\0${control.name}`
    const group = this.groups.get(key)
    if (group) { this.choices.get(group)?.push(choice); group.required ||= control.required; return }
    const field: AskField = { name: control.name, question: collapse(this.previous || this.title), kind: 'choice', multi: type === 'checkbox', other: false, required: control.required, options: [], value: '', multiline: false }
    this.groups.set(key, field)
    this.choices.set(field, [choice])
    this.add(field)
  }
}
/** OMP's own de-duplication of choice labels: a repeated label gets " (2)", " (3)", … */
function unique(labels: string[], taken: string[] = []): string[] {
  const seen = new Set(taken)
  return labels.map(label => {
    let next = label
    for (let count = 2; seen.has(next); count++) next = `${label} (${count})`
    seen.add(next)
    return next
  })
}
/** A radio/checkbox group's enabled options, its fallback title, and OMP's Other; then OMP's unique labels. */
function finishField(field: AskField, choices: RawChoice[] | undefined): void {
  if (choices) {
    field.options = enabled(choices)
    field.question ||= field.options.length === 1 ? field.options[0].label : field.name
    field.other = field.options.length >= 2 && !field.options.some(option => /^\s*other\b/i.test(option.label))
  }
  const labels = unique(field.options.map(option => option.label))
  field.options = field.options.map((option, index) => ({ ...option, label: labels[index] }))
}
function validFields(fields: AskField[]): boolean {
  return fields.length > 0 && new Set(fields.map(field => field.name)).size === fields.length && fields.every(field => field.kind === 'text' || field.options.length > 0)
}

/** The named fields of one ask form, or null for anything main cannot show as one form (OMP's cards remain). */
export function parseAskForm(html: string): AskField[] | null {
  if (typeof html !== 'string' || Buffer.byteLength(html) > ASK_HTML_MAX_BYTES) return null
  const tokens = tokenize(html)
  const formAt = tokens.findIndex(token => token.kind === 'open' && token.name === 'form')
  const parser = new FormParser(tokens)
  parser.walk(formAt + 1, formAt >= 0 ? closing(tokens, formAt) : tokens.length)
  if (parser.unsupported) return null
  const fields = parser.fields.filter(field => field.name)
  for (const field of fields) finishField(field, parser.choices.get(field))
  return validFields(fields) ? fields : null
}

/**
 * The form prompt's fields: option ids are positional, defaults preselected. `required` is the HTML's (any control of
 * a group marked `required`), except that a radio group always takes exactly one pick.
 */
export function askPromptForm(fields: readonly AskField[], safe: (text: string) => string): PromptForm {
  return { fields: fields.map(field => ({
    id: safe(field.name), title: safe(field.question).slice(0, 2_000), multi: field.multi,
    options: field.options.map((option, index) => ({ id: `option_${index}`, label: safe(option.label), ...(option.checked ? { preselected: true } : {}) })),
    text: field.kind === 'text' ? 'only' as const : field.other ? 'other' as const : 'none' as const,
    ...(field.kind === 'text' && field.value ? { defaultText: safe(field.value).slice(0, 20_000) } : {}),
    required: field.kind === 'choice' && !field.multi ? true : field.required
  })) }
}

/** Chosen option indexes in option order; null for an unknown or repeated id. */
function chosenIndexes(field: AskField, optionIds: readonly string[]): number[] | null {
  const chosen = optionIds.map(id => /^option_\d+$/.test(id) ? Number(id.slice('option_'.length)) : -1)
  if (new Set(chosen).size !== chosen.length || chosen.some(index => index < 0 || index >= field.options.length)) return null
  return chosen.sort((a, b) => a - b)
}
/** A choice field's answer: Other text only where OMP offers it; a single choice exactly one pick; a required group one. */
function choiceDesired(field: AskField, chosen: number[], text: string | undefined): AskDesired | null {
  if (text !== undefined && !field.other) return null
  const picks = chosen.length + (text === undefined ? 0 : 1)
  const valid = field.multi ? !field.required || picks > 0 : picks === 1
  if (!valid) return null
  return text === undefined ? { chosen } : { chosen, text }
}
/** A text field's answer: never options; an omitted text keeps the default; a required one is not blank. */
function textDesired(field: AskField, chosen: number[], text: string | undefined): AskDesired | null {
  const value = text ?? field.value
  if (chosen.length || (field.required && !value.trim())) return null
  return { chosen: [], text: value }
}
function fieldDesired(field: AskField, answer: FormFieldAnswer): AskDesired | null {
  const chosen = chosenIndexes(field, answer.optionIds)
  if (!chosen) return null
  if (field.kind === 'text') return textDesired(field, chosen, answer.text)
  return choiceDesired(field, chosen, answer.text?.trim() ? answer.text : undefined)
}
/**
 * The person's answer to every field, or null when it is not a complete, valid answer OMP could take: a field
 * missing or repeated, an unknown or repeated option, text a field does not take, a single choice without exactly one
 * pick, or a required field left empty. A text field's omitted `text` keeps its default.
 */
export function askDesired(fields: readonly AskField[], answers: readonly FormFieldAnswer[], safe: (text: string) => string): AskDesired[] | null {
  if (answers.length !== fields.length || new Set(answers.map(answer => answer.fieldId)).size !== answers.length) return null
  const desired = fields.flatMap(field => {
    const answer = answers.find(entry => entry.fieldId === safe(field.name))
    const value = answer ? fieldDesired(field, answer) : null
    return value ? [value] : []
  })
  return desired.length === fields.length ? desired : null
}

/** One line of the person's answers for the transcript: `question: answer` per field. */
export function askSummary(fields: readonly AskField[], desired: readonly AskDesired[]): string {
  return fields.map((field, index) => {
    const answer = desired[index]
    const text = field.kind === 'text' ? answer.text : answer.text && `Other: ${answer.text}`
    const values = [...answer.chosen.map(choice => field.options[choice].label), ...(text === undefined || text === '' && field.kind !== 'text' ? [] : [text])]
    return `${field.question}: ${values.join(', ')}`
  }).join('\n')
}

const string = (value: unknown): string => typeof value === 'string' ? value : ''
const strings = (value: unknown): string[] | null => Array.isArray(value) && value.every(entry => typeof entry === 'string') ? value as string[] : null
/** The asked question of a request title: its last line without OMP's "(n selected) " count. */
function asked(title: unknown): string {
  return collapse(string(title).split('\n').at(-1)!.replace(/^\(\d+ selected\) /, ''))
}
/** The labels OMP offers for a choice field: its options, then Other. */
function offered(field: AskField): string[] {
  const labels = unique(field.options.map(option => option.label))
  return field.other ? [...labels, unique([OTHER_LABEL], labels)[0]] : labels
}
/** A checkbox request: its markers, and at most one trailing action, Done. */
function checkboxMatches(frame: ObjectValue, options: string[], markable: number): boolean {
  const actions = options.slice(markable)
  return frame.selectionMarker === 'checkbox' && frame.markableCount === markable && actions.length <= 1 && actions.every(action => action.endsWith(DONE_SUFFIX))
}
function choiceMatches(field: AskField, frame: ObjectValue): boolean {
  const options = strings(frame.options)
  if (frame.method !== 'select' || !options) return false
  const labels = offered(field)
  const same = labels.every((label, index) => options[index] === label)
  if (field.multi) return same && checkboxMatches(frame, options, labels.length)
  return same && frame.selectionMarker === 'radio' && options.length === labels.length
}
/** Whether a request is the one OMP asks for this field, by its question and its offered labels. */
export function askFrameMatches(field: AskField, frame: ObjectValue, awaitingOther: boolean): boolean {
  if (asked(frame.title) !== collapse(field.question)) return false
  if (awaitingOther) return frame.method === 'input'
  if (field.kind === 'text') return frame.method === (field.multiline || field.value !== '' ? 'editor' : 'input')
  return choiceMatches(field, frame)
}

/** Free text: Other's `input`, or a text field. Other ends a single choice; a checkbox loop continues. */
function textStep(drive: OmpAskDrive, field: AskField, desired: AskDesired): Step {
  const other = drive.awaitingOther
  drive.awaitingOther = false
  if (!other || !field.multi) drive.position++
  return { value: desired.text ?? '' }
}
function radioStep(drive: OmpAskDrive, field: AskField, desired: AskDesired, labels: string[]): Step {
  if (desired.text !== undefined) {
    drive.awaitingOther = true
    return { value: labels[field.options.length] }
  }
  drive.position++
  return { value: labels[desired.chosen[0]] }
}
/** The first markable option whose state in OMP's own `checkedIndices` differs from the answer; Other sits after the options. */
function checkboxToggle(frame: ObjectValue, desired: AskDesired, other: number, markable: number): { index: number; add: boolean } | null {
  const checked = new Set(Array.isArray(frame.checkedIndices) ? frame.checkedIndices : [])
  const wanted = new Set(desired.chosen)
  if (desired.text !== undefined) wanted.add(other)
  for (let index = 0; index < markable; index++) {
    if (checked.has(index) !== wanted.has(index)) return { index, add: wanted.has(index) }
  }
  return null
}
function checkboxStep(drive: OmpAskDrive, field: AskField, desired: AskDesired, frame: ObjectValue): Step {
  const labels = strings(frame.options) ?? []
  const markable = Number(frame.markableCount)
  if (++drive.rounds > markable + 1) return { diverged: `The checkbox question "${field.question}" did not settle.` }
  const toggle = checkboxToggle(frame, desired, field.options.length, markable)
  if (toggle) {
    drive.awaitingOther = toggle.add && toggle.index === field.options.length
    return { value: labels[toggle.index] }
  }
  if (labels[markable] === undefined) return { diverged: `The checkbox question "${field.question}" offered no Done.` }
  drive.position++
  drive.rounds = 0
  return { value: labels[markable] }
}
/** The response to the next request of a submitted form: toggles against OMP's own checked state, then Done. */
export function askDriveStep(drive: OmpAskDrive, frame: ObjectValue): DriveStep {
  const field = drive.fields[drive.position], desired = drive.desired?.[drive.position]
  if (!field || !desired) return { diverged: 'The agent asked more than its form held.' }
  if (!askFrameMatches(field, frame, drive.awaitingOther)) return { diverged: `The agent's request did not match the form's question "${field.question}".` }
  const labels = strings(frame.options) ?? []
  let step: Step
  if (drive.awaitingOther || field.kind === 'text') step = textStep(drive, field, desired)
  else step = field.multi ? checkboxStep(drive, field, desired, frame) : radioStep(drive, field, desired, labels)
  if ('diverged' in step) return step
  return { frame: { type: 'extension_ui_response', id: string(frame.id), value: step.value }, done: drive.position === drive.fields.length }
}

/** The markable options of a lone checkbox `select`: all but at most one trailing Done; null for any other request. */
function checkboxMarkable(frame: ObjectValue, options: string[] | null): number | null {
  if (frame.method !== 'select' || frame.selectionMarker !== 'checkbox' || !options) return null
  const markable = Number(frame.markableCount ?? options.length)
  const actions = options.slice(markable)
  const valid = Number.isInteger(markable) && markable >= 1 && markable <= options.length && actions.length <= 1
  return valid && actions.every(action => action.endsWith(DONE_SUFFIX)) ? markable : null
}
/** A lone checkbox `select` (not from a parsed ask form) as a one-field form, its checked options preselected. */
export function checkboxField(frame: ObjectValue): AskField | null {
  const options = strings(frame.options)
  const markable = checkboxMarkable(frame, options)
  if (!options || markable === null) return null
  const checked = new Set(Array.isArray(frame.checkedIndices) ? frame.checkedIndices : [])
  const other = options[markable - 1] === OTHER_LABEL
  const labels = options.slice(0, other ? markable - 1 : markable)
  if (!labels.length || checked.has(labels.length)) return null
  return { name: 'field_0', question: asked(frame.title), kind: 'choice', multi: true, other, required: options.length === markable,
    options: labels.map((label, index) => ({ value: label, label, checked: checked.has(index) })), value: '', multiline: false }
}
