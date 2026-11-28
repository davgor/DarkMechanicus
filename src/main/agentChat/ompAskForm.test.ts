import { describe, expect, it } from 'vitest'
import { askDesired, askDriveStep, askFrameMatches, askPromptForm, askSummary, checkboxField, parseAskForm, type AskField, type OmpAskDrive } from './ompAskForm'

const identity = (text: string): string => text
/** Each parsed field as [name, question, kind, options as `label=value` with `*` for a default]. */
const shape = (html: string) => parseAskForm(html)?.map(field => [field.name, field.question, field.kind,
  field.options.map(option => `${option.label}=${option.value}${option.checked ? '*' : ''}`)])
const form = (body: string): string => `<form>${body}</form>`
/** A one-option select named `name`, which (unlike a text input) takes the text before it as its question. */
const select = (name: string): string => `<select name="${name}"><option>X</option></select>`

describe('parseAskForm: what it refuses', () => {
  it('refuses a non-string, an oversized form, a form with no named field and one whose names repeat', () => {
    expect(parseAskForm(42 as unknown as string)).toBeNull()
    expect(parseAskForm(form(`<input name="a"><p>${'x'.repeat(64 * 1024)}</p>`))).toBeNull()
    expect(parseAskForm(form('<input><textarea></textarea>'))).toBeNull()
    expect(parseAskForm(form('<input type="radio" name="a" value="1"><input name="a">'))).toBeNull()
    expect(parseAskForm(form('<input type="radio" name="a" value="1"><input type="checkbox" name="a" value="2">'))).toBeNull()
  })

  it('refuses a choice group whose every option is disabled, and controls inside a table or pre block', () => {
    expect(parseAskForm(form('<input type="radio" name="a" value="1" disabled><input type="radio" name="a" value="2" disabled>'))).toBeNull()
    expect(parseAskForm(form('<select name="s"><option disabled>Only</option></select>'))).toBeNull()
    expect(parseAskForm(form('<table><tr><td><input name="a"></td></tr></table>'))).toBeNull()
    expect(parseAskForm(form('<pre><input name="a"></pre>'))).toBeNull()
  })

  it('keeps a form whose table holds no control, and reads a body with no <form> tag', () => {
    expect(shape(form('<table><tr><td>Info</td></tr></table><input name="a" aria-label="A">'))).toEqual([['a', 'A', 'text', []]])
    expect(shape(`<p>Your database</p>${select('db')}`)).toEqual([['db', 'Your database', 'choice', ['X=X*']]])
  })
})

describe('parseAskForm: the tokenizer', () => {
  it('decodes named and numeric entities, leaving unknown or out-of-range ones as written', () => {
    expect(shape(form('<label>Fish &amp; chips &#65;&#x42; &bogus; &#0; &#x110000;<input name="a"></label>'))?.[0][1])
      .toBe('Fish & chips AB &bogus; &#0; &#x110000;')
  })

  it('skips comments, CDATA, doctypes, processing instructions, scripts, styles and buttons', () => {
    const html = '<!DOCTYPE html><?xml x?><form><!-- <input name="c"> --><![CDATA[<input name="d">]]><script><input name="s"></script>'
      + '<style>input{}</style><button><input name="b"></button><input name="a" title="Real"></form>'
    expect(shape(html)).toEqual([['a', 'Real', 'text', []]])
  })

  it('reads attributes in any quoting, upper case and first-wins, and treats a bare attribute as present', () => {
    expect(parseAskForm(form("<INPUT NAME=pick TYPE='checkbox' value=\"x\" CHECKED REQUIRED name=other aria-label='Pick'>")))
      .toEqual([expect.objectContaining({ name: 'pick', question: 'Pick', kind: 'choice', multi: true, required: true, options: [{ value: 'x', label: 'Pick', checked: true }] })])
  })

  it('keeps inline markup text in a label, drops stray close tags and imageless alt, and labels an empty option by its value', () => {
    expect(shape(form('<label><b>Bold</b> word<img src="x.png"><svg/></script> <select name="s"><option value="v"></option></select></label>')))
      .toEqual([['s', 'Bold word', 'choice', ['v=v*']]])
  })

  it('joins a line break into the text before a control, and reads text after the last tag of an unclosed form', () => {
    expect(shape(`<p>First line<br>second line</p>${select('a')}`)?.[0][1]).toBe('First line second line')
    expect(parseAskForm(`<form>${select('a')} trailing words`)).toHaveLength(1)
  })

  it('keeps a textarea body raw, decoded, without its first newline, and runs an unclosed one to the end', () => {
    expect(parseAskForm(form('<textarea name="t">\n<b>bold</b> &lt;ok&gt;</textarea>'))?.[0]).toMatchObject({ kind: 'text', multiline: true, value: '<b>bold</b> <ok>' })
    expect(parseAskForm('<form><textarea name="t">left open')?.[0].value).toBe('left open')
  })
})

