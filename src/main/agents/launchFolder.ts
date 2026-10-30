/**
 * The folder a chat's agent process starts in, checked on disk at the moment it starts. A chat stores the
 * canonical path of the tracked folder it was created in; by the time a process starts, that folder may have
 * been moved, deleted, untracked, or replaced by a symlink to some other directory. Each of those is refused
 * here, so the process cwd, the protocol's workspace and the `--repo` of the chat's `dm` command are always
 * the one folder the person tracked.
 */
import { realpathSync, statSync } from 'node:fs'
import { DomainError } from '../../core/errors'
import type { ChatRecord } from '../../shared/agents/chat'
import { canonicalPath, type RegistryFs } from '../desktop/folderRegistry'

export interface LaunchFolderDeps {
  /** The canonical path of the tracked folder `path` names, or null when it is not tracked (`FolderRegistry.resolve`). */
  trackedFolder: (path: string) => string | null
  /** The disk; the real one when omitted. */
  fs?: Pick<RegistryFs, 'realpath' | 'isDirectory'>
}

const nodeFs: Pick<RegistryFs, 'realpath' | 'isDirectory'> = {
  realpath: (path) => realpathSync.native(path),
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }
}

function refuse(folder: string, reason: string): never {
  throw new DomainError('not_found', `The folder ${folder} ${reason}. Track the folder again to keep using this chat.`)
}

/**
 * The chat's folder as its agent may start in it: the canonical real path, which must exist, be a directory,
 * equal the path the chat stored (a symlink swapped in leads somewhere else), and still be tracked. Throws a
 * `not_found` DomainError naming the folder and the reason otherwise.
 */
export function resolveLaunchFolder(chat: Pick<ChatRecord, 'folder'>, deps: LaunchFolderDeps): string {
  const fs = deps.fs ?? nodeFs
  const { folder } = chat
  const canonical = canonicalPath(fs, folder)
  if (canonical === null) {
    refuse(folder, 'is gone: it was moved or deleted')
  }
  if (!fs.isDirectory(canonical)) {
    refuse(folder, 'is no longer a folder')
  }
  if (canonical !== folder) {
    refuse(folder, `now leads to ${canonical}, not to the folder this chat was created in`)
  }
  if (deps.trackedFolder(canonical) !== canonical) {
    refuse(folder, 'is no longer tracked')
  }
  return canonical
}
