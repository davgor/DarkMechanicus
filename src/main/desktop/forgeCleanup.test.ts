import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { scratchDir } from '../../test/gitScratch'
import { cleanupForgeSource } from './forgeCleanup'
import { installClaudeSkills, toTarget } from './skillInstall'

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
