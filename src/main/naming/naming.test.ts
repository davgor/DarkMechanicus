import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runCli, type CliHost } from '../../cli/main'
import { createMcpServer } from '../../mcp/server'
import { withRig, callTool } from '../../test/mcpHarness'
import { openWorkspace, type Workspace } from '../../core/workspace'
import { createDesktopClient } from '../../core/desktop/desktopClient'
import { namingOperationSchema } from '../../shared/agents/chatNaming'
import { createFakeGit } from '../../test/workspaceHarness'
import { createTestClock, type TestClock } from '../../test/testContext'
import { memoryChatStore, connectedAgents } from '../agents/__mocks__/chatFixtures'
import { createChatGrants, type ChatGrants, type IssuedChatCli } from '../agents/chatGrants'
import { createChatRecords } from '../agents/chatRecords'
import { createControlPipe, type ControlPipe } from './controlPipe'
import { createNamingDispatcher } from './namingCommands'

let root: string
let repo: string
let workspace: Workspace
let grants: ChatGrants
let server: ControlPipe
let clock: TestClock
const store = memoryChatStore()
const records = createChatRecords({ store, agentFor: connectedAgents() })
let issued: IssuedChatCli
beforeEach(async () => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-name-')))
  repo = join(root, 'repo'); mkdirSync(repo)
  clock = createTestClock('2026-11-15T09:00:00.000Z')
  workspace = openWorkspace({ repoRoot: repo, homeDir: join(root, 'home'), role: 'desktop', label: 'test', transport: 'desktop', clock, git: createFakeGit({ branch: 'main', commit: 'b'.repeat(40), detached: false }) })
  await workspace.initializeRepository({ name: 'naming-test' })
  grants = createChatGrants({ workspaceFor: () => workspace, cliFor: () => ({ command: 'node', args: [], env: {} }), minutes: 60, log: () => {} })
  issued = await grants.issueChatCli(repo, { role: 'worker', allowSave: false, label: 'owned terminal' })
  server = await createControlPipe({ authorize: token => grants.authorizeNaming(token), dispatch: createNamingDispatcher({ store, push: () => {} }) })
})
afterEach(async () => { vi.unstubAllEnvs(); await server?.close(); grants?.dispose(); workspace?.close(); rmSync(root, { recursive: true, force: true }) })
function client(token = issued.cli.env['DM_SESSION_TOKEN']) { return createDesktopClient({ env: { DM_DESKTOP_PIPE: server.address, DM_SESSION_TOKEN: token } }) }
function bound(firstPrompt = 'Could you investigate why sign-in keeps failing after expiry and fix the refresh flow?') {
  const chat = records.createChat({ folder: repo, agent: 'codex', role: 'worker', firstPrompt })
  grants.bindChatGrant(issued.grantId, { folder: repo, chatId: chat.id, generation: 'pty-one' })
  return chat
}
it('persists selected-agent semantic naming only for the live bound first-message chat', async () => {
  const chat = bound()
  expect(await client().request({ op: 'name_chat', args: { title: 'Repair expired-session refresh' } })).toMatchObject({ ok: true, data: { applied: true } })
  expect(store.getChat(chat)).toMatchObject({ title: 'Repair expired-session refresh', titleStatus: 'generated', firstPrompt: chat.firstPrompt })
  expect(await client().request({ op: 'name_chat', args: { title: 'Later turn' } })).toMatchObject({ ok: true, data: { applied: false } })
  expect(store.getChat(chat)?.title).toBe('Repair expired-session refresh')
  if (process.platform !== 'win32') {
    expect(statSync(server.address).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(server.address)).mode & 0o777).toBe(0o700)
  }
})
it('never derives binding from historical grants and rejects foreign tokens', async () => {
  expect(await client().request({ op: 'name_chat', args: { title: 'Unauthorized title' } })).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
  bound()
  expect(await client('foreign').request({ op: 'name_chat', args: { title: 'Unauthorized title' } })).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
})
it('rechecks current DB grant capability, revocation, expiry and machine binding', async () => {
  const chat = bound()
  const ctx = workspace.ctx()
  ctx.db.run('UPDATE grants SET role = ? WHERE id = ?', 'reader', issued.grantId)
  expect(await client().request({ op: 'name_chat', args: { title: 'Wrong role' } })).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
  ctx.db.run('UPDATE grants SET role = ?, machine_id = ? WHERE id = ?', 'worker', 'other-machine', issued.grantId)
  expect(await client().request({ op: 'name_chat', args: { title: 'Wrong machine' } })).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
  ctx.db.run('UPDATE grants SET machine_id = ? WHERE id = ?', ctx.machineId, issued.grantId)
  await workspace.revokeGrant({ grantId: issued.grantId })
  expect(await client().request({ op: 'name_chat', args: { title: 'Revoked grant' } })).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
  expect(store.getChat(chat)?.titleStatus).toBe('pending')
})
it('invalidates an older exact chat generation synchronously before database revocation', async () => {
  const chat = bound()
  const previous = grants.authorizeNaming(issued.cli.env['DM_SESSION_TOKEN']!)
  const next = await grants.issueChatCli(repo, { role: 'worker', allowSave: false, label: 'replacement' })
  grants.bindChatGrant(next.grantId, { folder: repo, chatId: chat.id, generation: 'pty-two' })
  expect(previous.signal.aborted).toBe(true)
  expect(() => previous.assertCurrent()).toThrow()
  expect(await client().request({ op: 'name_chat', args: { title: 'Old generation' } })).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
  expect(await client(next.cli.env['DM_SESSION_TOKEN']).request({ op: 'name_chat', args: { title: 'Current generation' } })).toMatchObject({ ok: true, data: { applied: true } })
})
it('protects manual rename races, old chats and every system identity', async () => {
  const chat = bound()
  const response = client().request({ op: 'name_chat', args: { title: 'Delayed inference' } })
  records.renameChat(chat, 'My explicit title')
  expect(await response).toMatchObject({ ok: true, data: { applied: false } })
  expect(store.getChat(chat)).toMatchObject({ title: 'My explicit title', titleStatus: 'manual' })
  for (const fields of [{}, { runId: 'run' }, { transferEpicId: 'epic' }, { cardId: 'card' }, { title: 'Explicit' }]) {
    const protectedChat = records.createChat({ folder: repo, agent: 'codex', role: 'worker', ...fields })
    const grant = await grants.issueChatCli(repo, { role: 'worker', allowSave: false, label: 'protected' })
    grants.bindChatGrant(grant.grantId, { folder: repo, chatId: protectedChat.id, generation: protectedChat.id })
    expect(await client(grant.cli.env['DM_SESSION_TOKEN']).request({ op: 'name_chat', args: { title: 'Do not apply' } })).toMatchObject({ ok: true, data: { applied: false } })
    expect(store.getChat(protectedChat)?.title).toBe(protectedChat.title)
  }
})
it('reports inference failure without inventing a prefix and leaves the full first message recoverable', async () => {
  const chat = bound()
  expect(await client().request({ op: 'name_chat', args: { error: 'The selected model refused inference.' } })).toMatchObject({ ok: true, data: { applied: true } })
  expect(store.getChat(chat)).toMatchObject({ firstPrompt: chat.firstPrompt, titleStatus: 'failed', titleError: 'The selected model refused inference.' })
})
it('rejects caller-selected targets, every pane operation, long titles and ambiguous result payloads', () => {
  for (const op of [
    { op: 'open_in_pane', args: { target: 'https://example.com' } },
    { op: 'capture_pane', args: { pane: 'terminal' } },
    { op: 'ping', args: {} },
    { op: 'name_chat', args: { title: 'Six words do not fit this title' } },
    { op: 'name_chat', args: { title: 'Short title', chatId: 'other' } },
    { op: 'name_chat', args: { title: 'Short title', error: 'failure' } }
  ]) expect(namingOperationSchema.safeParse(op).success).toBe(false)
})

