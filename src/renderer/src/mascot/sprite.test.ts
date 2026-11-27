import { describe, expect, it } from 'vitest'
import { frameForMotion, spritePlacement, type SpriteSheet } from './sprite'
import type { MotionAction } from './motion'
import atlas from '../assets/mascot/atlas.json'
import magosAtlas from '../assets/magos/atlas.json'
import { MAGOS_SHEET } from '../cults/chamber/chamberArt'
import type { MagosAction } from '../cults/chamber/chamberState'

function expectAlignedFrames(action: MotionAction): void {
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

describe('salute and type in the mascot image map', () => {
  it('plays the one-shot salute once and loops type, pinned to each frame foot', () => {
    expect(frameForMotion('salute', 0, 0).index).toBe(0)
    expect(frameForMotion('salute', 250, 0).index).toBe(2)
    expect(frameForMotion('salute', 5000, 0).index).toBe(5)
    expect(frameForMotion('type', 130, 0).index).toBe(1)
    expect(frameForMotion('type', 760, 0).index).toBe(0)
    for (const action of ['salute', 'type'] as const) {
      const clip = atlas.actions[action]
      for (let index = 0; index < clip.frames.length; index += 1) {
        const pose = spritePlacement({ action, elapsed: index * 1000 / clip.fps, progress: 0, facing: 'left', x: 90, y: 200 })
        const frame = clip.frames[index]!
        expect(pose.index).toBe(index)
        expect(pose.image).toContain(`${action}.png`)
        expect(pose.left + (frame.width - frame.footAnchor.x) * pose.scale).toBeCloseTo(90)
        expect(pose.top + frame.footAnchor.y * pose.scale).toBeCloseTo(200)
      }
    }
  })

  it('scales the whole placement by an extra size factor', () => {
    const base = spritePlacement({ action: 'type', elapsed: 0, progress: 0, facing: 'right', x: 50, y: 90 })
    const small = spritePlacement({ action: 'type', elapsed: 0, progress: 0, facing: 'right', x: 50, y: 90, scale: 0.6 })
    expect(small.scale).toBeCloseTo(base.scale * 0.6)
    expect(small.width).toBeCloseTo(base.width * 0.6)
    expect(small.left + small.anchorX).toBeCloseTo(50)
  })
})

describe('the same reader on the Magos atlases', () => {
  const actions = Object.keys(magosAtlas.actions) as MagosAction[]

  it('reads every Magos clip at its own rate, holding one-shots on their last frame', () => {
    expect(actions).toHaveLength(7)
    expect(frameForMotion('idle', 340, 0, MAGOS_SHEET).index).toBe(2)
    expect(frameForMotion('idle', 1010, 0, MAGOS_SHEET).index).toBe(0)
    expect(frameForMotion('order_all', 260, 0, MAGOS_SHEET).index).toBe(2)
    expect(frameForMotion('order_all', 9000, 0, MAGOS_SHEET).index).toBe(5)
    expect(frameForMotion('petition', 9000, 0, MAGOS_SHEET).index).toBe(0)
  })

  it.each(actions)('pins every %s frame foot and draws left-facing art unmirrored', (action) => {
    const clip = magosAtlas.actions[action]
    for (let index = 0; index < clip.frames.length; index += 1) {
      const elapsed = index * 1000 / clip.fps
      const left = spritePlacement({ action, elapsed, progress: 0, facing: 'left', x: 400, y: 300 }, MAGOS_SHEET)
      const right = spritePlacement({ action, elapsed, progress: 0, facing: 'right', x: 400, y: 300 }, MAGOS_SHEET)
      const frame = clip.frames[index]!
      expect(left.frame).toEqual(frame)
      expect(left.image).toBe(MAGOS_SHEET.images[action])
      expect(left.mirrored).toBe(false)
      expect(right.mirrored).toBe(true)
      expect(left.scale).toBeCloseTo(MAGOS_SHEET.cellSize / magosAtlas.cell.width * clip.renderScale)
      expect(left.left + frame.footAnchor.x * left.scale).toBeCloseTo(400)
      expect(right.left + (frame.width - frame.footAnchor.x) * right.scale).toBeCloseTo(400)
      expect(left.top + frame.footAnchor.y * left.scale).toBeCloseTo(300)
      expect(left.sheetWidth).toBeCloseTo(3 * magosAtlas.cell.width * left.scale)
    }
  })
})

describe('a sheet whose frames share the clip foot anchor', () => {
  const sheet: SpriteSheet<'stand'> = {
    atlas: { cell: { width: 200, height: 300 }, actions: { stand: { fps: 4, loop: true, renderScale: 1,
      footAnchor: { x: 60, y: 280 }, frames: [{ x: 0, y: 0, width: 120, height: 290 },
        { x: 200, y: 0, width: 140, height: 290, footAnchor: { x: 90, y: 270 } }] } } },
    images: { stand: 'stand.png' }, cellSize: 100, facing: 'right'
  }

  it('pins a frame without its own anchor by the clip anchor, and a frame with one by its own', () => {
    const shared = spritePlacement({ action: 'stand', elapsed: 0, progress: 0, facing: 'left', x: 100, y: 200 }, sheet)
    expect(shared.scale).toBe(0.5)
    expect(shared.left).toBe(100 - (120 - 60) * 0.5)
    expect(shared.top).toBe(200 - 280 * 0.5)
    const own = spritePlacement({ action: 'stand', elapsed: 250, progress: 0, facing: 'right', x: 100, y: 200 }, sheet)
    expect(own.index).toBe(1)
    expect(own.left).toBe(100 - 90 * 0.5)
    expect(own.top).toBe(200 - 270 * 0.5)
  })
})
