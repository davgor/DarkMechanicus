import { rmSync } from 'node:fs'
import { releaseScratch } from './scratchHandles'

/**
 * Removes a scratch folder after a test. Every registered child and handle inside it is released first
 * (`releaseScratch`): handles are closed, and a registered child still in the folder fails the cleanup by name instead
 * of holding it through the retries. A process the test did not register can still hold the folder for a while
 * (Windows answers EPERM or EBUSY), so the removal retries and then gives up quietly: a leftover folder in the
 * operating system's temp directory is harmless, a failed suite is not.
 */
export function removeScratch(folder: string): void {
  releaseScratch(folder)
  try {
    rmSync(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  } catch {
    // The temp directory is cleaned up by the operating system later.
  }
}
