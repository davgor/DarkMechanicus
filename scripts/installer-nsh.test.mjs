import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const INSTALLER_SCRIPT = readFileSync(join(ROOT, 'build', 'installer.nsh'), 'utf8')

/** The PowerShell the installer runs to find the app's processes, as NSIS hands it over for one install folder. */
function findCommand(installDir) {
  const [, command] = /-C "([^"]+)"/.exec(INSTALLER_SCRIPT) ?? []
  return command.replaceAll('$$', '$').replaceAll('$INSTDIR', () => installDir)
}

/** The installer's answer: 0 when something runs from the install folder, 1 when nothing does. */
function find(installDir) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-C', findCommand(installDir)]).status
}

// The installer runs only on Windows, where the query reads processes through Get-CimInstance.
describe.runIf(process.platform === 'win32')('installer.nsh: finding the app running from its install folder', () => {
  let installDir = ''
  let appExe = ''
  const running = []

  /** Starts one long-running process from the install folder, as a lone Dark Mechanicus MCP server would run. */
  async function start() {
    const child = spawn(appExe, ['-n', '3600', '127.0.0.1'], { stdio: 'ignore' })
    running.push(child)
    await once(child, 'spawn')
  }

  beforeAll(() => {
    // The long name: Windows reports a process's path in full, never as a temp folder's 8.3 short name.
    installDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-install-')))
    // Any executable inside the folder stands in for the app: the query matches on the process's path only. Windows'
    // 45 KB PING.EXE starts in about 20 ms; a copy of the 92 MB node.exe took 400-520 ms to start (an antivirus scans a
    // new executable on first launch), which on a busy CI runner pushed this test past its timeout.
    const ping = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'PING.EXE')
    appExe = join(installDir, basename(ping))
    copyFileSync(ping, appExe)
  })

  afterEach(async () => {
    for (const child of running.splice(0)) {
      child.kill()
      if (child.exitCode === null && child.signalCode === null) {
        await once(child, 'exit')
      }
    }
  })

  afterAll(() => {
    rmSync(installDir, { recursive: true, force: true, maxRetries: 10 })
  })

  it('finds the app when exactly one of its processes is left', async () => {
    await start()

    expect(find(installDir)).toBe(0)
  })

  it('finds the app while several of its processes run', async () => {
    await start()
    await start()

    expect(find(installDir)).toBe(0)
  })

  it('finds nothing once every process from the install folder has exited', () => {
    expect(find(installDir)).toBe(1)
  })
})
