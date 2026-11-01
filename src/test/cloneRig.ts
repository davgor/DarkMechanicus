/** A cloner over a scratch folder that the native dialog "picks", with a registry that records what it tracks. Not shipped. */
import { mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { TrackedFolderView } from '../shared/desktop/api'
import type { GitProgressEvent } from '../shared/git/api'
import { createCloneParentStore, createCloner, type Cloner } from '../main/git/clone'
import type { CredentialSession } from '../main/git/credentials'
import { createGitRunner, type GitRunner } from '../main/git/runner'
import { scratchDir } from './gitScratch'

export interface CloneRigOptions {
  runner?: GitRunner
  session?: CredentialSession
  /** The test-only `file://` allowance; on unless a test turns it off. */
  allowFile?: boolean
  /** Called before the registry records a path; a test makes tracking fail by throwing. */
  track?(path: string): void
  exitWaitMs?: number
}

export interface CloneRig {
  cloner: Cloner
  /** The folder the dialog picks: `<scratch>/clones`. */
  parent: string
  scratch: string
  tracked: string[]
  events: GitProgressEvent[]
}

/** The view the rig's registry returns for a tracked path. */
export function trackedView(path: string): TrackedFolderView {
  return { path, name: basename(path), displayPath: path, initialized: false, storageMode: 'repo', available: true, addedAt: '2026-11-01T00:00:00.000Z', childRepositories: null }
}

export function cloneRig(cleanups: Array<() => void>, options: CloneRigOptions = {}): CloneRig {
  const dir = scratchDir('dm-clone-')
  cleanups.push(dir.cleanup)
  const parent = join(dir.path, 'clones')
  mkdirSync(parent)
  const tracked: string[] = []
  const events: GitProgressEvent[] = []
  const cloner = createCloner({
    runner: options.runner ?? createGitRunner(),
    session: options.session ?? { getAccount: () => null, getToken: () => null },
    parents: createCloneParentStore({ file: join(dir.path, 'userData', 'clone.json'), pickDirectory: async () => parent }),
    registry: {
      track: (path) => {
        options.track?.(path)
        tracked.push(path)
        return { folder: trackedView(path), added: true }
      }
    },
    onProgress: (event) => events.push(event),
    env: {},
    allowFileProtocol: options.allowFile ?? true,
    ...(options.exitWaitMs === undefined ? {} : { exitWaitMs: options.exitWaitMs })
  })
  return { cloner, parent, scratch: dir.path, tracked, events }
}
