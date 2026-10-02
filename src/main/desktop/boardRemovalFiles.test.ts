import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import { type BoardRemovalFs, MAX_REMOVAL_ENTRIES, previewBoardRemoval, removeBoardFiles } from './boardRemovalFiles'

const SKILL = '---\nname: complete-ticket\n---\n\nTickets live under `/board` (`backlog/`, `in-progress/`, `done/`).\n'
const COLLAPSE = '---\nname: collapse-epic\n---\n\nFold the sub-tickets in board/done into the epic file.\n'
const DELIVERY = '---\nname: delivery-standards\n---\n\nEvery task must be traceable on `/board`.\n'

/** The old workflow's files, as this repository had them at 52d6a0c (a few board files only). */
const OLD_WORKFLOW: Record<string, string> = {
  'board/backlog/.gitkeep': '',
  'board/backlog/014.3-windows-macos-packaging.md': '# 014.3 — Windows and macOS packaging\n',
  'board/done/001-engineering-delivery-standards.md': '# EPIC: Engineering delivery standards\n',
  'board/in-progress/.gitkeep': '',
  'board/in-progress/014-cross-host-release.md': '# EPIC: Cross-host release\n',
  '.claude/skills/complete-ticket/SKILL.md': SKILL,
  '.claude/skills/collapse-epic/SKILL.md': COLLAPSE,
  '.claude/skills/delivery-standards/SKILL.md': DELIVERY,
  '.cursor/skills/complete-ticket/SKILL.md': SKILL,
  '.cursor/skills/collapse-epic/SKILL.md': COLLAPSE,
  '.cursor/skills/delivery-standards/SKILL.md': DELIVERY,
  '.cursor/rules/delivery-standards.mdc': '---\ndescription: /board ticket traceability\n---\n',
  '.ai-instructions.md': '# AI Development Instructions\n\n- Board / TDD / delivery gate\n',
  'README.md': '# Project\n\nWork is tracked under [`board/`](board/).\n',
  'src/index.ts': 'export {}\n'
}

const WILL_DELETE = [
  '.claude/skills/collapse-epic/SKILL.md',
  '.claude/skills/complete-ticket/SKILL.md',
  '.cursor/skills/collapse-epic/SKILL.md',
  '.cursor/skills/complete-ticket/SKILL.md',
  'board/backlog/.gitkeep',
  'board/backlog/014.3-windows-macos-packaging.md',
  'board/done/001-engineering-delivery-standards.md',
  'board/in-progress/.gitkeep',
  'board/in-progress/014-cross-host-release.md'
]

const LINK_REASON = 'is a link; links are never followed or deleted'

interface Sandbox {
  repo: string
  outside: string
}

/** A repository holding the old workflow, and an unrelated directory that must never be touched. */
function withSandbox(run: (sandbox: Sandbox) => void): void {
  // Native realpath, like production, so Windows 8.3 temp names (RUNNER~1) are already expanded.
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-board-removal-')))
  try {
    const repo = join(base, 'repo')
    const outside = join(base, 'outside')
    mkdirSync(outside)
    for (const [path, text] of Object.entries(OLD_WORKFLOW)) {
      put(repo, path, text)
    }
    run({ repo, outside })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

function put(root: string, path: string, text: string): string {
  const file = join(root, ...path.split('/'))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  return file
}

/** Every entry under `root` (links listed, never followed), repository-relative with forward slashes. */
function tree(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const stats = lstatSync(path)
      found.push(`${relative(root, path).split(sep).join('/')}${stats.isDirectory() ? '/' : ''}`)
      if (stats.isDirectory()) {
        walk(path)
      }
    }
  }
  walk(root)
  return found
}

/** Links need a privilege on Windows; report false there instead of failing the suite. */
function tryLink(target: string, path: string, type: 'file' | 'junction'): boolean {
  try {
    symlinkSync(target, path, type)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      return false
    }
    throw error
  }
}

function errorCode(action: () => unknown): string {
  try {
    action()
  } catch (error) {
    return error instanceof DomainError ? error.code : String(error)
  }
  return 'no error'
}

