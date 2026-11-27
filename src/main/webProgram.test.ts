import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * `npm run deadcode` runs ts-prune once over tsconfig.node.json and once over tsconfig.web.json. A renderer or shared
 * module (a test included) that imports a main or core module, even only for a type, pulls that module and everything it
 * imports into the web program, where their real importers do not exist, so ts-prune reports their live exports as
 * unused and the gate fails or flips its findings. Tests that need main modules and renderer code together live in
 * src/integration-ui, which neither deadcode program includes.
 *
 * The modules outside src/renderer and src/shared that the web program legitimately reaches. Adding one is a decision:
 * run `npm run deadcode` and confirm its findings are unchanged before listing it here.
 */
const NON_WEB_MODULES = [
  'resources/skitarii/extension/controlLimits.ts',
  'src/core/canonical.ts',
  'src/core/claimTokenMask.ts',
  'src/core/definitionOfDone.ts',
  'src/core/plan/acceptance.ts',
  'src/core/plan/criterionWording.ts',
  'src/core/plan/graph.ts',
  'src/core/plan/repoTitles.ts',
  'src/core/transfer/linearPacket.ts',
  'src/preload/index.ts',
  'src/preload/terminals.ts',
  'src/test/markdownSections.ts'
]

/** Files the web program reaches from `roots` (default: its own include) through imports, type-only ones included. */
function webProgramFiles(roots?: string[]): string[] {
  const config = ts.getParsedCommandLineOfConfigFile('tsconfig.web.json', {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined })
  if (!config) throw new Error('tsconfig.web.json could not be read')
  const cache = ts.createModuleResolutionCache(process.cwd(), (file) => file, config.options)
  const reached = new Set((roots ?? config.fileNames).map((file) => resolve(file)))
  for (const file of reached) {
    for (const { fileName } of ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles) {
      const resolved = ts.resolveModuleName(fileName, file, config.options, ts.sys, cache).resolvedModule
      if (resolved && !resolved.isExternalLibraryImport) reached.add(resolve(resolved.resolvedFileName))
    }
  }
  return [...reached].map((file) => relative(process.cwd(), file).replaceAll('\\', '/'))
}

describe('the tsconfig.web.json program deadcode scans', () => {
  it('reaches renderer code and, outside it, only the listed modules', () => {
    const files = webProgramFiles()
    expect(files).toContain('src/renderer/src/App.tsx')
    expect(files.filter((file) => !/^src\/(renderer|shared)\//.test(file)).sort()).toEqual(NON_WEB_MODULES)
  })

  it('follows a test file\'s imports into main modules, as the integration-ui tests make them', () => {
    expect(webProgramFiles(['src/integration-ui/agentChatSessions.test.ts'])).toContain('src/main/agentChat/agentChatSessions.ts')
  })
})
