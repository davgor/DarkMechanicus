import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PendingPrompt } from '../../shared/agents/agentChat'
import { askDesired, askPromptForm, parseAskForm } from './ompAskForm'
import { createOmpState, encodeOmpCommand, translateOmpLine, type OmpEvent } from './ompProtocol'
import { ompAnswerForm, ompAnswerPrompt, ompHoldPrompt, type OmpHeldPrompt } from './ompPrompts'
import type { FormFieldAnswer } from './pendingPrompts'

function hold(frame: Record<string, unknown>): OmpHeldPrompt {
  const held = ompHoldPrompt(frame, true)
  if (held === null) throw new Error('The prompt was not held.')
  return held
}

const form = (blocks: unknown[], extra: Record<string, unknown> = {}): OmpHeldPrompt =>
  hold({ id: 'f1', method: 'form', title: 'Setup', form: { sections: [{ blocks }] }, ...extra })

const response = (body: Record<string, unknown>, id = 'f1') => ({ frame: { type: 'extension_ui_response', id, ...body } })

describe('ompHoldPrompt headers, select choices and field titles', () => {
  it('holds nothing without an id or a method', () => {
    expect([ompHoldPrompt({ method: 'select' }, true), ompHoldPrompt({ id: 'x' }, true)]).toEqual([null, null])
  })

  it('asks a select with Deny but no approve option as a plain question and answers with the chosen label', () => {
    const held = hold({ id: 's', method: 'select', title: 'Pick', options: ['Maybe', 'Deny'] })
    expect(held.prompt.kind).toBe('question')
    expect(held.prompt.options.map((option) => option.label)).toEqual(['Maybe', 'Deny'])
    expect(ompAnswerPrompt(held, 'option_1')).toEqual(response({ value: 'Deny' }, 's'))
  })

  it('titles a form field by its question, then its label, then its name, and skips other blocks', () => {
    const held = form([{ kind: 'text', name: 'a', question: 'Q?', label: 'L' }, { kind: 'text', name: 'b', label: 'Label B' }, { kind: 'text', name: 'c' }, { kind: 'note', name: 'skip' }])
    expect(held.fields.map((field) => field.title)).toEqual(['Q?', 'Label B', 'c'])
  })
})

describe('ompAnswerPrompt one-field forms', () => {
  it('converts a numeric field and refuses a value that is not a number', () => {
    const held = form([{ kind: 'text', name: 'count', type: 'number', label: 'Count' }])
    expect(ompAnswerPrompt(held, 'text', 'many')).toBeNull()
    expect(ompAnswerPrompt(held, 'text', '42')).toEqual(response({ data: { count: 42 } }))
  })

  it('takes a multi choice as offered options in option order, an offered option, or free text as one literal value', () => {
    const held = form([{ kind: 'choice', name: 'tags', multi: true, options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }, { label: 'Off', value: 'off', disabled: true }] }])
    expect(held.prompt.options.map((option) => option.id)).toEqual(['option_0', 'option_1', 'text'])
    expect(ompAnswerPrompt(held, 'option_1')).toEqual(response({ data: { tags: ['b'] } }))
    expect(ompAnswerPrompt(held, ['option_1', 'option_0'])).toEqual(response({ data: { tags: ['a', 'b'] } }))
    expect(ompAnswerPrompt(held, 'text', '["a","b"]')).toEqual(response({ data: { tags: ['["a","b"]'] } }))
    expect(ompAnswerPrompt(held, 'text', 'custom')).toEqual(response({ data: { tags: ['custom'] } }))
    expect([ompAnswerPrompt(held, ['option_2']), ompAnswerPrompt(held, ['option_0', 'option_0']), ompAnswerPrompt(held, ['text'])]).toEqual([null, null, null])
  })

  it('refuses a list of ids on a single-choice field and shows no step count for one field', () => {
    const held = form([{ kind: 'choice', name: 'tag', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] }])
    expect(held.prompt).toMatchObject({ multi: false })
    expect(held.prompt.kind === 'question' && held.prompt.progress).toBeUndefined()
    expect([ompAnswerPrompt(held, ['option_0']), ompAnswerPrompt(held, ['option_0', 'option_1'])]).toEqual([null, null])
  })
})

