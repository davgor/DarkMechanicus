import { expect, it } from 'vitest'
import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTempRepo, linkDirectory } from '../../test/tempRepo'
import { createHarness } from '../../test/workspaceHarness'
import { gitIn } from '../../test/gitScratch'
import type { ForgeSetupDetection } from '../../shared/desktop/forgeSetup'
import { loadKnowledge } from '../knowledge/load'
import { FORGE_RECIPEBOOK_BYTES } from './forgeSetupFormat'
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

it('shows a missing workflow without materializing setup files or permitting a blind save', () => {
  const temp = createTempRepo()
  try {
    expect(readForgeSetupWorkflow(temp.root)).toBeNull()
    expect(forgeSetupWorkflowState(readForgeSetupWorkflow(temp.root))).toBe('missing')
    expect(() => saveForgeSetupWorkflow(temp.root, {
      expectedSha256: '0'.repeat(64), workflow: { state: 'needs-discovery', steps: [] }
    })).toThrow(expect.objectContaining({ code: 'conflict' }))
    expect(readdirSync(temp.root)).toEqual([])
  } finally { temp.cleanup() }
})

it('reopens a reviewed workflow as a draft and preserves its authored details on an unchanged save', () => {
  const temp = createTempRepo()
  try {
    mkdirSync(temp.layout.dmDir)
    const original = refreshForgeSetupWorkflow(temp.root, repository, detected('a', '22'))
    const steps = [{ id: 'install', title: 'Install dependencies', kind: 'command' as const, cwd: '.', program: 'npm', args: ['ci'] }]
    const configured = saveForgeSetupWorkflow(temp.root, {
      expectedSha256: original.sha256, notes: 'Retain this team choice.', workflow: { state: 'configured', steps }
    })
    const draft = { state: 'needs-discovery' as const, steps }
    const reopened = saveForgeSetupWorkflow(temp.root, { expectedSha256: configured.sha256, workflow: draft })
    expect(reopened.value).toMatchObject({ revision: configured.value.revision + 1, notes: 'Retain this team choice.',
      workflow: { ...draft, basedOn: null } })
    expect(forgeSetupWorkflowState(reopened)).toBe('needs-discovery')
    const path = join(temp.layout.knowledgeDir, 'forge-setup', 'workflow.yaml')
    const external = '# Keep this reviewed comment.\n' + readFileSync(path, 'utf8')
    writeFileSync(path, external)
    const current = readForgeSetupWorkflow(temp.root)!
    expect(saveForgeSetupWorkflow(temp.root, { expectedSha256: current.sha256, workflow: draft })).toEqual(current)
    expect(readFileSync(path, 'utf8')).toBe(external)
  } finally { temp.cleanup() }
})

it('does not overwrite setup knowledge when evidence or the target identifies another repository', () => {
  const temp = createTempRepo()
  try {
    mkdirSync(temp.layout.dmDir)
    const original = refreshForgeSetupWorkflow(temp.root, repository, detected('a', '22'))
    const other = 'https://github.com/example/other.git'
    const evidence = detected('b', '24')
    const otherEvidence = { ...evidence, source: { repository: other, commit: 'b'.repeat(40) } }
    expect(() => refreshForgeSetupWorkflow(temp.root, repository, otherEvidence)).toThrow(/evidence belongs/i)
    expect(() => refreshForgeSetupWorkflow(temp.root, other, otherEvidence)).toThrow(/workflow belongs/i)
    expect(readForgeSetupWorkflow(temp.root)).toEqual(original)
    expect(readdirSync(temp.layout.localDir)).toEqual([])
  } finally { temp.cleanup() }
})

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

it('refuses a linked Forge World root and portable files hardlinked outside the world', () => {
  const temp = createTempRepo()
  try {
    const book = { version: 1 as const, recipes: [] }
    const initial = writeForgeRecipebook(temp.root, null, book)
    const alias = join(temp.base, 'alias')
    linkDirectory(temp.root, alias)
    expect(() => readForgeRecipebook(alias)).toThrow(expect.objectContaining({ code: 'unsafe_path' }))
    expect(readForgeRecipebook(temp.root)).toEqual(initial)

    const path = join(temp.root, 'forge-recipes.yaml')
    const original = readFileSync(path)
    const outside = join(temp.outside, 'original.yaml')
    linkSync(path, outside)
    expect(() => readForgeRecipebook(temp.root)).toThrow(expect.objectContaining({ code: 'unsafe_path' }))
    expect(() => writeForgeRecipebook(temp.root, initial.sha256, book)).toThrow(expect.objectContaining({ code: 'unsafe_path' }))
    expect(readFileSync(outside)).toEqual(original)
  } finally { temp.cleanup() }
})

