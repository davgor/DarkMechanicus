// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { installDomShims } from '../epic/__mocks__/domShims'
import { bundle, draftPlan, edge, execution, rowCheck, rowView, runView, savedPlan, sprint, ticket } from '../epic/__mocks__/fixtures'
import { allowSlowRendering } from '../epic/__mocks__/testTiming'
import type { ReasoningEffort } from '../../../shared/domain/bundle'
import { buildGraphModel, type GraphModel } from './graphModel'
import { PlanGraph, type PlanGraphProps } from './PlanGraph'

allowSlowRendering()

beforeAll(() => {
  installDomShims()
})

afterEach(() => {
  cleanup()
})

function model(mode: 'saved' | 'draft'): GraphModel {
  return buildGraphModel({
    plan: mode === 'draft' ? draftPlan() : savedPlan(),
    mode,
    run: mode === 'draft' ? null : runView(),
    statuses: new Map(),
    outcome: null,
    rejected: null,
    draftNumber: 5
  })
}

interface Recorded {
  selected: string[]
  connected: string[]
  dropped: string[]
  removed: string[]
  added: string[]
  addedAcceptance: string[]
}

function renderGraph(
  mode: 'saved' | 'draft',
  graphModel: GraphModel = model(mode)
): { recorded: Recorded; container: HTMLElement } {
  const recorded: Recorded = { selected: [], connected: [], dropped: [], removed: [], added: [], addedAcceptance: [] }
  const props: PlanGraphProps = {
    model: graphModel,
    editable: mode === 'draft',
    legend: mode === 'draft' ? 'draft' : 'execution',
    draftNumber: 5,
    selectedTicketId: 'tk_202',
    onSelectTicket: (id) => recorded.selected.push(id),
    onConnect: (from, to) => recorded.connected.push(`${from}->${to}`),
    onDropTicket: (id, top) => recorded.dropped.push(`${id}@${top}`),
    onRemoveDependency: (from, to) => recorded.removed.push(`${from}->${to}`),
    onAddTicket: (id) => recorded.added.push(id),
    onAddAcceptance: (id) => recorded.addedAcceptance.push(id)
  }
  const { container } = render(<PlanGraph {...props} />)
  return { recorded, container }
}

describe('PlanGraph in the Saved view', () => {
  it('renders the epic, sprint labels, checkpoints and labeled ticket cards', () => {
    const { container } = renderGraph('saved')
    expect(screen.getByText('EPIC · 10 TICKETS · 3 SPRINTS')).toBeTruthy()
    expect(screen.getByText('CHECKPOINT 1 · PASSED').textContent).toBe('CHECKPOINT 1 · PASSED')
    expect(screen.getByText('DM-202 · RUNNING · ATTEMPT 2').textContent).toBe('DM-202 · RUNNING · ATTEMPT 2')
    expect(screen.getByText('Active · 1 of 4 accepted').textContent).toBe('Active · 1 of 4 accepted')
    const active = container.querySelector('[data-ticket="tk_202"]')
    expect(active?.className).toBe('pg-card ew-tone-running is-active')
    expect(container.querySelector('[data-ticket="tk_301"]')?.className).toBe('pg-card ew-tone-waiting is-dashed')
    expect(container.querySelector('.pg')?.className).toBe('pg is-readonly')
    expect(screen.queryAllByText('+ Ticket').length).toBe(0)
    expect(container.querySelectorAll('.pg-note').length).toBe(0)
    expect(container.querySelector('.pg-sprint.is-active')?.textContent).toBe('SPRINT 2Authoring through MCPActive · 1 of 4 accepted')
  })

  it('shows the execution legend', () => {
    renderGraph('saved')
    const legend = screen.getByLabelText('Legend')
    expect(legend.textContent).toBe('AcceptedIn reviewRunningReadyWaitingBlockedFailedPrerequisite metWaiting on it')
  })

  it('colors the checkpoint awaiting approval with the attention tone, as the run bar does', () => {
    const awaiting = buildGraphModel({
      plan: savedPlan(),
      mode: 'saved',
      run: runView({ state: 'awaiting_checkpoint' }),
      statuses: new Map(),
      outcome: null,
      rejected: null,
      draftNumber: 5
    })
    renderGraph('saved', awaiting)
    expect(screen.getByText('CHECKPOINT 2 · AWAITING APPROVAL').parentElement?.className).toBe('pg-divider ew-tone-attention')
    expect(screen.getByText('CHECKPOINT 1 · PASSED').parentElement?.className).toBe('pg-divider ew-tone-accepted')
  })

  it('leaves the canvas dot color to the theme stylesheet', () => {
    const { container } = renderGraph('saved')
    const background = container.querySelector('.react-flow__background')
    expect(background === null).toBe(false)
    expect(background?.getAttribute('style') ?? '').not.toContain('--xy-background-pattern-color-props')
  })

  it('selects tickets on click but not structure nodes', () => {
    const { recorded, container } = renderGraph('saved')
    fireEvent.click(screen.getByText('Transactional bundle import'))
    const epic = container.querySelector('.pg-epic')
    if (epic) {
      fireEvent.click(epic)
    }
    expect(recorded.selected).toEqual(['tk_202'])
  })

})