describe('ompAnswerPrompt secret prompts with several fields', () => {
  it('answers a secret ask only as one complete, valid JSON answer list', () => {
    const held = hold({ id: 's1', method: 'ask', secret: true, questions: [
      { id: 'q1', question: 'Q1', options: [{ label: 'A' }, { label: 'B' }] },
      { id: 'q2', question: 'Q2', multi: true, options: [{ label: 'C' }, { label: 'D' }] }
    ] })
    const valid = [{ id: 'q1', selectedOptions: ['A'] }, { id: 'q2', selectedOptions: ['C', 'D'] }]
    expect(ompAnswerPrompt(held, 'text', JSON.stringify(valid))).toEqual(response({ answers: valid }, 's1'))
    const invalid = [
      [{ id: 'q1', selectedOptions: ['A'] }],
      [{ id: 'q1', selectedOptions: ['A', 'B'] }, { id: 'q2', selectedOptions: [] }],
      [{ id: 'q9', selectedOptions: ['A'] }, { id: 'q2', selectedOptions: [] }],
      [{ id: 'q1', selectedOptions: ['Z'] }, { id: 'q2', selectedOptions: [] }]
    ].map((answers) => JSON.stringify(answers))
    expect([...invalid, 'not json'].map((text) => ompAnswerPrompt(held, 'text', text))).toEqual([null, null, null, null, null])
    expect(held.prompt).toMatchObject({ progress: { index: 1, total: 2 } })
    expect(held.prompt.kind === 'question' && held.prompt.form).toBeUndefined()
  })

  it('answers a secret form only with every field present and of its type', () => {
    const held = form([
      { kind: 'text', name: 'pin', type: 'number', question: 'PIN' },
      { kind: 'choice', name: 'tags', multi: true, options: [{ label: 'A', value: 'a' }] },
      { kind: 'text', name: 'note' }
    ], { secret: true })
    expect(ompAnswerPrompt(held, 'text', '{"pin":1234,"tags":["a"],"note":"x"}')).toEqual(response({ data: { pin: 1234, tags: ['a'], note: 'x' } }))
    const invalid = ['{"pin":"1234","tags":["a"],"note":"x"}', '{"pin":1234,"tags":"a","note":"x"}', '{"pin":1234,"tags":["a"]}', '{"pin":1234,"tags":["a"],"note":5}']
    expect(invalid.map((text) => ompAnswerPrompt(held, 'text', text))).toEqual([null, null, null, null])
    expect(held.prompt.kind === 'question' && held.prompt.form).toBeUndefined()
  })
})

const fixtures = join(import.meta.dirname, '__fixtures__', 'omp')
const golden = (name: string): string[] => readFileSync(join(fixtures, name), 'utf8').trim().split(/\r?\n/)
const goldenFrames = (name: string): Record<string, unknown>[] => golden(name).map(line => JSON.parse(line) as Record<string, unknown>)
type FormOf = NonNullable<Extract<PendingPrompt, { kind: 'question' }>['form']>
const formOf = (prompt: PendingPrompt | undefined): FormOf => {
  if (prompt?.kind !== 'question' || !prompt.form) throw new Error('Not a form prompt.')
  return prompt.form
}
/** The answers a person leaves untouched: every preselected option and each text field's default. */
const defaults = (form: FormOf): FormFieldAnswer[] => form.fields.map(field => ({
  fieldId: field.id, optionIds: field.options.filter(option => option.preselected).map(option => option.id)
}))

