import { afterEach, describe, expect, it } from 'vitest'
import { createStagedAttachment } from '../../core/services/attachments'
import { attachmentUrl } from '../../shared/desktop/attachmentUrl'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { pngBytes } from '../../test/images'
import { createAttachmentLookup, handleAttachmentRequest } from './attachmentProtocol'
import { createWorkspacePool, type WorkspacePool } from './workspacePool'

const FOLDER_KEY = '0123456789abcdef0123456789abcdef'
const UNKNOWN_KEY = 'ffffffffffffffffffffffffffffffff'
const UNKNOWN_ID = 'im_00000000000000000000000009'

interface Fixture {
  harness: Harness
  pool: WorkspacePool
  imageId: string
  png: Buffer
  fetch(folderKey: string, attachmentId: string): Response
}

/** A real workspace behind a pool, wired like `startAttachmentProtocol` in bootstrap.ts. */
async function setup(): Promise<Fixture> {
  const harness = createHarness()
  await harness.open('orchestrator').initializeRepository({ name: 'protocol-repo' })
  const pool = createWorkspacePool((root) => harness.open('desktop', { root }))
  const lookup = createAttachmentLookup({
    pathForKey: (key) => (key === FOLDER_KEY ? harness.root : null),
    contextFor: (path) => pool.get(path).ctx()
  })
  const png = pngBytes(12, 8, 3)
  const imageId = createStagedAttachment(pool.get(harness.root).ctx(), { bytes: png, label: 'shot', purpose: 'reference' }).id
  return {
    harness,
    pool,
    imageId,
    png,
    fetch: (folderKey, attachmentId) =>
      handleAttachmentRequest(new Request(attachmentUrl(folderKey, attachmentId)), lookup)
  }
}

describe('dm-attachment protocol against a real workspace', () => {
  let fixture: Fixture | undefined

  afterEach(() => {
    fixture?.pool.closeAll()
    fixture?.harness.cleanup()
    fixture = undefined
  })

  it('serves the stored PNG bytes as image/png through the pool', async () => {
    fixture = await setup()
    const response = fixture.fetch(FOLDER_KEY, fixture.imageId)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(fixture.png)
  })

  it('answers 404 for an unknown attachment id', async () => {
    fixture = await setup()
    expect(fixture.fetch(FOLDER_KEY, UNKNOWN_ID).status).toBe(404)
  })

  it('answers 404 for an unknown folder key', async () => {
    fixture = await setup()
    expect(fixture.fetch(UNKNOWN_KEY, fixture.imageId).status).toBe(404)
  })
})
