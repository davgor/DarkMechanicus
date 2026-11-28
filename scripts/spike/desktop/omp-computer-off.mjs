/**
 * DM-1041 throwaway negative control for the "control active" signature: `node scripts/spike/desktop/omp-computer-off.mjs
 * [--on]` starts `omp --mode rpc-ui` with the same argv shape as `omp-computer-probe.mjs` but an overlay that leaves
 * `computer.enabled` at its default (or sets it with `--on`), sends no model prompt, asks `get_state` and
 * `/computer status`, and prints whether the system prompt carries the computer section and what the status line
 * says. No model request is made and nothing touches the desktop. Imported by no product code.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanEnv, killTree } from './fixture.mjs'

const ON = process.argv.includes('--on')
const OMP = join(homedir(), 'AppData', 'Local', 'omp', 'omp.exe')
const root = mkdtempSync(join(tmpdir(), 'dm1041-omp-off-'))
writeFileSync(join(root, 'config.yml'), ON ? 'setupVersion: 3\ncomputer:\n  enabled: true\n' : 'setupVersion: 3\n')
writeFileSync(join(root, 'instructions.md'), 'DM-1041 negative control: no prompt is sent.')
const args = [
  '--mode', 'rpc-ui', '--cwd', root, '--append-system-prompt', join(root, 'instructions.md'),
  '--config', join(root, 'config.yml'), '--session-dir', join(root, 'sessions'), '--max-time', '2m', '--max-cost', '0.01'
]
const child = spawn(OMP, args, { cwd: root, env: cleanEnv(), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
const result = { computerEnabledInOverlay: ON, systemPromptHasComputerSection: null, statusLine: null }
const timer = setTimeout(() => killTree(child), 90_000)
let buffer = ''

function onFrame(frame) {
  if (frame.type === 'ready') {
    child.stdin.write(`${JSON.stringify({ type: 'get_state', id: 'state' })}\n`)
    child.stdin.write(`${JSON.stringify({ type: 'prompt', id: 'status', message: '/computer status' })}\n`)
  }
  if (frame.id === 'state') result.systemPromptHasComputerSection = JSON.stringify(frame.data?.systemPrompt ?? '').includes('The `computer` eval prelude is enabled.')
  if (frame.type === 'command_output') result.statusLine = frame.text
  if (frame.id === 'status' && frame.type === 'response') child.stdin.end()
}

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop()
  for (const line of lines.filter((entry) => entry.trim())) onFrame(JSON.parse(line))
})
child.on('exit', (code) => {
  clearTimeout(timer)
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  process.stdout.write(`${JSON.stringify({ ...result, exitCode: code })}\n`)
})
