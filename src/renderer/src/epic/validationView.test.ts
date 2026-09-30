import { describe, expect, it } from 'vitest'
import { draftPlan, runView, validation } from './__mocks__/fixtures'
import { changeRows, changesHeading, draftBarNote, saveBlocked, saveNote, saveOutcome, validationSummary } from './validationView'

describe('validation summary', () => {
  it('counts errors and warnings and confirms a clean graph', () => {
    expect(validationSummary(validation())).toEqual({
      heading: 'VALIDATION · 0 ERRORS · 1 WARNING',
      items: [
        { tone: 'ok', text: 'Graph is acyclic; every reference resolves' },
        {
          tone: 'warning',
          text: 'DM-305 has no prerequisites and nothing depends on it. It can start as soon as its sprint opens.'
        }
      ]
    })
  })

  it('lists errors before warnings and uses singular words', () => {
    const report = validation({
      valid: false,
      errors: [{ code: 'cycle', message: 'Dependency cycle: DM-1 → DM-2 → DM-1.' }],
      warnings: []
    })
    expect(validationSummary(report)).toEqual({
      heading: 'VALIDATION · 1 ERROR · 0 WARNINGS',
      items: [{ tone: 'error', text: 'Dependency cycle: DM-1 → DM-2 → DM-1.' }]
    })
    expect(saveBlocked(report)).toBe('Fix 1 error before saving.')
    const two = validation({ errors: [report.errors[0] ?? { code: '', message: '' }, { code: 'x', message: 'y' }] })
    expect(saveBlocked(two)).toBe('Fix 2 errors before saving.')
    expect(saveBlocked(validation())).toBe(null)
    expect(saveBlocked(null)).toBe(null)
  })

  it('says when validation has not run', () => {
    expect(validationSummary(null)).toEqual({ heading: 'VALIDATION · NOT CHECKED YET', items: [] })
  })
})

describe('changes since the base revision', () => {
  it('marks added, edited and removed changes and names the base revision', () => {
    expect(changeRows(draftPlan().changes)).toEqual([
      { symbol: '+', tone: 'added', text: 'added to Sprint 3', label: 'DM-305 Plan list view' },
      { symbol: '~', tone: 'edited', text: 'acceptance criteria edited (2 lines)', label: 'DM-302' },
      { symbol: '~', tone: 'edited', text: 'concurrency cap 2 → 3', label: 'Sprint 3' },
      { symbol: '−', tone: 'removed', text: 'no longer requires DM-102', label: 'DM-202' }
    ])
    expect(changesHeading(draftPlan())).toBe('CHANGES SINCE REV 4')
    expect(changesHeading(draftPlan({ baseRevisionNumber: null }))).toBe('CHANGES · FIRST REVISION')
  })

  it('drops a label that the detail sentence already starts with', () => {
    const rows = changeRows([
      { kind: 'added', target: 'ticket', id: 't', label: 'DM-9 Title', detail: 'DM-9 Title added to Sprint 1' }
    ])
    expect(rows).toEqual([{ symbol: '+', tone: 'added', text: 'DM-9 Title added to Sprint 1', label: '' }])
  })
})

describe('save note and outcome', () => {
  it('explains that saving never changes an active run', () => {
    expect(saveNote(runView(), 5)).toBe("Saving doesn't change run #2. Adopt rev 5 at the Sprint 2 checkpoint.")
    expect(saveNote(runView({ activeSprintOrdinal: null, number: undefined }), 5)).toBe(
      "Saving doesn't change the active run. Adopt rev 5 at its next checkpoint."
    )
    expect(saveNote(runView({ state: 'completed' }), 5)).toBe('Saving makes rev 5 the plan the next run executes.')
    expect(saveNote(null, 1)).toBe('Saving makes rev 1 the plan the next run executes.')
  })

  it('maps save results to messages', () => {
    const base = { epicId: 'ep_1', revisionId: 'rv_5', revisionNumber: 5, contentHash: 'h', error: null }
    expect(saveOutcome({ ...base, status: 'saved' })).toEqual({ kind: 'saved', message: 'Saved rev 5.' })
    expect(saveOutcome({ ...base, status: 'pending' })).toEqual({
      kind: 'pending',
      message: "Save pending — the snapshot hasn't been written yet; your draft is kept."
    })
    expect(saveOutcome({ ...base, status: 'pending', error: 'disk full' })).toEqual({
      kind: 'pending',
      message: "Save pending — the snapshot hasn't been written yet; your draft is kept. (disk full)"
    })
    expect(saveOutcome({ ...base, status: 'unchanged', revisionNumber: 4 })).toEqual({
      kind: 'unchanged',
      message: 'Nothing to save — the draft matches rev 4.'
    })
  })
})

describe('draft bar note', () => {
  it('reminds that the draft never changes the active run', () => {
    expect(draftBarNote(runView(), 5)).toBe('Changes stay in draft rev 5 until you save. Run #2 keeps executing rev 4 unchanged.')
    expect(draftBarNote(runView({ state: 'canceled' }), 5)).toBe('Changes stay in draft rev 5 until you save.')
    expect(draftBarNote(null, 1)).toBe('Changes stay in draft rev 1 until you save.')
  })
})
