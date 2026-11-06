// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AttachmentRef } from '../../../shared/domain/views'
import { installDomShims } from '../epic/__mocks__/domShims'
import { FakeBackend, scenario } from '../epic/__mocks__/fakeBackend'
import { bundle as planBundle, draftPlan, epicDetail } from '../epic/__mocks__/fixtures'
import { renderWorkspace } from '../epic/__mocks__/renderWorkspace'
import { allowSlowRendering } from '../epic/__mocks__/testTiming'

allowSlowRendering()

beforeAll(() => {
  installDomShims()
})

afterEach(() => {
  cleanup()
})

const FOLDER_KEY = '00000000000000000000000000000001'

function ref(id: string, label: string): AttachmentRef {
  return { id, sha256: 'a'.repeat(64), mime: 'image/png', bytes: 1024, width: 800, height: 600, label, purpose: 'reference' }
}

/** The sample draft with two reference images on DM-202. */
function draftWithImages() {
  const draft = draftPlan()
  const tickets = draft.bundle.tickets.map((item) =>
    item.id === 'tk_202' ? { ...item, attachments: [ref('im_00000000000000000000000001', 'mock.png'), ref('im_00000000000000000000000002', 'flow.png')] } : item
  )
  return { ...draft, bundle: planBundle({ ...draft.bundle, tickets }) }
}

async function openEditor(): Promise<{ backend: FakeBackend; editor: HTMLElement }> {
  const backend = new FakeBackend(scenario({ epic: epicDetail({ hasDraft: true }), draft: draftWithImages() }))
  backend.handlers.uploadAttachment = (input) => ({ id: 'im_00000000000000000000000009', label: (input as { label: string }).label })
  renderWorkspace(backend)
  fireEvent.click(await screen.findByRole('button', { name: 'View draft' }))
  fireEvent.click(await screen.findByText('Transactional bundle import'))
  return { backend, editor: await screen.findByLabelText('Edit ticket DM-202') }
}

function patchesOf(backend: FakeBackend): unknown[] {
  return backend.inputs('updatePlanDraft').flatMap((input) => (input as { ops: { patch?: unknown }[] }).ops.map((op) => op.patch))
}

describe('ticket editor images', () => {
  it('renders the existing images by folder key and shows an uploaded one beside them', async () => {
    const { editor } = await openEditor()
    const mock = within(editor).getByRole('img', { name: 'mock.png' }) as HTMLImageElement
    expect(mock.getAttribute('src')).toBe(`dm-attachment://${FOLDER_KEY}/im_00000000000000000000000001`)
    expect(within(editor).getByRole('img', { name: 'flow.png' })).toBeTruthy()
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'new.png', { type: 'image/png' })
    fireEvent.drop(within(editor).getByText(/Paste or drop/).parentElement as HTMLElement, { dataTransfer: { files: [file], types: ['Files'] } })
    expect(await within(editor).findByRole('img', { name: 'new.png' })).toBeTruthy()
    expect(within(editor).getByText('Unapplied edits')).toBeTruthy()
  })

  it('applies the full list with an upload added and one image removed, in the update_ticket patch', async () => {
    const { backend, editor } = await openEditor()
    fireEvent.click(within(editor).getByRole('button', { name: 'Remove mock.png' }))
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'new.png', { type: 'image/png' })
    fireEvent.drop(within(editor).getByText(/Paste or drop/).parentElement as HTMLElement, { dataTransfer: { files: [file], types: ['Files'] } })
    await within(editor).findByRole('img', { name: 'new.png' })
    fireEvent.click(within(editor).getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(backend.inputs('updatePlanDraft')).toHaveLength(1))
    expect(patchesOf(backend)).toEqual([{ attachments: ['im_00000000000000000000000002', 'im_00000000000000000000000009'] }])
  })
})