describe('PlanGraph mascot overlay', () => {
  it('keeps the decorative mascot controls out of ticket selection', () => {
    const { recorded, container } = renderGraph('saved')
    const button = screen.getByRole('button', { name: 'Pause mascot animation' })
    fireEvent.click(button)
    expect(screen.getByRole('button', { name: 'Resume mascot animation' })).toBeTruthy()
    expect(container.querySelector('.pg-mascot-layer')).toBeTruthy()
    expect(recorded.selected).toEqual([])
    fireEvent.click(screen.getByText('Transactional bundle import'))
    expect(recorded.selected).toEqual(['tk_202'])
  })
})

describe('PlanGraph in the Draft view', () => {
  it('offers + Ticket per sprint and marks the canvas editable', () => {
    const { recorded, container } = renderGraph('draft')
    const buttons = screen.getAllByText('+ Ticket')
    expect(buttons.length).toBe(3)
    fireEvent.click(buttons[1] as HTMLElement)
    expect(recorded.added).toEqual(['sp_2'])
    expect(container.querySelector('.pg')?.className).toBe('pg is-editable')
    expect(screen.getByLabelText('Legend').textContent).toBe('UnchangedNew in rev 5EditedRejected editPrerequisite')
  })

  it('connects a prerequisite by clicking its source handle and then a target handle', () => {
    const { recorded, container } = renderGraph('draft')
    const source = container.querySelector('[data-id$="-tk_101-null-source"]')
    const target = container.querySelector('[data-id$="-tk_204-null-target"]')
    expect([source === null, target === null]).toEqual([false, false])
    fireEvent.click(source as Element)
    fireEvent.click(target as Element)
    expect(recorded.connected).toEqual(['tk_101->tk_204'])
  })
})

/** Sprint 1 (DM-1, DM-2, then DM-3 after DM-1, then its node DM-91) and Sprint 2 (DM-4, no node). */
function acceptanceModel(mode: 'saved' | 'draft'): GraphModel {
  const work = [ticket('DM-1', 'One'), ticket('DM-2', 'Two'), ticket('DM-3', 'Three'), ticket('DM-4', 'Four')]
  const node = ticket('DM-91', 'Sprint 1 acceptance', { kind: 'acceptance' })
  const planBundle = bundle({
    tickets: [...work, node],
    sprints: [sprint(1, 'Build', ['tk_1', 'tk_2', 'tk_3', 'tk_91']), sprint(2, 'Ship', ['tk_4'])],
    edges: [edge(1, 3)]
  })
  const rows = [
    rowView('sp_1', 1, ['DM-1', 'DM-2'], rowCheck('sp_1', 1, true)),
    rowView('sp_1', 2, ['DM-3'], rowCheck('sp_1', 2, false, { number: 2 })),
    rowView('sp_2', 1, ['DM-4'])
  ]
  const states = ['DM-1', 'DM-2', 'DM-3', 'DM-91'].map((key) => execution(key, 'sp_1', key === 'DM-3' ? 'failed' : 'accepted'))
  return buildGraphModel({
    plan: mode === 'draft' ? draftPlan({ bundle: planBundle, changes: [] }) : savedPlan({ bundle: planBundle }),
    mode,
    run: mode === 'draft' ? null : runView({ tickets: [...states, execution('DM-4', 'sp_2', 'later_sprint')], rows }),
    statuses: new Map(),
    outcome: null,
    rejected: null,
    draftNumber: 5
  })
}

