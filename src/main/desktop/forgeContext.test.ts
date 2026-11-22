import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

describe('Forge agent repository context', () => {
  it('describes a fresh machine from both root and member without cloning code or requiring a local binding', () => {
    for (const folder of [root, member]) {
      const text = forgeAgentContext(folder)
      expect(text).toContain('https://github.com/example/source-code.git')
      expect(text).toContain(JSON.stringify(member))
      expect(text).toContain('only when the task needs its code')
      expect(text).toContain('outside the Forge World')
      expect(text).toContain('git clone --')
      expect(text).not.toContain('Local code checkout:')
    }
    expect(existsSync(join(root, 'source-code'))).toBe(false)
    expect(existsSync(join(root, '.darkmechanicus'))).toBe(false)
  })

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
