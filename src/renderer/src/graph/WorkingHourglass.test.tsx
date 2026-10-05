// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkingHourglass } from './WorkingHourglass'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'matchMedia')
})

function preferReducedMotion(reduced: boolean): void {
  window.matchMedia = ((): unknown => ({
    matches: reduced,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  })) as unknown as typeof window.matchMedia
}

describe('WorkingHourglass', () => {
  it('is a button named for the ticket that opens the live attempt', () => {
    const opened: string[] = []
    const parent: string[] = []
    render(
      <div onClick={() => parent.push('click')}>
        <WorkingHourglass ticketKey="DM-12" onOpen={() => opened.push('open')} />
      </div>
    )
    const button = screen.getByRole('button', { name: 'DM-12 is being worked on' })
    expect(button.getAttribute('title')).toBe('Being worked on. Open the live activity.')
    fireEvent.click(button)
    expect([opened, parent]).toEqual([['open'], []])
  })

  it('turns while motion is welcome', () => {
    preferReducedMotion(false)
    render(<WorkingHourglass ticketKey="DM-12" onOpen={() => undefined} />)
    const button = screen.getByRole('button')
    expect([button.className, button.getAttribute('data-motion')]).toEqual(['ew-hourglass nodrag nopan is-animated', 'animated'])
  })

  it('holds still with reduced motion', () => {
    preferReducedMotion(true)
    render(<WorkingHourglass ticketKey="DM-12" onOpen={() => undefined} />)
    const button = screen.getByRole('button')
    expect([button.className, button.getAttribute('data-motion')]).toEqual(['ew-hourglass nodrag nopan is-static', 'static'])
  })
})
