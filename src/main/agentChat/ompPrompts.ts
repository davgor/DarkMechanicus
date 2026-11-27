import { z } from 'zod'
import { pendingPromptSchema, type PendingPrompt } from '../../shared/agents/agentChat'
import type { FormFieldAnswer } from './pendingPrompts'
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
/** `text`: whether the field takes free text never, beside its options, or only text; `checked` is the agent's default. */
type Field = {
  id: string; title: string; multi: boolean; numeric: boolean; text: 'none' | 'other' | 'only'
  options: { label: string; value: string; description: string; checked: boolean }[]
}
export interface OmpHeldPrompt {
  wireId: string
  method: string
  secret: boolean
  prompt: PendingPrompt
  options: Record<string, string>
  fields: Field[]
}
type Answer = { frame: ObjectValue } | null

function offerText(held: OmpHeldPrompt): void {
  if (held.prompt.kind !== 'question' || held.prompt.form || held.method === 'select' || held.method === 'confirm') return
  if (held.prompt.options.some(option => option.id === 'text')) return
  held.prompt.options.push({ id: 'text', label: held.prompt.options.length ? 'Other' : 'Answer' })
}

/** An ask or form of one field, or a secret one (answered as one JSON value): its first field as one question. */
function fieldPrompt(held: OmpHeldPrompt): void {
  const field = held.fields[0]
  held.prompt.title = safe(field.title)
  held.options = Object.fromEntries(field.options.map((option, index) => [`option_${index}`, option.value]))
  if (held.prompt.kind === 'question') {
    held.prompt.options = field.options.map((option, index) => ({ id: `option_${index}`, label: safe(option.label), ...(option.description ? { description: safe(option.description) } : {}) }))
    held.prompt.multi = field.multi
    if (held.fields.length > 1) held.prompt.progress = { index: 1, total: held.fields.length }
  }
}
/**
 * Every field of one ask or form as one form prompt; fields are answered together by position (`field_<n>`). False,
 * leaving the prompt as it was, when the contract cannot carry it (too many fields or options).
 */