describe('OMP method ask with several questions (askDialog, one answers[] frame)', () => {
  const request = goldenFrames('question_multi.out.jsonl').find(frame => frame.method === 'ask')!

  it('holds every question as one form prompt, the radio recommendation preselected, free text beside options', () => {
    const held = hold(request)
    expect(held.prompt).toMatchObject({ id: 'ui_T1_question_multi', title: 'Answer 2 questions', options: [] })
    expect(formOf(held.prompt).fields).toEqual([
      { id: 'field_0', title: 'Which databases?', multi: true, text: 'other', required: false, options: [
        { id: 'option_0', label: 'SQLite', description: 'Local database' }, { id: 'option_1', label: 'Postgres', description: 'Server database' },
        { id: 'option_2', label: 'MySQL', description: 'Server database' }, { id: 'option_3', label: 'DuckDB', description: 'Analytics database' }] },
      { id: 'field_1', title: 'Which region?', multi: false, text: 'other', required: true, options: [
        { id: 'option_0', label: 'EU', description: 'Europe', preselected: true }, { id: 'option_1', label: 'US', description: 'United States' }] }
    ])
  })

  it('answers every question in one frame, the untouched default included, as the golden records it', () => {
    const held = hold(request)
    const answer = ompAnswerForm(held, [{ fieldId: 'field_1', optionIds: ['option_0'] }, { fieldId: 'field_0', optionIds: ['option_1', 'option_0'] }])
    expect(answer).toEqual({ frame: JSON.parse(golden('question_multi.in.jsonl')[1]) })
    expect(ompAnswerForm(held, [{ fieldId: 'field_0', optionIds: ['option_2'], text: 'Redis' }, { fieldId: 'field_1', optionIds: [], text: 'Mars' }])).toEqual(response({ answers: [
      { id: 'q_T1_databases', selectedOptions: ['MySQL'], customInput: 'Redis' }, { id: 'q_T1_region', selectedOptions: [], customInput: 'Mars' }] }, 'ui_T1_question_multi'))
  })

  it('never sends a partial or invalid answer', () => {
    const held = hold(request)
    const invalid: FormFieldAnswer[][] = [
      [{ fieldId: 'field_0', optionIds: ['option_0'] }],
      [{ fieldId: 'field_0', optionIds: ['option_0'] }, { fieldId: 'field_0', optionIds: ['option_0'] }],
      [{ fieldId: 'field_0', optionIds: ['option_9'] }, { fieldId: 'field_1', optionIds: ['option_0'] }],
      [{ fieldId: 'field_0', optionIds: ['option_0', 'option_0'] }, { fieldId: 'field_1', optionIds: ['option_0'] }],
      [{ fieldId: 'field_0', optionIds: [] }, { fieldId: 'field_1', optionIds: ['option_0', 'option_1'] }],
      [{ fieldId: 'field_0', optionIds: [] }, { fieldId: 'field_1', optionIds: ['option_0'], text: 'and text' }],
      [{ fieldId: 'field_0', optionIds: [] }, { fieldId: 'field_1', optionIds: [] }]
    ]
    expect(invalid.map(fields => ompAnswerForm(held, fields))).toEqual(invalid.map(() => null))
    expect([ompAnswerPrompt(held, 'option_0'), ompAnswerPrompt(held, ['option_0'])]).toEqual([null, null])
  })

  it('sends a multi question empty (it is optional) but never a single one', () => {
    const held = hold(request)
    expect(ompAnswerForm(held, [{ fieldId: 'field_0', optionIds: [] }, { fieldId: 'field_1', optionIds: ['option_1'] }])).toEqual(response({ answers: [
      { id: 'q_T1_databases', selectedOptions: [] }, { id: 'q_T1_region', selectedOptions: ['US'] }] }, 'ui_T1_question_multi'))
  })
})

describe('OMP form request with several fields (one data record)', () => {
  it('preselects checked options and answers every field in one data record', () => {
    const held = form([
      { kind: 'choice', name: 'tags', multi: true, other: true, options: [{ label: 'A', value: 'a', checked: true }, { label: 'B', value: 'b' }] },
      { kind: 'choice', name: 'size', options: [{ label: 'Small', value: 's' }, { label: 'Large', value: 'l', checked: true }] },
      { kind: 'text', name: 'count', type: 'number', question: 'How many?' }
    ])
    expect(formOf(held.prompt).fields.map(field => [field.text, field.options.filter(option => option.preselected).map(option => option.label)]))
      .toEqual([['other', ['A']], ['none', ['Large']], ['only', []]])
    expect(ompAnswerForm(held, [...defaults(formOf(held.prompt)).slice(0, 2), { fieldId: 'field_2', optionIds: [], text: '3' }]))
      .toEqual(response({ data: { tags: ['a'], size: 'l', count: 3 } }))
    expect(ompAnswerForm(held, [{ fieldId: 'field_0', optionIds: ['option_1'], text: 'zz' }, { fieldId: 'field_1', optionIds: ['option_0'] }, { fieldId: 'field_2', optionIds: [], text: 'x' }])).toBeNull()
    expect(ompAnswerForm(held, [{ fieldId: 'field_0', optionIds: ['option_1'], text: 'zz' }, { fieldId: 'field_1', optionIds: ['option_0'] }, { fieldId: 'field_2', optionIds: [], text: '7' }]))
      .toEqual(response({ data: { tags: ['b', 'zz'], size: 's', count: 7 } }))
  })
})

