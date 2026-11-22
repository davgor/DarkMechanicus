import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { openDatabase } from '../db/database'
import { verifyForgeExport, verifyForgeExportOwner } from './forgeExportReceipt'
import { withForgeTransfer } from './forgeBinding'
import { resolveLayout } from './layout'
import { nodeFs } from './nodeFs'

let h: Harness
beforeEach(() => { h = createHarness() })
afterEach(() => h.cleanup())

it.each(['identity', 'checkpoint', 'database', 'portable', 'receipt', 'project_id', 'missing_project', 'missing_database', 'missing_owner'] as const)('refuses a resumed export with changed %s proof and preserves source work', async changed => {
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
  const editReceipt = (field: string, value: string) => {
    const saved = JSON.parse(readFileSync(receipt, 'utf8'))
    saved[field] = value
    writeFileSync(receipt, JSON.stringify(saved))
  }
  const mutations = {
    identity: () => editReceipt('source', join(h.homeDir, 'Other project')),
    project_id: () => editReceipt('projectId', 'another-project'),
    checkpoint: () => {
      const checkpoint = join(layout.localDir, 'migration-records.json')
      writeFileSync(checkpoint, readFileSync(checkpoint, 'utf8') + '\n')
    },
    database: () => {
      const db = openDatabase(layout.dbFile)
      try { db.run("UPDATE kanban_cards SET title = 'Unverified database edit' WHERE id = ?", card.id) }
      finally { db.close() }
    },
    portable: () => writeFileSync(join(layout.kanbanDir, card.id, 'card.json'), '{malformed'),
    missing_project: () => rmSync(layout.projectFile),
    missing_database: () => rmSync(layout.dbFile),
    missing_owner: () => rmSync(join(layout.localDir, 'forge-owner.json')),
    receipt: () => rmSync(receipt)
  }
  mutations[changed]()
  const verify = changed === 'missing_owner' ? verifyForgeExportOwner : verifyForgeExport
  const messages = { identity: 'export changed', project_id: 'export changed', checkpoint: 'export changed', database: 'export changed', portable: 'export changed', missing_project: 'project is missing', missing_database: 'database is missing', missing_owner: 'no ownership marker', receipt: 'no ownership receipt' }
  expect(() => verify(env, source.ctx().projectId)).toThrow(messages[changed])
  expect(await source.getKanbanCard({ cardId: card.id })).toEqual(before)
})
