/**
 * Makes `@xterm/addon-unicode-graphemes` read its built-in data from the data's own bytes.
 *
 * 0.4.0 decodes its grapheme tables with `Buffer.from(base64)` under Node and reads them through
 * `new DataView(e.buffer)`, which ignores the Buffer's `byteOffset`. A Buffer that small comes from Node's shared
 * pool, so whenever it does not start at byte 0 the addon reads the wrong bytes, and a length it reads there makes
 * `new Uint8Array` throw "Array buffer allocation failed" while the module loads. Main imports the addon
 * (`terminalScreen.ts`), and in the packed app the pool is never fresh at that point, so the app died at start
 * (DM-405). Upstream fixed it after 0.4.0 (0.5.0 betas pass `byteOffset` and `byteLength`), but no stable release
 * carries the fix, so this runs from the repository's `postinstall` and rewrites the call in both builds. A build
 * already reading from its offset is left alone. `scripts/xtermGraphemesPatch.test.mjs` loads the installed addon
 * with its data at a nonzero offset, so an install that skipped this fails the tests.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUILDS = ['addon-unicode-graphemes.js', 'addon-unicode-graphemes.mjs']
/** `new DataView(x.buffer)`: a view of the whole pool rather than of `x`. */
const WHOLE_BUFFER_VIEW = /new DataView\((\w+)\.buffer\)/g

/**
 * Rewrites every `new DataView(x.buffer)` in the addon's builds under `root` to
 * `new DataView(x.buffer,x.byteOffset,x.byteLength)`. Returns the files it changed: none when the addon is not
 * installed or is already fixed.
 */
export function patchXtermGraphemes({ root = ROOT } = {}) {
  const lib = join(root, 'node_modules', '@xterm', 'addon-unicode-graphemes', 'lib')
  const changed = []
  for (const build of BUILDS) {
    const file = join(lib, build)
    if (!existsSync(file)) {
      continue
    }
    const source = readFileSync(file, 'utf8')
    const patched = source.replace(WHOLE_BUFFER_VIEW, 'new DataView($1.buffer,$1.byteOffset,$1.byteLength)')
    if (patched !== source) {
      writeFileSync(file, patched)
      changed.push(file)
    }
  }
  return changed
}

if (typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href) {
  patchXtermGraphemes()
}
