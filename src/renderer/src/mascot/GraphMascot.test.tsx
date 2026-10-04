// @vitest-environment jsdom
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GraphMascot } from './GraphMascot'

const board = createRef<HTMLDivElement>()
let reduced = false
let visible = true
const mediaListeners = new Set<() => void>()
const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 1

class SizeObserver {
  observe(): void {}
  disconnect(): void {}
}

function tick(time: number): void {
  const pending = [...frames.values()]
  frames.clear()
  act(() => pending.forEach((frame) => frame(time)))
}

function mount() {
  return render(<div ref={board}><GraphMascot board={board} nodes={[]} viewport={{ x: 0, y: 0, zoom: 1 }} /></div>)
}

beforeEach(() => {
  localStorage.clear()
  reduced = false
  visible = true
  frames.clear()
  nextFrame = 1
  vi.stubGlobal('ResizeObserver', SizeObserver)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('matchMedia', () => ({
    get matches() { return reduced },
    addEventListener: (_name: string, callback: () => void) => mediaListeners.add(callback),
    removeEventListener: (_name: string, callback: () => void) => mediaListeners.delete(callback)
  }))
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => !visible })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 500 })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  mediaListeners.clear()
})

describe('graph mascot lifecycle', () => {
  it('pauses, preserves pose, resumes without a time jump, and cleans up on unmount', () => {
    const view = mount()
    expect(frames.size).toBe(1)
    tick(100)
    const pose = view.container.querySelector<HTMLElement>('.pg-mascot-sprite')!
    const initialLeft = pose.style.left
    for (let time = 150; time <= 5000 && pose.style.left === initialLeft; time += 50) tick(time)
    expect(pose.style.left).not.toBe(initialLeft)
    const left = pose.style.left
    const top = pose.style.top
    const frame = pose.getAttribute('data-frame')
    fireEvent.click(screen.getByRole('button', { name: 'Pause mascot animation' }))
    expect(frames.size).toBe(0)
    expect(pose.style.left).toBe(left)
    expect(pose.style.top).toBe(top)
    expect(pose.getAttribute('data-frame')).toBe(frame)
    expect(screen.getByRole('button', { name: 'Resume mascot animation' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Resume mascot animation' }))
    expect(frames.size).toBe(1)
    tick(10_000)
    expect(pose.style.left).toBe(left)
    tick(10_050)
    expect(frames.size).toBe(1)
    view.unmount()
    expect(frames.size).toBe(0)
  })

  it('renders a grounded static pose when persisted paused or reduced motion is requested', () => {
    localStorage.setItem('mascotMotionPaused', 'true')
    const view = mount()
    expect(frames.size).toBe(0)
    expect(view.container.querySelector<HTMLElement>('.pg-mascot-sprite')?.style.left).toBe('350px')
    fireEvent.click(screen.getByRole('button', { name: 'Resume mascot animation' }))
    expect(frames.size).toBe(1)
    act(() => { reduced = true; mediaListeners.forEach((listener) => listener()) })
    expect(frames.size).toBe(0)
    expect(view.container.querySelector('.pg-mascot-sprite')?.getAttribute('data-action')).toBe('idle')
    expect(view.container.querySelector('.pg-mascot-sprite')?.getAttribute('data-frame')).toBe('0')
  })

  it('stops scheduling while the page is hidden and restarts on visibility', () => {
    mount()
    expect(frames.size).toBe(1)
    act(() => { visible = false; document.dispatchEvent(new Event('visibilitychange')) })
    expect(frames.size).toBe(0)
    act(() => { visible = true; document.dispatchEvent(new Event('visibilitychange')) })
    expect(frames.size).toBe(1)
  })
})
