import { AsyncLocalStorage } from 'node:async_hooks'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

export type SqlValue = null | number | bigint | string | Uint8Array

interface RunResult {
  changes: number
  lastInsertRowid: number
}

/**
 * Thin synchronous wrapper over node:sqlite. All writes go through `tx`, which opens
 * BEGIN IMMEDIATE so concurrent processes serialize on the write lock instead of deadlocking
 * on lock upgrades. Nested `tx` calls use savepoints.
 */
export interface Db {
  readonly path: string
  get<T>(sql: string, ...params: SqlValue[]): T | undefined
  all<T>(sql: string, ...params: SqlValue[]): T[]
  run(sql: string, ...params: SqlValue[]): RunResult
  exec(sql: string): void
  /** Read snapshots use deferred BEGIN, leaving the WAL writer available; writes keep BEGIN IMMEDIATE. */
  tx<T>(fn: () => T, mode?: 'read'): T
  inTransaction(): boolean
  close(): void
}

export interface OpenDatabaseOptions {
  /** For one-shot CLI processes, wait for an external writer and notify the supervising host. */
  onWriterBusy?: () => void
  busyTimeoutMs?: number
  /** Bounded retries when BEGIN IMMEDIATE still reports SQLITE_BUSY after the busy timeout. */
  beginRetries?: number
  /** Optional total lock-wait deadline for a one-shot connection, measured from open using a monotonic clock. */
  contentionTimeoutMs?: number
  /**
   * SQLite's synchronous setting (default 'full': a commit is on disk before it returns). 'off' leaves syncing to the
   * operating system; only test harnesses, whose databases are thrown away, pass it.
   */
  synchronous?: 'full' | 'off'
  /** Open an existing database without permission to create or mutate it. */
  readOnly?: boolean
  /**
   * Measurement only: called once per depth-0 write transaction after its COMMIT or ROLLBACK returns. Nested
   * savepoints and read snapshots are not reported. Absent (the default), nothing is timed or recorded. The observer
   * cannot change the transaction: it runs after the outcome is final and anything it throws is ignored.
   */
  onTransaction?: TransactionObserver
}

/** The caller a write transaction is attributed to; see `tagTransactions`. */
export type TransactionTag = 'reconcile' | 'flush' | 'command'

export interface TransactionHold {
  /** The innermost `tagTransactions` scope active when the transaction began; null outside any scope. */
  tag: TransactionTag | null
  outcome: 'commit' | 'rollback'
  /** Milliseconds spent acquiring `BEGIN IMMEDIATE`, including SQLite busy waits and begin retries. */
  acquireMs: number
  /** Milliseconds the write lock was held: from `BEGIN IMMEDIATE` returning to `COMMIT`/`ROLLBACK` returning. */
  holdMs: number
}

export type TransactionObserver = (hold: TransactionHold) => void

const transactionTags = new AsyncLocalStorage<TransactionTag>()
/** Open connections with an observer; while zero, `tagTransactions` only calls `fn`. */
let observedConnections = 0

/**
 * Attributes the depth-0 write transactions `fn` begins (synchronously or across its awaits) to `tag`, for a
 * connection opened with `onTransaction`. It never changes what `fn` does or returns, and costs one comparison while
 * no observed connection is open.
 */
export function tagTransactions<T>(tag: TransactionTag, fn: () => T): T {
  return observedConnections === 0 ? fn() : transactionTags.run(tag, fn)
}

export const DEFAULT_BUSY_TIMEOUT_MS = 5_000

export function isBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const errcode = (error as { errcode?: unknown }).errcode
  return typeof errcode === 'number'
    ? (errcode & 0xff) === 5 || (errcode & 0xff) === 6
    : /database(?: table| schema)? is (locked|busy)/i.test(error.message)
}

function applyPragmas(db: DatabaseSync, path: string, options: OpenDatabaseOptions): void {
  db.exec('PRAGMA foreign_keys = ON')
  if (path !== ':memory:' && options.readOnly !== true) {
    db.exec('PRAGMA journal_mode = WAL')
  }
  db.exec(options.synchronous === 'off' ? 'PRAGMA synchronous = OFF' : 'PRAGMA synchronous = FULL')
}

class SqliteDb implements Db {
  readonly path: string
  private readonly db: DatabaseSync
  private readonly statements = new Map<string, StatementSync>()
  private depth = 0
  /** Total `BEGIN IMMEDIATE` tries: at least one, and finite for any ordinary `beginRetries`. */
  private readonly beginAttempts: number
  private readonly onWriterBusy: (() => void) | undefined
  private readonly busyTimeoutMs: number
  private readonly contentionDeadline: number | undefined
  private activeBusyTimeoutMs = -1
  private readonly onTransaction: TransactionObserver | undefined

  constructor(path: string, options: OpenDatabaseOptions) {
    this.path = path
    this.onWriterBusy = options.onWriterBusy
    this.onTransaction = options.onTransaction
    this.busyTimeoutMs = Math.max(0, Math.floor(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS))
    this.contentionDeadline = options.contentionTimeoutMs === undefined ? undefined : performance.now() + options.contentionTimeoutMs
    this.beginAttempts = 1 + Math.max(0, Math.floor(options.beginRetries ?? 3) || 0)
    this.db = new DatabaseSync(path, { readOnly: options.readOnly ?? false })
    try {
      this.configureBusyTimeout()
      this.waitForWriter(() => applyPragmas(this.db, path, options))
    } catch (error) {
      this.db.close()
      throw error
    }
    if (this.onTransaction) observedConnections += 1
  }

