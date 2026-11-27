// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AttachmentRef } from '../../../shared/domain/views'
import { FakeBackend, scenario } from '../epic/__mocks__/fakeBackend'
import { bundle, ticket, ticketDetail } from '../epic/__mocks__/fixtures'
import { OverviewTab } from './panelTabs'

afterEach(() => {
  cleanup()
})

const FOLDER_KEY = '0123456789abcdef0123456789abcdef'

const MOCKUP: AttachmentRef = {
  id: 'im_00000000000000000000000001',
  sha256: 'a'.repeat(64),
  mime: 'image/png',
  bytes: 1024,
  width: 800,
  height: 600,
  label: 'login mockup',
  purpose: 'reference'
}

function renderOverview(patch: Parameters<typeof ticket>[2]): void {
  const detail = ticketDetail({ ticket: ticket('DM-202', 'Build the login', patch) })
  render(
    <OverviewTab
      detail={detail}
      bundle={bundle()}
      runner={new FakeBackend(scenario()).runner}
      folderKey={FOLDER_KEY}
      onSelect={() => undefined}
    />
  )
}

describe('OverviewTab ticket materials', () => {
  it('shows the ticket images, references and expected artifacts', () => {
    renderOverview({
      attachments: [MOCKUP],
      references: [
        { kind: 'file', label: 'login form', location: 'src/login.tsx', hash: null, remoteOnly: false },
        { kind: 'file', label: 'src/auth.ts', location: 'src/auth.ts', hash: null, remoteOnly: false },
        { kind: 'url', label: 'Design doc', location: 'https://example.test/design', hash: null, remoteOnly: true }
      ],
      expectedArtifacts: ['src/login.test.tsx']
    })
    const images = screen.getByRole('region', { name: 'Attachments' })
    const picture = within(images).getByAltText('login mockup')
    expect(picture.getAttribute('src')).toContain(FOLDER_KEY)
    expect(picture.getAttribute('src')).toContain(MOCKUP.id)
    expect(within(images).getByText('Reference')).toBeTruthy()
    const references = screen.getByRole('region', { name: 'References' })
    expect(within(references).getByText('login form (src/login.tsx)')).toBeTruthy()
    expect(within(references).getByText('src/auth.ts')).toBeTruthy()
    expect(within(references).getByRole('link', { name: 'Design doc (https://example.test/design)' }).getAttribute('href')).toBe('https://example.test/design')
    expect(within(references).getAllByRole('link')).toHaveLength(1)
    expect(within(references).getByText('login form (src/login.tsx)').closest('a')).toBeNull()
    expect(within(references).getByText('src/auth.ts').closest('a')).toBeNull()
    const artifacts = screen.getByRole('region', { name: 'Expected artifacts' })
    expect(within(artifacts).getByText('src/login.test.tsx')).toBeTruthy()
  })

  it('shows none of the sections for a ticket without them', () => {
    renderOverview({ attachments: undefined, references: [], expectedArtifacts: [] })
    expect(screen.queryByRole('region', { name: 'Attachments' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'References' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Expected artifacts' })).toBeNull()
  })
})

describe('OverviewTab delivery of an acceptance node', () => {
  const DELIVERY = { target: 'main', release: true, verifyInstalled: true }

  function renderNode(kind: 'acceptance' | undefined, delivery: typeof DELIVERY | undefined): void {
    const plan = bundle()
    const sprints = plan.sprints.map((sprint) => (sprint.ordinal === 2 && delivery !== undefined ? { ...sprint, delivery } : sprint))
    const detail = ticketDetail({ ticket: ticket('DM-202', 'Sprint 2 acceptance', { kind }) })
    render(
      <OverviewTab
        detail={detail}
        bundle={{ ...plan, sprints }}
        runner={new FakeBackend(scenario()).runner}
        folderKey={FOLDER_KEY}
        onSelect={() => undefined}
      />
    )
  }

  it('shows the declared delivery on the acceptance node of a delivering sprint', () => {
    renderNode('acceptance', DELIVERY)
    const section = screen.getByRole('region', { name: 'Delivery' })
    expect(within(section).getByText('Delivery verification: after the checkpoint → main · release · verify installed')).toBeTruthy()
  })

  it('shows no delivery on an acceptance node of a sprint that declares none', () => {
    renderNode('acceptance', undefined)
    expect(screen.queryByRole('region', { name: 'Delivery' })).toBeNull()
  })

  it('shows no delivery on a regular ticket of a delivering sprint', () => {
    renderNode(undefined, DELIVERY)
    expect(screen.queryByRole('region', { name: 'Delivery' })).toBeNull()
  })
})
