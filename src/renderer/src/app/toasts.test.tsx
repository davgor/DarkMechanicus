// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { ToastProvider, useToasts } from './toasts'

afterEach(cleanup)

function Trigger(): JSX.Element {
  const toasts = useToasts()
  return (
    <div>
      <button type="button" onClick={() => toasts.push('success', 'Saved it')}>
        good
      </button>
      <button type="button" onClick={() => toasts.push('info', 'FYI')}>
        note
      </button>
      <button type="button" onClick={() => toasts.reportError(new Error('Nope'))}>
        fail
      </button>
      <button type="button" onClick={() => toasts.reportError('plain text')}>
        text
      </button>
    </div>
  )
}

function renderToasts(): ManualScheduler {
  const scheduler = new ManualScheduler()
  render(
    <ToastProvider scheduler={scheduler}>
      <Trigger />
    </ToastProvider>
  )
  return scheduler
}

const press = (name: string): void => {
  fireEvent.click(screen.getByRole('button', { name }))
}

describe('ToastProvider messages', () => {
  it('announces command errors as alerts using the error message', () => {
    renderToasts()
    press('fail')
    expect(screen.getByRole('alert').textContent).toContain('Nope')
  })

  it('stringifies values that are not errors', () => {
    renderToasts()
    press('text')
    expect(screen.getByRole('alert').textContent).toContain('plain text')
  })

  it('announces other toasts politely', () => {
    renderToasts()
    press('good')
    expect(screen.getByRole('status').textContent).toContain('Saved it')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('labels the tone in text, not only color', () => {
    renderToasts()
    press('fail')
    press('good')
    expect(screen.getByRole('alert').textContent).toContain('Error')
    expect(screen.getByRole('status').textContent).toContain('Success')
  })

  it('shows a repeated message once', () => {
    renderToasts()
    press('fail')
    press('fail')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })
})

describe('ToastProvider dismissal', () => {
  it('removes a toast with its dismiss button', () => {
    renderToasts()
    press('good')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it.each([
    ['fail', 10_000],
    ['good', 4_000],
    ['note', 5_000]
  ])('schedules %s toasts to disappear after %i ms', (name, ms) => {
    const scheduler = renderToasts()
    press(name)
    expect(scheduler.timeouts()).toEqual([ms])
  })

  it('removes a toast when its timer fires', () => {
    const scheduler = renderToasts()
    press('good')
    act(() => scheduler.fireTimeouts())
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('schedules each toast only once across re-renders', () => {
    const scheduler = renderToasts()
    press('good')
    press('fail')
    expect(scheduler.timeouts()).toEqual([4_000, 10_000])
  })
})

describe('useToasts', () => {
  it('requires a provider', () => {
    const original = console.error
    const quiet = (event: Event): void => event.preventDefault()
    console.error = () => undefined
    window.addEventListener('error', quiet)
    try {
      expect(() => render(<Trigger />)).toThrow('ToastProvider')
    } finally {
      window.removeEventListener('error', quiet)
      console.error = original
    }
  })
})
