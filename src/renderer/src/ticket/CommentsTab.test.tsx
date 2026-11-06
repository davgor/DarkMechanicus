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
