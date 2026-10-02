import { describe, expect, it } from 'vitest'
import {
  boardMentionLines,
  confirmedRemoval,
  planBoardRemoval,
  REMOVAL_ROOTS,
  refersToBoard,
  type RemovalEntry,
  type RemovalScan
} from './removal'

const COMPLETE_TICKET = '---\nname: complete-ticket\n---\n\nThis repo tracks work under `/board` (`backlog/`, `in-progress/`, `done/`).\n'
const COLLAPSE_EPIC = '---\nname: collapse-epic\n---\n\nMerge every sub-ticket in board/done into the epic file.\n'
const UNRELATED_SKILL = '---\nname: complete-ticket\n---\n\nCompletes a Jira ticket and links the pull request.\n'
const DELIVERY = 'Every task must be traceable on `/board`:\n\nRun the tests.\n\n- [ ] Ticket created on /board\n'
const AI_INSTRUCTIONS = '# AI Development Instructions\n\nRun lint.\n\n- Board / TDD / delivery gate: see the skill\n'

function dir(path: string): RemovalEntry {
  return { path, kind: 'directory' }
}

function file(path: string): RemovalEntry {
  return { path, kind: 'file' }
}

/** The old board workflow as this repository had it at 52d6a0c, trimmed to a few files per folder. */
function oldWorkflow(): RemovalScan {
  return {
    entries: [
      dir('board'),
      dir('board/backlog'),
      file('board/backlog/.gitkeep'),
      file('board/backlog/014.3-windows-macos-packaging.md'),
      dir('board/done'),
      file('board/done/001-engineering-delivery-standards.md'),
      dir('board/in-progress'),
      file('board/in-progress/.gitkeep'),
      dir('.claude/skills/complete-ticket'),
      file('.claude/skills/complete-ticket/SKILL.md'),
      dir('.claude/skills/collapse-epic'),
      file('.claude/skills/collapse-epic/SKILL.md'),
      dir('.cursor/skills/complete-ticket'),
      file('.cursor/skills/complete-ticket/SKILL.md'),
      dir('.cursor/skills/collapse-epic'),
      file('.cursor/skills/collapse-epic/SKILL.md')
    ],
    texts: [
      { path: '.claude/skills/complete-ticket/SKILL.md', text: COMPLETE_TICKET },
      { path: '.claude/skills/collapse-epic/SKILL.md', text: COLLAPSE_EPIC },
      { path: '.cursor/skills/complete-ticket/SKILL.md', text: COMPLETE_TICKET },
      { path: '.cursor/skills/collapse-epic/SKILL.md', text: COLLAPSE_EPIC },
      { path: '.claude/skills/delivery-standards/SKILL.md', text: DELIVERY },
      { path: '.cursor/skills/delivery-standards/SKILL.md', text: DELIVERY },
      { path: '.cursor/rules/delivery-standards.mdc', text: DELIVERY },
      { path: '.ai-instructions.md', text: AI_INSTRUCTIONS },
      { path: 'README.md', text: '# Project\n\nTickets live under [`board/`](board/).\n' }
    ],
    problems: []
  }
}

function withEntries(scan: RemovalScan, entries: RemovalEntry[]): RemovalScan {
  return { ...scan, entries: [...scan.entries, ...entries] }
}

describe('board skill recognition', () => {
  it('recognizes a skill that refers to the /board folder or one of its status folders', () => {
    expect(refersToBoard(COMPLETE_TICKET)).toBe(true)
    expect(refersToBoard(COLLAPSE_EPIC)).toBe(true)
    expect(refersToBoard('Move the ticket to board/in-progress first.')).toBe(true)
    expect(refersToBoard('Search board/backlog for it.')).toBe(true)
  })

  it('does not recognize a skill that only shares the name', () => {
    expect(refersToBoard(UNRELATED_SKILL)).toBe(false)
    expect(refersToBoard('Pin it to the whiteboard and keep the dashboard green.')).toBe(false)
    expect(refersToBoard('The keyboard/ folder and onboarding/ stay.')).toBe(false)
  })

  it('finds every line that mentions the board, in any case', () => {
    expect(boardMentionLines(DELIVERY)).toEqual([1, 5])
    expect(boardMentionLines(AI_INSTRUCTIONS)).toEqual([5])
    expect(boardMentionLines('one\r\ntwo board\r\nthree')).toEqual([2])
    expect(boardMentionLines('dashboard, onboarding and keyboard')).toEqual([])
  })

  it('looks for board skills only under .claude/skills and .cursor/skills', () => {
    expect(REMOVAL_ROOTS).toEqual([
      'board',
      '.claude/skills/complete-ticket',
      '.claude/skills/collapse-epic',
      '.cursor/skills/complete-ticket',
      '.cursor/skills/collapse-epic'
    ])
  })
})

