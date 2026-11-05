import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { ATLAS_DIR, buildFrames, decodePng, OUT_FILE } from './mascotFrames.mjs'

/** Minimal RGBA PNG writer (filter 0, CRC left zero: the decoder does not check it). */
function encodePng(width, height, rgba) {
  const chunk = (type, body) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(body.length, 0)
    head.write(type, 4, 'latin1')
    return Buffer.concat([head, body, Buffer.alloc(4)])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// Two 8x8 frames side by side. A red 4x5 figure stands on a different row in each frame, so only the
// foot anchors keep the boots together.
const CELL = 8
const frames = [
  { name: 'a', x: 0, y: 0, width: CELL, height: CELL, footAnchor: { x: 4, y: 7 }, fig: { x0: 2, x1: 5, y0: 3, y1: 7 } },
  { name: 'b', x: 8, y: 0, width: CELL, height: CELL, footAnchor: { x: 4, y: 5 }, fig: { x0: 2, x1: 5, y0: 1, y1: 5 } }
]
function fixtureImage() {
  const rgba = Buffer.alloc(16 * 8 * 4)
  for (const f of frames) {
    for (let y = f.fig.y0; y <= f.fig.y1; y++) {
      for (let x = f.fig.x0; x <= f.fig.x1; x++) {
        const i = (y * 16 + f.x + x) * 4
        rgba.set([200, 30, 30, 255], i)
      }
    }
  }
  return decodePng(encodePng(16, 8, rgba))
}
const atlas = { actions: { idle: { image: 'fx.png', fps: 6, frames: frames.map((f) => ({ name: f.name, x: f.x, y: f.y, width: f.width, height: f.height, footAnchor: f.footAnchor })) } } }
const ROWS = 3

const SGR = new RegExp(String.fromCharCode(27) + '[[][0-9;]*m', 'g')
const strip = (s) => s.replace(SGR, '')
const lastFigureRow = (rows) => rows.reduce((last, line, i) => (strip(line).trim() ? i : last), -1)

describe('mascot frame generator', () => {
  const doc = buildFrames(atlas, fixtureImage.bind(null), ['idle'], { banner: ROWS })
  const loop = doc.loops.idle.sizes.banner

  it('decodes the PNG it is given', () => {
    expect(fixtureImage()).toMatchObject({ width: 16, height: 8 })
  })

  it('makes one frame per atlas frame, with the atlas fps', () => {
    expect(loop.frames.map((f) => f.name)).toEqual(['a', 'b'])
    expect(doc.loops.idle.fps).toBe(6)
  })

  it('gives every frame the requested rows and a fixed column count', () => {
    for (const f of loop.frames) {
      expect(f.rows).toHaveLength(ROWS)
      for (const line of f.rows) expect(strip(line)).toHaveLength(loop.cols)
    }
    expect(loop.rows).toBe(ROWS)
  })

  it('leaves transparent cells as plain spaces with no color codes', () => {
    for (const f of loop.frames) {
      for (const line of f.rows) {
const outside = line.replace(SGR, '').replaceAll(String.fromCharCode(0x2580), '').replaceAll(String.fromCharCode(0x2584), '')
        expect(outside).toMatch(/^ *$/)
      }
      expect(f.rows.join('')).toContain('\x1b[38;2;200;30;30')
    }
    // The leftmost column is empty in the fixture, so it must be an unpainted space.
    expect(loop.frames[0].rows.every((line) => line.startsWith(' '))).toBe(true)
  })

  it('keeps the foot on the same row in every frame', () => {
    const feet = loop.frames.map((f) => lastFigureRow(f.rows))
    expect(feet[0]).toBe(feet[1])
    expect(feet[0]).toBe(loop.footRow)
  })
})

describe('committed output', () => {
  const committed = JSON.parse(readFileSync(OUT_FILE, 'utf8'))

  it('is exactly what the script makes from the atlases', () => {
    const atlasJson = JSON.parse(readFileSync(join(ATLAS_DIR, 'atlas.json'), 'utf8'))
    const fresh = buildFrames(atlasJson, (file) => decodePng(readFileSync(join(ATLAS_DIR, file))))
    expect(committed).toEqual(fresh)
  })

  it('holds banner and indicator frames for the idle and drill loops with a steady foot row', () => {
    for (const loop of ['idle', 'drill']) {
      for (const [size, rows] of [['banner', 16], ['indicator', 6]]) {
        const s = committed.loops[loop].sizes[size]
        expect(s.frames).toHaveLength(6)
        expect(s.rows).toBe(rows)
        const feet = new Set(s.frames.map((f) => lastFigureRow(f.rows)))
        // Drill sparks can sit below the boots in one frame; the boots themselves stay put.
        expect(Math.max(...feet) - s.footRow).toBeLessThanOrEqual(1)
      }
    }
  })
})
