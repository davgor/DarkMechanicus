import type { BranchEpicView } from '../../shared/domain/views'
import type { Db } from '../db/database'
import { isStableId } from '../ids'
import { displayPath } from './paths'
import { type EpicPointerRecord, epicPointerRecord, type EpicStateRecord, epicStateRecord, parseRecord } from './portable'
import type { GitAdapter, RepoLayout } from './types'

const MAX_BRANCHES = 50
const MAX_EPICS = 500

interface BranchEpicDeps {
  db: Db
  git: GitAdapter
  layout: RepoLayout
}

interface Candidate {
  epicId: string
  hasPointer: boolean
}

/** Epic directories listed at a ref that hold a state record (the pointer is optional). */
function candidatesFrom(files: string[], epicsPath: string): Candidate[] {
  const kinds = new Map<string, Set<string>>()
  for (const file of files) {
    const [epicId, name, extra] = file.slice(epicsPath.length + 1).split('/')
    if (file.startsWith(`${epicsPath}/`) && extra === undefined && epicId !== undefined && isStableId(epicId, 'epic')) {
      kinds.set(epicId, (kinds.get(epicId) ?? new Set()).add(name ?? ''))
    }
  }
  return [...kinds]
    .filter(([, names]) => names.has('state.json'))
    .map(([epicId, names]) => ({ epicId, hasPointer: names.has('current.json') }))
    .sort((a, b) => a.epicId.localeCompare(b.epicId))
}

/** Parses untrusted text from another branch; anything invalid is skipped rather than reported. */
function parsedOrNull<T>(parse: () => T): T | null {
  try {
    return parse()
  } catch {
    return null
  }
}

async function readState(deps: BranchEpicDeps, branch: string, path: string): Promise<EpicStateRecord | null> {
  const text = await deps.git.showFile(branch, path)
  return text === null ? null : parsedOrNull(() => parseRecord(epicStateRecord, text, `${branch}:${path}`))
}

async function readPointer(deps: BranchEpicDeps, branch: string, path: string): Promise<EpicPointerRecord | null> {
  const text = await deps.git.showFile(branch, path)
  return text === null ? null : parsedOrNull(() => parseRecord(epicPointerRecord, text, `${branch}:${path}`))
}

async function readBranchEpic(deps: BranchEpicDeps, branch: string, candidate: Candidate): Promise<BranchEpicView | null> {
  const dir = `${displayPath(deps.layout, deps.layout.epicsDir)}/${candidate.epicId}`
  const state = await readState(deps, branch, `${dir}/state.json`)
  if (state === null || state.epicId !== candidate.epicId) {
    return null
  }
  const pointer = candidate.hasPointer ? await readPointer(deps, branch, `${dir}/current.json`) : undefined
  if (pointer === null || (pointer !== undefined && pointer.epicId !== candidate.epicId)) {
    return null
  }
  return {
    branch,
    epicId: candidate.epicId,
    title: state.title,
    status: state.status,
    revisionNumber: pointer?.revisionNumber ?? null,
    presentLocally: deps.db.get('SELECT id FROM epics WHERE id = ?', candidate.epicId) !== undefined
  }
}

async function readBranch(deps: BranchEpicDeps, branch: string, limit: number): Promise<BranchEpicView[]> {
  const epicsPath = displayPath(deps.layout, deps.layout.epicsDir)
  const views: BranchEpicView[] = []
  for (const candidate of candidatesFrom(await deps.git.listFiles(branch, epicsPath), epicsPath)) {
    const view = views.length < limit ? await readBranchEpic(deps, branch, candidate) : null
    if (view !== null) {
      views.push(view)
    }
  }
  return views
}

/**
 * Epics recorded on other local branches, read through Git without switching the checkout
 * (at most 50 branches and 500 epics). Records are untrusted; invalid ones are skipped.
 */
export async function listBranchEpics(deps: BranchEpicDeps): Promise<BranchEpicView[]> {
  const current = deps.git.head()?.branch ?? null
  const branches = (await deps.git.listLocalBranches()).filter((branch) => branch !== current).slice(0, MAX_BRANCHES)
  const views: BranchEpicView[] = []
  for (const branch of branches) {
    if (views.length < MAX_EPICS) {
      views.push(...(await readBranch(deps, branch, MAX_EPICS - views.length)))
    }
  }
  return views
}
