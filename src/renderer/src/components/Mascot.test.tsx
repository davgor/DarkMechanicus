// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Mascot } from './Mascot'

afterEach(cleanup)

describe('Mascot', () => {
  it('is a decorative 1x/2x image of the tech-priest from the bundled assets', () => {
    render(<Mascot size={128} />)
    const image = document.querySelector('img')
    expect(image).toBeTruthy()
    expect(image?.getAttribute('alt')).toBe('')
    expect(image?.getAttribute('src')).toMatch(/brand-icon-128.*\.png$/)
    const sources = (image?.getAttribute('srcset') ?? '').split(',').map((entry) => entry.trim())
    expect(sources).toHaveLength(2)
    expect(sources[0]).toMatch(/brand-icon-128.*\.png 1x$/)
    expect(sources[1]).toMatch(/brand-icon-256.*\.png 2x$/)
  })

  it('takes its display size from attributes rather than inline styles', () => {
    render(<Mascot size={96} />)
    const image = document.querySelector('img')
    expect(image?.getAttribute('width')).toBe('96')
    expect(image?.getAttribute('height')).toBe('96')
    expect(image?.getAttribute('style')).toBeNull()
  })
})
