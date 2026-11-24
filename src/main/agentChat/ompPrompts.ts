import { z } from 'zod'
import type { PendingPrompt } from '../../shared/agents/agentChat'
import { maskAgentChatSecretsDeep } from './secretMask'

type ObjectValue = Record<string, unknown>
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}
const string = (value: unknown): string => typeof value === 'string' ? value : ''
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const safe = (value: string): string => maskAgentChatSecretsDeep(value)
const ignoredUiMethods: Record<string, true> = { notify: true, setStatus: true, setWidget: true, setTitle: true, setWorkingMessage: true, set_editor_text: true, open_url: true }
const dataSchema = z.record(z.string(), z.union([z.string(), z.number(), z.array(z.string())]))
const answersSchema = z.array(z.strictObject({ id: z.string(), selectedOptions: z.array(z.string()), customInput: z.string().optional() }))
const uiHeaderSchema = z.object({ id: z.string().min(1), method: z.string().min(1) })
type Field = { id: string; title: string; options: { label: string; value: string }[]; multi: boolean; numeric: boolean }
export interface OmpHeldPrompt {
  wireId: string
  method: string
  secret: boolean
  prompt: PendingPrompt
  options: Record<string, string>
  fields: Field[]
  index: number
  answers: z.infer<typeof answersSchema>
  data: z.infer<typeof dataSchema>
}
type Answer = { frame?: ObjectValue; next?: OmpHeldPrompt } | null

function offerText(held: OmpHeldPrompt): void {
  if (held.prompt.kind !== 'question' || held.method === 'select' || held.method === 'confirm') return
  if (held.prompt.options.some(option => option.id === 'text')) return
  held.prompt.options.push({ id: 'text', label: held.prompt.options.length ? 'Other' : 'Answer' })
}