describe('PlanGraph acceptance nodes', () => {
  it('draws the node as a distinct card tagged ACCEPTANCE, and work cards as before', () => {
    const { container } = renderGraph('saved', acceptanceModel('saved'))
    const card = container.querySelector('[data-ticket="tk_91"]')
    expect(card?.classList.contains('is-acceptance')).toBe(true)
    expect(card?.querySelector('.pg-kind')?.textContent).toBe('ACCEPTANCE')
    expect(card?.querySelector('.pg-card-title')?.textContent).toBe('Sprint 1 acceptance')
    const work = container.querySelector('[data-ticket="tk_2"]')
    expect(work?.classList.contains('is-acceptance')).toBe(false)
    expect(work?.querySelector('.pg-kind') ?? null).toBe(null)
    expect(container.querySelectorAll('.pg-kind')).toHaveLength(1)
  })

  it('selects the node on click like any ticket', () => {
    const { recorded } = renderGraph('saved', acceptanceModel('saved'))
    fireEvent.click(screen.getByText('Sprint 1 acceptance'))
    expect(recorded.selected).toEqual(['tk_91'])
  })

  it('draws one join per sprint band, waiting while a required ticket is not accepted, and no edge per ticket', () => {
    const { container } = renderGraph('saved', acceptanceModel('saved'))
    const joins = [...container.querySelectorAll('.pg-join')]
    expect(joins).toHaveLength(1)
    expect(joins[0]?.classList.contains('is-waiting')).toBe(true)
    expect(joins[0]?.getAttribute('aria-label')).toBe('DM-91 requires every required ticket of Sprint 1')
    expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(1)
  })

  it('draws the join solid once the sprint work is accepted', () => {
    const { container } = renderGraph('draft', acceptanceModel('draft'))
    expect(container.querySelector('.pg-join')?.classList.contains('is-met')).toBe(true)
  })
})

describe('PlanGraph row checks', () => {
  it('shows each row latest check with words beside the color, a failed one included', () => {
    const { container } = renderGraph('saved', acceptanceModel('saved'))
    const chips = [...container.querySelectorAll<HTMLElement>('.pg-rowcheck')]
    expect(chips.map((chip) => chip.textContent)).toEqual(['ROW 1✓ PASSED', 'ROW 2✗ FAILED', 'ROW 1– NO CHECK'])
    expect(chips.map((chip) => chip.className)).toEqual([
      'pg-rowcheck ew-tone-accepted',
      'pg-rowcheck ew-tone-failed',
      'pg-rowcheck ew-tone-neutral'
    ])
    expect(chips[1]?.getAttribute('title')).toBe('Row 2 check 2 at a1b2c3d did not pass: Unit tests (failed)')
  })

  it('shows no row check in the Draft view', () => {
    const { container } = renderGraph('draft', acceptanceModel('draft'))
    expect(container.querySelectorAll('.pg-rowcheck')).toHaveLength(0)
  })
})

describe('PlanGraph + Acceptance', () => {
  it('offers + Acceptance on a draft sprint without a node only, and adds one for that sprint', () => {
    const { recorded } = renderGraph('draft', acceptanceModel('draft'))
    const buttons = screen.getAllByText('+ Acceptance')
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0] as HTMLElement)
    expect(recorded.addedAcceptance).toEqual(['sp_2'])
    expect(recorded.added).toEqual([])
    expect(screen.getAllByText('+ Ticket')).toHaveLength(2)
  })

  it('offers + Acceptance on every sprint of a draft plan that has no nodes', () => {
    renderGraph('draft')
    expect(screen.getAllByText('+ Acceptance')).toHaveLength(3)
  })

  it('offers no + Acceptance in the read-only Saved view', () => {
    renderGraph('saved', acceptanceModel('saved'))
    expect(screen.queryAllByText('+ Acceptance')).toHaveLength(0)
  })
})

describe('PlanGraph dependency edges', () => {
  it('draws met prerequisites solid and waiting ones dashed', () => {
    const { container } = renderGraph('saved')
    const edges = [...container.querySelectorAll('.react-flow__edge')]
    expect(edges.length).toBe(9)
    expect(edges.filter((edge) => edge.classList.contains('is-met')).length).toBe(5)
    expect(edges.filter((edge) => edge.classList.contains('is-waiting')).length).toBe(4)
  })

  it('asks the server to remove a selected edge on Delete and keeps it until the reload', async () => {
    const { recorded, container } = renderGraph('draft')
    const edge = container.querySelector('.react-flow__edge') as Element
    fireEvent.click(edge)
    fireEvent.keyDown(document.body, { key: 'Delete', code: 'Delete' })
    await act(async () => undefined)
    expect(recorded.removed).toEqual(['tk_101->tk_203'])
    expect(container.querySelectorAll('.react-flow__edge').length).toBe(9)
  })

  it('ignores Delete in the read-only Saved view', async () => {
    const { recorded, container } = renderGraph('saved')
    fireEvent.click(container.querySelector('.react-flow__edge') as Element)
    fireEvent.keyDown(document.body, { key: 'Delete', code: 'Delete' })
    await act(async () => undefined)
    expect(recorded.removed).toEqual([])
  })
})

