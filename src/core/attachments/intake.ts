import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import * as nodePath from 'node:path'
import { fail } from '../errors'

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_IMAGE_SIDE = 8000

type ImageMime = 'image/png' | 'image/jpeg'

interface ImageInspection {
  mime: ImageMime
  width: number
  height: number
}

interface ImageFile extends ImageInspection {
  bytes: Buffer
  sha256: string
}

/** The file system calls intake needs, injectable so tests do not depend on the machine. */
export interface ImageFs {
  exists(path: string): boolean
  realpath(path: string): string
  /** Stats the path itself (a link is not followed). */
  lstat(path: string): { isSymbolicLink: boolean; isFile: boolean; size: number }
  readFile(path: string): Buffer
}

const nodeImageFs: ImageFs = {
  exists: (path) => existsSync(path),
  realpath: (path) => realpathSync(path),
  lstat: (path) => {
    const stats = lstatSync(path)
    return { isSymbolicLink: stats.isSymbolicLink(), isFile: stats.isFile(), size: stats.size }
  },
  readFile: (path) => readFileSync(path)
}

interface AllowedRootsInput {
  repoRoot: string
  worktrees: readonly string[]
  env: Readonly<Record<string, string | undefined>>
  platform: NodeJS.Platform
  homeDir: string
  /** Defaults to `os.tmpdir()`. */
  tmpDir?: string
  /** macOS only: the `com.apple.screencapture location` default when readable, else null. */
  screencaptureLocation?: string | null
  fs?: Pick<ImageFs, 'exists' | 'realpath'>
}

function screenshotCandidates(input: AllowedRootsInput, path: typeof nodePath.posix): string[] {
  const { env, platform, homeDir } = input
  if (platform === 'win32') {
    const found = [path.join(env.USERPROFILE ?? homeDir, 'Pictures', 'Screenshots')]
    if (env.OneDrive) found.push(path.join(env.OneDrive, 'Pictures', 'Screenshots'))
    return found
  }
  if (platform === 'darwin') {
    const location = input.screencaptureLocation
    return [location && location.length > 0 ? location : path.join(homeDir, 'Desktop')]
  }
  const pictures = env.XDG_PICTURES_DIR
  return [pictures ? path.join(pictures, 'Screenshots') : path.join(homeDir, 'Pictures', 'Screenshots')]
}

/**
 * The folders an agent-supplied image path may live in: the project root, its worktrees, the
 * system temp folder and the OS screenshot folder. Folders that do not exist are skipped and the
 * rest are returned as real paths, de-duplicated. Path rules follow the injected platform.
 */
export function resolveAllowedRoots(input: AllowedRootsInput): string[] {
  const fs = input.fs ?? nodeImageFs
  const path = input.platform === 'win32' ? nodePath.win32 : nodePath.posix
  const candidates = [
    input.repoRoot,
    ...input.worktrees,
    input.tmpDir ?? tmpdir(),
    ...screenshotCandidates(input, path)
  ]
  const roots: string[] = []
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || !fs.exists(candidate)) continue
    let real: string
    try {
      real = fs.realpath(candidate)
    } catch {
      continue
    }
    if (!roots.includes(real)) roots.push(real)
  }
  return roots
}

/** For production callers: the real machine's environment. */
export function resolveAllowedRootsForMachine(repoRoot: string, worktrees: readonly string[]): string[] {
  return resolveAllowedRoots({ repoRoot, worktrees, env: process.env, platform: process.platform, homeDir: homedir() })
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function pngSize(bytes: Buffer): { width: number; height: number } {
  // Signature (8) + IHDR length (4) + "IHDR" (4) + width (4) + height (4).
  if (bytes.length < 24 || bytes.toString('latin1', 12, 16) !== 'IHDR') {
    fail('invalid_input', 'Image is not a valid PNG: the IHDR header is missing or truncated.')
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

const JPEG_NON_FRAME_C = new Set([0xc4, 0xc8, 0xcc])

function isJpegFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && !JPEG_NON_FRAME_C.has(marker)
}

/** Standalone markers carry no length. */
function isJpegStandalone(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)
}

function jpegSize(bytes: Buffer): { width: number; height: number } {
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      fail('invalid_input', 'Image is not a valid JPEG: a marker is malformed.')
    }
    const marker = bytes[offset + 1] as number
    if (marker === 0xff || isJpegStandalone(marker)) {
      offset += marker === 0xff ? 1 : 2
    } else if (isJpegFrame(marker) && offset + 9 <= bytes.length) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) }
    } else {
      offset += 2 + bytes.readUInt16BE(offset + 2)
    }
  }
  return fail('invalid_input', 'Image is not a valid JPEG: no frame header with dimensions was found.')
}

function tooLarge(size: number): never {
  return fail('invalid_input', `Image is too large: ${size} bytes exceeds the ${MAX_IMAGE_BYTES} byte (10 MiB) limit.`)
}

function detectMime(buffer: Buffer): ImageMime {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  return fail('invalid_input', 'Unsupported image type: only PNG and JPEG are accepted (SVG and other files are refused).')
}

function checkDimensions(width: number, height: number): void {
  if (width < 1 || height < 1) {
    fail('invalid_input', 'Image has no pixels: width and height must be at least 1.')
  }
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) {
    fail('invalid_input', `Image has too many pixels: ${width}x${height} exceeds ${MAX_IMAGE_SIDE} px on a side.`)
  }
}

/**
 * Decides the type by magic bytes (never the extension), parses width and height without a
 * dependency, and enforces the size and pixel limits. SVG and everything else is refused.
 */
export function inspectImageBytes(bytes: Uint8Array): ImageInspection {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buffer.length > MAX_IMAGE_BYTES) tooLarge(buffer.length)
  const mime = detectMime(buffer)
  const { width, height } = mime === 'image/png' ? pngSize(buffer) : jpegSize(buffer)
  checkDimensions(width, height)
  return { mime, width, height }
}

/**
 * Reads an agent-supplied image path. Refuses (invalid_input) a path outside every allowed root,
 * a symbolic link, a non-regular file, and anything `inspectImageBytes` refuses.
 */
export function readImageFile(path: string, roots: readonly string[], fs: ImageFs = nodeImageFs): ImageFile {
  const absolute = resolve(path)
  let linkInfo: ReturnType<ImageFs['lstat']>
  let real: string
  try {
    linkInfo = fs.lstat(absolute)
    real = fs.realpath(absolute)
  } catch {
    return fail('invalid_input', 'Image file cannot be read: it does not exist or is not accessible.')
  }
  if (linkInfo.isSymbolicLink) {
    fail('invalid_input', 'Image path is a symbolic link; attach the real file instead.')
  }
  if (!linkInfo.isFile) {
    fail('invalid_input', 'Image path is not a regular file.')
  }
  const realRoots = roots.map((root) => {
    try {
      return fs.realpath(root)
    } catch {
      return resolve(root)
    }
  })
  if (!realRoots.some((root) => isInside(root, real))) {
    fail('invalid_input', 'Image path is outside the allowed folders (project root, worktrees, temp folder, screenshot folder).')
  }
  if (linkInfo.size > MAX_IMAGE_BYTES) tooLarge(linkInfo.size)
  const bytes = fs.readFile(real)
  const inspection = inspectImageBytes(bytes)
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), ...inspection }
}