describe('previewBoardRemoval on a real repository', () => {
  it('lists every file of board/ and of the board-only skills, and changes nothing', () => {
    withSandbox(({ repo }) => {
      const before = tree(repo)
      const preview = previewBoardRemoval(repo)
      expect(preview.remove).toEqual(WILL_DELETE)
      expect(preview.kept).toEqual([])
      expect(tree(repo)).toEqual(before)
    })
  })

  it('lists README, .ai-instructions.md, the delivery-standards skills and the Cursor rules for editing by hand', () => {
    withSandbox(({ repo }) => {
      expect(previewBoardRemoval(repo).editByHand).toEqual([
        { path: '.ai-instructions.md', lines: [3] },
        { path: '.claude/skills/delivery-standards/SKILL.md', lines: [5] },
        { path: '.cursor/rules/delivery-standards.mdc', lines: [2] },
        { path: '.cursor/skills/delivery-standards/SKILL.md', lines: [5] },
        { path: 'README.md', lines: [3] }
      ])
    })
  })

  it('finds nothing in a repository without the old workflow', () => {
    withSandbox(({ repo }) => {
      rmSync(join(repo, 'board'), { recursive: true })
      rmSync(join(repo, '.claude'), { recursive: true })
      rmSync(join(repo, '.cursor'), { recursive: true })
      expect(previewBoardRemoval(repo)).toEqual({
        remove: [],
        kept: [],
        editByHand: [
          { path: '.ai-instructions.md', lines: [3] },
          { path: 'README.md', lines: [3] }
        ]
      })
    })
  })

  it('reports a missing repository folder as not_found', () => {
    withSandbox(({ repo }) => {
      expect(errorCode(() => previewBoardRemoval(join(repo, 'gone')))).toBe('not_found')
    })
  })
})

describe('removeBoardFiles on a real repository', () => {
  it('deletes exactly the confirmed files, then the folders that leaves empty, and nothing else', () => {
    withSandbox(({ repo }) => {
      const result = removeBoardFiles(repo, WILL_DELETE)
      expect(result.removed).toEqual(WILL_DELETE)
      expect(result.removedFolders).toEqual([
        '.claude/skills/collapse-epic',
        '.claude/skills/complete-ticket',
        '.cursor/skills/collapse-epic',
        '.cursor/skills/complete-ticket',
        'board/backlog',
        'board/done',
        'board/in-progress',
        'board'
      ])
      expect(result.kept).toEqual([])
      expect(result.editByHand.map((mention) => mention.path)).toEqual([
        '.ai-instructions.md',
        '.claude/skills/delivery-standards/SKILL.md',
        '.cursor/rules/delivery-standards.mdc',
        '.cursor/skills/delivery-standards/SKILL.md',
        'README.md'
      ])
      expect(tree(repo)).toEqual([
        '.ai-instructions.md',
        '.claude/',
        '.claude/skills/',
        '.claude/skills/delivery-standards/',
        '.claude/skills/delivery-standards/SKILL.md',
        '.cursor/',
        '.cursor/rules/',
        '.cursor/rules/delivery-standards.mdc',
        '.cursor/skills/',
        '.cursor/skills/delivery-standards/',
        '.cursor/skills/delivery-standards/SKILL.md',
        'README.md',
        'src/',
        'src/index.ts'
      ])
    })
  })

})

describe('removeBoardFiles against the confirmed list', () => {
  it('leaves a file that appeared in board/ after the preview in place, with its folder', () => {
    withSandbox(({ repo }) => {
      const confirmed = previewBoardRemoval(repo).remove
      put(repo, 'board/done/021-new-epic.md', '# EPIC: New\n')

      const result = removeBoardFiles(repo, confirmed)

      expect(result.removed).toEqual(WILL_DELETE)
      expect(result.kept).toEqual([{ path: 'board/done/021-new-epic.md', reason: 'was not on the confirmed list' }])
      expect(result.removedFolders).not.toContain('board/done')
      expect(result.removedFolders).not.toContain('board')
      expect(tree(join(repo, 'board'))).toEqual(['done/', 'done/021-new-epic.md'])
    })
  })

  it('deletes only what was confirmed when the list is shorter than the preview', () => {
    withSandbox(({ repo }) => {
      const result = removeBoardFiles(repo, ['board/in-progress/.gitkeep'])
      expect(result.removed).toEqual(['board/in-progress/.gitkeep'])
      expect(existsSync(join(repo, 'board', 'in-progress', '014-cross-host-release.md'))).toBe(true)
      expect(existsSync(join(repo, '.claude', 'skills', 'complete-ticket', 'SKILL.md'))).toBe(true)
      expect(result.kept.map((kept) => kept.path)).toEqual(WILL_DELETE.filter((path) => path !== 'board/in-progress/.gitkeep'))
    })
  })

  it('never deletes a confirmed path that is not a file to remove', () => {
    withSandbox(({ repo }) => {
      const strays = ['README.md', '.ai-instructions.md', '.claude/skills/delivery-standards/SKILL.md', 'src/index.ts']
      const before = strays.map((path) => readFileSync(join(repo, ...path.split('/')), 'utf8'))

      const result = removeBoardFiles(repo, ['board/backlog/.gitkeep', ...strays])

      expect(result.removed).toEqual(['board/backlog/.gitkeep'])
      expect(strays.map((path) => readFileSync(join(repo, ...path.split('/')), 'utf8'))).toEqual(before)
      expect(result.kept.filter((kept) => kept.reason === 'is not one of the files to remove').map((kept) => kept.path)).toEqual(
        [...strays].sort()
      )
    })
  })
})

