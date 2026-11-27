import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { prepareInstallerToolchain, TOOLCHAIN_METADATA } from './prepareInstallerTests.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const nsis = value => value.replaceAll('$', '$$').replaceAll('"', '$\\"')

// Compile the actual production macro, with no PowerShell host or emulated native inventory.
function compile(compiler, file, text) {
  writeFileSync(file, '\ufeff' + text)
  const result = spawnSync(compiler.path, ['/V2', file], { encoding: 'utf8', env: { ...process.env, ...compiler.env } })
  expect(result.status, result.stdout + result.stderr).toBe(0)
}

function program(output, body) {
  return `Unicode true\nSilentInstall silent\nSilentUnInstall silent\nRequestExecutionLevel user\nOutFile "${nsis(output)}"\n${body}\n`
}

function detectorProgram(probe, installer = join(ROOT, 'build/installer.nsh')) {
  return program(probe, `
!include "LogicLib.nsh"
!addincludedir "${nsis(join(ROOT, 'node_modules/app-builder-lib/templates/nsis/include'))}"
!include "${nsis(installer)}"
Var PowerShellPath
Var IsPowerShellAvailable
!macro FIND_PROCESS _FILE _RETURN
 StrCmp $IsPowerShellAvailable 1 +2
 Abort "Fallback must not start PowerShell"
 ReadINIStr \${_RETURN} "$EXEDIR\\query.ini" "query" "fallback"
!macroend
Section
 ReadINIStr $INSTDIR "$EXEDIR\\query.ini" "query" "directory"
 StrCpy $PowerShellPath "$EXEDIR\\PowerShell-deliberately-unavailable.exe"
 StrCpy $IsPowerShellAvailable 0
 StrCpy $0 "saved-0"
 StrCpy $1 "saved-1"
 StrCpy $R1 "saved-R1"
 !insertmacro FIND_INSTALLED_PROCESS "different-name.exe" $R0
 FileOpen $R2 "$EXEDIR\\result.txt" w
 FileWrite $R2 "$R0|$0|$1|$R1|$IsPowerShellAvailable"
 FileClose $R2
SectionEnd`)
}

function fullProgram(output, uninstall = false) {
  const prefix = uninstall ? 'un.' : ''
  return program(output, `
${uninstall ? '!define BUILD_UNINSTALLER' : ''}
!include "LogicLib.nsh"
!addincludedir "${nsis(join(ROOT, 'node_modules/app-builder-lib/templates/nsis/include'))}"
!define APP_EXECUTABLE_FILENAME "Unrelated-fixture-name.exe"
!define PRODUCT_NAME "Disposable installer test"
!define isUpdated "0 = 1"
!include "${nsis(join(ROOT, 'build/installer.nsh'))}"
!include "allowOnlyOneInstallerInstance.nsh"
LoadLanguageFile "\${NSISDIR}\\Contrib\\Language files\\English.nlf"
LangString appRunning 1033 "Fixture running"
LangString appClosing 1033 "Fixture closing"
LangString appCannotBeClosed 1033 "Fixture cannot close"
Function ${prefix}RunFullCheck
 !insertmacro CHECK_APP_RUNNING
FunctionEnd
${uninstall ? 'Section\n WriteUninstaller "$EXEDIR\\uninstall-probe.exe"\nSectionEnd' : ''}
Section ${uninstall ? '"Uninstall"' : ''}
 ReadINIStr $INSTDIR "$EXEDIR\\query.ini" "query" "directory"
 StrCpy $IsPowerShellAvailable "not-launched"
 Call ${prefix}RunFullCheck
 FileOpen $R2 "$EXEDIR\\full-result.txt" w
 FileWrite $R2 "$IsPowerShellAvailable"
 FileClose $R2
SectionEnd`)
}

let root, installDir, nestedDir, outsideDir, probe, worker, failedSnapshot, fullProbe, uninstallProbe
const running = []

// CI provisions the compiler in its own step; a fresh local checkout provisions it here, on first use.
async function provisionCompiler() {
  if (!existsSync(TOOLCHAIN_METADATA)) await prepareInstallerToolchain()
}