describe('planBoardRemoval', () => {
  it('lists every file of the board and of the board-only skills, and nothing else', () => {
    const plan = planBoardRemoval(oldWorkflow())
    expect(plan.remove).toEqual([
      '.claude/skills/collapse-epic/SKILL.md',
      '.claude/skills/complete-ticket/SKILL.md',
      '.cursor/skills/collapse-epic/SKILL.md',
      '.cursor/skills/complete-ticket/SKILL.md',
      'board/backlog/.gitkeep',
      'board/backlog/014.3-windows-macos-packaging.md',
      'board/done/001-engineering-delivery-standards.md',
      'board/in-progress/.gitkeep'
    ])
    expect(plan.kept).toEqual([])
  })

  it('lists instruction files that mention the board for editing by hand, never for deletion', () => {
    const plan = planBoardRemoval(oldWorkflow())
    expect(plan.editByHand).toEqual([
      { path: '.ai-instructions.md', lines: [5] },
      { path: '.claude/skills/delivery-standards/SKILL.md', lines: [1, 5] },
      { path: '.cursor/rules/delivery-standards.mdc', lines: [1, 5] },
      { path: '.cursor/skills/delivery-standards/SKILL.md', lines: [1, 5] },
      { path: 'README.md', lines: [3] }
    ])
    const deleted = new Set(plan.remove)
    for (const { path } of plan.editByHand) {
      expect(deleted.has(path)).toBe(false)
    }
  })

  it('does not list a file for editing that the removal deletes, or one that never mentions the board', () => {
    const scan = oldWorkflow()
    scan.texts.push({ path: 'AGENTS.md', text: '# Agents\n\nUse the dashboard.\n' })
    const listed = planBoardRemoval(scan).editByHand.map((mention) => mention.path)
    expect(listed).not.toContain('AGENTS.md')
    expect(listed).not.toContain('board/backlog/014.3-windows-macos-packaging.md')
    expect(listed.filter((path) => path.includes('complete-ticket') || path.includes('collapse-epic'))).toEqual([])
  })

})

describe('planBoardRemoval folders', () => {
  it('removes the folders the deletion empties, deepest first, so each comes before its parent', () => {
    expect(planBoardRemoval(oldWorkflow()).folders).toEqual([
      '.claude/skills/collapse-epic',
      '.claude/skills/complete-ticket',
      '.cursor/skills/collapse-epic',
      '.cursor/skills/complete-ticket',
      'board/backlog',
      'board/done',
      'board/in-progress',
      'board'
    ])
  })

  it('lists every file of a nested folder inside a board skill', () => {
    const scan = withEntries(oldWorkflow(), [
      dir('.claude/skills/complete-ticket/references'),
      file('.claude/skills/complete-ticket/references/format.md')
    ])
    const plan = planBoardRemoval(scan)
    expect(plan.remove).toContain('.claude/skills/complete-ticket/references/format.md')
    expect(plan.folders.indexOf('.claude/skills/complete-ticket/references')).toBeLessThan(
      plan.folders.indexOf('.claude/skills/complete-ticket')
    )
  })

  it('returns nothing for a repository without the old workflow', () => {
    expect(planBoardRemoval({ entries: [], texts: [], problems: [] })).toEqual({
      remove: [],
      kept: [],
      editByHand: [],
      folders: []
    })
  })
})

describe('planBoardRemoval refusals', () => {
  it('leaves a skill folder named like a board skill in place when its SKILL.md does not mention the board', () => {
    const scan = oldWorkflow()
    scan.texts = scan.texts.map((text) =>
      text.path === '.cursor/skills/complete-ticket/SKILL.md' ? { ...text, text: UNRELATED_SKILL } : text
    )
    const plan = planBoardRemoval(scan)
    expect(plan.remove).not.toContain('.cursor/skills/complete-ticket/SKILL.md')
    expect(plan.folders).not.toContain('.cursor/skills/complete-ticket')
    expect(plan.kept).toEqual([
      { path: '.cursor/skills/complete-ticket', reason: 'its SKILL.md does not refer to the board' }
    ])
  })

  it('leaves a skill folder without a SKILL.md in place', () => {
    const scan = withEntries(
      { ...oldWorkflow(), entries: oldWorkflow().entries.filter((entry) => !entry.path.startsWith('.cursor/skills/collapse-epic')) },
      [dir('.cursor/skills/collapse-epic'), file('.cursor/skills/collapse-epic/notes.md')]
    )
    scan.texts = scan.texts.filter((text) => text.path !== '.cursor/skills/collapse-epic/SKILL.md')
    const plan = planBoardRemoval(scan)
    expect(plan.remove.filter((path) => path.startsWith('.cursor/skills/collapse-epic'))).toEqual([])
    expect(plan.kept).toEqual([{ path: '.cursor/skills/collapse-epic', reason: 'has no SKILL.md to recognize it by' }])
  })

})

