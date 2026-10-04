import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { idOf, insertEpic, T0 } from '../../test/repoFixtures'
import { createTestDb } from '../../test/testContext'
import { prettyJson } from '../canonical'
import { listBranchEpics } from './branchEpics'
import { resolveLayout } from './layout'
import type { GitAdapter } from './types'

const layout = resolveLayout(resolve('/repo'))
const HASH = `sha256:${'a'.repeat(64)}`

type Tree = Record<string, string>

interface FakeGit extends GitAdapter {
  listed: string[]
}

function fakeGit(current: string | null, branches: Record<string, Tree>): FakeGit {
  const listed: string[] = []
  return {
    listed,
    head: () => ({ branch: current, commit: null, detached: current === null }),
    countUncommitted: async () => 0,
    listLocalBranches: async () => Object.keys(branches),
    listFiles: async (ref, pathspec) => {
      listed.push(ref)
      return Object.keys(branches[ref] ?? {}).filter((path) => path.startsWith(`${pathspec}/`))
    },
    showFile: async (ref, path) => branches[ref]?.[path] ?? null,
    isAncestor: async () => null,
    commitParents: async () => null
  }
}

function stateText(epicId: string, title: string, status = 'backlog'): string {
  return prettyJson({
    format: 'darkmechanicus.epic-state',
    formatVersion: 1,
    epicId,
    title,
    status,
    branch: null,
    provenance: null,
    outcome: null,
    createdAt: T0,
    completedAt: null,
    ticketStatuses: {},
    generation: 1,
    updatedAt: T0
  })
}

function pointerText(epicId: string, revisionNumber: number): string {
  return prettyJson({
    format: 'darkmechanicus.epic-pointer',
    formatVersion: 1,
    epicId,
    revisionId: idOf('revision', revisionNumber),
    revisionNumber,
    contentHash: HASH,
    generation: 1,
    updatedAt: T0
  })
}

/** `count` epics with only a state record, numbered from `first`. */
function stateFiles(first: number, count: number): Tree {
  const tree: Tree = {}
  for (let n = first; n < first + count; n += 1) {
    tree[`.darkmechanicus/epics/${idOf('epic', n)}/state.json`] = stateText(idOf('epic', n), `Epic ${n}`)
  }
  return tree
}

function epicFiles(epicId: string, title: string, revisionNumber: number): Tree {
  return {
    [`.darkmechanicus/epics/${epicId}/state.json`]: stateText(epicId, title),
    [`.darkmechanicus/epics/${epicId}/current.json`]: pointerText(epicId, revisionNumber),
    [`.darkmechanicus/epics/${epicId}/snapshots/${idOf('revision', revisionNumber)}.json`]: '{}'
  }
}

describe('listBranchEpics', () => {
  it('lists valid epics on other local branches and marks those present locally', async () => {
    const db = createTestDb()
    insertEpic(db, { id: idOf('epic', 1) })
    const git = fakeGit('main', {
      main: epicFiles(idOf('epic', 9), 'Current branch epic', 1),
      'feature/a': { ...epicFiles(idOf('epic', 1), 'Shared epic', 3), ...epicFiles(idOf('epic', 2), 'Feature epic', 1) },
      'feature/b': {
        [`.darkmechanicus/epics/${idOf('epic', 3)}/state.json`]: stateText(idOf('epic', 3), 'Unsaved pointer'),
        '.darkmechanicus/epics/README.md': 'hello',
        '.darkmechanicus/epics/ep_bad/state.json': stateText('ep_bad', 'Bad id')
      }
    })
    expect(await listBranchEpics({ db, git, layout })).toEqual([
      { branch: 'feature/a', epicId: idOf('epic', 1), title: 'Shared epic', status: 'backlog', revisionNumber: 3, presentLocally: true },
      { branch: 'feature/a', epicId: idOf('epic', 2), title: 'Feature epic', status: 'backlog', revisionNumber: 1, presentLocally: false },
      { branch: 'feature/b', epicId: idOf('epic', 3), title: 'Unsaved pointer', status: 'backlog', revisionNumber: null, presentLocally: false }
    ])
    expect(git.listed).toEqual(['feature/a', 'feature/b'])
  })

})

describe('listBranchEpics with untrusted records', () => {
  it('skips invalid, mismatched, or conflicted records', async () => {
    const epic = idOf('epic', 4)
    const git = fakeGit(null, {
      a: { [`.darkmechanicus/epics/${epic}/state.json`]: '{"format":"nope"}' },
      b: { [`.darkmechanicus/epics/${epic}/state.json`]: stateText(idOf('epic', 5), 'Other epic') },
      c: {
        [`.darkmechanicus/epics/${epic}/state.json`]: stateText(epic, 'Broken pointer'),
        [`.darkmechanicus/epics/${epic}/current.json`]: `<<<<<<< HEAD\n${pointerText(epic, 1)}`
      },
      d: { [`.darkmechanicus/epics/${epic}/state.json`]: stateText(epic, 'Fine') },
      e: {
        [`.darkmechanicus/epics/${epic}/state.json`]: stateText(epic, 'Foreign pointer'),
        [`.darkmechanicus/epics/${epic}/current.json`]: pointerText(idOf('epic', 5), 1)
      },
      f: { [`.darkmechanicus/epics/${epic}/current.json`]: pointerText(epic, 1) }
    })
    const views = await listBranchEpics({ db: createTestDb(), git, layout })
    expect(views.map((view) => [view.branch, view.title])).toEqual([['d', 'Fine']])
  })

})

describe('listBranchEpics limits', () => {
  it('reads at most 50 branches and 500 epics', async () => {
    const branches: Record<string, Tree> = {}
    for (let n = 1; n <= 51; n += 1) {
      branches[`b${String(n).padStart(2, '0')}`] = epicFiles(idOf('epic', n), `Epic ${n}`, 1)
    }
    const limited = fakeGit('main', branches)
    expect(await listBranchEpics({ db: createTestDb(), git: limited, layout })).toHaveLength(50)
    expect(limited.listed).toHaveLength(50)

    const crowded = fakeGit('main', { first: stateFiles(1, 300), second: stateFiles(301, 300), third: stateFiles(601, 1) })
    const views = await listBranchEpics({ db: createTestDb(), git: crowded, layout })
    expect(views).toHaveLength(500)
    expect(views.filter((view) => view.branch === 'first')).toHaveLength(300)
    expect(views.filter((view) => view.branch === 'second')).toHaveLength(200)
    expect(crowded.listed).toEqual(['first', 'second'])
  })
})
