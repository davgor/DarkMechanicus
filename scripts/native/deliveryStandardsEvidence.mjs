/** Run after npm run build. Drive the production desktop with disposable projects. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { openWorkspace } from '../../src/core/workspace.ts'
import { createFolderRegistry } from '../../src/main/desktop/folderRegistry.ts'

const require = createRequire(import.meta.url)
const root = mkdtempSync(join(tmpdir(), 'dm-standards-'))
const output = resolve(process.argv[2] ?? 'out/standards-evidence')
const userData = join(root, 'desktop')
const homeDir = join(root, 'tickets')
const registry = createFolderRegistry({ file: join(userData, 'folders.json'), homeDir: root, dmHome: homeDir })
mkdirSync(output, { recursive: true })
for (const [name, mode] of [['Mars', 'db'], ['Ryza', 'repo']]) {
  const repoRoot = join(root, name)
  mkdirSync(repoRoot)
  const workspace = openWorkspace({ repoRoot, homeDir, role: 'desktop', transport: 'desktop', label: 'Screenshot fixture' })
  try {
    await workspace.initializeRepository({ name, mode })
    registry.track(repoRoot)
  } finally { workspace.close() }
}

const fixture = fileURLToPath(new URL('deliveryStandardsWindow.cjs', import.meta.url))
const env = { ...process.env, DARKMECHANICUS_HOME: homeDir }
delete env.ELECTRON_RUN_AS_NODE
delete env.DM_SESSION_TOKEN
delete env.DM_DESKTOP_PIPE
const child = spawnSync(require('electron'), [fixture, root, output, process.cwd()], {
  env, stdio: 'inherit', windowsHide: true, timeout: 60_000
})
if (child.error) throw child.error
assert.equal(child.status, 0, 'Desktop verification failed')
for (const name of ['01-project-setup', '02-saved-revision', '03-standardize-confirmation']) {
  assert.equal(readFileSync(join(output, name + '.png')).readUInt32BE(0), 0x89504e47)
}
