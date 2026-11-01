import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildCliConfig } from './cliConfig'

describe('buildCliConfig', () => {
  it('runs the built CLI under node in development, pinned to the folder, with nothing added to the environment', () => {
    const launch = buildCliConfig({ packaged: false, execPath: '/bin/electron', appPath: '/dev/app', repoPath: '/work/repo' })

    expect(launch).toEqual({ command: 'node', args: [join('/dev/app', 'out', 'main', 'cli.js'), '--repo', '/work/repo'], env: {} })
  })

  it('runs the packaged app as Node, and passes on the Dark Mechanicus home the app resolved', () => {
    const launch = buildCliConfig({
      packaged: true,
      execPath: '/Applications/Dark Mechanicus.app/Contents/MacOS/Dark Mechanicus',
      appPath: '/Applications/Dark Mechanicus.app/Contents/Resources/app.asar',
      repoPath: '/work/repo',
      dmHome: '/Users/me/.darkmechanicus'
    })

    expect(launch.command).toBe('/Applications/Dark Mechanicus.app/Contents/MacOS/Dark Mechanicus')
    expect(launch.args[0]).toBe(join('/Applications/Dark Mechanicus.app/Contents/Resources/app.asar', 'out', 'main', 'cli.js'))
    expect(launch.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', DARKMECHANICUS_HOME: '/Users/me/.darkmechanicus' })
  })
})
