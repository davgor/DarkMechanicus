import { dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { fail } from '../errors'
import { displayPath } from '../repo/paths'
import type { FsAdapter, RepoLayout } from '../repo/types'
import { BUILTIN_KNOWLEDGE } from './builtin'
import { parseFact, type KnowledgeDiagnostic, type KnowledgeFact, type KnowledgeLayer } from './fact'
import { mergeLayers } from './merge'

/** A fact file larger than this is skipped with a diagnostic. */
export const KNOWLEDGE_FILE_LIMIT = 64 * 1024

/** What `loadKnowledge` needs from a workspace; `RepositoryWorkspace` satisfies it. */
export interface KnowledgeWorkspace {
  layout: RepoLayout
  homeDir: string
  fs: FsAdapter
}

export interface KnowledgeLoad {
  facts: KnowledgeFact[]
  diagnostics: KnowledgeDiagnostic[]
  layers: {
    builtin: { count: number }
    /** `configured` once `<home>/knowledge.json` names a repository; `path` is that repository. */
    overall: { configured: boolean; path: string | null; count: number }
    repo: { path: string; count: number }
  }
}

/** The overall layer's location: a repository whose `knowledge/` folder holds the facts. */
export interface KnowledgePointer {
  repository: string
}

const pointerSchema = z.object({ repository: z.string().refine(isAbsolute, 'repository must be an absolute path') })

export function knowledgePointerFile(homeDir: string): string {
  return join(homeDir, 'knowledge.json')
}

/** The overall-layer pointer, or null when none is configured. Throws `invalid_input` for a malformed file. */
export function readKnowledgePointer(fs: Pick<FsAdapter, 'exists' | 'readFile'>, homeDir: string): KnowledgePointer | null {
  const file = knowledgePointerFile(homeDir)
  if (!fs.exists(file)) return null
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFile(file))
  } catch {
    fail('invalid_input', `${file} is not valid JSON.`)
  }
  const parsed = pointerSchema.safeParse(raw)
  if (!parsed.success) fail('invalid_input', `${file}: ${parsed.error.issues[0].message}`)
  return { repository: parsed.data.repository }
}

/** Points the overall layer at `pointer.repository` (absolute), replacing the file atomically. */
export function writeKnowledgePointer(
  fs: Pick<FsAdapter, 'mkdirp' | 'writeFile' | 'rename'>,
  homeDir: string,
  pointer: KnowledgePointer
): void {
  if (!isAbsolute(pointer.repository)) fail('invalid_input', 'The knowledge repository must be an absolute path.')
  const file = knowledgePointerFile(homeDir)
  const temp = `${file}.tmp-${process.pid}`
  fs.mkdirp(dirname(file))
  fs.writeFile(temp, `${JSON.stringify({ repository: pointer.repository }, null, 2)}\n`)
  fs.rename(temp, file)
}

/** Removes the overall-layer pointer; nothing happens when none is configured. */
export function clearKnowledgePointer(fs: Pick<FsAdapter, 'exists' | 'remove'>, homeDir: string): void {
  const file = knowledgePointerFile(homeDir)
  if (fs.exists(file)) fs.remove(file)
}

interface LayerRead {
  facts: KnowledgeFact[]
  diagnostics: KnowledgeDiagnostic[]
}

function parseInto(read: LayerRead, source: string, layer: KnowledgeLayer, path: string): void {
  const result = parseFact(source, { layer, path })
  if (result.ok) read.facts.push(result.fact)
  else read.diagnostics.push(result.diagnostic)
}

function readBuiltin(): LayerRead {
  const read: LayerRead = { facts: [], diagnostics: [] }
  for (const { path, source } of BUILTIN_KNOWLEDGE) {
    if (Buffer.byteLength(source) > KNOWLEDGE_FILE_LIMIT) {
      read.diagnostics.push({ layer: 'builtin', path, message: 'file is larger than 64 KiB; skipped' })
    } else {
      parseInto(read, source, 'builtin', path)
    }
  }
  return read
}

