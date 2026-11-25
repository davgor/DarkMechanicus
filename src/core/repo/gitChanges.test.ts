import { describe, expect, it } from 'vitest'
import { idOf } from '../../test/repoFixtures'
import type { ReconcileMarker } from '../meta'
import { IMPORTER_VERSION, trackedChanges, type TrackedChangesInput } from './gitChanges'
import type { GitPathChange } from './types'

const C1 = '1'.repeat(40)
const C2 = '2'.repeat(40)
const EPIC = idOf('epic', 1)
const EPIC_2 = idOf('epic', 2)
const RUN = idOf('run', 1)
const CARD = idOf('kanbanCard', 1)

const MARKER: ReconcileMarker = { baseCommit: C1, importerVersion: IMPORTER_VERSION, dirtyPaths: [] }

/** A clean working tree on `main` at C2, last reconciled at C1 on `main`, with `committed` changed in between. */
function input(committed: GitPathChange[], overrides: Partial<TrackedChangesInput> = {}): TrackedChangesInput {
  return {
    marker: MARKER,
    status: { ok: true, head: C2, branch: 'main', paths: [] },
    recordedBranch: 'main',
    isAncestor: true,
    diff: { ok: true, paths: committed },
    ...overrides
  }
}

function modified(...paths: string[]): GitPathChange[] {
  return paths.map((path) => ({ status: 'M', path }))
}

const NOTHING = { epics: new Set(), runs: new Set(), kanbanCards: new Set(), profiles: new Set(), projectObservations: false, recoveredAttachments: false }

describe('trackedChanges maps each record path class to its record', () => {
  it('targets exactly the epic whose state.json changed between the marker commit and HEAD', () => {
    expect(trackedChanges(input(modified(`epics/${EPIC}/state.json`)))).toEqual({ kind: 'targeted', ...NOTHING, epics: new Set([EPIC]) })
  })

  it('maps every file below an epic (comments, observations, attachments, snapshots) to that epic', () => {
    const result = trackedChanges(input(modified(
      `epics/${EPIC}/current.json`,
      `epics/${EPIC}/snapshots/${idOf('revision', 1)}.json`,
      `epics/${EPIC}/comments/${idOf('comment', 1)}.json`,
      `epics/${EPIC}/observations/${idOf('metricObservation', 1)}.json`,
      `epics/${EPIC_2}/attachments/${'a'.repeat(64)}.png`
    )))
    expect(result).toEqual({ kind: 'targeted', ...NOTHING, epics: new Set([EPIC, EPIC_2]) })
  })

  it('maps runs, Kanban cards, profiles, project observations and recovered attachments', () => {
    const result = trackedChanges(input(modified(
      `history/${RUN}/run.json`,
      `history/${RUN}/scorecards/${idOf('report', 1)}.json`,
      `kanban/${CARD}/card.json`,
      `kanban/${CARD}/events/${idOf('kanbanEvent', 1)}.json`,
      'profiles/fast-coder.json',
      `observations/${idOf('metricObservation', 2)}.json`,
      `recovered-attachments/${idOf('attachment', 1)}.json`
    )))
    expect(result).toEqual({
      kind: 'targeted',
      epics: new Set(),
      runs: new Set([RUN]),
      kanbanCards: new Set([CARD]),
      profiles: new Set(['fast-coder']),
      projectObservations: true,
      recoveredAttachments: true
    })
  })

  it('maps a deleted record folder (a whole-directory status entry) to its record', () => {
    const status = { ok: true as const, head: C2, branch: 'main', paths: [{ status: '?', path: `kanban/${CARD}/` }, { status: 'D.', path: `epics/${EPIC}/state.json` }] }
    expect(trackedChanges(input([], { status }))).toEqual({ kind: 'targeted', ...NOTHING, epics: new Set([EPIC]), kanbanCards: new Set([CARD]) })
  })

  it('ignores local/, knowledge/ and .gitignore, and an ignored file below them', () => {
    const status = {
      ok: true as const,
      head: C2,
      branch: 'main',
      paths: [{ status: '!', path: 'local/state.sqlite' }, { status: '?', path: 'knowledge/facts/a.md' }, { status: '.M', path: '.gitignore' }]
    }
    expect(trackedChanges(input(modified('local/machine.json', 'knowledge/x.md'), { status }))).toEqual({ kind: 'targeted', ...NOTHING })
  })
})

