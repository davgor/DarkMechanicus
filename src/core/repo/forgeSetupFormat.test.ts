import { expect, it } from 'vitest'
import type { ForgeRecipebook, ForgeSetupWorkflow } from '../../shared/desktop/forgeSetup'
import { encodeForgeRecipebook, encodeForgeSetupWorkflow, parseForgeRecipebook, parseForgeSetupWorkflow } from './forgeSetupFormat'

const repo = 'https://github.com/example/software.git'
const workflow: ForgeSetupWorkflow = {
  version: 1, revision: 1, repository: repo,
  detection: { detectorVersion: 1, status: 'unsupported', source: { repository: repo, commit: 'a'.repeat(40) }, facts: [], reason: 'no-node-manifest' },
  workflow: { state: 'needs-discovery', basedOn: null, steps: [
    { id: 'inspect', title: 'Read the setup guide', kind: 'instruction', instruction: 'Inspect the repository before proposing steps.' }
  ] },
  notes: 'Use the project’s existing instructions.'
}
const catalog: ForgeRecipebook = {
  version: 1, recipes: [{
    id: 'react', kind: 'scaffold', title: 'React', description: 'React starter', source: { repository: repo, commit: 'a'.repeat(40) },
    assets: [{ source: 'files/index.html', target: 'index.html', sha256: 'b'.repeat(64) }],
    steps: [{ id: 'install', title: 'Install dependencies', kind: 'command', cwd: '.', program: 'npm', args: ['ci'] }]
  }]
}

it('round trips the portable workflow and editable recipebook as ordinary YAML', () => {
  const text = encodeForgeSetupWorkflow(workflow)
  expect(text).toContain('needs-discovery')
  expect(parseForgeSetupWorkflow(text)).toEqual(workflow)
  expect(parseForgeRecipebook(encodeForgeRecipebook(catalog))).toEqual(catalog)
})

it.each([
  'notes: ordinary\nnotes: duplicate',
  'notes: &anchor ordinary',
  'notes: *anchor',
  'notes: !!str ordinary',
  '<<: {notes: merge}',
  'include: ./other.yaml',
  '---\nversion: 1',
  'notes: ' + 'a'.repeat(70_000)
])('refuses unsupported or oversized YAML without disclosing its contents', (extra) => {
  const text = encodeForgeSetupWorkflow(workflow).replace(/^notes: .+$/m, extra)
  expect(() => parseForgeSetupWorkflow(text)).toThrow(/YAML|workflow/i)
})

it.each(['../outside', 'packages/../outside', 'C:/private', 'a\\b', 'b:alternate', 'apps/CON', 'apps/trailing.'])(
  'refuses a command directory that is not safe in a portable checkout (%s)', (cwd) => {
    const value = { ...workflow, workflow: { ...workflow.workflow, steps: [
      { id: 'install', title: 'Install', kind: 'command', cwd, program: 'npm', args: ['ci'] }
    ] } }
    expect(() => parseForgeSetupWorkflow(JSON.stringify(value))).toThrow(/workflow/i)
  }
)

it.each([
  'D:/private-work/example',
  '--prefix=D:\\private-work\\example',
  '--prefix="/opt/local/example"',
  '\\\\build-host\\cache\\example',
  '//build-host/cache/example'
])('refuses machine-specific command arguments in both workflows and recipes (%s)', (argument) => {
  const [recipe] = catalog.recipes
  const steps = [{ kind: 'command' as const, id: 'install', title: 'Install', cwd: '.', program: 'npm', args: ['ci', '--prefix', argument] }]
  expect(() => parseForgeSetupWorkflow(JSON.stringify({ ...workflow, workflow: { ...workflow.workflow, steps } }))).toThrow(/workflow/i)
  expect(() => encodeForgeRecipebook({ version: 1, recipes: [{ ...recipe, steps }] })).toThrow(/recipe/i)
})

it('keeps relative arguments and HTTPS endpoints portable', () => {
  const [recipe] = catalog.recipes
  const steps = [{ kind: 'command' as const, id: 'install', title: 'Install', cwd: '.',
    program: 'npm', args: ['ci', '--prefix', './packages/app', '--registry=https://packages.example.test/npm/'] }]
  const expected = { version: 1 as const, recipes: [{ ...recipe, steps }] }
  expect(parseForgeRecipebook(encodeForgeRecipebook(expected))).toEqual(expected)
})

it('refuses credentials, raw shells, forged empty success and colliding recipe targets', () => {
  const secret = 'ghp_' + 'z'.repeat(36)
  expect(() => parseForgeSetupWorkflow(JSON.stringify({ ...workflow, notes: 'Auth ' + secret }))).toThrow(/workflow/i)
  expect(() => parseForgeSetupWorkflow(JSON.stringify({ ...workflow, notes: 'See C:/Users/sam/private.' }))).toThrow(/workflow/i)
  const shell = { id: 'install', title: 'Run', kind: 'command', cwd: '.', program: 'powershell.exe', args: ['-Command', 'echo test'] }
  expect(() => parseForgeSetupWorkflow(JSON.stringify({ ...workflow, workflow: { ...workflow.workflow, steps: [shell] } }))).toThrow(/workflow/i)
  const fake = { ...workflow.detection, status: 'detected', reason: undefined }
  expect(() => parseForgeSetupWorkflow(JSON.stringify({ ...workflow, detection: fake }))).toThrow(/workflow/i)
  const [recipe] = catalog.recipes
  const [asset] = recipe.assets
  expect(() => encodeForgeRecipebook({ version: 1, recipes: [{ ...recipe, assets: [asset, { ...asset, target: 'INDEX.HTML' }] }] })).toThrow(/recipe/i)
  expect(() => encodeForgeRecipebook({ version: 1, recipes: [{ ...recipe, assets: [asset, { ...asset, target: 'index.html/nested' }] }] })).toThrow(/recipe/i)
})
