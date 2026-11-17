/**
 * DM-505 acceptance instrumentation (not product code): preloaded into the built `dm` CLI with
 * `NODE_OPTIONS=--require <this file>` to count the filesystem and child-process calls one CLI process makes, so the
 * 1000-poll smoke can show from the outside that a restricted status/wake poll does no record reconcile, portable flush,
 * staged-image pruning or Git work, while an ordinary CLI call (the positive control) does. One JSON line per process
 * is appended to $DM505_PROBE_OUT on exit. It records counts only, never arguments, environment or output.
 */
'use strict'
const fs = require('node:fs')
const childProcess = require('node:child_process')

const out = process.env.DM505_PROBE_OUT
const append = fs.appendFileSync
const counts = {}

function wrap(target, name, key) {
  const original = target[name]
  if (typeof original !== 'function') return
  target[name] = function counted(...args) {
    counts[key] = (counts[key] ?? 0) + 1
    return original.apply(this, args)
  }
}

for (const name of ['readdirSync', 'opendirSync', 'writeFileSync', 'renameSync', 'rmSync', 'unlinkSync', 'rmdirSync', 'mkdirSync', 'copyFileSync', 'readdir', 'writeFile', 'rename', 'rm', 'unlink', 'mkdir']) {
  wrap(fs, name, `fs.${name}`)
}
for (const name of ['readdir', 'opendir', 'writeFile', 'rename', 'rm', 'unlink', 'rmdir', 'mkdir', 'copyFile']) {
  wrap(fs.promises, name, `fs.promises.${name}`)
}
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
  wrap(childProcess, name, `child_process.${name}`)
}

process.on('exit', (code) => {
  if (out) append(out, `${JSON.stringify({ pid: process.pid, command: process.argv[process.argv.indexOf('call') + 1] ?? null, exitCode: code, counts })}\n`)
})