describe('planBoardRemoval links and other entries', () => {
  it('refuses a board or skill folder that is itself a link, and never lists what is behind it', () => {
    const scan: RemovalScan = {
      entries: [{ path: 'board', kind: 'link' }, { path: '.claude/skills/complete-ticket', kind: 'link' }],
      texts: [],
      problems: []
    }
    const plan = planBoardRemoval(scan)
    expect(plan.remove).toEqual([])
    expect(plan.folders).toEqual([])
    expect(plan.kept).toEqual([
      { path: '.claude/skills/complete-ticket', reason: 'is a link; links are never followed or deleted' },
      { path: 'board', reason: 'is a link; links are never followed or deleted' }
    ])
  })

  it('refuses a board that is a file rather than a folder', () => {
    const plan = planBoardRemoval({ entries: [file('board')], texts: [], problems: [] })
    expect(plan.remove).toEqual([])
    expect(plan.kept).toEqual([{ path: 'board', reason: 'is not a folder' }])
  })

  it('keeps links and special files inside the board, and still deletes the regular files beside them', () => {
    const scan = withEntries(oldWorkflow(), [
      { path: 'board/done/linked.md', kind: 'link' },
      { path: 'board/linked-folder', kind: 'link' },
      { path: 'board/done/pipe', kind: 'other' }
    ])
    const plan = planBoardRemoval(scan)
    expect(plan.remove).toContain('board/done/001-engineering-delivery-standards.md')
    expect(plan.remove).not.toContain('board/done/linked.md')
    expect(plan.remove).not.toContain('board/done/pipe')
    expect(plan.kept).toEqual([
      { path: 'board/done/linked.md', reason: 'is a link; links are never followed or deleted' },
      { path: 'board/done/pipe', reason: 'is not a regular file' },
      { path: 'board/linked-folder', reason: 'is a link; links are never followed or deleted' }
    ])
  })

  it('reports what the file layer could not look at as left in place', () => {
    const scan: RemovalScan = { ...oldWorkflow(), problems: [{ path: '.claude', reason: 'is a link' }] }
    expect(planBoardRemoval(scan).kept).toEqual([{ path: '.claude', reason: 'is a link' }])
  })

  it('ignores entries outside the removal roots', () => {
    const scan = withEntries(oldWorkflow(), [file('README.md'), file('boards/x.md'), file('.claude/skills/delivery-standards/SKILL.md')])
    const plan = planBoardRemoval(scan)
    expect(plan.remove).not.toContain('README.md')
    expect(plan.remove).not.toContain('boards/x.md')
    expect(plan.remove).not.toContain('.claude/skills/delivery-standards/SKILL.md')
  })
})

describe('confirmedRemoval', () => {
  const plan = planBoardRemoval(oldWorkflow())

  it('deletes exactly the confirmed files that are still files to remove', () => {
    expect(confirmedRemoval(plan, plan.remove)).toEqual({ remove: plan.remove, kept: [] })
  })

  it('leaves a file that appeared after the list was confirmed in place, and says so', () => {
    const confirmed = plan.remove.filter((path) => path !== 'board/backlog/.gitkeep')
    expect(confirmedRemoval(plan, confirmed)).toEqual({
      remove: confirmed,
      kept: [{ path: 'board/backlog/.gitkeep', reason: 'was not on the confirmed list' }]
    })
  })

  it('never deletes a confirmed path that is not a file to remove: outside, traversing, absolute or unrelated', () => {
    const strays = [
      'README.md',
      '.ai-instructions.md',
      '.claude/skills/delivery-standards/SKILL.md',
      'board/../README.md',
      '../outside/secret.txt',
      '/etc/passwd',
      'board',
      'board/done'
    ]
    const result = confirmedRemoval(plan, ['board/in-progress/.gitkeep', ...strays])
    expect(result.remove).toEqual(['board/in-progress/.gitkeep'])
    expect(result.kept.filter((kept) => kept.reason === 'is not one of the files to remove').map((kept) => kept.path)).toEqual(
      [...strays].sort()
    )
  })

  it('reports a confirmed path that is already left in place, such as a link, once with its own reason', () => {
    const linked = planBoardRemoval(withEntries(oldWorkflow(), [{ path: 'board/done/linked.md', kind: 'link' }]))
    expect(confirmedRemoval(linked, [...linked.remove, 'board/done/linked.md']).kept).toEqual([])
  })

  it('counts a path confirmed twice once', () => {
    expect(confirmedRemoval(plan, ['board/in-progress/.gitkeep', 'board/in-progress/.gitkeep']).remove).toEqual([
      'board/in-progress/.gitkeep'
    ])
  })
})
