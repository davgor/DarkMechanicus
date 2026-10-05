import { describe, expect, it } from 'vitest'
import { frameForMotion, spritePlacement } from './sprite'
import atlas from '../assets/mascot/atlas.json'

function expectAlignedFrames(action: keyof typeof atlas.actions): void {
  const clip = atlas.actions[action]
  for (let index = 0; index < clip.frames.length; index += 1) {
    const progress = action === 'jump' ? [0, 0.14, 0.32, 0.5, 0.68, 0.86][index]! : index / clip.frames.length
    const elapsed = index * 1000 / clip.fps
    const right = spritePlacement({ action, elapsed, progress, facing: 'right', x: 173, y: 281 })
    const left = spritePlacement({ action, elapsed, progress, facing: 'left', x: 173, y: 281 })
    const frame = clip.frames[right.index]!
    const anchor = frame.footAnchor ?? clip.footAnchor
    expect(right.frame).toEqual(frame)
    expect(right.width).toBeCloseTo(frame.width * 100 / atlas.cell.width * clip.renderScale)
    expect(right.height).toBeCloseTo(frame.height * 100 / atlas.cell.width * clip.renderScale)
    expect(right.left + anchor.x * right.scale).toBeCloseTo(173)
    expect(left.left + (frame.width - anchor.x) * left.scale).toBeCloseTo(173)
    expect(right.top + anchor.y * right.scale).toBeCloseTo(281)
    expect(left.top + anchor.y * left.scale).toBeCloseTo(281)
    expect(right.sheetWidth).toBeCloseTo(3 * atlas.cell.width * right.scale)
    expect(right.sheetHeight).toBeCloseTo(2 * atlas.cell.height * right.scale)
    expect(left.mirrored).toBe(true)
    expect(right.mirrored).toBe(false)
  }
}

describe('mascot sprite playback', () => {
  it('advances looping actions at their own clip rates', () => {
    expect(frameForMotion('walk', 0, 0).index).toBe(0)
    expect(frameForMotion('walk', 190, 0).index).toBe(1)
    expect(frameForMotion('walk', 610, 0).index).toBe(0)
    expect(frameForMotion('walk', 1810, 0).index).toBe(0)
    expect(frameForMotion('run', 150, 0).index).toBe(2)
    expect(frameForMotion('climb', 375, 0).index).toBe(3)
    expect(frameForMotion('drill', 0, 0).index).toBe(0)
    expect(frameForMotion('drill', 250, 0).index).toBe(1)
    expect(frameForMotion('drill', 1500, 0).index).toBe(0)
  })

  it('reserves jump crouch, flight and landing and lets stumble recover once', () => {
    expect(frameForMotion('jump', 0, 0).index).toBe(0)
    expect(frameForMotion('jump', 0, 0.14).index).toBe(1)
    expect(frameForMotion('jump', 0, 0.5).index).toBe(3)
    expect(frameForMotion('jump', 0, 0.86).index).toBe(5)
    expect(frameForMotion('stumble', 2000, 1).index).toBe(5)
    expect(frameForMotion('stumble', 400, 0.85).index).toBe(5)
  })

  it('pins each scaled frame foot anchor and mirrors left-facing playback', () => {
    const first = spritePlacement({ action: 'walk', elapsed: 0, progress: 0, facing: 'right', x: 200, y: 300 })
    const fourth = spritePlacement({ action: 'walk', elapsed: 350, progress: 0, facing: 'right', x: 200, y: 300 })
    expect(first.top).toBeCloseTo(300 - 429 * first.scale)
    expect(fourth.top).toBeCloseTo(300 - 424 * fourth.scale)
    expect(first.top).not.toBe(fourth.top)
    const climb = spritePlacement({ action: 'climb', elapsed: 0, progress: 0, facing: 'left', x: 200, y: 300 })
    expect(climb.scale).toBeCloseTo(first.scale * 0.78)
    expect(climb.left + climb.anchorX).toBeCloseTo(200)
    expect(climb.mirrored).toBe(true)
  })

  it('keeps every action frame aligned to its foot and its atlas cell in both directions', () => {
    for (const action of ['idle', 'walk', 'run', 'jump', 'climb', 'stumble'] as const) {
      expect(atlas.actions[action].frames.length).toBeGreaterThan(0)
      expectAlignedFrames(action)
    }
  })

})

describe('drill sprite placement', () => {
  it('anchors every drill frame to the planted feet and mirrors the drill with the mascot', () => {
    const clip = atlas.actions.drill
    for (let index = 0; index < clip.frames.length; index += 1) {
      const right = spritePlacement({ action: 'drill', elapsed: index * 250, progress: 0, facing: 'right', x: 173, y: 281 })
      const left = spritePlacement({ action: 'drill', elapsed: index * 250, progress: 0, facing: 'left', x: 173, y: 281 })
      const frame = clip.frames[index]!
      const anchor = frame.footAnchor ?? clip.footAnchor
      expect(right.frame).toEqual(frame)
      expect(right.top + anchor.y * right.scale).toBeCloseTo(281)
      expect(right.left + anchor.x * right.scale).toBeCloseTo(173)
      expect(left.left + (frame.width - anchor.x) * left.scale).toBeCloseTo(173)
      expect(left.mirrored).toBe(true)
    }
  })
})