/** One layer's folder walk: where diagnostics and facts go, and how a file's path is shown. */
interface TreeWalk {
  fs: FsAdapter
  layer: KnowledgeLayer
  label: (path: string) => string
  read: LayerRead
}

function report(walk: TreeWalk, path: string, message: string): void {
  walk.read.diagnostics.push({ layer: walk.layer, path: walk.label(path), message })
}

/** One folder entry; links are never followed (a linked folder could loop or leave the layer). */
function readEntry(walk: TreeWalk, path: string): void {
  const { fs } = walk
  if (fs.isSymlink(path)) report(walk, path, 'symbolic link not followed')
  else if (fs.isDirectory(path)) readTree(walk, path)
  else if (!path.endsWith('.md')) return
  else if (fs.fileSize(path) > KNOWLEDGE_FILE_LIMIT) report(walk, path, 'file is larger than 64 KiB; skipped')
  else parseInto(walk.read, fs.readFile(path), walk.layer, walk.label(path))
}

/** Reads every `*.md` below `dir`, depth first in name order; an unreadable entry becomes a diagnostic and the walk goes on. */
function readTree(walk: TreeWalk, dir: string): void {
  let names: string[]
  try {
    names = [...walk.fs.readdir(dir)].sort()
  } catch (error) {
    report(walk, dir, `cannot read folder: ${String(error)}`)
    return
  }
  for (const name of names) {
    const path = join(dir, name)
    try {
      readEntry(walk, path)
    } catch (error) {
      report(walk, path, `cannot read: ${String(error)}`)
    }
  }
}

function readOverall(workspace: KnowledgeWorkspace): LayerRead & { pointer: KnowledgePointer | null } {
  const read: LayerRead = { facts: [], diagnostics: [] }
  let pointer: KnowledgePointer | null
  try {
    pointer = readKnowledgePointer(workspace.fs, workspace.homeDir)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    read.diagnostics.push({ layer: 'overall', path: knowledgePointerFile(workspace.homeDir), message })
    return { ...read, pointer: null }
  }
  if (pointer === null) return { ...read, pointer }
  const dir = join(pointer.repository, 'knowledge')
  if (!workspace.fs.isDirectory(dir)) {
    read.diagnostics.push({ layer: 'overall', path: dir, message: 'knowledge folder does not exist' })
  } else {
    readTree({ fs: workspace.fs, layer: 'overall', label: (path) => path, read }, dir)
  }
  return { ...read, pointer }
}

/**
 * Loads and merges the built-in, overall and repo knowledge layers. Reads the disk on every call (no cache) so a
 * `git pull` shows at once. A missing repo folder or pointer is an empty layer; anything unreadable, malformed or
 * oversized becomes a diagnostic and never stops the other facts from loading.
 */
export function loadKnowledge(workspace: KnowledgeWorkspace): KnowledgeLoad {
  const { layout, fs } = workspace
  const builtin = readBuiltin()
  const overall = readOverall(workspace)
  const repo: LayerRead = { facts: [], diagnostics: [] }
  if (fs.exists(layout.knowledgeDir)) {
    readTree({ fs, layer: 'repo', label: (path) => displayPath(layout, path), read: repo }, layout.knowledgeDir)
  }

  const merged = mergeLayers([...builtin.facts, ...overall.facts, ...repo.facts])
  return {
    facts: merged.facts,
    diagnostics: [...builtin.diagnostics, ...overall.diagnostics, ...repo.diagnostics, ...merged.diagnostics],
    layers: {
      builtin: { count: builtin.facts.length },
      overall: { configured: overall.pointer !== null, path: overall.pointer?.repository ?? null, count: overall.facts.length },
      repo: { path: layout.knowledgeDir, count: repo.facts.length }
    }
  }
}
