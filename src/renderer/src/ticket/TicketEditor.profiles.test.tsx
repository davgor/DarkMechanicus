// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { CapabilityProfile } from '../../../shared/domain/bundle'
import type { ProfileView } from '../../../shared/domain/views'
import { installDomShims } from '../epic/__mocks__/domShims'
import { FakeBackend, scenario } from '../epic/__mocks__/fakeBackend'
import { draftPlan, epicDetail, profileView } from '../epic/__mocks__/fixtures'
import { renderWorkspace, type WorkspaceHarness } from '../epic/__mocks__/renderWorkspace'
import { allowSlowRendering } from '../epic/__mocks__/testTiming'

allowSlowRendering()

beforeAll(() => {
  installDomShims()
})

afterEach(() => {
  cleanup()
})

const CHECKBOXES = ['Repo read', 'Repo write', 'Shell', 'Browser', 'Test execution', 'Network', 'Text', 'Images']

function ticketCapability(): CapabilityProfile {
  const found = draftPlan().bundle.tickets.find((item) => item.id === 'tk_202')
  if (!found) {
    throw new Error('missing ticket')
  }
  return found.capability
}

async function openEditor(backend: FakeBackend): Promise<{ h: WorkspaceHarness; editor: HTMLElement }> {
  const h = renderWorkspace(backend)
  fireEvent.click(await screen.findByRole('button', { name: 'View draft' }))
  fireEvent.click(await screen.findByText('Transactional bundle import'))
  const editor = await screen.findByLabelText('Edit ticket DM-202')
  return { h, editor }
}

function withProfiles(profiles: ProfileView[]): FakeBackend {
  return new FakeBackend(scenario({ epic: epicDetail({ hasDraft: true }), draft: draftPlan(), profiles }))
}

function field(editor: HTMLElement, label: string): HTMLInputElement {
  return within(editor).getByLabelText(label) as HTMLInputElement
}

function checked(editor: HTMLElement): boolean[] {
  return CHECKBOXES.map((label) => field(editor, label).checked)
}

