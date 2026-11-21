/** Run after npm run build. Drive the production desktop with disposable projects. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { openWorkspace } from '../../src/core/workspace.ts'
import { openAppDatabase } from '../../src/main/desktop/appDatabase.ts'
import { createAgentRegistry } from '../../src/main/desktop/agentRegistry.ts'
import { createChatStore } from '../../src/main/agents/chatStore.ts'
import { defaultPrompts } from '../../src/shared/domain/standardsPrompts.ts'
import { createFolderRegistry } from '../../src/main/desktop/folderRegistry.ts'

const require = createRequire(import.meta.url)
const root = mkdtempSync(join(tmpdir(), 'dm-standards-'))
const output = resolve(process.argv[2] ?? 'out/standards-evidence')
const live = process.argv[3] === '--live-skitarii'
if (live && existsSync(output) && readdirSync(output).length) throw new Error('Choose an empty output directory for live provider evidence.')
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

// CI checks the app's real persisted launch request without a provider account. This program reads
// stdin without answering, so a chat record can never be mistaken for a model-authored reply.
if (!live) {
  const db = openAppDatabase(userData)
  try {
    createAgentRegistry({ db }).addCustom({
      id: 'cu_01m7excm4q4w8k80je8vrvffej', displayName: 'Planner launch fixture',
      executablePath: process.execPath, args: ['-e', 'process.stdin.resume()']
    })
  } finally { db.close() }
}

const fixture = fileURLToPath(new URL(live ? 'deliveryStandardsLive.cjs' : 'deliveryStandardsWindow.cjs', import.meta.url))
const env = { ...process.env, DARKMECHANICUS_HOME: homeDir }
delete env.ELECTRON_RUN_AS_NODE
delete env.DM_SESSION_TOKEN
delete env.DM_DESKTOP_PIPE
const child = spawnSync(require('electron'), [fixture, root, output, process.cwd()], {
  env, stdio: 'inherit', windowsHide: true, timeout: live ? 600_000 : 60_000
})
if (child.error) throw child.error
assert.equal(child.status, 0, 'Desktop verification failed')
const captures = live ? ['01-initial-standards', '02-initial-agent', '03-revised-standards', '04-running-agent', '05-new-agent'] : ['01-project-setup', '02-saved-revision', '03-standardize-confirmation']
for (const name of captures) {
  assert.equal(readFileSync(join(output, name + '.png')).readUInt32BE(0), 0x89504e47)
}

if (!live) {
  for (const [name, revision] of [['Mars', 2], ['Ryza', 1]]) {
    const repoRoot = join(root, name)
    const workspace = openWorkspace({ repoRoot, homeDir, role: 'desktop', transport: 'desktop', label: 'Reopen saved standards' })
    try {
      const { deliveryStandards } = await workspace.getProject()
      assert.equal(deliveryStandards.revision, revision)
      assert.equal(deliveryStandards.policy.setupDecision, revision === 1 ? 'defaults' : 'edited')
      const ticket = revision === 1 ? defaultPrompts.ticket : defaultPrompts.ticket + '\nVerify the SQLite round-trip before ticket acceptance.'
      assert.deepEqual(deliveryStandards.policy.prompts, { ...defaultPrompts, ticket })
    } finally { workspace.close() }
  }
  const store = createChatStore({ root: join(userData, 'agents', 'chats') })
  const chats = store.listChats(join(root, 'Mars'))
  assert.equal(chats.length, 2)
  assert(chats.every(c => c.folder === join(root, 'Mars') && c.role === 'planner' && c.allowSave))
  assert.equal(store.listChats(join(root, 'Ryza')).length, 0)
}