describe('trackedChanges merges every source of changes', () => {
  it('reads nothing when nothing changed, including when HEAD is still the marker commit', () => {
    expect(trackedChanges(input([]))).toEqual({ kind: 'targeted', ...NOTHING })
    const same = input([], { status: { ok: true, head: C1, branch: 'main', paths: [] }, isAncestor: null, diff: null })
    expect(trackedChanges(same)).toEqual({ kind: 'targeted', ...NOTHING })
  })

  it('merges working-tree changes with the committed ones', () => {
    const status = { ok: true as const, head: C2, branch: 'main', paths: [{ status: '?', path: `kanban/${CARD}/card.json` }, { status: '.M', path: 'profiles/a.json' }] }
    expect(trackedChanges(input(modified(`epics/${EPIC}/state.json`), { status }))).toEqual({
      kind: 'targeted', ...NOTHING, epics: new Set([EPIC]), kanbanCards: new Set([CARD]), profiles: new Set(['a'])
    })
  })

  it('re-reads a path that was dirty at the last reconcile and has since been reverted (clean in diff and status)', () => {
    const marker = { ...MARKER, dirtyPaths: [`epics/${EPIC}/state.json`, `kanban/${CARD}/card.json`] }
    expect(trackedChanges(input([], { marker }))).toEqual({ kind: 'targeted', ...NOTHING, epics: new Set([EPIC]), kanbanCards: new Set([CARD]) })
  })

  it('merges recheck records into a targeted result', () => {
    const recheck = { epics: [EPIC_2], runs: new Set([RUN]), kanbanCards: [CARD], profiles: ['p'], projectObservations: true, recoveredAttachments: true }
    expect(trackedChanges(input(modified(`epics/${EPIC}/state.json`), { recheck }))).toEqual({
      kind: 'targeted',
      epics: new Set([EPIC, EPIC_2]),
      runs: new Set([RUN]),
      kanbanCards: new Set([CARD]),
      profiles: new Set(['p']),
      projectObservations: true,
      recoveredAttachments: true
    })
  })

  it('leaves a full result full whatever recheck holds', () => {
    expect(trackedChanges(input(modified('project.json'), { recheck: { epics: [EPIC], projectObservations: true } }))).toEqual({ kind: 'full', reason: 'project_record' })
  })
})

describe('trackedChanges returns full with a reason', () => {
  it('when project.json changed, committed or in the working tree', () => {
    expect(trackedChanges(input(modified('project.json')))).toEqual({ kind: 'full', reason: 'project_record' })
    const status = { ok: true as const, head: C2, branch: 'main', paths: [{ status: '.M', path: 'project.json' }] }
    expect(trackedChanges(input([], { status }))).toEqual({ kind: 'full', reason: 'project_record' })
  })

  it.each([
    ['an unknown top-level file', 'notes.txt'],
    ['an unknown top-level folder', 'drafts/a.json'],
    ['an epic folder with an invalid id', 'epics/not-an-id/state.json'],
    ['an epic folder named with another kind of id', `epics/${RUN}/state.json`],
    ['a run folder with an invalid id', 'history/rn_bad/run.json'],
    ['a Kanban folder with an invalid id', 'kanban/x/card.json'],
    ['a file directly in epics/', 'epics/readme.md'],
    ['an invalid profile name', 'profiles/Bad Name.json'],
    ['a Windows device name as a profile', 'profiles/con.json'],
    ['a profile file that is not JSON', 'profiles/a.txt'],
    ['a nested profile path', 'profiles/a/b.json'],
    ['a backslash path', `epics\\${EPIC}\\state.json`],
    ['a prototype key as a folder', `constructor/${EPIC}/x.json`]
  ])('when %s changed', (_label, path) => {
    expect(trackedChanges(input(modified(path)))).toEqual({ kind: 'full', reason: 'unknown_path' })
  })

  it('when an unknown path was dirty at the last reconcile', () => {
    expect(trackedChanges(input([], { marker: { ...MARKER, dirtyPaths: ['stray.json'] } }))).toEqual({ kind: 'full', reason: 'unknown_path' })
  })

  it('when git ignores a record file, so it cannot report its changes', () => {
    const status = { ok: true as const, head: C2, branch: 'main', paths: [{ status: '!', path: `epics/${EPIC}/attachments/${'a'.repeat(64)}.png` }] }
    expect(trackedChanges(input([], { status }))).toEqual({ kind: 'full', reason: 'ignored_path' })
  })
})

