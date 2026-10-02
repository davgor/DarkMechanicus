import { describe, expect, it } from 'vitest'
import { COMMAND_SCHEMAS } from '../commandSchemas'
import { LIMITS } from '../schemas'
import { boardFixtures } from './__mocks__/boardFixtures'
import {
  boardImportView,
  boardReferenceSource,
  boardSourceKeys,
  openBoardEpicImport,
  recordedBoardSources
} from './imports'
import { type BoardEpic, type BoardFile, parseBoard } from './parse'
import { boardEpicImport } from './plan'

const EPIC_ID = 'ep_0000000000000000000000000a'

function epicOf(files: BoardFile[], boardId: string): BoardEpic {
  const epic = parseBoard(files).epics.find((item) => item.boardId === boardId)
  if (epic === undefined) {
    throw new Error(`Epic ${boardId} was not parsed`)
  }
  return epic
}

function moved(files: BoardFile[], from: string, to: string): BoardFile[] {
  return files.map((file) => (file.path === from ? { ...file, path: to } : file))
}

const ORPHAN: BoardFile[] = [
  { path: 'board/backlog/090.1-first.md', text: '# 090.1 — First\n' },
  { path: 'board/backlog/090.2-second.md', text: '# 090.2 — Second\n\nDepends on 090.1.\n' }
]

function schemaIssues(epic: BoardEpic): unknown[] {
  const { createEpic, ops } = openBoardEpicImport(epic)
  return [
    COMMAND_SCHEMAS.createEpic.safeParse(createEpic).error?.issues,
    COMMAND_SCHEMAS.updatePlanDraft.safeParse({ epicId: EPIC_ID, ops }).error?.issues
  ]
}

describe('board sources', () => {
  it('reads back from the import note the source of every fixture epic and of an orphan', () => {
    const epics = [...parseBoard(boardFixtures()).epics, ...parseBoard(ORPHAN).epics]
    for (const epic of epics) {
      const recorded = recordedBoardSources(boardEpicImport(epic).createEpic.intent ?? '')
      expect(boardSourceKeys(epic)).toContain(recorded[0])
      expect(recorded).toHaveLength(1)
    }
  })

  it('names an epic by its file name, whatever folder the file sits in', () => {
    const files = boardFixtures()
    const inProgress = epicOf(files, '014')
    const backlog = epicOf(moved(files, inProgress.sourcePath ?? '', 'board/backlog/014-cross-host-release.md'), '014')
    expect(boardSourceKeys(backlog)).toEqual(boardSourceKeys(inProgress))
    expect(boardSourceKeys(inProgress)[0]).toBe('file:014-cross-host-release.md')
  })

  it('names an orphan by its board epic number, and every epic also by its ticket files', () => {
    expect(boardSourceKeys(epicOf(ORPHAN, '090'))).toEqual(['orphan:090', 'file:090.1-first.md', 'file:090.2-second.md'])
  })

  it('treats a renamed epic file as another source', () => {
    const files = [{ path: 'board/backlog/030-old-name.md', text: '# EPIC: Thirty\n' }]
    const renamed = epicOf(moved(files, 'board/backlog/030-old-name.md', 'board/backlog/030-new-name.md'), '030')
    expect(boardSourceKeys(renamed)).not.toContain(boardSourceKeys(epicOf(files, '030'))[0])
  })

  it('reads every import note in an intent, and nothing from other text', () => {
    const intent = [
      'Imported from the /board file `board/done/014-a.md`.',
      'Imported from /board epic 090, which has no epic file; each ticket references its own file.',
      'Mentions board/done/015-b.md and `board/done/016-c.md` without a note.'
    ].join('\n\n')
    expect(recordedBoardSources(intent)).toEqual(['file:014-a.md', 'orphan:090'])
    expect(recordedBoardSources('Written by hand.')).toEqual([])
  })

  it('reads a board ticket reference in any board folder, and nothing outside the board', () => {
    expect(boardReferenceSource('board/backlog/014.3-windows-macos-packaging.md')).toBe('file:014.3-windows-macos-packaging.md')
    expect(boardReferenceSource('board/in-progress/014.3-windows-macos-packaging.md')).toBe(
      'file:014.3-windows-macos-packaging.md'
    )
    expect(boardReferenceSource('docs/014.3-windows-macos-packaging.md')).toBeNull()
    expect(boardReferenceSource('board/014.3-windows-macos-packaging.md')).toBeNull()
  })
})

