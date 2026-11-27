/**
 * Compatibility guard for the optional sprint `delivery`: every plan snapshot saved before the field existed must
 * parse unchanged and keep its stored content hash. `snapshotRecord` recomputes `contentHash(bundle)` after parsing,
 * so a defaulted (or null) `delivery` would fail here.
 *
 * It reads the repository's own `.darkmechanicus/epics/<epic>/snapshots/*.json` (moved to the Forge World, so
 * possibly none in this checkout) and the real snapshots committed as test fixtures, which are always present.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { snapshotRecord } from '../repo/portable'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

const EPIC_ROOTS = [
  join(REPO_ROOT, '.darkmechanicus', 'epics'),
  join(REPO_ROOT, 'src', 'core', 'repo', '__mocks__', 'legacy', 'epics'),
  join(REPO_ROOT, 'src', 'test', 'fixtures', 'portable-history', 'epics')
]

function snapshotFiles(epicsRoot: string): string[] {
  if (!existsSync(epicsRoot)) {
    return []
  }
  return readdirSync(epicsRoot, { withFileTypes: true })
    .filter((epic) => epic.isDirectory())
    .map((epic) => join(epicsRoot, epic.name, 'snapshots'))
    .filter((dir) => existsSync(dir))
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => join(dir, name))
    )
}

const SNAPSHOTS = EPIC_ROOTS.flatMap(snapshotFiles)

describe('plan snapshots saved before sprint delivery existed', () => {
  it('finds the committed legacy snapshots', () => {
    expect(SNAPSHOTS.length).toBeGreaterThanOrEqual(3)
  })

  it.each(SNAPSHOTS.map((file) => [file.slice(REPO_ROOT.length), file]))(
    '%s parses with its stored contentHash and no sprint gains a delivery',
    (_label, file) => {
      // JSON.parse treats CR as whitespace, so LF and CRLF checkouts read alike.
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
      const parsed = snapshotRecord.safeParse(raw)
      expect(parsed.error?.issues ?? []).toEqual([])
      for (const sprint of parsed.data?.bundle.sprints ?? []) {
        expect(Object.hasOwn(sprint, 'delivery')).toBe(false)
      }
    }
  )
})
