import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildMcpConfig } from './mcpConfig'

const PACKAGED_APP = join('/Applications', 'DarkMechanicus.app', 'Contents', 'Resources', 'app.asar')
const PACKAGED_EXEC = join('/Applications', 'DarkMechanicus.app', 'Contents', 'MacOS', 'DarkMechanicus')
const DEV_APP = join('/work', 'DarkMechanicus')

describe('buildMcpConfig for a packaged app', () => {
  const view = buildMcpConfig({
    packaged: true,
    execPath: PACKAGED_EXEC,
    appPath: PACKAGED_APP,
    repoPath: '/repos/site'
  })
  const script = join(PACKAGED_APP, 'out', 'main', 'mcp.js')

  it('runs the app executable as Node against the bundled server script', () => {
    expect(view.command).toBe(PACKAGED_EXEC)
    expect(view.args).toEqual([script, '--repo', '/repos/site'])
    expect(view.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
    expect(view.note).toBe('Uses the installed Dark Mechanicus app as the MCP runtime.')
  })

  it('produces a ready-to-paste mcpServers block including the environment', () => {
    expect(view.json).toBe(
      JSON.stringify(
        {
          mcpServers: {
            darkmechanicus: {
              command: PACKAGED_EXEC,
              args: [script, '--repo', '/repos/site'],
              env: { ELECTRON_RUN_AS_NODE: '1' }
            }
          }
        },
        null,
        2
      )
    )
    expect(view.json.split('\n')[1]).toBe('  "mcpServers": {')
  })
})

describe('buildMcpConfig for a development build', () => {
  const view = buildMcpConfig({
    packaged: false,
    execPath: '/usr/lib/electron/electron',
    appPath: DEV_APP,
    repoPath: '/repos/site'
  })
  const script = join(DEV_APP, 'out', 'main', 'mcp.js')

  it('uses plain Node against the built server script', () => {
    expect(view.command).toBe('node')
    expect(view.args).toEqual([script, '--repo', '/repos/site'])
    expect(view.env).toEqual({})
    expect(view.note).toBe('Development build: run `npm run build` first; requires Node 22.13+.')
  })

  it('omits the env block from the pasted JSON when there is nothing to set', () => {
    expect(JSON.parse(view.json)).toEqual({
      mcpServers: { darkmechanicus: { command: 'node', args: [script, '--repo', '/repos/site'] } }
    })
    expect(view.json.includes('env')).toBe(false)
  })
})

describe('buildMcpConfig repo path handling', () => {
  it('passes the repository path through as a single argument, unmodified', () => {
    const repoPath = join('/repos', 'my project', 'with "quotes"')
    const view = buildMcpConfig({
      packaged: false,
      execPath: '/electron',
      appPath: DEV_APP,
      repoPath
    })
    expect(view.args[2]).toBe(repoPath)
    expect(JSON.parse(view.json).mcpServers.darkmechanicus.args[2]).toBe(repoPath)
  })
})