describe('trackedChanges returns full when the marker or git cannot be trusted', () => {
  it('when no marker is stored, or any part of it is missing or invalid', () => {
    for (const marker of [
      { baseCommit: null, importerVersion: null, dirtyPaths: null },
      { ...MARKER, baseCommit: null },
      { ...MARKER, importerVersion: null },
      { ...MARKER, dirtyPaths: null }
    ]) {
      expect(trackedChanges(input([], { marker }))).toEqual({ kind: 'full', reason: 'no_marker' })
    }
  })

  it('when the stored importer version differs from the current one', () => {
    for (const importerVersion of [IMPORTER_VERSION - 1, IMPORTER_VERSION + 1]) {
      expect(trackedChanges(input([], { marker: { ...MARKER, importerVersion } }))).toEqual({ kind: 'full', reason: 'importer_version' })
    }
  })

  it('when the stored commit is not an ancestor of HEAD', () => {
    expect(trackedChanges(input(modified(`epics/${EPIC}/state.json`), { isAncestor: false }))).toEqual({ kind: 'full', reason: 'not_ancestor' })
  })

  it('when the branch changed, or none was recorded', () => {
    const on = (branch: string | null): TrackedChangesInput['status'] => ({ ok: true, head: C2, branch, paths: [] })
    expect(trackedChanges(input([], { status: on('other') }))).toEqual({ kind: 'full', reason: 'branch_changed' })
    expect(trackedChanges(input([], { status: on(null) }))).toEqual({ kind: 'full', reason: 'branch_changed' })
    expect(trackedChanges(input([], { recordedBranch: '' }))).toEqual({ kind: 'full', reason: 'branch_changed' })
    expect(trackedChanges(input([], { recordedBranch: null }))).toEqual({ kind: 'full', reason: 'branch_changed' })
    // A detached HEAD recorded as '' and still detached is the same checkout.
    expect(trackedChanges(input([], { recordedBranch: '', status: on(null) }))).toEqual({ kind: 'targeted', ...NOTHING })
  })

  it('when HEAD is unborn', () => {
    expect(trackedChanges(input([], { status: { ok: true, head: null, branch: 'main', paths: [] } }))).toEqual({ kind: 'full', reason: 'unborn_head' })
  })

  it('when the folder is not inside a git work tree', () => {
    expect(trackedChanges(input([], { status: { ok: false, reason: 'not_work_tree' } }))).toEqual({ kind: 'full', reason: 'not_work_tree' })
  })

  it('when git is unavailable or a git command fails', () => {
    expect(trackedChanges(input([], { status: { ok: false, reason: 'git_failed' } }))).toEqual({ kind: 'full', reason: 'git_failed' })
    expect(trackedChanges(input([], { diff: { ok: false, reason: 'git_failed' } }))).toEqual({ kind: 'full', reason: 'git_failed' })
    expect(trackedChanges(input([], { diff: null }))).toEqual({ kind: 'full', reason: 'git_failed' })
    expect(trackedChanges(input([], { isAncestor: null }))).toEqual({ kind: 'full', reason: 'git_failed' })
  })
})
