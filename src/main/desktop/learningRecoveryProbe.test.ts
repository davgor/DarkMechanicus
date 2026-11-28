/** DM-983: the read-only startup pre-check that decides whether a folder's workspace opens for learning recovery. */
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { put, scratchDir } from '../../test/gitScratch'
import { mayHavePendingLearningApprovals } from './learningRecoveryProbe'

const THIS_MACHINE = 'mc_this'
const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function scratch(prefix: string): string {
  const dir = scratchDir(prefix)
  cleanups.push(dir.cleanup)
  return dir.path
}

/** A repo-mode project folder; `machine` is written as `local/machine.json` when given, `rows` into its database when given. */
function project(options: { machine?: string; rows?: Array<{ state: string; owner: string | null }> }): string {
  const folder = scratch('dm-probe-project-')
  const local = join(folder, '.darkmechanicus', 'local')
  if (options.machine !== undefined) put(local, 'machine.json', options.machine)
  if (options.rows !== undefined) {
    put(local, '.keep', '')
    const db = new DatabaseSync(join(local, 'state.sqlite'))
    try {
      db.exec('CREATE TABLE learning_integrations (id TEXT PRIMARY KEY, state TEXT NOT NULL, owner_machine_id TEXT)')
      options.rows.forEach((row, index) => db.prepare('INSERT INTO learning_integrations VALUES (?, ?, ?)').run(`li_${index}`, row.state, row.owner))
    } finally {
      db.close()
    }
  }
  return folder
}

const machine = JSON.stringify({ machineId: THIS_MACHINE, createdAt: '2026-01-01T00:00:00.000Z' })
const probe = (folder: string): boolean => mayHavePendingLearningApprovals(folder, scratch('dm-probe-home-'))

describe('mayHavePendingLearningApprovals', () => {
  it('finds an open integration this machine owns in every open state', () => {
    for (const state of ['prepared', 'integrating', 'integrated']) {
      expect(probe(project({ machine, rows: [{ state, owner: THIS_MACHINE }] }))).toBe(true)
    }
  })

  it('finds nothing for a closed integration, another machine’s, an unowned one, or an empty table', () => {
    const rows = [
      { state: 'published', owner: THIS_MACHINE },
      { state: 'aborted', owner: THIS_MACHINE },
      { state: 'conflicted', owner: THIS_MACHINE },
      { state: 'prepared', owner: 'mc_other' },
      { state: 'integrating', owner: null }
    ]
    expect(probe(project({ machine, rows }))).toBe(false)
    expect(probe(project({ machine, rows: [] }))).toBe(false)
  })

  it('finds nothing without a database or a machine record, which this machine never wrote', () => {
    expect(probe(project({ machine }))).toBe(false)
    expect(probe(project({ rows: [{ state: 'prepared', owner: THIS_MACHINE }] }))).toBe(false)
  })

  it('leaves the decision to the workspace when the machine record or the database cannot be read', () => {
    const owned = [{ state: 'prepared', owner: THIS_MACHINE }]
    expect(probe(project({ machine: JSON.stringify({ createdAt: 'no id' }), rows: owned }))).toBe(true)
    expect(probe(project({ machine: 'not json', rows: owned }))).toBe(true)
    const garbled = project({ machine })
    put(join(garbled, '.darkmechanicus', 'local'), 'state.sqlite', 'not a database')
    expect(probe(garbled)).toBe(true)
    expect(probe(join(scratch('dm-probe-gone-'), 'missing'))).toBe(true)
  })
})
