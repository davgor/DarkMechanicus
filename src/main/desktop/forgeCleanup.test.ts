import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RenameRetryNote } from '../../core/repo/forgeManifest'
import { refuseRenames, releaseRenames, renamesAsked } from '../../test/busyRename'
import { scratchDir } from '../../test/gitScratch'
import { cleanupForgeSource } from './forgeCleanup'
import { installClaudeSkills, toTarget } from './skillInstall'

// vi.mock factories run before the file's static imports, so the helper is loaded from inside the factory.
vi.mock('node:fs', async original => (await import('../../test/busyRename')).withBusyRename(await original()))

afterEach(() => { releaseRenames() })

it('removes only shipped skills and the MCP entry belonging to this checkout', () => {
  const fixture = scratchDir('forge-cleanup-')
  const root = realpathSync.native(fixture.path)
  const skills = ['worker', 'planner'].map(name => ({ name, description: 'Test skill', body: name }))
  const file = join(root, '.mcp.json')
  const entry = { command: 'node', args: ['mcp.js', '--repo', root, '--label', 'Claude Code'] }
  try {
    installClaudeSkills(root, skills)
    const worker = toTarget(root, skills[0])
    const planner = toTarget(root, skills[1])
    writeFileSync(planner.file, 'user edits')
    writeFileSync(file, JSON.stringify({ mcpServers: { darkmechanicus: entry, other: { command: 'keep' } } }))
    cleanupForgeSource(root, skills)
    expect(existsSync(worker.dir)).toBe(false)
    expect(readFileSync(planner.file, 'utf8')).toBe('user edits')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ mcpServers: { other: { command: 'keep' } } })
    writeFileSync(file, JSON.stringify({ mcpServers: { darkmechanicus: entry } }))
    cleanupForgeSource(root, [])
    expect(existsSync(file)).toBe(false)
    for (const existing of ['invalid json', '{"mcpServers":{"darkmechanicus":{"command":"custom"}}}']) {
      writeFileSync(file, existing)
      cleanupForgeSource(root, [])
      expect(readFileSync(file, 'utf8')).toBe(existing)
    }
  } finally { fixture.cleanup() }
})

describe('a busy rename onto .mcp.json', () => {
  /** A checkout whose .mcp.json holds this checkout's entry beside one the user keeps. */
  function checkout() {
    const fixture = scratchDir('forge-cleanup-busy-')
    const root = realpathSync.native(fixture.path)
    const file = join(root, '.mcp.json')
    const entry = { command: 'node', args: ['mcp.js', '--repo', root, '--label', 'Claude Code'] }
    const before = JSON.stringify({ mcpServers: { darkmechanicus: entry, other: { command: 'keep' } } })
    writeFileSync(file, before)
    return { root, file, before, cleanup: fixture.cleanup }
  }

  it('asks again after one busy refusal and removes the entry within 300 ms', () => {
    const { root, file, cleanup } = checkout()
    const onRetry = vi.fn<RenameRetryNote>()
    try {
      refuseRenames('EPERM')
      const started = performance.now()
      cleanupForgeSource(root, [], onRetry)
      expect(performance.now() - started).toBeLessThan(300)
      expect(renamesAsked()).toBe(2)
      expect(onRetry.mock.calls).toEqual([['EPERM', file]])
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ mcpServers: { other: { command: 'keep' } } })
      expect(readdirSync(root)).toEqual(['.mcp.json'])
    } finally { cleanup() }
  })

  it('throws the last busy refusal after the bound and leaves .mcp.json unchanged', () => {
    const { root, file, before, cleanup } = checkout()
    const onRetry = vi.fn<RenameRetryNote>()
    try {
      refuseRenames('EPERM', 'EACCES', 'EBUSY', 'EPERM')
      expect(() => cleanupForgeSource(root, [], onRetry)).toThrow('EPERM: rename refused')
      expect(renamesAsked()).toBe(4)
      expect(onRetry.mock.calls).toEqual([['EPERM', file], ['EACCES', file], ['EBUSY', file]])
      expect(readFileSync(file, 'utf8')).toBe(before)
    } finally { cleanup() }
  })

  it('throws any other error at once without asking again', () => {
    const { root, file, before, cleanup } = checkout()
    const onRetry = vi.fn<RenameRetryNote>()
    try {
      refuseRenames('ENOENT')
      expect(() => cleanupForgeSource(root, [], onRetry)).toThrow('ENOENT: rename refused')
      expect(renamesAsked()).toBe(1)
      expect(onRetry).not.toHaveBeenCalled()
      expect(readFileSync(file, 'utf8')).toBe(before)
    } finally { cleanup() }
  })
})
