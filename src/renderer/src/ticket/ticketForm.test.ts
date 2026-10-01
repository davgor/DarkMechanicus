import { describe, expect, it } from 'vitest'
import type { CapabilityProfile } from '../../../shared/domain/bundle'
import { draftPlan, profileView } from '../epic/__mocks__/fixtures'
import {
  CONFLICT_MESSAGE,
  addCriterion,
  applyOutcome,
  applyProfile,
  formCapability,
  profileSaveInput,
  editForm,
  initialEditor,
  rejectForm,
  syncEditor,
  editCriterion,
  formErrors,
  formFromBundle,
  formToOps,
  moveCriterion,
  pick,
  prerequisiteOptions,
  removeCriterion,
  splitList,
  sprintOptions,
  toggleValue,
  type TicketForm
} from './ticketForm'

const BUNDLE = draftPlan().bundle

function capabilityOf(ticketId: string): CapabilityProfile {
  const found = BUNDLE.tickets.find((item) => item.id === ticketId)
  if (!found) {
    throw new Error('missing ticket')
  }
  return found.capability
}

const DM_202_CAPABILITY = capabilityOf('tk_202')

function form(ticketId = 'tk_202'): TicketForm {
  const value = formFromBundle(BUNDLE, ticketId)
  if (!value) {
    throw new Error('missing ticket')
  }
  return value
}

describe('ticket form from the draft bundle', () => {
  it('copies every editable field', () => {
    expect(form()).toEqual({
      title: 'Transactional bundle import',
      body: '`save_plan_draft` accepts one bundle of tickets.',
      criteria: [
        { key: 'c1', id: 'c1', text: 'Bundle with client-local refs returns stable IDs' },
        { key: 'c2', id: 'c2', text: 'An invalid edge rejects the whole bundle and nothing persists' },
        { key: 'c3', id: 'c3', text: 'A retry with the same idempotency key returns the original result' },
        { key: 'c4', id: 'c4', text: 'Export outbox entry is written in the same transaction' }
      ],
      nextKey: 1,
      tags: 'storage',
      priority: 'high',
      optional: false,
      sprintId: 'sp_2',
      prerequisites: ['tk_102', 'tk_103'],
      workType: 'implementation',
      reasoningLevel: 'multi_step',
      rationale: 'transaction and outbox ordering',
      tools: ['repo_read', 'repo_write', 'shell', 'test_execution'],
      modalities: ['text'],
      skills: 'TypeScript, SQLite, Database design, MCP',
      tokens: '40000',
      profile: '',
      baseCapability: DM_202_CAPABILITY,
      loadedCapability: DM_202_CAPABILITY
    })
    expect(form('tk_101').tokens).toBe('')
    expect(formFromBundle(BUNDLE, 'tk_nope')).toBe(null)
  })

  it('produces no operations when nothing changed', () => {
    expect(formToOps(form(), BUNDLE, 'tk_202')).toEqual([])
    expect(formToOps(form(), BUNDLE, 'tk_nope')).toEqual([])
  })
})