describe('OMP form request: required fields', () => {
  it('marks a single choice and a field the form requires as required, refuses them empty, and sends an optional group empty', () => {
    const held = form([
      { kind: 'choice', name: 'tags', multi: true, options: [{ label: 'A', value: 'a' }] },
      { kind: 'choice', name: 'must', multi: true, required: true, options: [{ label: 'B', value: 'b' }] },
      { kind: 'choice', name: 'size', options: [{ label: 'Small', value: 's' }] },
      { kind: 'text', name: 'why', required: true }
    ])
    expect(formOf(held.prompt).fields.map(field => field.required)).toEqual([false, true, true, true])
    const answers = (must: string[], why: string) => [{ fieldId: 'field_0', optionIds: [] }, { fieldId: 'field_1', optionIds: must },
      { fieldId: 'field_2', optionIds: ['option_0'] }, { fieldId: 'field_3', optionIds: [], text: why }]
    expect(ompAnswerForm(held, answers([], 'because'))).toBeNull()
    expect(ompAnswerForm(held, answers(['option_0'], '  '))).toBeNull()
    expect(ompAnswerForm(held, answers(['option_0'], 'because'))).toEqual(response({ data: { tags: [], must: ['b'], size: 's', why: 'because' } }))
  })
})

type Replay = { prompts: PendingPrompt[]; written: Record<string, unknown>[]; events: OmpEvent[]; frames: number[] }
/**
 * Feeds a recorded OMP 18.20.2 stream through the translator, answering every published prompt once with `answer`;
 * `written` is every stdin frame main sends, and `frames` how many each OMP request drew.
 */
function replay(lines: string[], answer: (prompt: PendingPrompt) => FormFieldAnswer[]): Replay {
  let state = createOmpState()
  const result: Replay = { prompts: [], written: [], events: [], frames: [] }
  for (const line of lines) {
    const translated = translateOmpLine(line, state, '2026-11-27T00:00:00.000Z')
    state = translated.state
    result.written.push(...translated.lines.map(entry => JSON.parse(entry) as Record<string, unknown>))
    result.events.push(...translated.events)
    if (JSON.parse(line).type === 'extension_ui_request') result.frames.push(translated.lines.length)
    for (const event of translated.events) {
      if (event.type !== 'pending' || !event.prompt) continue
      result.prompts.push(event.prompt)
      const encoded = encodeOmpCommand({ type: 'answer', id: 'answer', promptId: event.prompt.id, fields: answer(event.prompt) }, state, '2026-11-27T00:00:00.000Z')
      state = encoded.state
      result.written.push(...encoded.lines.map(entry => JSON.parse(entry) as Record<string, unknown>))
      result.events.push(...encoded.events)
    }
  }
  return result
}
const responses = (name: string): Record<string, unknown>[] => goldenFrames(name).filter(frame => frame.type === 'extension_ui_response')