describe('removeBoardFiles path safety: paths outside the repository', () => {
  it('never deletes a file outside the repository, however the confirmed path reaches it', () => {
    withSandbox(({ repo, outside }) => {
      const victim = put(outside, 'victim.md', 'keep me')
      const confirmed = [
        '../outside/victim.md',
        'board/../../outside/victim.md',
        victim,
        `${repo}/../outside/victim.md`,
        'board/done/../../../outside/victim.md'
      ]

      const result = removeBoardFiles(repo, confirmed)

      expect(result.removed).toEqual([])
      expect(readFileSync(victim, 'utf8')).toBe('keep me')
      expect(result.kept.filter((kept) => kept.reason === 'is not one of the files to remove')).toHaveLength(confirmed.length)
      expect(existsSync(join(repo, 'board', 'done', '001-engineering-delivery-standards.md'))).toBe(true)
    })
  })

  it('refuses a board/ that is a link out of the repository and leaves its target alone', () => {
    withSandbox(({ repo, outside }) => {
      rmSync(join(repo, 'board'), { recursive: true })
      const target = join(outside, 'board')
      put(target, 'done/001-elsewhere.md', '# EPIC: Elsewhere\n')
      if (!tryLink(target, join(repo, 'board'), 'junction')) {
        expect(process.platform).toBe('win32')
        return
      }

      const preview = previewBoardRemoval(repo)
      expect(preview.remove.filter((path) => path.startsWith('board'))).toEqual([])
      expect(preview.kept).toEqual([{ path: 'board', reason: LINK_REASON }])

      const result = removeBoardFiles(repo, [...preview.remove, 'board/done/001-elsewhere.md'])
      expect(result.removed.filter((path) => path.startsWith('board'))).toEqual([])
      expect(readFileSync(join(target, 'done', '001-elsewhere.md'), 'utf8')).toBe('# EPIC: Elsewhere\n')
      expect(lstatSync(join(repo, 'board')).isSymbolicLink()).toBe(true)
    })
  })

})

describe('removeBoardFiles path safety: linked folders above', () => {
  it('refuses board skills behind a .claude folder that is a link, and leaves them alone', () => {
    withSandbox(({ repo, outside }) => {
      const shared = join(outside, 'dotclaude')
      put(shared, 'skills/complete-ticket/SKILL.md', SKILL)
      rmSync(join(repo, '.claude'), { recursive: true })
      if (!tryLink(shared, join(repo, '.claude'), 'junction')) {
        expect(process.platform).toBe('win32')
        return
      }

      const preview = previewBoardRemoval(repo)
      expect(preview.remove.filter((path) => path.startsWith('.claude'))).toEqual([])
      expect(preview.kept).toEqual([{ path: '.claude', reason: LINK_REASON }])

      removeBoardFiles(repo, ['.claude/skills/complete-ticket/SKILL.md'])
      expect(readFileSync(join(shared, 'skills', 'complete-ticket', 'SKILL.md'), 'utf8')).toBe(SKILL)
    })
  })

  it('works on the real folder when the repository path itself is a link to it', () => {
    withSandbox(({ repo, outside }) => {
      const link = join(outside, 'repo-link')
      symlinkSync(repo, link, 'junction')

      expect(removeBoardFiles(link, WILL_DELETE).removed).toEqual(WILL_DELETE)
      expect(existsSync(join(repo, 'board'))).toBe(false)
    })
  })
})

