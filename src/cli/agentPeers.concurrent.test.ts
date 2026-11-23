import { build } from 'esbuild'
import { existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createDmClient, DM_CLIENT_DESCRIPTOR_ENV, nodeDmClientDeps } from '../../resources/skitarii/extension/dmClient'
import { writeDmClientDescriptor } from '../main/terminals/terminalFiles'
import { bindAgentMailEndpoint, provisionAgentMailEndpoint, sendAgentMessage } from '../core/services/agentMail'
import { openDatabase, type Db, type SqlValue } from '../core/db/database'
import { createHarness, type Harness } from '../test/workspaceHarness'
import { openWorkspace, type Workspace } from '../core/workspace'
import { runCli } from './main'
import { COMMANDS } from '../core/commands'
import { createStagedAttachment, getAttachment } from '../core/services/attachments'
import { pngBytes } from '../test/images'
import { projectKey } from '../core/repo/storageMode'
import { dropAcceptanceNodes } from '../test/acceptanceNodes'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
let harness: Harness
let desktop: Workspace
let writer: Db | undefined

const readers: Workspace[] = []

beforeEach(() => {
  harness = createHarness()
  harness.clock.set(new Date().toISOString())
  desktop = harness.open('desktop')
})

afterEach(() => {
  for (const reader of readers.splice(0)) reader.close()
  writer?.close()
  writer = undefined
  harness.cleanup()
})

async function fixture(mode: 'repo' | 'db' = 'repo') {
  await desktop.initializeRepository({ name: 'Peer discovery', mode })
  const { grant, token } = await desktop.issueGrant({ role: 'orchestrator', label: 'Peer caller' })
  const endpoint = provisionAgentMailEndpoint(desktop.ctx(), { chatId: 'peer-caller', name: 'Caller' })
  bindAgentMailEndpoint(desktop.ctx(), { endpointId: endpoint.id, grantId: grant.id })
  const peers = Array.from({ length: 51 }, (_, index) => {
    const peer = provisionAgentMailEndpoint(desktop.ctx(), { chatId: `peer-${index}`, name: `Peer ${index}` })
    return { endpointId: peer.id, name: peer.name }
  }).sort((a, b) => a.endpointId.localeCompare(b.endpointId))
  const cli = join(harness.homeDir, 'cli.js')
  await build({
    entryPoints: [join(ROOT, 'src/cli/main.ts')], outfile: cli,
    bundle: true, platform: 'node', format: 'cjs', packages: 'external',
    loader: { '.md': 'text' }, logLevel: 'warning',
    plugins: [{
      name: 'shipped-knowledge',
      setup(builder) {
        builder.onLoad({ filter: /[/\\]knowledge[/\\]builtin\.ts$/ }, ({ path }) => ({
          contents: readFileSync(path, 'utf8').replace(
            "import.meta.glob<string>('../../../skills/knowledge/**/*.md', { query: '?raw', import: 'default', eager: true })",
            JSON.stringify(Object.fromEntries(globSync('skills/knowledge/**/*.md', { cwd: ROOT }).map((file) => [`../../../${file.replaceAll('\\', '/')}`, readFileSync(join(ROOT, file), 'utf8')])))
          ),
          loader: 'ts'
        }))
      }
    }],
    banner: { js: `require = require('node:module').createRequire(${JSON.stringify(join(ROOT, 'package.json'))});` }
  })
  const descriptor = await writeDmClientDescriptor({
    userData: harness.homeDir, chatId: 'ch_peer_caller', generation: 'peer-test-generation', folder: harness.root,
    cli: { command: process.execPath, args: [cli, '--repo', harness.root], env: { ELECTRON_RUN_AS_NODE: '1', DM_SESSION_TOKEN: token, DARKMECHANICUS_HOME: harness.homeDir } },
    platform: process.platform
  })
  const client = createDmClient({ ...nodeDmClientDeps(), env: { ...process.env, [DM_CLIENT_DESCRIPTOR_ENV]: descriptor, DM_SESSION_TOKEN: token } })
  return { client, grant, token, peers }
}

it.each(['repo', 'db'] as const)('returns native peer pages while an unrelated %s writer holds the SQLite lock', async (mode) => {
  const { client, peers } = await fixture(mode)
  const sessions = desktop.ctx().db.all('SELECT * FROM sessions ORDER BY id')
  const grants = desktop.ctx().db.all('SELECT * FROM grants ORDER BY id')
  const probe = writer = openDatabase(desktop.ctx().db.path, { busyTimeoutMs: 0, beginRetries: 0, synchronous: 'off' })
  probe.exec('BEGIN IMMEDIATE')
  try {
    probe.run('UPDATE agent_mail_endpoints SET name = ? WHERE id = ?', 'Not committed', peers[0]!.endpointId)
    expect(await client.call('peers', { afterId: '0', limit: 50 })).toMatchObject({ ok: false, error: { source: 'dm', code: 'invalid_input' } })
    const first = await client.call('peers', { limit: 50 })
    expect(first).toEqual({ ok: true, data: { peers: peers.slice(0, 50), nextAfterId: peers[49]!.endpointId, hasMore: true } })
    expect(await client.call('peers', { afterId: peers[49]!.endpointId, limit: 50 })).toEqual({
      ok: true, data: { peers: peers.slice(50), nextAfterId: peers[50]!.endpointId, hasMore: false }
    })
    expect(await client.call('peers', { limit: 51 })).toMatchObject({ ok: false, error: { source: 'dm', code: 'invalid_input' } })
    expect(desktop.ctx().db.all('SELECT * FROM sessions ORDER BY id')).toEqual(sessions)
    expect(desktop.ctx().db.all('SELECT * FROM grants ORDER BY id')).toEqual(grants)
  } finally {
    probe.exec('ROLLBACK')
    await client.cancelAll()
  }
})

