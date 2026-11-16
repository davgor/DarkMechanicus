import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cliInstructions } from '../agents/cliInstructions'
import { buildCliConfig, dmClientRuntime, type CliLaunch } from './cliConfig'

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

describe('dmClientRuntime: what the Skitarii mail client spawns', () => {
  const BUILDS = [
    { packaged: false, execPath: '/dev/app/node_modules/electron/dist/electron', appPath: '/dev/app' },
    { packaged: true, execPath: '/Applications/DM.app/Contents/MacOS/DM', appPath: '/Applications/DM.app/Contents/Resources/app.asar' },
    { packaged: false, execPath: 'C:\\dev\\app\\node_modules\\electron\\dist\\electron.exe', appPath: 'C:\\dev\\app' },
    { packaged: true, execPath: 'C:\\Program Files\\DM\\DM.exe', appPath: 'C:\\Program Files\\DM\\resources\\app.asar' }
    // A drive path is absolute on Windows alone, where main runs it.
  ].filter((build) => process.platform === 'win32' || build.execPath.startsWith('/'))
  const repo = '/work/my repo'

  it.each(BUILDS)('runs this build’s own executable as Node on the built CLI, never a node from PATH (packaged: $packaged, $execPath)', (build) => {
    const launch = buildCliConfig({ execPath: build.execPath, appPath: build.appPath, repoPath: repo, dmHome: '/Users/me/.darkmechanicus' })
    const issued: CliLaunch = { ...launch, env: { ...launch.env, DM_SESSION_TOKEN: 'grant-token', DM_DESKTOP_PIPE: '\\\\.\\pipe\\naming' } }

    expect(dmClientRuntime(issued, repo)).toEqual({
      command: build.execPath,
      args: [join(build.appPath, 'out', 'main', 'cli.js'), '--repo', repo],
      env: { ELECTRON_RUN_AS_NODE: '1', DARKMECHANICUS_HOME: '/Users/me/.darkmechanicus' }
    })
  })

  it.each<[string, (cli: CliLaunch) => CliLaunch, RegExp]>([
    ['a bare node', (cli) => ({ ...cli, command: 'node' }), /absolute runtime/],
    ['a relative script', (cli) => ({ ...cli, args: ['out/main/cli.js', '--repo', repo] }), /absolute runtime/],
    ['a script that is not the CLI', (cli) => ({ ...cli, args: ['/dev/app/out/main/mcp.js', '--repo', repo] }), /absolute runtime/],
    ['a path through ..', (cli) => ({ ...cli, command: '/dev/app/../evil/electron' }), /absolute runtime/],
    ['another folder', (cli) => ({ ...cli, args: [cli.args[0] as string, '--repo', '/elsewhere'] }), /pinned/],
    ['extra arguments', (cli) => ({ ...cli, args: [...cli.args, '--token-file', 't'] }), /pinned/],
    ['no Node switch', (cli) => ({ ...cli, env: {} }), /as Node/],
    ['a relative home', (cli) => ({ ...cli, env: { ...cli.env, DARKMECHANICUS_HOME: '.darkmechanicus' } }), /home/]
  ])('refuses %s', (_what, change, error) => {
    const launch = buildCliConfig({ execPath: '/dev/app/node_modules/electron/dist/electron', appPath: '/dev/app', repoPath: repo })
    expect(() => dmClientRuntime(change(launch), repo)).toThrow(error)
  })
})