describe('removeBoardFiles path safety: links inside the old workflow', () => {
  it('keeps a link inside the board, never deletes through it, and deletes the regular files beside it', () => {
    withSandbox(({ repo, outside }) => {
      const victim = put(outside, 'victim.md', 'keep me')
      if (!tryLink(victim, join(repo, 'board', 'done', 'linked.md'), 'file')) {
        expect(process.platform).toBe('win32')
        return
      }

      const preview = previewBoardRemoval(repo)
      expect(preview.remove).toEqual(WILL_DELETE)
      expect(preview.kept).toEqual([{ path: 'board/done/linked.md', reason: LINK_REASON }])

      const result = removeBoardFiles(repo, [...preview.remove, 'board/done/linked.md'])

      expect(result.removed).toEqual(WILL_DELETE)
      expect(result.kept).toEqual([{ path: 'board/done/linked.md', reason: LINK_REASON }])
      expect(readFileSync(victim, 'utf8')).toBe('keep me')
      expect(lstatSync(join(repo, 'board', 'done', 'linked.md')).isSymbolicLink()).toBe(true)
      expect(result.removedFolders).not.toContain('board/done')
    })
  })

  it('never descends into a linked folder inside the board', () => {
    withSandbox(({ repo, outside }) => {
      const target = join(outside, 'notes')
      const victim = put(target, 'plan.md', 'keep me')
      if (!tryLink(target, join(repo, 'board', 'notes'), 'junction')) {
        expect(process.platform).toBe('win32')
        return
      }

      const preview = previewBoardRemoval(repo)
      expect(preview.remove.some((path) => path.startsWith('board/notes'))).toBe(false)
      expect(preview.kept).toEqual([{ path: 'board/notes', reason: LINK_REASON }])

      removeBoardFiles(repo, [...preview.remove, 'board/notes/plan.md'])
      expect(readFileSync(victim, 'utf8')).toBe('keep me')
      expect(existsSync(join(repo, 'board', 'notes'))).toBe(true)
    })
  })

})

describe('removeBoardFiles path safety: links in place of skills and files', () => {
  it('refuses a skill folder that is itself a link', () => {
    withSandbox(({ repo, outside }) => {
      const target = join(outside, 'complete-ticket')
      put(target, 'SKILL.md', SKILL)
      rmSync(join(repo, '.cursor', 'skills', 'complete-ticket'), { recursive: true })
      if (!tryLink(target, join(repo, '.cursor', 'skills', 'complete-ticket'), 'junction')) {
        expect(process.platform).toBe('win32')
        return
      }

      const preview = previewBoardRemoval(repo)
      expect(preview.kept).toEqual([{ path: '.cursor/skills/complete-ticket', reason: LINK_REASON }])
      removeBoardFiles(repo, ['.cursor/skills/complete-ticket/SKILL.md'])
      expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe(SKILL)
    })
  })

  it('does not delete a confirmed file that was replaced by a link after the preview', () => {
    withSandbox(({ repo, outside }) => {
      const confirmed = previewBoardRemoval(repo).remove
      const victim = put(outside, 'victim.md', 'keep me')
      const swapped = join(repo, 'board', 'done', '001-engineering-delivery-standards.md')
      unlinkSync(swapped)
      if (!tryLink(victim, swapped, 'file')) {
        expect(process.platform).toBe('win32')
        return
      }

      const result = removeBoardFiles(repo, confirmed)

      expect(result.removed).not.toContain('board/done/001-engineering-delivery-standards.md')
      expect(result.kept).toContainEqual({ path: 'board/done/001-engineering-delivery-standards.md', reason: LINK_REASON })
      expect(readFileSync(victim, 'utf8')).toBe('keep me')
      expect(lstatSync(swapped).isSymbolicLink()).toBe(true)
    })
  })
})

