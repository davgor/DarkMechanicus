import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../shared/domain/bundle'
import { sid } from '../../test/bundles'
import { COMMAND_SCHEMAS } from '../commandSchemas'
import { applyDraftOps } from '../plan/draftOps'
import { createInitialBundle } from '../plan/normalize'
import { LIMITS } from '../schemas'
import { boardFixtures } from './__mocks__/boardFixtures'
import { type BoardEpic, type BoardTicket, parseBoard } from './parse'
import { boardEpicImport } from './plan'

const EPIC_ID = 'ep_0000000000000000000000000a'

function fixtureEpic(boardId: string): BoardEpic {
  const epic = parseBoard(boardFixtures()).epics.find((item) => item.boardId === boardId)
  if (epic === undefined) {
    throw new Error(`Epic ${boardId} was not parsed`)
  }
  return epic
}

/** The draft a new epic starts with (one empty sprint), after the import ops, through the real op logic. */
function draftAfterImport(epic: BoardEpic): PlanBundle {
  const { createEpic, ops } = boardEpicImport(epic)
  const initial = createInitialBundle(
    { title: createEpic.title, intent: createEpic.intent ?? '', successCriteria: [], ownerRole: null },
    sid(1)
  )
  let created = 0
  const deps = {
    newId: (kind: 'ticket' | 'sprint') => {
      created += 1
      return `${kind === 'ticket' ? 'tk' : 'sp'}_new${created}`
    },
    nextKey: () => `DM-${created}`
  }
  return applyDraftOps(initial, ops, deps).bundle
}

function schemaErrors(epic: BoardEpic): unknown[] {
  const { createEpic, ops } = boardEpicImport(epic)
  return [
    COMMAND_SCHEMAS.createEpic.safeParse(createEpic).error?.issues,
    COMMAND_SCHEMAS.updatePlanDraft.safeParse({ epicId: EPIC_ID, ops }).error?.issues
  ]
}

describe('boardEpicImport passes the command schemas', () => {
  it('maps every fixture epic to create_epic and update_plan_draft inputs the schemas accept', () => {
    const epics = parseBoard(boardFixtures()).epics
    expect(epics.map((epic) => epic.boardId)).toEqual(['008', '013', '014', '019'])
    expect(epics.map(schemaErrors)).toEqual(epics.map(() => [undefined, undefined]))
  })

  it('maps an epic at the plan-size limit to one request the schema still accepts', () => {
    const files = Array.from({ length: LIMITS.opsPerRequest - 1 }, (_, n) => ({
      path: `board/backlog/090.${n + 1}-t.md`,
      text: `# 090.${n + 1} — Ticket ${n + 1}\n`
    }))
    const [epic] = parseBoard(files).epics
    expect(epic && boardEpicImport(epic).ops).toHaveLength(LIMITS.opsPerRequest)
    expect(epic && schemaErrors(epic)).toEqual([undefined, undefined])
  })
})

describe('boardEpicImport create_epic input', () => {
  it('takes the open epic 014 title, its description plus the source path as intent, and unchecked criteria', () => {
    expect(boardEpicImport(fixtureEpic('014')).createEpic).toEqual({
      title: 'Cross-host validation and release (milestone 6)',
      intent:
        'Package the headless MCP entry with the app, document host setup, and validate on Windows/macOS and a second agent host.\n\nSub-tickets: 014.1–014.4.\n\nImported from the /board file `board/in-progress/014-cross-host-release.md`.',
      successCriteria: ['All sub-tickets 014.1–014.4 are done']
    })
  })

  it('drops checked epic criteria and names the source of a standalone ticket', () => {
    expect(boardEpicImport(fixtureEpic('013')).createEpic.successCriteria).toEqual([])
    expect(boardEpicImport(fixtureEpic('008')).createEpic).toEqual({
      title: 'Desktop experience mockups',
      intent: 'Imported from the /board file `board/done/008-desktop-mockups.md`.',
      successCriteria: []
    })
  })

  it('names the board epic number of sub-tickets that have no epic file', () => {
    const [orphan] = parseBoard([{ path: 'board/backlog/031.1-c.md', text: '# 031.1 — Waiting\n' }]).epics
    expect(orphan && boardEpicImport(orphan).createEpic).toEqual({
      title: 'Board epic 031',
      intent: 'Imported from /board epic 031, which has no epic file; each ticket references its own file.',
      successCriteria: []
    })
  })
})