function prepareFixture() {
  const compiler = JSON.parse(readFileSync(TOOLCHAIN_METADATA, 'utf8'))
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-install-native-')))
  installDir = join(root, "App's Unicode Ω folder")
  nestedDir = join(installDir, 'nested')
  outsideDir = installDir + '-other'
  for (const dir of [installDir, nestedDir, outsideDir]) mkdirSync(dir, { recursive: true })
  probe = join(root, 'detect.exe')
  worker = join(nestedDir, 'different-name.exe')
  compile(compiler, join(root, 'worker.nsi'), program(worker, 'Section\n Sleep 600000\nSectionEnd'))
  compile(compiler, join(root, 'detect.nsi'), detectorProgram(probe))
  const broken = join(root, 'snapshot-failure.nsh')
  const source = readFileSync(join(ROOT, 'build/installer.nsh'), 'utf8')
  const snapshot = "System::Call 'kernel32::CreateToolhelp32Snapshot(i 2, i 0) p.r1'"
  expect(source).toContain(snapshot)
  writeFileSync(broken, source.replace(snapshot, 'StrCpy $1 -1'))
  failedSnapshot = join(root, 'snapshot-failure.exe')
  compile(compiler, join(root, 'snapshot-failure.nsi'), detectorProgram(failedSnapshot, broken))
  fullProbe = join(root, 'full-installer.exe')
  compile(compiler, join(root, 'full-installer.nsi'), fullProgram(fullProbe))
  const uninstallerBuilder = join(root, 'uninstaller-builder.exe')
  compile(compiler, join(root, 'full-uninstaller.nsi'), fullProgram(uninstallerBuilder, true))
  expect(spawnSync(uninstallerBuilder, [], { windowsHide: true }).status).toBe(0)
  uninstallProbe = join(root, 'uninstall-probe.exe')
  const pe = readFileSync(probe)
  expect(pe.readUInt16LE(pe.readUInt32LE(0x3c) + 4)).toBe(0x14c)
}

async function start(executable = worker) {
  const child = spawn(executable, [], { stdio: 'ignore', windowsHide: true })
  running.push(child)
  await once(child, 'spawn')
}

function find(directory, fallback = '7', executable = probe, expectedExit = 0) {
  writeFileSync(join(root, 'query.ini'), Buffer.from('\ufeff[query]\r\ndirectory=' + directory + '\r\nfallback=' + fallback + '\r\n', 'utf16le'))
  const resultFile = join(root, 'result.txt')
  rmSync(resultFile, { force: true })
  const started = performance.now()
  const result = spawnSync(executable, [], { encoding: 'utf8', windowsHide: true })
  console.info('Native installer query', { elapsedMs: performance.now() - started, status: result.status, error: result.error?.message })
  expect(result.status, result.stderr).toBe(expectedExit)
  if (expectedExit) { expect(existsSync(resultFile)).toBe(false); return null }
  const [found, ...registers] = readFileSync(resultFile, 'utf8').split('|')
  expect(registers).toEqual(['saved-0', 'saved-1', 'saved-R1', '0'])
  return found
}

async function stopChildren() {
  for (const child of running.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
  }
}

describe.runIf(process.platform === 'win32')('installer.nsh: native installed-process detection', () => {
  // A first local run downloads the pinned NSIS archive (a few MB from GitHub) and verifies its checksum; that is a
  // network fetch, not test work, so it gets a bound of its own. Later runs reuse out/ and electron-builder's cache.
  beforeAll(provisionCompiler, 120_000)
  beforeAll(prepareFixture)
  afterEach(stopChildren)
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }) })

  it.each([0, 1, 2])('detects %i owned native processes without any PowerShell host', async count => {
    for (let index = 0; index < count; index += 1) await start()
    expect(find(installDir)).toBe(count ? '0' : '1')
    expect(find(outsideDir)).toBe('1')
  })

  it('matches case-insensitive directory boundaries, nested paths and a trailing separator', async () => {
    await start()
    expect(find(installDir.toUpperCase() + '\\')).toBe('0')
    expect(find(installDir.slice(0, -3))).toBe('1')
  })

  it('rejects a real process in a sibling directory with the same prefix', async () => {
    const outside = join(outsideDir, 'different-name.exe')
    copyFileSync(worker, outside)
    await start(outside)
    expect(find(installDir)).toBe('1')
    expect(find(outsideDir)).toBe('0')
  })

  it.runIf(process.arch === 'x64')('finds the real 64-bit Node executable from a 32-bit installer', () => {
    expect(find(dirname(realpathSync.native(process.execPath)))).toBe('0')
  })

  it.each(['0', '1'])('uses the native fallback result %s when the snapshot fails', result => {
    expect(find(installDir, result, failedSnapshot)).toBe(result)
  })

  it.each(['2', 'error'])('aborts installation on inconclusive fallback %s', result => {
    find(installDir, result, failedSnapshot, 2)
  })

  it('compiles and runs the full installer and uninstaller checks without starting PowerShell when idle', () => {
    writeFileSync(join(root, 'query.ini'), Buffer.from('\ufeff[query]\r\ndirectory=' + installDir + '\r\n', 'utf16le'))
    for (const executable of [fullProbe, uninstallProbe]) {
      rmSync(join(root, 'full-result.txt'), { force: true })
      const result = spawnSync(executable, ['_?=' + root], { encoding: 'utf8', windowsHide: true })
      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(join(root, 'full-result.txt'), 'utf8')).toBe('not-launched')
    }
  })
})
