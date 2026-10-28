import { describe, expect, it } from 'vitest'
import type { DarkMechanicusCli } from '../../shared/agents/chat'
import { cliCommandLine, cliInstructions } from './cliInstructions'

const CLI: DarkMechanicusCli = {
  command: 'node',
  args: ['/app/out/main/cli.js', '--repo', '/work/repo'],
  env: { DM_SESSION_TOKEN: 'dmg_secret' }
}

describe('cliCommandLine', () => {
  it('writes the invocation the chat may make', () => {
    expect(cliCommandLine(CLI)).toBe('node /app/out/main/cli.js --repo /work/repo')
  })

  it('quotes a part that needs it, so the line can be copied as written', () => {
    expect(cliCommandLine({ ...CLI, args: ['/a b/cli.js'] })).toBe("node '/a b/cli.js'")
  })
})

describe('cliInstructions', () => {
  const text = cliInstructions({ cli: CLI, role: 'orchestrator', allowSave: true })

  it('gives the exact command, so the agent does not have to guess at it', () => {
    expect(text).toContain('node /app/out/main/cli.js --repo /work/repo --list')
    expect(text).toContain("call get_capabilities '{}'")
  })

  it('says there is no MCP server, which is what an agent otherwise goes looking for', () => {
    expect(text).toContain('no MCP server')
    expect(text).toContain('mcp__darkmechanicus__')
  })

  it('states the grant already exists, rather than leaving the agent to ask for one', () => {
    expect(text).toContain('DM_SESSION_TOKEN')
    expect(text).toMatch(/already hold a \*\*orchestrator\*\* grant/)
    expect(text).toMatch(/asking a person to issue you a grant is wrong/)
  })

  it('never puts the token itself in the prompt', () => {
    expect(text).not.toContain('dmg_secret')
  })

  it('tells a chat that may not save to hand the draft over', () => {
    const planner = cliInstructions({ cli: CLI, role: 'planner', allowSave: false })
    expect(planner).toContain('may not save plans')
    expect(planner).toContain('press Save')
  })

  it('names the role it was issued', () => {
    expect(cliInstructions({ cli: CLI, role: 'worker', allowSave: false })).toContain('**worker**')
  })
})
