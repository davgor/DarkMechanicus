import { describe, expect, it } from 'vitest'
import { sameFolder } from './paths'

describe('sameFolder', () => {
  it('ignores forward versus back slashes', () => {
    expect(sameFolder('C:/Users/me/repo', 'C:\\Users\\me\\repo')).toBe(true)
  })

  it('ignores drive-letter and path case on a Windows path', () => {
    expect(sameFolder('c:/Users/Me/Repo', 'C:\\users\\me\\repo')).toBe(true)
  })

  it('keeps case significant on a POSIX path', () => {
    expect(sameFolder('/home/me/Repo', '/home/me/repo')).toBe(false)
  })

  it('ignores trailing slashes', () => {
    expect(sameFolder('/home/me/repo/', '/home/me/repo')).toBe(true)
    expect(sameFolder('C:\\Users\\me\\repo\\', 'C:/Users/me/repo')).toBe(true)
  })

  it('does not report a subfolder as its repository root', () => {
    expect(sameFolder('/home/me/repo', '/home/me/repo/packages/app')).toBe(false)
    expect(sameFolder('C:/Users/me/repo', 'C:\\Users\\me\\repo\\packages')).toBe(false)
  })

  it('keeps a filesystem root intact', () => {
    expect(sameFolder('/', '/')).toBe(true)
    expect(sameFolder('C:\\', 'c:/')).toBe(true)
  })

  it('resolves both sides through realpath when one is given', () => {
    const links: Record<string, string> = { '/tmp/link': '/private/tmp/real' }
    const realpath = (path: string): string => links[path] ?? path
    expect(sameFolder('/tmp/link', '/private/tmp/real', realpath)).toBe(true)
    expect(sameFolder('/tmp/link', '/private/tmp/real')).toBe(false)
  })

  it('falls back to the given path when realpath throws', () => {
    const realpath = (): string => {
      throw new Error('ENOENT')
    }
    expect(sameFolder('/gone/repo/', '/gone/repo', realpath)).toBe(true)
  })
})
