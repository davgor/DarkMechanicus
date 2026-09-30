// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { EmptyState } from './EmptyState'

afterEach(cleanup)

describe('EmptyState', () => {
  it('shows a heading and explanatory text', () => {
    render(<EmptyState title="Nothing here">Add something to begin.</EmptyState>)
    expect(screen.getByRole('heading', { name: 'Nothing here' })).toBeTruthy()
    expect(screen.getByText('Add something to begin.')).toBeTruthy()
  })

  it('uses a level-2 heading by default and level 1 on request', () => {
    render(<EmptyState title="Default" />)
    expect(screen.getByRole('heading', { name: 'Default' }).tagName).toBe('H2')
    cleanup()
    render(<EmptyState title="Page" headingLevel={1} />)
    expect(screen.getByRole('heading', { name: 'Page' }).tagName).toBe('H1')
  })

  it('renders an optional icon and action', () => {
    render(<EmptyState title="Empty" icon="folder" action={<button type="button">Do it</button>} />)
    expect(document.querySelector('[data-icon="folder"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Do it' })).toBeTruthy()
  })

  it('omits the icon and action when not given', () => {
    render(<EmptyState title="Empty" />)
    expect(document.querySelector('svg')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
