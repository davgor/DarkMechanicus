import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { openDatabase } from '../db/database'
import { verifyForgeExport, verifyForgeExportOwner } from './forgeExportReceipt'
import { pendingForgeTransfer, withForgeTransfer } from './forgeBinding'
import { forgeSetupWorkflowState, readForgeSetupWorkflow, refreshForgeSetupWorkflow, saveForgeSetupWorkflow } from './forgeSetupStorage'
import { resolveLayout } from './layout'
import { nodeFs } from './nodeFs'
import type { ForgeSetupDetection } from '../../shared/desktop/forgeSetup'

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

it('includes refreshed setup evidence and authored steps in the original force export receipt', async () => {
  const source = h.open('desktop', { mode: 'repo', transport: 'desktop' })
  await source.initializeRepository({ name: 'Setup conversion' })
  const repository = 'https://github.com/example/setup.git'
  const detection: ForgeSetupDetection = { detectorVersion: 1, status: 'detected', source: { commit: '1'.repeat(40), repository },
    facts: [{ kind: 'node', source: '.node-version', value: '22' }] }
  const first = refreshForgeSetupWorkflow(h.root, repository, detection)
  const steps = [{ kind: 'command' as const, id: 'setup', title: 'Install confirmed files', program: 'npm', cwd: '.', args: ['ci'] }]
  const authored = saveForgeSetupWorkflow(h.root, { expectedSha256: first.sha256, workflow: { state: 'configured', steps }, notes: 'Keep this review' })
  const member = join(h.homeDir, 'Setup')
  mkdirSync(member)
  await withForgeTransfer(h.homeDir, h.root, member, async () => source.exportForge!(member, 'repo', { force: true,
    setup: { repository, detection: { ...detection, source: { commit: '2'.repeat(40), repository }, facts: [{ kind: 'node', source: '.node-version', value: '24' }] } }
  }))
  expect(() => verifyForgeExport({ fs: nodeFs, layout: resolveLayout(member), source: h.root }, source.ctx().projectId)).not.toThrow()
  const moved = readForgeSetupWorkflow(member)
  expect(moved?.value).toMatchObject({ workflow: { steps }, notes: 'Keep this review', detection: { facts: [{ value: '24' }] } })
  expect(forgeSetupWorkflowState(moved)).toBe('stale')
  const path = join(resolveLayout(member).knowledgeDir, 'forge-setup', 'workflow.yaml')
  const prepared = readFileSync(path, 'utf8')
  writeFileSync(path, '# Changed after the prepared receipt\n' + prepared)
  expect(() => verifyForgeExport({ fs: nodeFs, layout: resolveLayout(member), source: h.root }, source.ctx().projectId)).toThrow(/export changed/i)
  expect(readFileSync(path, 'utf8')).toContain('Changed after the prepared receipt')
  expect(readForgeSetupWorkflow(h.root)).toEqual(authored)
})

it.each([
  { evidenceFromOtherRepository: true, message: 'evidence belongs to a different code repository' },
  { evidenceFromOtherRepository: false, message: 'workflow belongs to a different code repository' }
])('discards only unpublished force-export staging when $message', async ({ evidenceFromOtherRepository, message }) => {
  const source = h.open('desktop', { mode: 'repo', transport: 'desktop' })
  await source.initializeRepository({ name: 'Preserve reviewed setup' })
  const card = await source.createKanbanCard({ title: 'Keep the existing ticket' })
  const repository = 'https://github.com/example/setup.git'
  const other = 'https://github.com/example/other.git'
  const detection: ForgeSetupDetection = { detectorVersion: 1, status: 'detected', source: { commit: '1'.repeat(40), repository },
    facts: [{ kind: 'node', source: '.node-version', value: '22' }] }
  const first = refreshForgeSetupWorkflow(h.root, repository, detection)
  const authored = saveForgeSetupWorkflow(h.root, { expectedSha256: first.sha256, notes: 'Reviewed by the team',
    workflow: { state: 'configured', steps: [{ kind: 'command', id: 'setup', title: 'Install', program: 'npm', cwd: '.', args: ['ci'] }] } })
  const guidePath = join(resolveLayout(h.root).knowledgeDir, 'forge-setup', 'guide.md')
  const guide = readFileSync(guidePath, 'utf8') + '\nOur team has approved this guide.\n'
  writeFileSync(guidePath, guide)
  const member = join(h.homeDir, 'Setup')
  mkdirSync(member)
  const alongside = join(member, 'review.txt')
  writeFileSync(alongside, 'Existing destination notes')

  const offered = { ...detection, source: { commit: '2'.repeat(40), repository: other } }
  await expect(withForgeTransfer(h.homeDir, h.root, { target: member, force: true }, async () => source.exportForge!(member, 'repo', {
    force: true, setup: { repository: evidenceFromOtherRepository ? repository : other, detection: offered }
  }))).rejects.toMatchObject({ code: 'project_mismatch', message: expect.stringContaining(message) })

  expect(readdirSync(member)).toEqual(['review.txt'])
  expect(readFileSync(alongside, 'utf8')).toBe('Existing destination notes')
  expect(pendingForgeTransfer(h.homeDir, h.root)).toBeNull()
  expect(readForgeSetupWorkflow(h.root)).toEqual(authored)
  expect(readFileSync(guidePath, 'utf8')).toBe(guide)
  expect(await source.getKanbanCard({ cardId: card.id })).toMatchObject({ id: card.id, title: 'Keep the existing ticket' })
})
