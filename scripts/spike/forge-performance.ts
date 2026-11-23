/**
 * Sanitized Electron profiler. Run from a clean worktree after `npm run build`:
 *   node --import tsx scripts/spike/forge-performance.ts probe /path/to/probe.jsonl
 *   node --import tsx scripts/spike/forge-performance.ts matrix /path/to/matrix.jsonl
 *
 * Only the generated projects and a private Electron profile are opened. No real project directory is accepted.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { buildSync } from 'esbuild'
import { seedProject, withFixture } from './forge-performance-fixture'
import type { ProfileRun } from './forge-performance-main'

const mode = process.argv[2]
const output = process.argv[3]
if ((mode !== 'probe' && mode !== 'matrix' && mode !== 'production') || !output || process.argv.length !== 4 || existsSync(output)) {
  throw new Error('Expected probe|matrix|production and the path of a new JSONL evidence file.')
}
const builtApp = resolve('out/main/index.js')
const cliEntry = resolve('out/main/cli.js')
for (const path of [builtApp, cliEntry, resolve('out/renderer/index.html')]) {
  if (!existsSync(path)) throw new Error(`Run npm run build first. Missing ${path}`)
}

const resultPath = resolve(output)
const repoRevision = execFileSync('git', ['-C', process.cwd(), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version
const electron = createRequire(import.meta.url)('electron') as string
withFixture((root) => {
  const userData = join(root, 'electron-profile')
  const home = join(root, 'profile-home')
  mkdirSync(userData)
  mkdirSync(home)
  const small = seedProject(join(root, 'unrelated-small'), 5)
  const sizes = mode === 'probe' ? [10] : mode === 'production' ? [10_000] : [100, 1000, 10_000]
  const projects = sizes.map((count) => seedProject(join(root, `tickets-${count}`), count))
  writeFileSync(join(userData, 'folders.json'), JSON.stringify({
    version: 1, folders: [{ path: small.root, addedAt: '2026-01-01T00:00:00.000Z' }]
  }))
  for (const role of ['main', 'owner']) {
    buildSync({
      entryPoints: [resolve(`scripts/spike/forge-performance-${role}.ts`)],
      outfile: join(root, `${role}.cjs`),
      bundle: true,
      format: 'cjs',
      platform: 'node',
      external: ['electron']
    })
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'dm-forge-profiler', version, main: 'main.cjs' }))
  const result = join(root, 'result.jsonl')
  const config: ProfileRun = {
    userData, home, builtApp, ownerEntry: join(root, 'owner.cjs'), cliEntry, systemNode: process.execPath,
    repoRevision, result, mode, projects, small
  }
  const configFile = join(root, 'config.json')
  writeFileSync(configFile, JSON.stringify(config))
  const child = spawnSync(electron, [root, configFile], { timeout: 180_000, windowsHide: true, encoding: 'utf8' })
  if (existsSync(result)) copyFileSync(result, resultPath)
  if (child.status !== 0 || !existsSync(join(userData, 'profiler.finished'))) {
    throw new Error(`Electron profiler failed (exit ${child.status}): ${child.error ?? child.stderr}`)
  }
})
console.log(`Saved ${mode} evidence to ${resultPath}`)
