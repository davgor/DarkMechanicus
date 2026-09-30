/** Temp-repository harness for Workspace integration tests. Not shipped. */
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
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
    showFile: async () => null
  }
}

export interface Harness {
  root: string
  clock: TestClock
  git: FakeGit
  open(role: SessionRole, options?: OpenOptions): Workspace
  /** Copies tracked records (without local/) into a fresh directory, like a clone. */
  cloneTracked(): string
  cleanup(): void
}

interface OpenOptions {
  allowSave?: boolean
  root?: string
  fs?: FsAdapter
  /** Defaults to in-process; stdio sessions search upward for the repository root. */
  transport?: OpenWorkspaceOptions['transport']
  autoReconcile?: boolean
}

export function createHarness(): Harness {
  const dirs = [mkdtempSync(join(tmpdir(), 'dm-ws-'))]
  const root = dirs[0] ?? ''
  const clock = createTestClock('2026-03-01T10:00:00.000Z')
  const ids = createSequentialIds()
  const git = createFakeGit({ branch: 'main', commit: 'a'.repeat(40), detached: false })
  const workspaces: Workspace[] = []
  return {
    root,
    clock,
    git,
    open(role, options = {}) {
      const workspace = openWorkspace({
        repoRoot: options.root ?? root,
        role,
        label: `${role} session`,
        transport: options.transport ?? 'in_process',
        allowSave: options.allowSave ?? true,
        clock,
        ids,
        git,
        ...(options.fs ? { fs: options.fs } : {}),
        ...(options.autoReconcile === undefined ? {} : { autoReconcile: options.autoReconcile }),
        serverInfo: { name: 'darkmechanicus-test', version: '0.0.0-test' }
      })
      workspaces.push(workspace)
      return workspace
    },
    cloneTracked() {
      const target = mkdtempSync(join(tmpdir(), 'dm-clone-'))
      dirs.push(target)
      cpSync(join(root, '.darkmechanicus'), join(target, '.darkmechanicus'), {
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