describe('ticket form operations (1)', () => {
  it('patches only changed fields in one update_ticket op', () => {
    const edited: TicketForm = { ...form(), title: '  Import v2  ', priority: 'critical' }
    expect(formToOps(edited, BUNDLE, 'tk_202')).toEqual([
      { op: 'update_ticket', ticket: 'tk_202', patch: { title: 'Import v2', priority: 'critical' } }
    ])
  })

  it('patches body, criteria, tags and optional', () => {
    const base = form()
    const edited: TicketForm = {
      ...addCriterion(removeCriterion(base, 3)),
      body: 'New body',
      tags: 'storage, Import, storage, ',
      optional: true
    }
    const withText = editCriterion(edited, 3, '  Added check  ')
    expect(formToOps(withText, BUNDLE, 'tk_202')).toEqual([
      {
        op: 'update_ticket',
        ticket: 'tk_202',
        patch: {
          body: 'New body',
          acceptanceCriteria: [
            { id: 'c1', text: 'Bundle with client-local refs returns stable IDs' },
            { id: 'c2', text: 'An invalid edge rejects the whole bundle and nothing persists' },
            { id: 'c3', text: 'A retry with the same idempotency key returns the original result' },
            { text: 'Added check' }
          ],
          tags: ['storage', 'Import'],
          optional: true
        }
      }
    ])
  })

  it('drops blank criteria and detects reordering', () => {
    const blank = addCriterion(form())
    expect(formToOps(blank, BUNDLE, 'tk_202')).toEqual([])
    const reordered = moveCriterion(form(), 0, 1)
    expect(reordered.criteria.map((item) => item.id)).toEqual(['c2', 'c1', 'c3', 'c4'])
    const [op] = formToOps(reordered, BUNDLE, 'tk_202')
    expect(op).toMatchObject({ op: 'update_ticket', patch: { acceptanceCriteria: [{ id: 'c2' }, { id: 'c1' }, { id: 'c3' }, { id: 'c4' }] } })
  })
})

describe('ticket form operations (2)', () => {
  it('patches capability groups that changed', () => {
    const edited: TicketForm = {
      ...form(),
      workType: 'testing',
      rationale: 'needs care',
      tools: ['shell', 'repo_read'],
      modalities: ['images', 'text'],
      skills: 'TypeScript',
      tokens: '1200'
    }
    const [op] = formToOps(edited, BUNDLE, 'tk_202')
    expect(op).toEqual({
      op: 'update_ticket',
      ticket: 'tk_202',
      patch: {
        capability: {
          workType: 'testing',
          reasoning: { level: 'multi_step', rationale: 'needs care' },
          tools: ['repo_read', 'shell'],
          modalities: ['text', 'images'],
          skills: ['TypeScript'],
          context: { estimatedInputTokens: 1200, requiredArtifacts: [] }
        }
      }
    })
  })
})

describe('ticket form capability details', () => {
  it('treats reordered tool selections as unchanged and a new reasoning level as changed', () => {
    const reordered: TicketForm = { ...form(), tools: ['test_execution', 'shell', 'repo_write', 'repo_read'] }
    expect(formToOps(reordered, BUNDLE, 'tk_202')).toEqual([])
    const deeper: TicketForm = { ...form(), reasoningLevel: 'deep' }
    expect(formToOps(deeper, BUNDLE, 'tk_202')).toEqual([
      {
        op: 'update_ticket',
        ticket: 'tk_202',
        patch: { capability: { reasoning: { level: 'deep', rationale: 'transaction and outbox ordering' } } }
      }
    ])
    const cleared: TicketForm = { ...form(), tokens: ' ' }
    expect(formToOps(cleared, BUNDLE, 'tk_202')).toEqual([
      {
        op: 'update_ticket',
        ticket: 'tk_202',
        patch: { capability: { context: { estimatedInputTokens: null, requiredArtifacts: [] } } }
      }
    ])
    const fewer: TicketForm = { ...form(), tools: ['repo_read'] }
    expect(formToOps(fewer, BUNDLE, 'tk_202')[0]).toMatchObject({ patch: { capability: { tools: ['repo_read'] } } })
  })
})

