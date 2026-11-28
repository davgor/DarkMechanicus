import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBrowserShots } from './browserShots'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'dm-shots-'))
  roots.push(root)
  return root
}

describe('browser screenshot copies', () => {
  it('writes each copy in its own dm-browser-shot- folder', async () => {
    const shots = createBrowserShots({ root: scratch() })
    const first = await shots.write(PNG)
    const second = await shots.write(PNG)
    expect(dirname(first)).not.toBe(dirname(second))
    expect(readFileSync(first)).toEqual(PNG)
  })

  it('sweeps copies 10 minutes old at the next screenshot, including ones an earlier run left', async () => {
    const root = scratch()
    // A second ahead of the folders' own times, so the TTL boundary does not depend on how fast the writes run.
    let now = Date.now() + 1000
    const shots = createBrowserShots({ root, now: () => now })
    const old = await shots.write(PNG)
    const leftover = join(root, 'dm-browser-shot-crashed')
    mkdirSync(leftover)
    const unrelated = join(root, 'other-folder')
    mkdirSync(unrelated)
    const stale = new Date(now - 10 * 60_000)
    for (const folder of [leftover, unrelated]) utimesSync(folder, stale, stale)
    now += 9 * 60_000
    await shots.write(PNG)
    expect(existsSync(old)).toBe(true)
    now += 60_000
    const fresh = await shots.write(PNG)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(leftover)).toBe(false)
    expect(existsSync(unrelated)).toBe(true)
    expect(existsSync(fresh)).toBe(true)
  })

  it('removes every copy it wrote on dispose', async () => {
    const shots = createBrowserShots({ root: scratch() })
    const copies = [await shots.write(PNG), await shots.write(PNG)]
    await shots.dispose()
    for (const copy of copies) expect(existsSync(dirname(copy))).toBe(false)
  })
})
