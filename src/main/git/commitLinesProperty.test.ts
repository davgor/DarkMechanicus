/** Property-style check: for random edits and random line selections, the commit holds exactly the selected content. */
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { changedLineIndices, type FileDiff } from '../../shared/git/diff'
import type { RepoStatus } from '../../shared/git/status'
import { copyGitRepo, createGitRepo, type GitRepo } from '../../test/gitRepo'
import { put } from '../../test/gitScratch'
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

/** Every case's diff, read at once: the reads are independent, and they take no random numbers. */
async function readDiffs(r: GitRepo, status: RepoStatus, cases: ReadonlyArray<{ path: string; item: Case }>): Promise<TextDiff[]> {
  const diffs = await Promise.all(cases.map(({ path }) => readWorkingDiff(runner, r.root, findInStatus(status, path))))
  return diffs.map((diff, at) => {
    if (diff.kind !== 'text') {
      throw new Error(`expected a text diff for ${JSON.stringify(cases[at]?.item)}`)
    }
    return diff
  })
}

/** A case with its diff and its random selection of the diff's changed lines. */
function prepare({ path, item }: { path: string; item: Case }, diff: TextDiff, next: () => number): Prepared {
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

/** Whether the case deleted its file and committed the whole deletion, so HEAD's tree must not hold it. */
function deletedWhole({ item, selected, count }: Prepared): boolean {
  return item.newText === null && selected.size === count
}

/** HEAD's tree entry for each path (`git ls-tree HEAD -- <path>`'s line, '' for none), from one `ls-tree`. */
function treeEntries(r: GitRepo, paths: readonly string[]): Map<string, string> {
  const lines = paths.length === 0 ? [] : r.git('ls-tree', 'HEAD', '--', ...paths).split('\n')
  return new Map(paths.map((path) => [path, lines.find((line) => line.endsWith(`\t${path}`)) ?? '']))
}

/** HEAD's content of each path, as `git show HEAD:<path>` prints it, from one `git cat-file --batch`. */
function committedContents(r: GitRepo, paths: readonly string[]): Map<string, string> {
  const out = execFileSync('git', ['-C', r.root, 'cat-file', '--batch'], { input: paths.map((path) => `HEAD:${path}\n`).join('') })
  const contents = new Map<string, string>()
  let at = 0
  for (const path of paths) {
    const end = out.indexOf(0x0a, at)
    const header = out.subarray(at, end).toString('utf8')
    const size = /^[0-9a-f]+ blob (\d+)$/.exec(header)?.[1]
    if (size === undefined) {
      throw new Error(`HEAD holds no blob ${path}: ${header}`)
    }
    contents.set(path, out.subarray(end + 1, end + 1 + Number(size)).toString('utf8'))
    at = end + 1 + Number(size) + 1
  }
  return contents
}

/** Each case's working file and committed content, reading HEAD with two git processes for the whole batch. */
function observe(r: GitRepo, prepared: readonly Prepared[]): Observed[] {
  const entries = treeEntries(r, prepared.filter(deletedWhole).map(({ path }) => path))
  const contents = committedContents(r, prepared.filter((one) => !deletedWhole(one)).map(({ path }) => path))
  return prepared.map((one) => {
    const { path, item, diff, selected } = one
    const label = `${JSON.stringify(item)} lines ${JSON.stringify([...selected])}`
    const working = item.newText === null ? null : readFileSync(join(r.root, path), 'utf8')
    if (deletedWhole(one)) {
      return {
        actual: { label, working, committed: entries.get(path) ?? '' },
        expected: { label, working: null, committed: '' }
      }
    }
    return {
      actual: { label, working, committed: contents.get(path) ?? '' },
      expected: { label, working: item.newText, committed: expectedContent(item.oldText ?? '', item.newText ?? '', diff, selected) }
    }
  })
}

/** Runs `size` random cases through one commit, each case in a file of its own. */
async function runBatch(r: GitRepo, batch: number, size: number, next: () => number): Promise<Observed[]> {
  const cases = Array.from({ length: size }, (_, at) => ({ path: `case-${batch}-${at}.txt`, item: makeCase(next) }))
  writeCases(r, cases)
  const status = await requireStatus(runner, r.root)
  const diffs = await readDiffs(r, status, cases)
  // Selections are picked in case order, so the random numbers each case takes do not depend on the reads' timing.
  const prepared = cases.map((one, at) => prepare(one, diffs[at] as TextDiff, next))
  const files = prepared.map(({ path, selected, diff }) => ({ path, oldPath: null, lines: [...selected], diffHash: diff.hash }))
  await commitFiles(runner, r.root, { summary: `batch ${batch}`, description: '', files })
  return observe(r, prepared)
}

describe('commitFiles with random line selections', () => {
  it('commits exactly the selected content and never changes the working file', async () => {
    const base = createGitRepo()
    cleanups.push(base.cleanup)
    base.git('config', 'core.autocrlf', 'false')
    // Four batches of 20 cases, each in a repository of its own with its own generator seeded from 154, run side by
    // side: the cases stay replayable, and git's processes for one batch overlap another's.
    const seeds = random(154)
    const batches = [0, 1, 2, 3].map((batch) => {
      const r = batch === 0 ? base : copyGitRepo(base)
      if (r !== base) {
        cleanups.push(r.cleanup)
      }
      return { r, batch, next: random(Math.floor(seeds() * 4294967296)) }
    })
    const observed = (await Promise.all(batches.map(({ r, batch, next }) => runBatch(r, batch, 20, next)))).flat()
    const actual = observed.map((outcome) => outcome.actual)
    const expected = observed.map((outcome) => outcome.expected)
    expect(actual).toHaveLength(80)
    expect(actual).toEqual(expected)
  })
})
