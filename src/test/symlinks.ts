/** Whether this machine lets a test create file symlinks. Not shipped. */
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from './removeScratch'

let probed: boolean | undefined

/**
 * True when a file symlink can be created here. Windows accounts without symlink rights get EPERM, so tests that
 * need one skip there. CI (GitHub sets CI=true) always runs them, so a missing privilege fails there instead of
 * skipping silently. The probe runs once per process.
 */
export function canCreateFileSymlinks(): boolean {
  if (process.env.CI) {
    return true
  }
  if (probed === undefined) {
    probed = probeFileSymlink()
  }
  return probed
}

function probeFileSymlink(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'dm-symlink-probe-'))
  try {
    const target = join(dir, 'target.txt')
    writeFileSync(target, '')
    symlinkSync(target, join(dir, 'link.txt'))
    return true
  } catch {
    return false
  } finally {
    removeScratch(dir)
  }
}
