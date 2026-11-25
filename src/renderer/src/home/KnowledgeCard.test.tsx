// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import type { KnowledgeStatusView } from '../../../shared/desktop/api'
import { folderView, knowledgeStatus } from '../__mocks__/fixtures'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { ToastProvider } from '../app/toasts'
import { KnowledgeCard } from './KnowledgeCard'

let dm: FakeDm

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
})

afterEach(cleanup)

const folder = folderView({ path: '/a', name: 'alpha' })

async function renderCard(): Promise<void> {
  render(
    <ToastProvider scheduler={new ManualScheduler()}>
      <KnowledgeCard folder={folder} onOpenLearnings={() => undefined} />
    </ToastProvider>
  )
  await settle()
}

const card = (): HTMLElement => screen.getByRole('region', { name: 'Knowledge' })
/** The value of the row labelled `label`. */
const row = (label: string): string | null =>
  within(card()).getByText(label, { selector: 'dt' }).nextElementSibling?.textContent ?? null
const methods = (): string[] => dm.knowledgeCalls.map((call) => call.method)

describe('KnowledgeCard', () => {
  it('shows Not set with a Choose button and the folder layer counts', async () => {
    await renderCard()
    expect(dm.knowledgeCalls[0]).toEqual({ method: 'knowledgeStatus', args: ['/a'] })
    expect(row('Overall repo')).toBe('Not set')
    expect(row('Built-in')).toBe('3 facts')
    expect(row('Overall')).toBe('0 facts')
    expect(row('This folder')).toBe('0 facts')
    expect(within(card()).queryByText('Branch')).toBeNull()
    expect(within(card()).getByRole('button', { name: 'Choose…' })).toBeTruthy()
    expect(within(card()).queryByRole('button', { name: 'Clear' })).toBeNull()
  })

  it('shows the overall repository path, branch, ahead/behind, dirty state and per-layer counts once set', async () => {
    dm.knowledge = knowledgeStatus({
      layers: {
        builtin: { count: 2 },
        overall: { configured: true, path: '/k/team-knowledge', count: 5 },
        repo: { path: '/a/.darkmechanicus/knowledge', count: 1 }
      },
      git: { state: 'ok', branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, dirty: true }
    })
    await renderCard()
    expect(row('Overall repo')).toBe('/k/team-knowledge')
    expect(row('Branch')).toBe('main')
    expect(row('Sync')).toBe('2 ahead · 1 behind origin/main')
    expect(row('Changes')).toBe('Uncommitted changes')
    expect(row('Built-in')).toBe('2 facts')
    expect(row('Overall')).toBe('5 facts')
    expect(row('This folder')).toBe('1 fact')
    expect(within(card()).getByRole('button', { name: 'Change…' })).toBeTruthy()
  })

  it('says why Git could not be read, and a clean repository with no upstream', async () => {
    dm.knowledge = knowledgeStatus({
      layers: { ...knowledgeStatus().layers, overall: { configured: true, path: '/k', count: 0 } },
      git: { state: 'unavailable', reason: 'The folder is not a Git repository.' }
    })
    await renderCard()
    expect(row('Git')).toBe('The folder is not a Git repository.')
    cleanup()

    dm.knowledge.git = { state: 'ok', branch: null, upstream: null, ahead: 0, behind: 0, dirty: false }
    await renderCard()
    expect(row('Branch')).toBe('detached HEAD')
    expect(row('Sync')).toBe('No upstream')
    expect(row('Changes')).toBe('Clean')
  })
})

describe('KnowledgeCard diagnostics', () => {
  it('lists diagnostics in a collapsible section', async () => {
    dm.knowledge = knowledgeStatus({
      diagnostics: [
        { layer: 'repo', path: '.darkmechanicus/knowledge/broken.md', message: 'missing frontmatter' },
        { layer: 'overall', path: '/k/knowledge', message: 'knowledge folder does not exist' }
      ]
    })
    await renderCard()
    const details = within(card()).getByRole('group', { name: 'Knowledge diagnostics' })
    expect(details.tagName).toBe('DETAILS')
    expect(details.hasAttribute('open')).toBe(false)
    expect(within(details).getByText('2 diagnostics')).toBeTruthy()
    const items = within(details).getAllByRole('listitem').map((item) => item.textContent)
    expect(items).toEqual([
      'This folder .darkmechanicus/knowledge/broken.md: missing frontmatter',
      'Overall /k/knowledge: knowledge folder does not exist'
    ])
  })

  it('shows no diagnostics section when there are none', async () => {
    await renderCard()
    expect(within(card()).queryByRole('group', { name: 'Knowledge diagnostics' })).toBeNull()
  })

  it('says diagnostic in the singular for one', async () => {
    dm.knowledge = knowledgeStatus({ diagnostics: [{ layer: 'repo', path: 'broken.md', message: 'missing frontmatter' }] })
    await renderCard()
    expect(within(card()).getByRole('group', { name: 'Knowledge diagnostics' }).querySelector('summary')?.textContent).toBe(
      '1 diagnostic'
    )
  })
})

