import { createServer, type Server } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDmClient, type DmClientDeps } from '../../../resources/skitarii/extension/dmClient'
import { writeRecoveryClientDescriptor } from './terminalFiles'

const roots: string[] = []
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('recovery-only host control', () => {
  it('preserves fragmented multibyte peer context, pins the current generation and never spawns generic projectless commands', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dm901-control-')); roots.push(root)
    const address = process.platform === 'win32' ? `\\\\.\\pipe\\dm901-fixture-${crypto.randomUUID()}` : join(root, 'p')
    let current = true
    const server = createServer(socket => {
      let request = ''
      socket.on('data', chunk => {
        request += chunk.toString('utf8')
        if (!request.endsWith('\n')) return
        const input = JSON.parse(request) as { requestId: string; token: string; op: string; args: { generation?: string } }
        const allowed = input.token === 'non-sensitive-fixture-grant' && input.args.generation === 'fixture-generation' && current
        const reply = Buffer.from(JSON.stringify({ version: 1, requestId: input.requestId, ...(allowed ? { ok: true, data: { messages: [{ id: 'recovery-fixture', text: 'Question: 漢字 café 𐐀' }] } } : { ok: false, error: { code: 'unauthorized', message: 'The live generation was revoked.' } }) }) + '\n')
        const split = reply.indexOf(Buffer.from('漢')) + 1
        socket.write(reply.subarray(0, split))
        setImmediate(() => socket.end(reply.subarray(split)))
      })
    }); servers.push(server)
    await new Promise<void>(resolve => server.listen(address, resolve))
    const descriptor = await writeRecoveryClientDescriptor({ userData: root, chatId: 'projectless-fixture', generation: 'fixture-generation', address })
    expect(JSON.parse(readFileSync(descriptor, 'utf8'))).toEqual({ version: 1, chatId: 'projectless-fixture', generation: 'fixture-generation', recoveryAddress: address })
    const spawn = vi.fn<DmClientDeps['spawn']>()
    const client = createDmClient({ env: { DM_SKITARII_CLIENT_DESCRIPTOR: descriptor, DM_SESSION_TOKEN: 'non-sensitive-fixture-grant' }, platform: process.platform, readFile: async path => readFileSync(path, 'utf8'), spawn })
    expect(await client.readRecovery!()).toEqual({ ok: true, data: [{ id: 'recovery-fixture', text: 'Question: 漢字 café 𐐀' }] })
    expect(await client.run('get_capabilities', {})).toMatchObject({ ok: false, error: { code: 'descriptor_invalid' } })
    expect(await client.call('identity', {})).toMatchObject({ ok: false, error: { code: 'descriptor_invalid' } })
    expect(spawn).not.toHaveBeenCalled()
    current = false
    expect(await client.readRecovery!()).toMatchObject({ ok: false, error: { source: 'dm', code: 'unauthorized' } })
    await client.cancelAll()
  })
})

it('refuses JSON-expanded credentials for context and recovery before any socket or generic child', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dm901-credential-')); roots.push(root)
  const descriptor = await writeRecoveryClientDescriptor({ userData: root, chatId: 'credential-fixture', generation: 'fixture-generation', address: 'unreachable-fixture-address' })
  const spawn = vi.fn<DmClientDeps['spawn']>()
  const client = createDmClient({ env: { DM_SKITARII_CLIENT_DESCRIPTOR: descriptor, DM_SESSION_TOKEN: '\x01'.repeat(1024) }, platform: process.platform, readFile: async path => readFileSync(path, 'utf8'), spawn })
  expect(await client.readRecovery!()).toMatchObject({ ok: false, error: { source: 'client', code: 'invalid_input' } })
  expect(await client.run('recover_tooling', { action: 'status', incidentId: 'fixture' })).toMatchObject({ ok: false, error: { source: 'client', code: 'invalid_input' } })
  expect(spawn).not.toHaveBeenCalled()
  await client.cancelAll()
})
