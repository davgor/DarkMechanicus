import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bool,
  DEFAULT_BUSY_TIMEOUT_MS,
  type Db,
  isBusyError,
  type OpenDatabaseOptions,
  openDatabase,
  parseJson,
  toJson
} from './database'

const tempDirs: string[] = []
const openDbs: Db[] = []

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dm-db-test-'))
  tempDirs.push(dir)
  return join(dir, 'state.sqlite')
}

function open(path = ':memory:', options: OpenDatabaseOptions = {}): Db {
  const db = openDatabase(path, options)
  openDbs.push(db)
  return db
}

function openWithNotes(path = ':memory:'): Db {
  const db = open(path)
  db.exec('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, name TEXT)')
  return db
}

function names(db: Db): string[] {
  return db.all<{ name: string }>('SELECT name FROM notes ORDER BY id').map((row) => row.name)
}

function add(db: Db, name: string): void {
  db.run('INSERT INTO notes (name) VALUES (?)', name)
}

function thrownBy(action: () => unknown): unknown {
  try {
    action()
  } catch (error: unknown) {
    return error
  }
  return undefined
}

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close()
    } catch {
      // already closed by the test
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('isBusyError', () => {
  it.each([[5], [6]])('recognizes sqlite error code %i', (errcode) => {
    expect(isBusyError(Object.assign(new Error('something'), { errcode }))).toBe(true)
  })

  it.each([['database is locked'], ['Database is BUSY'], ['sqlite: database is locked (5)']])(
    'recognizes the message "%s"',
    (message) => {
      expect(isBusyError(new Error(message))).toBe(true)
    }
  )

  it('rejects other errors', () => {
    expect(isBusyError(new Error('no such table: x'))).toBe(false)
    expect(isBusyError(Object.assign(new Error('constraint'), { errcode: 19 }))).toBe(false)
    expect(isBusyError(Object.assign(new Error('x'), { errcode: '5' }))).toBe(false)
  })

  it.each([['database is locked'], [{ errcode: 5 }], [null], [undefined], [5]])(
    'rejects the non-Error value %s',
    (value) => {
      expect(isBusyError(value)).toBe(false)
    }
  )
})

describe('parseJson', () => {
  it('returns the fallback for null, undefined and empty text', () => {
    const fallback = { fallback: true }
    expect(parseJson(null, fallback)).toBe(fallback)
    expect(parseJson(undefined, fallback)).toBe(fallback)
    expect(parseJson('', fallback)).toBe(fallback)
  })

  it('parses valid JSON text', () => {
    expect(parseJson('{"a":[1,2]}', {})).toEqual({ a: [1, 2] })
    expect(parseJson('"x"', 'fallback')).toBe('x')
    expect(parseJson('0', 5)).toBe(0)
    expect(parseJson('false', true)).toBe(false)
  })

  it('returns a stored JSON null rather than the fallback', () => {
    expect(parseJson('null', { fallback: true })).toBeNull()
  })

  it('throws on malformed JSON', () => {
    expect(() => parseJson('{oops', {})).toThrow(SyntaxError)
  })
})

describe('toJson and bool', () => {
  it('serializes values and maps undefined to null', () => {
    expect(toJson({ a: 1, b: [true] })).toBe('{"a":1,"b":[true]}')
    expect(toJson(undefined)).toBe('null')
    expect(toJson(null)).toBe('null')
  })

  it('keeps falsy values that are not nullish', () => {
    expect(toJson(false)).toBe('false')
    expect(toJson(0)).toBe('0')
    expect(toJson('')).toBe('""')
  })

  it('maps booleans to 1 and 0', () => {
    expect(bool(true)).toBe(1)
    expect(bool(false)).toBe(0)
  })
})

describe('openDatabase pragmas', () => {
  it('exposes its path', () => {
    const path = tempDbPath()
    expect(open(path).path).toBe(path)
    expect(open(':memory:').path).toBe(':memory:')
  })

  it('applies the default busy timeout, foreign keys and full synchronous', () => {
    const db = open()
    expect(DEFAULT_BUSY_TIMEOUT_MS).toBe(5000)
    expect(db.get<{ timeout: number }>('PRAGMA busy_timeout')?.timeout).toBe(5000)
    expect(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys).toBe(1)
    expect(db.get<{ synchronous: number }>('PRAGMA synchronous')?.synchronous).toBe(2)
  })

  it('uses a custom busy timeout, flooring fractions and clamping negatives to zero', () => {
    const timeout = (options: OpenDatabaseOptions): number | undefined =>
      open(':memory:', options).get<{ timeout: number }>('PRAGMA busy_timeout')?.timeout
    expect(timeout({ busyTimeoutMs: 1234 })).toBe(1234)
    expect(timeout({ busyTimeoutMs: 12.9 })).toBe(12)
    expect(timeout({ busyTimeoutMs: -50 })).toBe(0)
    expect(timeout({ busyTimeoutMs: 0 })).toBe(0)
  })

  it('keeps the in-memory journal but switches file databases to WAL', () => {
    const journal = (db: Db): string | undefined =>
      db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode
    expect(journal(open(':memory:'))).toBe('memory')
    expect(journal(open(tempDbPath()))).toBe('wal')
  })

  it('enforces foreign keys', () => {
    const db = open()
    db.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY)')
    db.exec('CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))')
    expect(() => db.run('INSERT INTO child (parent_id) VALUES (?)', 99)).toThrow(/FOREIGN KEY constraint failed/)
  })

  it('fails to open a database in a missing directory', () => {
    expect(() => openDatabase(join(tempDbPath(), 'missing', 'state.sqlite'))).toThrow()
  })
})

