/**
 * Spike (board 009.6): competing claims across OS processes sharing one SQLite file.
 *
 *   npx tsx scripts/spike/claim-stress.ts [workers=8] [rounds=25]
 *
 * The parent seeds a temporary database (epic, saved revision, running run, one ready ticket) and
 * forks `workers` child processes, each with its own connection. Every round the parent releases all
 * children at the same instant; each calls `claimTicket` for the same ticket. Exactly one must win and
 * every other child must see `already_claimed` (or give up on a busy lock), leaving exactly one open
 * attempt. Between rounds the parent cancels the winning attempt with SQL. Exits non-zero on any
 * violation.
 */
import { type ChildProcess, fork } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { capabilitiesForRole } from '../../src/core/authz'
import { createSystemClock } from '../../src/core/clock'
import type { Ctx } from '../../src/core/context'
import { type Db, isBusyError, openDatabase } from '../../src/core/db/database'
import { migrate } from '../../src/core/db/migrations'
import { DomainError } from '../../src/core/errors'
import { createIdGenerator } from '../../src/core/ids'
import { claimTicket } from '../../src/core/services/attempts'
import { startRun } from '../../src/core/services/runs'
import { makeBundle, tid } from '../../src/test/bundles'
import { seedEpic } from '../../src/test/execution'

const MACHINE_ID = 'mc_claimstress00000000000001'
const PROJECT_ID = 'pj_claimstress00000000000001'
const RELEASE_DELAY_MS = 400
const ALLOWED_LOSSES = new Set(['already_claimed', 'busy'])

interface Target {
  dbPath: string
  runId: string
  ticketId: string
}

type ParentMessage = { type: 'round'; round: number; startAt: number } | { type: 'exit' }

interface ClaimOutcome {
  type: 'result'
  round: number
  pid: number
  outcome: string
  attemptId: string | null
  releasedAt: number
  elapsedMs: number
  /** Busy-wait iterations before the release instant; 0 means the child arrived late. */
  spins: number
}

type ChildMessage = { type: 'ready'; pid: number } | ClaimOutcome

interface Worker {
  child: ChildProcess
  inbox: ChildMessage[]
  waiters: ((message: ChildMessage) => void)[]
}

interface RoundReport {
  round: number
  winners: ClaimOutcome[]
  losses: Record<string, number>
  openAttempts: number
  spreadMs: number
  late: number
  slowestMs: number
  /** Losers released while the winner's claim was still in flight (true contention). */
  contended: number
  ok: boolean
}

function makeCtx(db: Db, label: string): Ctx {
  return {
    db,
    clock: createSystemClock(),
    ids: createIdGenerator(),
    session: {
      id: `ss_${label}`,
      role: 'orchestrator',
      label,
      capabilities: new Set(capabilitiesForRole('orchestrator'))
    },
    machineId: MACHINE_ID,
    projectId: PROJECT_ID,
    assertBranch: () => undefined,
    checkout: () => ({ branch: null, commit: null })
  }
}

// ---------------------------------------------------------------------------------------------
// Child process: one connection, one claim per round.

function now(): number {
  return performance.timeOrigin + performance.now()
}

function claimOnce(ctx: Ctx, target: Target): { outcome: string; attemptId: string | null } {
  try {
    const result = claimTicket(ctx, { runId: target.runId, ticketId: target.ticketId, worker: { label: ctx.session.label } })
    return { outcome: 'claimed', attemptId: result.attempt.id }
  } catch (error: unknown) {
    if (error instanceof DomainError) {
      return { outcome: error.code, attemptId: null }
    }
    return { outcome: isBusyError(error) ? 'busy' : `error:${String(error)}`, attemptId: null }
  }
}

function claimAt(ctx: Ctx, target: Target, message: { round: number; startAt: number }): ClaimOutcome {
  let spins = 0
  while (now() < message.startAt) {
    spins += 1
  }
  const releasedAt = now()
  const { outcome, attemptId } = claimOnce(ctx, target)
  return {
    type: 'result',
    round: message.round,
    pid: process.pid,
    outcome,
    attemptId,
    releasedAt,
    elapsedMs: now() - releasedAt,
    spins
  }
}

function runChild(target: Target): void {
  const ctx = makeCtx(openDatabase(target.dbPath), `stress-child-${process.pid}`)
  process.on('message', (message: ParentMessage) => {
    if (message.type === 'exit') {
      ctx.db.close()
      process.exit(0)
    }
    process.send?.(claimAt(ctx, target, message))
  })
  process.send?.({ type: 'ready', pid: process.pid })
}

// ---------------------------------------------------------------------------------------------
// Parent process: seed, fork, release rounds, verify, reset.

function seed(dbPath: string): Target {
  const db = openDatabase(dbPath)
  migrate(db)
  const ctx = makeCtx(db, 'stress-parent')
  const { epicId } = seedEpic(ctx, { bundle: makeBundle([[1]]) })
  const run = startRun(ctx, { epicId })
  db.close()
  return { dbPath, runId: run.id, ticketId: tid(1) }
}

function receive(worker: Worker): Promise<ChildMessage> {
  const queued = worker.inbox.shift()
  if (queued) {
    return Promise.resolve(queued)
  }
  return new Promise((resolve) => worker.waiters.push(resolve))
}

