import { expect, it } from 'vitest'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTempRepo, linkDirectory } from '../../test/tempRepo'
import { createHarness } from '../../test/workspaceHarness'
import type { ForgeSetupDetection } from '../../shared/desktop/forgeSetup'
import { loadKnowledge } from '../knowledge/load'
import { resolveLayout } from './layout'
import { nodeFs } from './nodeFs'
import {
  forgeSetupWorkflowState, readForgeRecipebook, readForgeSetupWorkflow, refreshForgeSetupWorkflow,
  saveForgeSetupWorkflow, writeForgeRecipebook
} from './forgeSetupStorage'

const repository = 'https://github.com/example/software.git'
function detected(commit: string, node: string): ForgeSetupDetection {
  return { detectorVersion: 1, status: 'detected', source: { repository, commit: commit.repeat(40) }, facts: [
    { kind: 'node', value: node, source: '.nvmrc' }
  ] }
}

it('preserves authored workflow, comments and guide across pinned evidence refreshes', () => {
  const temp = createTempRepo()
  try {
    mkdirSync(temp.layout.dmDir)
    expect(readForgeSetupWorkflow(temp.layout)).toBeNull()
    const initial = refreshForgeSetupWorkflow(temp.layout, repository, detected('a', '22'))
    expect(forgeSetupWorkflowState(initial)).toBe('needs-discovery')
    const configured = saveForgeSetupWorkflow(temp.layout, {
      expectedSha256: initial.sha256, notes: 'Use the team’s package registry.', workflow: { state: 'configured', steps: [
        { id: 'install', title: 'Install dependencies', kind: 'command', cwd: '.', program: 'npm', args: ['ci'] }
      ] }
    })
    expect(forgeSetupWorkflowState(configured)).toBe('configured')
    const path = join(temp.layout.knowledgeDir, 'forge-setup', 'workflow.yaml')
    const guide = join(temp.layout.knowledgeDir, 'forge-setup', 'guide.md')
    writeFileSync(path, '# Keep this comment\n' + readFileSync(path, 'utf8'))
    writeFileSync(guide, readFileSync(guide, 'utf8') + '\nTeam setup notes.\n')
    const same = readForgeSetupWorkflow(temp.layout)!
    const mtime = statSync(path, { bigint: true }).mtimeNs
    expect(refreshForgeSetupWorkflow(temp.layout, repository, detected('a', '22'))).toEqual(same)
    expect(statSync(path, { bigint: true }).mtimeNs).toBe(mtime)
    const advanced = refreshForgeSetupWorkflow(temp.layout, repository, detected('b', '22'))
    expect(advanced.sha256).not.toBe(same.sha256)
    expect(forgeSetupWorkflowState(advanced)).toBe('configured')
    const changed = refreshForgeSetupWorkflow(temp.layout, repository, detected('c', '24'))
    expect(forgeSetupWorkflowState(changed)).toBe('stale')
    expect(changed.value).toMatchObject({ notes: configured.value.notes, workflow: configured.value.workflow })
    expect(readFileSync(path, 'utf8')).toContain('# Keep this comment')
    const knowledge = loadKnowledge({ layout: temp.layout, fs: nodeFs, homeDir: temp.outside })
    expect(knowledge.diagnostics.filter((item) => item.layer === 'repo')).toEqual([])
    expect(knowledge.facts.find((fact) => fact.id === 'forge.setup.workflow')).toMatchObject({
      body: expect.stringContaining('Team setup notes.'),
      scope: { roles: ['planner', 'worker', 'orchestrator', 'reviewer'] }
    })
    expect(() => saveForgeSetupWorkflow(temp.layout, { expectedSha256: same.sha256, workflow: configured.value.workflow })).toThrow(/changed/i)
    const unavailable = refreshForgeSetupWorkflow(temp.layout, repository, {
      detectorVersion: 1, status: 'unavailable', source: null, facts: [], reason: 'source-unavailable'
    })
    expect(unavailable.value.detection).toMatchObject({
      status: 'unavailable',
      source: changed.value.detection.source,
      facts: changed.value.detection.facts
    })
  } finally { temp.cleanup() }
})

it('refuses a linked knowledge directory and leaves its target untouched', () => {
  const temp = createTempRepo()
  try {
    mkdirSync(temp.layout.dmDir)
    linkDirectory(temp.outside, temp.layout.knowledgeDir)
    expect(() => refreshForgeSetupWorkflow(temp.layout, repository, detected('a', '22'))).toThrow(/unsafe/i)
    expect(readdirSync(temp.outside)).toEqual([])
  } finally { temp.cleanup() }
})

it('preserves a legacy world and makes recipebook edits compare-and-swap by file bytes', () => {
  const temp = createTempRepo()
  try {
    const manifest = JSON.stringify({ version: 1, owner: 'example', projects: [], syncMinutes: 10 })
    const manifestFile = join(temp.root, 'forge-world.json')
    writeFileSync(manifestFile, manifest)
    expect(readForgeRecipebook(temp.root)).toBeNull()
    expect(readdirSync(temp.root)).toEqual(['forge-world.json'])

    const initial = writeForgeRecipebook(temp.root, null, { version: 1, recipes: [] })
    const book = {
      version: 1 as const,
      recipes: [{
        id: 'manual-app', kind: 'world' as const, title: 'Manual app', description: 'An individually prepared application',
        source: { repository, commit: 'd'.repeat(40) }, assets: [], steps: []
      }]
    }
    const updated = writeForgeRecipebook(temp.root, initial.sha256, book)
    expect(updated).toEqual(readForgeRecipebook(temp.root))
    expect(() => writeForgeRecipebook(temp.root, initial.sha256, initial.value)).toThrow(/changed/i)
    expect(readFileSync(manifestFile, 'utf8')).toBe(manifest)
  } finally { temp.cleanup() }
})

it('copies exact authored setup knowledge through a Forge export and database-only restore', async () => {
  const harness = createHarness()
  try {
    const source = harness.open('desktop', { transport: 'desktop', mode: 'repo' })
    await source.initializeRepository({ name: 'Portable setup fixture' })
    const sourceLayout = resolveLayout(harness.root)
    const configured = refreshForgeSetupWorkflow(sourceLayout, repository, detected('a', '22'))
    const sourceGuide = join(sourceLayout.knowledgeDir, 'forge-setup', 'guide.md')
    const guide = readFileSync(sourceGuide, 'utf8') + '\nAn original team decision.\n'
    writeFileSync(sourceGuide, guide)

    const member = join(harness.homeDir, 'World', 'Member')
    const restored = join(harness.homeDir, 'code')
    mkdirSync(member, { recursive: true })
    mkdirSync(restored)
    source.exportForge!(member, 'repo')
    source.close()
    expect(readForgeSetupWorkflow(member)).toEqual(configured)
    const placement = harness.open('desktop', { root: member, transport: 'desktop', mode: 'repo' })
    placement.exportForge!(restored, 'db')
    placement.close()
    const restoredLayout = resolveLayout(restored, { mode: 'db', homeDir: harness.homeDir })
    expect(readForgeSetupWorkflow(restoredLayout)).toEqual(configured)
    expect(readFileSync(join(restoredLayout.knowledgeDir, 'forge-setup', 'guide.md'), 'utf8')).toBe(guide)
  } finally { harness.cleanup() }
})
