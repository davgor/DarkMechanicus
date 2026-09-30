import { DatabaseSync, type StatementSync } from 'node:sqlite'

export type SqlValue = null | number | bigint | string | Uint8Array

export interface RunResult {
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
  tx<T>(fn: () => T): T
  inTransaction(): boolean
  close(): void
}

export interface OpenDatabaseOptions {
  busyTimeoutMs?: number
  /** Bounded retries when BEGIN IMMEDIATE still reports SQLITE_BUSY after the busy timeout. */
  beginRetries?: number
}

export const DEFAULT_BUSY_TIMEOUT_MS = 5_000

export function isBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const errcode = (error as { errcode?: unknown }).errcode
  return errcode === 5 || errcode === 6 || /database is (locked|busy)/i.test(error.message)
}

function applyPragmas(db: DatabaseSync, path: string, busyTimeoutMs: number): void {
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`)
  db.exec('PRAGMA foreign_keys = ON')
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL')
  }
  db.exec('PRAGMA synchronous = FULL')
}

class SqliteDb implements Db {
  readonly path: string
  private readonly db: DatabaseSync
  private readonly statements = new Map<string, StatementSync>()
  private depth = 0
  private readonly beginRetries: number

  constructor(path: string, options: OpenDatabaseOptions) {
    this.path = path
    this.db = new DatabaseSync(path)
    this.beginRetries = options.beginRetries ?? 3
    applyPragmas(this.db, path, options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS)
  }

  private statement(sql: string): StatementSync {
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
    this.db.exec(sql)
  }

  inTransaction(): boolean {
    return this.depth > 0
  }

  private begin(): void {
    for (let attempt = 0; ; attempt += 1) {
      try {
        this.db.exec('BEGIN IMMEDIATE')
        return
      } catch (error: unknown) {
        if (!isBusyError(error) || attempt >= this.beginRetries) {
          throw error
        }
      }
    }
  }

  private rollback(savepoint: string | null): void {
    try {
      this.db.exec(savepoint ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK')
    } catch {
      // SQLite already closed the transaction (e.g. after SQLITE_FULL); keep the original error.
    }
  }

  tx<T>(fn: () => T): T {
    const savepoint = this.depth > 0 ? `sp_${this.depth}` : null
    if (savepoint) {
      this.db.exec(`SAVEPOINT ${savepoint}`)
    } else {
      this.begin()
    }
    this.depth += 1
    try {
      const result = fn()
      this.db.exec(savepoint ? `RELEASE ${savepoint}` : 'COMMIT')
      return result
    } catch (error: unknown) {
      this.rollback(savepoint)
      throw error
    } finally {
      this.depth -= 1
    }
  }

  close(): void {
    this.statements.clear()
    this.db.close()
  }
}

export function openDatabase(path: string, options: OpenDatabaseOptions = {}): Db {
  return new SqliteDb(path, options)
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
