// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommentView } from '../../../shared/domain/views'
import { comment, NOW } from '../epic/__mocks__/fixtures'
import type { Runner } from '../epic/runner'
import { CommentsTab } from './CommentsTab'

afterEach(() => {
  cleanup()
})

const FOLDER_KEY = '0123456789abcdef0123456789abcdef'

function runnerOf(comments: CommentView[]): Runner {
  return ((name: string) => (name === 'listComments' ? Promise.resolve(comments) : Promise.reject(new Error(name)))) as unknown as Runner
}

function renderTab(comments: CommentView[]): void {
  render(<CommentsTab runner={runnerOf(comments)} epicId="ep_1" ticketId="tk_202" now={NOW} reloadKey={0} canComment folderKey={FOLDER_KEY} />)
}

describe('CommentsTab attachments', () => {
  it('shows the comment\'s images under its body, addressed by folder key', async () => {
    renderTab([
      comment(1, 5, {
        attachments: [
          { id: 'im_00000000000000000000000001', sha256: 'a'.repeat(64), mime: 'image/png', bytes: 1024, width: 800, height: 600, label: 'mockup', purpose: 'reference' }
        ]
      }),
      comment(2, 3)
    ])
    const items = await waitFor(() => {
      const found = screen.getAllByRole('listitem', { name: 'Comment by worker-a' })
      expect(found).toHaveLength(2)
      return found
    })
    const image = within(items[0] as HTMLElement).getByRole('img', { name: 'mockup' }) as HTMLImageElement
    expect(image.getAttribute('src')).toBe(`dm-attachment://${FOLDER_KEY}/im_00000000000000000000000001`)
    expect(within(items[1] as HTMLElement).queryByRole('img')).toBeNull()
  })
})

describe('CommentsTab image composer', () => {
  it('sends an uploaded image with the comment and clears it afterwards', async () => {
    const calls: { name: string; input: unknown }[] = []
    const runner = ((name: string, input: unknown) => {
      calls.push({ name, input })
      if (name === 'listComments') {
        return Promise.resolve([])
      }
      if (name === 'uploadAttachment') {
        return Promise.resolve({ id: 'im_00000000000000000000000007', label: 'shot.png' })
      }
      return Promise.resolve({})
    }) as unknown as Runner
    render(<CommentsTab runner={runner} epicId="ep_1" ticketId="tk_202" now={NOW} reloadKey={0} canComment folderKey={FOLDER_KEY} />)

    fireEvent.change(screen.getByLabelText('New comment'), { target: { value: 'See the screenshot' } })
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', { type: 'image/png' })
    fireEvent.drop(screen.getByLabelText('New comment'), { dataTransfer: { files: [file], types: ['Files'] } })
    const preview = (await screen.findByRole('img', { name: 'shot.png' })) as HTMLImageElement
    expect(preview.getAttribute('src')).toBe(`dm-attachment://${FOLDER_KEY}/im_00000000000000000000000007`)

    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }))
    await waitFor(() => expect(calls.some((call) => call.name === 'addComment')).toBe(true))
    expect(calls.find((call) => call.name === 'addComment')?.input).toEqual({
      epicId: 'ep_1',
      ticketId: 'tk_202',
      body: 'See the screenshot',
      attachments: ['im_00000000000000000000000007']
    })
    await waitFor(() => expect(screen.queryByRole('img', { name: 'shot.png' })).toBeNull())
  })

  it('sends no attachments key when nothing was uploaded', async () => {
    const calls: { name: string; input: unknown }[] = []
    const runner = ((name: string, input: unknown) => {
      calls.push({ name, input })
      return Promise.resolve(name === 'listComments' ? [] : {})
    }) as unknown as Runner
    render(<CommentsTab runner={runner} epicId="ep_1" ticketId="tk_202" now={NOW} reloadKey={0} canComment folderKey={FOLDER_KEY} />)
    fireEvent.change(screen.getByLabelText('New comment'), { target: { value: 'Plain' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }))
    await waitFor(() => expect(calls.some((call) => call.name === 'addComment')).toBe(true))
    expect(calls.find((call) => call.name === 'addComment')?.input).toEqual({ epicId: 'ep_1', ticketId: 'tk_202', body: 'Plain' })
  })
})

function dropImage(name: string): void {
  const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' })
  fireEvent.drop(screen.getByLabelText('New comment'), { dataTransfer: { files: [file], types: ['Files'] } })
}

/** A runner that records every call and answers each upload through `upload`. */
function recordingRunner(calls: { name: string; input: unknown }[], upload: () => Promise<unknown>): Runner {
  return ((name: string, input: unknown) => {
    calls.push({ name, input })
    if (name === 'listComments') {
      return Promise.resolve([])
    }
    return name === 'uploadAttachment' ? upload() : Promise.resolve({})
  }) as unknown as Runner
}

function renderComposer(runner: Runner): void {
  render(<CommentsTab runner={runner} epicId="ep_1" ticketId="tk_202" now={NOW} reloadKey={0} canComment folderKey={FOLDER_KEY} />)
}

describe('CommentsTab composer uploads', () => {
  it('disables Add comment while an image uploads', async () => {
    let finish: ((view: { id: string; label: string }) => void) | null = null
    renderComposer(
      recordingRunner([], () =>
        new Promise((resolve) => {
          finish = resolve
        })
      )
    )

    fireEvent.change(screen.getByLabelText('New comment'), { target: { value: 'Uploading one' } })
    const button = screen.getByRole('button', { name: 'Add comment' })
    expect(button).toHaveProperty('disabled', false)
    dropImage('slow.png')
    await waitFor(() => expect(button).toHaveProperty('disabled', true))

    // The upload starts only once the file is read, after the button already went busy.
    const resolveUpload = await waitFor(() => {
      expect(finish).not.toBeNull()
      return finish as (view: { id: string; label: string }) => void
    })
    resolveUpload({ id: 'im_00000000000000000000000008', label: 'slow.png' })
    await screen.findByRole('img', { name: 'slow.png' })
    await waitFor(() => expect(button).toHaveProperty('disabled', false))
  })

  it('does not bring back a sent image with the next upload', async () => {
    const calls: { name: string; input: unknown }[] = []
    const uploads = [
      { id: 'im_0000000000000000000000000a', label: 'a.png' },
      { id: 'im_0000000000000000000000000b', label: 'b.png' }
    ]
    renderComposer(recordingRunner(calls, () => Promise.resolve(uploads.shift())))
    const sent = (): unknown[] => calls.filter((call) => call.name === 'addComment').map((call) => call.input)

    fireEvent.change(screen.getByLabelText('New comment'), { target: { value: 'First' } })
    dropImage('a.png')
    await screen.findByRole('img', { name: 'a.png' })
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }))
    await waitFor(() => expect(sent()).toHaveLength(1))
    await waitFor(() => expect(screen.queryByRole('img', { name: 'a.png' })).toBeNull())

    fireEvent.change(screen.getByLabelText('New comment'), { target: { value: 'Second' } })
    dropImage('b.png')
    await screen.findByRole('img', { name: 'b.png' })
    expect(screen.queryByRole('img', { name: 'a.png' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }))
    await waitFor(() => expect(sent()).toHaveLength(2))
    expect(sent()[1]).toEqual({ epicId: 'ep_1', ticketId: 'tk_202', body: 'Second', attachments: ['im_0000000000000000000000000b'] })
    expect(screen.queryByRole('img', { name: 'a.png' })).toBeNull()
  })
})
