import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import atlas from '../assets/magos/atlas.json'

const assetDir = join(__dirname, '../assets/magos')
const expectedTiming = {
  idle: { loop: true, fps: 6 },
  speak: { loop: true, fps: 8 },
  order_one: { loop: false },
  order_all: { loop: false },
  summon: { loop: false },
  petition: { loop: true },
  chronicle: { loop: false }
} as const

type ActionName = keyof typeof expectedTiming

function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(join(assetDir, file))
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG')
  expect(bytes.subarray(12, 16).toString('ascii')).toBe('IHDR')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

describe('magos atlas', () => {
  const actions = atlas.actions as Record<ActionName, (typeof atlas.actions)['idle']>

  it('lists all seven actions', () => {
    expect(Object.keys(atlas.actions).sort()).toEqual(Object.keys(expectedTiming).sort())
  })

  it('stores every action as a 1536x1024 PNG with 512x512 cells', () => {
    expect(atlas.cell).toMatchObject({ width: 512, height: 512 })
    for (const clip of Object.values(actions)) expect(pngSize(clip.image)).toEqual({ width: 1536, height: 1024 })
  })

  it('keeps six frame rectangles inside their row-major cells and foot anchors inside frames', () => {
    for (const clip of Object.values(actions)) {
      expect(clip.frames).toHaveLength(6)
      expect(clip.footAnchor.x).toBeGreaterThanOrEqual(0)
      expect(clip.footAnchor.y).toBeLessThanOrEqual(atlas.cell.height)
      clip.frames.forEach((frame, index) => {
        const cellX = (index % 3) * atlas.cell.width
        const cellY = Math.floor(index / 3) * atlas.cell.height
        expect(frame.x).toBeGreaterThanOrEqual(cellX)
        expect(frame.y).toBeGreaterThanOrEqual(cellY)
        expect(frame.x + frame.width).toBeLessThanOrEqual(cellX + atlas.cell.width)
        expect(frame.y + frame.height).toBeLessThanOrEqual(cellY + atlas.cell.height)
        expect(frame.footAnchor.x).toBeGreaterThanOrEqual(0)
        expect(frame.footAnchor.x).toBeLessThanOrEqual(frame.width)
        expect(frame.footAnchor.y).toBeGreaterThanOrEqual(0)
        expect(frame.footAnchor.y).toBeLessThanOrEqual(frame.height)
      })
    }
  })

  it('matches the ticket loop and frame-rate contract', () => {
    for (const [name, timing] of Object.entries(expectedTiming) as Array<[ActionName, { loop: boolean; fps?: number }]>) {
      const clip = actions[name]
      expect(clip.loop).toBe(timing.loop)
      expect(clip.playback).toBe(timing.loop ? 'loop' : 'once')
      if (timing.fps !== undefined) expect(clip.fps).toBe(timing.fps)
      expect(clip.fps).toBeGreaterThan(0)
      expect(clip.renderScale).toBeGreaterThan(0)
    }
  })
})
