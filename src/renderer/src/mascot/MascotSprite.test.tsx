// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MascotSprite } from './MascotSprite'
import { createMotion } from './motion'

afterEach(cleanup)

describe('mascot sprite action overrides', () => {
  it('uses the drill atlas while working and follows playback time', () => {
    const motion = { ...createMotion(1, { x: 160, y: 120 }), action: 'climb' as const, facing: 'left' as const, working: true }
    const view = render(<MascotSprite motion={motion} playbackMs={500} />)
    const sprite = view.container.querySelector<HTMLElement>('.pg-mascot-sprite')!
    expect(sprite.dataset.action).toBe('drill')
    expect(sprite.dataset.frame).toBe('2')
    expect(sprite.style.transform).toBe('scaleX(-1)')
    expect(sprite.style.backgroundImage).toContain('drill.png')
  })

  it('freezes a resting drill pose at motion elapsed time', () => {
    const motion = { ...createMotion(1, { x: 160, y: 120 }), action: 'walk' as const, elapsed: 250, working: true, resting: true }
    const view = render(<MascotSprite motion={motion} playbackMs={5000} />)
    const sprite = view.container.querySelector<HTMLElement>('.pg-mascot-sprite')!
    expect(sprite.dataset.action).toBe('drill')
    expect(sprite.dataset.frame).toBe('1')
  })

  it('keeps ordinary motion playback on the original action atlas', () => {
    const motion = { ...createMotion(1, { x: 160, y: 120 }), action: 'walk' as const }
    const view = render(<MascotSprite motion={motion} playbackMs={200} />)
    const sprite = view.container.querySelector<HTMLElement>('.pg-mascot-sprite')!
    expect(sprite.dataset.action).toBe('walk')
    expect(sprite.dataset.frame).toBe('2')
    expect(sprite.style.backgroundImage).toContain('walk.png')
  })

  it('shows only the early tumble frames while falling, then permits landing recovery', () => {
    const motion = { ...createMotion(1, { x: 160, y: 120 }), action: 'stumble' as const, progress: 0.9, falling: true }
    const view = render(<MascotSprite motion={motion} />)
    const sprite = view.container.querySelector<HTMLElement>('.pg-mascot-sprite')!
    expect(Number(sprite.dataset.frame)).toBeLessThanOrEqual(2)
    view.rerender(<MascotSprite motion={{ ...motion, falling: false }} />)
    expect(Number(sprite.dataset.frame)).toBeGreaterThan(2)
  })
})
