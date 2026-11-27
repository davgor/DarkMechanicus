// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FirstPromptDialog } from './ChatDialogs'

afterEach(() => cleanup())

const PROMPT = 'Plan the refresh flow repair.'

async function start(): Promise<void> {
  fireEvent.change(screen.getByRole('textbox', { name: 'First prompt' }), { target: { value: PROMPT } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start' })) })
}

const radio = (name: string): HTMLElement => within(screen.getByRole('radiogroup', { name: 'Agent role' })).getByRole('radio', { name })

describe('FirstPromptDialog with roles', () => {
  it('shows the role picker above the prompt with Magos checked by default, and starts an orchestrator chat', async () => {
    const submit = vi.fn(async () => true)
    render(<FirstPromptDialog roles onSubmit={submit} onClose={() => {}} />)
    const group = screen.getByRole('radiogroup', { name: 'Agent role' })
    const field = screen.getByRole('textbox', { name: 'First prompt' })
    expect(group.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(radio('Magos').getAttribute('aria-checked')).toBe('true')
    expect(radio('Lexmechanic').getAttribute('aria-checked')).toBe('false')
    await start()
    expect(submit).toHaveBeenCalledExactlyOnceWith(PROMPT, 'orchestrator')
  })

  it('starts a planner chat once Lexmechanic is chosen', async () => {
    const submit = vi.fn(async () => true)
    render(<FirstPromptDialog roles onSubmit={submit} onClose={() => {}} />)
    fireEvent.click(radio('Lexmechanic'))
    expect(radio('Lexmechanic').getAttribute('aria-checked')).toBe('true')
    await start()
    expect(submit).toHaveBeenCalledExactlyOnceWith(PROMPT, 'planner')
  })

  it('submits the card the arrow keys checked, without pressing Enter on it', async () => {
    const submit = vi.fn(async () => true)
    render(<FirstPromptDialog roles onSubmit={submit} onClose={() => {}} />)
    fireEvent.keyDown(radio('Magos'), { key: 'ArrowRight' })
    expect(radio('Lexmechanic').getAttribute('aria-checked')).toBe('true')
    await start()
    expect(submit).toHaveBeenCalledExactlyOnceWith(PROMPT, 'planner')
  })
})

describe('FirstPromptDialog without roles (a summoned, project-less chat)', () => {
  it('shows no picker and submits the prompt with no role', async () => {
    const submit = vi.fn(async () => true)
    render(<FirstPromptDialog onSubmit={submit} onClose={() => {}} />)
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.queryByRole('radio')).toBeNull()
    await start()
    expect(submit).toHaveBeenCalledExactlyOnceWith(PROMPT)
  })
})