it('routes real CLI token-file and MCP calls through the same authenticated metadata pipe', async () => {
  const chat = bound()
  vi.stubEnv('DM_DESKTOP_PIPE', server.address)
  vi.stubEnv('DM_SESSION_TOKEN', 'wrong-inherited-token')
  const stdout: string[] = [], stderr: string[] = []
  let code = -1
  const options = { homeDir: join(root, 'home'), clock, git: createFakeGit({ branch: 'main', commit: 'b'.repeat(40), detached: false }) }
  const host: CliHost = {
    argv: ['--repo', repo, '--token-file', 'owned-token', 'call', 'name_chat', JSON.stringify({ title: 'Repair expired-session refresh' })],
    env: { ...process.env }, cwd: repo, execPath: process.execPath, cliPath: 'cli.js',
    open: input => openWorkspace({ ...input, ...options }),
    readFile: () => issued.cli.env['DM_SESSION_TOKEN']!, readStdin: () => '',
    writeStdout: text => stdout.push(text), writeStderr: text => stderr.push(text), exit: value => { code = value }
  }
  await runCli(host)
  expect(code).toBe(0)
  expect(stderr).toEqual([])
  expect(JSON.parse(stdout.join(''))).toEqual({ ok: true, data: { applied: true } })
  expect(store.getChat(chat)).toMatchObject({ title: 'Repair expired-session refresh', titleStatus: 'generated' })
  const api = openWorkspace({ repoRoot: repo, ...options, role: 'reader', transport: 'cli', label: 'MCP over owned grant', grantToken: issued.cli.env['DM_SESSION_TOKEN']! })
  try {
    await withRig(target => createMcpServer(target, { name: 'naming-test', version: '1' }, { role: 'worker', allowSave: false }), Object.assign(api, { calls: [] }), async rig => {
      expect((await callTool(rig, 'name_chat', { title: 'Later name rejected' })).payload).toEqual({ ok: true, data: { applied: false } })
      await workspace.revokeGrant({ grantId: issued.grantId })
      expect((await callTool(rig, 'name_chat', { title: 'Revoked caller rejected' })).payload).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
      expect(store.getChat(chat)?.title).toBe('Repair expired-session refresh')
    })
  } finally { api.close() }
})

