/**
 * Measurement only: a `node --require` preload for the built `dm` CLI (`out/main/cli.js`) that appends one JSON line
 * per process to `$DM_CLI_PHASE_LOG`: where the call's wall time went. The revamp harness adds it to its CLI agents
 * when `DM_REVAMP_CLI_PHASES=1`; without the variable it does nothing. It wraps the bundle's exported entry points
 * (`openWorkspace`, `tagTransactions`) and, process-wide, synchronous git runs and SQLite `BEGIN IMMEDIATE`/`COMMIT`,
 * so it attributes the same phases on any build that exports them. App behaviour is unchanged.
 *
 * Phases: `open` (migrations, identity, session register, open reconcile and flush), `reconcile` and `flush` nested in
 * it or in `execute`, `command` (the command itself), `close` (the session audit). Each phase records its own wall time
 * and, for work done while it was the innermost phase, git runs and writer waits (`BEGIN IMMEDIATE` time, which is
 * SQLite's busy wait) and holds.
 */
'use strict'
const { appendFileSync } = require('node:fs')
const Module = require('node:module')
const childProcess = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')
const { performance } = require('node:perf_hooks')

const LOG = process.env['DM_CLI_PHASE_LOG']
const preloadAt = performance.now()
const phases = {}
const stack = []
const marks = { preload: preloadAt }

function bucket(name) {
  phases[name] ??= { n: 0, ms: 0, gitN: 0, gitMs: 0, git: {}, beginN: 0, beginWaitMs: 0, busy: 0, holdMs: 0, fileReads: 0 }
  return phases[name]
}

/** What each automatic reconcile returned: its result lists, counted. */
const reconciles = []

function wrapFileReads() {
  const fs = require('node:fs')
  const readFileSync = fs.readFileSync
  fs.readFileSync = function countedReadFileSync(...args) {
    current().fileReads += 1
    return readFileSync.apply(this, args)
  }
}

function current() {
  return bucket(stack.at(-1) ?? 'outside')
}

function timed(name, fn) {
  const started = performance.now()
  stack.push(name)
  const end = () => {
    stack.splice(stack.lastIndexOf(name), 1)
    const entry = bucket(name)
    entry.n += 1
    entry.ms += performance.now() - started
  }
  let result
  try {
    result = fn()
  } catch (error) {
    end()
    throw error
  }
  if (result instanceof Promise) return result.finally(end)
  end()
  return result
}

function wrapGit() {
  const execFileSync = childProcess.execFileSync
  childProcess.execFileSync = function timedExecFileSync(file, args, ...rest) {
    const started = performance.now()
    try {
      return execFileSync.call(this, file, args, ...rest)
    } finally {
      const entry = current()
      const verb = Array.isArray(args) ? args.find((arg, index) => index > 0 && !arg.startsWith('-') && args[index - 1] !== '-C') ?? '?' : '?'
      entry.gitN += 1
      entry.gitMs += performance.now() - started
      entry.git[verb] = (entry.git[verb] ?? 0) + 1
    }
  }
}

function wrapSqlite() {
  const exec = DatabaseSync.prototype.exec
  let began = null
  DatabaseSync.prototype.exec = function timedExec(sql) {
    const started = performance.now()
    const begin = sql.startsWith('BEGIN IMMEDIATE')
    try {
      const result = exec.call(this, sql)
      if (begin) began = performance.now()
      return result
    } catch (error) {
      if (begin) current().busy += 1
      throw error
    } finally {
      settle(sql, started, begin)
    }
  }
  function settle(sql, started, begin) {
    const entry = current()
    if (begin) {
      entry.beginN += 1
      entry.beginWaitMs += performance.now() - started
    } else if (began !== null && (sql === 'COMMIT' || sql === 'ROLLBACK')) {
      entry.holdMs += performance.now() - began
      began = null
    }
  }
}

function wrapWorkspace(exports) {
  const open = exports.openWorkspace
  exports.openWorkspace = (options) => {
    marks.open = performance.now()
    const workspace = timed('open', () => open(options))
    marks.opened = performance.now()
    const execute = workspace.execute
    const close = workspace.close
    workspace.execute = (name, input) => timed('execute', () => execute(name, input))
    workspace.close = () => timed('close', () => close())
    return workspace
  }
}

