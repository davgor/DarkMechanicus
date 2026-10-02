/**
 * Real `/board` files from this repository's history (commit 52d6a0c, the last with the full board),
 * copied verbatim into `__mocks__/board/` with `git show 52d6a0c:board/<path>`. Test support only.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BoardFile } from '../parse'

/** A repository root whose `board/` folder holds the fixture files. */
export const FIXTURE_ROOT = fileURLToPath(new URL('.', import.meta.url))

const FOLDERS = ['backlog', 'in-progress', 'done']

/** Every fixture file as repository-relative path and contents, in folder then name order. */
export function boardFixtures(): BoardFile[] {
  return FOLDERS.flatMap((folder) =>
    readdirSync(join(FIXTURE_ROOT, 'board', folder))
      .sort()
      .map((name) => ({
        path: `board/${folder}/${name}`,
        text: readFileSync(join(FIXTURE_ROOT, 'board', folder, name), 'utf8')
      }))
  )
}
