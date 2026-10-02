// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { installDomShims } from '../epic/__mocks__/domShims'
import { bundle, draftPlan, runView, savedPlan, sprint } from '../epic/__mocks__/fixtures'
import { allowSlowRendering } from '../epic/__mocks__/testTiming'
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
}

function renderGraph(
  mode: 'saved' | 'draft',
  graphModel: GraphModel = model(mode)
): { recorded: Recorded; container: HTMLElement } {
  const recorded: Recorded = { selected: [], connected: [], dropped: [], removed: [], added: [] }
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
    onAddTicket: (id) => recorded.added.push(id)
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