it.each(['revoked', 'expired', 'closed binding', 'suspended endpoint', 'wrong folder', 'unbound'] as const)(
  'refuses native peer discovery with a %s grant or mailbox while another writer is active', async (state) => {
    const { client, grant } = await fixture()
    const db = desktop.ctx().db
    if (state === 'revoked') await desktop.revokeGrant({ grantId: grant.id })
    if (state === 'expired') db.run('UPDATE grants SET expires_at = ? WHERE id = ?', '2000-01-01T00:00:00.000Z', grant.id)
    if (state === 'closed binding') db.run("UPDATE agent_mail_bindings SET closed_at = ?, close_reason = 'grant_ended' WHERE grant_id = ?", new Date().toISOString(), grant.id)
    if (state === 'suspended endpoint') db.run("UPDATE agent_mail_endpoints SET state = 'suspended' WHERE id = (SELECT endpoint_id FROM agent_mail_bindings WHERE grant_id = ?)", grant.id)
    if (state === 'wrong folder') db.run('UPDATE agent_mail_bindings SET canonical_folder = ? WHERE grant_id = ?', harness.homeDir, grant.id)
    if (state === 'unbound') db.run('DELETE FROM agent_mail_bindings WHERE grant_id = ?', grant.id)
    const probe = writer = openDatabase(db.path, { busyTimeoutMs: 0, beginRetries: 0, synchronous: 'off' })
    probe.exec('BEGIN IMMEDIATE')
    try {
      expect(await client.call('peers', { limit: 50 })).toMatchObject({ ok: false, error: { source: 'dm', code: 'unauthorized' } })
    } finally {
      probe.exec('ROLLBACK')
      await client.cancelAll()
    }
  }
)

it('selects the read-only CLI path for both peer command spellings without changing ordinary commands', async () => {
  const { token } = await fixture()
  for (const command of ['list_agent_peers', 'listAgentPeers', 'get_project']) {
    let output = ''
    let exitCode: number | undefined
    await runCli({
      argv: ['--repo', harness.root, 'call', command, '{}'], env: { DM_SESSION_TOKEN: token }, cwd: harness.root,
      execPath: process.execPath, cliPath: join(harness.homeDir, 'cli.js'),
      open: (options) => openWorkspace({ ...options, homeDir: harness.homeDir, clock: harness.clock, git: harness.git, databaseSynchronous: 'off' }),
      readFile: (path) => readFileSync(path, 'utf8'), readStdin: () => '{}',
      writeStdout: (text) => { output += text }, writeStderr: () => {}, exit: (code) => { exitCode = code }
    })
    expect(exitCode, output).toBe(0)
    expect(JSON.parse(output)).toMatchObject({ ok: true })
  }
})

function peerReader(token: string): Workspace {
  const reader = openWorkspace({
    repoRoot: harness.root, homeDir: harness.homeDir, role: 'desktop', transport: 'cli', label: 'Ephemeral peer reader',
    grantToken: token, mailRead: true, clock: harness.clock, databaseSynchronous: 'off', git: harness.git
  })
  readers.push(reader)
  return reader
}

it('restricts ephemeral peer readers even when constructed with a privileged role', async () => {
  const { token, peers } = await fixture()
  const reader = peerReader(token)
  expect(reader.sessionId()).toBeNull()
  expect((await reader.listAgentPeers({ limit: 1 })).peers).toEqual(peers.slice(0, 1))
  for (const name of Object.keys(COMMANDS) as (keyof typeof COMMANDS)[]) {
    if (name !== 'listAgentPeers') await expect(reader.execute(name, {})).rejects.toMatchObject({ code: 'unauthorized' })
  }
  expect(() => reader.heartbeat()).toThrow(/no heartbeat/)
  expect(() => sendAgentMessage(reader.ctx(), { to: peers[0]!.endpointId, body: 'Not permitted', clientMessageId: 'no-write' })).toThrow(/only list agent peers/)
  expect(() => reader.ctx().db.run('UPDATE grants SET label = ?', 'Not permitted')).toThrow(/readonly/)
  const readerGrant = await desktop.issueGrant({ role: 'reader', label: 'No mailbox authority' })
  await expect(peerReader(readerGrant.token).listAgentPeers({})).rejects.toMatchObject({ code: 'unauthorized' })
  expect(() => openWorkspace({
    repoRoot: harness.root, homeDir: harness.homeDir, role: 'orchestrator', transport: 'stdio', label: 'Not CLI',
    grantToken: token, mailRead: true
  })).toThrow(/Restricted mailbox access/)
})

