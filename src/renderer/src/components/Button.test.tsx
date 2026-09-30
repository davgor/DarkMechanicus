// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Button } from './Button'

afterEach(cleanup)

describe('Button', () => {
  it('is a plain button that does not submit forms by default', () => {
    render(<Button>Save</Button>)
    const button = screen.getByRole('button', { name: 'Save' })
    expect(button.getAttribute('type')).toBe('button')
    expect(button.className).toBe('btn')
  })

  it('allows a submit button', () => {
    render(<Button type="submit">Go</Button>)
    expect(screen.getByRole('button', { name: 'Go' }).getAttribute('type')).toBe('submit')
  })

  it.each([
    ['primary', 'btn btn-primary'],
    ['ghost', 'btn btn-ghost'],
    ['danger', 'btn btn-danger'],
    ['default', 'btn']
  ] as const)('styles the %s variant', (variant, expected) => {
    render(<Button variant={variant}>Label</Button>)
    expect(screen.getByRole('button').className).toBe(expected)
  })

  it('adds the small size class and any extra class', () => {
    render(
      <Button size="sm" className="extra">
        Label
      </Button>
    )
    expect(screen.getByRole('button').className).toBe('btn btn-sm extra')
  })
})

describe('Button content', () => {
  it('shows an icon before the label', () => {
    render(<Button icon="plus">Add</Button>)
    const button = screen.getByRole('button', { name: 'Add' })
    expect(button.firstElementChild?.getAttribute('data-icon')).toBe('plus')
    expect(button.className).toBe('btn')
  })

  it('becomes an icon-only button without children', () => {
    render(<Button icon="close" aria-label="Close" />)
    const button = screen.getByRole('button', { name: 'Close' })
    expect(button.className).toBe('btn btn-icon')
    expect(button.querySelector('span')).toBeNull()
  })
})

describe('Button state', () => {
  it('is disabled and marked busy while busy', () => {
    render(<Button busy>Working</Button>)
    const button = screen.getByRole('button') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
  })

  it('can be disabled without being busy', () => {
    render(<Button disabled>Nope</Button>)
    const button = screen.getByRole('button') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBeNull()
  })

  it('is enabled otherwise and forwards clicks', () => {
    const clicks: string[] = []
    render(<Button onClick={() => clicks.push('click')}>Go</Button>)
    const button = screen.getByRole('button') as HTMLButtonElement
    fireEvent.click(button)
    expect(button.disabled).toBe(false)
    expect(clicks).toEqual(['click'])
  })
})
