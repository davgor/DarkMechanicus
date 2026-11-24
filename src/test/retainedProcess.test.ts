import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { retainedProcess, withRetainedProcess, type RetainedProcess } from './retainedProcess'

interface ProcessIdentity { created: string; exited: boolean }
const execute = promisify(execFile)

// Query the kernel object, not .NET's running-process enumeration. The observer closes its own
// handle on every call, so it cannot accidentally reserve the identity the fixture must retain.
const INSPECT = String.raw`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OwnedProcessProbe {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
$handle = [OwnedProcessProbe]::OpenProcess(4096, $false, $ownedPid)
if ($handle -eq [IntPtr]::Zero) { 'null'; exit }
try {
  $code = [uint32]0; $created = [long]0; $exited = [long]0; $kernel = [long]0; $user = [long]0
  if (-not [OwnedProcessProbe]::GetExitCodeProcess($handle, [ref]$code)) { throw 'Could not inspect owned process exit status' }
  if (-not [OwnedProcessProbe]::GetProcessTimes($handle, [ref]$created, [ref]$exited, [ref]$kernel, [ref]$user)) { throw 'Could not inspect owned process identity' }
  @{ created = $created.ToString(); exited = ($code -ne 259) } | ConvertTo-Json -Compress
} finally { [void][OwnedProcessProbe]::CloseHandle($handle) }
`

async function identity(pid: number): Promise<ProcessIdentity | null> {
  const command = Buffer.from(`$ErrorActionPreference = 'Stop'; $ownedPid = ${pid};\n${INSPECT}`, 'utf16le').toString('base64')
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-EncodedCommand', command], { encoding: 'utf8', windowsHide: true })
  return JSON.parse(stdout) as ProcessIdentity | null
}

it('keeps the real exited Windows process identity reserved until explicit release', async () => {
  const child = await retainedProcess()
  try {
    expect(() => process.kill(child.pid, 0)).not.toThrow()
    const running = process.platform === 'win32' ? await identity(child.pid) : null
    await child.exit()
    expect(child.phase).toBe('exited')
    expect(() => process.kill(child.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    if (process.platform === 'win32') {
      expect(running).not.toBeNull()
      expect(await identity(child.pid), `Owned PID ${child.pid}, phase ${child.phase}`).toEqual({ ...running, exited: true })
    }
  } finally { await child.close() }
  expect(child.phase).toBe('released')
})

it('terminates and releases an owned running child when its caller fails, including supervisor stdin EOF', async () => {
  let child: RetainedProcess | undefined
  const original: { identity: ProcessIdentity | null } = { identity: null }
  const failure = new Error('Owned fixture caller failed')
  await expect(withRetainedProcess(async owned => {
    child = owned
    expect(() => process.kill(owned.pid, 0)).not.toThrow()
    if (process.platform === 'win32') original.identity = await identity(owned.pid)
    throw failure
  })).rejects.toBe(failure)
  expect(child?.phase).toBe('released')
  if (child === undefined) throw new Error('The fixture did not start its child.')
  if (process.platform === 'win32') {
    expect(original.identity).not.toBeNull()
    const after = await identity(child.pid)
    // A numeric PID may already belong to a different process after release. Only the owned
    // generation must have exited; do not reintroduce the PID-reuse assumption in cleanup proof.
    if (after?.created === original.identity?.created) expect(after?.exited).toBe(true)
  }
})
