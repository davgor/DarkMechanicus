import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { killProcessTree, startsOwnGroup } from '../agents/processTree'
import { hasRunningShell } from './runningShell'

/**
 * `hasRunningShell` on this platform's real listing (`ps`, or PowerShell on Windows): a program plays a CLI and starts
 * one child, a shell running a command or not, then prints the child's pid once it is started.
 */
vi.setConfig({ testTimeout: 60_000 })

const WINDOWS = process.platform === 'win32'

/** A shell running a long command; `sh` runs two, so it cannot hand its process over to `sleep`. */
const SHELL: [string, string[]] = WINDOWS ? ['powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep 60']] : ['/bin/sh', ['-c', 'sleep 60; :']]
const NOT_A_SHELL: [string, string[]] = [process.execPath, ['-e', 'setTimeout(() => {}, 60000)']]

const trees: ChildProcess[] = []

/** Starts a program that starts `child`, and resolves once `child` runs. */
async function cliRunning(child: [string, string[]]): Promise<ChildProcess> {
  const script = `const c = require('node:child_process').spawn(${JSON.stringify(child[0])}, ${JSON.stringify(child[1])}, { stdio: 'ignore', windowsHide: true }); c.on('spawn', () => console.log(c.pid)); setInterval(() => {}, 1000)`
  const cli = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], detached: startsOwnGroup(), windowsHide: true })
  trees.push(cli)
  await once(cli.stdout as NonNullable<ChildProcess['stdout']>, 'data')
  return cli
}

afterEach(async () => {
  await Promise.all(trees.splice(0).map((tree) => killProcessTree(tree)))
})

describe('hasRunningShell on a real process tree', () => {
  it('answers true while a shell runs under the program', async () => {
    const cli = await cliRunning(SHELL)

    expect(await hasRunningShell(cli.pid as number)).toBe(true)
  })

  it('answers false when what runs under the program is not a shell', async () => {
    const cli = await cliRunning(NOT_A_SHELL)

    expect(await hasRunningShell(cli.pid as number)).toBe(false)
  })

  it.runIf(WINDOWS)('answers false for cmd.exe under the program', async () => {
    const cli = await cliRunning(['cmd.exe', ['/d', '/c', 'ping -n 60 127.0.0.1 >NUL']])

    expect(await hasRunningShell(cli.pid as number)).toBe(false)
  })
})
