import { cpSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BoardImportView } from '../../shared/domain/views'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { FIXTURE_ROOT } from '../board/__mocks__/boardFixtures'
import type { Workspace } from '../workspace'

const EPIC_014_FILE = 'board/in-progress/014-cross-host-release.md'

/** The preview of the fixture board (`src/core/board/__mocks__/board`) before anything is imported. */
const FIXTURE_PREVIEW: BoardImportView = {
  open: [
    {
      boardId: '014',
      kind: 'epic',
      title: 'Cross-host validation and release (milestone 6)',
      folder: 'in-progress',
      sourcePath: EPIC_014_FILE,
      sourcePaths: [
        EPIC_014_FILE,
        'board/done/014.1-package-mcp-entry.md',
        'board/done/014.2-skill-install-wrapper.md',
        'board/backlog/014.3-windows-macos-packaging.md',
        'board/backlog/014.4-second-host-validation.md'
      ],
      ticketCount: 2,
      doneTickets: [
        {
          boardId: '014.1',
          title: 'Package the MCP entry and connection snippet',
          sourcePath: 'board/done/014.1-package-mcp-entry.md'
        },
        { boardId: '014.2', title: 'Host skill install wrapper', sourcePath: 'board/done/014.2-skill-install-wrapper.md' }
      ],
      state: 'new',
      epicId: null
    }
  ],
  done: [
    {
      boardId: '008',
      title: 'Desktop experience mockups',
      sourcePath: 'board/done/008-desktop-mockups.md',
      sourcePaths: ['board/done/008-desktop-mockups.md'],
      ticketCount: 1
    },
    {
      boardId: '013',
      title: 'Sprint checkpoints and recovery (milestone 5)',
      sourcePath: 'board/done/013-checkpoints-and-recovery.md',
      sourcePaths: ['board/done/013-checkpoints-and-recovery.md'],
      ticketCount: 6
    },
    {
      boardId: '019',
      title: 'Chibi Mechanicus app icon',
      sourcePath: 'board/done/019-chibi-app-icon.md',
      sourcePaths: ['board/done/019-chibi-app-icon.md'],
      ticketCount: 0
    }
  ],
  skipped: []
}

let harness: Harness

beforeEach(() => {
  harness = createHarness()
  cpSync(join(FIXTURE_ROOT, 'board'), join(harness.root, 'board'), { recursive: true })
})

afterEach(() => {
  harness.cleanup()
})

function boardPath(path: string): string {
  return join(harness.root, path)
}

function writeBoardFile(path: string, text: string): void {
  mkdirSync(join(boardPath(path), '..'), { recursive: true })
  writeFileSync(boardPath(path), text)
}

async function initialized(role: 'desktop' | 'planner' | 'orchestrator' = 'desktop'): Promise<Workspace> {
  const workspace = harness.open(role)
  await workspace.initializeRepository({ name: 'board-repo' })
  return workspace
}

async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error: unknown) {
    return (error as { code: string }).code
  }
  return 'ok'
}

/** Tracked files under `.darkmechanicus/`, leaving out the ignored `local/` database. */
function trackedRecords(): string[] {
  const root = join(harness.root, '.darkmechanicus')
  return (readdirSync(root, { recursive: true }) as string[]).filter((path) => !path.startsWith('local')).sort()
}

describe('previewBoardImport', () => {
  it('previews the board before the repository is initialized: open epics, done epics, skipped files', async () => {
    const workspace = harness.open('desktop')
    expect(workspace.isInitialized()).toBe(false)
    expect(await workspace.previewBoardImport()).toEqual(FIXTURE_PREVIEW)
  })

  it('lists files it could not read as part of the board with their reasons', async () => {
    writeBoardFile('board/backlog/notes.txt', 'not a ticket')
    writeBoardFile('board/backlog/021-untitled.md', 'No title line here.\n')
    const preview = await harness.open('desktop').previewBoardImport()
    expect(preview.skipped).toEqual([
      { path: 'board/backlog/021-untitled.md', reason: 'does not start with a `# ` title line' },
      { path: 'board/backlog/notes.txt', reason: 'is not a Markdown file' }
    ])
    expect(preview.open.map((epic) => epic.boardId)).toEqual(['014'])
  })

  it('is empty for a repository without a board, and an import there creates nothing', async () => {
    rmSync(boardPath('board'), { recursive: true })
    const workspace = await initialized()
    expect(await workspace.previewBoardImport()).toEqual({ open: [], done: [], skipped: [] })
    expect(await workspace.importBoard({})).toEqual({ open: [], done: [], skipped: [] })
    expect(await workspace.listEpics()).toEqual([])
  })

  it('changes nothing: no epic, draft or record appears', async () => {
    const workspace = await initialized()
    const before = trackedRecords()
    await workspace.previewBoardImport()
    expect(await workspace.listEpics()).toEqual([])
    expect(trackedRecords()).toEqual(before)
  })

  it('is open to every role, while only roles that create epics may import', async () => {
    await initialized()
    for (const role of ['worker', 'reviewer', 'planner', 'orchestrator'] as const) {
      expect((await harness.open(role).previewBoardImport()).open).toHaveLength(1)
    }
    expect(await failureOf(harness.open('worker').importBoard({}))).toBe('unauthorized')
    expect(await failureOf(harness.open('reviewer').importBoard({}))).toBe('unauthorized')
  })
})

