import { describe, expect, it } from 'vitest'
import { realGitFirst } from './realGit'

const EXEC_PATH = 'C:/Program Files/Git/ucrt64/libexec/git-core'
const REAL_GIT = 'C:\\Program Files\\Git\\ucrt64\\libexec\\git-core\\git.exe'
const BIN = 'C:\\Program Files\\Git\\ucrt64\\bin'
const PATH = 'C:\\Program Files\\Git\\cmd;C:\\Windows\\System32'

describe('realGitFirst', () => {
  it("puts git's exec-path folder first on a Windows PATH when it holds the real git.exe", () => {
    const asked: string[] = []
    const path = realGitFirst({
      platform: 'win32',
      path: PATH,
      execPath: () => EXEC_PATH,
      exists: (file) => {
        asked.push(file)
        return file === REAL_GIT
      }
    })

    expect(path).toBe(`C:\\Program Files\\Git\\ucrt64\\libexec\\git-core;${PATH}`)
    expect(asked).toEqual([REAL_GIT])
  })

  it('finds the real Git for Windows executable when the helper directory no longer contains git.exe', () => {
    const asked: string[] = []
    const path = realGitFirst({
      platform: 'win32', path: PATH, execPath: () => EXEC_PATH,
      exists: file => { asked.push(file); return file === `${BIN}\\git.exe` }
    })

    expect(path).toBe(`${BIN};${PATH}`)
    expect(asked).toEqual([REAL_GIT, `${BIN}\\git.exe`])
  })

  it('does not look for a sibling executable outside the Git for Windows helper directory layout', () => {
    const asked: string[] = []
    expect(realGitFirst({
      platform: 'win32', path: PATH, execPath: () => 'C:/other/helpers/custom',
      exists: file => { asked.push(file); return file === 'C:\\other\\bin\\git.exe' }
    })).toBe(PATH)
    expect(asked).toEqual(['C:\\other\\helpers\\custom\\git.exe'])
  })

  it('leaves PATH alone when the exec-path folder holds no git.exe, or git cannot say where it is', () => {
    expect(realGitFirst({ platform: 'win32', path: PATH, execPath: () => EXEC_PATH, exists: () => false })).toBe(PATH)
    const noGit = (): string => {
      throw Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' })
    }
    expect(realGitFirst({ platform: 'win32', path: PATH, execPath: noGit, exists: () => true })).toBe(PATH)
  })

  it('leaves PATH alone off Windows, where git on PATH is the real binary, without asking git', () => {
    const unasked = (): string => {
      throw new Error('git asked off Windows')
    }
    expect(realGitFirst({ platform: 'linux', path: '/usr/bin:/bin', execPath: unasked, exists: () => true })).toBe('/usr/bin:/bin')
    expect(realGitFirst({ platform: 'darwin', path: '/usr/bin', execPath: unasked, exists: () => true })).toBe('/usr/bin')
  })
})
