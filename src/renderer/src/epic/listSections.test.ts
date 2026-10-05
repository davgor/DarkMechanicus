import { describe, expect, it } from 'vitest'
import type { GraphInput } from '../graph/graphModel'
import { attempt, draftPlan, runView, savedPlan, sprint, bundle } from './__mocks__/fixtures'
import { listSections } from './listSections'

function input(patch: Partial<GraphInput> = {}): GraphInput {
  return {
    plan: savedPlan(),
    mode: 'saved',
    run: runView(),
    statuses: new Map([
      ['tk_101', 'completed'],
      ['tk_202', 'in_progress']
    ]),
    outcome: null,
    rejected: null,
    draftNumber: 5,
    ...patch
  }
}

describe('list view', () => {
  it('groups tickets by sprint in ordinal order with status and execution state', () => {
    const sections = listSections(input())
    expect(sections.map((section) => [section.heading, section.goal, section.rows.length])).toEqual([
      ['SPRINT 1', 'Storage foundation', 3],
      ['SPRINT 2', 'Authoring through MCP', 4],
      ['SPRINT 3', 'Desktop editing', 3]
    ])
    const [first] = sections[0]?.rows ?? []
    expect(first).toEqual({
      id: 'tk_101',
      key: 'DM-101',
      title: 'Repository init',
      status: 'Completed',
      badge: { label: 'ACCEPTED', tone: 'accepted', dashed: false },
      priority: 'Normal',
      tags: [],
      optional: false,
      working: null
    })
    const importRow = sections[1]?.rows.find((row) => row.id === 'tk_202')
    expect(importRow).toMatchObject({ status: 'In progress', priority: 'High', tags: ['storage'] })
    expect(sections[1]?.rows.find((row) => row.id === 'tk_204')?.status).toBe('—')
  })

})

describe('list view and the attempt being worked on', () => {
  it('names the open attempt of a ticket being worked on, and no other', () => {
    const rows = listSections(input())[1]?.rows ?? []
    expect(rows.map((row) => [row.key, row.working])).toEqual([
      ['DM-201', null],
      ['DM-202', 'at_202_2'],
      ['DM-203', null],
      ['DM-204', null]
    ])
    const closed = runView({ attempts: [attempt('DM-202', 1, 'running'), attempt('DM-202', 2, 'failed')] })
    expect(listSections(input({ run: closed }))[1]?.rows.map((row) => row.working)).toEqual([null, null, null, null])
  })

  it('shows draft change states in the Draft view', () => {
    const rows = listSections(input({ mode: 'draft', plan: draftPlan() }))[2]?.rows ?? []
    expect(rows.map((row) => `${row.key} ${row.badge.label}`)).toEqual([
      'DM-301 DRAFT',
      'DM-302 EDITED',
      'DM-304 DRAFT',
      'DM-305 NEW IN REV 5'
    ])
  })

  it('names empty goals and skips unknown ticket ids', () => {
    const plan = savedPlan({ bundle: bundle({ sprints: [sprint(2, '', ['tk_999']), sprint(1, 'One', ['tk_101'])] }) })
    const sections = listSections(input({ plan, run: null }))
    expect(sections.map((section) => [section.heading, section.goal, section.rows.map((row) => row.key)])).toEqual([
      ['SPRINT 1', 'One', ['DM-101']],
      ['SPRINT 2', 'No goal yet', []]
    ])
  })
})