describe('importBoard creates draft epics', () => {
  it('creates each open board epic in Backlog with its open tickets as an unsaved draft plan', async () => {
    const workspace = await initialized()
    const result = await workspace.importBoard({})
    const [entry] = result.open
    expect(result.open).toHaveLength(1)
    expect(entry).toMatchObject({ boardId: '014', state: 'created' })
    expect(result.done).toEqual(FIXTURE_PREVIEW.done)
    const epicId = entry?.epicId ?? ''
    const epic = await workspace.getEpic({ epicId })
    expect(epic).toMatchObject({
      title: 'Cross-host validation and release (milestone 6)',
      status: 'backlog',
      currentRevisionId: null,
      hasDraft: true,
      ticketCount: 2,
      sprintCount: 1
    })
    expect(epic.successCriteria.map((criterion) => criterion.text)).toEqual(['All sub-tickets 014.1–014.4 are done'])
    const tickets = await workspace.listTickets({ epicId, view: 'draft' })
    expect(tickets.map((ticket) => ticket.title)).toEqual([
      'Windows and macOS packaging verification',
      'Second agent host validation'
    ])
    expect(await workspace.listRevisions({ epicId })).toEqual([])
  })

  it('saves and commits nothing: no plan revision, no tracked epic record, no change to the board', async () => {
    const workspace = await initialized()
    const records = trackedRecords()
    const board = (readdirSync(boardPath('board'), { recursive: true }) as string[]).sort()
    await workspace.importBoard({})
    const [epic] = await workspace.listEpics()
    expect(epic).toMatchObject({ currentRevisionId: null, pendingSave: false, draftChanged: true })
    expect(trackedRecords()).toEqual(records)
    expect((readdirSync(boardPath('board'), { recursive: true }) as string[]).sort()).toEqual(board)
  })
})

describe('importBoard records the source', () => {
  it('records the source file in the intent and the ticket references, and lists done sub-tickets in the intent', async () => {
    const workspace = await initialized()
    const epicId = (await workspace.importBoard({})).open[0]?.epicId ?? ''
    const epic = await workspace.getEpic({ epicId })
    expect(epic.intent).toBe(
      [
        'Package the headless MCP entry with the app, document host setup, and validate on Windows/macOS and a second agent host.',
        'Sub-tickets: 014.1–014.4.',
        [
          'Already done on the board, so not imported as tickets:',
          '',
          '- 014.1 Package the MCP entry and connection snippet (`board/done/014.1-package-mcp-entry.md`)',
          '- 014.2 Host skill install wrapper (`board/done/014.2-skill-install-wrapper.md`)'
        ].join('\n'),
        'Imported from the /board file `board/in-progress/014-cross-host-release.md`.'
      ].join('\n\n')
    )
    const plan = await workspace.getPlan({ epicId, view: 'draft' })
    expect(plan.bundle.sprints[0]?.goal).toBe('Cross-host validation and release (milestone 6)')
    expect(plan.bundle.tickets.map((ticket) => ticket.references.map((reference) => reference.location))).toEqual([
      ['board/backlog/014.3-windows-macos-packaging.md'],
      ['board/backlog/014.4-second-host-validation.md']
    ])
  })
})

describe('importBoard never duplicates', () => {
  it('creates no duplicate when the board is imported a second time', async () => {
    const workspace = await initialized()
    const first = await workspace.importBoard({})
    const epicId = first.open[0]?.epicId
    const second = await workspace.importBoard({})
    expect(second.open).toEqual([{ ...FIXTURE_PREVIEW.open[0], state: 'imported', epicId }])
    expect((await workspace.listEpics()).map((epic) => epic.id)).toEqual([epicId])
    expect((await workspace.previewBoardImport()).open.map((epic) => [epic.state, epic.epicId])).toEqual([
      ['imported', epicId]
    ])
  })

  it('answers a retried request with the same idempotency key with the first result, creating nothing', async () => {
    const workspace = await initialized()
    const first = await workspace.importBoard({ idempotencyKey: 'board-import-1' })
    const retry = await workspace.importBoard({ idempotencyKey: 'board-import-1' })
    expect(retry).toEqual(first)
    expect(retry.open[0]?.state).toBe('created')
    expect(await workspace.listEpics()).toHaveLength(1)
  })

  it('recognizes an imported epic after its board files moved to other folders', async () => {
    const workspace = await initialized()
    const epicId = (await workspace.importBoard({})).open[0]?.epicId
    renameSync(boardPath(EPIC_014_FILE), boardPath('board/backlog/014-cross-host-release.md'))
    renameSync(boardPath('board/backlog/014.3-windows-macos-packaging.md'), boardPath('board/in-progress/014.3-windows-macos-packaging.md'))
    const again = await workspace.importBoard({})
    expect(again.open.map((epic) => [epic.folder, epic.state, epic.epicId])).toEqual([['backlog', 'imported', epicId]])
    expect(await workspace.listEpics()).toHaveLength(1)
  })
})

