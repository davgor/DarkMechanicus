// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { withInertStyleElements } from './inertStyles'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('withInertStyleElements', () => {
  it('answers a hidden element that is not a style element for a <style>, so its text never applies', () => {
    const made = withInertStyleElements(document, () => {
      const style = document.createElement('style')
      style.textContent = '.xterm { color: red; }'
      document.body.append(style)
      return style
    })
    expect(made).not.toBeInstanceOf(HTMLStyleElement)
    expect(made.hidden).toBe(true)
    expect(document.querySelectorAll('style')).toHaveLength(0)
    expect(document.styleSheets).toHaveLength(0)
  })

  it('treats the tag name case-insensitively, as createElement does', () => {
    const made = withInertStyleElements(document, () => document.createElement('STYLE'))
    expect(made).not.toBeInstanceOf(HTMLStyleElement)
  })

  it('creates every other element as usual, with its options', () => {
    const [canvas, div] = withInertStyleElements(document, () => [document.createElement('canvas'), document.createElement('div')])
    expect(canvas).toBeInstanceOf(HTMLCanvasElement)
    expect(div).toBeInstanceOf(HTMLDivElement)
    expect(div?.hidden).toBe(false)
  })

  it('returns what the work returns, and restores createElement afterwards', () => {
    expect(withInertStyleElements(document, () => 42)).toBe(42)
    expect(document.createElement('style')).toBeInstanceOf(HTMLStyleElement)
    expect(Object.hasOwn(document, 'createElement')).toBe(false)
  })

  it('restores createElement when the work throws', () => {
    expect(() =>
      withInertStyleElements(document, () => {
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(document.createElement('style')).toBeInstanceOf(HTMLStyleElement)
  })

  it('restores an inner call to the outer one when nested', () => {
    withInertStyleElements(document, () => {
      withInertStyleElements(document, () => undefined)
      expect(document.createElement('style')).not.toBeInstanceOf(HTMLStyleElement)
    })
    expect(document.createElement('style')).toBeInstanceOf(HTMLStyleElement)
  })
})
