// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AttachmentGallery, type GalleryAttachment } from './AttachmentGallery'

afterEach(cleanup)

const FOLDER_KEY = '0123456789abcdef0123456789abcdef'

const SHOTS: GalleryAttachment[] = [
  { id: 'im_00000000000000000000000001', label: 'failing test', purpose: 'evidence', width: 800, height: 600 },
  { id: 'im_00000000000000000000000002', label: 'mockup', purpose: 'reference', width: 1200, height: 900 },
  { id: 'im_00000000000000000000000003', label: 'terminal', purpose: 'evidence', width: 640, height: 480 }
]

function gallery(attachments: readonly GalleryAttachment[] = SHOTS): JSX.Element {
  return <AttachmentGallery folderKey={FOLDER_KEY} attachments={attachments} />
}

function lightbox(): HTMLElement {
  return screen.getByRole('dialog', { name: /./ })
}

describe('AttachmentGallery thumbnails', () => {
  it('renders nothing for no attachments', () => {
    const { container } = render(gallery([]))
    expect(container.firstChild).toBeNull()
  })

  it('shows each image as a thumbnail with its label and purpose, addressed by folder key and id', () => {
    render(gallery())
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(3)
    const first = within(items[0] as HTMLElement)
    expect(first.getByText('Evidence')).toBeTruthy()
    expect(first.getByText('failing test')).toBeTruthy()
    const image = first.getByRole('img', { name: 'failing test' }) as HTMLImageElement
    expect(image.getAttribute('src')).toBe(`dm-attachment://${FOLDER_KEY}/im_00000000000000000000000001`)
    expect(within(items[1] as HTMLElement).getByText('Reference')).toBeTruthy()
  })
})

describe('AttachmentGallery lightbox', () => {
  it('opens at full size on click and closes with Escape', () => {
    render(gallery())
    fireEvent.click(screen.getByRole('button', { name: 'Open mockup' }))
    const open = lightbox()
    expect(within(open).getByText('mockup')).toBeTruthy()
    expect(within(open).getByText('2 / 3')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes from its close button', () => {
    render(gallery())
    fireEvent.click(screen.getByRole('button', { name: 'Open mockup' }))
    fireEvent.click(within(lightbox()).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('steps with the arrow keys and wraps at both ends', () => {
    render(gallery())
    fireEvent.click(screen.getByRole('button', { name: 'Open failing test' }))
    fireEvent.keyDown(document, { key: 'ArrowLeft' })
    expect(within(lightbox()).getByText('3 / 3')).toBeTruthy()
    expect(within(lightbox()).getByText('terminal')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(within(lightbox()).getByText('1 / 3')).toBeTruthy()
  })

  it('shows the full-size image with the same address as its thumbnail', () => {
    render(gallery())
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    const full = within(lightbox()).getByRole('img', { name: 'terminal' }) as HTMLImageElement
    expect(full.getAttribute('src')).toBe(`dm-attachment://${FOLDER_KEY}/im_00000000000000000000000003`)
  })
})

describe('AttachmentGallery missing images', () => {
  it('shows a placeholder with the label, and requests nothing, for a missing image', () => {
    const { container } = render(gallery([{ ...SHOTS[0], missing: true } as GalleryAttachment]))
    const placeholder = screen.getByRole('img', { name: 'failing test (image missing)' })
    expect(within(placeholder).getByText('failing test')).toBeTruthy()
    expect(within(placeholder).getByText('Image missing')).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
  })

  it('swaps a thumbnail for the placeholder when its image fails to load', () => {
    render(gallery([SHOTS[0] as GalleryAttachment]))
    fireEvent.error(screen.getByRole('img', { name: 'failing test' }))
    expect(screen.getByRole('img', { name: 'failing test (image missing)' })).toBeTruthy()
    expect(screen.queryByRole('img', { name: 'failing test' })).toBeNull()
  })
})

describe('AttachmentGallery lightbox edges', () => {
  it('ignores other keys, and closes only from a press on the backdrop itself', () => {
    render(gallery())
    fireEvent.click(screen.getByRole('button', { name: 'Open failing test' }))
    fireEvent.keyDown(document, { key: 'x' })
    expect(within(lightbox()).getByText('1 / 3')).toBeTruthy()
    fireEvent.mouseDown(lightbox())
    expect(screen.queryByRole('dialog', { name: /./ })).not.toBeNull()
    const backdrop = lightbox().parentElement as HTMLElement
    fireEvent.mouseDown(backdrop)
    expect(screen.queryByRole('dialog', { name: /./ })).toBeNull()
  })

  it('shows nothing when the open image is no longer in the list', () => {
    const { rerender } = render(gallery())
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    rerender(gallery([SHOTS[0] as GalleryAttachment]))
    expect(screen.queryByRole('dialog', { name: /./ })).toBeNull()
  })
})
