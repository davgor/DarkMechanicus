#!/usr/bin/env node
/**
 * A stand-in agent CLI for terminal tests and the acceptance round (register it as a custom CLI).
 *
 * It reports what it was started with: its working folder, whether `DM_SESSION_TOKEN` is set (never the
 * value), and its exact argv. It echoes what is typed (the terminal is put in raw mode, so the echo is
 * this program's, not the terminal driver's) and reports every resize (SIGWINCH) with the new size.
 * Everything it reports is printed and also appended, one JSON object per line, to `agent-fixture.log`
 * in its working folder (its scratch folder); `AGENT_FIXTURE_LOG` names another file.
 *
 * Started with `--background-child`, it first starts a child of its own that ignores SIGHUP and runs
 * until it is killed, in the fixture's process group, waits until that child is ignoring SIGHUP, and
 * reports its pid: the backgrounded grandchild a process-tree kill must also end. Typing Ctrl-C makes it
 * exit with code 130.
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const LOG = process.env.AGENT_FIXTURE_LOG ?? join(process.cwd(), 'agent-fixture.log')
const CTRL_C = '\u0003'
/** Ignores SIGHUP (as `nohup` would), says so, closes its output and runs until it is killed. */
const BACKGROUND_CHILD = "process.on('SIGHUP', () => {}); process.stdout.end('ready'); setInterval(() => {}, 1000)"

function report(event) {
  appendFileSync(LOG, `${JSON.stringify(event)}\n`)
  process.stdout.write(`[fixture] ${JSON.stringify(event)}\r\n`)
}

function size() {
  const [cols, rows] = process.stdout.isTTY ? process.stdout.getWindowSize() : [null, null]
  return { cols, rows }
}

const argv = process.argv.slice(2)
report({ event: 'start', pid: process.pid, cwd: process.cwd(), sessionToken: process.env.DM_SESSION_TOKEN !== undefined, argv, ...size() })

if (argv.includes('--background-child')) {
  const child = spawn(process.execPath, ['-e', BACKGROUND_CHILD], { stdio: ['ignore', 'pipe', 'ignore'] })
  await once(child.stdout.resume(), 'end')
  child.unref()
  report({ event: 'background-child', pid: child.pid })
}

if (process.platform === 'win32') {
  process.stdout.on('resize', () => report({ event: 'resize', ...size() }))
} else {
  process.on('SIGWINCH', () => report({ event: 'sigwinch', ...size() }))
}

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (data) => {
  report({ event: 'input', data })
  if (data.includes(CTRL_C)) {
    process.exit(130)
  }
})
report({ event: 'ready' })
