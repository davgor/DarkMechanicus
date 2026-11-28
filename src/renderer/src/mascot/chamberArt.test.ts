import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import atlas from '../assets/mascot/atlas.json'
import props from '../assets/chamber/props.json'

const ASSETS = fileURLToPath(new URL('../assets/', import.meta.url))

interface Rect { x: number; y: number; width: number; height: number }
interface Size { width: number; height: number }

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: string): Size {
  const bytes = readFileSync(file)
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG')
  expect(bytes.subarray(12, 16).toString('latin1')).toBe('IHDR')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function expectInside(inner: Rect, outer: Rect): void {
  expect(inner.width).toBeGreaterThan(0)
  expect(inner.height).toBeGreaterThan(0)
  expect(inner.x).toBeGreaterThanOrEqual(outer.x)
  expect(inner.y).toBeGreaterThanOrEqual(outer.y)
  expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width)
  expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height)
}

function imageRect(prop: Size): Rect {
  return { x: 0, y: 0, width: prop.width, height: prop.height }
}

describe('acolyte salute and type atlases', () => {
  for (const action of ['salute', 'type'] as const) {
    it(`${action} keeps its frames in their cells and its foot anchors in their frames`, () => {
      const clip = atlas.actions[action]
      const sheet = pngSize(join(ASSETS, 'mascot', clip.image))
      expect(sheet).toEqual({ width: 3 * atlas.cell.width, height: 2 * atlas.cell.height })
      expect(clip.frames).toHaveLength(6)
      expect(clip.fps).toBeGreaterThan(0)
      clip.frames.forEach((frame, index) => {
        const cell = { x: (index % 3) * atlas.cell.width, y: Math.floor(index / 3) * atlas.cell.height,
          width: atlas.cell.width, height: atlas.cell.height }
        expectInside(frame, cell)
        const local = { x: 0, y: 0, width: frame.width, height: frame.height }
        expectInside({ ...frame.footAnchor, width: 1, height: 1 }, local)
      })
      expectInside({ ...clip.footAnchor, width: 1, height: 1 }, { x: 0, y: 0, ...atlas.cell })
    })
  }
})

describe('chamber scenery', () => {
  it('has an opaque-sized backdrop with its floor band inside the image', () => {
    const { backdrop } = props
    expect(pngSize(join(ASSETS, 'chamber', backdrop.image))).toEqual({ width: 2400, height: 1200 })
    expect(backdrop).toMatchObject({ width: 2400, height: 1200 })
    expect(backdrop.floorY).toBeGreaterThan(0)
    expect(backdrop.floorY).toBeLessThan(backdrop.height)
  })

  it('declares every prop at the pixel size of its PNG with its foot line inside it', () => {
    const images: Array<{ prop: Size & { footY: number }; file: string }> = [
      ...[props.helm, props.console, props.teleportPad, props.viewscreen].map((prop) => ({ prop, file: prop.image })),
      ...[props.door.images.closed, props.door.images.open].map((file) => ({ prop: props.door, file }))
    ]
    for (const { prop, file } of images) {
      expect(pngSize(join(ASSETS, 'chamber', file)), file).toEqual({ width: prop.width, height: prop.height })
      expect(prop.footY).toBeGreaterThan(0)
      expect(prop.footY).toBeLessThanOrEqual(prop.height)
    }
  })

  it('puts the measured stand tops, screen window and doorway inside their images', () => {
    for (const prop of [props.helm, props.console]) {
      const { left, right, y } = prop.standTop
      expectInside({ x: left, y, width: right - left, height: 1 }, imageRect(prop))
      expect(y).toBeLessThan(prop.footY)
    }
    expectInside(props.viewscreen.window, imageRect(props.viewscreen))
    expectInside(props.door.doorway, imageRect(props.door))
    expect(props.door.doorway.y + props.door.doorway.height).toBeLessThanOrEqual(props.door.footY)
  })
})
