import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createHarness, type Harness } from '../test/workspaceHarness'
import { bindForge, FORGE_POINTER, withForgeTransfer } from './repo/forgeBinding'
import { openWorkspace } from './workspace'

let h: Harness
beforeEach(() => { h = createHarness() })
afterEach(() => h.cleanup())

it('preserves ticket identity and opens a bound code project through its pointer', async () => {
  const source = h.open('desktop', { transport: 'desktop', mode: 'db' })
  await source.initializeRepository({ name: 'Source' })
  const card = await source.createKanbanCard({ title: 'One shared card' })
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
  } finally { workspace.close() }
})