it.each([
  { bytes: Buffer.alloc(FORGE_RECIPEBOOK_BYTES + 1, '#'), code: 'response_too_large' },
  { bytes: Buffer.from([0xc3, 0x28]), code: 'invalid_input' }
])('refuses a $code portable file and preserves its exact bytes on save', ({ bytes, code }) => {
  const temp = createTempRepo()
  try {
    const path = join(temp.root, 'forge-recipes.yaml')
    writeFileSync(path, bytes)
    expect(() => readForgeRecipebook(temp.root)).toThrow(expect.objectContaining({ code }))
    expect(() => writeForgeRecipebook(temp.root, null, { version: 1, recipes: [] })).toThrow(expect.objectContaining({ code }))
    expect(readFileSync(path)).toEqual(bytes)
    expect(readdirSync(temp.root)).toEqual(['forge-recipes.yaml'])
  } finally { temp.cleanup() }
})

it('resumes a workflow write after an interrupted writer leaves incomplete private files', () => {
  const temp = createTempRepo()
  try {
    mkdirSync(temp.layout.localDir, { recursive: true })
    const interrupted = ['forge-setup-guide.md.lock', 'forge-setup-workflow.yaml.lock'].map((name) => join(temp.layout.localDir, name))
    for (const path of interrupted) writeFileSync(path, 'incomplete write from a stopped process')

    const initial = refreshForgeSetupWorkflow(temp.layout, repository, detected('a', '22'))
    const refreshed = refreshForgeSetupWorkflow(temp.layout, repository, detected('b', '24'))
    expect(refreshed.value.detection).toEqual(detected('b', '24'))
    expect(readForgeSetupWorkflow(temp.layout)).toEqual(refreshed)
    expect(() => saveForgeSetupWorkflow(temp.layout, {
      expectedSha256: initial.sha256, workflow: initial.value.workflow
    })).toThrow(/changed/i)
    for (const path of interrupted) expect(readFileSync(path, 'utf8')).toBe('incomplete write from a stopped process')
    expect(readdirSync(temp.layout.localDir).sort()).toEqual(['forge-setup-guide.md.lock', 'forge-setup-workflow.yaml.lock'])
  } finally { temp.cleanup() }
})

it('keeps abandoned recipebook write artifacts private in an actual linked Git worktree', () => {
  const temp = createTempRepo()
  try {
    gitIn(temp.root, 'init', '-q', '--initial-branch=main')
    writeFileSync(join(temp.root, '.gitignore'), '**/.darkmechanicus/local/\n')
    gitIn(temp.root, 'add', '.gitignore')
    gitIn(temp.root, 'commit', '-qm', 'Initialize world')
    gitIn(temp.root, 'worktree', 'add', '--detach', temp.outside)

    const privateDir = resolveLayout(temp.outside).localDir
    mkdirSync(privateDir, { recursive: true })
    const artifact = 'forge-setup-forge-recipes.yaml.01234567-89ab-4def-8123-456789abcdef.tmp'
    writeFileSync(join(privateDir, artifact), 'abandoned private recipebook bytes')
    const initial = writeForgeRecipebook(temp.outside, null, { version: 1, recipes: [] })
    expect(initial).toEqual(readForgeRecipebook(temp.outside))
    expect(readdirSync(privateDir)).toEqual([artifact])
    expect(gitIn(temp.outside, 'status', '--porcelain', '--untracked-files=all').trim()).toBe('?? forge-recipes.yaml')

    const originalPrivateDir = join(temp.base, 'previous-local')
    renameSync(privateDir, originalPrivateDir)
    linkDirectory(originalPrivateDir, privateDir)
    expect(() => writeForgeRecipebook(temp.outside, initial.sha256, {
      version: 1, recipes: [{
        id: 'custom', kind: 'world', title: 'Custom', description: 'An authored recipe',
        source: { repository, commit: 'd'.repeat(40) }, assets: [], steps: []
      }]
    })).toThrow(/unsafe/i)
    expect(readForgeRecipebook(temp.outside)).toEqual(initial)
    expect(readdirSync(originalPrivateDir)).toEqual([artifact])
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
    const path = join(temp.root, 'forge-recipes.yaml')
    const withComment = '# Keep this reader note.\n' + readFileSync(path, 'utf8')
    writeFileSync(path, withComment)
    const current = readForgeRecipebook(temp.root)!
    expect(writeForgeRecipebook(temp.root, current.sha256, book)).toEqual(current)
    expect(readFileSync(path, 'utf8')).toBe(withComment)
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