describe('ticket editor: start from a named profile', () => {
  it('lists the profiles and fills the capability fields from the chosen one without writing anything', async () => {
    const { h, editor } = await openEditor(withProfiles([profileView(), profileView({ name: 'ui-implementation', description: '' })]))
    const picker = (await within(editor).findByLabelText('Start from profile')) as HTMLSelectElement
    expect([...picker.options].map((option) => option.textContent)).toEqual(['Choose a profile…', 'deep-review', 'ui-implementation'])
    expect(checked(editor)).toEqual([true, true, true, false, true, false, true, false])
    fireEvent.change(picker, { target: { value: 'deep-review' } })
    const values = ['Work type', 'Reasoning', 'Reasoning rationale', 'Skills', 'Estimated input tokens'].map((label) => field(editor, label).value)
    expect(values).toEqual(['review', 'deep', 'Risky change', 'security-review', '80000'])
    expect(checked(editor)).toEqual([true, false, false, false, true, false, true, true])
    expect(within(editor).getByText('Filled from deep-review: Independent review of risky changes. Apply to update the draft.')).toBeTruthy()
    expect(within(editor).getByText('Unapplied edits').textContent).toBe('Unapplied edits')
    expect(h.backend.inputs('updatePlanDraft')).toEqual([])
  })

  it('applies the chosen profile to the draft as one capability patch', async () => {
    const { h, editor } = await openEditor(withProfiles([profileView()]))
    fireEvent.change(await within(editor).findByLabelText('Start from profile'), { target: { value: 'deep-review' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Apply' }))
    expect(await within(editor).findByText('Applied to the draft.')).toBeTruthy()
    const { tools: _tools, ...rest } = profileView().capability
    expect(h.backend.inputs('updatePlanDraft')).toEqual([
      {
        epicId: 'ep_1',
        ops: [{ op: 'update_ticket', ticket: 'tk_202', patch: { capability: { ...rest, tools: ['repo_read', 'test_execution'] } } }],
        expectedDraftRevision: 7
      }
    ])
  })

  it('ignores the placeholder and forgets the profile on revert', async () => {
    const { editor } = await openEditor(withProfiles([profileView()]))
    const picker = (await within(editor).findByLabelText('Start from profile')) as HTMLSelectElement
    fireEvent.change(picker, { target: { value: 'deep-review' } })
    fireEvent.change(picker, { target: { value: '' } })
    expect([picker.value, field(editor, 'Work type').value]).toEqual(['deep-review', 'review'])
    fireEvent.click(within(editor).getByRole('button', { name: 'Revert' }))
    expect([picker.value, field(editor, 'Work type').value]).toEqual(['', 'implementation'])
    expect(within(editor).queryByText(/^Filled from/)).toBeNull()
  })
})

describe('ticket editor: profile list states', () => {
  it('shows a hint instead of the picker when the repository has no profiles', async () => {
    const { editor } = await openEditor(withProfiles([]))
    expect(await within(editor).findByText('No named profiles yet.')).toBeTruthy()
    expect(within(editor).queryByLabelText('Start from profile')).toBeNull()
  })

  it('says when profiles are still loading or could not be loaded', async () => {
    const backend = withProfiles([profileView()])
    let release = (): void => undefined
    backend.gates.listProfiles = new Promise<void>((resolve) => {
      release = resolve
    })
    backend.fail('listProfiles', 'internal', 'disk error')
    const { editor } = await openEditor(backend)
    expect(within(editor).getByText('Loading profiles…')).toBeTruthy()
    release()
    expect(await within(editor).findByText('Profiles unavailable: disk error')).toBeTruthy()
    expect(within(editor).queryByLabelText('Start from profile')).toBeNull()
  })
})

describe('ticket editor: save requirements as a profile', () => {
  it('saves the current requirements as a new profile and then offers it', async () => {
    const { h, editor } = await openEditor(withProfiles([]))
    await within(editor).findByText('No named profiles yet.')
    fireEvent.click(within(editor).getByRole('button', { name: 'Save as profile…' }))
    const save = within(editor).getByRole('button', { name: 'Save profile' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(field(editor, 'Profile name'), { target: { value: 'import-work' } })
    fireEvent.change(field(editor, 'Profile description'), { target: { value: 'Bundle imports' } })
    fireEvent.click(save)
    expect(await within(editor).findByText('Saved profile import-work.')).toBeTruthy()
    expect(h.backend.inputs('saveProfile')).toEqual([{ name: 'import-work', description: 'Bundle imports', capability: ticketCapability() }])
    const picker = (await within(editor).findByLabelText('Start from profile')) as HTMLSelectElement
    expect([...picker.options].map((option) => option.value)).toEqual(['', 'import-work'])
    expect(within(editor).queryByLabelText('Profile name')).toBeNull()
    expect(h.backend.inputs('updatePlanDraft')).toEqual([])
  })

  it('replaces a saved profile of the same name at its revision', async () => {
    const { h, editor } = await openEditor(withProfiles([profileView()]))
    await within(editor).findByLabelText('Start from profile')
    fireEvent.click(within(editor).getByRole('button', { name: 'Save as profile…' }))
    fireEvent.change(field(editor, 'Profile name'), { target: { value: 'deep-review' } })
    expect(within(editor).getByText('Replaces the saved profile deep-review (revision 2).')).toBeTruthy()
    fireEvent.click(within(editor).getByRole('button', { name: 'Replace profile' }))
    expect(await within(editor).findByText('Saved profile deep-review.')).toBeTruthy()
    expect(h.backend.inputs('saveProfile')).toEqual([
      { name: 'deep-review', description: 'Independent review of risky changes', capability: ticketCapability(), expectedRevision: 2 }
    ])
  })
})

describe('ticket editor: save as profile failures', () => {
  it('shows why a profile could not be saved and keeps the entry open', async () => {
    const { h, editor } = await openEditor(withProfiles([]))
    await within(editor).findByText('No named profiles yet.')
    const reason = 'Invalid saveProfile input at name: Use 1-64 lowercase letters, digits, or hyphens.'
    h.backend.fail('saveProfile', 'invalid_input', reason)
    fireEvent.click(within(editor).getByRole('button', { name: 'Save as profile…' }))
    fireEvent.change(field(editor, 'Profile name'), { target: { value: 'Bad Name' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Save profile' }))
    expect((await within(editor).findByRole('alert')).textContent).toBe(reason)
    expect(field(editor, 'Profile name').value).toBe('Bad Name')
    expect((within(editor).getByRole('button', { name: 'Save profile' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('closes the entry on cancel without saving', async () => {
    const { h, editor } = await openEditor(withProfiles([]))
    await within(editor).findByText('No named profiles yet.')
    fireEvent.click(within(editor).getByRole('button', { name: 'Save as profile…' }))
    fireEvent.change(field(editor, 'Profile name'), { target: { value: 'draft-name' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }))
    expect(within(editor).queryByLabelText('Profile name')).toBeNull()
    expect(h.backend.inputs('saveProfile')).toEqual([])
  })
})
