import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DomainError } from '../errors'
import { inspectImageBytes, readImageFile, resolveAllowedRoots, type ImageFs } from './intake'

function png(width = 3, height = 2): Buffer {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

function jpeg(width = 5, height = 4): Buffer {
  // SOI, APP0 (len 4), SOF0 (len 11): precision, height, width, 1 component, EOI.
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08,
    height >> 8, height & 255, width >> 8, width & 255, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9
  ])
}

function refusal(run: () => unknown): DomainError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError)
    expect((error as DomainError).code).toBe('invalid_input')
    return error as DomainError
  }
  throw new Error('expected a refusal')
}

// eslint-disable-next-line max-lines-per-function -- one shared temp tree for the file cases
describe('image intake', () => {
  let base: string
  let project: string
  let outside: string
  let temp: string
  let roots: string[]

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'dm-intake-')))
    project = join(base, 'project')
    outside = join(base, 'outside')
    temp = join(base, 'temp')
    for (const dir of [project, outside, temp]) mkdirSync(dir)
    roots = [project, temp]
  })
  afterAll(() => rmSync(base, { recursive: true, force: true }))

  it('accepts a PNG and a JPEG from the project root and the temp folder', () => {
    for (const dir of [project, temp]) {
      writeFileSync(join(dir, 'a.png'), png(3, 2))
      writeFileSync(join(dir, 'b.jpg'), jpeg(5, 4))
      const a = readImageFile(join(dir, 'a.png'), roots)
      expect(a).toMatchObject({ mime: 'image/png', width: 3, height: 2 })
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(a.bytes.equals(png(3, 2))).toBe(true)
      expect(readImageFile(join(dir, 'b.jpg'), roots)).toMatchObject({ mime: 'image/jpeg', width: 5, height: 4 })
    }
  })

  it('refuses a file outside every root', () => {
    writeFileSync(join(outside, 'x.png'), png())
    expect(refusal(() => readImageFile(join(outside, 'x.png'), roots)).message).toMatch(/outside the allowed folders/)
  })

  it('refuses a path that escapes a root through ..', () => {
    writeFileSync(join(outside, 'y.png'), png())
    expect(refusal(() => readImageFile(join(project, '..', 'outside', 'y.png'), roots)).message).toMatch(/outside/)
  })

  it('refuses a symlink into a root', (context) => {
    writeFileSync(join(project, 'real.png'), png())
    try {
      symlinkSync(join(project, 'real.png'), join(project, 'link.png'), 'file')
    } catch {
      context.skip('creating a symlink needs privileges on this machine')
      return
    }
    expect(refusal(() => readImageFile(join(project, 'link.png'), roots)).message).toMatch(/symbolic link/)
  })

  it('refuses a link reported by the file system (injected, so it runs without symlink privileges)', () => {
    const fs: ImageFs = {
      exists: () => true,
      realpath: (p) => p,
      lstat: () => ({ isSymbolicLink: true, isFile: false, size: 10 }),
      readFile: () => png()
    }
    expect(refusal(() => readImageFile(join(project, 'l.png'), roots, fs)).message).toMatch(/symbolic link/)
  })

  it('refuses a directory', () => {
    mkdirSync(join(project, 'dir.png'))
    expect(refusal(() => readImageFile(join(project, 'dir.png'), roots)).message).toMatch(/regular file/)
  })

  it('refuses an SVG and a text file renamed .png', () => {
    writeFileSync(join(project, 'v.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    writeFileSync(join(project, 't.png'), 'just some text, not an image')
    expect(refusal(() => readImageFile(join(project, 'v.svg'), roots)).message).toMatch(/Unsupported image type/)
    expect(refusal(() => readImageFile(join(project, 't.png'), roots)).message).toMatch(/Unsupported image type/)
  })

  it('refuses an over-size file and an over-dimension header', () => {
    const big = Buffer.concat([png(), Buffer.alloc(10 * 1024 * 1024)])
    writeFileSync(join(project, 'big.png'), big)
    expect(refusal(() => readImageFile(join(project, 'big.png'), roots)).message).toMatch(/too large/)
    expect(refusal(() => inspectImageBytes(big)).message).toMatch(/too large/)
    writeFileSync(join(project, 'wide.png'), png(8001, 10))
    expect(refusal(() => readImageFile(join(project, 'wide.png'), roots)).message).toMatch(/too many pixels/)
    expect(refusal(() => inspectImageBytes(jpeg(10, 8001))).message).toMatch(/too many pixels/)
    expect(inspectImageBytes(png(8000, 8000))).toMatchObject({ width: 8000, height: 8000 })
  })

  it('decides the type by magic bytes: a PNG renamed .jpg is a PNG', () => {
    writeFileSync(join(project, 'p.jpg'), png(7, 9))
    expect(readImageFile(join(project, 'p.jpg'), roots)).toMatchObject({ mime: 'image/png', width: 7, height: 9 })
  })

  it('refuses a truncated PNG and a JPEG with no frame header', () => {
    expect(refusal(() => inspectImageBytes(png().subarray(0, 14))).message).toMatch(/PNG/)
    expect(refusal(() => inspectImageBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0]))).message).toMatch(/JPEG/)
  })

  it('reports a missing file as invalid_input and checks size before reading', () => {
    expect(refusal(() => readImageFile(join(project, 'nope.png'), roots)).message).toMatch(/cannot be read/)
    const fs: ImageFs = {
      exists: () => true,
      realpath: (p) => p,
      lstat: () => ({ isSymbolicLink: false, isFile: true, size: 10 * 1024 * 1024 + 1 }),
      readFile: () => {
        throw new Error('must not read')
      }
    }
    expect(refusal(() => readImageFile(join(project, 'huge.png'), roots, fs)).message).toMatch(/too large/)
  })
})