describe('parseAskForm: questions and labels', () => {
  it('titles a text control by its wrapping label, a for= label, aria-label or title, else by its name, never by text before it', () => {
    const html = form('<label>Wrapped <input name="a"></label><label for="b-id">By for</label><input id="b-id" name="b">'
      + '<input name="c" aria-label="By aria"><input name="d" title="By title"><p>Preceding text</p><input name="e"><textarea name="first_name"></textarea>')
    expect(shape(html)?.map(([name, question]) => [name, question])).toEqual([
      ['a', 'Wrapped'], ['b', 'By for'], ['c', 'By aria'], ['d', 'By title'], ['e', 'e'], ['first_name', 'first name']
    ])
  })

  it('titles an unlabelled select by the text before it, and a for= label naming no control is such text', () => {
    expect(shape(form(`<p>Preceding text</p>${select('a')}<label for="missing">Lost label</label>${select('b')}${select('c')}`))?.map(([name, question]) => [name, question]))
      .toEqual([['a', 'Preceding text'], ['b', 'Lost label'], ['c', 'c']])
  })

  it('leaves a select, textarea and script out of a label, keeps image alt text and line breaks as spaces', () => {
    expect(shape(form('<label>Size<br><img alt="(cm)"><script>bad()</script><select name="s"><option>Big</option></select></label>'))?.[0])
      .toEqual(['s', 'Size (cm)', 'choice', ['Big=Big*']])
  })

  it('titles fields by the top-level legend, a nested legend as a text block, and forgets them after the fieldset', () => {
    const html = form(`<fieldset><legend>Outer</legend>${select('a')}<fieldset><legend>Inner</legend>${select('b')}</fieldset></fieldset>`
      + `<fieldset>${select('c')}</fieldset>${select('d')}`)
    expect(shape(html)?.map(([name, question]) => [name, question])).toEqual([['a', 'Outer'], ['b', 'Inner'], ['c', 'c'], ['d', 'd']])
  })

  it('takes a heading or list item as the text before a control, but a list without controls ends that text', () => {
    expect(shape(form(`<h2>Heading</h2>${select('a')}<p>Kept</p><ul><li>Note</li></ul>${select('b')}`))?.map(([name, question]) => [name, question]))
      .toEqual([['a', 'Heading'], ['b', 'b']])
    expect(shape(form(`<ul><li>Item text ${select('a')}</li></ul>`))?.[0][1]).toBe('Item text')
  })

  it('titles a choice group by the text before its first control, else its only option, else its name', () => {
    expect(shape(form('<p>Pick one</p><label><input type="radio" name="r" value="1"> One</label><label><input type="radio" name="r" value="2"> Two</label>'))?.[0][1]).toBe('Pick one')
    expect(shape(form('<label><input type="checkbox" name="agree"> I agree</label>'))?.[0]).toEqual(['agree', 'I agree', 'choice', ['I agree=on']])
    expect(shape(form('<input type="radio" name="r" value="1"><input type="radio" name="r" value="2">'))?.[0]).toEqual(['r', 'r', 'choice', ['1=1', '2=2']])
  })
})