it('pins grant authority and the peer page to one snapshot, and observes revocation on the next call', async () => {
  const { token, grant, peers } = await fixture()
  const reader = peerReader(token)
  const ctx = reader.ctx()
  const db = ctx.db
  const probe = writer = openDatabase(db.path, { busyTimeoutMs: 0, beginRetries: 0, synchronous: 'off' })
  let intervened = false
  ctx.db = {
    ...db,
    get<T>(sql: string, ...params: SqlValue[]): T | undefined {
      const row = db.get<T>(sql, ...params)
      if (!intervened && sql.startsWith('SELECT expires_at, revoked_at, machine_id FROM grants')) {
        intervened = true
        probe.tx(() => {
          probe.run('UPDATE grants SET revoked_at = ? WHERE id = ?', harness.clock.nowIso(), grant.id)
          probe.run('UPDATE agent_mail_endpoints SET name = ? WHERE id = ?', 'Changed after authorization', peers[0]!.endpointId)
        })
      }
      return row
    }
  }
  expect((await reader.listAgentPeers({ limit: 1 })).peers).toEqual(peers.slice(0, 1))
  expect(intervened).toBe(true)
  await expect(reader.listAgentPeers({ limit: 1 })).rejects.toMatchObject({ code: 'unauthorized' })
})

it('still imports portable epics into a fresh local database for ordinary readers', async () => {
  await desktop.initializeRepository({ name: 'Portable ordinary reader', mode: 'repo' })
  const epic = await desktop.createEpic({ title: 'Portable work must remain discoverable' })
  await dropAcceptanceNodes(desktop, epic.id)
  const draft = await desktop.updatePlanDraft({
    epicId: epic.id, ops: [{ op: 'add_ticket', sprint: '1', ticket: { title: 'Portable saved work' } }]
  })
  expect((await desktop.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })).status).toBe('saved')
  const clone = harness.cloneTracked()
  expect(existsSync(join(clone, '.darkmechanicus', 'local'))).toBe(false)
  const ordinary = harness.open('reader', { root: clone })
  expect((await ordinary.getEpic({ epicId: epic.id })).title).toBe('Portable work must remain discoverable')
  expect(existsSync(join(clone, '.darkmechanicus', 'local', 'state.sqlite'))).toBe(true)
})

it('still prunes expired staged images on ordinary open while retaining fresh evidence', async () => {
  await desktop.initializeRepository({ name: 'Ordinary attachment maintenance', mode: 'repo' })
  const expired = createStagedAttachment(desktop.ctx(), { bytes: pngBytes(2, 2), label: 'Expired staged evidence', purpose: 'evidence' })
  harness.clock.advanceSeconds(8 * 24 * 60 * 60)
  const fresh = createStagedAttachment(desktop.ctx(), { bytes: pngBytes(3, 3), label: 'Fresh staged evidence', purpose: 'evidence' })
  harness.open('reader')
  expect(() => getAttachment(desktop.ctx(), expired.id)).toThrow('does not exist')
  expect(getAttachment(desktop.ctx(), fresh.id)).toEqual(fresh)
})

it('still refreshes and ends ordinary sessions rather than treating them as peer readers', async () => {
  await desktop.initializeRepository({ name: 'Ordinary session lifecycle', mode: 'repo' })
  const ordinary = harness.open('orchestrator')
  const id = ordinary.sessionId()
  harness.clock.advanceSeconds(70)
  expect((await desktop.listSessions()).find((session) => session.id === id)?.active).toBe(false)
  ordinary.heartbeat()
  expect((await desktop.listSessions()).find((session) => session.id === id)).toMatchObject({
    active: true, lastSeenAt: harness.clock.nowIso()
  })
  ordinary.close()
  expect((await desktop.listSessions()).find((session) => session.id === id)?.active).toBe(false)
})

it('leaves abandoned migration staging untouched for peer reads but recovers it on an ordinary open', async () => {
  const { token, peers } = await fixture()
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true })
  if (child.status !== 0) throw new Error(`Could not obtain a terminated fixture process: ${child.stderr}`)
  const directory = join(harness.homeDir, 'projects')
  mkdirSync(directory, { recursive: true })
  const prepared = join(directory, `${projectKey(harness.root)}.switch.json.prepare-${child.stdout}-${randomUUID()}`)
  writeFileSync(prepared, 'Interrupted unpublished staging data')
  const reader = peerReader(token)
  expect((await reader.listAgentPeers({ limit: 1 })).peers).toEqual(peers.slice(0, 1))
  expect(readFileSync(prepared, 'utf8')).toBe('Interrupted unpublished staging data')
  harness.open('reader', { transport: 'cli', grantToken: token })
  expect(existsSync(prepared)).toBe(false)
})
