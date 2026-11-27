/**
 * Vitest global setup, Windows only: one real supervised agent launch before any test file runs. Not shipped.
 *
 * Every agent launch on Windows starts the Windows PowerShell supervisor of `windowsAgentJob.ts`, which compiles its
 * C# with csc.exe. On a freshly booted CI runner the first such launch reads powershell.exe, .NET Framework and
 * csc.exe from a cold disk: it added 3.3 to 12.6 s to whichever test launched an agent first (the claude variant of
 * restartResume.wiring.test.ts timed out on it), while later launches took about 0.3 s. That one-time cost belongs
 * to the machine, not to any test, so it is paid here, once, under its own bound.
 */
import { startAgentProcess, type AgentProcessExit } from '../main/agentChat/agentProcess'

const BOUND_MS = 60_000

export default async function setup(): Promise<void> {
  if (process.platform !== 'win32') return
  const started = Date.now()
  const child = startAgentProcess({ file: process.execPath, args: ['-e', "console.log('ready')"] })
  const lines: string[] = []
  child.onLine(line => { lines.push(line) })
  let timer: NodeJS.Timeout | undefined
  const exit = await Promise.race([
    new Promise<AgentProcessExit>(resolve => { child.onExit(resolve) }),
    new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), BOUND_MS) })
  ]).finally(() => clearTimeout(timer))
  if (exit === null) {
    await child.stop({ force: true })
    throw new Error(`The Windows agent job warm-up launch did not finish within ${BOUND_MS / 1000} s.`)
  }
  if (exit.code !== 0 || lines.join('\n') !== 'ready') {
    throw new Error(`The Windows agent job warm-up launch failed (exit ${exit.code}, output ${JSON.stringify(lines)}): ${exit.stderr}`)
  }
  console.info(`Warmed the Windows agent job supervisor with one real launch in ${Date.now() - started} ms.`)
}