describe('PlanGraph sprint labels', () => {
  const LONG_GOAL = `The card's words and pictures are ready: ${'every ticket title reads clearly and the sprint label wraps. '.repeat(5)}`

  function longGoalModel(): GraphModel {
    const sprints = [sprint(1, LONG_GOAL, ['tk_101', 'tk_102']), sprint(2, 'Desktop editing', ['tk_301'])]
    return buildGraphModel({
      plan: savedPlan({ bundle: bundle({ sprints, edges: [] }) }),
      mode: 'saved',
      run: null,
      statuses: new Map(),
      outcome: null,
      rejected: null,
      draftNumber: 5
    })
  }

  it('keeps the full goal reachable: complete text in the DOM and as a tooltip, clamped to the reserved lines', () => {
    expect(LONG_GOAL.length).toBeGreaterThanOrEqual(300)
    const { container } = renderGraph('saved', longGoalModel())
    const goals = [...container.querySelectorAll<HTMLElement>('.pg-sprint-goal')]
    expect(goals.map((goal) => goal.textContent)).toEqual([LONG_GOAL, 'Desktop editing'])
    expect(goals.map((goal) => goal.getAttribute('title'))).toEqual([LONG_GOAL, 'Desktop editing'])
    expect(goals.map((goal) => goal.style.getPropertyValue('--pg-goal-lines'))).toEqual(['6', '1'])
  })

  it('gives the sprint label the height the layout reserved', () => {
    const graphModel = longGoalModel()
    const { container } = renderGraph('saved', graphModel)
    const reserved = graphModel.nodes.flatMap((item) => (item.kind === 'sprint' ? [item.height] : []))
    const rendered = [...container.querySelectorAll<HTMLElement>('.react-flow__node-sprint')].map((item) => item.style.height)
    expect(rendered).toEqual(reserved.map((height) => `${height}px`))
  })
})

/** The draft plan with DM-202 micro, DM-203 small, DM-301 large and a rejected edge between DM-301 and DM-203. */
function sizedModel(): GraphModel {
  const plan = draftPlan()
  const sizes: Record<string, 'micro' | 'small' | 'large'> = { tk_202: 'micro', tk_203: 'small', tk_301: 'large' }
  const tickets = plan.bundle.tickets.map((item) => (sizes[item.id] === undefined ? item : { ...item, size: sizes[item.id] }))
  return buildGraphModel({
    plan: { ...plan, bundle: { ...plan.bundle, tickets } },
    mode: 'draft',
    run: null,
    statuses: new Map(),
    outcome: null,
    rejected: { from: 'tk_301', to: 'tk_203' },
    draftNumber: 5
  })
}

function badge(container: HTMLElement, ticketId: string): Element | null {
  return container.querySelector(`[data-ticket="${ticketId}"] .pg-size`)
}

describe('PlanGraph size badges', () => {
  it('shows the size on each sized card and nothing on an unsized one', () => {
    const { container } = renderGraph('draft', sizedModel())
    expect(badge(container, 'tk_203')?.textContent).toBe('small')
    expect(badge(container, 'tk_301')?.textContent).toBe('large')
    expect(badge(container, 'tk_201')).toBe(null)
  })

  it('calls a micro ticket out with its own badge class', () => {
    const { container } = renderGraph('draft', sizedModel())
    expect(badge(container, 'tk_202')?.className).toBe('pg-size is-micro')
    expect(badge(container, 'tk_203')?.className).toBe('pg-size')
    expect(badge(container, 'tk_301')?.className).toBe('pg-size')
  })

  it('names the size for assistive technology', () => {
    const { container } = renderGraph('draft', sizedModel())
    expect(badge(container, 'tk_202')?.getAttribute('title')).toBe('Size: micro')
    expect(badge(container, 'tk_203')?.getAttribute('title')).toBe('Size: small')
  })

  it('keeps the rejection note of a sized ticket', () => {
    const { container } = renderGraph('draft', sizedModel())
    const rejected = container.querySelector('[data-ticket="tk_203"]')
    expect(rejected?.querySelector('.pg-note')?.textContent).toBe('Rejected: would require DM-301')
    expect(rejected?.querySelector('.pg-size')?.textContent).toBe('small')
    expect(container.querySelector('[data-ticket="tk_301"] .pg-note')?.textContent).toBe('Rejected as prerequisite of DM-203')
  })

  it('keeps the badge out of the state label, so a long label is not cut for it', () => {
    const { container } = renderGraph('draft', sizedModel())
    const card = container.querySelector('[data-ticket="tk_202"]')
    expect(badge(container, 'tk_202')?.parentElement?.className).toBe('pg-tags')
    expect(badge(container, 'tk_202')?.parentElement?.parentElement).toBe(card)
    expect(card?.querySelector('.pg-card-label')?.textContent).toMatch(/^DM-202 · /)
    expect(card?.querySelector('.pg-card-label')?.querySelector('.pg-size') ?? null).toBe(null)
  })
})