describe('removeBoardFiles recognition on a real repository', () => {
  it('leaves a complete-ticket skill that does not mention the board in place, and says why', () => {
    withSandbox(({ repo }) => {
      put(repo, '.claude/skills/complete-ticket/SKILL.md', '---\nname: complete-ticket\n---\n\nCloses a Jira ticket.\n')

      const preview = previewBoardRemoval(repo)
      expect(preview.remove).not.toContain('.claude/skills/complete-ticket/SKILL.md')
      expect(preview.kept).toEqual([
        { path: '.claude/skills/complete-ticket', reason: 'its SKILL.md does not refer to the board' }
      ])

      removeBoardFiles(repo, [...preview.remove, '.claude/skills/complete-ticket/SKILL.md'])
      expect(existsSync(join(repo, '.claude', 'skills', 'complete-ticket', 'SKILL.md'))).toBe(true)
    })
  })
})

type MemoryNode = { kind: 'file'; text: string } | { kind: 'directory' | 'symlink' | 'other' }

/** In-memory BoardRemovalFs: real paths remapped, deletions recorded, a hook after each unlink. */
class MemoryFs implements BoardRemovalFs {
  nodes = new Map<string, MemoryNode>()
  realpaths = new Map<string, string>()
  unlinked: string[] = []
  removedDirs: string[] = []
  afterUnlink: (path: string) => void = () => undefined

  constructor(readonly root: string) {
    this.nodes.set(root, { kind: 'directory' })
  }

  abs(path: string): string {
    return join(this.root, ...path.split('/'))
  }

  /** Adds a file and its missing parent folders. */
  file(path: string, text = ''): this {
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index += 1) {
      const dir = this.abs(parts.slice(0, index).join('/'))
      if (!this.nodes.has(dir)) {
        this.nodes.set(dir, { kind: 'directory' })
      }
    }
    this.nodes.set(this.abs(path), { kind: 'file', text })
    return this
  }

  entryKind(path: string): ReturnType<BoardRemovalFs['entryKind']> {
    return this.nodes.get(path)?.kind ?? 'missing'
  }

  readdir(path: string): string[] {
    return [...this.nodes.keys()].filter((key) => key !== path && dirname(key) === path).map((key) => basename(key))
  }

  readFile(path: string): string {
    const node = this.nodes.get(path)
    return node?.kind === 'file' ? node.text : ''
  }

  fileSize(path: string): number {
    return this.readFile(path).length
  }

  realpath(path: string): string {
    return this.realpaths.get(path) ?? path
  }

  unlink(path: string): void {
    this.unlinked.push(path)
    this.nodes.delete(path)
    this.afterUnlink(path)
  }

  rmdir(path: string): void {
    if (this.readdir(path).length > 0) {
      throw new Error('ENOTEMPTY')
    }
    this.removedDirs.push(path)
    this.nodes.delete(path)
  }
}

function memoryWorkflow(): MemoryFs {
  return new MemoryFs(join(sep, 'repo'))
    .file('board/done/001-a.md', '# EPIC: A\n')
    .file('board/done/002-b.md', '# EPIC: B\n')
    .file('board/done/003-c.md', '# EPIC: C\n')
    .file('.claude/skills/complete-ticket/SKILL.md', SKILL)
}

const MEMORY_FILES = ['.claude/skills/complete-ticket/SKILL.md', 'board/done/001-a.md', 'board/done/002-b.md', 'board/done/003-c.md']

describe('removeBoardFiles containment with an injected file system', () => {
  it('deletes through the injected file system and prunes the emptied folders', () => {
    const fs = memoryWorkflow()
    expect(removeBoardFiles(fs.root, MEMORY_FILES, fs).removed).toEqual(MEMORY_FILES)
    expect(fs.unlinked).toEqual(MEMORY_FILES.map((path) => fs.abs(path)))
    expect(fs.removedDirs).toEqual([fs.abs('.claude/skills/complete-ticket'), fs.abs('board/done'), fs.abs('board')])
  })

  it('re-checks the folders before each deletion: a folder turned into a link stops the rest', () => {
    const fs = memoryWorkflow()
    fs.afterUnlink = (path) => {
      if (path === fs.abs('board/done/001-a.md')) {
        fs.nodes.set(fs.abs('board/done'), { kind: 'symlink' })
      }
    }

    const result = removeBoardFiles(fs.root, MEMORY_FILES, fs)

    expect(result.removed).toEqual(['.claude/skills/complete-ticket/SKILL.md', 'board/done/001-a.md'])
    expect(fs.unlinked).toEqual([fs.abs('.claude/skills/complete-ticket/SKILL.md'), fs.abs('board/done/001-a.md')])
    expect(result.kept).toEqual([
      { path: 'board/done/002-b.md', reason: 'is no longer inside a real folder of the repository' },
      { path: 'board/done/003-c.md', reason: 'is no longer inside a real folder of the repository' }
    ])
    expect(fs.removedDirs).toEqual([fs.abs('.claude/skills/complete-ticket')])
  })

})

