// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { folderView } from '../__mocks__/fixtures'
import { LoadingView, UnavailableView, WelcomeView } from './MainViews'

afterEach(cleanup)

describe('WelcomeView', () => {
  it('invites the person to track a folder', () => {
    const calls: string[] = []
    render(<WelcomeView onTrack={() => calls.push('track')} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Track a folder to get started' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }))
    expect(calls).toEqual(['track'])
  })

  it('shows the tech-priest above the heading, as a decorative image', () => {
    render(<WelcomeView onTrack={() => undefined} />)
    const image = document.querySelector('.empty-state img') as HTMLImageElement
    expect(image).toBeTruthy()
    expect(image.getAttribute('alt')).toBe('')
    expect(image.getAttribute('src')).toMatch(/brand-icon-128.*\.png$/)
    expect(image.getAttribute('width')).toBe('128')
    const heading = screen.getByRole('heading', { level: 1, name: 'Track a folder to get started' })
    expect(image.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(document.querySelector('[data-icon="folder"]')).toBeNull()
  })
})

describe('UnavailableView', () => {
  it('says where the folder was expected and offers to stop tracking it', () => {
    const requests: string[] = []
    const folder = folderView({ path: '/gone', name: 'gone', displayPath: '~/code/gone', available: false })
    render(<UnavailableView folder={folder} onStopTracking={(f) => requests.push(f.path)} />)
    expect(screen.getByRole('heading', { level: 1, name: 'gone can’t be found' })).toBeTruthy()
    expect(screen.getByText(/~\/code\/gone/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop tracking folder' }))
    expect(requests).toEqual(['/gone'])
  })

  it('keeps its warning icon and shows no mascot', () => {
    const folder = folderView({ path: '/gone', name: 'gone', displayPath: '~/code/gone', available: false })
    render(<UnavailableView folder={folder} onStopTracking={() => undefined} />)
    expect(document.querySelector('[data-icon="warning"]')).not.toBeNull()
    expect(document.querySelector('img')).toBeNull()
  })
})

describe('LoadingView', () => {
  it.each([
    ['folders', 'Loading folders…'],
    ['chat', 'Loading chat…'],
    ['agents', 'Loading agents…']
  ] as const)('announces that the %s are loading', (what, words) => {
    render(<LoadingView what={what} />)
    const status = screen.getByRole('status')
    expect(status.textContent).toBe(words)
    expect(status.getAttribute('aria-busy')).toBe('true')
  })
})
