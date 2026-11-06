import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { jpegBytes, pngBytes } from '../../test/images'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { DomainError } from '../errors'

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
  await harness.open('orchestrator').initializeRepository({ name: 'upload-repo' })
})

afterEach(() => {
  harness.cleanup()
})

const desktop = () => harness.open('desktop', { transport: 'desktop' })

describe('uploadAttachment on the desktop transport', () => {
  it('stages a PNG as a reference labelled "Pasted image" by default', async () => {
    const bytes = pngBytes(640, 480)
    const view = await desktop().uploadAttachment({ data: bytes.toString('base64') })
    expect(view).toMatchObject({
      id: expect.stringMatching(/^im_/),
      mime: 'image/png',
      bytes: bytes.length,
      width: 640,
      height: 480,
      label: 'Pasted image',
      purpose: 'reference',
      owner: null
    })
  })

  it('stages a JPEG with the given label and purpose', async () => {
    const view = await desktop().uploadAttachment({
      data: jpegBytes(1200, 800).toString('base64'),
      label: 'mock.jpg',
      purpose: 'evidence'
    })
    expect(view).toMatchObject({ mime: 'image/jpeg', width: 1200, height: 800, label: 'mock.jpg', purpose: 'evidence' })
  })

  it('cuts a long label to the label limit', async () => {
    const view = await desktop().uploadAttachment({ data: pngBytes(4, 4).toString('base64'), label: 'x'.repeat(500) })
    expect(view.label).toHaveLength(200)
  })
})

describe('uploadAttachment refusals', () => {
  const data = () => pngBytes(10, 10).toString('base64')

  it.each(['cli', 'stdio', 'in_process'] as const)('refuses the %s transport', async (transport) => {
    const error = await failureOf(harness.open('worker', { transport }).uploadAttachment({ data: data() }))
    expect(error.code).toBe('unauthorized')
    expect(error.message).toMatch(/Only the desktop app uploads/)
  })

  it('refuses bytes that are not a PNG or JPEG', async () => {
    const error = await failureOf(desktop().uploadAttachment({ data: Buffer.from('hello, not an image').toString('base64') }))
    expect(error.code).toBe('invalid_input')
  })

  it('refuses a data: prefix', async () => {
    const error = await failureOf(desktop().uploadAttachment({ data: `data:image/png;base64,${data()}` }))
    expect(error.code).toBe('invalid_input')
  })

  it('refuses characters outside the base64 alphabet', async () => {
    const error = await failureOf(desktop().uploadAttachment({ data: `${data()}\n` }))
    expect(error.code).toBe('invalid_input')
  })

  it('refuses input over the cap', async () => {
    const error = await failureOf(desktop().uploadAttachment({ data: 'A'.repeat(13_981_017) }))
    expect(error.code).toBe('invalid_input')
  })

  it('refuses an unknown key such as a path', async () => {
    const input = { data: data(), path: '/etc/passwd' } as unknown as { data: string }
    const error = await failureOf(desktop().uploadAttachment(input))
    expect(error.code).toBe('invalid_input')
  })
})
