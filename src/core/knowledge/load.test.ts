import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { createSequentialIds, createTestClock } from '../../test/testContext'
import { createTempRepo, linkDirectory, type TempRepo } from '../../test/tempRepo'
import { DomainError } from '../errors'
import { initializeRepository } from '../repo/initialize'
import { resolveLayout } from '../repo/layout'
import { nodeFs } from '../repo/nodeFs'
import { BUILTIN_KNOWLEDGE } from './builtin'
import {
  clearKnowledgePointer,
  KNOWLEDGE_FILE_LIMIT,
  knowledgePointerFile,
  loadKnowledge,
  readKnowledgePointer,
  writeKnowledgePointer,
  type KnowledgeWorkspace
} from './load'

function fact(id: string, body = `Body of ${id}.`, extra: string[] = []): string {
  return ['---', `id: ${id}`, 'type: convention', `title: Title ${id}`, ...extra, '---', '', body, ''].join('\n')
}

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

let repo: TempRepo | undefined
let git: GitRepo | undefined

afterEach(() => {
  repo?.cleanup()
  git?.cleanup()
  repo = undefined
  git = undefined
})

interface Setup {
  workspace: KnowledgeWorkspace
  homeDir: string
  overallRepo: string
}

function setup(): Setup {
  repo = createTempRepo()
  const homeDir = join(repo.base, 'home')
  mkdirSync(homeDir)
  return { workspace: { layout: repo.layout, homeDir, fs: nodeFs }, homeDir, overallRepo: join(repo.outside, 'team-knowledge') }
}

const builtinCount = BUILTIN_KNOWLEDGE.length

describe('loadKnowledge', () => {
  it('merges all three layers and counts each one', () => {
    const { workspace, homeDir, overallRepo } = setup()
    put(join(overallRepo, 'knowledge', 'team', 'shared.md'), fact('shared', 'From the overall layer.'))
    put(join(overallRepo, 'knowledge', 'overall-only.md'), fact('overall-only'))
    put(join(overallRepo, 'knowledge', 'README.txt'), 'not a fact')
    put(join(workspace.layout.knowledgeDir, 'nested', 'deep', 'shared.md'), fact('shared', 'From the repo layer.'))
    writeKnowledgePointer(nodeFs, homeDir, { repository: overallRepo })

    const result = loadKnowledge(workspace)

    expect(result.diagnostics).toEqual([])
    expect(result.layers).toEqual({
      builtin: { count: builtinCount },
      overall: { configured: true, path: overallRepo, count: 2 },
      repo: { path: workspace.layout.knowledgeDir, count: 1 }
    })
    const shared = result.facts.find((f) => f.id === 'shared')
    expect(shared).toMatchObject({ layer: 'repo', path: '.darkmechanicus/knowledge/nested/deep/shared.md', body: 'From the repo layer.' })
    expect(result.facts.find((f) => f.id === 'overall-only')?.layer).toBe('overall')
    expect(result.facts.filter((f) => f.layer === 'builtin')).toHaveLength(builtinCount)
    expect(result.facts).toHaveLength(builtinCount + 2)
  })

  it('reads the disk again on every call', () => {
    const { workspace } = setup()
    expect(loadKnowledge(workspace).layers.repo.count).toBe(0)
    put(join(workspace.layout.knowledgeDir, 'later.md'), fact('later'))
    expect(loadKnowledge(workspace).layers.repo.count).toBe(1)
  })

  it('treats a missing pointer as an unconfigured overall layer and a missing repo directory as empty, without diagnostics', () => {
    const { workspace } = setup()
    const result = loadKnowledge(workspace)
    expect(result.diagnostics).toEqual([])
    expect(result.layers.overall).toEqual({ configured: false, path: null, count: 0 })
    expect(result.layers.repo).toEqual({ path: workspace.layout.knowledgeDir, count: 0 })
    expect(result.facts).toHaveLength(builtinCount)
  })
})

