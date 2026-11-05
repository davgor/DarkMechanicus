// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SkitariiMascot } from './SkitariiMascot'

let reduced = false
let visible = true
const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 1

function tick(time: number): void {
  const pending = [...frames.values()]
  frames.clear()
  act(() => pending.forEach((frame) => frame(time)))
}

beforeEach(() => {
  reduced = false
  visible = true
  frames.clear()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('matchMedia', () => ({
    get matches() { return reduced },
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }))
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => !visible })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const sprite = (container: HTMLElement): HTMLElement => container.querySelector<HTMLElement>('.pg-mascot-sprite')!

describe('SkitariiMascot', () => {
  it('idles, and drills while working', () => {
    const view = render(<SkitariiMascot working={false} />)
    expect(sprite(view.container).dataset.action).toBe('idle')
    view.rerender(<SkitariiMascot working />)
    expect(sprite(view.container).dataset.action).toBe('drill')
    view.rerender(<SkitariiMascot working={false} />)
    expect(sprite(view.container).dataset.action).toBe('idle')
  })

  it('advances its frames while animated', () => {
    const view = render(<SkitariiMascot working />)
    tick(0)
    const seen = new Set<string>()
    for (let time = 50; time <= 1000; time += 50) {
      tick(time)
      seen.add(sprite(view.container).dataset.frame!)
    }
    expect(seen.size).toBeGreaterThan(1)
  })

  it('stays still with reduced motion, even while working, and requests no frames', () => {
    reduced = true
    const view = render(<SkitariiMascot working />)
    expect(frames.size).toBe(0)
    expect(view.container.querySelector('.skitarii-mascot')!.getAttribute('data-animated')).toBe('false')
    expect(sprite(view.container).dataset.action).toBe('drill')
    expect(sprite(view.container).dataset.frame).toBe('0')
  })

  it('stops while the page is hidden and goes on when it is shown again', () => {
    const view = render(<SkitariiMascot working />)
    expect(frames.size).toBe(1)
    visible = false
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(frames.size).toBe(0)
    expect(view.container.querySelector('.skitarii-mascot')!.getAttribute('data-animated')).toBe('false')
    visible = true
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(frames.size).toBe(1)
  })
})
