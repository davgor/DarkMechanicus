// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatCallsign, rootCallsignOf } from '../../../shared/agents/callsign'
import { AGENT_ROLES } from './agentRoles'
import { AgentRolePicker } from './AgentRolePicker'
import { LexmechanicArt } from './LexmechanicArt'
import { MagosArt } from './MagosArt'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const radio = (name: string): HTMLElement => screen.getByRole('radio', { name })
const card = (name: string): HTMLElement => radio(name).closest<HTMLElement>('.arc')!

function prefersReducedMotion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query === '(prefers-reduced-motion: reduce)',
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }))
}

describe('AgentRolePicker: cards', () => {
  it('renders a radiogroup of the Magos and Lexmechanic cards with their role lines, facts and labelled art', () => {
    render(<AgentRolePicker onChoose={() => undefined} />)
    const group = screen.getByRole('radiogroup', { name: 'Agent role' })
    expect(within(group).getAllByRole('radio').map((element) => element.textContent)).toEqual(['MagosOrchestrator', 'LexmechanicPlanner'])
    expect(radio('Magos').getAttribute('aria-describedby')).toBeTruthy()
    expect(within(card('Magos')).getByRole('img', { name: 'Magos: a hooded tech-priest with a cog halo' })).toBeTruthy()
    expect(within(card('Lexmechanic')).getByRole('img', { name: 'Lexmechanic: a scribe-priest with a data-slate, scrolls and a quill-servo arm' }))
      .toBeTruthy()
    expect(within(card('Magos')).getByText('Delivers each sprint to main')).toBeTruthy()
    expect(within(card('Lexmechanic')).getByText('Never runs work')).toBeTruthy()
    expect(within(card('Lexmechanic')).getAllByRole('listitem')).toHaveLength(3)
  })

  it('describes each radio with its role line and facts', () => {
    render(<AgentRolePicker onChoose={() => undefined} />)
    const description = radio('Lexmechanic').getAttribute('aria-describedby')!.split(' ')
      .map((id) => document.getElementById(id)?.textContent).join(' ')
    expect(description).toContain('Planner')
    expect(description).toContain('Saves plans when allowed')
  })

  it('names the cards with the agent tree’s root callsigns', () => {
    expect(AGENT_ROLES.map((info) => info.name)).toEqual(AGENT_ROLES.map((info) => formatCallsign(rootCallsignOf({ role: info.role, runId: 'rn_1' })!)))
  })

  it('checks the first card and keeps one radio in the tab order', () => {
    render(<AgentRolePicker onChoose={() => undefined} />)
    expect(radio('Magos').getAttribute('aria-checked')).toBe('true')
    expect(radio('Lexmechanic').getAttribute('aria-checked')).toBe('false')
    expect([radio('Magos').tabIndex, radio('Lexmechanic').tabIndex]).toEqual([0, -1])
    expect(card('Magos').classList.contains('arc-checked')).toBe(true)
  })
})

describe('AgentRolePicker: keyboard and choosing', () => {
  it('moves the checked card and focus with the arrow keys, wrapping, and Home and End', () => {
    render(<AgentRolePicker onChoose={() => undefined} />)
    fireEvent.keyDown(radio('Magos'), { key: 'ArrowRight' })
    expect(radio('Lexmechanic').getAttribute('aria-checked')).toBe('true')
    expect(radio('Magos').getAttribute('aria-checked')).toBe('false')
    expect(document.activeElement).toBe(radio('Lexmechanic'))
    expect([radio('Magos').tabIndex, radio('Lexmechanic').tabIndex]).toEqual([-1, 0])
    fireEvent.keyDown(radio('Lexmechanic'), { key: 'ArrowDown' })
    expect(radio('Magos').getAttribute('aria-checked')).toBe('true')
    fireEvent.keyDown(radio('Magos'), { key: 'ArrowLeft' })
    expect(radio('Lexmechanic').getAttribute('aria-checked')).toBe('true')
    fireEvent.keyDown(radio('Lexmechanic'), { key: 'Home' })
    expect(document.activeElement).toBe(radio('Magos'))
    fireEvent.keyDown(radio('Magos'), { key: 'End' })
    expect(document.activeElement).toBe(radio('Lexmechanic'))
  })

  it('chooses the second card with ArrowRight then Enter: onChoose receives planner', () => {
    const onChoose = vi.fn()
    render(<AgentRolePicker onChoose={onChoose} />)
    fireEvent.keyDown(radio('Magos'), { key: 'ArrowRight' })
    expect(onChoose).not.toHaveBeenCalled()
    fireEvent.keyDown(radio('Lexmechanic'), { key: 'Enter' })
    expect(onChoose.mock.calls).toEqual([['planner']])
  })

  it('chooses with Space and with a click anywhere on the card', () => {
    const onChoose = vi.fn()
    render(<AgentRolePicker onChoose={onChoose} />)
    fireEvent.keyDown(radio('Magos'), { key: ' ' })
    fireEvent.click(within(card('Lexmechanic')).getByText('Saves plans when allowed'))
    expect(onChoose.mock.calls).toEqual([['orchestrator'], ['planner']])
    expect(radio('Lexmechanic').getAttribute('aria-checked')).toBe('true')
  })
})

