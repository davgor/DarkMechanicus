/** Temp-repository harness for Workspace integration tests. Not shipped. */
import { cpSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FsAdapter, GitAdapter, GitHead } from '../core/repo/types'
import { openWorkspace, type OpenWorkspaceOptions, type Workspace } from '../core/workspace'
import type { SessionRole } from '../shared/domain/views'
import { createSequentialIds, createTestClock, type TestClock } from './testContext'

interface FakeGit extends GitAdapter {
  setHead(head: GitHead | null): void
}

export function createFakeGit(initial: GitHead | null): FakeGit {
  let head = initial
  return {
    head: () => head,
    setHead: (next) => {
      head = next
    },
    countUncommitted: async () => 0,
    listLocalBranches: async () => [],
    listFiles: async () => [],
    showFile: async () => null,
    isAncestor: async () => null,
    commitParents: async () => null
  }
}

export interface Harness {
  root: string
  /** Dark Mechanicus home directory db-mode sessions store their projects in. */
  homeDir: string
  clock: TestClock
  git: FakeGit
  open(role: SessionRole, options?: OpenOptions): Workspace
  /** Copies tracked records (without local/) into a fresh directory, like a clone; `from` defaults to the harness root. */
  cloneTracked(from?: string): string
  cleanup(): void
}

interface OpenOptions {
  allowSave?: boolean
  root?: string
  /** Forces the storage mode instead of resolving it from the home directory. */
  mode?: OpenWorkspaceOptions['mode']
  /** A grant token, for a `cli` session. */
  grantToken?: string
  /** Replaces the harness's fake Git, e.g. with `createGitAdapter` on a real temporary repository. */
  git?: GitAdapter
  fs?: FsAdapter
  /** Defaults to in-process; stdio sessions search upward for the repository root. */
  transport?: OpenWorkspaceOptions['transport']
  autoReconcile?: boolean
}

interface HarnessEnv {
  root: string
  homeDir: string
  clock: TestClock
  ids: ReturnType<typeof createSequentialIds>
  git: FakeGit
}

function openOptions(env: HarnessEnv, role: SessionRole, options: OpenOptions): OpenWorkspaceOptions {
  return {
    repoRoot: options.root ?? env.root,
    role,
    label: `${role} session`,
    transport: options.transport ?? 'in_process',
    allowSave: options.allowSave ?? true,
    homeDir: env.homeDir,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.grantToken === undefined ? {} : { grantToken: options.grantToken }),
    clock: env.clock,
    ids: env.ids,
    git: options.git ?? env.git,
    ...(options.fs ? { fs: options.fs } : {}),
    ...(options.autoReconcile === undefined ? {} : { autoReconcile: options.autoReconcile }),
    serverInfo: { name: 'darkmechanicus-test', version: '0.0.0-test' }
  }
}

export function createHarness(): Harness {
  // Canonical, like the paths the desktop registry and the MCP entry point hand the workspace.
  const dirs = [
    realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-ws-'))),
    realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-home-')))
  ]
  const env: HarnessEnv = {
    root: dirs[0] ?? '',
    homeDir: dirs[1] ?? '',
    clock: createTestClock('2026-03-01T10:00:00.000Z'),
    ids: createSequentialIds(),
    git: createFakeGit({ branch: 'main', commit: 'a'.repeat(40), detached: false })
  }
  const { root, homeDir, clock, git } = env
  const workspaces: Workspace[] = []
  return {
    root,
    homeDir,
    clock,
    git,
    open(role, options = {}) {
      const workspace = openWorkspace(openOptions(env, role, options))
      workspaces.push(workspace)
      return workspace
    },
    cloneTracked(from = root) {
      const target = mkdtempSync(join(tmpdir(), 'dm-clone-'))
      dirs.push(target)
      cpSync(join(from, '.darkmechanicus'), join(target, '.darkmechanicus'), {
        recursive: true,
        filter: (source) => !source.includes(`${join('.darkmechanicus', 'local')}`)
      })
      return target
    },
    cleanup() {
      for (const workspace of workspaces) {
        workspace.close()
      }
      for (const dir of dirs) {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  }
}
