import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cliInstructions } from '../agents/cliInstructions'
import { buildCliConfig } from './cliConfig'

describe('buildCliConfig', () => {
  it('runs the development build’s Electron executable as Node, pinned to the folder', () => {
    const launch = buildCliConfig({ execPath: '/dev/app/node_modules/electron/electron', appPath: '/dev/app', repoPath: '/work/repo' })

    expect(launch).toEqual({
      command: '/dev/app/node_modules/electron/electron',
      args: [join('/dev/app', 'out', 'main', 'cli.js'), '--repo', '/work/repo'],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    })
  })

  it('runs the packaged app as Node, and passes on the Dark Mechanicus home the app resolved', () => {
    const launch = buildCliConfig({
      execPath: '/Applications/Dark Mechanicus.app/Contents/MacOS/Dark Mechanicus',
      appPath: '/Applications/Dark Mechanicus.app/Contents/Resources/app.asar',
      repoPath: '/work/repo',
      dmHome: '/Users/me/.darkmechanicus'
    })

    expect(launch.command).toBe('/Applications/Dark Mechanicus.app/Contents/MacOS/Dark Mechanicus')
    expect(launch.args[0]).toBe(join('/Applications/Dark Mechanicus.app/Contents/Resources/app.asar', 'out', 'main', 'cli.js'))
    expect(launch.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', DARKMECHANICUS_HOME: '/Users/me/.darkmechanicus' })
  })

  it.each([
    { packaged: false, execPath: '/dev/app/node_modules/electron/electron', appPath: '/dev/app' },
    { packaged: true, execPath: '/Applications/DM.app/Contents/MacOS/DM', appPath: '/Applications/DM.app/Contents/Resources/app.asar' }
  ])('injects the running build command into chat instructions (packaged: $packaged)', (build) => {
    const launch = buildCliConfig({ execPath: build.execPath, appPath: build.appPath, repoPath: '/work/repo' })
    const text = cliInstructions({ cli: launch, role: 'orchestrator', allowSave: false })
    const script = join(build.appPath, 'out', 'main', 'cli.js')
    expect(text).toContain(`ELECTRON_RUN_AS_NODE=1 ${build.execPath} ${process.platform === 'win32' ? `'${script}'` : script} --repo /work/repo --list`)
    expect(launch.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })
})