describe('AgentRolePicker: disabled roles and motion', () => {
  it('shows a disabled Magos’s reason and never chooses it, by click or key', () => {
    const onChoose = vi.fn()
    render(<AgentRolePicker onChoose={onChoose} disabled={{ orchestrator: 'Save the plan first' }} />)
    expect(within(card('Magos')).getByText('Save the plan first')).toBeTruthy()
    expect(radio('Magos').getAttribute('aria-disabled')).toBe('true')
    expect(card('Magos').classList.contains('arc-disabled')).toBe(true)
    const description = radio('Magos').getAttribute('aria-describedby')!.split(' ').map((id) => document.getElementById(id)?.textContent)
    expect(description).toContain('Save the plan first')
    expect(radio('Lexmechanic').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(card('Magos'))
    fireEvent.click(radio('Magos'))
    fireEvent.keyDown(radio('Lexmechanic'), { key: 'ArrowLeft' })
    expect(radio('Magos').getAttribute('aria-checked')).toBe('false')
    expect(onChoose).not.toHaveBeenCalledWith('orchestrator')
    fireEvent.keyDown(radio('Lexmechanic'), { key: 'Enter' })
    expect(onChoose.mock.calls).toEqual([['planner']])
  })

  it('keeps a disabled card checked from initial from choosing on Enter', () => {
    const onChoose = vi.fn()
    render(<AgentRolePicker onChoose={onChoose} initial="orchestrator" disabled={{ orchestrator: 'Save the plan first' }} />)
    fireEvent.keyDown(radio('Magos'), { key: 'Enter' })
    expect(onChoose).not.toHaveBeenCalled()
  })

  it('lifts on hover only without reduced motion: the motion class goes when the person prefers reduced motion', () => {
    prefersReducedMotion(false)
    render(<AgentRolePicker onChoose={() => undefined} />)
    expect(card('Magos').classList.contains('arc-motion')).toBe(true)
    cleanup()
    prefersReducedMotion(true)
    render(<AgentRolePicker onChoose={() => undefined} />)
    expect(card('Magos').classList.contains('arc-motion')).toBe(false)
    expect(card('Lexmechanic').classList.contains('arc-motion')).toBe(false)
  })
})

describe('role illustrations', () => {
  it.each([
    ['Magos', MagosArt],
    ['Lexmechanic', LexmechanicArt]
  ])('%s art is an inline, labelled SVG painted only with theme classes', (name, Art) => {
    const { container } = render(<Art size={96} />)
    const svg = screen.getByRole('img', { name: new RegExp(`^${name}: `) })
    expect(svg.tagName.toLowerCase()).toBe('svg')
    expect([svg.getAttribute('width'), svg.getAttribute('viewBox')]).toEqual(['96', '0 0 160 160'])
    expect(container.querySelector('image, foreignObject, use, [href], [xlink\\:href], [style]')).toBeNull()
    const painted = [...container.querySelectorAll('[fill], [stroke], [stop-color]')]
      .flatMap((element) => ['fill', 'stroke', 'stop-color'].map((attribute) => element.getAttribute(attribute)))
      .filter((value): value is string => value !== null)
    expect(painted.every((value) => value === 'none' || /^url\(#role-art-[A-Za-z0-9]+-(hood|robe)\)$/.test(value))).toBe(true)
  })

  it('gives two copies of an illustration their own gradient and glow ids', () => {
    const { container } = render(<><MagosArt /><MagosArt /><LexmechanicArt /></>)
    const ids = [...container.querySelectorAll('linearGradient, filter')].map((element) => element.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('colours every illustration class with a theme variable', () => {
    const css = readFileSync(join(__dirname, 'agentRoles.css'), 'utf8')
    const { container } = render(<><MagosArt /><LexmechanicArt /></>)
    const used = new Set([...container.querySelectorAll('[class]')].flatMap((element) => [...element.classList]).filter((name) => name.startsWith('ra-')))
    expect(used.size).toBeGreaterThan(5)
    for (const name of used) expect(css).toMatch(new RegExp(`\\.role-art \\.${name} \\{ (fill|stroke|stop-color): var\\(--[a-z-]+\\); \\}`))
  })
})
