/**
 * The folder a project-less chat (`folder` null, summoned from the AGENTS section) runs in: its own scratch
 * folder, `userData/agents/scratch/<chat id>`, made when its terminal starts and removed with everything in it when
 * the chat is deleted. It is no repository and no tracked folder: the chat reaches Dark Mechanicus records through
 * its grants (`chatGrants.ts`, `issueReachCli`), never through this folder.
 */
import { mkdirSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { chatIdSchema } from '../../shared/agents/chat'

/** Where the chat's scratch folder is. The chat id names a folder, so anything but a chat id is refused. */
export function scratchFolderPath(userData: string, chatId: string): string {
  if (!chatIdSchema.safeParse(chatId).success) {
    throw new Error(`${JSON.stringify(chatId)} is not a chat id.`)
  }
  return join(userData, 'agents', 'scratch', chatId)
}

/** Makes the chat's scratch folder when it is missing; answers its canonical real path, the terminal's cwd. */
export function ensureScratchFolder(userData: string, chatId: string): string {
  const folder = scratchFolderPath(userData, chatId)
  mkdirSync(folder, { recursive: true })
  return realpathSync.native(folder)
}

/** Removes the chat's scratch folder and everything in it; one that is already gone is not an error. */
export async function removeScratchFolder(userData: string, chatId: string): Promise<void> {
  await rm(scratchFolderPath(userData, chatId), { recursive: true, force: true })
}