describe('ticket form named profiles', () => {
  it('fills every capability field from the profile and leaves the rest of the form alone', () => {
    const applied = applyProfile(form(), profileView())
    expect(applied).toEqual({
      ...form(),
      workType: 'review',
      reasoningLevel: 'deep',
      rationale: 'Risky change',
      tools: ['test_execution', 'repo_read'],
      modalities: ['text', 'images'],
      skills: 'security-review',
      tokens: '80000',
      profile: 'deep-review',
      baseCapability: profileView().capability
    })
    expect(applyProfile(form(), profileView({ capability: { ...profileView().capability, context: { estimatedInputTokens: null, requiredArtifacts: [] } } })).tokens).toBe('')
  })

  it('patches every capability group the profile changes, in one update_ticket op', () => {
    expect(formToOps(applyProfile(form(), profileView()), BUNDLE, 'tk_202')).toEqual([
      {
        op: 'update_ticket',
        ticket: 'tk_202',
        patch: {
          capability: {
            workType: 'review',
            reasoning: { level: 'deep', rationale: 'Risky change' },
            skills: ['security-review'],
            modalities: ['text', 'images'],
            tools: ['repo_read', 'test_execution'],
            context: { estimatedInputTokens: 80_000, requiredArtifacts: ['docs/architecture.md'] },
            constraints: { environments: ['ci'], dataLocation: 'eu', maxDurationMinutes: 60, maxCostUsd: 5 },
            preferences: { quality: 'high', latency: null, cost: 'low', autonomy: 'supervised', modelOverride: null }
          }
        }
      }
    ])
  })
})

describe('ticket form named profile edge cases', () => {
  it('produces no operations for a profile equal to the ticket requirements', () => {
    const same = profileView({ capability: DM_202_CAPABILITY })
    expect(formToOps(applyProfile(form(), same), BUNDLE, 'tk_202')).toEqual([])
  })

  it('compares tools and modalities as sets even when the ticket stores them out of order', () => {
    const shuffled = {
      ...BUNDLE,
      tickets: BUNDLE.tickets.map((item) =>
        item.id === 'tk_202' ? { ...item, capability: { ...item.capability, tools: ['test_execution', 'repo_read'], modalities: ['images', 'text'] } } : item
      )
    } as typeof BUNDLE
    const untouched = formFromBundle(shuffled, 'tk_202')
    expect(untouched === null ? 'missing' : formToOps(untouched, shuffled, 'tk_202')).toEqual([])
  })

  it('patches only the hidden groups a profile changes', () => {
    const base = profileView({ capability: DM_202_CAPABILITY })
    const capability = base.capability
    const preferences = { ...capability.preferences, quality: 'high' as const }
    const constraints = { ...capability.constraints, environments: ['ci'] }
    const artifacts = { ...capability.context, requiredArtifacts: ['README.md'] }
    const patchOf = (next: typeof capability): unknown => formToOps(applyProfile(form(), { ...base, capability: next }), BUNDLE, 'tk_202')[0]
    expect(patchOf({ ...capability, preferences })).toMatchObject({ patch: { capability: { preferences } } })
    expect(patchOf({ ...capability, constraints })).toMatchObject({ patch: { capability: { constraints } } })
    expect(patchOf({ ...capability, context: artifacts })).toMatchObject({ patch: { capability: { context: artifacts } } })
    expect(Object.keys((patchOf({ ...capability, preferences }) as { patch: { capability: object } }).patch.capability)).toEqual(['preferences'])
  })

  it('keeps later edits made on top of an applied profile', () => {
    const edited: TicketForm = { ...applyProfile(form(), profileView()), workType: 'testing', tokens: '' }
    expect(formToOps(edited, BUNDLE, 'tk_202')[0]).toMatchObject({
      patch: { capability: { workType: 'testing', context: { estimatedInputTokens: null, requiredArtifacts: ['docs/architecture.md'] } } }
    })
  })
})

/** The latest draft after someone else (an agent's update_ticket) changed DM-202's requirements. */
function changedElsewhere(change: (capability: CapabilityProfile) => CapabilityProfile): typeof BUNDLE {
  return { ...BUNDLE, tickets: BUNDLE.tickets.map((item) => (item.id === 'tk_202' ? { ...item, capability: change(item.capability) } : item)) }
}

/** A cost ceiling, a model override, and a required artifact: groups the editor never shows. */
function hiddenChanges(capability: CapabilityProfile): CapabilityProfile {
  return {
    ...capability,
    constraints: { ...capability.constraints, maxCostUsd: 5 },
    preferences: { ...capability.preferences, modelOverride: 'some-model' },
    context: { ...capability.context, requiredArtifacts: ['docs/architecture.md'] }
  }
}