describe('run, get and all', () => {
  it('reports changes and the last inserted row id as numbers', () => {
    const db = openWithNotes()
    const first = db.run('INSERT INTO notes (name) VALUES (?)', 'a')
    const second = db.run('INSERT INTO notes (name) VALUES (?)', 'b')
    expect(first).toEqual({ changes: 1, lastInsertRowid: 1 })
    expect(second).toEqual({ changes: 1, lastInsertRowid: 2 })
    expect(typeof second.changes).toBe('number')
    expect(typeof second.lastInsertRowid).toBe('number')
  })

  it('counts every row an update touches and zero when nothing matches', () => {
    const db = openWithNotes()
    add(db, 'a')
    add(db, 'a')
    add(db, 'b')
    expect(db.run("UPDATE notes SET name = 'z' WHERE name = ?", 'a').changes).toBe(2)
    expect(db.run("UPDATE notes SET name = 'z' WHERE name = ?", 'missing').changes).toBe(0)
  })

  it('returns undefined for a missing row and an empty list for no rows', () => {
    const db = openWithNotes()
    expect(db.get('SELECT * FROM notes WHERE id = ?', 1)).toBeUndefined()
    expect(db.all('SELECT * FROM notes')).toEqual([])
  })

  it('returns rows in query order', () => {
    const db = openWithNotes()
    add(db, 'first')
    add(db, 'second')
    expect(db.get<{ name: string }>('SELECT name FROM notes WHERE id = ?', 2)?.name).toBe('second')
    expect(names(db)).toEqual(['first', 'second'])
  })

})

describe('parameter binding', () => {
  it('round-trips null, strings, numbers and blobs as parameters', () => {
    const db = open()
    const row = db.get<{ a: null; b: string; c: number; d: Uint8Array }>(
      'SELECT ? AS a, ? AS b, ? AS c, ? AS d',
      null,
      'text',
      2.5,
      new Uint8Array([1, 2, 3])
    )
    expect(row?.a).toBeNull()
    expect(row?.b).toBe('text')
    expect(row?.c).toBe(2.5)
    expect([...(row?.d ?? [])]).toEqual([1, 2, 3])
  })

  it('binds bigint parameters', () => {
    const db = open()
    expect(db.get<{ n: number }>('SELECT ? AS n', 5n)?.n).toBe(5)
  })

  it('executes several statements with exec', () => {
    const db = open()
    db.exec('CREATE TABLE a (x); INSERT INTO a VALUES (1); INSERT INTO a VALUES (2)')
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM a')?.n).toBe(2)
  })
})

