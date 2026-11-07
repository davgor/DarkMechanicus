// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReferenceList } from './ReferenceList'

afterEach(() => {
  cleanup()
})

describe('ReferenceList', () => {
  it('renders an https reference as a link that opens through window.dm.openExternal', () => {
    const openExternal = vi.fn(() => Promise.resolve(true))
    window.dm = { openExternal } as unknown as typeof window.dm
    render(<ReferenceList references={[{ kind: 'url', label: 'Design doc', location: 'https://example.test/design', hash: null, remoteOnly: true }]} />)
    const link = screen.getByRole('link', { name: 'Design doc (https://example.test/design)' })
    fireEvent.click(link)
    expect(openExternal).toHaveBeenCalledWith('https://example.test/design')
  })

  it('renders a file reference as text with no link', () => {
    render(<ReferenceList references={[{ kind: 'file', label: 'login form', location: 'src/login.tsx', hash: null, remoteOnly: false }]} />)
    const region = screen.getByRole('region', { name: 'References' })
    expect(screen.getByText('login form (src/login.tsx)')).toBeTruthy()
    expect(region.querySelector('a')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('renders nothing for an empty list', () => {
    const { container } = render(<ReferenceList references={[]} />)
    expect(container.innerHTML).toBe('')
  })
})