describe('openBoardEpicImport leaves done sub-tickets out', () => {
  it('imports only open sub-tickets and lists the done ones in the intent before the import note', () => {
    const { createEpic, ops, doneTickets } = openBoardEpicImport(epicOf(boardFixtures(), '014'))
    expect(ops.map((op) => (op.op === 'add_ticket' ? op.ref : op.op))).toEqual(['update_sprint', 'board-014.3', 'board-014.4'])
    expect(doneTickets.map((ticket) => ticket.boardId)).toEqual(['014.1', '014.2'])
    expect(createEpic.intent).toBe(
      [
        'Package the headless MCP entry with the app, document host setup, and validate on Windows/macOS and a second agent host.',
        'Sub-tickets: 014.1–014.4.',
        'Already done on the board, so not imported as tickets:',
        [
          '- 014.1 Package the MCP entry and connection snippet (`board/done/014.1-package-mcp-entry.md`)',
          '- 014.2 Host skill install wrapper (`board/done/014.2-skill-install-wrapper.md`)'
        ].join('\n'),
        'Imported from the /board file `board/in-progress/014-cross-host-release.md`.'
      ].join('\n\n')
    )
  })

  it('maps an epic without done sub-tickets exactly as boardEpicImport does', () => {
    const files = [
      { path: 'board/backlog/031-epic.md', text: '# EPIC: Thirty-one\n\nWhy.\n' },
      { path: 'board/backlog/031.1-one.md', text: '# 031.1 — One\n' },
      { path: 'board/in-progress/031.2-two.md', text: '# 031.2 — Two\n\nDepends on 031.1.\n' }
    ]
    const epic = epicOf(files, '031')
    const { createEpic, ops, doneTickets } = openBoardEpicImport(epic)
    expect({ createEpic, ops }).toEqual(boardEpicImport(epic))
    expect(doneTickets).toEqual([])
  })

  it('drops a dependency on a done sub-ticket along with it', () => {
    const files = [
      { path: 'board/backlog/032-epic.md', text: '# EPIC: Thirty-two\n' },
      { path: 'board/done/032.1-one.md', text: '# 032.1 — One\n' },
      { path: 'board/backlog/032.2-two.md', text: '# 032.2 — Two\n\nDepends on 032.1.\n' }
    ]
    const { ops } = openBoardEpicImport(epicOf(files, '032'))
    expect(ops.map((op) => op.op)).toEqual(['update_sprint', 'add_ticket'])
  })
})

describe('openBoardEpicImport stays within the command limits', () => {
  it('keeps the intent within the Markdown limit, ending with the import note, however many sub-tickets are done', () => {
    const slug = 's'.repeat(190)
    const title = 'T'.repeat(LIMITS.title - 10)
    const files: BoardFile[] = [
      { path: 'board/in-progress/033-big.md', text: `# EPIC: Big\n\n${'Body text. '.repeat(5_900)}\n` },
      ...Array.from({ length: 480 }, (_, n) => ({
        path: `board/done/033.${n + 1}-${slug}.md`,
        text: `# 033.${n + 1} — ${title}\n`
      })),
      { path: 'board/backlog/033.481-open.md', text: '# 033.481 — Still open\n' }
    ]
    const epic = epicOf(files, '033')
    const intent = openBoardEpicImport(epic).createEpic.intent ?? ''
    expect(intent.length).toBeLessThanOrEqual(LIMITS.markdown)
    expect(intent.length).toBeGreaterThan(LIMITS.markdown - 1_000)
    expect(intent).toMatch(/\n- …and \d+ more\n\nImported from the \/board file `board\/in-progress\/033-big\.md`\.$/)
    expect(schemaIssues(epic)).toEqual([undefined, undefined])
  })

  it('gives inputs the command schemas accept for every open fixture epic', () => {
    const open = parseBoard(boardFixtures()).epics.filter((epic) => epic.folder !== 'done')
    expect(open.map((epic) => epic.boardId)).toEqual(['014'])
    expect(open.map(schemaIssues)).toEqual([[undefined, undefined]])
  })
})
describe('boardImportView', () => {
  it('asks about each open epic in order, lists done epics and passes skipped files through', () => {
    const files = [
      ...boardFixtures(),
      { path: 'board/backlog/021-ticket.md', text: '# 021 — Standalone\n' },
      ...ORPHAN.map((file) => ({ ...file, path: file.path.replace('backlog', 'done') }))
    ]
    const board = parseBoard(files)
    const asked: string[] = []
    const view = boardImportView({ ...board, skipped: [{ path: 'board/x.txt', reason: 'is not a Markdown file' }] }, (epic) => {
      asked.push(epic.boardId)
      return epic.boardId === '014' ? { state: 'imported', epicId: EPIC_ID } : { state: 'new', epicId: null }
    })
    expect(asked).toEqual(['014', '021'])
    expect(view.open.map((epic) => [epic.boardId, epic.kind, epic.state, epic.epicId, epic.ticketCount])).toEqual([
      ['014', 'epic', 'imported', EPIC_ID, 2],
      ['021', 'standalone', 'new', null, 1]
    ])
    expect(view.done.map((epic) => [epic.boardId, epic.sourcePath, epic.ticketCount])).toEqual([
      ['008', 'board/done/008-desktop-mockups.md', 1],
      ['013', 'board/done/013-checkpoints-and-recovery.md', 6],
      ['019', 'board/done/019-chibi-app-icon.md', 0],
      ['090', null, 2]
    ])
    expect(view.skipped).toEqual([{ path: 'board/x.txt', reason: 'is not a Markdown file' }])
  })
})
