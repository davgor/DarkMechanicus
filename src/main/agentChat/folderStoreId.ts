import { createHash } from 'node:crypto'

/**
 * The durable on-disk identity of a tracked folder: the first 32 hex characters of the sha256 of its canonical
 * path (the registry's `realpathSync.native` form), lowercased first on win32, where paths are case-insensitive.
 * Chat image directories, browser site files and persistent browser partitions (`persist:dm-browser-<id>`) are
 * named by it. They never use the folder's `attachmentKey`: that is random and lasts one app run, so it serves
 * only per-run URLs (`dm-chat-image://<attachmentKey>/…`), which main maps to the path (`pathForKey`) and then here.
 */
export function folderStoreId(canonicalPath: string, platform: NodeJS.Platform = process.platform): string {
  const identity = platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath
  return createHash('sha256').update(identity).digest('hex').slice(0, 32)
}
