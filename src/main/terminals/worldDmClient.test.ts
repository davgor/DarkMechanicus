import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DM_CLIENT_DESCRIPTOR_ENV } from '../../../resources/skitarii/extension/dmClient'
import { parseWorldMailDescriptor, worldMailClients, type WorldMailDescriptor } from '../../../resources/skitarii/extension/worldDmClient'
import { reachTargets } from '../agents/chatReach'
import { buildCliConfig } from '../desktop/cliConfig'
import { writeDmClientDescriptor, writeRecoveryClientDescriptor, writeWorldMailDescriptor } from './terminalFiles'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function descriptor() {
  const root = mkdtempSync(join(tmpdir(), 'dm-world-client-'))
  roots.push(root)
  const folder = join(root, 'world')
  const userData = join(root, 'data')
  const reach = reachTargets(join(userData, 'agents', 'scratch', 'chat_world'), [join(folder, 'Alpha'), join(folder, 'Beta')])
  const options = { userData, chatId: 'chat_world', generation: 'g1', folder,
    cli: buildCliConfig({ appPath: root, execPath: join(root, 'electron'), repoPath: null }), platform: process.platform, reach }
  const path = await writeWorldMailDescriptor(options)
  return { path, text: readFileSync(path, 'utf8'), reach, options }
}

describe('world mail descriptor producer and consumer', () => {
  it('routes every member through its own folder and private grant file without exposing a token', async () => {
    const { path, text, reach } = await descriptor()
    const parsed = parseWorldMailDescriptor(path, text)
    expect(parsed?.routes.map(route => [route.project, route.descriptor.folder, route.tokenFile])).toEqual(reach.map(target => [target.folder.endsWith('Alpha') ? 'Alpha' : 'Beta', target.folder, target.tokenFile]))
    expect(text).not.toContain('DM_SESSION_TOKEN')
    const clients = await worldMailClients({ env: { [DM_CLIENT_DESCRIPTOR_ENV]: path }, platform: process.platform, readFile: async file => readFileSync(file, 'utf8'), spawn: () => { throw new Error('Must not spawn before a call') } })
    expect(clients?.projects.map(project => project.project)).toEqual(['Alpha', 'Beta'])
  })

  it('rejects cross-chat tokens, paths outside the world, duplicate projects and mismatched launch identities', async () => {
    const { path, text } = await descriptor()
    const valid = JSON.parse(text) as WorldMailDescriptor
    for (const mutate of [
      (value: typeof valid) => { value.routes[0]!.tokenFile = join(tmpdir(), 'secret.token') },
      (value: typeof valid) => { value.routes[0]!.descriptor.folder = tmpdir() },
      (value: typeof valid) => { value.routes.push(value.routes[0]!) },
      (value: typeof valid) => { value.routes[0]!.descriptor.generation = 'another' },
      (value: typeof valid) => {
        const route = value.routes[0]!
        route.project = '..'
        route.descriptor.folder = dirname(value.folder)
        route.descriptor.cwd = route.descriptor.folder
        route.descriptor.args[2] = route.descriptor.folder
      },
    ]) {
      const value = JSON.parse(text) as WorldMailDescriptor
      mutate(value)
      expect(parseWorldMailDescriptor(path, JSON.stringify(value))).toBeNull()
    }
  })
})

describe('world descriptor generation cleanup', () => {
  it('replaces a prior generation and pins recovery to the current desktop address', async () => {
    const { path, options } = await descriptor()
    const current = await writeWorldMailDescriptor({ ...options, generation: 'g2', cli: { ...options.cli, env: { ...options.cli.env, DM_DESKTOP_PIPE: 'desktop-current' } } })
    expect(existsSync(path)).toBe(false)
    expect(JSON.parse(readFileSync(current, 'utf8'))).toMatchObject({ generation: 'g2', recoveryAddress: 'desktop-current' })
    const recovery = await writeRecoveryClientDescriptor({ ...options, generation: 'g3', address: 'recovery-current' })
    expect(existsSync(current)).toBe(false)
    expect(JSON.parse(readFileSync(recovery, 'utf8'))).toEqual({ version: 1, chatId: options.chatId, generation: 'g3', recoveryAddress: 'recovery-current' })
  })

  it('refuses corrupt descriptor directories instead of replacing unrelated files', async () => {
    const { path, options } = await descriptor()
    rmSync(dirname(path), { recursive: true })
    writeFileSync(dirname(path), 'Keep this file')
    await expect(writeWorldMailDescriptor(options)).rejects.toMatchObject({ code: 'ENOTDIR' })
    await expect(writeRecoveryClientDescriptor({ ...options, address: 'desktop' })).rejects.toMatchObject({ code: 'ENOTDIR' })
    const pinned = { ...options, cli: { ...options.cli, args: [...options.cli.args, '--repo', options.folder] } }
    await expect(writeDmClientDescriptor(pinned)).rejects.toMatchObject({ code: 'ENOTDIR' })
    expect(readFileSync(dirname(path), 'utf8')).toBe('Keep this file')
  })
})
