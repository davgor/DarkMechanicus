/** Acquire electron-builder's checksum-pinned compiler before Windows native installer tests. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { getMakeNsisPath } from 'app-builder-lib/out/toolsets/windows.js'

if (process.platform === 'win32') {
  const output = join(dirname(fileURLToPath(import.meta.url)), '..', 'out')
  const compiler = await getMakeNsisPath()
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, 'installer-test-toolchain.json'), JSON.stringify(compiler))
  console.info('Prepared checksum-pinned NSIS compiler:', compiler.path)
}