describe('parseAskForm: controls', () => {
  it('ignores hidden, submit, button, reset, file and image inputs and reads the rest as text with their value as default', () => {
    const html = form('<input type="hidden" name="h"><input type="submit" name="s"><input type="file" name="f"><input type="image" name="i">'
      + '<input type="reset" name="r"><input type="button" name="b"><input type="email" name="mail" value="a@b.c"><input type="number" name="n">')
    expect(parseAskForm(html)?.map(field => [field.name, field.kind, field.value, field.multiline])).toEqual([['mail', 'text', 'a@b.c', false], ['n', 'text', '', false]])
  })

  it('defaults a single select to its first enabled option, keeps a selected one, and gives a multiple select no default', () => {
    expect(shape(form('<select name="s"><option disabled>Off</option><option>A</option><option value="b">B</option></select>'))?.[0][3]).toEqual(['A=A*', 'B=b'])
    expect(shape(form('<select name="s"><option>A</option><option selected>B</option></select>'))?.[0][3]).toEqual(['A=A', 'B=B*'])
    expect(parseAskForm(form('<select name="s" multiple><option>A</option><option>B</option></select>'))?.[0]).toMatchObject({ multi: true, options: [{ checked: false }, { checked: false }] })
  })

  it('labels a radio by its value, then its name, when it has no label, and drops disabled ones', () => {
    expect(shape(form('<input type="radio" name="r" value="yes"><input type="radio" name="r"><input type="radio" name="r" value="no" disabled>'))?.[0][3])
      .toEqual(['yes=yes', 'r=on'])
  })

  it('marks a group required when any of its controls is, and offers Other only for two or more options none called Other', () => {
    const fields = parseAskForm(form('<input type="checkbox" name="a" value="1"><input type="checkbox" name="a" value="2" required>'
      + '<input type="radio" name="b" value="x"><input type="radio" name="b" value="Other">'
      + '<input type="radio" name="c" value="only">'))
    expect(fields?.map(field => [field.name, field.required, field.other])).toEqual([['a', true, true], ['b', false, false], ['c', false, false]])
  })

  it('makes repeated option labels unique as OMP does', () => {
    expect(shape(form('<select name="s"><option value="1">Same</option><option value="2">Same</option><option value="3">Same</option></select>'))?.[0][3])
      .toEqual(['Same=1*', 'Same (2)=2', 'Same (3)=3'])
  })
})

const choice = (name: string, labels: string[], patch: Partial<AskField> = {}): AskField => ({
  name, question: `${name}?`, kind: 'choice', multi: false, other: false, required: false, value: '', multiline: false,
  options: labels.map(label => ({ value: label.toLowerCase(), label, checked: false })), ...patch
})
const text = (name: string, patch: Partial<AskField> = {}): AskField => ({
  name, question: `${name}?`, kind: 'text', multi: false, other: false, required: false, options: [], value: '', multiline: false, ...patch
})

describe('askPromptForm', () => {
  it('requires every radio group, keeps a checkbox group or text field as the HTML says, and carries text defaults', () => {
    const fields = [choice('r', ['A', 'B']), choice('c', ['A'], { multi: true }), text('t', { value: 'Hi', required: true }), text('u')]
    expect(askPromptForm(fields, identity).fields.map(field => [field.id, field.required, field.text, field.defaultText])).toEqual([
      ['r', true, 'none', undefined], ['c', false, 'none', undefined], ['t', true, 'only', 'Hi'], ['u', false, 'only', undefined]
    ])
  })
})

