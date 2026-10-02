import { describe, expect, it } from 'vitest'
import { describeBoardRemoval, groupByFolder, mentionedLines } from './removalText'

describe('groupByFolder', () => {
  it('groups files under their folder in the order the paths come', () => {
    expect(
      groupByFolder([
        '.claude/skills/complete-ticket/SKILL.md',
        'board/backlog/.gitkeep',
        'board/done/001-a.md',
        'board/done/002-b.md'
      ])
    ).toEqual([
      { folder: '.claude/skills/complete-ticket/', files: ['SKILL.md'] },
      { folder: 'board/backlog/', files: ['.gitkeep'] },
      { folder: 'board/done/', files: ['001-a.md', '002-b.md'] }
    ])
  })

  it('keeps a file at the repository root under an empty folder, and returns nothing for no paths', () => {
    expect(groupByFolder(['board'])).toEqual([{ folder: '', files: ['board'] }])
    expect(groupByFolder([])).toEqual([])
  })
})

describe('mentionedLines', () => {
  it('names one line or several', () => {
    expect(mentionedLines([52])).toBe('line 52')
    expect(mentionedLines([29, 37, 39])).toBe('lines 29, 37, 39')
  })

  it('shows the first eight lines and counts the rest', () => {
    expect(mentionedLines([1, 2, 3, 4, 5, 6, 7, 8])).toBe('lines 1, 2, 3, 4, 5, 6, 7, 8')
    expect(mentionedLines([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe('lines 1, 2, 3, 4, 5, 6, 7, 8 and 2 more')
  })
})

describe('describeBoardRemoval', () => {
  const result = { removedFolders: [], kept: [], editByHand: [] }

  it('says how many files went and that nothing was committed', () => {
    expect(describeBoardRemoval({ ...result, removed: ['board/a.md'] })).toEqual({
      tone: 'success',
      message: 'Removed 1 file of the old board workflow. Nothing was committed.'
    })
    expect(describeBoardRemoval({ ...result, removed: ['board/a.md', 'board/b.md'] }).message).toBe(
      'Removed 2 files of the old board workflow. Nothing was committed.'
    )
  })

  it('says so when nothing was removed', () => {
    expect(describeBoardRemoval({ ...result, removed: [] })).toEqual({ tone: 'info', message: 'Nothing was removed.' })
  })
})