it('refuses pending-name metadata on system chats and rejects direct prompt-prefix titles without consuming inference', async () => {
  const chat = bound()
  expect(await client().request({ op: 'name_chat', args: { title: 'Could you investigate' } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  expect(store.getChat(chat)?.titleStatus).toBe('pending')
  for (const fields of [{ runId: 'run' }, { transferEpicId: 'epic' }, { cardId: 'card' }]) {
    const system = store.createChat({ folder: repo, agent: 'codex', model: null, role: 'worker', allowSave: false, firstPrompt: 'Investigate and repair the build', title: 'Keep this system identity', titleStatus: 'pending', ...fields })
    const grant = await grants.issueChatCli(repo, { role: 'worker', allowSave: false, label: 'system' })
    grants.bindChatGrant(grant.grantId, { folder: repo, chatId: system.id, generation: system.id })
    expect(await client(grant.cli.env['DM_SESSION_TOKEN']).request({ op: 'name_chat', args: { title: 'Repair build pipeline' } })).toMatchObject({ ok: true, data: { applied: false } })
    expect(store.getChat(system)?.title).toBe('Keep this system identity')
  }
})

it('rejects a grant that expires after binding without altering the pending title', async () => {
  const chat = bound()
  clock.advanceSeconds(61 * 60)
  expect(await client().request({ op: 'name_chat', args: { title: 'Repair session refresh' } })).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
  expect(store.getChat(chat)).toMatchObject({ titleStatus: 'pending', firstPrompt: chat.firstPrompt })
})

it('reports a removed bound chat without resurrecting it or naming another chat', async () => {
  const chat = bound()
  await records.deleteChat(chat)
  expect(await client().request({ op: 'name_chat', args: { title: 'Repair session refresh' } })).toMatchObject({ ok: false, error: { code: 'not_found' } })
  expect(store.getChat(chat)).toBeNull()
})

it('refuses a live binding whose credential no longer matches the current stored grant', async () => {
  const chat = bound()
  workspace.ctx().db.run('UPDATE grants SET token_hash = ? WHERE id = ?', 'replaced-credential', issued.grantId)
  expect(await client().request({ op: 'name_chat', args: { title: 'Stale credential mutation' } })).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
  expect(store.getChat(chat)).toMatchObject({ title: chat.title, titleStatus: 'pending', firstPrompt: chat.firstPrompt })
})