describe('ticket form apply after concurrent requirement changes', () => {
  it('writes only the title when that is all the person edited, keeping the hidden groups changed meanwhile', () => {
    const latest = changedElsewhere(hiddenChanges)
    const edited = editForm(initialEditor(BUNDLE, 'tk_202'), { ...form(), title: 'Renamed by the person' })
    const kept = syncEditor(edited, latest, 'tk_202')
    expect(kept).toBe(edited)
    expect(kept.form === null ? 'no form' : formToOps(kept.form, latest, 'tk_202')).toEqual([
      { op: 'update_ticket', ticket: 'tk_202', patch: { title: 'Renamed by the person' } }
    ])
  })

  it('never reverts visible requirements changed meanwhile that the person left alone', () => {
    const latest = changedElsewhere((capability) => ({ ...capability, workType: 'testing', tools: ['browser'], context: { ...capability.context, estimatedInputTokens: 9000 } }))
    expect(formToOps({ ...form(), priority: 'low' }, latest, 'tk_202')).toEqual([{ op: 'update_ticket', ticket: 'tk_202', patch: { priority: 'low' } }])
  })

  it('writes the fields the person changed, with the required artifacts added meanwhile', () => {
    const edited: TicketForm = { ...form(), workType: 'testing', tokens: '1200' }
    expect(formToOps(edited, changedElsewhere(hiddenChanges), 'tk_202')).toEqual([
      {
        op: 'update_ticket',
        ticket: 'tk_202',
        patch: { capability: { workType: 'testing', context: { estimatedInputTokens: 1200, requiredArtifacts: ['docs/architecture.md'] } } }
      }
    ])
  })

  it('lets the person win a group both sides changed', () => {
    const latest = changedElsewhere((capability) => ({ ...capability, tools: ['browser'] }))
    expect(formToOps({ ...form(), tools: ['shell'] }, latest, 'tk_202')).toEqual([{ op: 'update_ticket', ticket: 'tk_202', patch: { capability: { tools: ['shell'] } } }])
  })
})

describe('ticket form apply of a profile after concurrent requirement changes', () => {
  it('writes the hidden group a chosen profile changes and keeps the ones it leaves as loaded', () => {
    const constraints = { ...DM_202_CAPABILITY.constraints, environments: ['ci'] }
    const profile = profileView({ capability: { ...DM_202_CAPABILITY, constraints } })
    expect(formToOps(applyProfile(form(), profile), changedElsewhere(hiddenChanges), 'tk_202')).toEqual([
      { op: 'update_ticket', ticket: 'tk_202', patch: { capability: { constraints } } }
    ])
  })

  it('merges context per field: the profile artifacts with a token estimate changed meanwhile', () => {
    const latest = changedElsewhere((capability) => ({ ...capability, context: { ...capability.context, estimatedInputTokens: 9000 } }))
    const profile = profileView({ capability: { ...DM_202_CAPABILITY, context: { estimatedInputTokens: 40_000, requiredArtifacts: ['README.md'] } } })
    expect(formToOps(applyProfile(form(), profile), latest, 'tk_202')).toEqual([
      { op: 'update_ticket', ticket: 'tk_202', patch: { capability: { context: { estimatedInputTokens: 9000, requiredArtifacts: ['README.md'] } } } }
    ])
  })
})

describe('formCapability', () => {
  it('builds the full requirements the form describes, normalized like an apply', () => {
    const edited: TicketForm = {
      ...applyProfile(form(), profileView()),
      rationale: '  Risky change  ',
      tools: ['shell', 'repo_read'],
      modalities: ['images', 'text'],
      skills: 'security-review, Go, go, ',
      tokens: ' 1200 '
    }
    expect(formCapability(edited)).toEqual({
      ...profileView().capability,
      reasoning: { level: 'deep', rationale: 'Risky change' },
      tools: ['repo_read', 'shell'],
      modalities: ['text', 'images'],
      skills: ['security-review', 'Go'],
      context: { estimatedInputTokens: 1200, requiredArtifacts: ['docs/architecture.md'] }
    })
    expect(formCapability(form())).toEqual(DM_202_CAPABILITY)
  })
})

