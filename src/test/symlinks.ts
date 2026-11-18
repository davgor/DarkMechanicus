/** Whether this machine lets a test create file symlinks. Not shipped. */
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from './removeScratch'

let probed: boolean | undefined

/**
 * True when a file symlink can actually be created here. Windows accounts without symlink rights get EPERM, including
 * on some CI hosts, so callers use the measured capability instead of an environment label. The probe runs once per process.
 */
export function canCreateFileSymlinks(): boolean {
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