function fieldPrompt(held: OmpHeldPrompt): void {
  const field = held.fields[held.index]
  held.prompt.id = safe(held.index ? `${held.wireId}:${held.index}` : held.wireId)
  held.prompt.title = safe(field.title)
  held.options = Object.fromEntries(field.options.map((option, index) => [`option_${index}`, option.value]))
  if (held.prompt.kind === 'question') held.prompt.options = field.options.map((option, index) => ({ id: `option_${index}`, label: safe(option.label) }))
  offerText(held)
}
function approvalOptions(method: string, options: string[]): Record<string, string> | null {
  if (method !== 'select' || options.at(-1) !== 'Deny') return null
  const once = options.slice(0, -1).find(option => option === 'Approve' || option === 'Approve Once')
  if (once === undefined) return null
  const session = options.find(option => option.endsWith('for this session'))
  return { allow_once: once, ...(session ? { allow_chat: session } : {}), deny: 'Deny' }
}
function promptChoices(approval: Record<string, string> | null, options: Record<string, string>, method: string): Pick<PendingPrompt, 'kind' | 'options'> {
  if (approval) return { kind: 'approval', options: Object.entries(approval).map(([id, label]) => ({ id, label: safe(label) })) }
  return { kind: 'question', options: Object.entries(options).map(([id, label]) => ({ id, label: method === 'confirm' ? id === 'yes' ? 'Yes' : 'No' : safe(label) })) }
}
function askFields(frame: ObjectValue): Field[] {
  return array(frame.questions).map(object).map(question => ({
    id: string(question.id), title: string(question.question), multi: question.multi === true, numeric: false,
    options: array(question.options).map(object).map(option => ({ label: string(option.label), value: string(option.label) }))
  }))
}
function formFields(frame: ObjectValue): Field[] {
  return array(object(frame.form).sections).flatMap(section => array(object(section).blocks)).map(object)
    .filter(field => (field.kind === 'text' || field.kind === 'choice') && string(field.name))
    .map(field => ({
      id: string(field.name), title: string(field.question) || string(field.label) || string(field.name),
      multi: field.multi === true, numeric: field.type === 'number',
      options: array(field.options).map(object).filter(option => !option.disabled).map(option => ({ label: string(option.label), value: string(option.value) }))
    }))
}
export function ompHoldPrompt(frame: ObjectValue, attributed: boolean): OmpHeldPrompt | null {
  const header = uiHeaderSchema.safeParse(frame)
  if (!header.success) return null
  const { id: wireId, method } = header.data
  if (Object.hasOwn(ignoredUiMethods, method) || method === 'cancel') return null
  const offered = method === 'select' ? array(frame.options).filter((option): option is string => typeof option === 'string') : []
  const approval = approvalOptions(method, offered)
  const options = approval ?? (method === 'confirm' ? { yes: 'true', no: 'false' } : Object.fromEntries(offered.map((option, index) => [`option_${index}`, option])))
  const fields = method === 'ask' ? askFields(frame) : method === 'form' ? formFields(frame) : []
  const prompt = {
    id: safe(wireId), title: safe(string(frame.title)), detail: safe(string(frame.message)), threadId: null,
    callsign: null, arbitration: { state: 'off' as const, reason: null }, attributed, ...promptChoices(approval, options, method)
  }
  // The choice builder only emits allow_once/allow_chat/deny for an approval.
  const held: OmpHeldPrompt = { wireId, method, secret: frame.secret === true, prompt: prompt as PendingPrompt, options, fields, index: 0, answers: [], data: {} }
  if (fields.length) fieldPrompt(held)
  offerText(held)
  return held
}
function validAskAnswer(answer: z.infer<typeof answersSchema>[number], field: Field): boolean {
  if (answer.id !== field.id || (!field.multi && answer.selectedOptions.length > 1)) return false
  return answer.selectedOptions.every(value => field.options.some(option => option.value === value))
}
function validFieldValue(value: unknown, field: Field): boolean {
  if (field.numeric) return typeof value === 'number'
  if (field.multi) return Array.isArray(value) && value.every(value => typeof value === 'string')
  return typeof value === 'string'
}
function secretAnswers(held: OmpHeldPrompt, text: string): Answer {
  // Multi-step secrets must arrive atomically; none are retained in translator state.
  try {
    const value: unknown = JSON.parse(text)
    if (held.method === 'ask') {
      const answers = answersSchema.parse(value)
      if (answers.length !== held.fields.length || !answers.every((answer, index) => validAskAnswer(answer, held.fields[index]))) return null
      return { frame: { type: 'extension_ui_response', id: held.wireId, answers } }
    }
    const data = dataSchema.parse(value)
    if (!held.fields.every(field => Object.hasOwn(data, field.id) && validFieldValue(data[field.id], field))) return null
    return { frame: { type: 'extension_ui_response', id: held.wireId, data } }
  } catch { return null }
}
function selections(field: Field, selected: string | undefined, text: string): string[] | null {
  if (selected !== undefined) return [selected]
  if (!field.multi || !text.startsWith('[')) return []
  try {
    const values = z.array(z.string()).parse(JSON.parse(text))
    return values.every(value => field.options.some(option => option.value === value)) ? values : null
  } catch { return null }
}
function storeField(next: OmpHeldPrompt, field: Field, chosen: string[], value: string): boolean {
  if (next.method === 'ask') {
    next.answers.push({ id: field.id, selectedOptions: chosen, ...(!chosen.length ? { customInput: value } : {}) })
    return true
  }
  const converted = field.numeric ? Number(value) : field.multi ? chosen.length ? chosen : [value] : value
  if (typeof converted === 'number' && !Number.isFinite(converted)) return false
  Object.defineProperty(next.data, field.id, { value: converted, enumerable: true, configurable: true, writable: true })
  return true
}
function fieldAnswer(held: OmpHeldPrompt, selected: string | undefined, value: string): Answer {
  if (held.secret && held.fields.length > 1) return secretAnswers(held, value)
  const field = held.fields[held.index]
  const chosen = selections(field, selected, value)
  if (chosen === null) return null
  const next = structuredClone(held)
  if (!storeField(next, field, chosen, value)) return null
  next.index++
  if (next.index < next.fields.length) { fieldPrompt(next); return { next } }
  return { frame: { type: 'extension_ui_response', id: held.wireId, ...(held.method === 'ask' ? { answers: next.answers } : { data: next.data }) } }
}
function freeAnswer(held: OmpHeldPrompt, value: string): Answer {
  if (held.method === 'ask') return { frame: { type: 'extension_ui_response', id: held.wireId, answers: [{ id: held.wireId, selectedOptions: [], customInput: value }] } }
  if (held.method === 'form') {
    try { return { frame: { type: 'extension_ui_response', id: held.wireId, data: dataSchema.parse(JSON.parse(value)) } } }
    catch { return null }
  }
  return { frame: { type: 'extension_ui_response', id: held.wireId, value } }
}
function answerValue(held: OmpHeldPrompt, optionId: string, text?: string): { selected?: string; value: string } | null {
  if (Object.hasOwn(held.options, optionId)) return { selected: held.options[optionId], value: held.options[optionId] }
  if (optionId !== 'text' || text === undefined || !held.prompt.options.some(option => option.id === 'text')) return null
  return { value: text }
}
/** Secret answers exist only in the returned stdin frame, never in held state or events. */
export function ompAnswerPrompt(held: OmpHeldPrompt, optionId: string, text?: string): Answer {
  const answer = answerValue(held, optionId, text)
  if (!answer) return null
  if (held.method === 'confirm') return { frame: { type: 'extension_ui_response', id: held.wireId, confirmed: answer.selected === 'true' } }
  return held.fields.length ? fieldAnswer(held, answer.selected, answer.value) : freeAnswer(held, answer.value)
}