function spawnWorker(self: string, target: Target): Worker {
  const child = fork(self, ['child', target.dbPath, target.runId, target.ticketId], {
    execArgv: ['--import', 'tsx', '--disable-warning=ExperimentalWarning']
  })
  const worker: Worker = { child, inbox: [], waiters: [] }
  child.on('message', (message: ChildMessage) => {
    const waiter = worker.waiters.shift()
    if (waiter) {
      waiter(message)
    } else {
      worker.inbox.push(message)
    }
  })
  return worker
}

function countOpen(db: Db, target: Target): number {
  const row = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM attempts WHERE run_id = ? AND ticket_id = ? AND state IN ('claimed', 'running', 'submitted')",
    target.runId,
    target.ticketId
  )
  return row?.n ?? 0
}

function resetClaims(db: Db, target: Target): void {
  db.tx(() => {
    db.run(
      `UPDATE attempts SET state = 'canceled', lease_expires_at = NULL, updated_at = ?
       WHERE run_id = ? AND ticket_id = ? AND state IN ('claimed', 'running', 'submitted')`,
      new Date().toISOString(),
      target.runId,
      target.ticketId
    )
  })
}

function summarize(round: number, outcomes: ClaimOutcome[], openAttempts: number): RoundReport {
  const winners = outcomes.filter((item) => item.outcome === 'claimed')
  const losses: Record<string, number> = {}
  for (const item of outcomes.filter((entry) => entry.outcome !== 'claimed')) {
    losses[item.outcome] = (losses[item.outcome] ?? 0) + 1
  }
  const released = outcomes.map((item) => item.releasedAt)
  const spreadMs = Math.max(...released) - Math.min(...released)
  const lossesAllowed = Object.keys(losses).every((outcome) => ALLOWED_LOSSES.has(outcome))
  const winnerDone = winners.length === 1 ? winners[0].releasedAt + winners[0].elapsedMs : 0
  return {
    round,
    winners,
    losses,
    openAttempts,
    spreadMs,
    late: outcomes.filter((item) => item.spins === 0).length,
    slowestMs: Math.max(...outcomes.map((item) => item.elapsedMs)),
    contended: outcomes.filter((item) => item.outcome !== 'claimed' && item.releasedAt < winnerDone).length,
    ok: winners.length === 1 && lossesAllowed && openAttempts === 1
  }
}

async function playRound(workers: Worker[], db: Db, target: Target, round: number): Promise<RoundReport> {
  const startAt = now() + RELEASE_DELAY_MS
  for (const worker of workers) {
    worker.child.send({ type: 'round', round, startAt } satisfies ParentMessage)
  }
  const messages = await Promise.all(workers.map(receive))
  const outcomes = messages.filter((message): message is ClaimOutcome => message.type === 'result')
  const report = summarize(round, outcomes, countOpen(db, target))
  resetClaims(db, target)
  return report
}

function describeRound(report: RoundReport): string {
  const winner = report.winners.map((item) => `pid ${item.pid} (${item.attemptId ?? '?'})`).join(', ') || 'none'
  const losses = Object.entries(report.losses).map(([outcome, count]) => `${outcome}=${count}`).join(' ')
  const verdict = report.ok ? 'ok' : 'VIOLATION'
  const timing = `contended=${report.contended} release-spread=${report.spreadMs.toFixed(2)}ms late=${report.late} slowest-claim=${report.slowestMs.toFixed(1)}ms`
  return `round ${String(report.round).padStart(2)}: ${verdict} winner=${winner} losers[${losses}] open=${report.openAttempts} ${timing}`
}

async function stopWorkers(workers: Worker[]): Promise<void> {
  await Promise.all(
    workers.map(
      (worker) =>
        new Promise<void>((resolve) => {
          worker.child.once('exit', () => resolve())
          worker.child.send({ type: 'exit' } satisfies ParentMessage)
        })
    )
  )
}

async function runParent(self: string, workerCount: number, rounds: number): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), 'dm-claim-stress-'))
  try {
    const target = seed(join(dir, 'state.sqlite'))
    const workers = Array.from({ length: workerCount }, () => spawnWorker(self, target))
    await Promise.all(workers.map(receive))
    const db = openDatabase(target.dbPath)
    const reports: RoundReport[] = []
    for (let round = 1; round <= rounds; round += 1) {
      reports.push(await playRound(workers, db, target, round))
      console.log(describeRound(reports[reports.length - 1]))
    }
    db.close()
    await stopWorkers(workers)
    const failed = reports.filter((report) => !report.ok).length
    const contendedRounds = reports.filter((report) => report.contended > 0).length
    const contenders = reports.reduce((sum, report) => sum + report.contended, 0)
    console.log(
      `\n${workerCount} processes x ${rounds} rounds: ${rounds - failed}/${rounds} rounds with exactly one winner and ` +
        `only already_claimed/busy losers. ${contendedRounds}/${rounds} rounds had losers racing the winner's in-flight ` +
        `claim (${contenders} racing claims in total).`
    )
    return failed === 0
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const self = fileURLToPath(import.meta.url)
const [mode, ...args] = process.argv.slice(2)
if (mode === 'child') {
  runChild({ dbPath: args[0] ?? '', runId: args[1] ?? '', ticketId: args[2] ?? '' })
} else {
  runParent(self, Number(mode ?? 8), Number(args[0] ?? 25)).then(
    (ok) => {
      process.exitCode = ok ? 0 : 1
    },
    (error: unknown) => {
      console.error(error)
      process.exitCode = 1
    }
  )
}
