import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { scratchDir } from '../../test/gitScratch'
import { bundledForgeRecipes, materializeForgeScaffold, verifyForgeScaffold } from './forgeScaffold'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
const context = { name: 'new-crud', repository: 'https://github.com/example/new-crud.git' }

function target() {
  const scratch = scratchDir('dm-forge-assets-')
  cleanups.push(scratch.cleanup)
  const path = join(scratch.path, 'project')
  mkdirSync(path)
  return path
}

it('materializes the pinned React tree, rewriting repository metadata and leaving copied workflow and host hooks inert', async () => {
  const path = target()
  const react = bundledForgeRecipes().recipes.find(recipe => recipe.id === 'boosterseat-react')!
  await materializeForgeScaffold(path, react, context)
  expect(JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))).toMatchObject({
    name: context.name, repository: { url: context.repository }, scripts: { build: expect.stringContaining('vite') }
  })
  expect(existsSync(join(path, 'src', 'App.tsx'))).toBe(true)
  expect(existsSync(join(path, 'scripts', 'check-darkmechanicus.mjs'))).toBe(true)
  expect(existsSync(join(path, '.github', 'workflow-templates', 'pr-checks.yml'))).toBe(true)
  for (const blocked of ['.git', '.darkmechanicus', 'board', '.husky', '.github/workflows', '.claude/settings.json', '.cursor/environment.json']) {
    expect(existsSync(join(path, blocked))).toBe(false)
  }
})

it('refuses changed, undeclared, duplicate and escaping scaffold assets before writing any code', async () => {
  const path = target()
  const react = bundledForgeRecipes().recipes.find(recipe => recipe.id === 'boosterseat-react')!
  const [asset, ...remaining] = react.assets
  for (const assets of [
    [{ ...asset!, sha256: '0'.repeat(64) }, ...remaining],
    [{ ...asset!, source: 'arbitrary.txt' }, ...remaining],
    [asset!, asset!, ...remaining],
    [{ ...asset!, target: '../outside.txt' }, ...remaining]
  ]) {
    expect(() => verifyForgeScaffold({ ...react, assets })).toThrow()
  }
  expect(existsSync(join(path, 'package.json'))).toBe(false)
})

it('includes a real pending Electron conversion procedure without installing when seeded', async () => {
  const path = target()
  const desktop = bundledForgeRecipes().recipes.find(recipe => recipe.id === 'boosterseat-electron')!
  await materializeForgeScaffold(path, desktop, context)
  expect(desktop.kind).toBe('conversion')
  expect(desktop.steps).toContainEqual(expect.objectContaining({ kind: 'command', program: 'node', args: ['scripts/enable-electron.mjs'] }))
  expect(readFileSync(join(path, 'templates', 'electron', 'starter', 'main.ts'), 'utf8')).toContain('contextIsolation: true')
  expect(existsSync(join(path, 'scripts', 'enable-electron.mjs'))).toBe(true)
  expect(existsSync(join(path, 'electron.vite.config.ts'))).toBe(false)
  expect(existsSync(join(path, 'node_modules'))).toBe(false)
})
