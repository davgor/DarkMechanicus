import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { openDatabase } from '../db/database'
import { verifyForgeExport } from './forgeExportReceipt'
import { withForgeTransfer } from './forgeBinding'
import { resolveLayout } from './layout'
import { nodeFs } from './nodeFs'

let h: Harness
beforeEach(() => { h = createHarness() })
afterEach(() => h.cleanup())

it.each(['identity', 'checkpoint', 'database', 'portable', 'receipt'] as const)('refuses a resumed export with changed %s proof and preserves source work', async changed => {
  const source = h.open('desktop', { mode: 'db', transport: 'desktop' })
  await source.initializeRepository({ name: 'Receipt proof' })
  const card = await source.createKanbanCard({ title: 'Original card' })
  await source.playKanbanCard({ cardId: card.id })
  const before = await source.getKanbanCard({ cardId: card.id })
  const member = join(h.homeDir, 'Receipt')
  mkdirSync(member)
  await withForgeTransfer(h.homeDir, h.root, member, async () => source.exportForge!(member, 'repo', { force: true }))
  const layout = resolveLayout(member)
  const env = { fs: nodeFs, layout, source: h.root }
  expect(() => verifyForgeExport(env, source.ctx().projectId)).not.toThrow()
  const receipt = join(layout.localDir, 'forge-export.json')
  if (changed === 'identity') {
    const saved = JSON.parse(readFileSync(receipt, 'utf8'))
    saved.source = join(h.homeDir, 'Other project')
    writeFileSync(receipt, JSON.stringify(saved))
  } else if (changed === 'checkpoint') {
    const checkpoint = join(layout.localDir, 'migration-records.json')
    writeFileSync(checkpoint, readFileSync(checkpoint, 'utf8') + '\n')
  } else if (changed === 'database') {
    const db = openDatabase(layout.dbFile)
    try { db.run("UPDATE kanban_cards SET title = 'Unverified database edit' WHERE id = ?", card.id) }
    finally { db.close() }
  } else if (changed === 'portable') {
    writeFileSync(join(layout.kanbanDir, card.id, 'card.json'), '{malformed')
  } else rmSync(receipt)
  expect(() => verifyForgeExport(env, source.ctx().projectId)).toThrow(changed === 'receipt' ? 'ownership receipt' : 'changed or belongs')
  expect(await source.getKanbanCard({ cardId: card.id })).toEqual(before)
})
