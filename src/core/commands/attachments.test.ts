import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AttachmentFileView } from '../../shared/domain/views'
import { jpegBytes, pngBytes } from '../../test/images'
import { createFakeGit, createHarness, type Harness } from '../../test/workspaceHarness'
import { DomainError } from '../errors'

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function failureOf(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise
  } catch (error: unknown) {
    if (error instanceof DomainError) {
      return error
    }
    throw error
  }
  throw new Error('Expected the command to fail.')
}

let harness: Harness

beforeEach(async () => {
  harness = createHarness()
  await harness.open('orchestrator').initializeRepository({ name: 'attachment-repo' })
})

afterEach(() => {
  harness.cleanup()
})

describe('adding an image', () => {
  it('stages an image from the project root with the type and size read from the file', async () => {
    const bytes = pngBytes(640, 480)
    writeFileSync(join(harness.root, 'shot.png'), bytes)
    const agent = harness.open('worker')

    const view = await agent.addAttachment({ path: join(harness.root, 'shot.png'), label: 'Login screen', purpose: 'evidence' })

    expect(view).toMatchObject({
      id: expect.stringMatching(/^im_/),
      sha256: sha256Of(bytes),
      mime: 'image/png',
      bytes: bytes.length,
      width: 640,
      height: 480,
      label: 'Login screen',
      purpose: 'evidence',
      owner: null,
      missing: false,
      createdBy: { role: 'worker', label: 'worker session' }
    })
    expect(await agent.getAttachment({ attachmentId: view.id, as: 'metadata' })).toEqual(view)
  })

  it('accepts a JPEG and reads its dimensions from the file', async () => {
    writeFileSync(join(harness.root, 'mock.jpg'), jpegBytes(1200, 800))
    const view = await harness.open('planner').addAttachment({ path: join(harness.root, 'mock.jpg'), label: 'Mockup', purpose: 'reference' })
    expect(view).toMatchObject({ mime: 'image/jpeg', width: 1200, height: 800, purpose: 'reference' })
  })

  it('accepts a path written with forward slashes', async () => {
    writeFileSync(join(harness.root, 'fwd.png'), pngBytes(10, 20))
    const forward = join(harness.root, 'fwd.png').replace(/\\/g, '/')
    const view = await harness.open('worker').addAttachment({ path: forward, label: 'Forward slashes', purpose: 'evidence' })
    expect(view).toMatchObject({ width: 10, height: 20 })
  })

})

describe('refusals', () => {
  it('refuses the desktop transport', async () => {
    writeFileSync(join(harness.root, 'desk.png'), pngBytes(10, 10))
    const desktop = harness.open('desktop', { transport: 'desktop' })
    const error = await failureOf(desktop.addAttachment({ path: join(harness.root, 'desk.png'), label: 'Desk', purpose: 'evidence' }))
    expect(error.code).toBe('unauthorized')
    expect(error.message).toMatch(/desktop app does not add attachments/)
  })

  it('refuses a path outside the allowed folders', async () => {
    const outside = mkdtempSync(join(homedir(), 'dm-attach-outside-'))
    try {
      writeFileSync(join(outside, 'secret.png'), pngBytes(10, 10))
      const error = await failureOf(
        harness.open('worker').addAttachment({ path: join(outside, 'secret.png'), label: 'Outside', purpose: 'evidence' })
      )
      expect(error.code).toBe('invalid_input')
      expect(error.message).toMatch(/outside the allowed folders/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

})

describe('worktrees, file types and sessions', () => {
  it('accepts a file in a worktree the Git adapter lists', async () => {
    const worktree = mkdtempSync(join(homedir(), 'dm-attach-worktree-'))
    try {
      writeFileSync(join(worktree, 'wt.png'), pngBytes(30, 40))
      const git = { ...createFakeGit({ branch: 'main', commit: 'a'.repeat(40), detached: false }), listWorktrees: async () => [worktree] }
      const view = await harness.open('worker', { git }).addAttachment({ path: join(worktree, 'wt.png'), label: 'Worktree', purpose: 'evidence' })
      expect(view).toMatchObject({ width: 30, height: 40 })
    } finally {
      rmSync(worktree, { recursive: true, force: true })
    }
  })

  it('refuses an SVG or any other non-image file', async () => {
    writeFileSync(join(harness.root, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>')
    const error = await failureOf(
      harness.open('worker').addAttachment({ path: join(harness.root, 'icon.svg'), label: 'Icon', purpose: 'reference' })
    )
    expect(error.code).toBe('invalid_input')
    expect(error.message).toMatch(/Unsupported image type/)
  })

  it('refuses a session without attachment.write', async () => {
    writeFileSync(join(harness.root, 'reader.png'), pngBytes(10, 10))
    const error = await failureOf(
      harness.open('reader').addAttachment({ path: join(harness.root, 'reader.png'), label: 'Reader', purpose: 'evidence' })
    )
    expect(error.code).toBe('unauthorized')
  })

})

describe('reading an image', () => {
  it('writes a byte-identical copy as a file and returns its path', async () => {
    const bytes = pngBytes(64, 32)
    writeFileSync(join(harness.root, 'copy.png'), bytes)
    const agent = harness.open('worker')
    const view = await agent.addAttachment({ path: join(harness.root, 'copy.png'), label: 'Copy', purpose: 'evidence' })

    const file = (await agent.getAttachment({ attachmentId: view.id, as: 'file' })) as AttachmentFileView

    expect(file.path).toMatch(/darkmechanicus-attachments/)
    expect(file.path.endsWith(`${view.sha256}.png`)).toBe(true)
    expect(readFileSync(file.path).equals(bytes)).toBe(true)
    expect(file).toMatchObject({ id: view.id, sha256: view.sha256, width: 64, height: 32 })

    // A second request reuses the same copy.
    const again = await agent.getAttachment({ attachmentId: view.id, as: 'file' })
    expect((again as { path: string }).path).toBe(file.path)
    unlinkSync(file.path)
  })

  it('returns the metadata alone for as metadata', async () => {
    writeFileSync(join(harness.root, 'meta.png'), pngBytes(5, 6))
    const agent = harness.open('worker')
    const view = await agent.addAttachment({ path: join(harness.root, 'meta.png'), label: 'Meta', purpose: 'evidence' })
    const metadata = await agent.getAttachment({ attachmentId: view.id, as: 'metadata' })
    expect(metadata).not.toHaveProperty('path')
  })

})

describe('pruning staged images', () => {
  it('prunes a staged image older than seven days when a workspace opens', async () => {
    writeFileSync(join(harness.root, 'old.png'), pngBytes(10, 10))
    writeFileSync(join(harness.root, 'fresh.png'), pngBytes(11, 11))
    const agent = harness.open('worker')
    const old = await agent.addAttachment({ path: join(harness.root, 'old.png'), label: 'Old', purpose: 'evidence' })

    harness.clock.advanceSeconds(8 * 24 * 60 * 60)
    const fresh = await agent.addAttachment({ path: join(harness.root, 'fresh.png'), label: 'Fresh', purpose: 'evidence' })

    // Opening another session on the project runs the prune.
    harness.open('reviewer')

    const gone = await failureOf(agent.getAttachment({ attachmentId: old.id, as: 'metadata' }))
    expect(gone.code).toBe('not_found')
    expect(await agent.getAttachment({ attachmentId: fresh.id, as: 'metadata' })).toMatchObject({ id: fresh.id })
  })
})
