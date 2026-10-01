// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Dialog, wrapTarget } from './Dialog'

afterEach(cleanup)

function Harness(props: { closed: string[] }): JSX.Element {
  return (
    <Dialog
      title="Create thing"
      description="Explains the thing."
      onClose={() => props.closed.push('closed')}
      actions={<button type="button">Confirm</button>}
    >
      <input aria-label="Name" />
    </Dialog>
  )
}

describe('wrapTarget', () => {
  it('wraps forward from the last item to the first', () => {
    expect(wrapTarget(['a', 'b', 'c'], 'c', false)).toBe('a')
  })

  it('wraps backward from the first item to the last', () => {
    expect(wrapTarget(['a', 'b', 'c'], 'a', true)).toBe('c')
  })

  it('leaves movement inside the list to the browser', () => {
    expect(wrapTarget(['a', 'b', 'c'], 'b', false)).toBeNull()
    expect(wrapTarget(['a', 'b', 'c'], 'b', true)).toBeNull()
    expect(wrapTarget(['a', 'b', 'c'], 'a', false)).toBeNull()
    expect(wrapTarget(['a', 'b', 'c'], 'c', true)).toBeNull()
  })

  it('has nowhere to wrap to with no items', () => {
    expect(wrapTarget([], 'a', false)).toBeNull()
  })

  it('wraps a single item onto itself', () => {
    expect(wrapTarget(['only'], 'only', false)).toBe('only')
    expect(wrapTarget(['only'], 'only', true)).toBe('only')
  })
})

describe('Dialog semantics', () => {
  it('is a modal dialog named by its title and described by its description', () => {
    render(<Harness closed={[]} />)
    const dialog = screen.getByRole('dialog', { name: 'Create thing' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const describedBy = dialog.getAttribute('aria-describedby') ?? ''
    expect(document.getElementById(describedBy)?.textContent).toBe('Explains the thing.')
  })

  it('omits the description link when there is no description', () => {
    render(
      <Dialog title="Bare" onClose={() => undefined}>
        body
      </Dialog>
    )
    expect(screen.getByRole('dialog').getAttribute('aria-describedby')).toBeNull()
    expect(document.querySelector('.dialog-actions')).toBeNull()
  })

  it('renders its body and actions', () => {
    render(<Harness closed={[]} />)
    expect(screen.getByLabelText('Name')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy()
  })
})

describe('Dialog dismissal', () => {
  it('closes on Escape', () => {
    const closed: string[] = []
    render(<Harness closed={closed} />)
    fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Escape' })
    expect(closed).toEqual(['closed'])
  })

  it('ignores other keys', () => {
    const closed: string[] = []
    render(<Harness closed={closed} />)
    fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'a' })
    expect(closed).toEqual([])
  })

  it('closes when the backdrop is pressed but not the panel', () => {
    const closed: string[] = []
    render(<Harness closed={closed} />)
    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(closed).toEqual([])
    fireEvent.mouseDown(document.querySelector('.dialog-backdrop') as Element)
    expect(closed).toEqual(['closed'])
  })
})

describe('Dialog focus', () => {
  it('moves focus to the first control and restores it afterwards', () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    const { unmount } = render(<Harness closed={[]} />)
    expect(document.activeElement).toBe(screen.getByLabelText('Name'))
    unmount()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('keeps Tab inside the dialog', () => {
    render(<Harness closed={[]} />)
    const confirm = screen.getByRole('button', { name: 'Confirm' })
    confirm.focus()
    const notPrevented = fireEvent.keyDown(confirm, { key: 'Tab' })
    expect(notPrevented).toBe(false)
    expect(document.activeElement).toBe(screen.getByLabelText('Name'))
  })

  it('keeps Shift+Tab inside the dialog', () => {
    render(<Harness closed={[]} />)
    const name = screen.getByLabelText('Name')
    name.focus()
    fireEvent.keyDown(name, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Confirm' }))
  })

  it('lets Tab move normally between inner controls', () => {
    render(<Harness closed={[]} />)
    const name = screen.getByLabelText('Name')
    name.focus()
    expect(fireEvent.keyDown(name, { key: 'Tab' })).toBe(true)
  })
})