describe('statement reuse', () => {
  it('rebinds parameters on every call of the same SQL', () => {
    const db = open()
    const sql = 'SELECT ? AS v'
    expect(db.get<{ v: number }>(sql, 1)?.v).toBe(1)
    expect(db.all<{ v: number }>(sql, 2)).toEqual([{ v: 2 }])
    expect(db.get<{ v: number }>(sql, 3)?.v).toBe(3)
    expect(db.get<{ v: string }>(sql, 'x')?.v).toBe('x')
  })

  it('reuses one statement for repeated writes', () => {
    const db = openWithNotes()
    for (const name of ['a', 'b', 'c']) {
      add(db, name)
    }
    expect(names(db)).toEqual(['a', 'b', 'c'])
    expect(db.run('DELETE FROM notes WHERE name = ?', 'b').changes).toBe(1)
    expect(names(db)).toEqual(['a', 'c'])
  })

  it('stays usable after a statement failed', () => {
    const db = openWithNotes()
    db.run('INSERT INTO notes (id, name) VALUES (?, ?)', 1, 'a')
    expect(() => db.run('INSERT INTO notes (id, name) VALUES (?, ?)', 1, 'dup')).toThrow(/UNIQUE constraint failed/)
    db.run('INSERT INTO notes (id, name) VALUES (?, ?)', 2, 'b')
    expect(names(db)).toEqual(['a', 'b'])
  })

  it('refuses to run after close', () => {
    const db = open()
    expect(db.get<{ one: number }>('SELECT 1 AS one')?.one).toBe(1)
    db.close()
    expect(() => db.get('SELECT 1 AS one')).toThrow(/not open/)
  })
})

describe('tx commit and rollback', () => {
  it('returns the callback result and commits its writes', () => {
    const db = openWithNotes()
    const result = db.tx(() => {
      add(db, 'kept')
      return 'result'
    })
    expect(result).toBe('result')
    expect(names(db)).toEqual(['kept'])
  })

  it('reports inTransaction only while a transaction is open', () => {
    const db = openWithNotes()
    const seen: boolean[] = [db.inTransaction()]
    db.tx(() => seen.push(db.inTransaction()))
    seen.push(db.inTransaction())
    expect(seen).toEqual([false, true, false])
  })

  it('rolls back on a throw and rethrows the same error', () => {
    const db = openWithNotes()
    const failure = new Error('boom')
    const caught = thrownBy(() =>
      db.tx(() => {
        add(db, 'lost')
        throw failure
      })
    )
    expect(caught).toBe(failure)
    expect(names(db)).toEqual([])
    expect(db.inTransaction()).toBe(false)
  })

  it('is usable again after a failed transaction', () => {
    const db = openWithNotes()
    expect(() => db.tx(() => db.exec('INSERT INTO missing VALUES (1)'))).toThrow(/no such table/)
    db.tx(() => add(db, 'later'))
    expect(names(db)).toEqual(['later'])
  })
})

describe('tx nesting with savepoints', () => {
  it('commits inner and outer writes together', () => {
    const db = openWithNotes()
    db.tx(() => {
      add(db, 'outer')
      db.tx(() => add(db, 'inner'))
    })
    expect(names(db)).toEqual(['outer', 'inner'])
  })

  it('tracks depth: still inside after an inner transaction, outside after the outer', () => {
    const db = openWithNotes()
    const seen: boolean[] = []
    db.tx(() => {
      db.tx(() => seen.push(db.inTransaction()))
      seen.push(db.inTransaction())
    })
    seen.push(db.inTransaction())
    expect(seen).toEqual([true, true, false])
  })

  it('returns values from nested transactions', () => {
    const db = openWithNotes()
    expect(db.tx(() => db.tx(() => db.tx(() => 'deep')))).toBe('deep')
  })

  it('rolls everything back when an inner failure propagates', () => {
    const db = openWithNotes()
    const attempt = (): void =>
      db.tx(() => {
        add(db, 'outer')
        db.tx(() => {
          add(db, 'inner')
          throw new Error('inner failed')
        })
      })
    expect(attempt).toThrow('inner failed')
    expect(names(db)).toEqual([])
    expect(db.inTransaction()).toBe(false)
  })
})

