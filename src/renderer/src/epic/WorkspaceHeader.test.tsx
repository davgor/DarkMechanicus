// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { CommandName } from '../../../shared/domain/api'
import { correctionProvenance } from '../__mocks__/crossRepoFixtures'
import { folderView } from '../__mocks__/fixtures'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import { type Deferred, deferred } from '../__mocks__/deferred'
import { settle } from '../__mocks__/settle'
import { installDomShims } from './__mocks__/domShims'
import { FakeBackend, scenario } from './__mocks__/fakeBackend'
import { epicDetail, folder, projectView } from './__mocks__/fixtures'
import { renderWorkspace } from './__mocks__/renderWorkspace'
import { allowSlowRendering } from './__mocks__/testTiming'

allowSlowRendering()

beforeAll(() => {
  installDomShims()
})

afterEach(cleanup)

const HERE = folder().path
const LINK = 'Corrective work from Shop · xp_0001 · report revision 3: open the epic that asked for it'

/** The tracked folders and the project each holds, this workspace's folder (the target, pj_dm) first. */
interface World {
  backend: FakeBackend
  /** Folders asked for their project (getProject), oldest first, recorded as each is asked. */
  asked: string[]
  opened: [string, string][]
  projects: Record<string, string>
  /** How each folder stands in the folder list, when not set up and available. */
  flags: Record<string, Partial<TrackedFolderView>>
  /** Answers to getProject wait on these, one per call, oldest first. */
  holds: Deferred[]
}

function world(projects: Record<string, string>, targetProjectId = 'pj_dm', sourceProjectId = 'pj_shop'): World {
  const backend = new FakeBackend(scenario({ epic: epicDetail({ provenance: correctionProvenance({ projectId: sourceProjectId }, targetProjectId) }) }))
  const state: World = { backend, asked: [], opened: [], projects: { [HERE]: targetProjectId, ...projects }, flags: {}, holds: [] }
  backend.listFolders = () =>
    Promise.resolve(Object.keys(state.projects).map((path) => folderView({ path, name: path.split('/').pop() ?? path, ...state.flags[path] })))
  const answer = backend.command.bind(backend)
  backend.command = (async (folderPath: string, name: CommandName, input: never) => {
    if (name !== 'getProject') return answer(folderPath, name, input)
    state.asked.push(folderPath)
    await state.holds.shift()?.promise
    return { ok: true, data: projectView({ projectId: state.projects[folderPath] ?? 'pj_unknown' }) }
  }) as FakeBackend['command']
  return state
}

function render(state: World, navigable = true): void {
  renderWorkspace(state.backend, navigable ? { onOpenFolderEpic: (path, epicId) => state.opened.push([path, epicId]) } : {})
}

describe('DM-191 review fix: a correction epic finds the epic that asked for it without opening every workspace', () => {
  it('asks no tracked folder for its project when the correction epic opens', async () => {
    const state = world({ 'C:/code/alpha': 'pj_alpha', 'C:/code/shop': 'pj_shop', 'C:/code/zeta': 'pj_zeta' })
    render(state)
    await screen.findByRole('button', { name: LINK })
    await settle()
    expect(state.asked).toEqual([])
  })

  it('following the link asks one folder at a time, skips this one, and stops at the first holding the source project', async () => {
    const state = world({ 'C:/code/alpha': 'pj_alpha', 'C:/code/shop': 'pj_shop', 'C:/code/zeta': 'pj_zeta' })
    render(state)
    fireEvent.click(await screen.findByRole('button', { name: LINK }))
    await settle()
    expect(state.asked).toEqual(['C:/code/alpha', 'C:/code/shop'])
    expect(state.opened).toEqual([['C:/code/shop', 'ep_shop']])
  })

  it('a project correcting itself opens the asking epic in this very folder without asking any folder', async () => {
    const state = world({ 'C:/code/alpha': 'pj_alpha' }, 'pj_dm', 'pj_dm')
    render(state)
    fireEvent.click(await screen.findByRole('button', { name: LINK }))
    await settle()
    expect(state.asked).toEqual([])
    expect(state.opened).toEqual([[HERE, 'ep_shop']])
  })

  it('a source project not tracked here says so, and the link finds it once its folder is added', async () => {
    const state = world({ 'C:/code/alpha': 'pj_alpha' })
    render(state)
    fireEvent.click(await screen.findByRole('button', { name: LINK }))
    await settle()
    expect(screen.getByText(/is not in your folder list/).textContent).toBe(' Shop (pj_shop) is not in your folder list on this machine: add its folder to open the epic.')
    expect(state.opened).toEqual([])
    state.projects['C:/code/shop'] = 'pj_shop'
    fireEvent.click(screen.getByRole('button', { name: LINK }))
    await settle()
    expect(state.opened).toEqual([['C:/code/shop', 'ep_shop']])
    expect(state.asked).toEqual(['C:/code/alpha', 'C:/code/alpha', 'C:/code/shop'])
  })

  it('where the shell cannot navigate, names the source as plain text and asks nothing', async () => {
    const state = world({ 'C:/code/shop': 'pj_shop' })
    render(state, false)
    const label = await screen.findByText('Corrective work from Shop · xp_0001 · report revision 3')
    expect(label.title).toBe('Epic ep_shop of project pj_shop')
    expect(screen.queryByRole('button', { name: LINK })).toBe(null)
    await settle()
    expect(state.asked).toEqual([])
  })
})

describe('DM-191 review fix: the source lookup asks only usable folders, once, and only while the epic is shown', () => {
  it('never asks a folder that is not set up or not available', async () => {
    const state = world({ 'C:/code/fresh': 'pj_shop', 'C:/code/gone': 'pj_shop', 'C:/code/shop': 'pj_shop' })
    state.flags = { 'C:/code/fresh': { initialized: false }, 'C:/code/gone': { available: false } }
    render(state)
    fireEvent.click(await screen.findByRole('button', { name: LINK }))
    await settle()
    expect(state.asked).toEqual(['C:/code/shop'])
    expect(state.opened).toEqual([['C:/code/shop', 'ep_shop']])
  })

  it('a lookup that finishes after the epic was left does not navigate', async () => {
    const state = world({ 'C:/code/shop': 'pj_shop' })
    const answer = deferred()
    state.holds = [answer]
    render(state)
    fireEvent.click(await screen.findByRole('button', { name: LINK }))
    await settle()
    expect(state.asked).toEqual(['C:/code/shop'])
    cleanup()
    answer.resolve()
    await settle()
    expect(state.opened).toEqual([])
  })

  it('the link is disabled and busy while it looks, and a second click asks nothing more', async () => {
    const state = world({ 'C:/code/alpha': 'pj_alpha', 'C:/code/shop': 'pj_shop' })
    const answer = deferred()
    state.holds = [answer]
    render(state)
    const link = (await screen.findByRole('button', { name: LINK })) as HTMLButtonElement
    fireEvent.click(link)
    await settle()
    expect([link.disabled, link.getAttribute('aria-busy')]).toEqual([true, 'true'])
    fireEvent.click(link)
    await settle()
    expect(state.asked).toEqual(['C:/code/alpha'])
    answer.resolve()
    await settle()
    expect(state.asked).toEqual(['C:/code/alpha', 'C:/code/shop'])
    expect(state.opened).toEqual([['C:/code/shop', 'ep_shop']])
    expect([link.disabled, link.getAttribute('aria-busy')]).toEqual([false, 'false'])
  })
})
