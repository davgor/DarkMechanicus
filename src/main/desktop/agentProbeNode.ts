/**
 * The Node side of probing an agent executable: the real process runner and file check that
 * `probeAgent` takes as injected dependencies. Tests exercise them against Node itself; the probe's
 * own tests use fakes.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import type { FileCheck, ProbeLaunch, ProcessOutcome, ProcessRunner } from './agentProbe'

/** A version line is a few bytes; a program that prints more than this is cut off. */
const MAX_OUTPUT_CHARS = 64 * 1024

function spawnFailure(error: unknown): ProcessOutcome {
  const code = (error as { code?: unknown } | null)?.code
  return {
    kind: 'spawn_failed',
    code: typeof code === 'string' ? code : null,
    message: error instanceof Error ? error.message : String(error)
  }
}

/** A Windows shim runs as cmd.exe's child, so stopping only the shell would leave Node running. */
export function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    killer.on('error', () => child.kill())
    return
  }
  child.kill('SIGKILL')
}

function startProcess(launch: ProbeLaunch): ChildProcess {
  return spawn(launch.file, [...launch.args], {
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: launch.verbatimArguments,
    // No stdin: a program that waits for input sees end-of-file instead of hanging until the timeout.
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

/**
 * Starts the launch without a shell and resolves with how it ended, never rejecting. Output is
 * stdout and stderr together, capped; the process (tree) is killed when `timeoutMs` passes.
 */
export const runProcess: ProcessRunner = (launch, timeoutMs) =>
  new Promise<ProcessOutcome>((resolve) => {
    let output = ''
    let settled = false
    const finish = (outcome: ProcessOutcome): void => {
      if (!settled) {
        settled = true
        resolve(outcome)
      }
    }
    let child: ChildProcess
    try {
      child = startProcess(launch)
    } catch (error) {
      finish(spawnFailure(error))
      return
    }
    const timer = setTimeout(() => {
      killTree(child)
      finish({ kind: 'timed_out' })
    }, timeoutMs)
    const collect = (chunk: string): void => {
      output = (output + chunk).slice(0, MAX_OUTPUT_CHARS)
    }
    child.stdout?.setEncoding('utf8').on('data', collect)
    child.stderr?.setEncoding('utf8').on('data', collect)
    child.on('error', (error) => {
      clearTimeout(timer)
      finish(spawnFailure(error))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ kind: 'exited', exitCode: code ?? -1, output })
    })
  })

/** A regular file the system lets this process execute (on Windows every file passes; the extension decides there). */
export function inspectExecutable(path: string): FileCheck {
  try {
    if (!statSync(path).isFile()) {
      return 'not_a_file'
    }
  } catch {
    return 'not_a_file'
  }
  if (process.platform === 'win32') {
    return 'ok'
  }
  try {
    accessSync(path, constants.X_OK)
    return 'ok'
  } catch {
    return 'not_executable'
  }
}
