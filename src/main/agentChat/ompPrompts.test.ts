import { describe, expect, it } from 'vitest'
import { ompAnswerPrompt, ompHoldPrompt, type OmpHeldPrompt } from './ompPrompts'

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

describe('ompAnswerPrompt form fields one at a time', () => {
  it('converts a numeric field, refuses a value that is not a number, and keeps the held prompt unchanged', () => {
    const held = form([{ kind: 'text', name: 'count', type: 'number', label: 'Count' }, { kind: 'text', name: 'note' }])
    expect(ompAnswerPrompt(held, 'text', 'many')).toBeNull()
    const next = ompAnswerPrompt(held, 'text', '42')?.next
    expect([next?.prompt.id, next?.prompt.title]).toEqual(['f1:1', 'note'])
    expect(next && ompAnswerPrompt(next, 'text', 'hi')).toEqual(response({ data: { count: 42, note: 'hi' } }))
    expect(held.data).toEqual({})
  })

  it('takes a multi choice as an offered option, a JSON list of offered values, or free text as one value', () => {
    const held = form([{ kind: 'choice', name: 'tags', multi: true, options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }, { label: 'Off', value: 'off', disabled: true }] }])
    expect(held.prompt.options.map((option) => option.id)).toEqual(['option_0', 'option_1', 'text'])
    expect(ompAnswerPrompt(held, 'option_1')).toEqual(response({ data: { tags: ['b'] } }))
    expect(ompAnswerPrompt(held, 'text', '["a","b"]')).toEqual(response({ data: { tags: ['a', 'b'] } }))
    expect(ompAnswerPrompt(held, 'text', 'custom')).toEqual(response({ data: { tags: ['custom'] } }))
    expect([ompAnswerPrompt(held, 'text', '["off"]'), ompAnswerPrompt(held, 'text', '[oops')]).toEqual([null, null])
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
    expect(held.answers).toEqual([])
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
    expect(held.data).toEqual({})
  })
})
