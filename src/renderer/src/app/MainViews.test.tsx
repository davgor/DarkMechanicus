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
})

describe('LoadingView', () => {
  it('announces that folders are loading', () => {
    render(<LoadingView />)
    const status = screen.getByRole('status')
    expect(status.textContent).toBe('Loading folders…')
    expect(status.getAttribute('aria-busy')).toBe('true')
  })
})
