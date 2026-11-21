import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createHarness, type Harness } from '../test/workspaceHarness'
import { assertForgeTransferIdle, bindForge, boundForgeRoot, FORGE_POINTER, isForgeMember, pendingForgeTransfer, withForgeTransfer } from './repo/forgeBinding'
import { nodeFs } from './repo/nodeFs'
import { dbProjectDir } from './repo/storageMode'
import { openWorkspace } from './workspace'

let h: Harness
beforeEach(() => { h = createHarness() })
afterEach(() => h.cleanup())

it('preserves ticket identity and opens a bound code project through its pointer', async () => {
  const source = h.open('desktop', { transport: 'desktop', mode: 'db' })
  await source.initializeRepository({ name: 'Source' })
  const card = await source.createKanbanCard({ title: 'One shared card' })
  const docs = join(dbProjectDir(h.root, h.homeDir), 'knowledge', 'design')
  mkdirSync(docs, { recursive: true })
  writeFileSync(join(docs, 'decisions.md'), 'Keep the original design.')
  const member = join(h.homeDir, 'Forge', 'Source')
  mkdirSync(member, { recursive: true })
  await withForgeTransfer(h.homeDir, h.root, member, async () => { source.exportForge!(member) })
  source.close()
  const note = 'Forge World: https://github.com/tester/world.git\nProject folder: Source\n'
  writeFileSync(join(h.root, FORGE_POINTER), note)
  bindForge(h.homeDir, h.root, member, note)
  const workspace = openWorkspace({ repoRoot: h.root, homeDir: h.homeDir, transport: 'desktop', role: 'desktop', label: 'Forge fixture', serverInfo: { name: 'fixture', version: '1' } })
  try {
    expect(workspace.repoRoot).toBe(member)
    expect((await workspace.getKanbanCard({ cardId: card.id })).title).toBe('One shared card')
    const exported = join(member, '.darkmechanicus', 'kanban', card.id, 'card.json')
    expect(existsSync(exported)).toBe(true)
    expect(readFileSync(exported, 'utf8')).toContain(card.id)
    expect(readFileSync(join(member, '.darkmechanicus/knowledge/design/decisions.md'), 'utf8')).toBe('Keep the original design.')
    expect(JSON.parse(readFileSync(join(member, '.darkmechanicus/local/source-checkout.json'), 'utf8'))).toEqual({ checkout: h.root })
  } finally { workspace.close() }
})

it('resumes an interrupted move at the last persisted phase and rejects a different destination', async () => {
  const { homeDir, root } = h
  const member = join(homeDir, 'World', 'Project')
  await expect(withForgeTransfer(homeDir, root, member, async (phase, advance) => {
    expect(phase).toBe(0)
    expect(boundForgeRoot(nodeFs, homeDir, root)).toBe(root)
    await expect(withForgeTransfer(homeDir, root, member, async () => null)).rejects.toThrow('already running')
    advance(2)
    throw new Error('interrupted after export')
  })).rejects.toThrow('interrupted after export')
  expect(pendingForgeTransfer(homeDir, root)).toBe(member)
  expect(() => assertForgeTransferIdle(nodeFs, homeDir, root)).toThrow('conversion is pending')
  await expect(withForgeTransfer(homeDir, root, 'another target', async () => null)).rejects.toThrow('Resume')
  expect(await withForgeTransfer(homeDir, root, member, async phase => phase)).toBe(2)
  expect(pendingForgeTransfer(homeDir, root)).toBeNull()
  await expect(withForgeTransfer(homeDir, root, member, async () => { throw new Error('before export') })).rejects.toThrow('before export')
  expect(pendingForgeTransfer(homeDir, root)).toBeNull()
})

it('rejects stale pointers and recognizes only project folders listed by a valid manifest', () => {
  const world = join(h.homeDir, 'World')
  const member = join(world, 'Project')
  mkdirSync(member, { recursive: true })
  const manifest = join(world, 'forge-world.json')
  const pointer = join(h.root, FORGE_POINTER)
  writeFileSync(pointer, 'original')
  expect(() => boundForgeRoot(nodeFs, h.homeDir, h.root)).toThrow('retrieve its Forge World')
  bindForge(h.homeDir, h.root, member, 'original')
  expect(boundForgeRoot(nodeFs, h.homeDir, h.root)).toBe(member)
  writeFileSync(pointer, 'new destination')
  expect(() => boundForgeRoot(nodeFs, h.homeDir, h.root)).toThrow('retrieve its Forge World')
  for (const text of ['invalid', '{}', '{"version":1,"projects":[{"folder":"Other"}]}']) {
    writeFileSync(manifest, text)
    expect(isForgeMember(nodeFs, member)).toBe(false)
  }
  writeFileSync(manifest, '{"version":1,"projects":[{"folder":"Project"}]}')
  expect(isForgeMember(nodeFs, member)).toBe(true)
})
