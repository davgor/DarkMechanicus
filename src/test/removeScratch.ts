import { rmSync } from 'node:fs'

/**
 * Removes a scratch folder after a test. A process the test killed can still hold the folder as its working
 * directory for a while (Windows answers EPERM or EBUSY), so the removal retries and then gives up quietly:
 * a leftover folder in the operating system's temp directory is harmless, a failed suite is not.
 */
export function removeScratch(folder: string): void {
  try {
    rmSync(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  } catch {
    // The temp directory is cleaned up by the operating system later.
  }
}