describe('askDesired and askSummary', () => {
  const fields = [choice('r', ['A', 'B'], { other: true }), choice('c', ['X', 'Y', 'Z'], { multi: true, required: true }), text('t', { value: 'default' })]
  const valid = [{ fieldId: 'r', optionIds: ['option_1'] }, { fieldId: 'c', optionIds: ['option_2', 'option_0'] }, { fieldId: 't', optionIds: [] }]

  it('takes a complete answer, options in option order, a text field keeping its default when text is omitted', () => {
    const desired = askDesired(fields, valid, identity)
    expect(desired).toEqual([{ chosen: [1] }, { chosen: [0, 2] }, { chosen: [], text: 'default' }])
    expect(askSummary(fields, desired!)).toBe('r?: B\nc?: X, Z\nt?: default')
  })

  it('refuses a missing or repeated field, an unknown or repeated option, and Other text where the field takes none', () => {
    expect(askDesired(fields, valid.slice(0, 2), identity)).toBeNull()
    expect(askDesired(fields, [valid[0], valid[0], valid[2]], identity)).toBeNull()
    for (const ids of [['option_9'], ['option_x'], ['bogus'], ['option_0', 'option_0']]) {
      expect(askDesired(fields, [valid[0], { fieldId: 'c', optionIds: ids }, valid[2]], identity)).toBeNull()
    }
    expect(askDesired(fields, [valid[0], { fieldId: 'c', optionIds: ['option_0'], text: 'extra' }, valid[2]], identity)).toBeNull()
  })

  it('refuses a single choice without exactly one pick, an empty required group, options on a text field and a blank required text', () => {
    expect(askDesired(fields, [{ fieldId: 'r', optionIds: [] }, valid[1], valid[2]], identity)).toBeNull()
    expect(askDesired(fields, [{ fieldId: 'r', optionIds: ['option_0'], text: 'mine' }, valid[1], valid[2]], identity)).toBeNull()
    expect(askDesired(fields, [valid[0], { fieldId: 'c', optionIds: [] }, valid[2]], identity)).toBeNull()
    expect(askDesired(fields, [valid[0], valid[1], { fieldId: 't', optionIds: ['option_0'] }], identity)).toBeNull()
    const required = [choice('r', ['A']), text('t', { required: true })]
    expect(askDesired(required, [{ fieldId: 'r', optionIds: ['option_0'] }, { fieldId: 't', optionIds: [], text: '   ' }], identity)).toBeNull()
  })

  it('takes Other text as the one pick of a radio, ignores whitespace-only Other text, and summarizes Other and an empty text', () => {
    const answers = [{ fieldId: 'r', optionIds: [], text: 'Mars' }, { fieldId: 'c', optionIds: ['option_1'], text: '  ' }, { fieldId: 't', optionIds: [], text: '' }]
    const desired = askDesired(fields, answers, identity)
    expect(desired).toEqual([{ chosen: [], text: 'Mars' }, { chosen: [1] }, { chosen: [], text: '' }])
    expect(askSummary(fields, desired!)).toBe('r?: Other: Mars\nc?: Y\nt?: ')
  })

  it('refuses answers that name a field the form does not hold, even when their count is right', () => {
    expect(askDesired([text('a'), text('b')], [{ fieldId: 'a', optionIds: [] }, { fieldId: 'z', optionIds: [] }], identity)).toBeNull()
  })

  it('matches answers by the field id the prompt showed, masked as main masks it', () => {
    expect(askDesired([text('secret_name')], [{ fieldId: 'MASKED', optionIds: [], text: 'x' }], () => 'MASKED')).toEqual([{ chosen: [], text: 'x' }])
  })
})

const request = (patch: Record<string, unknown>): Record<string, unknown> => ({ type: 'extension_ui_request', id: 'req', method: 'select', ...patch })
const drive = (fields: AskField[], desired: OmpAskDrive['desired']): OmpAskDrive =>
  ({ toolCallId: 'call', fields, wireId: 'req', request: null, desired, position: 0, rounds: 0, awaitingOther: false })
const radio = (title: string, options: string[]) => request({ title, options, selectionMarker: 'radio' })
const checkbox = (title: string, options: string[], checkedIndices: number[], markableCount = options.length - 1) =>
  request({ title, options, selectionMarker: 'checkbox', checkedIndices, markableCount })
/** A drive step's response value, or why it stopped. */
const value = (step: { frame: Record<string, unknown> } | { diverged: string }): unknown => 'frame' in step ? step.frame.value : step.diverged

