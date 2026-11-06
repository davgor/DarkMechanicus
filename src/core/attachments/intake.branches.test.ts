import { win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { captureError } from '../../test/authoring'
import { inspectImageBytes, resolveAllowedRoots } from './intake'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33)
  Buffer.from(PNG_SIGNATURE).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'latin1')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

/** SOI, then `lead` bytes, then a start-of-frame segment of 16 x 32 pixels. */
function jpeg(lead: number[]): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, ...lead, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03, 0x00, 0x00, 0x00])
}

describe('inspectImageBytes JPEG markers', () => {
  it('skips fill bytes before a marker', () => {
    expect(inspectImageBytes(jpeg([0xff]))).toEqual({ mime: 'image/jpeg', width: 32, height: 16 })
  })

  it('skips a standalone marker that carries no length', () => {
    expect(inspectImageBytes(jpeg([0x01]))).toEqual({ mime: 'image/jpeg', width: 32, height: 16 })
  })

  it('refuses a segment that is followed by something other than a marker', () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
    expect(captureError(() => inspectImageBytes(bytes)).message).toContain('a marker is malformed')
  })

  it('refuses a frame header that is cut short', () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00])
    expect(captureError(() => inspectImageBytes(bytes)).message).toContain('no frame header')
  })
})

describe('inspectImageBytes dimensions', () => {
  it('refuses an image with no pixels', () => {
    expect(captureError(() => inspectImageBytes(png(0, 30))).message).toContain('no pixels')
    expect(captureError(() => inspectImageBytes(png(40, 0))).message).toContain('no pixels')
  })
})

describe('resolveAllowedRoots on Windows', () => {
  const everything = { exists: () => true, realpath: (path: string) => path }
  const win = (path: string): string => win32.normalize(path)

  it('adds the OneDrive screenshot folder, and falls back to the home folder without USERPROFILE', () => {
    const roots = resolveAllowedRoots({
      repoRoot: 'C:/repo',
      worktrees: [],
      env: { OneDrive: 'C:/Users/me/OneDrive' },
      platform: 'win32',
      homeDir: 'C:/Users/me',
      tmpDir: 'C:/tmp',
      fs: everything
    })
    expect(roots).toEqual(['C:/repo', 'C:/tmp', 'C:/Users/me/Pictures/Screenshots', 'C:/Users/me/OneDrive/Pictures/Screenshots'].map((root, index) => (index < 2 ? root : win(root))))
  })

  it('lists a folder once however many ways it is named', () => {
    const roots = resolveAllowedRoots({
      repoRoot: 'C:/repo',
      worktrees: ['C:/repo'],
      env: { USERPROFILE: 'C:/Users/me' },
      platform: 'win32',
      homeDir: 'C:/Users/me',
      tmpDir: 'C:/repo',
      fs: everything
    })
    expect(roots.filter((root) => root === 'C:/repo')).toHaveLength(1)
  })
})