describe('profileSaveInput', () => {
  it('creates a profile from the form requirements with a trimmed name and description', () => {
    expect(profileSaveInput(form(), { name: ' import-work ', description: ' Bundle imports ' }, undefined)).toEqual({
      name: 'import-work',
      description: 'Bundle imports',
      capability: DM_202_CAPABILITY
    })
  })

  it('replaces an existing profile at its revision, keeping its description unless a new one is typed', () => {
    const existing = profileView()
    expect(profileSaveInput(form(), { name: 'deep-review', description: '  ' }, existing)).toEqual({
      name: 'deep-review',
      description: 'Independent review of risky changes',
      capability: DM_202_CAPABILITY,
      expectedRevision: 2
    })
    expect(profileSaveInput(form(), { name: 'deep-review', description: 'Sharper' }, existing)).toMatchObject({
      description: 'Sharper',
      expectedRevision: 2
    })
  })
})

describe('ticket form membership and dependencies', () => {
  it('orders removals before the move and additions after it', () => {
    const edited: TicketForm = { ...form(), sprintId: 'sp_3', prerequisites: ['tk_103', 'tk_201'] }
    expect(formToOps(edited, BUNDLE, 'tk_202')).toEqual([
      { op: 'remove_dependency', from: 'tk_102', to: 'tk_202' },
      { op: 'move_ticket', ticket: 'tk_202', toSprint: 'sp_3' },
      { op: 'add_dependency', from: 'tk_201', to: 'tk_202' }
    ])
  })

  it('never moves to an empty sprint selection', () => {
    expect(formToOps({ ...form(), sprintId: '' }, BUNDLE, 'tk_202')).toEqual([])
  })

  it('offers prerequisite candidates from the same or an earlier sprint only', () => {
    expect(prerequisiteOptions(BUNDLE, 'tk_202', form())).toEqual([
      { id: 'tk_101', label: 'DM-101 Repository init' },
      { id: 'tk_201', label: 'DM-201 MCP authoring tools' },
      { id: 'tk_203', label: 'DM-203 Folder registry & picker' },
      { id: 'tk_204', label: 'DM-204 Sidebar plan buckets' }
    ])
    expect(prerequisiteOptions(BUNDLE, 'tk_101', form('tk_101')).map((item) => item.id)).toEqual(['tk_102', 'tk_103'])
    expect(prerequisiteOptions(BUNDLE, 'tk_202', { ...form(), sprintId: 'sp_x' })).toEqual([])
    const reversed = { ...BUNDLE, sprints: [...BUNDLE.sprints].reverse() }
    expect(prerequisiteOptions(reversed, 'tk_202', form()).map((item) => item.id)).toEqual(['tk_101', 'tk_201', 'tk_203', 'tk_204'])
  })

  it('lists sprints in order with their goals', () => {
    expect(sprintOptions(BUNDLE)).toEqual([
      { id: 'sp_1', label: 'Sprint 1 · Storage foundation' },
      { id: 'sp_2', label: 'Sprint 2 · Authoring through MCP' },
      { id: 'sp_3', label: 'Sprint 3 · Desktop editing' }
    ])
    const reversed = { ...BUNDLE, sprints: [...BUNDLE.sprints].reverse() }
    expect(sprintOptions(reversed).map((item) => item.id)).toEqual(['sp_1', 'sp_2', 'sp_3'])
    const unnamed = { ...BUNDLE, sprints: [{ ...BUNDLE.sprints[0], goal: ' ', id: 'sp_1' }] }
    expect(sprintOptions(unnamed as typeof BUNDLE)).toEqual([{ id: 'sp_1', label: 'Sprint 1' }])
  })
})

