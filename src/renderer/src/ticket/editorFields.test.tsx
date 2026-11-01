// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { draftPlan } from '../epic/__mocks__/fixtures'
import { CapabilityFields, CriteriaFields, DetailFields } from './editorFields'
import { formFromBundle, type TicketForm } from './ticketForm'

afterEach(cleanup)

const { bundle } = draftPlan()

function loadedForm(): TicketForm {
  const form = formFromBundle(bundle, 'tk_202')
  if (form === null) throw new Error('The fixture has no DM-202.')
  return form
}

type Fields = (props: { form: TicketForm; update(form: TicketForm): void }) => JSX.Element

/** Renders `Fields` over a form the edits keep updating; answers the form as it stands after each edit. */
function edit(Fields: Fields, start: TicketForm = loadedForm()): () => TicketForm {
  let latest = start
  function Host(): JSX.Element {
    const [form, setForm] = useState(start)
    const update = (next: TicketForm): void => {
      latest = next
      setForm(next)
    }
    return <Fields form={form} update={update} />
  }
  render(<Host />)
  return () => latest
}

const change = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

describe('editorFields: details', () => {
  it('edits the tags and marks the ticket optional', () => {
    const form = edit((props) => <DetailFields {...props} bundle={bundle} />)

    change('Tags', 'import, storage')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Optional (does not gate the sprint)' }))

    expect([form().tags, form().optional]).toEqual(['import, storage', !loadedForm().optional])
  })
})

describe('editorFields: criteria', () => {
  it('moves a criterion down below the next one', () => {
    const criteria = [
      { key: 'new-1', id: null, text: 'First' },
      { key: 'new-2', id: null, text: 'Second' }
    ]
    const form = edit((props) => <CriteriaFields {...props} />, { ...loadedForm(), criteria, nextKey: 3 })

    fireEvent.click(screen.getByRole('button', { name: 'Move criterion 1 down' }))

    expect(form().criteria.map((criterion) => criterion.text)).toEqual(['Second', 'First'])
  })
})

describe('editorFields: capability profile', () => {
  it('edits the reasoning level, its rationale and the token estimate', () => {
    const form = edit((props) => <CapabilityFields {...props} />)

    change('Reasoning', 'deep')
    change('Reasoning rationale', 'Touches the import transaction.')
    change('Estimated input tokens', '42000')

    expect([form().reasoningLevel, form().rationale, form().tokens]).toEqual(['deep', 'Touches the import transaction.', '42000'])
  })
})