function wrapTags(exports) {
  const tag = exports.tagTransactions
  exports.tagTransactions = (name, fn) => timed(name, () => {
    const result = tag(name, fn)
    if (name === 'reconcile' && result !== null && typeof result === 'object' && !(result instanceof Promise)) {
      reconciles.push(Object.fromEntries(Object.entries(result).map(([key, value]) => [key, Array.isArray(value) ? value.length : value])))
    }
    return result
  })
}

/** Each fingerprint gate's answers (`reconcileFingerprint.ts`), where the build exports `reconcileGate`. */
const gates = []

function wrapGate(exports) {
  const gate = exports.reconcileGate
  exports.reconcileGate = (deps, automatic) => {
    const made = gate(deps, automatic)
    // The stored fingerprint, shortened: its tracked part (files and HEAD) and its machine-local part, with the local
    // inputs as `fingerprint()` in `reconcileFingerprint.ts` reads them now.
    const stored = () => {
      const value = deps.db.get("SELECT value FROM meta WHERE key = 'reconcile_fingerprint'")?.value ?? ''
      const [tracked = '', local = ''] = value.split(':')
      const outbox = deps.db.all("SELECT id, state, kind FROM outbox WHERE state IN ('pending', 'failed') ORDER BY id").map((row) => `${row.id}:${row.state}:${row.kind}`)
      const counts = deps.db.get(`SELECT (SELECT count(*) FROM sync_state) AS synced, (SELECT max(updated_at) FROM sync_state) AS syncedAt,
        (SELECT count(*) FROM sync_state WHERE conflict IS NOT NULL) AS conflicts, (SELECT count(*) FROM plan_revisions WHERE state = 'pending') AS pendingPlans,
        (SELECT count(*) FROM epics) AS epics, (SELECT count(*) FROM attachments WHERE owner_kind IS NOT NULL) AS owned,
        (SELECT coalesce(max(rowid), 0) FROM attachments) AS lastAttachment`)
      return `${tracked.slice(0, 6)}:${local.slice(0, 4)} ${JSON.stringify([outbox, counts])}`
    }
    const trace = { automatic, at: [], current: [], seen: [], stale: [], applied: 0, recorded: null }
    gates.push(trace)
    return {
      current: () => {
        const hit = made.current()
        trace.current.push(hit)
        trace.seen.push(stored())
        trace.at.push(round(performance.timeOrigin + performance.now()))
        return hit
      },
      applied: (result) => {
        trace.applied += 1
        made.applied(result)
        trace.recorded = stored()
        trace.recordedAt = round(performance.timeOrigin + performance.now())
      },
      ...(made.stale ? { stale: (result) => { const stale = made.stale(result); trace.stale.push(stale); return stale } } : {})
    }
  }
}

function patch(module, filename) {
  const exports = module.exports
  if (typeof exports?.openWorkspace === 'function' && /[\\/]workspace-[^\\/]+\.js$/.test(filename)) wrapWorkspace(exports)
  if (typeof exports?.tagTransactions === 'function') wrapTags(exports)
  if (typeof exports?.reconcileGate === 'function') wrapGate(exports)
}

function round(value) {
  return Math.round(value * 10) / 10
}

function writeLine() {
  const now = performance.now()
  const rounded = Object.fromEntries(Object.entries(phases).map(([name, entry]) => [name, {
    ...entry, ms: round(entry.ms), gitMs: round(entry.gitMs), beginWaitMs: round(entry.beginWaitMs), holdMs: round(entry.holdMs)
  }]))
  const argv = process.argv.slice(2)
  appendFileSync(LOG, JSON.stringify({
    at: performance.timeOrigin + now, pid: process.pid, command: argv[argv.indexOf('call') + 1] ?? null,
    marks: Object.fromEntries(Object.entries({ ...marks, exit: now }).map(([key, value]) => [key, round(value)])),
    phases: rounded, reconciles, gates
  }) + '\n')
}

if (LOG) {
  wrapGit()
  wrapSqlite()
  wrapFileReads()
  const load = Module._extensions['.js']
  Module._extensions['.js'] = function loadAndPatch(module, filename) {
    load.call(this, module, filename)
    patch(module, filename)
  }
  process.on('exit', writeLine)
}
