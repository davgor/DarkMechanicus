// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { installDomShims } from '../epic/__mocks__/domShims'
import { FakeBackend, scenario } from '../epic/__mocks__/fakeBackend'
import { draftPlan, epicDetail } from '../epic/__mocks__/fixtures'
import { renderWorkspace, type WorkspaceHarness } from '../epic/__mocks__/renderWorkspace'
import { allowSlowRendering } from '../epic/__mocks__/testTiming'

allowSlowRendering()

beforeAll(() => {
  installDomShims()
})

afterEach(() => {
  cleanup()
})

async function openEditor(): Promise<{ h: WorkspaceHarness; editor: HTMLElement }> {
  const h = renderWorkspace(new FakeBackend(scenario({ epic: epicDetail({ hasDraft: true }), draft: draftPlan() })))
  fireEvent.click(await screen.findByRole('button', { name: 'View draft' }))
  fireEvent.click(await screen.findByText('Transactional bundle import'))
  const editor = await screen.findByLabelText('Edit ticket DM-202')
  return { h, editor }
}

function field(editor: HTMLElement, label: string): HTMLInputElement {
  return within(editor).getByLabelText(label) as HTMLInputElement
}

function opsOf(h: WorkspaceHarness): unknown[] {
  return h.backend.inputs('updatePlanDraft').map((input) => (input as { ops: unknown }).ops)
}

describe('ticket editor: apply (1)', () => {
  it('applies local edits as one update_ticket patch with the expected draft revision', async () => {
    const { h, editor } = await openEditor()
    expect(field(editor, 'Title').value).toBe('Transactional bundle import')
    const apply = within(editor).getByRole('button', { name: 'Apply' }) as HTMLButtonElement
    expect(apply.disabled).toBe(true)
    fireEvent.change(field(editor, 'Title'), { target: { value: 'Import v2' } })
    fireEvent.change(field(editor, 'Priority'), { target: { value: 'critical' } })
    expect(within(editor).getByText('Unapplied edits').textContent).toBe('Unapplied edits')
    fireEvent.click(apply)
    expect(await within(editor).findByText('Applied to the draft.')).toBeTruthy()
    expect(h.backend.inputs('updatePlanDraft')).toEqual([
      {
        epicId: 'ep_1',
        ops: [{ op: 'update_ticket', ticket: 'tk_202', patch: { title: 'Import v2', priority: 'critical' } }],
        expectedDraftRevision: 7
      }
    ])
  })

  it('keeps unsaved text across a conflict and applies it again on the reloaded draft', async () => {
    const { h, editor } = await openEditor()
    fireEvent.change(field(editor, 'Title'), { target: { value: 'Import v2' } })
    const draft = h.backend.state.draft
    h.backend.state.draft = draft === null ? null : { ...draft, draftRevision: 8 }
    h.backend.fail('updatePlanDraft', 'conflict', 'The draft changed (now revision 8). Reload and reapply your edit.')
    const validations = h.backend.inputs('validatePlan').length
    fireEvent.click(within(editor).getByRole('button', { name: 'Apply' }))
    expect((await within(editor).findByRole('alert')).textContent).toBe(
      'The draft changed while you were editing — review and apply again.'
    )
    await waitFor(() => expect(h.backend.inputs('validatePlan').length).toBe(validations + 1))
    await act(async () => undefined)
    expect(field(editor, 'Title').value).toBe('Import v2')
    fireEvent.click(within(editor).getByRole('button', { name: 'Apply' }))
    expect(await within(editor).findByText('Applied to the draft.')).toBeTruthy()
    expect(h.backend.inputs('updatePlanDraft')[1]).toEqual({
      epicId: 'ep_1',
      ops: [{ op: 'update_ticket', ticket: 'tk_202', patch: { title: 'Import v2' } }],
      expectedDraftRevision: 8
    })
  })
})