describe('OMP 18.20.2 ask tool goldens (HTML form, answered field by field over RPC)', () => {
  it('holds the recorded ask as one prompt with all three fields and the form defaults preselected', () => {
    const { prompts } = replay(golden('ask_multi_q.out.jsonl'), prompt => defaults(formOf(prompt)).map(field => field.fieldId === 'note' ? { ...field, text: 'No' } : field))
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({ id: 'ui_T1_ask_1', kind: 'question', title: 'Answer 3 questions', options: [] })
    expect(formOf(prompts[0]).fields).toEqual([
      { id: 'databases', title: 'Which databases?', multi: true, text: 'other', required: false, options: [
        { id: 'option_0', label: 'SQLite', preselected: true }, { id: 'option_1', label: 'Postgres', preselected: true },
        { id: 'option_2', label: 'MySQL' }, { id: 'option_3', label: 'DuckDB' }] },
      { id: 'region', title: 'Which region?', multi: false, text: 'other', required: true, options: [
        { id: 'option_0', label: 'EU' }, { id: 'option_1', label: 'US', preselected: true }, { id: 'option_2', label: 'APAC' }] },
      { id: 'note', title: 'Anything else?', multi: false, text: 'only', required: false, options: [] }
    ])
  })

  it('answers untouched defaults with exactly the responses OMP accepted, the pre-checked group kept', () => {
    const result = replay(golden('ask_multi_q.out.jsonl'), prompt => defaults(formOf(prompt)).map(field => field.fieldId === 'note' ? { ...field, text: 'No' } : field))
    expect(result.written).toEqual(responses('ask_multi_q.in.jsonl'))
    expect(result.written[0]).toEqual({ type: 'extension_ui_response', id: 'ui_T1_ask_1', value: '✔ Done selecting' })
    expect(result.frames).toEqual([0, 1, 1])
    const answered = result.events.flatMap(event => event.type === 'item' && event.item.kind === 'user_message' ? [event.item.text] : [])
    expect(answered).toEqual(['Which databases?: SQLite, Postgres\nWhich region?: US\nAnything else?: No'])
    const toolResult = goldenFrames('ask_multi_q.out.jsonl').find(frame => frame.type === 'tool_execution_end')
    expect(JSON.stringify(toolResult)).toContain('\\"databases\\": [\\n    \\"sqlite\\",\\n    \\"postgres\\"\\n  ]')
  })

  it('lands toggles, Other text, a changed radio and typed text as the recorded responses after one Submit', () => {
    const result = replay(golden('ask_multi_q_changed.out.jsonl'), () => [
      { fieldId: 'databases', optionIds: ['option_2', 'option_1'], text: 'Redis' },
      { fieldId: 'region', optionIds: ['option_2'] },
      { fieldId: 'note', optionIds: [], text: 'Use the fixture cluster' }
    ])
    expect(result.prompts).toHaveLength(1)
    expect(result.written).toEqual(responses('ask_multi_q_changed.in.jsonl'))
    expect(result.written.map(frame => frame.value)).toEqual(['SQLite', 'MySQL', 'Other (type your own)', 'Redis', '✔ Done selecting', 'APAC', 'Use the fixture cluster'])
  })

})

describe('OMP 18.20.2 ask tool goldens: divergence and lone checkbox selects', () => {
  it('stops at a request that does not match the form, says so, and shows it as its own card without answering it', () => {
    const lines = golden('ask_multi_q.out.jsonl').map(line => line.includes('"id":"ui_T1_ask_2"') ? line.replace('"EU"', '"Europe"') : line)
    const result = replay(lines, prompt => prompt.kind === 'question' && prompt.form ? defaults(prompt.form).map(field => field.fieldId === 'note' ? { ...field, text: 'No' } : field) : [])
    expect(result.written).toEqual([responses('ask_multi_q.in.jsonl')[0]])
    expect(result.frames).toEqual([0, 0, 0])
    expect(result.events.some(event => event.type === 'item' && event.item.kind === 'error' && event.item.message.includes('did not match'))).toBe(true)
    expect(result.prompts.slice(1).map(prompt => [prompt.id, prompt.kind === 'question' && prompt.options.map(option => option.label)]))
      .toEqual([['ui_T1_ask_2', ['Europe', 'US', 'APAC', 'Other (type your own)']]])
    expect(result.events.some(event => event.type === 'item' && event.item.kind === 'approval_request' && event.item.requestId === 'ui_T1_ask_3')).toBe(true)
  })

  it('fails visibly when a checkbox group never settles, after markable options + 1 rounds', () => {
    const lines = golden('ask_multi_q_changed.out.jsonl')
    const first = lines.findIndex(line => line.includes('"id":"ui_T1_ask_1"'))
    const stuck = Array.from({ length: 7 }, (_, index) => lines[first].replaceAll('ui_T1_ask_1', `ui_T1_stuck_${index}`))
    const result = replay([...lines.slice(0, first + 1), ...stuck], () => [
      { fieldId: 'databases', optionIds: ['option_1'] }, { fieldId: 'region', optionIds: ['option_1'] }, { fieldId: 'note', optionIds: [], text: '' }
    ])
    expect(result.written.map(frame => frame.value)).toEqual(Array.from({ length: 6 }, () => 'SQLite'))
    expect(result.events.some(event => event.type === 'item' && event.item.kind === 'error' && event.item.message.includes('did not settle'))).toBe(true)
    expect(result.prompts.at(-1)?.id).toBe('ui_T1_stuck_5')
  })

  it('shows a lone checkbox select as a one-field form with its checked options, and toggles to the answer', () => {
    const select = { type: 'extension_ui_request', id: 'ui_T1_lone', method: 'select', title: '(1 selected) Pick', options: ['A', 'B', '✔ Done selecting'], selectionMarker: 'checkbox', checkedIndices: [0], markableCount: 2 }
    const next = { ...select, id: 'ui_T1_lone_2', title: '(2 selected) Pick', checkedIndices: [0, 1] }
    const result = replay([JSON.stringify(select), JSON.stringify(next)], () => [{ fieldId: 'field_0', optionIds: ['option_0', 'option_1'] }])
    expect(formOf(result.prompts[0]).fields).toEqual([{ id: 'field_0', title: 'Pick', multi: true, text: 'none', required: false, options: [{ id: 'option_0', label: 'A', preselected: true }, { id: 'option_1', label: 'B' }] }])
    expect(result.written).toEqual([{ type: 'extension_ui_response', id: 'ui_T1_lone', value: 'B' }, { type: 'extension_ui_response', id: 'ui_T1_lone_2', value: '✔ Done selecting' }])
  })
})