describe('tx nesting failures caught by the enclosing level', () => {
  it('keeps outer writes when the outer transaction catches an inner failure', () => {
    const db = openWithNotes()
    db.tx(() => {
      add(db, 'before')
      const caught = thrownBy(() =>
        db.tx(() => {
          add(db, 'inner')
          throw new Error('inner failed')
        })
      )
      expect((caught as Error).message).toBe('inner failed')
      add(db, 'after')
    })
    expect(names(db)).toEqual(['before', 'after'])
  })

  it('handles a failing innermost level caught by the middle level', () => {
    const db = openWithNotes()
    db.tx(() => {
      add(db, 'top')
      db.tx(() => {
        add(db, 'middle')
        thrownBy(() =>
          db.tx(() => {
            add(db, 'innermost')
            throw new Error('nope')
          })
        )
        add(db, 'middle-after')
      })
    })
    expect(names(db)).toEqual(['top', 'middle', 'middle-after'])
  })

  it('can retry a savepoint after one failed', () => {
    const db = openWithNotes()
    db.tx(() => {
      thrownBy(() =>
        db.tx(() => {
          add(db, 'x')
          db.exec('SELECT * FROM missing')
        })
      )
      db.tx(() => add(db, 'second try'))
    })
    expect(names(db)).toEqual(['second try'])
  })
})

describe('tx failure edge cases', () => {
  it('rolls back and rethrows when COMMIT itself fails', () => {
    const db = open()
    db.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY)')
    db.exec('CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))')
    const attempt = (): void =>
      db.tx(() => {
        db.exec('PRAGMA defer_foreign_keys = ON')
        db.run('INSERT INTO child (parent_id) VALUES (?)', 7)
      })
    expect(attempt).toThrow(/FOREIGN KEY constraint failed/)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM child')?.n).toBe(0)
    expect(db.inTransaction()).toBe(false)
    db.tx(() => db.run('INSERT INTO parent (id) VALUES (1)'))
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM parent')?.n).toBe(1)
  })

  it('keeps the original error when the transaction was already closed', () => {
    const db = openWithNotes()
    const original = new Error('original failure')
    const caught = thrownBy(() =>
      db.tx(() => {
        db.exec('ROLLBACK')
        throw original
      })
    )
    expect(caught).toBe(original)
    expect(db.inTransaction()).toBe(false)
    db.tx(() => add(db, 'recovered'))
    expect(names(db)).toEqual(['recovered'])
  })
})

describe('file databases shared by two connections', () => {
  it('lets a second connection see committed writes', () => {
    const path = tempDbPath()
    const first = openWithNotes(path)
    const second = open(path)
    first.tx(() => add(first, 'from first'))
    second.tx(() => second.run('INSERT INTO notes (name) VALUES (?)', 'from second'))
    expect(names(first)).toEqual(['from first', 'from second'])
    expect(names(second)).toEqual(['from first', 'from second'])
  })

  it('hides uncommitted writes from other connections until commit', () => {
    const path = tempDbPath()
    const first = openWithNotes(path)
    const second = open(path)
    let seenDuring: string[] = []
    first.tx(() => {
      add(first, 'pending')
      seenDuring = names(second)
    })
    expect(seenDuring).toEqual([])
    expect(names(second)).toEqual(['pending'])
  })

})

describe('file databases with a competing writer', () => {
  it('serializes writers: a busy writer fails fast, then succeeds after the lock is released', () => {
    const path = tempDbPath()
    const holder = openWithNotes(path)
    const writer = open(path, { busyTimeoutMs: 0, beginRetries: 1 })
    let ran = false
    holder.exec('BEGIN IMMEDIATE')
    const busy = thrownBy(() =>
      writer.tx(() => {
        ran = true
      })
    )
    expect(isBusyError(busy)).toBe(true)
    expect((busy as Error).message).toMatch(/database is locked/)
    expect(ran).toBe(false)
    expect(writer.inTransaction()).toBe(false)
    holder.exec('COMMIT')
    writer.tx(() => add(writer, 'after release'))
    expect(names(holder)).toEqual(['after release'])
  })

  it('does not disturb the lock holder when a second writer gives up', () => {
    const path = tempDbPath()
    const holder = openWithNotes(path)
    const writer = open(path, { busyTimeoutMs: 0, beginRetries: 1 })
    holder.exec('BEGIN IMMEDIATE')
    add(holder, 'held')
    expect(() => writer.tx(() => add(writer, 'blocked'))).toThrow(/database is locked/)
    holder.exec('COMMIT')
    expect(names(writer)).toEqual(['held'])
  })
})