describe('removeBoardFiles containment of resolved folders', () => {
  it('refuses a board whose folder resolves outside the repository', () => {
    const fs = memoryWorkflow()
    fs.realpaths.set(fs.abs('board'), join(sep, 'elsewhere', 'board'))

    const result = removeBoardFiles(fs.root, MEMORY_FILES, fs)

    expect(fs.unlinked).toEqual([fs.abs('.claude/skills/complete-ticket/SKILL.md')])
    expect(result.kept).toContainEqual({ path: 'board', reason: 'resolves outside the repository' })
    expect(fs.removedDirs).toEqual([fs.abs('.claude/skills/complete-ticket')])
  })

  it('refuses a folder that resolves to a sibling whose name merely starts with the repository name', () => {
    const fs = memoryWorkflow()
    fs.realpaths.set(fs.abs('board/done'), join(sep, 'repo-evil', 'board', 'done'))

    removeBoardFiles(fs.root, MEMORY_FILES, fs)

    expect(fs.unlinked.filter((path) => path.includes(`${sep}board${sep}`))).toEqual([])
  })

  it('canonicalizes the repository root before comparing', () => {
    const fs = memoryWorkflow()
    const real = join(sep, 'real', 'repo')
    fs.realpaths.set(fs.root, real)
    for (const path of ['board', 'board/done', '.claude', '.claude/skills', '.claude/skills/complete-ticket']) {
      fs.realpaths.set(fs.abs(path), join(real, ...path.split('/')))
    }

    expect(removeBoardFiles(fs.root, MEMORY_FILES, fs).removed).toEqual(MEMORY_FILES)
  })

})

describe('removeBoardFiles limits and failures', () => {
  it('refuses a board with more entries than it walks, deleting none of them', () => {
    const fs = new MemoryFs(join(sep, 'repo'))
    for (let index = 0; index <= MAX_REMOVAL_ENTRIES; index += 1) {
      fs.file(`board/done/${String(index).padStart(5, '0')}.md`)
    }

    const preview = previewBoardRemoval(fs.root, fs)
    expect(preview.remove).toEqual([])
    expect(preview.kept).toEqual([
      { path: 'board', reason: `holds more than ${MAX_REMOVAL_ENTRIES} entries; remove it by hand` }
    ])
    removeBoardFiles(fs.root, ['board/done/00000.md'], fs)
    expect(fs.unlinked).toEqual([])
  })

  it('does not look into folders nested deeper than it walks, and leaves them in place', () => {
    const deep = Array.from({ length: 17 }, (_, index) => `d${index}`).join('/')
    const fs = memoryWorkflow().file(`board/${deep}/deep.md`)

    const preview = previewBoardRemoval(fs.root, fs)

    expect(preview.remove).not.toContain(`board/${deep}/deep.md`)
    expect(preview.kept).toEqual([
      { path: `board/${deep.split('/').slice(0, 16).join('/')}`, reason: 'is nested too deeply to look into' }
    ])
    removeBoardFiles(fs.root, [...preview.remove, `board/${deep}/deep.md`], fs)
    expect(fs.entryKind(fs.abs(`board/${deep}/deep.md`))).toBe('file')
    expect(fs.removedDirs).not.toContain(fs.abs('board'))
  })

  it('keeps going when one file cannot be deleted, and reports it', () => {
    const fs = memoryWorkflow()
    const unlink = fs.unlink.bind(fs)
    fs.unlink = (path) => {
      if (path === fs.abs('board/done/002-b.md')) {
        throw new Error('EBUSY')
      }
      unlink(path)
    }

    const result = removeBoardFiles(fs.root, MEMORY_FILES, fs)

    expect(result.removed).toEqual(MEMORY_FILES.filter((path) => path !== 'board/done/002-b.md'))
    expect(result.kept).toEqual([{ path: 'board/done/002-b.md', reason: 'could not be deleted' }])
    expect(fs.removedDirs).toEqual([fs.abs('.claude/skills/complete-ticket')])
  })
})