describe('ticket form helpers', () => {
  it('validates the title and token estimate', () => {
    expect(formErrors(form())).toBe(null)
    expect(formErrors({ ...form(), title: '   ' })).toBe('Title is required.')
    expect(formErrors({ ...form(), tokens: '12k' })).toBe('Estimated tokens must be a whole number.')
    expect(formErrors({ ...form(), tokens: '' })).toBe(null)
  })

  it('edits, removes and moves criteria within bounds', () => {
    const added = addCriterion(form())
    expect(added.criteria[4]).toEqual({ key: 'new-1', id: null, text: '' })
    expect(addCriterion(added).criteria[5]?.key).toBe('new-2')
    expect(editCriterion(form(), 1, 'x').criteria[1]).toEqual({ key: 'c2', id: 'c2', text: 'x' })
    expect(removeCriterion(form(), 0).criteria.map((item) => item.id)).toEqual(['c2', 'c3', 'c4'])
    expect(moveCriterion(form(), 3, 1).criteria.map((item) => item.id)).toEqual(['c1', 'c2', 'c3', 'c4'])
    expect(moveCriterion(form(), 0, -1).criteria.map((item) => item.id)).toEqual(['c1', 'c2', 'c3', 'c4'])
    expect(moveCriterion(form(), 2, -1).criteria.map((item) => item.id)).toEqual(['c1', 'c3', 'c2', 'c4'])
  })

  it('splits comma lists without blanks or case-insensitive duplicates, and toggles values', () => {
    expect(splitList(' a, b ,, A ,c')).toEqual(['a', 'b', 'c'])
    expect(splitList('')).toEqual([])
    expect(toggleValue(['a', 'b'], 'a')).toEqual(['b'])
    expect(toggleValue(['a'], 'b')).toEqual(['a', 'b'])
  })
})

describe('ticket editor state', () => {
  it('keeps unsaved edits when the draft reloads and replaces untouched forms', () => {
    const start = initialEditor(BUNDLE, 'tk_202')
    expect(start).toMatchObject({ touched: false, awaitingSync: false, message: null })
    const renamed = editForm(start, { ...form(), title: 'Mine' })
    const newer = { ...BUNDLE, tickets: BUNDLE.tickets.map((item) => (item.id === 'tk_202' ? { ...item, title: 'Theirs' } : item)) }
    expect(syncEditor(renamed, newer, 'tk_202')).toBe(renamed)
    expect(syncEditor(start, newer, 'tk_202').form?.title).toBe('Theirs')
  })

  it('shows the conflict message and keeps the form, or reloads the form after a successful apply', () => {
    const renamed = editForm(initialEditor(BUNDLE, 'tk_202'), { ...form(), title: 'Mine' })
    const conflicted = applyOutcome(renamed, { ok: false, code: 'conflict', message: 'The draft changed (now revision 9).' })
    expect(conflicted.message).toEqual({ tone: 'error', text: CONFLICT_MESSAGE })
    expect(CONFLICT_MESSAGE).toBe('The draft changed while you were editing — review and apply again.')
    expect(syncEditor(conflicted, BUNDLE, 'tk_202').form?.title).toBe('Mine')
    const rejected = applyOutcome(renamed, { ok: false, code: 'invalid_graph', message: 'Move rejected.' })
    expect(rejected.message).toEqual({ tone: 'error', text: 'Move rejected.' })
    const applied = applyOutcome(renamed, { ok: true })
    expect([applied.awaitingSync, applied.message]).toEqual([true, { tone: 'info', text: 'Applied to the draft.' }])
    const synced = syncEditor(applied, BUNDLE, 'tk_202')
    expect([synced.form?.title, synced.touched, synced.awaitingSync]).toEqual(['Transactional bundle import', false, false])
    expect(rejectForm(renamed, 'Title is required.').message).toEqual({ tone: 'error', text: 'Title is required.' })
  })
})

describe('pick', () => {
  it('returns the matching option or the fallback', () => {
    expect(pick(['low', 'high'] as const, 'high', 'low')).toBe('high')
    expect(pick(['low', 'high'] as const, 'nope', 'low')).toBe('low')
  })
})
