/**
 * Whether a chat's CLI has a shell running under it: the sign that a command it started (a test run, a build, a
 * deploy, one it left running in the background) is still running, which can go far longer than the idle stop's 10
 * minutes without a line of output. The idle stop asks before it stops a quiet PTY, and a shell found counts as
 * activity (`watchLive` in `terminalSessions.ts`).
 *
 * Agents run their commands in a shell: Claude Code's Bash tool in bash (Git Bash on Windows) or zsh, its PowerShell
 * tool in PowerShell. What counts:
 * - a shell with a program that is not a shell between it and the PTY (that program included): a PTY whose own
 *   program is a shell (a CLI that is a shell script) runs its CLI in it, which is the launch, not a command;
 * - never `cmd.exe`: on Windows it is what an `npx`-style MCP server (`cmd /c npx …`) and a `.cmd` shim run in, so
 *   it stays up for the whole session, and Claude Code does not run its commands in it.
 *
 * The processes are listed with their parents once per ask: `ps` on macOS and Linux, `Get-CimInstance Win32_Process`
 * in Windows PowerShell on Windows (where `wmic` is gone). A listing that fails rejects.
 */
import { execFile } from 'node:child_process'
import { win32 } from 'node:path'

/** A process as a listing gives it. */
export interface ListedProcess {
  pid: number
  ppid: number
  name: string
}

/** The shells a command runs in, by program name in lower case, with no folder and no `.exe`. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'mksh', 'tcsh', 'csh', 'nu', 'pwsh', 'powershell'])

/** How long a listing may take, and how much it may print. */
const LIST_TIMEOUT_MS = 30_000
const LIST_MAX_BYTES = 16 * 1024 * 1024

/** One process a line: its pid, its parent's pid and its name. */
const WINDOWS_LIST = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.Name }"
const LINE = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/

interface ListDeps {
  platform: NodeJS.Platform
  /** Runs `file` with `args` and answers what it printed; rejects when it fails. */
  run: (file: string, args: string[]) => Promise<string>
}

function runFile(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', timeout: LIST_TIMEOUT_MS, maxBuffer: LIST_MAX_BYTES, windowsHide: true }, (error, stdout) => {
      if (error === null) {
        resolve(stdout)
      } else {
        reject(error)
      }
    })
  })
}

/** Windows PowerShell by its full path, so a program placed in the working folder can never stand in for it. */
function powershellPath(): string {
  return win32.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** The program name as `SHELLS` holds it: no folder, no login shell's leading `-`, no `.exe`. */
function programName(name: string): string {
  const base = name.split(/[\\/]/).at(-1) ?? ''
  return base.replace(/^-/, '').replace(/\.exe$/i, '').toLowerCase()
}

/** The processes in a listing of one process a line (`LINE`); a line that is not one is skipped. */
export function parseProcessList(stdout: string): ListedProcess[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const match = LINE.exec(line)
    return match === null ? [] : [{ pid: Number(match[1]), ppid: Number(match[2]), name: match[3] ?? '' }]
  })
}

/** Every process running now, with its parent. */
export async function listProcesses(deps: ListDeps): Promise<ListedProcess[]> {
  if (deps.platform === 'win32') {
    const encoded = Buffer.from(WINDOWS_LIST, 'utf16le').toString('base64')
    return parseProcessList(await deps.run(powershellPath(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]))
  }
  // One `-o` each: a header given with `=` takes the rest of its argument, commas included.
  return parseProcessList(await deps.run('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'comm=']))
}

/** Each process's children, by the parent's pid. */
function childrenByParent(processes: readonly ListedProcess[]): Map<number, ListedProcess[]> {
  const children = new Map<number, ListedProcess[]>()
  for (const listed of processes) {
    const siblings = children.get(listed.ppid)
    if (siblings === undefined) {
      children.set(listed.ppid, [listed])
    } else {
      siblings.push(listed)
    }
  }
  return children
}

/** A shell a command runs in, `cmd.exe` (which never counts), or any other program. */
function kindOf(listed: ListedProcess): 'shell' | 'cmd' | 'program' {
  const name = programName(listed.name)
  if (SHELLS.has(name)) {
    return 'shell'
  }
  return name === 'cmd' ? 'cmd' : 'program'
}

/** Whether a shell that counts (see the module comment) runs under `root`, the PTY's own program, in `processes`. */
export function shellUnder(root: number, processes: readonly ListedProcess[]): boolean {
  const children = childrenByParent(processes)
  const top = processes.find((listed) => listed.pid === root)
  if (top === undefined) {
    return false
  }
  // Each with whether a program that is not a shell is on its way down from the root; a pid is visited once, as a
  // parent id Windows still reports for a process whose parent has ended can by now be anyone's.
  const waiting = [{ listed: top, pastLaunch: false }]
  const seen = new Set([root])
  for (let next = waiting.pop(); next !== undefined; next = waiting.pop()) {
    const kind = kindOf(next.listed)
    if (kind === 'shell' && next.pastLaunch) {
      return true
    }
    const pastLaunch = next.pastLaunch || kind === 'program'
    for (const child of (children.get(next.listed.pid) ?? []).filter((unseen) => !seen.has(unseen.pid))) {
      seen.add(child.pid)
      waiting.push({ listed: child, pastLaunch })
    }
  }
  return false
}

/** Whether a shell runs under the PTY program `pid` (see the module comment); rejects when the listing fails. */
export async function hasRunningShell(pid: number, deps: ListDeps = { platform: process.platform, run: runFile }): Promise<boolean> {
  return shellUnder(pid, await listProcesses(deps))
}
