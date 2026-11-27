// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DraftOp } from '../../../shared/domain/api'
import type { SprintDelivery } from '../../../shared/domain/bundle'
import type { Result } from '../epic/workspaceActions'
import { DeliveryFields } from './DeliveryFields'

let calls: DraftOp[][]
let answer: Result<unknown>

beforeEach(() => {
  calls = []
  answer = { ok: true, value: null }
})

afterEach(cleanup)

function renderFields(delivery?: SprintDelivery, busy = false): HTMLElement {
  render(
    <DeliveryFields
      sprint={{ id: 'sp_2', ...(delivery === undefined ? {} : { delivery }) }}
      busy={busy}
      applyOps={async (ops) => {
        calls.push(ops)
        return answer
      }}
    />
  )
  return screen.getByRole('region', { name: 'Sprint delivery' })
}

function box(section: HTMLElement, label: string): HTMLInputElement {
  return within(section).getByLabelText(label) as HTMLInputElement
}

const DELIVER = 'Deliver this sprint after its checkpoint'
const RELEASE = 'Require a release that contains it'
const VERIFY = 'Verify the installed app runs that release'

describe('DM-840 c1: sprint delivery fields', () => {
  it('applies the declared delivery as exactly one update_sprint op', async () => {
    const section = renderFields()
    expect(box(section, VERIFY).disabled).toBe(true)
    fireEvent.click(box(section, DELIVER))
    expect(box(section, 'Target branch').value).toBe('main')
    fireEvent.click(box(section, RELEASE))
    expect(box(section, VERIFY).disabled).toBe(false)
    fireEvent.click(box(section, VERIFY))
    fireEvent.click(within(section).getByRole('button', { name: 'Apply delivery' }))
    expect((await within(section).findByRole('status')).textContent).toBe('Delivery applied to the draft.')
    expect(calls).toEqual([[{ op: 'update_sprint', sprint: 'sp_2', patch: { delivery: { target: 'main', release: true, verifyInstalled: true } } }]])
  })

  it('turning the release off unchecks and disables verifying the installed app', async () => {
    const section = renderFields({ target: 'develop', release: true, verifyInstalled: true })
    expect(box(section, VERIFY).checked).toBe(true)
    fireEvent.click(box(section, RELEASE))
    expect([box(section, VERIFY).checked, box(section, VERIFY).disabled]).toEqual([false, true])
    fireEvent.click(box(section, RELEASE))
    expect([box(section, VERIFY).checked, box(section, VERIFY).disabled]).toEqual([false, false])
    fireEvent.click(box(section, RELEASE))
    fireEvent.click(within(section).getByRole('button', { name: 'Apply delivery' }))
    await within(section).findByRole('status')
    expect(calls).toEqual([[{ op: 'update_sprint', sprint: 'sp_2', patch: { delivery: { target: 'develop', release: false, verifyInstalled: false } } }]])
  })
})

describe('DM-840 c1/c2: clearing, invalid branches and failures', () => {
  it('clearing the declaration applies delivery null', async () => {
    const section = renderFields({ target: 'main', release: true, verifyInstalled: false })
    fireEvent.click(box(section, DELIVER))
    expect(box(section, 'Target branch').disabled).toBe(true)
    fireEvent.click(within(section).getByRole('button', { name: 'Apply delivery' }))
    expect((await within(section).findByRole('status')).textContent).toBe('Delivery cleared in the draft.')
    expect(calls).toEqual([[{ op: 'update_sprint', sprint: 'sp_2', patch: { delivery: null } }]])
  })

  it('an invalid target branch shows the error and disables Apply', () => {
    const section = renderFields({ target: 'main', release: false, verifyInstalled: false })
    fireEvent.change(box(section, 'Target branch'), { target: { value: 'a..b' } })
    expect(within(section).getByText('“a..b” is not a valid branch name.')).toBeTruthy()
    const apply = within(section).getByRole('button', { name: 'Apply delivery' }) as HTMLButtonElement
    expect(apply.disabled).toBe(true)
    fireEvent.click(apply)
    expect(calls).toEqual([])
  })

  it('shows a rejected apply and disables everything while busy', async () => {
    answer = { ok: false, failure: { code: 'conflict', message: 'The draft changed.' } }
    const section = renderFields()
    fireEvent.click(within(section).getByRole('button', { name: 'Apply delivery' }))
    expect((await within(section).findByRole('alert')).textContent).toBe('The draft changed.')
    cleanup()
    const busy = renderFields(undefined, true)
    expect([box(busy, DELIVER).disabled, (within(busy).getByRole('button', { name: 'Apply delivery' }) as HTMLButtonElement).disabled]).toEqual([true, true])
  })
})
