/**
 * What the cult supervisor holds outside the store, written down (`userData/cults/ledger.json`, mode 0600) so the start
 * after a crash can undo it: the member processes of active runs, and the grant upgrades their petitions won. A
 * recorded pid is only ended when the process still running under it is the member's own: its command line names the
 * chat's own OMP session folder, which no other process does, so a pid the system handed to another program is left
 * alone.
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { z } from 'zod'
import { writePrivateFile } from '../terminals/privateFile'

const processSchema = z.object({ runId: z.string().min(1), chatId: z.string().min(1), pid: z.number().int().positive() })
const grantSchema = z.object({
  runId: z.string().min(1),
  /** The member chat that holds it: the Magos. */
  chatId: z.string().min(1),
  kind: z.enum(['allow_save', 'folder_access']),
  /** The folder whose database holds the grant: the run's workspace for Allow save, the petitioned folder otherwise. */
  folder: z.string().min(1),
  grantId: z.string().min(1),
  tokenFile: z.string().min(1).nullable()
})
const ledgerSchema = z.object({ processes: z.array(processSchema), grants: z.array(grantSchema) })

export type LedgerProcess = z.infer<typeof processSchema>
export type LedgerGrant = z.infer<typeof grantSchema>

export interface CultLedger {
  processes(): LedgerProcess[]
  grants(): LedgerGrant[]
  addProcess(entry: LedgerProcess): Promise<void>
  removeProcess(chatId: string): Promise<void>
  addGrant(entry: LedgerGrant): Promise<void>
  removeGrant(grantId: string): Promise<void>
}

type Ledger = z.infer<typeof ledgerSchema>

function load(path: string): Ledger {
  try {
    return ledgerSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    // Missing or unreadable: nothing is known to be left over.
    return { processes: [], grants: [] }
  }
}

export function cultLedgerPath(userData: string): string {
  return join(userData, 'cults', 'ledger.json')
}

export function createCultLedger(options: { userData: string }): CultLedger {
  const path = cultLedgerPath(options.userData)
  let ledger = load(path)
  let chain: Promise<void> = Promise.resolve()
  const save = (next: Ledger): Promise<void> => {
    ledger = next
    const text = JSON.stringify(next)
    chain = chain.catch(() => {}).then(() => writePrivateFile(path, text, 0o600))
    return chain
  }
  return {
    processes: () => [...ledger.processes],
    grants: () => [...ledger.grants],
    addProcess: (entry) => save({ ...ledger, processes: [...ledger.processes.filter((known) => known.chatId !== entry.chatId), entry] }),
    removeProcess: (chatId) =>
      ledger.processes.some((known) => known.chatId === chatId)
        ? save({ ...ledger, processes: ledger.processes.filter((known) => known.chatId !== chatId) })
        : chain,
    addGrant: (entry) => save({ ...ledger, grants: [...ledger.grants.filter((known) => known.grantId !== entry.grantId), entry] }),
    removeGrant: (grantId) =>
      ledger.grants.some((known) => known.grantId === grantId)
        ? save({ ...ledger, grants: ledger.grants.filter((known) => known.grantId !== grantId) })
        : chain
  }
}

/** How a leftover member process is found and ended. */
export interface LeftoverProcesses {
  /** The command line of the process running as `pid`, or null when none runs. */
  commandLine(pid: number): Promise<string | null>
  /** Ends the process tree `pid` leads. */
  killTree(pid: number): Promise<void>
}

/** Ends `pid` when its command line still names `marker` (the member chat's session folder); true when it did. */
export async function endLeftover(pid: number, marker: string, processes: LeftoverProcesses): Promise<boolean> {
  const command = await processes.commandLine(pid)
  if (command === null || !command.includes(marker)) return false
  await processes.killTree(pid)
  return true
}

function run(file: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 5_000 }, (error, stdout) => {
      const text = stdout.trim()
      resolve(error === null && text !== '' ? text : null)
    })
  })
}

/** A Windows system program by its full path, so a program placed in the working folder can never stand in for it. */
function system32(...parts: string[]): string {
  return win32.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', ...parts)
}

/** The real lookups: `ps` on macOS and Linux, CIM through PowerShell and `taskkill` on Windows. */
export function systemLeftovers(platform: NodeJS.Platform = process.platform): LeftoverProcesses {
  if (platform === 'win32') {
    return {
      commandLine: (pid) =>
        run(system32('WindowsPowerShell', 'v1.0', 'powershell.exe'), [
          '-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`
        ]),
      killTree: async (pid) => {
        await run(system32('taskkill.exe'), ['/pid', String(pid), '/t', '/f'])
      }
    }
  }
  return {
    commandLine: (pid) => run('/bin/ps', ['-o', 'command=', '-p', String(pid)]),
    killTree: async (pid) => {
      // A PTY's program leads its own process group: the group, or the program alone when it has none.
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, 'SIGKILL')
          return
        } catch {
          // Gone, or no group of its own.
        }
      }
    }
  }
}