describe('ticket editor: apply (2)', () => {
  it('surfaces a rejected edit and validates the form before sending', async () => {
    const { h, editor } = await openEditor()
    fireEvent.change(field(editor, 'Estimated input tokens'), { target: { value: '12k' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Apply' }))
    expect((await within(editor).findByRole('alert')).textContent).toBe('Estimated tokens must be a whole number.')
    fireEvent.change(field(editor, 'Estimated input tokens'), { target: { value: '12000' } })
    fireEvent.change(field(editor, 'Sprint'), { target: { value: 'sp_1' } })
    h.backend.fail('updatePlanDraft', 'invalid_graph', 'Move rejected. DM-202 (Sprint 1) would require DM-102 in later Sprint 1.')
    fireEvent.click(within(editor).getByRole('button', { name: 'Apply' }))
    expect((await within(editor).findByText(/^Move rejected\./)).textContent).toBe(
      'Move rejected. DM-202 (Sprint 1) would require DM-102 in later Sprint 1.'
    )
    expect(opsOf(h)).toEqual([
      [
        { op: 'update_ticket', ticket: 'tk_202', patch: { capability: { context: { estimatedInputTokens: 12000, requiredArtifacts: [] } } } },
        { op: 'move_ticket', ticket: 'tk_202', toSprint: 'sp_1' }
      ]
    ])
    fireEvent.change(field(editor, 'Title'), { target: { value: ' ' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Apply' }))
    expect((await within(editor).findByText('Title is required.')).textContent).toBe('Title is required.')
  })
})

describe('ticket editor: fields', () => {
  it('edits criteria, prerequisites and the capability profile', async () => {
    const { h, editor } = await openEditor()
    expect(within(editor).queryByText('No prerequisites.')).toBe(null)
    fireEvent.click(within(editor).getByRole('button', { name: 'Move criterion 2 up' }))
    fireEvent.click(within(editor).getByRole('button', { name: 'Remove criterion 4' }))
    fireEvent.click(within(editor).getByRole('button', { name: '+ Criterion' }))
    fireEvent.change(field(editor, 'Criterion 4'), { target: { value: 'New check' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Remove prerequisite DM-103 Portable export outbox' }))
    fireEvent.change(field(editor, 'Add prerequisite'), { target: { value: 'tk_201' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Add' }))
    fireEvent.change(field(editor, 'Work type'), { target: { value: 'testing' } })
    fireEvent.click(within(editor).getByLabelText('Browser'))
    fireEvent.click(within(editor).getByLabelText('Images'))
    fireEvent.click(within(editor).getByRole('button', { name: 'Apply' }))
    await within(editor).findByText('Applied to the draft.')
    const [ops] = opsOf(h) as { op: string; patch?: unknown }[][]
    expect(ops?.map((op) => op.op)).toEqual(['update_ticket', 'remove_dependency', 'add_dependency'])
    expect(ops?.slice(1)).toEqual([
      { op: 'remove_dependency', from: 'tk_103', to: 'tk_202' },
      { op: 'add_dependency', from: 'tk_201', to: 'tk_202' }
    ])
    expect(ops?.[0]?.patch).toEqual({
      acceptanceCriteria: [
        { id: 'c2', text: 'An invalid edge rejects the whole bundle and nothing persists' },
        { id: 'c1', text: 'Bundle with client-local refs returns stable IDs' },
        { id: 'c3', text: 'A retry with the same idempotency key returns the original result' },
        { text: 'New check' }
      ],
      capability: {
        workType: 'testing',
        tools: ['repo_read', 'repo_write', 'shell', 'browser', 'test_execution'],
        modalities: ['text', 'images']
      }
    })
  })

  it('previews Markdown, reverts local edits and removes the ticket after confirmation', async () => {
    const { h, editor } = await openEditor()
    fireEvent.click(within(editor).getByRole('button', { name: 'Preview' }))
    expect(editor.querySelector('.tp-preview code')?.textContent).toBe('save_plan_draft')
    fireEvent.click(within(editor).getByRole('button', { name: 'Write' }))
    fireEvent.change(field(editor, 'Description (Markdown)'), { target: { value: 'Changed' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Revert' }))
    expect(field(editor, 'Description (Markdown)').value).toBe('`save_plan_draft` accepts one bundle of tickets.')
    fireEvent.click(within(editor).getByRole('button', { name: 'Remove ticket…' }))
    fireEvent.click(within(within(editor).getByRole('alertdialog')).getByRole('button', { name: 'Remove ticket' }))
    await waitFor(() => expect(screen.queryByLabelText('Edit ticket DM-202')).toBe(null))
    expect(opsOf(h)).toEqual([[{ op: 'remove_ticket', ticket: 'tk_202' }]])
  })
})

/** A draft whose DM-202 is sized and carries an effort and an inherited quality and cost. */
function intenseDraft(): ReturnType<typeof draftPlan> {
  const draft = draftPlan()
  const tickets = draft.bundle.tickets.map((item) =>
    item.id === 'tk_202'
      ? {
          ...item,
          size: 'small' as const,
          capability: {
            ...item.capability,
            reasoning: { ...item.capability.reasoning, effort: 'high' as const },
            preferences: { ...item.capability.preferences, quality: 'high' as const, cost: 'low' as const }
          }
        }
      : item
  )
  return { ...draft, bundle: { ...draft.bundle, tickets } }
}

async function openIntense(): Promise<{ h: WorkspaceHarness; editor: HTMLElement }> {
  const h = renderWorkspace(new FakeBackend(scenario({ epic: epicDetail({ hasDraft: true }), draft: intenseDraft() })))
  fireEvent.click(await screen.findByRole('button', { name: 'View draft' }))
  fireEvent.click(await screen.findByText('Transactional bundle import'))
  return { h, editor: await screen.findByLabelText('Edit ticket DM-202') }
}

describe('ticket editor: size, effort, quality and cost', () => {
  it('shows the size, effort, quality and cost the ticket has, including an inherited quality', async () => {
    const { editor } = await openIntense()
    expect([field(editor, 'Size').value, field(editor, 'Effort').value]).toEqual(['small', 'high'])
    expect([field(editor, 'Quality').value, field(editor, 'Cost').value]).toEqual(['high', 'low'])
  })

  it('offers None for each, and a ticket without them starts on None', async () => {
    const { editor } = await openEditor()
    for (const label of ['Size', 'Effort', 'Quality', 'Cost']) {
      expect(field(editor, label).value).toBe('')
      expect(within(field(editor, label)).getByRole('option', { name: 'None' })).toBeTruthy()
    }
  })

  it('applies each cleared to None as a patch the saved draft can carry', async () => {
    const { h, editor } = await openIntense()
    for (const label of ['Size', 'Effort', 'Quality', 'Cost']) {
      fireEvent.change(field(editor, label), { target: { value: '' } })
    }
    fireEvent.click(within(editor).getByRole('button', { name: 'Apply' }))
    await within(editor).findByText('Applied to the draft.')
    const [ops] = opsOf(h) as { patch: { size: unknown; capability: unknown } }[][]
    expect(ops?.[0]?.patch).toEqual({
      size: null,
      capability: {
        reasoning: { level: 'multi_step', rationale: 'transaction and outbox ordering', effort: null },
        preferences: { quality: null, latency: null, cost: null, autonomy: null, modelOverride: null }
      }
    })
  })

  it('applies a new size, effort, quality and cost', async () => {
    const { h, editor } = await openEditor()
    fireEvent.change(field(editor, 'Size'), { target: { value: 'micro' } })
    fireEvent.change(field(editor, 'Effort'), { target: { value: 'low' } })
    fireEvent.change(field(editor, 'Quality'), { target: { value: 'standard' } })
    fireEvent.change(field(editor, 'Cost'), { target: { value: 'normal' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Apply' }))
    await within(editor).findByText('Applied to the draft.')
    const [ops] = opsOf(h) as { patch: { size: unknown; capability: { preferences: unknown } } }[][]
    expect(ops?.[0]?.patch.size).toBe('micro')
    expect(ops?.[0]?.patch.capability).toMatchObject({
      reasoning: { effort: 'low' },
      preferences: { quality: 'standard', cost: 'normal' }
    })
  })
})

describe('ticket editor: header', () => {
  it('shows the draft change badge of the ticket being edited', async () => {
    renderWorkspace(new FakeBackend(scenario({ epic: epicDetail({ hasDraft: true }), draft: draftPlan() })))
    fireEvent.click(await screen.findByRole('button', { name: 'View draft' }))
    fireEvent.click(await screen.findByText('Plan list view'))
    const editor = await screen.findByLabelText('Edit ticket DM-305')
    expect(within(editor).getByText('NEW IN REV 5').textContent).toBe('NEW IN REV 5')
    expect(within(editor).getByText('No prerequisites.').textContent).toBe('No prerequisites.')
  })
})