describe('askFrameMatches', () => {
  it('matches a request by its last title line without the selected count, and by the method OMP uses for the field', () => {
    const field = choice('c', ['A', 'B'], { multi: true, question: 'Pick  some' })
    expect(askFrameMatches(field, checkbox('Context line\n(2 selected) Pick some', ['A', 'B', '✔ Done selecting'], [0, 1], 2), false)).toBe(true)
    expect(askFrameMatches(field, checkbox('Something else', ['A', 'B', '✔ Done selecting'], [], 2), false)).toBe(false)
    expect(askFrameMatches(text('t', { question: 'Q' }), request({ method: 'input', title: 'Q' }), false)).toBe(true)
    expect(askFrameMatches(text('t', { question: 'Q', value: 'prefilled' }), request({ method: 'input', title: 'Q' }), false)).toBe(false)
    expect(askFrameMatches(text('t', { question: 'Q', multiline: true }), request({ method: 'editor', title: 'Q' }), false)).toBe(true)
    expect(askFrameMatches(choice('r', ['A'], { question: 'Q' }), request({ method: 'input', title: 'Q' }), true)).toBe(true)
    expect(askFrameMatches(choice('r', ['A'], { question: 'Q' }), radio('Q', ['A']), true)).toBe(false)
  })

  it('refuses choices that differ from the field: other labels, a missing Other, wrong markers, counts or trailing actions', () => {
    const single = choice('r', ['A', 'B'], { question: 'Q', other: true })
    expect(askFrameMatches(single, radio('Q', ['A', 'B', 'Other (type your own)']), false)).toBe(true)
    expect(askFrameMatches(single, radio('Q', ['A', 'B']), false)).toBe(false)
    expect(askFrameMatches(single, radio('Q', ['A', 'C', 'Other (type your own)']), false)).toBe(false)
    expect(askFrameMatches(single, checkbox('Q', ['A', 'B', 'Other (type your own)'], []), false)).toBe(false)
    expect(askFrameMatches(single, request({ title: 'Q', options: 'A,B', selectionMarker: 'radio' }), false)).toBe(false)
    const multi = choice('c', ['A', 'B'], { question: 'Q', multi: true })
    expect(askFrameMatches(multi, checkbox('Q', ['A', 'B', '✔ Done selecting'], [], 3), false)).toBe(false)
    expect(askFrameMatches(multi, checkbox('Q', ['A', 'B', 'Cancel'], [], 2), false)).toBe(false)
    expect(askFrameMatches(multi, checkbox('Q', ['A', 'B', '✔ Done selecting', 'Cancel'], [], 2), false)).toBe(false)
    expect(askFrameMatches(multi, radio('Q', ['A', 'B']), false)).toBe(false)
  })
})

