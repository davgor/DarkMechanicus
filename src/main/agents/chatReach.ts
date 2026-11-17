/**
 * What a project-less chat (`folder` null) can reach: every tracked folder that is set up for Dark Mechanicus, each
 * through a grant of its own, issued in that folder's workspace (`chatGrants.ts`, `issueReachCli`) and checked there by
 * the command layer like any other. A CLI session presents one token, so each folder's token is written to a file of
 * its own in the chat's scratch folder, and the chat names both on every call: `dm --repo <folder> --token-file <file>`.
 * The folders are the ones tracked when the terminal starts; a folder tracked later is reached from the next start.
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** One folder a project-less chat reaches, and the file holding the token of the grant it holds there. */
export interface ReachTarget {
  /** The tracked folder's canonical path. */
  folder: string
  /** Where that folder's grant token is written, only this user may read it. */
  tokenFile: string
}

/** Where the scratch folder keeps its grant tokens: one file per folder, named by a digest of the folder's path. */
export function reachTargets(scratchFolder: string, folders: readonly string[]): ReachTarget[] {
  return folders.map((folder) => ({
    folder,
    tokenFile: join(scratchFolder, '.dm', 'grants', `${createHash('sha256').update(folder).digest('hex').slice(0, 24)}.token`)
  }))
}
