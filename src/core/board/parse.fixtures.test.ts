import { describe, expect, it } from 'vitest'
import { boardFixtures } from './__mocks__/boardFixtures'
import { type BoardEpic, parseBoard } from './parse'

const EPIC_014 = 'board/in-progress/014-cross-host-release.md'
const EPIC_013 = 'board/done/013-checkpoints-and-recovery.md'
const TICKET_008 = 'board/done/008-desktop-mockups.md'

function epicOf(boardId: string): BoardEpic {
  const epic = parseBoard(boardFixtures()).epics.find((item) => item.boardId === boardId)
  if (epic === undefined) {
    throw new Error(`Epic ${boardId} was not parsed`)
  }
  return epic
}

describe('parseBoard on the real board (52d6a0c)', () => {
  it('parses every fixture file, in epic number order, with nothing skipped', () => {
    const board = parseBoard(boardFixtures())
    expect(board.skipped).toEqual([])
    expect(board.epics.map((epic) => [epic.boardId, epic.kind, epic.folder])).toEqual([
      ['008', 'standalone', 'done'],
      ['013', 'epic', 'done'],
      ['014', 'epic', 'in-progress'],
      ['019', 'epic', 'done']
    ])
  })

  it('reads the open epic 014: title, description, its own criteria and every source path', () => {
    const epic = epicOf('014')
    expect(epic.title).toBe('Cross-host validation and release (milestone 6)')
    expect(epic.body).toBe(
      'Package the headless MCP entry with the app, document host setup, and validate on Windows/macOS and a second agent host.\n\nSub-tickets: 014.1–014.4.'
    )
    expect(epic.criteria).toEqual([{ text: 'All sub-tickets 014.1–014.4 are done', checked: false }])
    expect(epic.sourcePath).toBe(EPIC_014)
    expect(epic.sourcePaths).toEqual([
      EPIC_014,
      'board/done/014.1-package-mcp-entry.md',
      'board/done/014.2-skill-install-wrapper.md',
      'board/backlog/014.3-windows-macos-packaging.md',
      'board/backlog/014.4-second-host-validation.md'
    ])
  })

})

describe('parseBoard on the open epic 014 and its sub-tickets', () => {
  it('orders 014 sub-tickets by M across folders, each with its own folder status and source file', () => {
    expect(epicOf('014').tickets.map((ticket) => [ticket.boardId, ticket.title, ticket.folder, ticket.sourcePath])).toEqual([
      ['014.1', 'Package the MCP entry and connection snippet', 'done', 'board/done/014.1-package-mcp-entry.md'],
      ['014.2', 'Host skill install wrapper', 'done', 'board/done/014.2-skill-install-wrapper.md'],
      ['014.3', 'Windows and macOS packaging verification', 'backlog', 'board/backlog/014.3-windows-macos-packaging.md'],
      ['014.4', 'Second agent host validation', 'backlog', 'board/backlog/014.4-second-host-validation.md']
    ])
  })

  it('keeps open 014 criteria unchecked and every other section as the Markdown body', () => {
    const [, , packaging, secondHost] = epicOf('014').tickets
    expect(packaging).toEqual({
      boardId: '014.3',
      title: 'Windows and macOS packaging verification',
      body: 'Requires Windows and macOS runners or machines; not verifiable from the Linux build container.',
      criteria: [
        {
          text: 'Packaged Windows (NSIS + portable) build starts the desktop and the MCP entry with a shared database',
          checked: false
        },
        { text: 'Packaged macOS build does the same (arm64 and x64)', checked: false }
      ],
      folder: 'backlog',
      sourcePath: 'board/backlog/014.3-windows-macos-packaging.md',
      dependsOn: []
    })
    expect(secondHost?.criteria).toEqual([
      { text: 'A second host completes a sprint through MCP using the same plan', checked: false }
    ])
  })

  it('keeps done 014 criteria checked and their verification notes in the body', () => {
    const [packageEntry, skillWrapper] = epicOf('014').tickets
    expect(packageEntry?.criteria.map((criterion) => criterion.checked)).toEqual([true, true, true])
    expect(packageEntry?.criteria[2]).toEqual({
      text: '`docs/runbooks/mcp-setup.md` documents host configuration',
      checked: true
    })
    expect(packageEntry?.body.startsWith('## Verification — 2026-09-30\n\n`npm run build` emits `out/main/mcp.js`')).toBe(true)
    expect(packageEntry?.body.endsWith('Windows and macOS installers are still unverified (014.3).')).toBe(true)
    expect(packageEntry?.body).not.toContain('Acceptance criteria')
    expect(skillWrapper?.body).toBe(
      '## Verification — 2026-09-30\n\n`src/main/desktop/skillInstall.test.ts` (writes `.claude/skills/darkmechanicus-*/SKILL.md`, refuses symlinks and escapes) against the real `SKILLS`.'
    )
  })
})

