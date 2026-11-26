import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, rmSync, truncateSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function directory(home: string): string { return join(home, 'human-questions', 'active-waits') }

/** The grant authorizes contact; this separate one-shot marker only makes that contact revocable. */
export function humanWaitCurrent(home: string, id: string): boolean {
  try {
    const pid = Number(readFileSync(join(directory(home), id), 'utf8'))
    if (!Number.isSafeInteger(pid) || pid <= 0) return false
    process.kill(pid, 0)
    return true
  } catch { return false }
}

export function removeHumanWait(home: string, id: string): void {
  const file = join(directory(home), id)
  try {
    rmSync(file, { force: true })
  } catch {
    // Revoking the marker does not depend on permission to unlink it.
    try { truncateSync(file, 0) } catch { /* Cleanup cannot break a human reply or host shutdown. */ }
  }
}

/** A reply in chat revokes synchronously; an accepted Telegram reply revokes through the same marker. */
export function openHumanWait(home: string, id: string, onReply: () => void): () => void {
  const dir = directory(home)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, id)
  const watcher = watch(dir, { persistent: false }, (_event, name) => {
    if ((name === null || name === id) && !humanWaitCurrent(home, id)) onReply()
  })
  watcher.on('error', () => watcher.close())
  let fd: number
  try {
    fd = openSync(file, 'wx', 0o600)
  } catch (error) {
    watcher.close()
    throw error
  }
  try {
    writeFileSync(fd, String(process.pid))
  } catch (error) {
    watcher.close()
    closeSync(fd)
    removeHumanWait(home, id)
    throw error
  }
  let released = false
  return () => {
    if (released) return
    released = true
    watcher.close()
    // The opened descriptor can invalidate the marker even if directory permissions changed.
    try { ftruncateSync(fd, 0) } catch { /* removeHumanWait still attempts to unlink it. */ }
    try { closeSync(fd) } catch { /* Do not break the input hook. */ }
    removeHumanWait(home, id)
  }
}
