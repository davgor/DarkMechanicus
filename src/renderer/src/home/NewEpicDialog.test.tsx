// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { deferred } from '../__mocks__/deferred'
import { settle } from '../__mocks__/settle'
import type { CreateEpicInput } from '../../../shared/domain/api'
import { NewEpicDialog } from './NewEpicDialog'

afterEach(cleanup)

interface Calls {
  submitted: CreateEpicInput[]
  closed: number
}

function renderDialog(outcome: () => Promise<boolean> = () => Promise.resolve(true)): Calls {
  const calls: Calls = { submitted: [], closed: 0 }
  render(
    <NewEpicDialog
      onSubmit={(input) => {
        calls.submitted.push(input)
        return outcome()
      }}
      onClose={() => {
        calls.closed += 1
      }}
    />
  )
  return calls
}

const field = (label: string): HTMLInputElement => screen.getByLabelText(label) as HTMLInputElement
const type = (label: string, value: string): void => {
  fireEvent.change(field(label), { target: { value } })
}
const create = (): HTMLButtonElement => screen.getByRole('button', { name: /^(Create epic|Creating…)$/ }) as HTMLButtonElement

describe('NewEpicDialog form', () => {
  it('is a labelled dialog that starts on the title', () => {
    renderDialog()
    expect(screen.getByRole('dialog', { name: 'New epic' })).toBeTruthy()
    expect(document.activeElement).toBe(field('Title'))
  })

  it('explains the fields', () => {
    renderDialog()
    expect(screen.getByText('One per line. Agents check finished work against these.')).toBeTruthy()
    expect(field('Intent').tagName).toBe('TEXTAREA')
    expect(field('Success criteria').tagName).toBe('TEXTAREA')
  })

  it('requires a title and does not submit without one', () => {
    const calls = renderDialog()
    type('Title', '   ')
    fireEvent.click(create())
    expect(screen.getByRole('alert').textContent).toBe('Give the epic a title.')
    expect(calls.submitted).toEqual([])
  })

  it('clears the message once the person edits again', () => {
    renderDialog()
    fireEvent.click(create())
    expect(screen.getByRole('alert')).toBeTruthy()
    type('Title', 'Ship')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('NewEpicDialog submitting', () => {
  it('submits the title, intent and one criterion per line, then closes', async () => {
    const calls = renderDialog()
    type('Title', 'Ship it')
    type('Intent', 'Because')
    type('Success criteria', '- first\nsecond')
    fireEvent.click(create())
    await settle()
    expect(calls.submitted).toEqual([{ title: 'Ship it', intent: 'Because', successCriteria: ['first', 'second'] }])
    expect(calls.closed).toBe(1)
  })

  it('submits from the form (Enter in a field)', async () => {
    const calls = renderDialog()
    type('Title', 'Ship it')
    fireEvent.submit(screen.getByRole('dialog').querySelector('form') as HTMLFormElement)
    await settle()
    expect(calls.submitted).toEqual([{ title: 'Ship it' }])
  })

  it('stays open and can be retried when creation fails', async () => {
    const calls = renderDialog(() => Promise.resolve(false))
    type('Title', 'Ship it')
    fireEvent.click(create())
    await settle()
    expect(calls.closed).toBe(0)
    expect(create().disabled).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows progress and blocks a second submit while creating', async () => {
    const gate = deferred()
    const calls = renderDialog(() => gate.promise.then(() => true))
    type('Title', 'Ship it')
    fireEvent.click(create())
    await settle()
    expect(create().textContent).toBe('Creating…')
    expect(create().disabled).toBe(true)
    gate.resolve()
    await settle()
    expect(calls.closed).toBe(1)
  })
})

describe('NewEpicDialog dismissal', () => {
  it('closes with Cancel', () => {
    const calls = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(calls.closed).toBe(1)
  })

  it('closes with Escape', () => {
    const calls = renderDialog()
    fireEvent.keyDown(field('Title'), { key: 'Escape' })
    expect(calls.closed).toBe(1)
  })
})