describe('resolveAllowedRoots', () => {
  const known = (paths: string[]) => ({
    exists: (p: string) => paths.includes(p),
    realpath: (p: string) => p
  })

  it('win32: project, worktrees, temp, Screenshots and OneDrive Screenshots; skips missing', () => {
    const repo = 'C:\\proj'
    const wt = 'C:\\wt\\a'
    const tmp = 'C:\\Temp'
    const shots = 'C:\\Users\\me\\Pictures\\Screenshots'
    const od = 'D:\\OD\\Pictures\\Screenshots'
    const input = {
      repoRoot: repo,
      worktrees: [wt, 'C:\\wt\\gone'],
      env: { USERPROFILE: 'C:\\Users\\me', OneDrive: 'D:\\OD' },
      platform: 'win32' as const,
      homeDir: 'C:\\Users\\other',
      tmpDir: tmp
    }
    expect(resolveAllowedRoots({ ...input, fs: known([repo, wt, tmp, shots, od]) })).toEqual([repo, wt, tmp, shots, od])
    expect(resolveAllowedRoots({ ...input, env: { USERPROFILE: 'C:\\Users\\me' }, fs: known([repo, tmp, shots, od]) })).toEqual([
      repo,
      tmp,
      shots
    ])
  })

  it('darwin: the screencapture location when set, else ~/Desktop', () => {
    const base = { repoRoot: '/r', worktrees: [], env: {}, platform: 'darwin' as const, homeDir: '/Users/me', tmpDir: '/tmp' }
    const all = ['/r', '/tmp', '/Users/me/Shots', '/Users/me/Desktop']
    expect(resolveAllowedRoots({ ...base, screencaptureLocation: '/Users/me/Shots', fs: known(all) })).toEqual([
      '/r',
      '/tmp',
      '/Users/me/Shots'
    ])
    expect(resolveAllowedRoots({ ...base, screencaptureLocation: null, fs: known(all) })).toEqual(['/r', '/tmp', '/Users/me/Desktop'])
  })

  it('linux: XDG_PICTURES_DIR/Screenshots, else ~/Pictures/Screenshots', () => {
    const base = { repoRoot: '/r', worktrees: [], platform: 'linux' as const, homeDir: '/home/me', tmpDir: '/tmp' }
    const all = ['/r', '/tmp', '/data/pics/Screenshots', '/home/me/Pictures/Screenshots']
    expect(resolveAllowedRoots({ ...base, env: { XDG_PICTURES_DIR: '/data/pics' }, fs: known(all) })).toEqual([
      '/r',
      '/tmp',
      '/data/pics/Screenshots'
    ])
    expect(resolveAllowedRoots({ ...base, env: {}, fs: known(all) })).toEqual(['/r', '/tmp', '/home/me/Pictures/Screenshots'])
  })
})