describe('loadKnowledge with a bad overall pointer', () => {
  it('reports a pointer to a missing folder and still loads the other layers', () => {
    const { workspace, homeDir, overallRepo } = setup()
    put(join(workspace.layout.knowledgeDir, 'a.md'), fact('repo-a'))
    writeKnowledgePointer(nodeFs, homeDir, { repository: overallRepo })

    const result = loadKnowledge(workspace)

    expect(result.layers.overall).toEqual({ configured: true, path: overallRepo, count: 0 })
    expect(result.layers.repo.count).toBe(1)
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toMatchObject({ layer: 'overall', path: join(overallRepo, 'knowledge') })
    expect(result.diagnostics[0].message).toMatch(/does not exist/)
  })

  it('reports a malformed pointer file as unconfigured with a diagnostic', () => {
    const { workspace, homeDir } = setup()
    put(knowledgePointerFile(homeDir), '{ not json')
    const result = loadKnowledge(workspace)
    expect(result.layers.overall).toEqual({ configured: false, path: null, count: 0 })
    expect(result.diagnostics).toEqual([
      { layer: 'overall', path: knowledgePointerFile(homeDir), message: expect.stringMatching(/not valid JSON/) }
    ])
  })
})

describe('loadKnowledge with bad fact files', () => {
  it('turns a malformed fact into a diagnostic while the others load', () => {
    const { workspace } = setup()
    put(join(workspace.layout.knowledgeDir, 'good.md'), fact('good'))
    put(join(workspace.layout.knowledgeDir, 'bad.md'), '---\nid: bad\n')

    const result = loadKnowledge(workspace)

    expect(result.layers.repo.count).toBe(1)
    expect(result.facts.some((f) => f.id === 'good')).toBe(true)
    expect(result.diagnostics).toEqual([
      { layer: 'repo', path: '.darkmechanicus/knowledge/bad.md', message: expect.stringMatching(/^line \d+:/) }
    ])
  })

  it('skips a file over the size cap with a diagnostic', () => {
    const { workspace } = setup()
    put(join(workspace.layout.knowledgeDir, 'small.md'), fact('small'))
    put(join(workspace.layout.knowledgeDir, 'huge.md'), fact('huge', 'x'.repeat(KNOWLEDGE_FILE_LIMIT)))

    const result = loadKnowledge(workspace)

    expect(result.layers.repo.count).toBe(1)
    expect(result.facts.some((f) => f.id === 'huge')).toBe(false)
    expect(result.diagnostics).toEqual([
      { layer: 'repo', path: '.darkmechanicus/knowledge/huge.md', message: expect.stringMatching(/64 KiB/) }
    ])
  })
})

describe('loadKnowledge with an oversized built-in file', () => {
  it('skips a built-in file over the size cap with a diagnostic and loads the other built-in facts', async () => {
    const { workspace } = setup()
    vi.resetModules()
    vi.doMock('./builtin', () => ({
      BUILTIN_KNOWLEDGE: [
        { path: 'skills/knowledge/huge.md', source: fact('builtin.huge', 'x'.repeat(KNOWLEDGE_FILE_LIMIT)) },
        { path: 'skills/knowledge/small.md', source: fact('builtin.small') }
      ]
    }))
    try {
      // A fresh import, so `./load` binds to the mocked built-in layer instead of the shipped files.
      const { loadKnowledge: loadWithMockedBuiltin } = await import('./load')
      const result = loadWithMockedBuiltin(workspace)
      expect(result.facts.map((f) => f.id)).toEqual(['builtin.small'])
      expect(result.layers.builtin).toEqual({ count: 1 })
      expect(result.diagnostics).toEqual([
        { layer: 'builtin', path: 'skills/knowledge/huge.md', message: 'file is larger than 64 KiB; skipped' }
      ])
    } finally {
      vi.doUnmock('./builtin')
      vi.resetModules()
    }
  })
})