describe('parseBoard on a collapsed done epic (013)', () => {
  it('reads the epic part: description and verification as body, its own criteria checked', () => {
    const epic = epicOf('013')
    expect(epic.title).toBe('Sprint checkpoints and recovery (milestone 5)')
    expect(epic.sourcePath).toBe(EPIC_013)
    expect(epic.sourcePaths).toEqual([EPIC_013])
    expect(epic.criteria).toEqual([
      { text: 'All sub-tickets 013.1–013.6 are done', checked: true },
      { text: 'Lint, tests, fireguard, typecheck, deadcode, and build pass', checked: true }
    ])
    expect(epic.body.startsWith('Reports, advancement with human approval grants')).toBe(true)
    expect(epic.body).toContain('hostile-import hardening.\n\nSub-tickets: 013.1–013.6.\n\n## Verification — 2026-09-30\n\n')
    expect(epic.body.endsWith('removed by simplification in `471b022`.')).toBe(true)
    expect(epic.body).not.toContain('## Sub-tickets')
    expect(epic.body).not.toContain('013.1 —')
  })

  it('turns each ### NNN.M section under ## Sub-tickets into a ticket, in order', () => {
    const tickets = epicOf('013').tickets
    expect(tickets.map((ticket) => [ticket.boardId, ticket.title, ticket.criteria.length])).toEqual([
      ['013.1', 'Sprint reports and gate evaluation', 2],
      ['013.2', 'Human approval grants and advancement', 4],
      ['013.3', 'Revision adoption, takeover, reconciliation', 3],
      ['013.4', 'Searchable history, backup, branch epic index', 3],
      ['013.5', 'Hostile repository import suite', 2],
      ['013.6', 'Desktop checkpoint view, history search, storage footer', 3]
    ])
    expect(tickets.every((ticket) => ticket.folder === 'done' && ticket.sourcePath === EPIC_013)).toBe(true)
    expect(tickets.flatMap((ticket) => ticket.criteria).every((criterion) => criterion.checked)).toBe(true)
  })

  it('reads the demoted #### criteria of a collapsed sub-ticket and keeps the rest of its section as body', () => {
    const [reports] = epicOf('013').tickets
    expect(reports).toEqual({
      boardId: '013.1',
      title: 'Sprint reports and gate evaluation',
      body: '#### Verification — 2026-09-30\n\n`src/core/services/reports.test.ts` and `checkpoints.test.ts`.',
      criteria: [
        {
          text: 'Reports store accepted/failed/blocked work, changes, checks, risks, follow-ups, exit criteria, and (final sprint) epic outcome (tested)',
          checked: true
        },
        { text: 'A failed required ticket or unmet exit criterion blocks advancement with the reason (tested)', checked: true }
      ],
      folder: 'done',
      sourcePath: EPIC_013,
      dependsOn: []
    })
  })
})

describe('parseBoard on a standalone ticket (008) and an epic without sub-tickets (019)', () => {
  it('imports a standalone NNN ticket as an epic holding that one ticket', () => {
    const epic = epicOf('008')
    expect(epic).toMatchObject({
      kind: 'standalone',
      title: 'Desktop experience mockups',
      body: '',
      criteria: [],
      folder: 'done',
      sourcePath: TICKET_008,
      sourcePaths: [TICKET_008]
    })
    expect(epic.tickets).toHaveLength(1)
    const [ticket] = epic.tickets
    expect(ticket).toMatchObject({ boardId: '008', title: 'Desktop experience mockups', folder: 'done', sourcePath: TICKET_008 })
    expect(ticket?.criteria).toHaveLength(4)
    expect(ticket?.criteria[0]).toEqual({
      text: 'Mockups cover folder onboarding, the plan graph during a run, ticket detail, draft revision editing with validation, the sprint checkpoint gate, and permanent plan deletion.',
      checked: true
    })
    expect(ticket?.body).toBe(
      'Produce design mockups for the desktop experience in `docs/product-plan.md` so milestone 2–5 implementation can start from agreed screens. Design-only; no application code changes.\n\n## Verification — 2026-09-30\n\nMockups were built on a Claude Design canvas and exported as static HTML (tag balance checked). No code, tests, or dependencies changed.'
    )
  })

  it('keeps an EPIC file with no sub-tickets as an epic with no tickets, notes after its checklist in the body', () => {
    const epic = epicOf('019')
    expect(epic.title).toBe('Chibi Mechanicus app icon')
    expect(epic.tickets).toEqual([])
    expect(epic.criteria).toHaveLength(3)
    expect(epic.criteria.every((criterion) => criterion.checked)).toBe(true)
    expect(epic.body.startsWith('Give the desktop application a cute, red-hooded Mechanicus mascot')).toBe(true)
    expect(epic.body).toContain('matching renderer favicon.\n\nVerification: lint, typecheck, deadcode and production build passed.')
    expect(epic.body.endsWith('Windows CI still needs to rerun with this test correction.')).toBe(true)
    expect(epic.body).not.toContain('- [x]')
  })
})