  private configureBusyTimeout(): void {
    const limit = this.contentionDeadline === undefined ? this.busyTimeoutMs
      : Math.min(this.busyTimeoutMs, Math.max(0, Math.floor(this.contentionDeadline - performance.now())))
    if (limit === this.activeBusyTimeoutMs) return
    this.db.exec(`PRAGMA busy_timeout = ${limit}`)
    this.activeBusyTimeoutMs = limit
  }

  private statement(sql: string): StatementSync {
    if (this.contentionDeadline !== undefined) this.configureBusyTimeout()
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.statement(sql).get(...params) as T | undefined
  }

  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.statement(sql).all(...params) as T[]
  }

  run(sql: string, ...params: SqlValue[]): RunResult {
    const result = this.statement(sql).run(...params)
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
  }

  exec(sql: string): void {
    if (this.contentionDeadline !== undefined) this.configureBusyTimeout()
    this.db.exec(sql)
  }

  inTransaction(): boolean {
    return this.depth > 0
  }

  /** Only repeat lock acquisition or idempotent connection setup. Never replay a transaction body. */
  private waitForWriter(acquire: () => void): void {
    for (;;) {
      try {
        acquire()
        return
      } catch (error) {
        // SQLITE_LOCKED is a conflict on this connection. Waiting for another process cannot resolve it.
        if (!this.onWriterBusy || !(error instanceof Error) || (error as { errcode?: number }).errcode !== 5) throw error
        this.onWriterBusy()
      }
    }
  }

  private begin(): void {
    if (this.onWriterBusy) return this.waitForWriter(() => this.exec('BEGIN IMMEDIATE'))
    let busy: unknown
    for (let attempt = 0; attempt < this.beginAttempts; attempt += 1) {
      try {
        this.exec('BEGIN IMMEDIATE')
        return
      } catch (error: unknown) {
        if (!isBusyError(error) || (this.contentionDeadline !== undefined && performance.now() >= this.contentionDeadline)) {
          throw error
        }
        busy = error
      }
    }
    throw busy
  }

  private rollback(savepoint: string | null): void {
    try {
      this.db.exec(savepoint ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK')
    } catch {
      // SQLite already closed the transaction (e.g. after SQLITE_FULL); keep the original error.
    }
  }

  tx<T>(fn: () => T, mode?: 'read'): T {
    const savepoint = this.depth > 0 ? `sp_${this.depth}` : null
    let observed: ObservedHold | undefined
    if (savepoint) {
      this.db.exec(`SAVEPOINT ${savepoint}`)
    } else if (mode === 'read') {
      this.db.exec('BEGIN')
    } else if (this.onTransaction) {
      const requested = performance.now()
      this.begin()
      const began = performance.now()
      observed = { tag: transactionTags.getStore() ?? null, acquireMs: began - requested, began, outcome: 'rollback' }
    } else {
      this.begin()
    }
    this.depth += 1
    try {
      const result = fn()
      this.exec(savepoint ? `RELEASE ${savepoint}` : 'COMMIT')
      if (observed) observed.outcome = 'commit'
      return result
    } catch (error: unknown) {
      this.rollback(savepoint)
      throw error
    } finally {
      this.depth -= 1
      if (observed) this.report(observed)
    }
  }

  private report({ tag, outcome, acquireMs, began }: ObservedHold): void {
    const holdMs = performance.now() - began
    try {
      this.onTransaction?.({ tag, outcome, acquireMs, holdMs })
    } catch {
      // Measurement never changes a transaction's outcome.
    }
  }

  close(): void {
    this.statements.clear()
    this.db.close()
    if (this.onTransaction) observedConnections -= 1
  }
}

interface ObservedHold {
  tag: TransactionTag | null
  outcome: TransactionHold['outcome']
  acquireMs: number
  began: number
}

export function openDatabase(path: string, options: OpenDatabaseOptions = {}): Db {
  return new SqliteDb(path, options)
}

/** Check a workspace's storage fence after acquiring its write lock, including callers
 * that retained a context across asynchronous verification or waited behind another process.
 * Only a depth-0 transaction checks: a nested savepoint already runs under a checked one. */
export function guardTransactions(db: Db, guard: () => void): Db {
  return {
    path: db.path,
    get: db.get.bind(db), all: db.all.bind(db), run: db.run.bind(db), exec: db.exec.bind(db),
    inTransaction: db.inTransaction.bind(db), close: db.close.bind(db),
    tx: (fn, mode) => (db.inTransaction() ? db.tx(fn, mode) : db.tx(() => { guard(); return fn() }, mode))
  }
}

/** Parses a JSON column; null/empty columns map to `fallback`. */
export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') {
    return fallback
  }
  return JSON.parse(text) as T
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null)
}

export function bool(value: boolean): number {
  return value ? 1 : 0
}