describe('boardEpicImport update_plan_draft ops', () => {
  it('fills the one sprint a new epic starts with, tickets in board order', () => {
    const draft = draftAfterImport(fixtureEpic('014'))
    expect(draft.sprints).toHaveLength(1)
    expect(draft.sprints[0]?.goal).toBe('Cross-host validation and release (milestone 6)')
    const byId = new Map(draft.tickets.map((ticket) => [ticket.id, ticket.title]))
    expect(draft.sprints[0]?.ticketIds.map((id) => byId.get(id))).toEqual([
      'Package the MCP entry and connection snippet',
      'Host skill install wrapper',
      'Windows and macOS packaging verification',
      'Second agent host validation'
    ])
    expect(draft.edges).toEqual([])
  })

  it('carries only unchecked criteria, the Markdown body and a reference to the source file', () => {
    const [packageEntry, , packaging] = draftAfterImport(fixtureEpic('014')).tickets
    expect(packageEntry?.acceptanceCriteria).toEqual([])
    expect(packaging?.acceptanceCriteria.map((criterion) => criterion.text)).toEqual([
      'Packaged Windows (NSIS + portable) build starts the desktop and the MCP entry with a shared database',
      'Packaged macOS build does the same (arm64 and x64)'
    ])
    expect(packaging?.body).toBe('Requires Windows and macOS runners or machines; not verifiable from the Linux build container.')
    expect(packaging?.references).toEqual([
      {
        kind: 'file',
        label: 'Board ticket 014.3',
        location: 'board/backlog/014.3-windows-macos-packaging.md',
        hash: null,
        remoteOnly: false
      }
    ])
  })

  it('references the collapsed epic file for a folded-in sub-ticket', () => {
    const [reports] = draftAfterImport(fixtureEpic('013')).tickets
    expect(reports?.references.map((reference) => [reference.label, reference.location])).toEqual([
      ['Board ticket 013.1', 'board/done/013-checkpoints-and-recovery.md']
    ])
  })
})

describe('boardEpicImport dependencies', () => {
  function ticket(boardId: string, dependsOn: string[]): BoardTicket {
    return { boardId, title: `Ticket ${boardId}`, body: '', criteria: [], folder: 'backlog', sourcePath: `board/backlog/${boardId}-t.md`, dependsOn }
  }

  function epicWith(...tickets: BoardTicket[]): BoardEpic {
    const sourcePaths = tickets.map((item) => item.sourcePath)
    return { boardId: '080', kind: 'orphan', title: 'Board epic 080', body: '', criteria: [], folder: 'backlog', sourcePath: null, sourcePaths, tickets }
  }

  it('adds a prerequisite edge for each dependency the board states', () => {
    const { ops } = boardEpicImport(epicWith(ticket('080.1', []), ticket('080.2', ['080.1']), ticket('080.3', ['080.1', '080.2'])))
    expect(ops.filter((op) => op.op === 'add_dependency')).toEqual([
      { op: 'add_dependency', from: 'board-080.1', to: 'board-080.2' },
      { op: 'add_dependency', from: 'board-080.1', to: 'board-080.3' },
      { op: 'add_dependency', from: 'board-080.2', to: 'board-080.3' }
    ])
  })

  it('adds no dependency the board does not state', () => {
    const { ops } = boardEpicImport(fixtureEpic('014'))
    expect(ops.map((op) => op.op)).toEqual(['update_sprint', 'add_ticket', 'add_ticket', 'add_ticket', 'add_ticket'])
  })

  it('leaves out a stated dependency that would close a cycle, so the draft accepts the rest', () => {
    const epic = epicWith(ticket('080.1', ['080.3']), ticket('080.2', ['080.1']), ticket('080.3', ['080.2']))
    expect(boardEpicImport(epic).ops.filter((op) => op.op === 'add_dependency')).toEqual([
      { op: 'add_dependency', from: 'board-080.3', to: 'board-080.1' },
      { op: 'add_dependency', from: 'board-080.1', to: 'board-080.2' }
    ])
    expect(draftAfterImport(epic).edges).toHaveLength(2)
  })
})
