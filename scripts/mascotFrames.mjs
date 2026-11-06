/**
 * Renders the chibi tech-priest mascot atlases (src/renderer/src/assets/mascot) as true-color half-block
 * terminal frames for the Skitarii TUI. No new art: every pixel comes from the atlas PNGs.
 *
 *   node scripts/mascotFrames.mjs        rewrites resources/skitarii/mascot/frames.json
 *
 * Each loop is rendered at two sizes (banner, indicator). Every frame of a loop uses the same crop window,
 * positioned from the frame's foot anchor, so the boots land on the same output row in every frame.
 * Cells with no figure in them carry no color codes at all (the terminal background shows through).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const ATLAS_DIR = join(ROOT, 'src', 'renderer', 'src', 'assets', 'mascot')
export const OUT_FILE = join(ROOT, 'resources', 'skitarii', 'mascot', 'frames.json')

/** Loops to render, and the output sizes in terminal rows (two image pixels per row). */
export const LOOPS = ['idle', 'run', 'drill']
export const SIZES = { banner: 20, indicator: 6 }

/** Pixel coverage (0..1) at or above which an output pixel counts as part of the figure. */
const COVERAGE_CUT = 0.35
/** Source alpha above which a pixel counts for the silhouette bounds (matches docs/mascot-sprites.md, >16). */
const BOUNDS_ALPHA = 16
const MARGIN_PX = 2

/** Reads the PNG chunks: { width, height, channels, idat }. Only 8-bit non-interlaced RGB/RGBA is supported. */
function readChunks(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  const info = { width: 0, height: 0, channels: 4, idat: [] }
  let pos = 8
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    const body = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') readHeader(body, info)
    else if (type === 'IDAT') info.idat.push(body)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  return info
}

function readHeader(body, info) {
  const colorType = body[9]
  if (body[8] !== 8 || body[12] !== 0 || (colorType !== 6 && colorType !== 2)) {
    throw new Error('only 8-bit non-interlaced RGB/RGBA PNGs are supported')
  }
  info.width = body.readUInt32BE(0)
  info.height = body.readUInt32BE(4)
  info.channels = colorType === 6 ? 4 : 3
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/** Undo one scanline filter in place; `prev` is the already-unfiltered line above. */
function unfilter(line, prev, filter, channels) {
  for (let i = 0; i < line.length; i++) {
    const a = i >= channels ? line[i - channels] : 0
    const c = i >= channels ? prev[i - channels] : 0
    const predictors = [0, a, prev[i], (a + prev[i]) >> 1, paeth(a, prev[i], c)]
    line[i] = (line[i] + predictors[filter]) & 255
  }
}

/** Decode an 8-bit RGBA or RGB, non-interlaced PNG. Returns { width, height, data } with RGBA bytes. */
export function decodePng(buf) {
  const { width, height, channels, idat } = readChunks(buf)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const data = Buffer.alloc(width * height * 4, 255)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1)
    const line = Buffer.from(raw.subarray(start + 1, start + 1 + stride))
    unfilter(line, prev, raw[start], channels)
    for (let x = 0; x < width; x++) line.copy(data, (y * width + x) * 4, x * channels, (x + 1) * channels)
    prev = line
  }
  return { width, height, data }
}

/** Opaque bounds (alpha > BOUNDS_ALPHA) of one frame rect, in image coordinates, or null when empty. */
function frameBounds(img, f) {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  for (let i = 0; i < f.width * f.height; i++) {
    const x = f.x + (i % f.width)
    const y = f.y + Math.floor(i / f.width)
    if (img.data[(y * img.width + x) * 4 + 3] <= BOUNDS_ALPHA) continue
    b.x0 = Math.min(b.x0, x)
    b.x1 = Math.max(b.x1, x)
    b.y0 = Math.min(b.y0, y)
    b.y1 = Math.max(b.y1, y)
  }
  return b.x0 === Infinity ? null : b
}

/**
 * The shared crop window for a loop, measured from each frame's foot anchor: how far the figure reaches above,
 * below, left and right of the anchor in any frame.
 */
export function loopWindow(img, frames) {
  let up = 0
  let down = 0
  let left = 0
  let right = 0
  for (const f of frames) {
    const b = frameBounds(img, f)
    if (!b) continue
    const ax = f.x + f.footAnchor.x
    const ay = f.y + f.footAnchor.y
    up = Math.max(up, ay - b.y0)
    down = Math.max(down, b.y1 - ay)
    left = Math.max(left, ax - b.x0)
    right = Math.max(right, b.x1 - ax)
  }
  return { up: up + MARGIN_PX, down: down + MARGIN_PX, half: Math.max(left, right) + MARGIN_PX }
}

/** Length of source cell [c, c+1) inside the span starting at s0 with length `size`. */
function overlap1d(c, s0, size) {
  return Math.min(c + 1, s0 + size) - Math.max(c, s0)
}

function insideFrame(img, frame, x, y) {
  const inRect = x >= frame.x && x < frame.x + frame.width && y >= frame.y && y < frame.y + frame.height
  return inRect && x < img.width && y < img.height
}

