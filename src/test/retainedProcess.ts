import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { z } from 'zod'

export interface RetainedProcess {
  readonly pid: number
  readonly phase: 'running' | 'exited' | 'released'
  exit(): Promise<void>
  close(): Promise<void>
}

/** Preserve the original real-child path on non-Windows hosts. */
async function directProcess(): Promise<RetainedProcess> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  const closed = new Promise<void>(resolve => { child.once('close', () => resolve()) })
  await once(child, 'spawn')
  if (child.pid === undefined) throw new Error('The owned child has no process id.')
  let phase: RetainedProcess['phase'] = 'running'
  const exit = async (): Promise<void> => {
    if (phase !== 'running') return
    child.kill()
    await closed
    phase = 'exited'
  }
  return {
    pid: child.pid,
    get phase() { return phase },
    exit,
    close: async () => { await exit(); phase = 'released' }
  }
}

const receiptSchema = z.strictObject({ phase: z.enum(['ready', 'exited', 'released']), pid: z.number().int().positive() })
const supervisorCommand = process.platform === 'win32'
  ? Buffer.from(readFileSync(new URL('./retainedProcess.ps1', import.meta.url), 'utf8'), 'utf16le').toString('base64')
  : ''

/** A retained native handle, not a cached PID, keeps this fixture's exited identity unambiguous. */
async function supervisedProcess(): Promise<RetainedProcess> {
  const supervisor = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', supervisorCommand], {
    stdio: 'pipe', windowsHide: true, env: { ...process.env, DM_TEST_OWNED_NODE: process.execPath }
  })
  const closed = new Promise<void>(resolve => { supervisor.once('close', () => resolve()) })
  let diagnostics = ''
  supervisor.stderr.on('data', chunk => { diagnostics += String(chunk) })
  await once(supervisor, 'spawn')
  const lines = createInterface({ input: supervisor.stdout })
  const replies = lines[Symbol.asyncIterator]()
  const receipt = async (expected: z.infer<typeof receiptSchema>['phase']): Promise<number> => {
    const next = await replies.next()
    if (next.done) throw new Error(`Owned supervisor ended before ${expected}: ${diagnostics}`)
    const message = receiptSchema.parse(JSON.parse(next.value))
    if (message.phase !== expected) throw new Error(`Owned supervisor reported ${message.phase}, expected ${expected}.`)
    return message.pid
  }
  let pid: number
  try { pid = await receipt('ready') }
  catch (error) { supervisor.stdin.end(); await closed; lines.close(); throw error }
  let phase: RetainedProcess['phase'] = 'running'
  return {
    pid, get phase() { return phase },
    exit: async () => {
      if (phase !== 'running') return
      supervisor.stdin.write('exit\n')
      if (await receipt('exited') !== pid) throw new Error('The owned process identity changed.')
      phase = 'exited'
    },
    close: async () => {
      if (phase === 'released') return
      supervisor.stdin.end()
      try {
        if (await receipt('released') !== pid) throw new Error('The released process identity changed.')
      } finally { await closed; lines.close() }
      if (supervisor.exitCode !== 0) throw new Error(`Owned supervisor failed: ${diagnostics}`)
      phase = 'released'
    }
  }
}

/** Real legacy child with identity reservation on Windows and mandatory owned cleanup. */
export const retainedProcess = process.platform === 'win32' ? supervisedProcess : directProcess

export async function withRetainedProcess<T>(work: (child: RetainedProcess) => Promise<T>): Promise<T> {
  const child = await retainedProcess()
  try { return await work(child) }
  finally { await child.close() }
}
