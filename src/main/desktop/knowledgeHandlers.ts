/**
 * The behavior behind the `knowledge:*` IPC channels, as a pure factory over injected dependencies (no Electron
 * imports). Only the person sets the overall knowledge repository: the path comes from the native folder picker in
 * this process, never from an IPC payload, and a folder that is not a Git work tree is refused before
 * `<dmHome>/knowledge.json` is written.
 */
import { clearKnowledgePointer, loadKnowledge, writeKnowledgePointer } from '../../core/knowledge/load'
import { resolveLayout } from '../../core/repo/layout'
import type { FsAdapter } from '../../core/repo/types'
import type { KnowledgeChooseResult, KnowledgeRepositoryGitView, KnowledgeStatusView } from '../../shared/desktop/api'
import { GitError } from '../git/errors'
import type { GitRunner } from '../git/runner'
import { readRepoState } from '../git/status'
import type { FolderRegistry } from './folderRegistry'
import { requireTracked } from './handlers'

interface KnowledgeHandlerDeps {
  registry: Pick<FolderRegistry, 'resolve' | 'storageMode'>
  /** The Dark Mechanicus home directory, where `knowledge.json` lives. */
  dmHome: string
  fs: FsAdapter
  /** Reads the overall repository's Git state (`src/main/git`). */
  gitRunner: GitRunner
  /** Native folder picker for the overall repository; null when the person cancels. The only source of its path. */
  pickKnowledgeRepository: () => Promise<string | null>
}

/** Arguments are `unknown` because they come straight from IPC. */
export interface KnowledgeHandlers {
  knowledgeStatus(folder: unknown): Promise<KnowledgeStatusView>
  chooseKnowledgeRepository(): Promise<KnowledgeChooseResult>
  clearKnowledgeRepository(): Promise<void>
}

/** Branch, ahead/behind of its upstream and whether anything is uncommitted; `unavailable` says why not. */
async function readRepositoryGit(runner: GitRunner, repository: string): Promise<KnowledgeRepositoryGitView> {
  try {
    const state = await readRepoState(runner, repository)
    if (state.kind === 'git_missing') return { state: 'unavailable', reason: 'Git was not found on this computer.' }
    if (state.kind === 'not_repository') return { state: 'unavailable', reason: 'The folder is not a Git repository.' }
    const { branch, files } = state.status
    return {
      state: 'ok',
      branch: branch.name,
      upstream: branch.upstream,
      ahead: branch.ahead,
      behind: branch.behind,
      dirty: files.length > 0
    }
  } catch (error) {
    return { state: 'unavailable', reason: error instanceof Error && error.message !== '' ? error.message : String(error) }
  }
}

/** Null when `folder` is a Git work tree; otherwise why it cannot be the overall repository. */
async function workTreeRefusal(runner: GitRunner, folder: string): Promise<string | null> {
  const refusal = `${folder} is not a Git work tree. Choose the folder of a cloned repository.`
  try {
    const result = await runner.run({ cwd: folder, args: ['rev-parse', '--is-inside-work-tree'], kind: 'read' })
    return result.stdout.trim() === 'true' ? null : refusal
  } catch (error) {
    if (error instanceof GitError && error.code === 'git_not_found') return 'Git was not found on this computer.'
    if (error instanceof GitError) return refusal
    throw error
  }
}

async function knowledgeStatus(deps: KnowledgeHandlerDeps, folder: unknown): Promise<KnowledgeStatusView> {
  const repoPath = requireTracked(deps.registry, folder)
  const homeDir = deps.dmHome
  const layout = resolveLayout(repoPath, { mode: deps.registry.storageMode(repoPath), homeDir })
  const { layers, diagnostics } = loadKnowledge({ layout, homeDir, fs: deps.fs })
  const git = layers.overall.path === null ? null : await readRepositoryGit(deps.gitRunner, layers.overall.path)
  return { layers, diagnostics, git }
}

async function chooseRepository(deps: KnowledgeHandlerDeps): Promise<KnowledgeChooseResult> {
  const picked = await deps.pickKnowledgeRepository()
  if (picked === null) return { outcome: 'cancelled' }
  const refusal = await workTreeRefusal(deps.gitRunner, picked)
  if (refusal !== null) return { outcome: 'refused', reason: refusal }
  writeKnowledgePointer(deps.fs, deps.dmHome, { repository: picked })
  return { outcome: 'set', repository: picked }
}

export function createKnowledgeHandlers(deps: KnowledgeHandlerDeps): KnowledgeHandlers {
  return {
    knowledgeStatus: (folder) => knowledgeStatus(deps, folder),
    chooseKnowledgeRepository: () => chooseRepository(deps),
    clearKnowledgeRepository: async () => {
      clearKnowledgePointer(deps.fs, deps.dmHome)
    }
  }
}
