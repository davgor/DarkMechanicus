/** Acquire electron-builder's checksum-pinned compiler before Windows native installer tests. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { getMakeNsisPath } from 'app-builder-lib/out/toolsets/windows.js'

/** Where the native installer tests read the provisioned compiler from. */
export const TOOLCHAIN_METADATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'out', 'installer-test-toolchain.json')

/** Download (or reuse electron-builder's cached) pinned NSIS and record it in `out/installer-test-toolchain.json`. */
export async function prepareInstallerToolchain() {
  const compiler = await getMakeNsisPath()
  mkdirSync(dirname(TOOLCHAIN_METADATA), { recursive: true })
  writeFileSync(TOOLCHAIN_METADATA, JSON.stringify(compiler))
  return compiler
}

if (process.platform === 'win32' && typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const compiler = await prepareInstallerToolchain()
  console.info('Prepared checksum-pinned NSIS compiler:', compiler.path)
}
