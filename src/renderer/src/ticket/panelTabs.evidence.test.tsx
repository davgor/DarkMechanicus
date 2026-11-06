// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentRef } from '../../../shared/domain/views'
import { EvidenceSections } from './panelTabs'
import type { EvidenceView } from './ticketView'

afterEach(() => {
  cleanup()
})

const FOLDER_KEY = '0123456789abcdef0123456789abcdef'

const SHOT: AttachmentRef = {
  id: 'im_00000000000000000000000001',
  sha256: 'a'.repeat(64),
  mime: 'image/png',
  bytes: 1024,
  width: 800,
  height: 600,
  label: 'failing test',
  purpose: 'evidence'
}

function evidence(patch: Partial<EvidenceView> = {}): EvidenceView {
  return {
    source: 'From attempt #2',
    checks: [],
    criteria: [],
    notes: '',
    attachments: [],
    artifacts: [],
    ...patch
  }
}

describe('EvidenceSections attachments', () => {
  it('shows the gallery with thumbnails addressed by folder key when the attempt attached images', () => {
    render(<EvidenceSections evidence={evidence({ attachments: [SHOT] })} folderKey={FOLDER_KEY} />)
    const section = screen.getByRole('region', { name: 'Attachments' })
    const image = within(section).getByRole('img', { name: 'failing test' }) as HTMLImageElement
    expect(image.getAttribute('src')).toBe(`dm-attachment://${FOLDER_KEY}/im_00000000000000000000000001`)
    fireEvent.click(within(section).getByRole('button', { name: 'Open failing test' }))
    expect(screen.getByRole('dialog', { name: 'failing test' })).toBeTruthy()
  })

  it('shows no attachments section when the attempt attached none', () => {
    render(<EvidenceSections evidence={evidence()} folderKey={FOLDER_KEY} />)
    expect(screen.queryByRole('region', { name: 'Attachments' })).toBeNull()
    expect(screen.queryByRole('list', { name: 'Attachments' })).toBeNull()
  })
})

describe('EvidenceSections artifacts', () => {
  it('lists each artifact label, with http and https locations as links and other locations as text', () => {
    const openExternal = vi.fn(() => Promise.resolve(true))
    window.dm = { openExternal } as unknown as typeof window.dm
    render(
      <EvidenceSections
        evidence={evidence({
          artifacts: [
            { label: 'Design doc', location: 'https://example.com/doc', hash: null, remoteOnly: true },
            { label: 'Patch', location: 'src/core/patch.ts', hash: null, remoteOnly: false }
          ]
        })}
        folderKey={FOLDER_KEY}
      />
    )
    const section = screen.getByRole('region', { name: 'Artifacts' })
    expect(within(section).getByText('Design doc')).toBeTruthy()
    expect(within(section).getByText('Patch')).toBeTruthy()
    const link = within(section).getByRole('link', { name: 'https://example.com/doc' })
    expect(within(section).queryByRole('link', { name: 'src/core/patch.ts' })).toBeNull()
    expect(within(section).getByText('src/core/patch.ts')).toBeTruthy()
    fireEvent.click(link)
    expect(openExternal).toHaveBeenCalledWith('https://example.com/doc')
  })

  it('shows no artifacts section when the attempt named none', () => {
    render(<EvidenceSections evidence={evidence()} folderKey={FOLDER_KEY} />)
    expect(screen.queryByRole('region', { name: 'Artifacts' })).toBeNull()
  })
})
