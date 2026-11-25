/**
 * Sanitized Electron profiler. Run from a clean worktree after `npm run build`:
 *   node --import tsx scripts/spike/forge-performance.ts probe /path/to/probe.jsonl
 *   node --import tsx scripts/spike/forge-performance.ts matrix /path/to/matrix.jsonl
 *   node --import tsx scripts/spike/forge-performance.ts revamp /path/to/revamp.jsonl [/path/to/real/project]
 *
 * Only generated projects, temporary copies and a private Electron profile are opened. In revamp mode an optional real
 * project is never opened in place: its tracked `.darkmechanicus` files (without `local/`) are copied and its database
 * is snapshotted read-only (`VACUUM INTO`) into the temporary fixture, and only that copy is tracked.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildSync } from 'esbuild'
import { seedProject, withFixture } from './forge-performance-fixture'
import type { ProfileRun } from './forge-performance-main'

const MODES = ['probe', 'matrix', 'production', 'revamp'] as const
const mode = process.argv[2] as ProfileRun['mode']
const output = process.argv[3]
const realSource = mode === 'revamp' ? process.argv[4] : undefined
const expectedArgs = realSource === undefined ? 4 : 5
if (!MODES.includes(mode) || !output || process.argv.length !== expectedArgs || existsSync(output)) {
  throw new Error('Expected probe|matrix|production|revamp, the path of a new JSONL evidence file and (revamp only) an optional project to copy.')
}
const builtApp = resolve('out/main/index.js')
const cliEntry = resolve('out/main/cli.js')
for (const path of [builtApp, cliEntry, resolve('out/renderer/index.html')]) {
  if (!existsSync(path)) throw new Error(`Run npm run build first. Missing ${path}`)
}

/** Copies a real project's tracked records and a read-only snapshot of its database into `target`; returns the copy. */
function copyRealStore(source: string, target: string): string {
  const dmDir = join(source, '.darkmechanicus')
  const database = join(dmDir, 'local', 'state.sqlite')
  if (!existsSync(join(dmDir, 'project.json')) || !existsSync(database)) throw new Error(`${source} is not a repository-mode project.`)
  mkdirSync(target)
  cpSync(dmDir, join(target, '.darkmechanicus'), { recursive: true, filter: (path) => !path.startsWith(join(dmDir, 'local') + sep) && path !== join(dmDir, 'local') })
  mkdirSync(join(target, '.darkmechanicus', 'local'))
  const snapshot = new DatabaseSync(database, { readOnly: true })
  try {
    snapshot.exec(`VACUUM INTO '${join(target, '.darkmechanicus', 'local', 'state.sqlite').replaceAll("'", "''")}'`)
  } finally {
    snapshot.close()
  }
  execFileSync('git', ['-C', target, 'init', '-q', '-b', 'main'])
  return target
}

const resultPath = resolve(output)
const repoRevision = execFileSync('git', ['-C', process.cwd(), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version
const electron = createRequire(import.meta.url)('electron') as string
/** Bundles the Electron main and utility entries into `root`; in revamp mode also returns the renderer helpers' IIFE. */
function bundleEntries(root: string): string | undefined {
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
  if (mode !== 'revamp') return undefined
  return buildSync({ entryPoints: [resolve('scripts/spike/forge-performance-renderer.ts')], bundle: true, format: 'iife', platform: 'browser', write: false })
    .outputFiles[0]?.text
}

/** Runs Electron as Electron (never as Node, whatever the calling shell sets) on the profiler package in `root`. */
function runProfiler(root: string, configFile: string, userData: string, result: string): void {
  // The project utilities' sync lanes (DM-963) append their write-lock holds and reconcile reads here; see `laneSince`.
  const env = { ...process.env, DM_LANE_OBSERVE_FILE: join(root, 'lane.jsonl') }
  delete env['ELECTRON_RUN_AS_NODE']
  const child = spawnSync(electron, [root, configFile], {
    env, timeout: mode === 'revamp' ? 3_700_000 : 180_000, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
  })
  if (existsSync(result)) copyFileSync(result, resultPath)
  if (child.status !== 0 || !existsSync(join(userData, 'profiler.finished'))) {
    throw new Error(`Electron profiler failed (exit ${child.status}): ${child.error ?? child.stderr}`)
  }
}

const smoke = mode === 'revamp' && process.env['DM_REVAMP_SMOKE'] === '1'
const SIZES: Record<ProfileRun['mode'], number[]> = { probe: [10], production: [10_000], matrix: [100, 1000, 10_000], revamp: smoke ? [100] : [100, 1000, 10_000] }

withFixture((root) => {
  const userData = join(root, 'electron-profile')
  const home = join(root, 'profile-home')
  mkdirSync(userData)
  mkdirSync(home)
  const small = seedProject(join(root, 'unrelated-small'), 5)
  const projects = SIZES[mode].map((count) => seedProject(join(root, `tickets-${count}`), count))
  const realStore = realSource === undefined ? undefined : copyRealStore(resolve(realSource), join(root, 'DarkMechanicus'))
  writeFileSync(join(userData, 'folders.json'), JSON.stringify({
    version: 1, folders: [{ path: small.root, addedAt: '2026-01-01T00:00:00.000Z' }]
  }))
  const rendererBundle = bundleEntries(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'dm-forge-profiler', version, main: 'main.cjs' }))
  const result = join(root, 'result.jsonl')
  const config: ProfileRun = {
    userData, home, builtApp, ownerEntry: join(root, 'owner.cjs'), cliEntry, systemNode: process.execPath,
    repoRevision, result, mode, projects, small, rendererBundle, realStore
  }
  const configFile = join(root, 'config.json')
  writeFileSync(configFile, JSON.stringify(config))
  runProfiler(root, configFile, userData, result)
})
console.log(`Saved ${mode} evidence to ${resultPath}`)
