import { buildSync } from 'esbuild'
import { describe, expect, it } from 'vitest'

/**
 * Modules that tests and plain Node scripts load must not import Electron, even through the app logger: outside the
 * app, requiring the `electron` package runs its installer, which downloads the binary when it is missing (as on CI,
 * which skips install scripts). The main process passes its logger in instead.
 */
const SHARED_ENTRIES = [
  // The Magos gate and its runner, through the wiring that composes them.
  'src/main/agentChat/agentChatWiring.ts',
  // The stores the e2e seed, the smoke scripts and the sync-lane probe bundle (they reach forgeManifest).
  'src/main/desktop/folderRegistry.ts',
  'src/main/agents/chatStore.ts'
]

describe('modules loaded outside the Electron main process', () => {
  it('reach neither electron, electron-log nor the app logger', () => {
    const { metafile } = buildSync({
      absWorkingDir: process.cwd(), entryPoints: SHARED_ENTRIES, bundle: true, write: false, outdir: 'out/electron-free',
      metafile: true, platform: 'node', format: 'esm', packages: 'external', loader: { '.md': 'text' }, logLevel: 'silent'
    })
    const inputs = Object.keys(metafile.inputs)
    const electron = Object.entries(metafile.inputs).flatMap(([file, input]) =>
      input.imports.filter(item => /^electron($|\/)|^electron-log($|\/)/.test(item.path)).map(item => `${file} -> ${item.path}`))
    expect(electron).toEqual([])
    expect(inputs).not.toContain('src/main/logger.ts')
    expect(inputs).toEqual(expect.arrayContaining([
      'src/main/agentChat/promptArbitration.ts', 'src/main/magos/arbiterRunner.ts', 'src/main/desktop/forgeManifest.ts'
    ]))
  })
})
