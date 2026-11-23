import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeTerminalFiles } from '../terminals/terminalFiles'
import { createForge, updateForge } from './forgeManifest'
import { forgeAgentContext, forgeReachFolders } from './forgeContext'
import { ensureForgeDirections, FORGE_DIRECTIONS } from './forgeDirections'

let root: string
let member: string
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-forge-context-')))
  member = join(root, 'Tickets')
  mkdirSync(member)
  createForge(root, 'example')
  updateForge(root, world => world.projects.push({ folder: 'Tickets', repository: 'example/source-code' }))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('writes ordinary root and member terminal instructions without cloning code or requiring a local binding', async () => {
  ensureForgeDirections(root)
  const guide = join(root, FORGE_DIRECTIONS)
  const applicationData = join(root, 'fixture-user-data')
  for (const folder of [root, member]) {
    const world = folder === root
    const cli = {
      command: process.execPath,
      args: [join(applicationData, 'cli.js'), ...(world ? [] : ['--repo', member])],
      env: {}
    }
    const files = await writeTerminalFiles({
      userData: applicationData, chatId: world ? 'ch_world' : 'ch_member', platform: 'win32', folder,
      cli, role: 'planner', allowSave: false, orchestratesRun: false, ...(world ? { reach: [] } : {})
    })
    const text = readFileSync(files.instructions, 'utf8')
    expect(text).toContain('https://github.com/example/source-code.git')
    expect(text).toContain(JSON.stringify(member))
    expect(text).toContain('only when the task needs its code')
    expect(text).toContain('outside the Forge World')
    expect(text).toContain('git clone --')
    expect(text).toContain(JSON.stringify(guide))
    expect(text).toContain('forge-recipes.yaml')
    expect(text).toContain('<member>/.darkmechanicus/knowledge/forge-setup/workflow.yaml')
    expect(text).toContain('Delivery Standards')
    expect(text).not.toContain('Local code checkout:')
  }
  expect(readFileSync(guide, 'utf8')).toContain('forge-recipes.yaml')
  expect(existsSync(join(root, 'source-code'))).toBe(false)
  expect(existsSync(join(root, '.darkmechanicus'))).toBe(false)
})

describe('Forge agent repository context', () => {
  it('uses a valid machine-local checkout hint, ignores a stale or ticket-store hint, and never exports it', () => {
    const checkout = join(root, '..', 'code-' + root.split(/[\\/]/).at(-1))
    mkdirSync(checkout)
    const local = join(member, '.darkmechanicus', 'local')
    mkdirSync(local, { recursive: true })
    const binding = join(local, 'source-checkout.json')
    try {
      writeFileSync(binding, JSON.stringify({ checkout }))
      expect(forgeAgentContext(member)).toContain('Local code checkout: ' + JSON.stringify(realpathSync.native(checkout)))
      writeFileSync(binding, JSON.stringify({ checkout: join(checkout, 'missing') }))
      expect(forgeAgentContext(member)).not.toContain('Local code checkout:')
      writeFileSync(binding, JSON.stringify({ checkout: member }))
      expect(forgeAgentContext(member)).not.toContain('Local code checkout:')
      ensureForgeDirections(root)
      expect(readFileSync(join(root, FORGE_DIRECTIONS), 'utf8')).not.toContain(checkout)
    } finally { rmSync(checkout, { recursive: true, force: true }) }
  })

  it('scopes root reach to available tracked member paths, keeping a member pinned and an empty world empty', () => {
    const unrelated = join(root, 'unrelated')
    mkdirSync(unrelated)
    expect(forgeReachFolders(root, [member, unrelated])).toEqual([member])
    expect(forgeReachFolders(member, [member, unrelated])).toBeUndefined()
    expect(forgeReachFolders(root, [unrelated])).toEqual([])
  })

  it('ships portable directions that always refer to the current manifest instead of stale copied links', () => {
    ensureForgeDirections(root)
    const first = readFileSync(join(root, FORGE_DIRECTIONS), 'utf8')
    expect(first).toContain('forge-world.json')
    expect(first).toContain('repository')
    expect(first).toContain('only when the task needs its code')
    updateForge(root, world => { world.projects = [] })
    ensureForgeDirections(root)
    expect(readFileSync(join(root, FORGE_DIRECTIONS), 'utf8')).toBe(first)
    expect(first).not.toContain(root)
  })
})

it('confines conflict fallback to canonical direct members supplied by the desktop and still tracked', () => {
  const nested = join(member, 'nested')
  mkdirSync(nested)
  const outside = join(root, '..')
  writeFileSync(join(root, 'forge-world.json'), '<<<<<<< conflicted manifest')
  expect(() => forgeReachFolders(root, [member, nested, outside])).toThrow()
  expect(forgeReachFolders(root, [member, nested, outside], [member, nested, outside])).toEqual([member])
  expect(forgeReachFolders(root, [nested], [member])).toEqual([])
})
