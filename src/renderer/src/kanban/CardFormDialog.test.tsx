// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AttachmentRef } from '../../../shared/domain/views'
import type { Runner } from '../epic/runner'
import { cardView } from './__mocks__/fixtures'
import { CardFormDialog, type CardContent } from './CardFormDialog'

afterEach(cleanup)

const KEY = '00000000000000000000000000000001'

function ref(id: string, label: string): AttachmentRef {
  return { id, sha256: 'a'.repeat(64), mime: 'image/png', bytes: 1024, width: 800, height: 600, label, purpose: 'reference' }
}

const uploads: Runner = ((name: string, input: unknown) =>
  Promise.resolve(name === 'uploadAttachment' ? { id: 'im_00000000000000000000000009', label: (input as { label: string }).label } : {})) as unknown as Runner

function open(card?: Parameters<typeof cardView>[0]): { sent: CardContent[] } {
  const sent: CardContent[] = []
  render(
    <CardFormDialog
      card={card === undefined ? undefined : cardView(card)}
      runner={uploads}
      folderKey={KEY}
      onSubmit={(content) => {
        sent.push(content)
        return Promise.resolve()
      }}
      onClose={() => undefined}
    />
  )
  return { sent }
}

async function drop(name: string): Promise<void> {
  const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' })
  fireEvent.drop(screen.getByText(/Paste or drop/).parentElement as HTMLElement, { dataTransfer: { files: [file], types: ['Files'] } })
  await screen.findByRole('img', { name })
}

describe('CardFormDialog images', () => {
  it('sends an uploaded image and drops a removed existing one in the full attachments list', async () => {
    const { sent } = open({
      title: 'Card',
      attachments: [ref('im_00000000000000000000000001', 'first.png'), ref('im_00000000000000000000000002', 'second.png')]
    })
    const first = screen.getByRole('img', { name: 'first.png' }) as HTMLImageElement
    expect(first.getAttribute('src')).toBe(`dm-attachment://${KEY}/im_00000000000000000000000001`)
    fireEvent.click(screen.getByRole('button', { name: 'Remove first.png' }))
    expect(screen.queryByRole('img', { name: 'first.png' })).toBeNull()
    await drop('third.png')
    fireEvent.click(screen.getByRole('button', { name: 'Save card' }))
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]?.attachments).toEqual(['im_00000000000000000000000002', 'im_00000000000000000000000009'])
  })

  it('sends an empty list when every existing image is removed, and none when they are untouched', async () => {
    const one = open({ title: 'Card', attachments: [ref('im_00000000000000000000000001', 'first.png')] })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove first.png' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save card' }))
    await waitFor(() => expect(one.sent).toHaveLength(1))
    expect(one.sent[0]?.attachments).toEqual([])
    cleanup()
    const two = open({ title: 'Card', attachments: [ref('im_00000000000000000000000001', 'first.png')] })
    fireEvent.click(screen.getByRole('button', { name: 'Save card' }))
    await waitFor(() => expect(two.sent).toHaveLength(1))
    expect('attachments' in (two.sent[0] as object)).toBe(false)
  })

  it('attaches an image to a new card', async () => {
    const { sent } = open()
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New' } })
    await drop('mock.png')
    fireEvent.click(screen.getByRole('button', { name: 'Create card' }))
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]?.attachments).toEqual(['im_00000000000000000000000009'])
  })
})
