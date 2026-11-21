import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IpcMain } from 'electron'
import { expect, it } from 'vitest'
import { openWorkspace } from '../../core/workspace'
import { gitIn, scratchDir } from '../../test/gitScratch'
import { createGitRunner } from '../git/runner'
import { createFolderRegistry } from './folderRegistry'
import { forgeKickoff } from './forgeManifest'
import { startForge } from './forgeService'
import { createWorkspacePool } from './workspacePool'

it('converts a real SQLite project, follows its source note and restores the same card to the code repo', async () => {
  const scratch = scratchDir('forge-convert-')
  const home = join(scratch.path, 'home')
  const source = join(scratch.path, 'Software')
  const world = join(scratch.path, 'TicketStore')
  const registry = createFolderRegistry({ file: join(home, 'folders.json'), dmHome: home, homeDir: home })
  const pool = createWorkspacePool(repoRoot => openWorkspace({ repoRoot, homeDir: home, transport: 'desktop', role: 'desktop', label: 'Desktop fixture', serverInfo: { name: 'fixture', version: '1' } }))
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const call = (name: string, ...args: string[]) => handlers.get('forge:' + name)!({} as Electron.IpcMainInvokeEvent, ...args)
  for (const dir of [source, world]) {
    mkdirSync(dir)
    gitIn(dir, 'init', '-b', 'main')
    gitIn(dir, 'config', 'user.name', 'Test')
    gitIn(dir, 'config', 'user.email', 'test@example.test')
    gitIn(dir, 'remote', 'add', 'origin', 'https://github.com/example/' + (dir === world ? 'tickets' : 'software') + '.git')
    registry.track(dir)
  }
  const real = createGitRunner()
  const forge = startForge({ handle: (key, handler) => { handlers.set(key, handler) } }, {
    home, registry, pool, session: { getAccount: () => null, getToken: () => null },
    pickDirectory: async () => source, cleanup: () => undefined, publish: async () => undefined,
    onSynced: async () => undefined, onConflict: async () => { throw new Error('Unexpected conflict') },
    runner: { run: req => req.kind === 'network' ? Promise.resolve({ code: 0, stdout: '', stderr: '' }) : real.run(req) }
  })
  try {
    const original = pool.get(source)
    await original.initializeRepository({ name: 'Software', mode: 'db' })
    const card = await original.createKanbanCard({ title: 'Keep me' })
    await call('create', world)
    await call('convert', world, source)
    expect(readFileSync(join(source, 'FORGE-WORLD.md'), 'utf8')).toContain('example/tickets.git')
    const member = await forge.openProject(source)
    expect(member).toBe(join(world, 'Software'))
    expect(forgeKickoff(member)).toContain('https://github.com/example/software.git')
    expect(forgeKickoff(source)).toBe('')
    expect((await pool.get(member).getStorageStatus()).storage.mode).toBe('forge')
    expect((await pool.get(member).getKanbanCard({ cardId: card.id })).title).toBe('Keep me')
    await call('restore', member, 'repo')
    expect(existsSync(join(source, 'FORGE-WORLD.md'))).toBe(false)
    expect((await pool.get(source).getKanbanCard({ cardId: card.id })).title).toBe('Keep me')
  } finally { forge.stop(); pool.closeAll(); scratch.cleanup() }
})
