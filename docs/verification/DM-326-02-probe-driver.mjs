// Throwaway probe for DM-326: runs a CLI in a PTY with a headless screen, plays steps, logs output timing and
// whether each chunk changed the screen's lines. Usage: node probe.mjs <log> <cwd> <steps.json> <file> [args...]
import { createRequire } from 'node:module'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const require = createRequire('/Users/davidgorden/Documents/GitHub/DarkMechanicus-worktrees/DM-326/package.json')
const pty = require('node-pty')
const { Terminal } = require('@xterm/headless')

const [log, cwd, stepsFile, file, ...args] = process.argv.slice(2)
const steps = JSON.parse(readFileSync(stepsFile, 'utf8'))
writeFileSync(log, '')
const t0 = Date.now()
const say = (line) => appendFileSync(log, `${((Date.now() - t0) / 1000).toFixed(2)} ${line}\n`)
const term = new Terminal({ cols: 120, rows: 40, allowProposedApi: true })
const lines = () => {
  const out = []
  const b = term.buffer.active
  for (let i = 0; i < term.rows; i++) out.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '')
  return out
}
const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
delete env.NODE_OPTIONS
for (const k of Object.keys(env)) if (k.startsWith('ELECTRON_')) delete env[k]
const child = pty.spawn(file, args, { cwd, env, cols: 120, rows: 40, name: 'xterm-256color' })
say(`spawn pid=${child.pid} ${file} ${JSON.stringify(args)}`)
let phase = 'start'
const stats = {}
child.onData((data) => {
  const before = lines().join('\n')
  term.write(data, () => {
    const changed = lines().join('\n') !== before
    const s = (stats[phase] ??= { chunks: 0, bytes: 0, changing: 0 })
    s.chunks++
    s.bytes += data.length
    if (changed) s.changing++
    if (phase.startsWith('idle')) say(`[${phase}] chunk ${data.length}B changed=${changed} ${JSON.stringify(data.slice(0, 80))}`)
  })
})
let exited = null
child.onExit((e) => {
  exited = e
  say(`exit ${JSON.stringify(e)}`)
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (const step of steps) {
  if (exited) break
  if (step.phase) phase = step.phase
  if (step.write !== undefined) {
    say(`write ${JSON.stringify(step.write)}`)
    child.write(step.write)
  }
  if (step.wait) await sleep(step.wait)
  if (step.screen) say(`screen:\n${lines().filter((l) => l.trim() !== '').join('\n')}`)
}
say(`stats ${JSON.stringify(stats)}`)
if (!exited) {
  child.kill()
  await sleep(500)
}
say(`done exited=${JSON.stringify(exited)}`)
process.exit(0)
