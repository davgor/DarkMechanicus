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

  it('sets Electron Node mode for this invocation without exposing the grant or other environment values', () => {
    const line = cliCommandLine({
      command: '/My Build/Electron',
      args: ['/My Build/out/main/cli.js', '--repo', '/work/repo'],
      env: { ELECTRON_RUN_AS_NODE: '1', DM_SESSION_TOKEN: 'dmg_secret', DARKMECHANICUS_HOME: '/private/home' }
    })
    expect(line).toBe("ELECTRON_RUN_AS_NODE=1 '/My Build/Electron' '/My Build/out/main/cli.js' --repo /work/repo")
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

  it('teaches an existing no-save orchestrator to request, inspect the decision, and recheck effective authority', () => {
    const guidance = cliInstructions({ cli: CLI, role: 'orchestrator', allowSave: false })
    for (const command of ['request_save_permission', 'list_save_permission_requests', 'get_capabilities']) expect(guidance).toContain(command)
    expect(guidance).toContain('requesting never grants permission')
    expect(guidance).toContain('Acquired Allow save never permits approving other requests')
  })

  it('names the role it was issued', () => {
    expect(cliInstructions({ cli: CLI, role: 'worker', allowSave: false })).toContain('**worker**')
  })

  it.each(['orchestrator', 'worker'] as const)('does not make an authorized single card wait on an unsolicited epic Save for %s', (role) => {
    const guidance = cliInstructions({ cli: CLI, role, allowSave: false })
    expect(guidance).toMatch(/Save.*only.*plan/i)
    expect(guidance).toMatch(/authorized single card.*not.*unsolicited epic.*Save/i)
  })
})

describe('cliInstructions: a project-less chat', () => {
  const unpinned: DarkMechanicusCli = { command: 'node', args: ['/app/out/main/cli.js'], env: { DM_SESSION_TOKEN: 'dmg_secret' } }
  const reach = [
    { folder: '/work/alpha', tokenFile: '/scratch/.dm/grants/a.token' },
    { folder: '/work/my beta', tokenFile: '/scratch/.dm/grants/b.token' }
  ]
  const text = cliInstructions({ cli: unpinned, role: 'orchestrator', allowSave: true, reach })

  it('gives one exact command line per tracked folder, naming the folder and its token file', () => {
    expect(text).toContain("node /app/out/main/cli.js --repo /work/alpha --token-file /scratch/.dm/grants/a.token call get_capabilities '{}'")
    expect(text).toContain("node /app/out/main/cli.js --repo '/work/my beta' --token-file /scratch/.dm/grants/b.token call get_capabilities '{}'")
  })

  it('says it is tied to no project, holds an orchestrator grant that may save in each folder, and must name the folder every time', () => {
    expect(text).toContain('not tied to a project')
    expect(text).toMatch(/\*\*orchestrator\*\* grant/)
    expect(text).toContain('This chat may save plans itself.')
    expect(text).toContain('--repo <folder> --token-file <file>')
    expect(text).not.toMatch(/Do not pass a role, a token or a repository/)
  })

  it('never puts a token itself in the prompt', () => {
    expect(text).not.toContain('dmg_secret')
  })

  it('says it holds no grant, and how one comes, while no folder is tracked and set up', () => {
    const none = cliInstructions({ cli: { ...unpinned, env: {} }, role: 'orchestrator', allowSave: true, reach: [] })

    expect(none).toContain('No folder is tracked and set up')
    expect(none).toContain('start this chat again')
    expect(none).not.toContain('--repo')
  })
})
