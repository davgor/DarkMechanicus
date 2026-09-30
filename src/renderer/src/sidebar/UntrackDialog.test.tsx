// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { folderView } from '../__mocks__/fixtures'
import { UntrackDialog } from './UntrackDialog'

afterEach(cleanup)

function renderDialog(): string[] {
  const events: string[] = []
  render(
    <UntrackDialog
      folder={folderView({ name: 'alpha', displayPath: '~/code/alpha' })}
      onConfirm={() => events.push('confirm')}
      onCancel={() => events.push('cancel')}
    />
  )
  return events
}

describe('UntrackDialog', () => {
  it('names the folder and explains that repository data is untouched', () => {
    renderDialog()
    const dialog = screen.getByRole('dialog', { name: 'Stop tracking alpha?' })
    expect(dialog.textContent).toContain('only removes the folder from this sidebar')
    expect(dialog.textContent).toContain('.darkmechanicus/ records')
    expect(dialog.textContent).toContain('~/code/alpha')
  })

  it('confirms with the stop button', () => {
    const events = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Stop tracking' }))
    expect(events).toEqual(['confirm'])
  })

  it('cancels with the cancel button', () => {
    const events = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(events).toEqual(['cancel'])
  })

  it('cancels with Escape', () => {
    const events = renderDialog()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' })
    expect(events).toEqual(['cancel'])
  })

  it('starts on the safe choice', () => {
    renderDialog()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
  })
})
