// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { installDomShims } from '../epic/__mocks__/domShims'
import { draftPlan, runView, savedPlan } from '../epic/__mocks__/fixtures'
import { buildGraphModel, type GraphModel } from './graphModel'
import { PlanGraph, type PlanGraphProps } from './PlanGraph'

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

function renderGraph(mode: 'saved' | 'draft'): { recorded: Recorded; container: HTMLElement } {
  const recorded: Recorded = { selected: [], connected: [], dropped: [], removed: [], added: [] }
  const props: PlanGraphProps = {
    model: model(mode),
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
  })

  it('shows the execution legend', () => {
    renderGraph('saved')
    const legend = screen.getByLabelText('Legend')
    expect(legend.textContent).toBe('AcceptedIn reviewRunningReadyWaitingFailedPrerequisite metWaiting on it')
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
