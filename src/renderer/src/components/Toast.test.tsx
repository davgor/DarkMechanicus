// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Toast } from '../app/toastState'
import { ToastViewport } from './Toast'

afterEach(cleanup)

const toasts: Toast[] = [
  { id: 1, tone: 'error', message: 'Disk full' },
  { id: 2, tone: 'success', message: 'Saved' },
  { id: 3, tone: 'info', message: 'Heads up' }
]

function renderViewport(list: readonly Toast[] = toasts): number[] {
  const dismissed: number[] = []
  render(<ToastViewport toasts={list} onDismiss={(id) => dismissed.push(id)} />)
  return dismissed
}

describe('ToastViewport', () => {
  it('announces errors as alerts and the rest as polite status messages', () => {
    renderViewport()
    expect(screen.getAllByRole('alert').map((el) => el.textContent)).toEqual(['Error: Disk full'])
    expect(screen.getAllByRole('status').map((el) => el.textContent)).toEqual(['Success: Saved', 'Notice: Heads up'])
  })

  it('classes each toast by tone', () => {
    renderViewport()
    expect(document.querySelectorAll('.toast-error, .toast-success, .toast-info')).toHaveLength(3)
    expect(screen.getByRole('alert').className).toBe('toast toast-error')
  })

  it('uses a warning icon for errors and a check for the others', () => {
    renderViewport()
    expect(screen.getByRole('alert').querySelector('[data-icon="warning"]')).not.toBeNull()
    for (const status of screen.getAllByRole('status')) {
      expect(status.querySelector('[data-icon="check"]')).not.toBeNull()
    }
  })

  it('dismisses the toast whose button was pressed', () => {
    const dismissed = renderViewport()
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss notification' })[1] as HTMLElement)
    expect(dismissed).toEqual([2])
  })

  it('renders nothing but the container when there are no toasts', () => {
    renderViewport([])
    expect(document.querySelector('.toast-viewport')?.children).toHaveLength(0)
  })
})