describe('parseAskForm (inert HTML form parser)', () => {
  it('reads the recorded form: legends as questions, checked defaults, Other on radio/checkbox groups', () => {
    const args = goldenFrames('ask_multi_q.out.jsonl').find(frame => frame.type === 'tool_execution_start')?.args
    const html = args && typeof args === 'object' && 'html' in args ? String(args.html) : ''
    expect(parseAskForm(html)?.map(field => [field.name, field.question, field.kind, field.multi, field.other, field.options.filter(option => option.checked).map(option => option.value)]))
      .toEqual([['databases', 'Which databases?', 'choice', true, true, ['sqlite', 'postgres']], ['region', 'Which region?', 'choice', false, true, ['us']], ['note', 'Anything else?', 'text', false, false, []]])
  })

  it('takes a group\'s required from any of its controls; a radio group is always required, an unmarked checkbox group optional', () => {
    const fields = parseAskForm('<form><fieldset><legend>Tags</legend><label><input type="checkbox" name="tags" value="a"> A</label><label><input type="checkbox" name="tags" value="b" required> B</label></fieldset>'
      + '<fieldset><legend>Extras</legend><label><input type="checkbox" name="extras" value="x"> X</label></fieldset>'
      + '<fieldset><legend>Size</legend><label><input type="radio" name="size" value="s"> S</label></fieldset></form>')!
    const identity = (text: string) => text
    expect(askPromptForm(fields, identity).fields.map(field => [field.id, field.required])).toEqual([['tags', true], ['extras', false], ['size', true]])
    const answers = (tags: string[]) => [{ fieldId: 'tags', optionIds: tags }, { fieldId: 'extras', optionIds: [] }, { fieldId: 'size', optionIds: ['option_0'] }]
    expect(askDesired(fields, answers([]), identity)).toBeNull()
    expect(askDesired(fields, answers(['option_1']), identity)).toEqual([{ chosen: [1] }, { chosen: [] }, { chosen: [0] }])
  })

  it('labels by for=, keeps select defaults and textarea values, titles an unlabelled control by its name as OMP does, ignores scripts and buttons', () => {
    const fields = parseAskForm('<form><script>alert("<input name=x>")</script><label for="c">Colour &amp; tone</label><select id="c" name="colour"><option value="r">Red</option><option value="g" selected>Green</option></select>'
      + '<p>Notes</p><textarea name="notes">\nhello</textarea><button>Go</button><input type="submit"></form>')
    expect(fields?.map(field => [field.name, field.question, field.other, field.options.map(option => `${option.label}${option.checked ? '*' : ''}`), field.value]))
      .toEqual([['colour', 'Colour & tone', false, ['Red', 'Green*'], ''], ['notes', 'notes', false, [], 'hello']])
  })

  it('refuses what it cannot show faithfully: no named control, controls in a table, duplicate names, oversized html', () => {
    expect(parseAskForm('<form><p>nothing</p></form>')).toBeNull()
    expect(parseAskForm('<form><table><tr><td><input name="a"></td></tr></table></form>')).toBeNull()
    expect(parseAskForm('<form><input name="a"><input type="checkbox" name="a" value="x"></form>')).toBeNull()
    expect(parseAskForm(`<form><input name="a" value="${'x'.repeat(70_000)}"></form>`)).toBeNull()
  })
})
