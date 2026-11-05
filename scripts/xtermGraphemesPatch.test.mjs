import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { patchXtermGraphemes } from './xtermGraphemesPatch.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ADDON_LIB = join(ROOT, 'node_modules', '@xterm', 'addon-unicode-graphemes', 'lib')

/** The two minified forms 0.4.0 ships, cut down to the trie's constructor. */
const BROKEN_CJS = 't.default=class{constructor(e){const t=new DataView(e.buffer);this.highStart=t.getUint32(0,!0)}}'
const BROKEN_ESM = 'Ne=class{constructor(e){let t=new DataView(e.buffer);this.highStart=t.getUint32(0,!0)}}'

const scratch = []

/** A node_modules folder holding the addon's two builds with the given contents. */
function fakeInstall(cjs, esm) {
  const root = mkdtempSync(join(tmpdir(), 'xterm-graphemes-'))
  scratch.push(root)
  const lib = join(root, 'node_modules', '@xterm', 'addon-unicode-graphemes', 'lib')
  mkdirSync(lib, { recursive: true })
  writeFileSync(join(lib, 'addon-unicode-graphemes.js'), cjs)
  writeFileSync(join(lib, 'addon-unicode-graphemes.mjs'), esm)
  return { root, lib }
}

function read(lib, name) {
  return readFileSync(join(lib, name), 'utf8')
}

afterEach(() => {
  for (const root of scratch.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('patchXtermGraphemes', () => {
  it('makes both builds read the data from its own byte offset, and reports them', () => {
    const { root, lib } = fakeInstall(BROKEN_CJS, BROKEN_ESM)
    expect(patchXtermGraphemes({ root })).toEqual([
      join(lib, 'addon-unicode-graphemes.js'),
      join(lib, 'addon-unicode-graphemes.mjs')
    ])
    expect(read(lib, 'addon-unicode-graphemes.js')).toBe(
      't.default=class{constructor(e){const t=new DataView(e.buffer,e.byteOffset,e.byteLength);this.highStart=t.getUint32(0,!0)}}'
    )
    expect(read(lib, 'addon-unicode-graphemes.mjs')).toBe(
      'Ne=class{constructor(e){let t=new DataView(e.buffer,e.byteOffset,e.byteLength);this.highStart=t.getUint32(0,!0)}}'
    )
  })

  it('leaves patched or upstream-fixed builds as they are, so it can run on every install', () => {
    const fixed = 'class{constructor(n){const t=new DataView(n.buffer,n.byteOffset,n.byteLength)}}'
    const { root, lib } = fakeInstall(fixed, fixed)
    expect(patchXtermGraphemes({ root })).toEqual([])
    expect(read(lib, 'addon-unicode-graphemes.js')).toBe(fixed)
    expect(read(lib, 'addon-unicode-graphemes.mjs')).toBe(fixed)
  })

  it('does nothing when the addon is not installed', () => {
    const root = mkdtempSync(join(tmpdir(), 'xterm-graphemes-'))
    scratch.push(root)
    expect(patchXtermGraphemes({ root })).toEqual([])
  })
})

/**
 * Loads one build of the installed addon in a fresh Node with every base64 `Buffer.from` landing at byte 300 of a
 * larger pool, as it does in the packed app (DM-405), and prints the width the addon gives a family emoji (one
 * grapheme, two cells; five without the addon's data).
 */
const LOAD_AT_OFFSET = `
const [addonUrl, headlessUrl] = process.argv.slice(1)
const from = Buffer.from
Buffer.from = function (value, encoding, ...rest) {
  const decoded = from.call(Buffer, value, encoding, ...rest)
  if (encoding !== 'base64') return decoded
  const pool = Buffer.alloc(decoded.length + 600)
  decoded.copy(pool, 300)
  return pool.subarray(300, 300 + decoded.length)
}
const { UnicodeGraphemesAddon } = await import(addonUrl)
const { Terminal } = (await import(headlessUrl)).default
const terminal = new Terminal({ cols: 20, rows: 2, allowProposedApi: true })
terminal.loadAddon(new UnicodeGraphemesAddon())
terminal.write('\\u{1F468}\\u200D\\u{1F469}\\u200D\\u{1F467}', () => {
  process.stdout.write(terminal.unicode.activeVersion + ' ' + terminal.buffer.active.cursorX)
  terminal.dispose()
})
`

function loadAtOffset(file) {
  const headless = join(ROOT, 'node_modules', '@xterm', 'headless', 'lib-headless', 'xterm-headless.js')
  return execFileSync(
    process.execPath,
    ['--input-type=module', '-e', LOAD_AT_OFFSET, pathToFileURL(join(ADDON_LIB, file)).href, pathToFileURL(headless).href],
    { encoding: 'utf8' }
  )
}

describe("this checkout's @xterm/addon-unicode-graphemes (patched by postinstall)", () => {
  // Main loads the CommonJS build (`terminalScreen.ts`), the renderer's bundle the ES module (`xtermKit.ts`).
  it.each(['addon-unicode-graphemes.js', 'addon-unicode-graphemes.mjs'])(
    '%s loads with its data at a nonzero byte offset and keeps grapheme widths',
    (file) => {
      expect(loadAtOffset(file)).toBe('15-graphemes 2')
    }
  )
})