describe('loadKnowledge with linked folders and db mode', () => {
  it('does not follow a linked folder and reports it', () => {
    const { workspace, overallRepo } = setup()
    const elsewhere = join(dirname(overallRepo), 'elsewhere')
    put(join(elsewhere, 'linked.md'), fact('linked'))
    mkdirSync(workspace.layout.knowledgeDir, { recursive: true })
    linkDirectory(elsewhere, join(workspace.layout.knowledgeDir, 'link'))

    const result = loadKnowledge(workspace)

    expect(result.layers.repo.count).toBe(0)
    expect(result.diagnostics).toEqual([
      { layer: 'repo', path: '.darkmechanicus/knowledge/link', message: expect.stringMatching(/link/) }
    ])
  })

  it('reads the repo layer from the project directory in db mode', () => {
    const { workspace, homeDir } = setup()
    const layout = resolveLayout(workspace.layout.root, { mode: 'db', homeDir })
    put(join(layout.knowledgeDir, 'db.md'), fact('db-fact'))
    const result = loadKnowledge({ layout, homeDir, fs: nodeFs })
    expect(result.layers.repo).toEqual({ path: layout.knowledgeDir, count: 1 })
    expect(result.facts.find((f) => f.id === 'db-fact')?.path).toBe('knowledge/db.md')
  })
})

describe('knowledge pointer', () => {
  it('writes and reads the repository path in <home>/knowledge.json', () => {
    const { homeDir, overallRepo } = setup()
    expect(readKnowledgePointer(nodeFs, homeDir)).toBeNull()
    writeKnowledgePointer(nodeFs, homeDir, { repository: overallRepo })
    expect(knowledgePointerFile(homeDir)).toBe(join(homeDir, 'knowledge.json'))
    expect(JSON.parse(nodeFs.readFile(join(homeDir, 'knowledge.json')))).toEqual({ repository: overallRepo })
    expect(readKnowledgePointer(nodeFs, homeDir)).toEqual({ repository: overallRepo })
  })

  it('refuses a relative repository path, on write and on read', () => {
    const { homeDir } = setup()
    expect(() => writeKnowledgePointer(nodeFs, homeDir, { repository: 'relative/path' })).toThrow(DomainError)
    put(knowledgePointerFile(homeDir), JSON.stringify({ repository: 'relative/path' }))
    expect(() => readKnowledgePointer(nodeFs, homeDir)).toThrow(/absolute/)
  })

  it('clears the pointer, and clearing again changes nothing', () => {
    const { homeDir, overallRepo } = setup()
    writeKnowledgePointer(nodeFs, homeDir, { repository: overallRepo })
    clearKnowledgePointer(nodeFs, homeDir)
    expect(nodeFs.exists(knowledgePointerFile(homeDir))).toBe(false)
    expect(readKnowledgePointer(nodeFs, homeDir)).toBeNull()
    clearKnowledgePointer(nodeFs, homeDir)
    expect(readKnowledgePointer(nodeFs, homeDir)).toBeNull()
  })
})

describe('repo knowledge directory and git', () => {
  it('is not ignored by the .darkmechanicus/.gitignore a repo-mode project gets', () => {
    git = createGitRepo()
    const layout = resolveLayout(git.root)
    initializeRepository({ layout, fs: nodeFs, ids: createSequentialIds(), clock: createTestClock() }, {})
    put(join(layout.knowledgeDir, 'team', 'fact.md'), fact('tracked'))

    const checkIgnore = ['-C', git.root, 'check-ignore', '-q']
    expect(spawnSync('git', [...checkIgnore, '.darkmechanicus/knowledge/team/fact.md']).status).toBe(1)
    // The same check does see what is ignored, so a passing result above is meaningful.
    expect(spawnSync('git', [...checkIgnore, '.darkmechanicus/local/state.sqlite']).status).toBe(0)
  })
})
