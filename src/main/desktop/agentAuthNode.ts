/**
 * The Node side of starting a sign-in: the real terminal launcher that `signInAgent` takes as an
 * injected dependency. The terminal is started detached with no stdio of its own, so it outlives the
 * app's interest in it; the app learns only that it started, never what the person typed or what
 * the CLI printed there.
 */
import { spawn } from 'node:child_process'
import type { TerminalLauncher, TerminalOutcome } from './agentAuth'

function failure(error: unknown): TerminalOutcome {
  const code = (error as { code?: unknown } | null)?.code
  return { ok: false, code: typeof code === 'string' ? code : null }
}

/** Starts the terminal program without a shell and resolves when it has started or failed to, never rejecting. */
export const launchTerminal: TerminalLauncher = (launch) =>
  new Promise<TerminalOutcome>((resolve) => {
    try {
      const child = spawn(launch.file, [...launch.args], {
        shell: false,
        detached: true,
        stdio: 'ignore',
        // The terminal's own window is the point: on Windows a detached console program (cmd.exe) gets a visible one.
        windowsHide: false,
        windowsVerbatimArguments: launch.verbatimArguments
      })
      child.once('error', (error) => {
        resolve(failure(error))
      })
      child.once('spawn', () => {
        child.unref()
        resolve({ ok: true })
      })
    } catch (error) {
      resolve(failure(error))
    }
  })
