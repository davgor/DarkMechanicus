import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const INSTALLER_SCRIPT = readFileSync(join(ROOT, 'build', 'installer.nsh'), 'utf8')

/** The PowerShell the installer runs, with NSIS's variable escaping expanded. */
function findCommand(installDir) {
  const [, command] = /-C "([^"]+)"/.exec(INSTALLER_SCRIPT) ?? []
  return command.replaceAll('$$', '$').replaceAll('$INSTDIR', () => installDir)
}

function find(installDir, inventory = '') {
  const started = performance.now()
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-C', inventory + findCommand(installDir)], { encoding: 'utf8' })
  console.info('Installer process query', { elapsedMs: performance.now() - started, status: result.status, stderr: result.stderr })
  return result.status
}

// Scope the real native inventory to owned children without changing the installer's path predicate.
function ownedInventory(running) {
  const query = running.length ? `Microsoft.PowerShell.Management\\Get-Process -Id ${running.map(child => child.pid).join(',')}` : '@()'
  return `function Get-Process { ${query} }; `
}

function nativeShellResult(installDir) {
  const [, nativePath] = /StrCpy \$PowerShellPath "(\$WINDIR\\Sysnative[^"]+)"/.exec(INSTALLER_SCRIPT) ?? []
  if (!nativePath) throw new Error('The installer must select native PowerShell on 64-bit Windows')
  // NSIS is a native 32-bit launcher, not a second PowerShell/.NET runtime. Match that launch path.
  const shell = join(process.env.SystemRoot, 'SysWOW64', 'cmd.exe')
  const pe = readFileSync(shell)
  if (pe.readUInt16LE(pe.readUInt32LE(0x3c) + 4) !== 0x14c) throw new Error('Expected a 32-bit launcher')
  const diagnostic = "[Console]::WriteLine('native64entry='+[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()); [Console]::WriteLine('bits='+([IntPtr]::Size * 8)); "
  const encoded = Buffer.from(diagnostic + findCommand(installDir), 'utf16le').toString('base64')
  const command = `echo cmd32entry=%time% & "${nativePath.replace('$WINDIR', process.env.SystemRoot)}" -NoProfile -NonInteractive -EncodedCommand ${encoded}`
  const started = performance.now()
  const result = spawnSync(shell, ['/d', '/s', '/c', `"${command}"`], { encoding: 'utf8', windowsVerbatimArguments: true })
  console.info('Installer native shell', { elapsedMs: performance.now() - started, status: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr })
  return result
}

// Native process discovery and the installer are Windows-only.
describe.runIf(process.platform === 'win32')('installer.nsh: finding the app running from its install folder', () => {
  let installDir = ''
  let emptyDir = ''
  const running = []

  async function start() {
    const started = performance.now()
    // Reuse an installed executable: copying one into temp makes its first launch depend on antivirus scanning.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    running.push(child)
    await once(child, 'spawn')
    console.info('Installer fixture spawn', { elapsedMs: performance.now() - started, pid: child.pid })
  }

  beforeAll(() => {
    installDir = dirname(realpathSync.native(process.execPath))
    emptyDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-install-empty-')))
  })

  afterEach(async () => {
    const started = performance.now()
    for (const child of running.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill()
        await exited
      }
    }
    console.info('Installer fixture cleanup', { elapsedMs: performance.now() - started })
  })

  afterAll(() => { rmSync(emptyDir, { recursive: true, force: true }) })

  it.each([0, 1, 2])('detects %i owned processes with real native process paths', async count => {
    for (let index = 0; index < count; index += 1) await start()
    expect(find(installDir, ownedInventory(running))).toBe(count ? 0 : 1)
    expect(find(emptyDir, ownedInventory(running))).toBe(1)
  })

  it('reads the unmodified native inventory and rejects an empty install folder', () => {
    expect(find(installDir)).toBe(0)
    expect(find(emptyDir)).toBe(1)
  })

  it('finds a single process without CIM or a scalar Count property', () => {
    const inventory = `function Get-CimInstance { throw 'CIM provider is unavailable' }; function Get-Process { [pscustomobject]@{ Path='C:\\Fixture\\app.exe'; Count=$null } }; `
    expect(find('C:\\Fixture', inventory)).toBe(0)
  })

  it.runIf(process.arch === 'x64')('uses native PowerShell from a 32-bit installer to inspect a 64-bit process', () => {
    const result = nativeShellResult(installDir)
    // EncodedCommand may serialize first-use progress to stderr; inspect shell width and the detection result.
    expect({ status: result.status, bits: /bits=(\d+)/.exec(result.stdout)?.[1] }, result.stderr).toEqual({ status: 0, bits: '64' })
  })
})
