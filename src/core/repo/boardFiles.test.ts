import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMemoryFs, type MemoryFs } from '../../test/memoryFs'
import { boardFixtures, FIXTURE_ROOT } from '../board/__mocks__/boardFixtures'
import { MAX_BOARD_FILE_BYTES, parseBoard } from '../board/parse'
import { MAX_BOARD_FOLDER_ENTRIES, readBoard } from './boardFiles'
import { nodeFs } from './nodeFs'

const ROOT = resolve('/work/repo')
const BOARD = join(ROOT, 'board')
const TICKET = '# 021 — A ticket\n\n## Acceptance criteria\n\n- [ ] Works\n'

function repoWithBoard(): MemoryFs {
  const fs = createMemoryFs()
  fs.put(join(BOARD, 'backlog', '.gitkeep'), '')
  fs.put(join(BOARD, 'done', '021-ticket.md'), TICKET)
  return fs
}

function skippedOf(fs: MemoryFs): [string, string][] {
  return readBoard(ROOT, fs).skipped.map((item) => [item.path, item.reason])
}

function epicIdsOf(fs: MemoryFs): string[] {
  return readBoard(ROOT, fs).epics.map((epic) => epic.boardId)
}

describe('readBoard', () => {
  it('reads the real board fixture from disk into the same parse as its contents', () => {
    const board = readBoard(FIXTURE_ROOT, nodeFs)
    expect(board.epics.map((epic) => epic.boardId)).toEqual(['008', '013', '014', '019'])
    expect(board).toEqual(parseBoard(boardFixtures()))
  })

  it('returns an empty board when the repository has no board folder', () => {
    const fs = createMemoryFs()
    fs.mkdirp(ROOT)
    expect(readBoard(ROOT, fs)).toEqual({ epics: [], skipped: [] })
  })

  it('ignores dot entries such as .gitkeep and reads the Markdown files of each folder', () => {
    const fs = repoWithBoard()
    expect(epicIdsOf(fs)).toEqual(['021'])
    expect(skippedOf(fs)).toEqual([])
  })

  it('reports other entries unread: non-Markdown files and directories', () => {
    const fs = repoWithBoard()
    fs.put(join(BOARD, 'done', 'icon.png'), 'binary')
    fs.mkdirp(join(BOARD, 'done', '022-folder.md'))
    expect(skippedOf(fs)).toEqual([
      ['board/done/022-folder.md', 'is a directory'],
      ['board/done/icon.png', 'is not a Markdown file']
    ])
    expect(fs.reads).not.toContain(join(BOARD, 'done', 'icon.png'))
    expect(epicIdsOf(fs)).toEqual(['021'])
  })

  it('reports a file over the size limit without reading it', () => {
    const fs = repoWithBoard()
    const big = join(BOARD, 'backlog', '023-big.md')
    fs.put(big, '# EPIC: Big\n')
    fs.setSize(big, MAX_BOARD_FILE_BYTES + 1)
    fs.failOn({ op: 'readFile', match: (path) => path === big })
    expect(skippedOf(fs)).toEqual([['board/backlog/023-big.md', 'is larger than the 64 KiB board file limit']])
  })

  it('reports a file that cannot be read and keeps the others', () => {
    const fs = repoWithBoard()
    const locked = join(BOARD, 'backlog', '024-locked.md')
    fs.put(locked, '# EPIC: Locked\n')
    fs.failOn({ op: 'readFile', match: (path) => path === locked })
    const board = readBoard(ROOT, fs)
    expect(board.skipped).toEqual([{ path: 'board/backlog/024-locked.md', reason: 'could not be read' }])
    expect(board.epics.map((epic) => epic.boardId)).toEqual(['021'])
  })
})

describe('readBoard limits and links', () => {
  it(`refuses a folder of more than ${MAX_BOARD_FOLDER_ENTRIES} entries unread and reads the other folders`, () => {
    const fs = repoWithBoard()
    fs.mkdirp(join(BOARD, 'in-progress'))
    const names = Array.from({ length: MAX_BOARD_FOLDER_ENTRIES + 1 }, (_, n) => `${n + 100}-t.md`)
    fs.setReaddir(join(BOARD, 'in-progress'), names)
    expect(skippedOf(fs)).toEqual([['board/in-progress', 'holds more than 1000 entries']])
    expect(epicIdsOf(fs)).toEqual(['021'])
  })

  it('refuses a board folder, status folder or file that is a link, without following it', () => {
    const fs = repoWithBoard()
    fs.put(resolve('/outside/secret.md'), '# EPIC: Outside\n')
    fs.symlink(join(BOARD, 'done', '025-link.md'), resolve('/outside/secret.md'))
    fs.symlink(join(BOARD, 'in-progress'), resolve('/outside'))
    expect(skippedOf(fs)).toEqual([
      ['board/done/025-link.md', 'is a link'],
      ['board/in-progress', 'is a link']
    ])
    expect(fs.reads).not.toContain(resolve('/outside/secret.md'))

    const linkedBoard = createMemoryFs()
    linkedBoard.mkdirp(ROOT)
    linkedBoard.mkdirp(resolve('/outside/board/done'))
    linkedBoard.symlink(BOARD, resolve('/outside/board'))
    expect(skippedOf(linkedBoard)).toEqual([['board', 'is a link']])
  })

  it('refuses a folder that resolves outside the board through a redirect not reported as a link', () => {
    const fs = repoWithBoard()
    fs.put(resolve('/outside/026-escaped.md'), '# EPIC: Escaped\n')
    fs.junction(join(BOARD, 'in-progress'), resolve('/outside'))
    expect(skippedOf(fs)).toEqual([['board/in-progress', 'resolves outside the board folder']])
    expect(epicIdsOf(fs)).toEqual(['021'])
  })

  it('refuses a board that is a file rather than a folder', () => {
    const fs = createMemoryFs()
    fs.put(BOARD, 'not a folder')
    expect(skippedOf(fs)).toEqual([['board', 'is not a directory']])
  })
})
