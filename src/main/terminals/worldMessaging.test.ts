import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DM_CLIENT_DESCRIPTOR_ENV } from '../../../resources/skitarii/extension/dmClient'
import { peerContextBodies } from '../../../resources/skitarii/extension/contextDelivery'
import type { MailApi, MailContext, MailToolDefinition, TypeBuilder } from '../../../resources/skitarii/extension/messaging'
import { worldMailClients, type WorldMailClients } from '../../../resources/skitarii/extension/worldDmClient'
import { attachWorldMessaging } from '../../../resources/skitarii/extension/worldMessaging'
import { reachTargets } from '../agents/chatReach'
import { buildCliConfig } from '../desktop/cliConfig'
import { writeWorldMailDescriptor } from './terminalFiles'

const roots: string[] = []
const worlds: WorldMailClients[] = []
afterEach(async () => {
  for (const world of worlds.splice(0)) await Promise.all([world.recovery.cancelAll(), ...world.projects.map(route => route.client.cancelAll())])
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const CLI = `
const fs = require('node:fs'), path = require('node:path')
const folder = process.argv[3], project = path.basename(folder), command = process.argv[5]
const input = JSON.parse(fs.readFileSync(0, 'utf8'))
if (process.env.DM_SESSION_TOKEN !== 'token-' + project) { console.log(JSON.stringify({ok:false,error:{code:'unauthorized',message:'wrong project grant'}})); process.exit(1) }
fs.appendFileSync(path.join(folder, 'calls.jsonl'), JSON.stringify({command,input}) + '\\n')
const message = {id:'mm_same',seq:1,from:{endpointId:'me_peer',name:'Peer',deleted:false},inReplyTo:null,bodyBytes:4,acceptedAt:'2026-11-22T00:00:00Z',acknowledgedAt:null,expiresAt:null,body:project}
const page = {snapshotHighWater:1,nextCursor:1,hasMore:false,messages:[message]}
const answers = {
 get_agent_identity:{endpointId:'me_' + project,name:project,role:'worker',boundAt:'2026-11-22T00:00:00Z'},
 list_agent_peers:{peers:[{endpointId:'me_peer',name:project + ' peer'}],hasMore:false,nextAfterId:null},
 send_agent_message:{messageId:'mm_sent',to:input.to,clientMessageId:input.clientMessageId,inReplyTo:null,acceptedAt:'now',duplicate:false},
 read_agent_inbox:page,get_agent_mail_status:{...page,pendingCount:1},
 acknowledge_agent_messages:{acknowledged:input.messageIds},get_capabilities:{project}
}
console.log(JSON.stringify({ok:true,data:answers[command]}))
`

async function fixture(empty = false) {
  const root = mkdtempSync(join(tmpdir(), 'dm-world-messaging-'))
  roots.push(root)
  const folder = join(root, 'world'), userData = join(root, 'data')
  const members = empty ? [] : ['Alpha', 'Beta'].map(name => join(folder, name))
  mkdirSync(join(root, 'out', 'main'), { recursive: true })
  writeFileSync(join(root, 'out', 'main', 'cli.js'), CLI)
  const reach = reachTargets(join(userData, 'agents', 'scratch', 'chat_world'), members)
  for (const [index, target] of reach.entries()) {
    mkdirSync(target.folder, { recursive: true })
    mkdirSync(join(userData, 'agents', 'scratch', 'chat_world', '.dm', 'grants'), { recursive: true })
    writeFileSync(target.tokenFile, 'token-' + ['Alpha', 'Beta'][index])
  }
  const path = await writeWorldMailDescriptor({ userData, chatId: 'chat_world', generation: 'g1', folder,
    cli: buildCliConfig({ appPath: root, execPath: process.execPath, repoPath: null }), platform: process.platform, reach })
  const world = await worldMailClients({ env: { [DM_CLIENT_DESCRIPTOR_ENV]: path, DM_SESSION_TOKEN: 'wrong-ambient-token' }, platform: process.platform, readFile: async file => readFileSync(file, 'utf8'), spawn })
  if (!world) throw new Error('The real descriptor was not recognized')
  worlds.push(world)
  return { root, folder, path, reach, world }
}

const type: TypeBuilder = {
  Object: (properties, options) => ({ type: 'object', properties, ...options }), String: options => ({ type: 'string', ...options }),
  Integer: options => ({ type: 'integer', ...options }), Boolean: options => ({ type: 'boolean', ...options }), Array: (items, options) => ({ type: 'array', items, ...options }),
  Optional: schema => ({ optional: schema }), Null: () => ({ type: 'null' }), Union: schemas => ({ anyOf: schemas }),
}

function host(world: WorldMailClients) {
  const handlers = new Map<string, ((event: unknown, ctx: MailContext) => unknown)[]>()
  const tools = new Map<string, MailToolDefinition>()
  const entries: unknown[] = []
  const statuses: string[] = []
  const pi: MailApi = { typebox: { Type: type }, registerTool: tool => { tools.set(tool.name, tool) },
    on: (event, handler) => { handlers.set(event, [...handlers.get(event) ?? [], handler]) },
    sendUserMessage: async (content, options) => { entries.push({ type: 'message', message: { role: 'user', content, attribution: options.attribution } }) },
  }
  const ctx: MailContext = { hasUI: true, agent: { kind: 'main' }, sessionManager: { getEntries: () => entries }, isIdle: () => true,
    ui: { setStatus: (_key, text) => { if (text) statuses.push(text) } } }
  attachWorldMessaging(pi, world, { setInterval: () => 0, clearInterval: () => {} })
  return { tools, entries, statuses, fire: async (name: string, event: unknown = {}) => {
    for (const handler of handlers.get(name) ?? []) {
      const result = await handler(event, ctx) as { message?: { content: string; attribution: string } } | undefined
      if (result?.message) entries.push({ type: 'message', message: { role: 'user', ...result.message } })
    }
  } }
}

describe('Forge World native mail tools and per-project cursors', () => {
  it('lists both identities, rejects ambiguous writes, and routes explicit send/read/ack to the matching grant', async () => {
    const { world, folder } = await fixture()
    const ui = host(world)
    const identities = await ui.tools.get('dm_agent_identity')!.execute('identity', {})
    expect(identities.isError).toBeUndefined()
    expect(identities.content[0]?.text).toContain('me_Alpha')
    expect(identities.content[0]?.text).toContain('me_Beta')
    expect((await ui.tools.get('dm_message_send')!.execute('send', { to: 'me_peer', clientMessageId: 'one', body: 'Hello' })).isError).toBe(true)
    expect((await ui.tools.get('dm_message_send')!.execute('send', { project: 'Beta', to: 'me_peer', clientMessageId: 'one', body: 'Hello' })).isError).toBeUndefined()
    const read = await ui.tools.get('dm_inbox_read')!.execute('read', { project: 'Alpha' })
    expect(peerContextBodies({ type: 'message', message: { role: 'toolResult', toolName: 'dm_inbox_read', ...read } })).toEqual([{
      id: 'mm_same', seq: 1, body: 'Alpha', project: join(folder, 'Alpha'), from: { endpointId: 'me_peer', name: 'Peer', deleted: false },
      inReplyTo: null, bodyBytes: 4, acceptedAt: '2026-11-22T00:00:00Z', acknowledgedAt: null, expiresAt: null,
    }])
    expect((await ui.tools.get('dm_inbox_ack')!.execute('ack', { project: 'Alpha', messageIds: ['mm_same'] })).isError).toBeUndefined()
    const alpha = readFileSync(join(folder, 'Alpha', 'calls.jsonl'), 'utf8')
    const beta = readFileSync(join(folder, 'Beta', 'calls.jsonl'), 'utf8')
    expect(alpha).toContain('acknowledge_agent_messages')
    expect(alpha).not.toContain('send_agent_message')
    expect(beta).toContain('send_agent_message')
    expect(beta).not.toContain('acknowledge_agent_messages')
  })

})

describe('Forge World automatic mail delivery', () => {
  it('admits identical member message ids separately and reconstructs route-specific receipts after restart', async () => {
    const { world, folder } = await fixture()
    const ui = host(world)
    await ui.fire('session_start')
    await ui.fire('before_agent_start', { prompt: 'Begin' })
    await ui.fire('session_stop')
    const bodies = ui.entries.flatMap(peerContextBodies)
    expect(bodies.map(body => [body.project, body.body])).toEqual(expect.arrayContaining([[join(folder, 'Alpha'), 'Alpha'], [join(folder, 'Beta'), 'Beta']]))
    expect(bodies).toHaveLength(2)
    await ui.fire('session_shutdown')
    await ui.fire('session_start')
    await ui.fire('before_agent_start', { prompt: 'Resume' })
    await ui.fire('session_stop')
    expect(ui.entries.flatMap(peerContextBodies)).toHaveLength(2)
    expect(ui.statuses.some(status => status.includes('descriptor_invalid'))).toBe(false)
    await ui.fire('session_shutdown')
  })

  it('explains empty worlds and refuses arbitrary project selection', async () => {
    const { world } = await fixture(true)
    const ui = host(world)
    await ui.fire('session_start')
    expect(ui.statuses).toContain('Skitarii mail: no project mailboxes in this Forge World')
    const result = await ui.tools.get('dm_call')!.execute('call', { project: 'unrelated', command: 'get_capabilities' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('Nothing was run')
    await ui.fire('session_shutdown')
  })
})
