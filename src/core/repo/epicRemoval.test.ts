import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMemoryFs, type MemoryFs } from '../../test/memoryFs'
import { domainErrorOf, idOf } from '../../test/repoFixtures'
import { removeEpicFiles } from './epicRemoval'
import { resolveLayout } from './layout'
import { ownedPaths } from './paths'

const EPIC = idOf('epic', 1)
const OTHER_EPIC = idOf('epic', 2)
const RUN = idOf('run', 3)
const MISSING_RUN = idOf('run', 4)
const OTHER_RUN = idOf('run', 5)
const layout = resolveLayout(resolve('/repo'))
const paths = ownedPaths(layout)

/** Two epics with snapshots, comments and run history, as the finalizer would have written them. */
function seededRepo(): MemoryFs {
  const fs = createMemoryFs()
  for (const epicId of [EPIC, OTHER_EPIC]) {
    fs.put(paths.epicPointerFile(epicId), '{}')
    fs.put(paths.epicStateFile(epicId), '{}')
    fs.put(paths.snapshotFile(epicId, idOf('revision', epicId === EPIC ? 6 : 7)), '{}')
    fs.put(paths.commentFile(epicId, idOf('comment', epicId === EPIC ? 8 : 9)), '{}')
  }
  fs.put(paths.runHistoryFile(RUN), '{}')
  fs.put(paths.runHistoryFile(OTHER_RUN), '{}')
  return fs
}

function filesUnder(fs: MemoryFs, dir: string): string[] {
  return [...fs.files().keys()].filter((path) => path.startsWith(`${dir}`)).sort()
}

describe('removeEpicFiles', () => {
  it("removes the epic's folder and its runs' history folders, and nothing else", () => {
    const fs = seededRepo()
    const removed = removeEpicFiles({ layout, fs }, EPIC, [RUN, MISSING_RUN])
    expect(removed).toEqual([`.darkmechanicus/epics/${EPIC}`, `.darkmechanicus/history/${RUN}`])
    expect(fs.exists(paths.epicDir(EPIC))).toBe(false)
    expect(fs.exists(paths.runDir(RUN))).toBe(false)
    expect(filesUnder(fs, layout.dmDir)).toEqual(
      [
        paths.commentFile(OTHER_EPIC, idOf('comment', 9)),
        paths.epicPointerFile(OTHER_EPIC),
        paths.snapshotFile(OTHER_EPIC, idOf('revision', 7)),
        paths.epicStateFile(OTHER_EPIC),
        paths.runHistoryFile(OTHER_RUN)
      ].sort()
    )
    expect(fs.isDirectory(layout.epicsDir)).toBe(true)
    expect(fs.isDirectory(layout.historyDir)).toBe(true)
  })

  it('reports nothing and changes nothing when the epic was never exported', () => {
    const fs = seededRepo()
    const before = fs.files()
    expect(removeEpicFiles({ layout, fs }, idOf('epic', 11), [MISSING_RUN])).toEqual([])
    expect(fs.files()).toEqual(before)
  })
})

describe('removeEpicFiles refusals', () => {
  it('refuses an epic folder that is a link, removing nothing', () => {
    const fs = seededRepo()
    const linked = idOf('epic', 12)
    fs.symlink(paths.epicDir(linked), paths.epicDir(OTHER_EPIC))
    const before = fs.files()
    expect(domainErrorOf(() => removeEpicFiles({ layout, fs }, linked, [])).code).toBe('unsafe_path')
    expect(fs.files()).toEqual(before)
  })

  it('refuses a link anywhere inside the folders before removing anything', () => {
    const fs = seededRepo()
    fs.put(join(resolve('/elsewhere'), 'keep.txt'), 'keep')
    fs.symlink(join(paths.runDir(RUN), 'escape'), resolve('/elsewhere'))
    const before = fs.files()
    const error = domainErrorOf(() => removeEpicFiles({ layout, fs }, EPIC, [RUN]))
    expect(error.code).toBe('unsafe_path')
    expect(fs.files()).toEqual(before)
    expect(fs.get(join(resolve('/elsewhere'), 'keep.txt'))).toBe('keep')
  })

  it.each(['..', '.', `..${'/'}${OTHER_EPIC}`, ''])('refuses a listed entry named %j that is not a plain child', (name) => {
    const fs = seededRepo()
    fs.setReaddir(paths.epicDir(EPIC), [name])
    const error = domainErrorOf(() => removeEpicFiles({ layout, fs }, EPIC, []))
    expect(error).toMatchObject({ code: 'unsafe_path', message: expect.stringContaining('not a plain entry') })
    expect(fs.exists(paths.epicPointerFile(OTHER_EPIC))).toBe(true)
    expect(fs.exists(paths.epicPointerFile(EPIC))).toBe(true)
  })
})
