// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
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