describe('KnowledgeCard sync and loading', () => {
  it('says up to date when the repository is neither ahead nor behind its upstream', async () => {
    dm.knowledge = knowledgeStatus({
      layers: { ...knowledgeStatus().layers, overall: { configured: true, path: '/k', count: 0 } },
      git: { state: 'ok', branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, dirty: false }
    })
    await renderCard()
    expect(row('Sync')).toBe('Up to date with origin/main')
  })

  it('reports a status that cannot be read and keeps showing Loading with Choose disabled', async () => {
    dm.knowledgeStatus = () => Promise.reject(new Error('The knowledge folder is unreadable.'))
    await renderCard()
    expect(screen.getByRole('alert').textContent).toContain('The knowledge folder is unreadable.')
    expect(within(card()).getByText('Loading knowledge…')).toBeTruthy()
    expect((within(card()).getByRole('button', { name: 'Choose…' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('KnowledgeCard folder switch', () => {
  it('ignores a late answer or failure for the folder shown before', async () => {
    // Each status request, oldest first; the renderer's lib (ES2022) has no Promise.withResolvers.
    const requests: { path: string; resolve: (status: KnowledgeStatusView) => void; reject: (error: Error) => void }[] = []
    dm.knowledgeStatus = (path) =>
      new Promise((resolve, reject) => {
        requests.push({ path, resolve, reject })
      })
    const scheduler = new ManualScheduler()
    const tree = (path: string): JSX.Element => (
      <ToastProvider scheduler={scheduler}>
        <KnowledgeCard folder={folderView({ path, name: path })} onOpenLearnings={() => undefined} />
      </ToastProvider>
    )
    const withRepoCount = (count: number): KnowledgeStatusView =>
      knowledgeStatus({ layers: { ...knowledgeStatus().layers, repo: { path: '/k', count } } })
    const { rerender } = render(tree('/a'))
    rerender(tree('/b'))
    await settle()
    expect(requests.map((request) => request.path)).toEqual(['/a', '/b'])

    requests[1].resolve(withRepoCount(4))
    await settle()
    requests[0].resolve(withRepoCount(9))
    await settle()
    expect(row('This folder')).toBe('4 facts')

    rerender(tree('/a'))
    rerender(tree('/b'))
    await settle()
    expect(requests.map((request) => request.path)).toEqual(['/a', '/b', '/a', '/b'])
    requests[2].reject(new Error('stale failure'))
    requests[3].resolve(withRepoCount(4))
    await settle()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(row('This folder')).toBe('4 facts')
  })
})

describe('KnowledgeCard choose and clear', () => {
  it('chooses a repository and shows it, then clears it', async () => {
    dm.knowledgeChooseOutcomes = [{ outcome: 'set', repository: '/k/team-knowledge' }]
    await renderCard()

    fireEvent.click(within(card()).getByRole('button', { name: 'Choose…' }))
    await settle()
    expect(methods()).toEqual(['knowledgeStatus', 'chooseKnowledgeRepository', 'knowledgeStatus'])
    expect(row('Overall repo')).toBe('/k/team-knowledge')

    fireEvent.click(within(card()).getByRole('button', { name: 'Clear' }))
    await settle()
    expect(methods().slice(3)).toEqual(['clearKnowledgeRepository', 'knowledgeStatus'])
    expect(row('Overall repo')).toBe('Not set')
  })

  it('shows the refusal for a folder that is not a Git work tree and keeps Not set', async () => {
    dm.knowledgeChooseOutcomes = [{ outcome: 'refused', reason: '/tmp/plain is not a Git work tree. Choose the folder of a cloned repository.' }]
    await renderCard()

    fireEvent.click(within(card()).getByRole('button', { name: 'Choose…' }))
    await settle()

    expect(within(card()).getByRole('alert').textContent).toBe(
      '/tmp/plain is not a Git work tree. Choose the folder of a cloned repository.'
    )
    expect(row('Overall repo')).toBe('Not set')
  })

  it('changes nothing when the picker is cancelled', async () => {
    await renderCard()
    fireEvent.click(within(card()).getByRole('button', { name: 'Choose…' }))
    await settle()
    expect(within(card()).queryByRole('alert')).toBeNull()
    expect(row('Overall repo')).toBe('Not set')
  })
})