/** The draft plan with sizes and efforts: DM-202 micro and low, DM-203 small and medium, DM-301 large with no effort, DM-201 an effort only. */
function effortModel(): GraphModel {
  const plan = draftPlan()
  const sizes: Record<string, 'micro' | 'small' | 'large'> = { tk_202: 'micro', tk_203: 'small', tk_301: 'large' }
  const efforts: Record<string, ReasoningEffort> = { tk_202: 'low', tk_203: 'medium', tk_201: 'high' }
  const tickets = plan.bundle.tickets.map((item) => {
    const effort = efforts[item.id]
    const reasoning = effort === undefined ? item.capability.reasoning : { ...item.capability.reasoning, effort }
    return { ...item, ...(sizes[item.id] === undefined ? {} : { size: sizes[item.id] }), capability: { ...item.capability, reasoning } }
  })
  return buildGraphModel({
    plan: { ...plan, bundle: { ...plan.bundle, tickets } },
    mode: 'draft',
    run: null,
    statuses: new Map(),
    outcome: null,
    rejected: { from: 'tk_301', to: 'tk_203' },
    draftNumber: 5
  })
}

function effortBadge(container: HTMLElement, ticketId: string): Element | null {
  return container.querySelector(`[data-ticket="${ticketId}"] .pg-effort`)
}

describe('PlanGraph effort badges', () => {
  it('shows the effort on each card that sets one and nothing on a card that sets none', () => {
    const { container } = renderGraph('draft', effortModel())
    expect(effortBadge(container, 'tk_202')?.textContent).toBe('low effort')
    expect(effortBadge(container, 'tk_203')?.textContent).toBe('medium effort')
    expect(effortBadge(container, 'tk_301')).toBe(null)
    expect(badge(container, 'tk_301')?.textContent).toBe('large')
  })

  it('sits right beside the size badge, before it, in the one tag group on the card edge', () => {
    const { container } = renderGraph('draft', effortModel())
    const effort = effortBadge(container, 'tk_203')
    const size = badge(container, 'tk_203')
    expect(effort?.parentElement).toBe(size?.parentElement)
    expect(effort?.parentElement?.className).toBe('pg-tags')
    expect(effort?.nextElementSibling).toBe(size)
    expect(effort?.parentElement?.parentElement).toBe(container.querySelector('[data-ticket="tk_203"]'))
  })

  it('names the effort for assistive technology the way the size is named', () => {
    const { container } = renderGraph('draft', effortModel())
    expect(effortBadge(container, 'tk_202')?.getAttribute('title')).toBe('Effort: low')
    expect(effortBadge(container, 'tk_203')?.getAttribute('title')).toBe('Effort: medium')
    expect(badge(container, 'tk_203')?.getAttribute('title')).toBe('Size: small')
  })

  it('leaves the micro badge filled and keeps the effort badge quiet', () => {
    const { container } = renderGraph('draft', effortModel())
    expect(badge(container, 'tk_202')?.className).toBe('pg-size is-micro')
    expect(effortBadge(container, 'tk_202')?.className).toBe('pg-effort')
  })

  it('shows an effort on a ticket that has no size, and no size badge with it', () => {
    const { container } = renderGraph('draft', effortModel())
    expect(effortBadge(container, 'tk_201')?.textContent).toBe('high effort')
    expect(badge(container, 'tk_201')).toBe(null)
  })

  it('draws no tag group for a ticket with neither a size nor an effort', () => {
    const { container } = renderGraph('draft', effortModel())
    expect(container.querySelector('[data-ticket="tk_204"] .pg-tags')).toBe(null)
  })

  it('keeps the rejection note and the badges together, and the badges out of the state label', () => {
    const { container } = renderGraph('draft', effortModel())
    const card = container.querySelector('[data-ticket="tk_203"]')
    expect(card?.querySelector('.pg-note')?.textContent).toBe('Rejected: would require DM-301')
    expect(card?.querySelector('.pg-effort')?.textContent).toBe('medium effort')
    expect(card?.querySelector('.pg-card-label')?.querySelector('.pg-effort, .pg-tags') ?? null).toBe(null)
  })
})