function formPrompt(held: OmpHeldPrompt): boolean {
  const form = { fields: held.fields.map((field, index) => ({
    id: `field_${index}`, title: safe(field.title).slice(0, 2_000), multi: field.multi, text: field.text,
    options: field.options.map((option, choice) => ({ id: `option_${choice}`, label: safe(option.label),
      ...(option.description ? { description: safe(option.description) } : {}), ...(option.checked ? { preselected: true } : {}) }))
  })) }
  const prompt = pendingPromptSchema.safeParse({ ...held.prompt, title: held.prompt.title || `Answer ${held.fields.length} questions`, options: [], form })
  if (!prompt.success) return false
  held.prompt = prompt.data
  return true
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
/** An ask always takes free text beside its options; a single question's `recommended` index is its default. */
function askFields(frame: ObjectValue): Field[] {
  return array(frame.questions).map(object).map(question => {
    const multi = question.multi === true
    const recommended = !multi && Number.isInteger(question.recommended) ? Number(question.recommended) : -1
    return { id: string(question.id), title: string(question.question), multi, numeric: false, text: 'other' as const,
      options: array(question.options).map(object).map((option, index) => ({ label: string(option.label), value: string(option.label), description: string(option.description), checked: index === recommended })) }
  })
}
function formFields(frame: ObjectValue): Field[] {
  return array(object(frame.form).sections).flatMap(section => array(object(section).blocks)).map(object)
    .filter(field => (field.kind === 'text' || field.kind === 'choice') && string(field.name))
    .map(field => ({
      id: string(field.name), title: string(field.question) || string(field.label) || string(field.name),
      multi: field.multi === true, numeric: field.type === 'number', text: field.kind === 'text' ? 'only' as const : field.other === true ? 'other' as const : 'none' as const,
      options: array(field.options).map(object).filter(option => !option.disabled).map(option => ({ label: string(option.label), value: string(option.value), description: string(option.description), checked: option.checked === true }))
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
  const prompt = {
    id: safe(wireId), title: safe(string(frame.title)), detail: safe(string(frame.message)), threadId: null,
    callsign: null, arbitration: { state: 'off' as const, reason: null }, attributed, ...promptChoices(approval, options, method)
  }
  // The choice builder only emits allow_once/allow_chat/deny for an approval.
  const held: OmpHeldPrompt = { wireId, method, secret: frame.secret === true, prompt: prompt as PendingPrompt, options, fields: questionFields(method, frame) }
  shapeFields(held)
  offerText(held)
  return held
}
function questionFields(method: string, frame: ObjectValue): Field[] {
  if (method === 'ask') return askFields(frame)
  return method === 'form' ? formFields(frame) : []
}
/** Several fields, unless secret, are one form prompt; one field (or a secret ask or form) is today's question. */
function shapeFields(held: OmpHeldPrompt): void {
  if (held.fields.length > 1 && !held.secret && formPrompt(held)) held.options = {}
  else if (held.fields.length) fieldPrompt(held)
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
  // Multi-field secrets arrive atomically as one JSON value; none are retained in translator state.
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
/** One field's native value: an ask answer entry, or a form data value; null for a number that is not one. */
type FieldValue = z.infer<typeof answersSchema>[number] | string | number | string[]
function fieldValue(method: string, field: Field, chosen: string[], custom: string | undefined): FieldValue | null {
  if (method === 'ask') return { id: field.id, selectedOptions: chosen, ...(custom === undefined ? {} : { customInput: custom }) }
  const converted = field.numeric ? Number(custom ?? chosen[0]) : field.multi ? [...chosen, ...(custom === undefined ? [] : [custom])] : custom ?? chosen[0]
  return typeof converted === 'number' && !Number.isFinite(converted) ? null : converted
}
/** The one native frame of an ask (`answers`, in question order) or a form (`data`) from each field's value. */
function fieldsFrame(held: OmpHeldPrompt, values: (FieldValue | null)[]): Answer {
  if (values.some(value => value === null)) return null
  if (held.method === 'ask') return { frame: { type: 'extension_ui_response', id: held.wireId, answers: values } }
  const data: Record<string, unknown> = {}
  held.fields.forEach((field, index) => Object.defineProperty(data, field.id, { value: values[index], enumerable: true, configurable: true, writable: true }))
  return { frame: { type: 'extension_ui_response', id: held.wireId, data } }
}
/** `custom` is the free text: an ask's customInput beside any choices, or one more value of a form field. */
function fieldAnswer(held: OmpHeldPrompt, chosen: string[], custom: string | undefined): Answer {
  return fieldsFrame(held, [fieldValue(held.method, held.fields[0], chosen, custom)])
}
/** A multi field's chosen values in option order; null for an unknown or repeated id, or `text` without free text. */
function multiAnswer(held: OmpHeldPrompt, optionIds: readonly string[], text: string | undefined): Answer {
  const field = held.fields[0]
  const offersText = held.prompt.options.some(option => option.id === 'text')
  if (!field?.multi || held.fields.length > 1 || new Set(optionIds).size !== optionIds.length) return null
  if (!optionIds.every(id => Object.hasOwn(held.options, id) || (id === 'text' && offersText && !!text))) return null
  const chosen = Object.keys(held.options).filter(id => optionIds.includes(id)).map(id => held.options[id])
  return fieldAnswer(held, chosen, optionIds.includes('text') ? text : undefined)
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
/** Secret answers exist only in the returned stdin frame, never in held state or events. A list of ids answers a multi field. */
export function ompAnswerPrompt(held: OmpHeldPrompt, choice: string | readonly string[], text?: string): Answer {
  if (typeof choice !== 'string') return multiAnswer(held, choice, text)
  if (held.prompt.kind === 'question' && held.prompt.form) return null
  const answer = answerValue(held, choice, text)
  if (!answer) return null
  if (held.method === 'confirm') return { frame: { type: 'extension_ui_response', id: held.wireId, confirmed: answer.selected === 'true' } }
  if (held.fields.length > 1) return held.secret ? secretAnswers(held, answer.value) : null
  if (!held.fields.length) return freeAnswer(held, answer.value)
  return answer.selected === undefined ? fieldAnswer(held, [], answer.value) : fieldAnswer(held, [answer.selected], undefined)
}
/**
 * Every field of a form prompt at once, as one native frame: an ask's `answers` (labels, then `customInput`), a form's
 * `data`. Null unless each field is answered exactly once with offered options, text only where the field takes it,
 * and a single choice holding exactly one option or text (OMP refuses a single answer carrying both).
 */
export function ompAnswerForm(held: OmpHeldPrompt, answers: readonly FormFieldAnswer[]): Answer {
  if (held.prompt.kind !== 'question' || !held.prompt.form || answers.length !== held.fields.length) return null
  if (new Set(answers.map(answer => answer.fieldId)).size !== answers.length) return null
  return fieldsFrame(held, held.fields.map((field, index) => {
    const answer = answers.find(entry => entry.fieldId === `field_${index}`)
    return answer ? formFieldValue(held.method, field, answer) : null
  }))
}
type Option = Field['options'][number]
/** The chosen options; null for an unknown or repeated id. */
function chosenOptions(field: Field, optionIds: readonly string[]): Option[] | null {
  const picked = optionIds.map(id => /^option_\d+$/.test(id) ? field.options[Number(id.slice('option_'.length))] : undefined)
    .filter((option): option is Option => option !== undefined)
  return picked.length === optionIds.length && new Set(picked).size === picked.length ? picked : null
}
/** Text only where the field takes it, and a single choice holding exactly one option or text. */
function choiceAllowed(field: Field, chosen: number, text: string | undefined): boolean {
  if (text !== undefined && field.text === 'none') return false
  return field.multi || chosen + (text === undefined ? 0 : 1) === 1
}
/** One field's native value from its form answer; null for an invalid answer (see `ompAnswerForm`). */
function formFieldValue(method: string, field: Field, answer: FormFieldAnswer): FieldValue | null {
  const chosen = chosenOptions(field, answer.optionIds)
  if (!chosen) return null
  if (field.text === 'only') return chosen.length ? null : fieldValue(method, field, [], answer.text ?? '')
  const text = answer.text?.trim() ? answer.text : undefined
  if (!choiceAllowed(field, chosen.length, text)) return null
  return fieldValue(method, field, field.options.filter(option => chosen.includes(option)).map(option => option.value), text)
}
/** The person's form answers as transcript text, `question: answer` per field; never for a secret prompt. */
export function ompFormSummary(held: OmpHeldPrompt, answers: readonly FormFieldAnswer[]): string {
  return held.fields.map((field, index) => {
    const answer = answers.find(entry => entry.fieldId === `field_${index}`)
    const labels = field.options.filter((_, choice) => answer?.optionIds.includes(`option_${choice}`)).map(option => option.label)
    return `${field.title}: ${[...labels, ...(answer?.text?.trim() ? [answer.text] : [])].join(', ')}`
  }).join('\n')
}
