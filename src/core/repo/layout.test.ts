import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DM_DIR, resolveLayout } from './layout'
import { dbProjectDir } from './storageMode'

const ROOT = resolve('/work/api')
const HOME = resolve('/home/dev/.darkmechanicus')

describe('resolveLayout in repo mode', () => {
  it('puts every path inside the repository, with the database under local/', () => {
    const layout = resolveLayout(ROOT)
    const dmDir = join(ROOT, DM_DIR)
    expect(layout).toEqual({
      root: ROOT,
      mode: 'repo',
      displayBase: ROOT,
      dmDir,
      projectFile: join(dmDir, 'project.json'),
      gitignoreFile: join(dmDir, '.gitignore'),
      epicsDir: join(dmDir, 'epics'),
      historyDir: join(dmDir, 'history'),
      profilesDir: join(dmDir, 'profiles'),
      localDir: join(dmDir, 'local'),
      dbFile: join(dmDir, 'local', 'state.sqlite'),
      machineFile: join(dmDir, 'local', 'machine.json')
    })
  })

  it('is the default, and ignores a home directory it does not need', () => {
    expect(resolveLayout(ROOT, { homeDir: HOME })).toEqual(resolveLayout(ROOT))
    expect(resolveLayout(ROOT, { mode: 'repo', homeDir: HOME })).toEqual(resolveLayout(ROOT))
  })
})

describe('resolveLayout in db mode', () => {
  const layout = resolveLayout(ROOT, { mode: 'db', homeDir: HOME })
  const projectDir = dbProjectDir(ROOT, HOME)

  it('keeps the repository root but moves every owned path into the home directory', () => {
    expect(layout.root).toBe(ROOT)
    expect(layout.mode).toBe('db')
    expect(layout.dmDir).toBe(projectDir)
    expect(layout.projectFile).toBe(join(projectDir, 'project.json'))
    expect(layout.localDir).toBe(join(projectDir, 'local'))
    expect(layout.dbFile).toBe(join(projectDir, 'local', 'state.sqlite'))
    expect(layout.machineFile).toBe(join(projectDir, 'local', 'machine.json'))
  })

  it('writes nothing into the repository folder', () => {
    for (const path of Object.values(layout)) {
      if (typeof path === 'string' && path !== ROOT && path !== 'db') {
        expect(path.startsWith(join(ROOT, DM_DIR))).toBe(false)
      }
    }
    expect(layout.dmDir.startsWith(ROOT)).toBe(false)
  })

  it('keeps the record directories inside the project directory, so a stray write cannot reach the repository', () => {
    expect(layout.epicsDir).toBe(join(projectDir, 'epics'))
    expect(layout.historyDir).toBe(join(projectDir, 'history'))
    expect(layout.profilesDir).toBe(join(projectDir, 'profiles'))
    expect(layout.gitignoreFile).toBe(join(projectDir, '.gitignore'))
  })

  it('shows owned paths relative to the project directory', () => {
    expect(layout.displayBase).toBe(projectDir)
  })

  it('refuses to resolve without a home directory', () => {
    expect(() => resolveLayout(ROOT, { mode: 'db' })).toThrow(/home directory/i)
  })

  it('gives two repositories of the same name different project directories', () => {
    const other = resolveLayout(resolve('/other/api'), { mode: 'db', homeDir: HOME })
    expect(other.dbFile).not.toBe(layout.dbFile)
  })
})
