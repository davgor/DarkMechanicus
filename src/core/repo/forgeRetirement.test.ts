import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { withForgeTransfer } from './forgeBinding'
import { archiveRetiredForgeStore, retireForcedStore } from './forgeRetirement'

let h: Harness
beforeEach(() => { h = createHarness() })
afterEach(() => h.cleanup())

async function exported() {
  const source = h.open('desktop', { transport: 'desktop', mode: 'repo' })
  await source.initializeRepository({ name: 'Retirement integrity' })
  const card = await source.createKanbanCard({ title: 'Keep original canonical content' })
  const member = join(h.homeDir, 'Member')
  mkdirSync(member)
  await withForgeTransfer(h.homeDir, h.root, member, async () => source.exportForge!(member, 'repo', { force: true }))
  const backup = join(member, '.darkmechanicus/local/pre-forge-source')
  return { source, member, backup, card }
}

it.each(['source', 'mode'] as const)('refuses a mismatched retirement %s without altering the private backup', async mismatch => {
  const f = await exported()
  retireForcedStore(h.homeDir, h.root, f.member, 'repo')
  const receipt = join(f.backup, 'local/retirement.json')
  if (mismatch === 'source') {
    const value = JSON.parse(readFileSync(receipt, 'utf8'))
    value.source = join(h.homeDir, 'Other source')
    writeFileSync(receipt, JSON.stringify(value))
  }
  const before = readFileSync(join(f.backup, 'kanban', f.card.id, 'card.json'), 'utf8')
  expect(() => retireForcedStore(h.homeDir, h.root, f.member, mismatch === 'mode' ? 'db' : 'repo')).toThrow(mismatch === 'source' ? 'another source' : 'different storage mode')
  expect(readFileSync(join(f.backup, 'kanban', f.card.id, 'card.json'), 'utf8')).toBe(before)
  expect(existsSync(join(h.root, '.darkmechanicus/local/state.sqlite'))).toBe(true)
})

it('preserves both copies when a portable backup path already exists', async () => {
  const f = await exported()
  const protectedFile = join(f.backup, 'kanban/protected.txt')
  mkdirSync(join(f.backup, 'kanban'), { recursive: true })
  writeFileSync(protectedFile, 'Existing backup data')
  const sourceRecord = join(h.root, '.darkmechanicus/kanban', f.card.id, 'card.json')
  const before = readFileSync(sourceRecord, 'utf8')
  expect(() => retireForcedStore(h.homeDir, h.root, f.member, 'repo')).toThrow('Both original and backup')
  expect(readFileSync(protectedFile, 'utf8')).toBe('Existing backup data')
  expect(readFileSync(sourceRecord, 'utf8')).toBe(before)
})

it.each(['marker', 'missing marker', 'archive', 'backup', 'backup database'] as const)('keeps the retired original when restore finds an invalid %s', async invalid => {
  const f = await exported()
  retireForcedStore(h.homeDir, h.root, f.member, 'repo')
  f.source.close()
  if (invalid === 'marker') writeFileSync(join(h.root, '.darkmechanicus/local/forge-retired.json'), JSON.stringify({ member: '/other' }))
  else if (invalid === 'missing marker') rmSync(join(h.root, '.darkmechanicus/local/forge-retired.json'))
  else if (invalid === 'archive') mkdirSync(join(f.backup, 'local/retired-open-store'))
  else if (invalid === 'backup database') rmSync(join(f.backup, 'local/state.sqlite'))
  else rmSync(join(f.backup, 'project.json'))
  const message = invalid === 'archive' ? 'archive already exists' : invalid.startsWith('backup') ? 'backup is incomplete' : 'already contains a ticket store'
  expect(() => archiveRetiredForgeStore(h.homeDir, h.root, f.member)).toThrow(message)
  expect(existsSync(join(h.root, '.darkmechanicus/local/state.sqlite'))).toBe(true)
  expect(existsSync(join(f.backup, 'local/state.sqlite'))).toBe(invalid !== 'backup database')
})

it('resumes after the retained physical store was already archived without moving it again', async () => {
  const f = await exported()
  retireForcedStore(h.homeDir, h.root, f.member, 'repo')
  f.source.close()
  archiveRetiredForgeStore(h.homeDir, h.root, f.member)
  const archived = join(f.backup, 'local/retired-open-store/local/state.sqlite')
  const before = readFileSync(archived)
  expect(() => archiveRetiredForgeStore(h.homeDir, h.root, f.member)).not.toThrow()
  expect(readFileSync(archived)).toEqual(before)
  expect(existsSync(join(h.root, '.darkmechanicus'))).toBe(false)
})
