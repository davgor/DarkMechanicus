import { createServer, type Server } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDmClient, type DmClientDeps } from '../../../resources/skitarii/extension/dmClient'
import { attachMessaging, type MailToolDefinition, type TypeBuilder } from '../../../resources/skitarii/extension/messaging'
import { toolingRecoveryInputSchema } from '../../shared/agents/toolingRecovery'
import { writeRecoveryClientDescriptor } from './terminalFiles'

const roots: string[] = []
const servers: Server[] = []
const builders: TypeBuilder = {
  Object: (properties, options) => ({ type: 'object', properties, ...options }),
  String: (options) => ({ type: 'string', ...options }),
  Integer: (options) => ({ type: 'integer', ...options }),
  Boolean: (options) => ({ type: 'boolean', ...options }),
  Array: (items, options) => ({ type: 'array', items, ...options }),
  Optional: (schema) => ({ optional: schema })
}
const diagnostic = { command: 'get_ticket', code: 'storage_error', message: 'Non-sensitive failure', reproduction: 'Read the unfinished fixture', expected: 'Keep original work blocked' }

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** The real descriptor and control client, with the shared command validator at the receiving boundary. */
async function nativeTool() {
  const root = mkdtempSync(join(tmpdir(), 'dm-native-recovery-')); roots.push(root)
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\dm901-native-${crypto.randomUUID()}` : join(root, 'p')
  const received: unknown[] = []
  const accepted: unknown[] = []
  let authorized = true
  const server = createServer(socket => {
    let wire = ''
    socket.on('data', chunk => {
      wire += chunk.toString('utf8')
      if (!wire.endsWith('\n')) return
      const request = JSON.parse(wire) as { requestId: string; token: string; op: string; args: unknown }
      received.push(request.args)
      const parsed = toolingRecoveryInputSchema.safeParse(request.args)
      const allowed = authorized && request.token === 'native-fixture-grant' && request.op === 'recover_tooling'
      if (allowed && parsed.success) accepted.push(parsed.data)
      const result = !allowed ? { ok: false, error: { code: 'unauthorized', message: 'The live grant was revoked.' } }
        : !parsed.success ? { ok: false, error: { code: 'invalid_input', message: 'The shared recovery schema refused the input.' } }
          : { ok: true, data: { accepted: parsed.data } }
      socket.end(JSON.stringify({ version: 1, requestId: request.requestId, ...result }) + '\n')
    })
  }); servers.push(server)
  await new Promise<void>(resolve => server.listen(address, resolve))
  const descriptor = await writeRecoveryClientDescriptor({ userData: root, chatId: 'native-caller', generation: 'native-generation', address })
  const spawn = vi.fn<DmClientDeps['spawn']>()
  const deps: DmClientDeps = { env: { DM_SKITARII_CLIENT_DESCRIPTOR: descriptor, DM_SESSION_TOKEN: 'native-fixture-grant' }, platform: process.platform, readFile: async path => readFileSync(path, 'utf8'), spawn }
  const tools: MailToolDefinition[] = []
  attachMessaging({ on: () => {}, registerTool: tool => tools.push(tool), typebox: { Type: builders } }, createDmClient(deps), { setInterval: () => 0, clearInterval: () => {} })
  const tool = tools.find(candidate => candidate.name === 'recover_tooling')
  expect(tool, 'the direct native recovery action must be registered').toBeDefined()
  return { tool: tool!, received, accepted, deps, spawn, revoke: () => { authorized = false } }
}

describe('direct native recover_tooling actions', () => {
  it('preserves known diagnostic fields and bounded scalar arguments in one authenticated call', async () => {
    const rig = await nativeTool()
    const result = await rig.tool.execute('escalate', { action: 'escalate', incidentId: 'native-incident', diagnostic: { ...diagnostic, argumentsJson: '{"count":3,"enabled":true,"optional":null}' }, messageId: null, text: null, version: null, evidence: null })
    expect(result.isError).toBeUndefined()
    expect(rig.accepted).toEqual([{ action: 'escalate', incidentId: 'native-incident', diagnostic: { ...diagnostic, arguments: { count: 3, enabled: true, optional: null } } }])
    expect(rig.received).toEqual(rig.accepted)
    expect(rig.spawn).not.toHaveBeenCalled()
  })

  it.each([
    { action: 'status', incidentId: 'native-incident' },
    { action: 'message', incidentId: 'native-incident', messageId: 'question', text: 'What failed?' },
    { action: 'message', incidentId: 'native-incident', messageId: 'answer', text: 'The tracking service failed.' },
    { action: 'available', incidentId: 'native-incident', version: '0.55.0', evidence: 'Independent reviewed deployed fixture' },
    { action: 'resume', incidentId: 'native-incident' }
  ])('dispatches $action without irrelevant provider-null fields', async input => {
    const rig = await nativeTool()
    const result = await rig.tool.execute('action', { diagnostic: null, messageId: null, text: null, version: null, evidence: null, ...input })
    expect(result.isError).toBeUndefined()
    expect(rig.accepted).toEqual([input])
    expect(rig.received).toEqual([input])
    expect(rig.spawn).not.toHaveBeenCalled()
  })
})

describe('direct native recovery validation and authority', () => {
  it.each([
    { action: 'status', incidentId: 'native-incident', version: 'irrelevant' },
    { action: 'status', incidentId: 'native-incident', role: 'desktop' },
    { action: 'message', incidentId: 'native-incident', messageId: 'question', text: null },
    { action: 'escalate', incidentId: 'native-incident', diagnostic: null },
    { action: 'escalate', incidentId: 'native-incident', diagnostic: { ...diagnostic, argumentsJson: '{broken' } },
    { action: 'escalate', incidentId: 'native-incident', diagnostic: { ...diagnostic, grant: 'not-allowed' } }
  ])('refuses malformed native action data before any connection: $action', async input => {
    const rig = await nativeTool()
    expect((await rig.tool.execute('invalid', input)).isError).toBe(true)
    expect(rig.received).toEqual([])
    expect(rig.spawn).not.toHaveBeenCalled()
  })

  it('retains shared scalar validation and live-grant refusals instead of inventing native authority', async () => {
    const rig = await nativeTool()
    expect((await rig.tool.execute('nested', { action: 'escalate', incidentId: 'native-incident', diagnostic: { ...diagnostic, argumentsJson: '{"nested":{"private":"contents"}}' } })).isError).toBe(true)
    expect(rig.accepted).toEqual([])
    rig.revoke()
    const result = await rig.tool.execute('revoked', { action: 'status', incidentId: 'native-incident' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('unauthorized')
    expect(rig.accepted).toEqual([])
  })

  it('refuses a descriptor that does not name its own live generation without generic child fallback', async () => {
    const rig = await nativeTool()
    rig.deps.readFile = async () => JSON.stringify({ version: 1, chatId: 'other-chat', generation: 'other-generation', recoveryAddress: 'unreachable' })
    expect((await rig.tool.execute('stale', { action: 'status', incidentId: 'native-incident' })).isError).toBe(true)
    expect(rig.received).toEqual([])
    expect(rig.spawn).not.toHaveBeenCalled()
  })
})
