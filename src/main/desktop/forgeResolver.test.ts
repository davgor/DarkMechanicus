import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IpcMain } from 'electron'
import { expect, it } from 'vitest'
import { openWorkspace } from '../../core/workspace'
import { gitIn, scratchDir } from '../../test/gitScratch'
import { createGitRunner } from '../git/runner'
import { createFolderRegistry } from './folderRegistry'
import { updateForge } from './forgeManifest'
import { startForge } from './forgeService'
import { createWorkspacePool } from './workspacePool'

function initializeOrigin(root: string) {
  mkdirSync(root)
  gitIn(root, 'init', '-b', 'main')
  gitIn(root, 'config', 'user.name', 'Test')
  gitIn(root, 'config', 'user.email', 'test@example.test')
  gitIn(root, 'remote', 'add', 'origin', 'https://github.com/owner/tickets.git')
}

it('opens a resolver for a conflicting sync and archives after valid merged tickets reach origin', async () => {
  const fixture = scratchDir('forge-resolver-')
  const root = join(fixture.path, 'world')
  const home = join(fixture.path, 'home')
  initializeOrigin(root)
  const registry = createFolderRegistry({ file: join(home, 'folders.json'), dmHome: home, homeDir: home })
  registry.track(root)
  const pool = createWorkspacePool(repoRoot => openWorkspace({ repoRoot, homeDir: home, transport: 'desktop', role: 'desktop', label: 'Resolver fixture', serverInfo: { name: 'fixture', version: '1' } }))
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const call = async (name: string, ...args: unknown[]) => handlers.get('forge:' + name)!({} as Electron.IpcMainInvokeEvent, ...args)
  const events: string[] = []
  const runner = createGitRunner()
  let upstream = ''
  const forge = startForge({ handle: (name, handler) => { handlers.set(name, handler) } }, {
    home, registry, pool, session: { getAccount: () => null, getToken: () => null },
    cleanup: () => undefined, pickDirectory: async () => null, publish: async () => undefined,
    onConflict: async (_world, member) => { events.push('resolve ' + member) },
    onSynced: async () => { events.push('archive') },
    runner: { run: async req => {
      if (req.kind !== 'network') return runner.run(req)
      if (req.args.includes('fetch')) writeFileSync(join(root, '.git/FETCH_HEAD'), upstream + "\t\tbranch 'main'\n")
      if (req.args.includes('push')) { upstream = gitIn(root, 'rev-parse', 'HEAD').trim(); events.push('push') }
      return { code: 0, stderr: '', stdout: req.args.includes('ls-remote') ? upstream : '' }
    } }
  })
  try {
    await call('create', root)
    await call('add', root, 'owner/Alpha', 'Alpha')
    await expect(call('add', root, 'owner/Alpha', 'Alias')).rejects.toThrow('already tracked')
    await expect(call('interval', root, 0)).rejects.toThrow()
    gitIn(root, 'switch', '-c', 'remote')
    updateForge(root, w => { w.syncMinutes = 19 })
    gitIn(root, 'commit', '-am', 'Change interval remotely')
    upstream = gitIn(root, 'rev-parse', 'HEAD').trim()
    gitIn(root, 'switch', 'main')
    await call('interval', root, 7)
    events.length = 0
    await expect(call('sync', root)).rejects.toThrow()
    expect(events).toEqual(['resolve ' + join(root, 'Alpha')])
    expect((await call('status', root)).error).toBeTruthy()
    writeFileSync(join(root, 'forge-world.json'), gitIn(root, 'show', 'remote:forge-world.json'))
    gitIn(root, 'add', 'forge-world.json')
    gitIn(root, 'commit', '-m', 'Resolve ticket settings conflict')
    await call('sync', root)
    expect(events).toEqual(['resolve ' + join(root, 'Alpha'), 'push', 'archive'])
    expect((await call('status', root)).error).toBeNull()
    expect(JSON.parse(readFileSync(join(root, 'forge-world.json'), 'utf8')).syncMinutes).toBe(19)
  } finally { forge.stop(); pool.closeAll(); fixture.cleanup() }
})