describe('importBoard recognizes an import after later edits', () => {
  it('recognizes an imported epic by its ticket references after the import note was edited out of the draft', async () => {
    const workspace = await initialized()
    const epicId = (await workspace.importBoard({})).open[0]?.epicId ?? ''
    await workspace.updatePlanDraft({ epicId, ops: [{ op: 'set_epic', intent: 'Rewritten by hand.' }] })
    expect((await workspace.importBoard({})).open.map((epic) => [epic.state, epic.epicId])).toEqual([['imported', epicId]])
    expect(await workspace.listEpics()).toHaveLength(1)
  })

  it('recognizes an import recorded only by an earlier saved revision', async () => {
    const workspace = await initialized()
    const epicId = (await workspace.importBoard({})).open[0]?.epicId ?? ''
    const first = await workspace.getPlan({ epicId, view: 'draft' })
    await workspace.savePlan({ epicId, expectedDraftRevision: first.draftRevision ?? 0 })
    const ticketIds = first.bundle.tickets.map((ticket) => ticket.id)
    const edited = await workspace.updatePlanDraft({
      epicId,
      ops: [
        { op: 'set_epic', intent: 'Rewritten by hand.' },
        ...ticketIds.map((ticket) => ({ op: 'remove_ticket' as const, ticket }))
      ]
    })
    await workspace.savePlan({ epicId, expectedDraftRevision: edited.draftRevision })
    expect((await workspace.listRevisions({ epicId })).length).toBe(2)
    expect((await workspace.previewBoardImport()).open.map((epic) => [epic.state, epic.epicId])).toEqual([['imported', epicId]])
  })
})

describe('importBoard with more than one epic naming the same source', () => {
  it('names the oldest of them, and still creates nothing', async () => {
    const workspace = await initialized()
    const epicId = (await workspace.importBoard({})).open[0]?.epicId
    harness.clock.advanceSeconds(1)
    await workspace.createEpic({ title: 'Hand copy', intent: `Imported from the /board file \`${EPIC_014_FILE}\`.` })
    const again = await workspace.importBoard({})
    expect(again.open.map((epic) => [epic.state, epic.epicId])).toEqual([['imported', epicId]])
    expect(await workspace.listEpics()).toHaveLength(2)
  })
})

describe('importBoard on later boards and for each role', () => {
  it('imports a board epic added after the first import and leaves the earlier one alone', async () => {
    const workspace = await initialized()
    const epicId = (await workspace.importBoard({})).open[0]?.epicId
    writeBoardFile('board/backlog/021-new-ticket.md', '# 021 — A new ticket\n\n## Acceptance criteria\n\n- [ ] Works\n')
    const again = await workspace.importBoard({})
    expect(again.open.map((epic) => [epic.boardId, epic.state])).toEqual([
      ['014', 'imported'],
      ['021', 'created']
    ])
    expect(again.open[0]?.epicId).toBe(epicId)
    expect(await workspace.listEpics()).toHaveLength(2)
  })

  it('imports nothing from a board whose epics are all done', async () => {
    const workspace = await initialized()
    renameSync(boardPath(EPIC_014_FILE), boardPath('board/done/014-cross-host-release.md'))
    const result = await workspace.importBoard({})
    expect(result.open).toEqual([])
    expect(result.done.map((epic) => epic.boardId)).toEqual(['008', '013', '014', '019'])
    expect(await workspace.listEpics()).toEqual([])
  })

  it('needs an initialized repository', async () => {
    expect(await failureOf(harness.open('desktop').importBoard({}))).toBe('not_initialized')
  })

  it('is available to planner and orchestrator sessions', async () => {
    await initialized()
    const result = await harness.open('planner', { allowSave: false }).importBoard({})
    expect(result.open[0]?.state).toBe('created')
    expect((await harness.open('orchestrator').importBoard({})).open[0]?.state).toBe('imported')
  })
})
