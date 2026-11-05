import { describe, expect, it } from 'vitest'
import { listProcesses, parseProcessList, shellUnder, type ListedProcess } from './runningShell'

/** A listing from `[pid, ppid, name]` rows. */
function listing(...rows: [number, number, string][]): ListedProcess[] {
  return rows.map(([pid, ppid, name]) => ({ pid, ppid, name }))
}

/** Something running elsewhere on the machine, under no chat: a terminal the person opened. */
const ELSEWHERE: [number, number, string][] = [
  [4, 0, 'System'],
  [500, 4, 'explorer.exe'],
  [501, 500, 'bash.exe']
]

describe('shellUnder', () => {
  it('finds the shell a CLI runs a command in, below it', () => {
    const processes = listing(...ELSEWHERE, [10, 4, 'claude.exe'], [11, 10, 'bash.exe'], [12, 11, 'node.exe'])

    expect(shellUnder(10, processes)).toBe(true)
  })

  it('finds a shell that is not the CLI’s own child, and PowerShell, zsh by its path and a login shell', () => {
    for (const shell of ['powershell.exe', 'pwsh.exe', '/bin/zsh', '-zsh', 'BASH.EXE']) {
      expect(shellUnder(10, listing([10, 1, 'node'], [11, 10, 'codex'], [12, 11, shell])), shell).toBe(true)
    }
  })

  it('finds no shell for a CLI at its prompt with an MCP server it runs through cmd.exe', () => {
    const processes = listing(...ELSEWHERE, [10, 4, 'claude.exe'], [20, 10, 'cmd.exe'], [21, 20, 'node.exe'], [22, 21, 'node.exe'])

    expect(shellUnder(10, processes)).toBe(false)
  })

  it('takes neither the cmd.exe of a .cmd shim nor a shell script the CLI is for a command', () => {
    expect(shellUnder(10, listing([10, 4, 'cmd.exe'], [11, 10, 'node.exe']))).toBe(false)
    expect(shellUnder(10, listing([10, 4, 'cmd.exe'], [11, 10, 'cmd.exe'], [12, 11, 'node.exe']))).toBe(false)
    expect(shellUnder(10, listing([10, 1, 'bash'], [11, 10, 'node']))).toBe(false)
    expect(shellUnder(10, listing([10, 4, 'cmd.exe'], [11, 10, 'node.exe'], [12, 11, 'bash.exe']))).toBe(true)
    expect(shellUnder(10, listing([10, 1, 'bash'], [11, 10, 'node'], [12, 11, 'sh']))).toBe(true)
  })

  it('finds nothing for a program that is not listed, and ends on parents that loop', () => {
    expect(shellUnder(10, listing(...ELSEWHERE))).toBe(false)
    expect(shellUnder(10, listing([10, 11, 'claude.exe'], [11, 10, 'node.exe']))).toBe(false)
  })
})

describe('parseProcessList', () => {
  it('reads pid, parent pid and a name that may hold spaces, and skips lines that are not processes', () => {
    const stdout = '\r\n0 0 System Idle Process\r\n 4 0 System\r\n  812   1 /Applications/Visual Studio Code.app/Contents/MacOS/Electron\r\nnot a process\r\n'

    expect(parseProcessList(stdout)).toEqual(
      listing([0, 0, 'System Idle Process'], [4, 0, 'System'], [812, 1, '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'])
    )
  })
})

describe('listProcesses', () => {
  it('lists through Windows PowerShell by its full path on Windows', async () => {
    const calls: { file: string; args: string[] }[] = []
    const run = async (file: string, args: string[]): Promise<string> => {
      calls.push({ file, args })
      return '10 4 claude.exe\r\n'
    }

    const processes = await listProcesses({ platform: 'win32', run })

    expect(processes).toEqual(listing([10, 4, 'claude.exe']))
    expect(calls[0]?.file).toMatch(/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/)
    expect(calls[0]?.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(Buffer.from(calls[0]?.args[3] ?? '', 'base64').toString('utf16le')).toContain('Get-CimInstance Win32_Process')
  })

  it('lists with ps elsewhere, one -o for each column', async () => {
    const calls: string[][] = []
    const run = async (file: string, args: string[]): Promise<string> => {
      calls.push([file, ...args])
      return '  10     1 /usr/local/bin/claude\n'
    }

    const processes = await listProcesses({ platform: 'darwin', run })

    expect(processes).toEqual(listing([10, 1, '/usr/local/bin/claude']))
    expect(calls).toEqual([['ps', '-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'comm=']])
  })

  it('rejects when the listing fails', async () => {
    const run = async (): Promise<string> => {
      throw new Error('spawn ps ENOENT')
    }

    await expect(listProcesses({ platform: 'linux', run })).rejects.toThrow('spawn ps ENOENT')
  })
})
