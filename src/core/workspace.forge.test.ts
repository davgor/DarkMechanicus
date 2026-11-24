import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createHarness, TEST_STORAGE, type Harness } from '../test/workspaceHarness'
import { assertForgeTransferIdle, bindForge, boundForgeRoot, FORGE_POINTER, isForgeMember, pendingForgeTransfer, withForgeTransfer } from './repo/forgeBinding'
import { nodeFs } from './repo/nodeFs'
import { dbProjectDir, SQLITE_STANDARDS_FILE } from './repo/storageMode'
import { baselineDeliveryPolicy, defaultPrompts } from '../shared/domain/standardsPrompts'
import { openWorkspace } from './workspace'
import { bindToolingGrant, holdToolingWorkflow, retireToolingWorkflow } from './services/toolingHold'

let h: Harness
beforeEach(() => { h = createHarness() })
afterEach(() => h.cleanup())

it('preserves ticket identity and opens a bound code project through its pointer', async () => {
  const source = h.open('desktop', { transport: 'desktop', mode: 'db' })
  await source.initializeRepository({ name: 'Source' })
  const policy = await source.setDeliveryStandards({ expectedRevision: 0, policy: baselineDeliveryPolicy })
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
  const workspace = openWorkspace({ repoRoot: h.root, homeDir: h.homeDir, transport: 'desktop', role: 'desktop', label: 'Forge fixture', serverInfo: { name: 'fixture', version: '1' }, ...TEST_STORAGE })
  try {
    expect(workspace.repoRoot).toBe(member)
    expect((await workspace.getProject()).deliveryStandards).toEqual(policy)
    expect(JSON.parse(readFileSync(join(member, '.darkmechanicus/project.json'), 'utf8')).deliveryStandards).toEqual(policy)
    expect((await workspace.getKanbanCard({ cardId: card.id })).title).toBe('One shared card')
    const exported = join(member, '.darkmechanicus', 'kanban', card.id, 'card.json')
    expect(existsSync(exported)).toBe(true)
    expect(readFileSync(exported, 'utf8')).toContain(card.id)
    expect(readFileSync(join(member, '.darkmechanicus/knowledge/design/decisions.md'), 'utf8')).toBe('Keep the original design.')
    expect(JSON.parse(readFileSync(join(member, '.darkmechanicus/local/source-checkout.json'), 'utf8'))).toEqual({ checkout: h.root })
    const grant = await workspace.issueGrant({ role: 'planner', label: 'Bound Forge planner' })
    bindToolingGrant(workspace.ctx(), grant.grant.id, 'chat_forge')
    holdToolingWorkflow(workspace.ctx(), { id: 'chat_forge', incidentId: 'forge_incident' })
    const planner = openWorkspace({ repoRoot: h.root, homeDir: h.homeDir, transport: 'cli', role: 'planner', label: 'Bound planner', grantToken: grant.token, ...TEST_STORAGE })
    try {
      expect(planner.repoRoot).toBe(member)
      expect((await planner.getKanbanCard({ cardId: card.id })).title).toBe('One shared card')
      await expect(planner.createKanbanCard({ title: 'Blocked while repairing' })).rejects.toMatchObject({ code: 'invalid_state' })
      retireToolingWorkflow(workspace.ctx(), 'chat_forge')
      expect((await planner.createKanbanCard({ title: 'After human retirement' })).title).toBe('After human retirement')
    } finally { planner.close() }
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

it('honors another live process holding a conversion and recovers the journal after its owner exits', async () => {
  const { homeDir, root } = h
  const member = join(homeDir, 'Forge', 'Project')
  await expect(withForgeTransfer(homeDir, root, member, async (_phase, advance) => {
    advance(1)
    throw new Error('suspended')
  })).rejects.toThrow('suspended')
  const journals = join(homeDir, 'forge-bindings')
  const file = join(journals, readdirSync(journals).find(f => f.endsWith('.move.json'))!)
  const journal = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...journal, pid: process.ppid }))
  await expect(withForgeTransfer(homeDir, root, member, async () => null)).rejects.toThrow('owns this conversion')
  const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
  expect(exited.status).toBe(0)
  writeFileSync(file, JSON.stringify({ ...journal, pid: exited.pid }))
  expect(await withForgeTransfer(homeDir, root, member, async phase => phase)).toBe(1)
  expect(existsSync(file)).toBe(false)
})

it('isolates revisions and the edited prompt across two projects in a cloned Forge World', async () => {
  const world = join(h.root, 'world')
  const paths = ['First', 'Second'].map(name => join(world, name))
  paths.forEach(path => mkdirSync(path, { recursive: true }))
  writeFileSync(join(world, 'forge-world.json'), JSON.stringify({ version: 1, projects: [{ folder: 'First' }, { folder: 'Second' }] }))
  const [first, second] = paths.map(root => h.open('desktop', { root, mode: 'repo' }))
  const policy = { ...baselineDeliveryPolicy, setupDecision: 'defaults' as const }
  for (const w of [first, second]) {
    await w.initializeRepository({})
    await w.setDeliveryStandards({ expectedRevision: 0, policy })
  }
  const custom = { ...policy, setupDecision: 'edited' as const, prompts: { ...defaultPrompts, ticket: 'Test the checkout flow with the bank simulator.' } }
  await first.setDeliveryStandards({ expectedRevision: 1, policy: custom })
  first.close()
  second.close()
  const reopened = paths.map(root => h.open('desktop', { root: h.cloneTracked(root) }))
  expect((await reopened[0].getProject()).deliveryStandards).toEqual({ revision: 2, policy: custom })
  expect((await reopened[1].getProject()).deliveryStandards).toEqual({ revision: 1, policy })
})

it.each(['db', 'repo'] as const)('exports a configured Forge member to %s with standards in the destination store', async mode => {
  const member = h.open('desktop', { mode: 'repo', transport: 'desktop' })
  await member.initializeRepository({ name: 'Forge member' })
  const policy = { ...baselineDeliveryPolicy, prompts: { ...defaultPrompts, epic: 'Review stability evidence' }, setupDecision: 'agent' as const }
  const approved = await member.setDeliveryStandards({ expectedRevision: 0, policy })
  const dest = join(h.homeDir, 'restored-code')
  mkdirSync(dest)
  member.exportForge!(dest, mode)
  const sidecar = join(dest, SQLITE_STANDARDS_FILE)
  if (mode === 'db') {
    expect(JSON.parse(readFileSync(sidecar, 'utf8')).standards).toEqual(approved)
    expect(existsSync(join(dest, '.darkmechanicus'))).toBe(false)
  } else {
    expect(existsSync(sidecar)).toBe(false)
    expect(JSON.parse(readFileSync(join(dest, '.darkmechanicus/project.json'), 'utf8')).deliveryStandards).toEqual(approved)
  }
})
