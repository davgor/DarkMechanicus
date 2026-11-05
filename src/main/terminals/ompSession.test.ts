/** How an OMP chat's session id is read from its own session folder, and the overlay that skips the Setup wizard. */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OMP_CONFIG_OVERLAY, ompFilePaths, ompSessionId, writeOmpFiles } from './ompSession'

const A = '01a19f51-856e-7612-8d38-0de416901104'
const B = '01a19f99-0000-7000-8000-00000000abcd'
const CHAT = 'ch_01hzzzzzzzzzzzzzzzzzzzzzzz'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omp-session-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function session(dir: string, stamp: string, id: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${stamp}_${id}.jsonl`), '{}\n')
}

describe('ompSessionId', () => {
  it('is null for a missing or empty folder', () => {
    expect(ompSessionId(join(root, 'none'))).toBeNull()
    mkdirSync(join(root, 'empty'))
    expect(ompSessionId(join(root, 'empty'))).toBeNull()
  })

  it('reads the id from <timestamp>_<uuid>.jsonl, ignoring other files', () => {
    session(root, '2026-11-03T02-51-22-350Z', A)
    writeFileSync(join(root, 'draft.txt'), 'say hi')
    writeFileSync(join(root, '2026-11-03T02-51-22-350Z_not-a-uuid.jsonl'), '')

    expect(ompSessionId(root)).toBe(A)
  })

  it('takes the newest when there are several', () => {
    session(root, '2026-11-03T02-51-22-350Z', A)
    session(root, '2026-11-04T01-00-00-000Z', B)

    expect(ompSessionId(root)).toBe(B)
  })
})

describe('writeOmpFiles', () => {
  it('rejects a name that is not a chat id', () => {
    expect(() => ompFilePaths(root, '../x')).toThrow(/not a chat id/)
  })

  it('makes the session folder and writes the overlay that skips the Setup wizard', async () => {
    const files = await writeOmpFiles(root, CHAT, false)

    expect(readdirSync(files.sessionDir)).toEqual([])
    expect(readFileSync(files.config, 'utf8')).toBe(OMP_CONFIG_OVERLAY)
    expect(OMP_CONFIG_OVERLAY).toBe('setupVersion: 2\n')
  })

  it('keeps the session folder on an ordinary start', async () => {
    const files = ompFilePaths(root, CHAT)
    session(files.sessionDir, '2026-11-03T02-51-22-350Z', A)
    await writeOmpFiles(root, CHAT, false)

    expect(ompSessionId(files.sessionDir)).toBe(A)
  })

  it('moves the old session aside on a fresh start, so it is not resumed', async () => {
    const files = ompFilePaths(root, CHAT)
    session(files.sessionDir, '2026-11-03T02-51-22-350Z', A)
    await writeOmpFiles(root, CHAT, true, () => 5)

    expect(ompSessionId(files.sessionDir)).toBeNull()
    expect(ompSessionId(`${files.sessionDir}.old-5`)).toBe(A)
  })
})