describe('askDriveStep', () => {
  it('answers a radio with its pick, and with Other then its text when the answer is Other', () => {
    const field = choice('r', ['A', 'B'], { question: 'Q', other: true })
    const picked = drive([field], [{ chosen: [1] }])
    expect(askDriveStep(picked, radio('Q', ['A', 'B', 'Other (type your own)']))).toEqual({ frame: { type: 'extension_ui_response', id: 'req', value: 'B' }, done: true })
    const other = drive([field], [{ chosen: [], text: 'Mars' }])
    const first = askDriveStep(other, radio('Q', ['A', 'B', 'Other (type your own)']))
    expect([value(first), 'frame' in first && first.done, other.awaitingOther]).toEqual(['Other (type your own)', false, true])
    const second = askDriveStep(other, request({ method: 'input', title: 'Q' }))
    expect([value(second), 'frame' in second && second.done]).toEqual(['Mars', true])
  })

  it('toggles a checkbox loop against OMP\'s own checked state, adds Other with its text, and ends with Done', () => {
    const field = choice('c', ['A', 'B'], { question: 'Q', multi: true, other: true })
    const loop = drive([field, text('t', { question: 'T' })], [{ chosen: [1], text: 'Extra' }, { chosen: [], text: 'typed' }])
    const options = ['A', 'B', 'Other (type your own)', '✔ Done selecting']
    expect(value(askDriveStep(loop, checkbox('Q', options, [0], 3)))).toBe('A')
    expect(value(askDriveStep(loop, checkbox('(0 selected) Q', options, [], 3)))).toBe('B')
    expect(value(askDriveStep(loop, checkbox('(1 selected) Q', options, [1], 3)))).toBe('Other (type your own)')
    expect(loop.awaitingOther).toBe(true)
    expect(value(askDriveStep(loop, request({ method: 'input', title: 'Q' })))).toBe('Extra')
    expect([loop.position, loop.awaitingOther]).toEqual([0, false])
    expect(value(askDriveStep(loop, checkbox('(2 selected) Q', options, [1, 2], 3)))).toBe('✔ Done selecting')
    expect([loop.position, loop.rounds]).toEqual([1, 0])
    expect(askDriveStep(loop, request({ method: 'input', title: 'T' }))).toEqual({ frame: { type: 'extension_ui_response', id: 'req', value: 'typed' }, done: true })
  })

  it('reads a request with no title as asking nothing, and a checkbox request without checkedIndices as nothing checked', () => {
    expect(askFrameMatches(text('t', { question: '' }), request({ method: 'input' }), false)).toBe(true)
    const loop = drive([choice('c', ['A'], { question: 'Q', multi: true })], [{ chosen: [0] }])
    expect(value(askDriveStep(loop, request({ title: 'Q', options: ['A', '✔ Done selecting'], selectionMarker: 'checkbox', markableCount: 1 })))).toBe('A')
  })

  it('stops on a request beyond the form, one that matches no field, a loop that never settles and one with no Done', () => {
    expect(askDriveStep(drive([], []), radio('Q', ['A']))).toEqual({ diverged: 'The agent asked more than its form held.' })
    expect(askDriveStep(drive([choice('r', ['A'], { question: 'Q' })], null), radio('Q', ['A']))).toEqual({ diverged: 'The agent asked more than its form held.' })
    expect(value(askDriveStep(drive([choice('r', ['A'], { question: 'Q' })], [{ chosen: [0] }]), radio('Other', ['A']))))
      .toBe('The agent\'s request did not match the form\'s question "Q".')
    const stuck = drive([choice('c', ['A'], { question: 'Q', multi: true })], [{ chosen: [0] }])
    const unchanged = checkbox('Q', ['A', '✔ Done selecting'], [], 1)
    expect([value(askDriveStep(stuck, unchanged)), value(askDriveStep(stuck, unchanged))]).toEqual(['A', 'A'])
    expect(value(askDriveStep(stuck, unchanged))).toBe('The checkbox question "Q" did not settle.')
    const required = drive([choice('c', ['A'], { question: 'Q', multi: true })], [{ chosen: [0] }])
    expect(value(askDriveStep(required, checkbox('Q', ['A'], [0], 1)))).toBe('The checkbox question "Q" offered no Done.')
  })
})

describe('checkboxField', () => {
  it('reads a lone checkbox select as an optional multi field with its checked options, Other and a missing Done', () => {
    expect(checkboxField(checkbox('Ctx\n(1 selected) Pick', ['A', 'B', 'Other (type your own)', '✔ Done selecting'], [1], 3))).toEqual({
      name: 'field_0', question: 'Pick', kind: 'choice', multi: true, other: true, required: false, value: '', multiline: false,
      options: [{ value: 'A', label: 'A', checked: false }, { value: 'B', label: 'B', checked: true }]
    })
    expect(checkboxField(request({ title: 'Pick', options: ['A', 'B'], selectionMarker: 'checkbox' }))).toMatchObject({ required: true, other: false, options: [{ label: 'A' }, { label: 'B' }] })
  })

  it('refuses anything else: another method or marker, bad markable counts, extra or non-Done actions, a checked Other', () => {
    const options = ['A', 'B', '✔ Done selecting']
    for (const frame of [
      request({ method: 'input', title: 'Q', options, selectionMarker: 'checkbox', markableCount: 2 }),
      radio('Q', options),
      checkbox('Q', ['A', 'B'], [], 0),
      checkbox('Q', ['A', 'B'], [], 3),
      checkbox('Q', ['A', 'B'], [], 1.5),
      checkbox('Q', ['A', 'Cancel', '✔ Done selecting'], [], 1),
      checkbox('Q', ['A', 'Cancel'], [], 1),
      checkbox('Q', ['Other (type your own)', '✔ Done selecting'], [], 1),
      checkbox('Q', ['A', 'Other (type your own)', '✔ Done selecting'], [1], 2),
      request({ title: 'Q', options: [1, 2], selectionMarker: 'checkbox' })
    ]) expect(checkboxField(frame)).toBeNull()
  })
})