/**
 * Average color of one output pixel (box filter over the source box, weighted by alpha so edges blend), or null
 * when less than COVERAGE_CUT of it is figure. Samples outside the frame's own rect count as transparent.
 */
function samplePixel(src, sx0, sy0, size) {
  const { img, frame } = src
  const sum = { r: 0, g: 0, b: 0, a: 0, n: 0 }
  for (let y = Math.floor(sy0); y < Math.ceil(sy0 + size); y++) {
    for (let x = Math.floor(sx0); x < Math.ceil(sx0 + size); x++) {
      const w = overlap1d(x, sx0, size) * overlap1d(y, sy0, size)
      sum.n += Math.max(w, 0)
      if (w <= 0 || !insideFrame(img, frame, x, y)) continue
      const i = (y * img.width + x) * 4
      const al = img.data[i + 3] / 255
      sum.r += img.data[i] * al * w
      sum.g += img.data[i + 1] * al * w
      sum.b += img.data[i + 2] * al * w
      sum.a += al * w
    }
  }
  if (sum.n === 0 || sum.a / sum.n < COVERAGE_CUT) return null
  return [Math.round(sum.r / sum.a), Math.round(sum.g / sum.a), Math.round(sum.b / sum.a)]
}

/** One terminal cell from its upper and lower pixel colors (null = transparent). Transparent halves carry no color codes. */
function cellText(upper, lower) {
  if (upper && lower) return `[38;2;${upper.join(';')};48;2;${lower.join(';')}m▀[0m`
  if (upper) return `[38;2;${upper.join(';')}m▀[0m`
  if (lower) return `[38;2;${lower.join(';')}m▄[0m`
  return ' '
}

/**
 * Render one frame to `grid.rows` terminal rows of `grid.cols` cells. `grid.scale` is source pixels per output pixel;
 * the foot anchor maps to output pixel row `grid.footPixel` in every frame.
 */
export function renderFrame(img, frame, grid) {
  const { scale, rows, cols, footPixel } = grid
  const left = frame.x + frame.footAnchor.x - (cols * scale) / 2
  const top = frame.y + frame.footAnchor.y - footPixel * scale
  const src = { img, frame }
  const out = []
  for (let row = 0; row < rows; row++) {
    let line = ''
    for (let col = 0; col < cols; col++) {
      const upper = samplePixel(src, left + col * scale, top + row * 2 * scale, scale)
      const lower = samplePixel(src, left + col * scale, top + (row * 2 + 1) * scale, scale)
      line += cellText(upper, lower)
    }
    out.push(line)
  }
  return out
}

/** Render one loop of an atlas at one size: { rows, cols, footRow, frames: [{ name, rows }] }. */
export function renderLoop(img, action, rows, win = loopWindow(img, action.frames)) {
  // Source pixels per output pixel so the loop window (above plus below the foot) fits; one pixel spare under the boots.
  const scale = (win.up + win.down) / (rows * 2 - 1)
  const footPixel = Math.round(win.up / scale)
  const cols = Math.ceil((win.half * 2) / scale)
  const frames = action.frames.map((f) => ({ name: f.name, rows: renderFrame(img, f, { scale, rows, cols, footPixel }) }))
  return { rows, cols, footRow: Math.floor(footPixel / 2), frames }
}

/** Build the whole frames document from an atlas object and a loader for its PNG files. */
export function buildFrames(atlas, loadImage, loops = LOOPS, sizes = SIZES) {
  const doc = { schemaVersion: 1, generatedBy: 'scripts/mascotFrames.mjs', loops: {} }
  // Idle and run share a camera: the startled pose must not suddenly shrink the hood or move the boot baseline.
  const opening = loops.filter((name) => name === 'idle' || name === 'run').map((name) => {
    const action = atlas.actions[name]
    return loopWindow(loadImage(action.image), action.frames)
  })
  const openingWindow = opening.length === 0 ? undefined : {
    up: Math.max(...opening.map((window) => window.up)),
    down: Math.max(...opening.map((window) => window.down)),
    half: Math.max(...opening.map((window) => window.half))
  }
  for (const name of loops) {
    const action = atlas.actions[name]
    const img = loadImage(action.image)
    doc.loops[name] = { fps: action.fps, sizes: {} }
    const window = name === 'idle' || name === 'run' ? openingWindow : undefined
    for (const [size, rows] of Object.entries(sizes)) doc.loops[name].sizes[size] = renderLoop(img, action, rows, window)
  }
  return doc
}

function main() {
  const atlas = JSON.parse(readFileSync(join(ATLAS_DIR, 'atlas.json'), 'utf8'))
  const doc = buildFrames(atlas, (file) => decodePng(readFileSync(join(ATLAS_DIR, file))))
  mkdirSync(dirname(OUT_FILE), { recursive: true })
  writeFileSync(OUT_FILE, JSON.stringify(doc) + '\n')
  for (const [loop, l] of Object.entries(doc.loops)) {
    for (const [size, s] of Object.entries(l.sizes)) {
      console.log(`${loop}/${size}: ${s.frames.length} frames, ${s.rows} rows x ${s.cols} cols, foot row ${s.footRow}`)
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1])) main()
