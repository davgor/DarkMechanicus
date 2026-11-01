/** Property-style check: for random edits and random line selections, the commit holds exactly the selected content. */
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { changedLineIndices, type FileDiff } from '../../shared/git/diff'
import type { RepoStatus } from '../../shared/git/status'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { gitIn, put } from '../../test/gitScratch'
import { commitFiles, findInStatus, requireStatus } from './commit'
import { readWorkingDiff } from './diff'
import { createGitRunner } from './runner'

type TextDiff = Extract<FileDiff, { kind: 'text' }>

const runner = createGitRunner()
const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

/** mulberry32: a small seeded generator, so a failing case can be replayed. */
function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Line texts that look like patch syntax, whitespace and empty lines, to catch an inexact patch. */
const WORDS = ['a', 'b', 'c', 'd', '', ' ', 'x\t', '\\ No newline at end of file', '-', '+', '@@ -1 +1 @@', 'é']

function content(next: () => number): string {
  const length = Math.floor(next() * 9)
  const lines = Array.from({ length }, () => `${WORDS[Math.floor(next() * WORDS.length)]}${next() < 0.2 ? '\r' : ''}`)
  const text = lines.join('\n')
  return length > 0 && next() < 0.8 ? `${text}\n` : text
}

/** A file's lines, each with its own line ending (the last may have none). */
function pieces(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

/** What the commit must hold, computed from the files and the diff's line numbers rather than from the patch. */
function expectedContent(oldText: string, newText: string, diff: TextDiff, selected: ReadonlySet<number>): string {
  const oldLines = pieces(oldText)
  const newLines = pieces(newText)
  const indices = changedLineIndices(diff)
  const out: string[] = []
  let next = 0
  diff.hunks.forEach((hunk, h) => {
    const first = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1
    out.push(...oldLines.slice(next, first))
    next = first
    hunk.lines.forEach((line, l) => {
      const index = indices[h][l]
      const kept = index === null || selected.has(index)
      if (line.kind === 'add') {
        out.push(...(kept ? [newLines[(line.newNumber ?? 0) - 1]] : []))
        return
      }
      out.push(...(line.kind === 'context' || !kept ? [oldLines[next]] : []))
      next += 1
    })
  })
  out.push(...oldLines.slice(next))
  // A line that is no longer last gains the newline it lacked.
  return out.map((piece, at) => (at < out.length - 1 && !piece.endsWith('\n') ? `${piece}\n` : piece)).join('')
}

interface Case {
  oldText: string | null
  newText: string | null
}

function makeCase(next: () => number): Case {
  const shape = next()
  const oldText = content(next)
  const newText = content(next)
  if (shape < 0.15 && newText !== '') {
    return { oldText: null, newText }
  }
  if (shape < 0.3 && oldText !== '') {
    return { oldText, newText: null }
  }
  return { oldText, newText: oldText === newText ? `${newText}z\n` : newText }
}

function pick(next: () => number, count: number): Set<number> {
  const selected = new Set([...Array(count).keys()].filter(() => next() < 0.5))
  return selected.size > 0 ? selected : new Set([Math.floor(next() * count)])
}

interface Prepared {
  path: string
  item: Case
  diff: TextDiff
  selected: Set<number>
  count: number
}

/** Commits the old side of every case at once, then writes the new side. */
function writeCases(r: GitRepo, cases: ReadonlyArray<{ path: string; item: Case }>): void {
  const based = cases.filter(({ item }) => item.oldText !== null)
  for (const { path, item } of based) {
    put(r.root, path, item.oldText ?? '')
  }
  r.git('add', '--', ...based.map(({ path }) => path))
  r.git('commit', '-q', '--allow-empty', '-m', 'base')
  for (const { path, item } of cases) {
    if (item.newText === null) {
      rmSync(join(r.root, path))
    } else {
      put(r.root, path, item.newText)
    }
  }
}

async function prepare(r: GitRepo, status: RepoStatus, { path, item }: { path: string; item: Case }, next: () => number): Promise<Prepared> {
  const diff = await readWorkingDiff(runner, r.root, findInStatus(status, path))
  if (diff.kind !== 'text') {
    throw new Error(`expected a text diff for ${JSON.stringify(item)}`)
  }
  const count = changedLineIndices(diff).flat().filter((index) => index !== null).length
  return { path, item, diff, selected: pick(next, count), count }
}

/** One case's working file and committed content (or HEAD's tree entry when the whole file was deleted). */
interface Outcome {
  label: string
  working: string | null
  committed: string
}

interface Observed {
  actual: Outcome
  expected: Outcome
}

function observe(r: GitRepo, { path, item, diff, selected, count }: Prepared): Observed {
  const label = `${JSON.stringify(item)} lines ${JSON.stringify([...selected])}`
  const working = item.newText === null ? null : readFileSync(join(r.root, path), 'utf8')
  if (item.newText === null && selected.size === count) {
    return {
      actual: { label, working, committed: r.git('ls-tree', 'HEAD', '--', path) },
      expected: { label, working: null, committed: '' }
    }
  }
  return {
    actual: { label, working, committed: gitIn(r.root, 'show', `HEAD:${path}`) },
    expected: { label, working: item.newText, committed: expectedContent(item.oldText ?? '', item.newText ?? '', diff, selected) }
  }
}

/** Runs `size` random cases through one commit, each case in a file of its own. */
async function runBatch(r: GitRepo, batch: number, size: number, next: () => number): Promise<Observed[]> {
  const cases = Array.from({ length: size }, (_, at) => ({ path: `case-${batch}-${at}.txt`, item: makeCase(next) }))
  writeCases(r, cases)
  const status = await requireStatus(runner, r.root)
  const prepared: Prepared[] = []
  for (const one of cases) {
    prepared.push(await prepare(r, status, one, next))
  }
  const files = prepared.map(({ path, selected, diff }) => ({ path, oldPath: null, lines: [...selected], diffHash: diff.hash }))
  await commitFiles(runner, r.root, { summary: `batch ${batch}`, description: '', files })
  return prepared.map((one) => observe(r, one))
}

describe('commitFiles with random line selections', () => {
  it('commits exactly the selected content and never changes the working file', async () => {
    const r = createGitRepo()
    cleanups.push(r.cleanup)
    r.git('config', 'core.autocrlf', 'false')
    const next = random(154)
    const actual: Outcome[] = []
    const expected: Outcome[] = []
    for (let batch = 0; batch < 4; batch += 1) {
      for (const outcome of await runBatch(r, batch, 20, next)) {
        actual.push(outcome.actual)
        expected.push(outcome.expected)
      }
    }
    expect(actual).toHaveLength(80)
    expect(actual).toEqual(expected)
  }, 180_000)
})
