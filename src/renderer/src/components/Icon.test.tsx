// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Icon } from './Icon'
import type { IconName } from './Icon'

afterEach(cleanup)

const NAMES: IconName[] = [
  'chevron-down',
  'chevron-right',
  'folder',
  'plus',
  'warning',
  'plug',
  'export',
  'file',
  'copy',
  'more',
  'search',
  'check',
  'close',
  'refresh',
  'branch',
  'arrow-up',
  'download',
  'hourglass'
]

function svgOf(name: IconName, props: { size?: number; strokeWidth?: number } = {}): SVGElement {
  const { container } = render(<Icon name={name} {...props} />)
  const svg = container.querySelector('svg')
  if (svg === null) throw new Error('no svg rendered')
  return svg
}

describe('Icon', () => {
  it('renders a decorative inline svg', () => {
    const svg = svgOf('plus')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('focusable')).toBe('false')
    expect(svg.getAttribute('data-icon')).toBe('plus')
    expect(svg.getAttribute('viewBox')).toBe('0 0 16 16')
  })

  it('defaults to a 16px icon with a 1.6 stroke', () => {
    const svg = svgOf('plus')
    expect(svg.getAttribute('width')).toBe('16')
    expect(svg.getAttribute('height')).toBe('16')
    expect(svg.getAttribute('stroke-width')).toBe('1.6')
  })

  it('honours size and stroke width', () => {
    const svg = svgOf('plus', { size: 20, strokeWidth: 1.5 })
    expect(svg.getAttribute('width')).toBe('20')
    expect(svg.getAttribute('height')).toBe('20')
    expect(svg.getAttribute('stroke-width')).toBe('1.5')
  })

  it('draws a path for every icon, each different', () => {
    const paths = NAMES.map((name) => {
      const d = svgOf(name).querySelector('path')?.getAttribute('d') ?? ''
      cleanup()
      return d
    })
    expect(paths.every((d) => d.length > 0)).toBe(true)
    expect(new Set(paths).size).toBe(NAMES.length)
  })
})
