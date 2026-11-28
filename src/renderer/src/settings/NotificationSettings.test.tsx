// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings as Settings } from '../../../shared/desktop/notificationSettings'
import { ToastProvider } from '../app/toasts'
import { NotificationSettings } from './NotificationSettings'

let dm: FakeDm

const stored: Settings = {
  version: 1,
  events: { approval_needed: true, question: false, checkpoint_ready: true, run_failed: false, run_stalled: true, browser_site: false },
  sound: false,
  whenFocused: 'notify',
  arbitration: { enabled: true, alwaysAsk: ['Bash', 'mcp__github__*'], autoHandleNotes: 'npm test is routine.' }
}

beforeEach(() => {
  dm = new FakeDm()
  dm.settings.notifications = structuredClone(stored)
  window.dm = dm
})

afterEach(cleanup)

async function mount(): Promise<void> {
  render(
    <ToastProvider scheduler={new ManualScheduler()}>
      <NotificationSettings />
    </ToastProvider>
  )
  await settle()
}

const box = (name: string): HTMLInputElement => screen.getByRole('checkbox', { name }) as HTMLInputElement
const radio = (name: string): HTMLInputElement => screen.getByRole('radio', { name }) as HTMLInputElement
const toggle = (): HTMLInputElement => screen.getByRole('switch', { name: 'Let the Magos arbitrate' }) as HTMLInputElement
const button = (name: string): HTMLButtonElement => screen.getByRole('button', { name }) as HTMLButtonElement
const entryInput = (): HTMLInputElement => screen.getByRole('textbox', { name: 'Always ask me' }) as HTMLInputElement
const notes = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: 'Magos auto-handles' }) as HTMLTextAreaElement
const entries = (): string[] =>
  within(screen.getByRole('list', { name: 'Always-ask entries' }))
    .getAllByRole('listitem')
    .map((item) => item.querySelector('code')?.textContent ?? '')

function addEntry(text: string): void {
  fireEvent.change(entryInput(), { target: { value: text } })
  fireEvent.click(button('Add'))
}

describe('NotificationSettings (DM-829 c1)', () => {
  it('renders every control with the stored values', async () => {
    await mount()
    expect(box('An approval needs you').checked).toBe(true)
    expect(box('A question needs you').checked).toBe(false)
    expect(box('A checkpoint is ready').checked).toBe(true)
    expect(box('A run failed').checked).toBe(false)
    expect(box('A run went quiet (5 minutes)').checked).toBe(true)
    expect(box('Play a sound').checked).toBe(false)
    const group = screen.getByRole('radiogroup', { name: 'When Dark Mechanicus is focused' })
    expect(within(group).getAllByRole('radio')).toHaveLength(2)
    expect(radio("Don't notify").checked).toBe(false)
    expect(radio('Notify anyway').checked).toBe(true)
    expect(toggle().checked).toBe(true)
    expect(toggle().getAttribute('aria-describedby')).toBeTruthy()
    const help = document.getElementById(toggle().getAttribute('aria-describedby') ?? '')
    expect(help?.textContent).toBe(
      "While a worker waits on a tool approval, the Magos's turn is blocked, so a short-lived Magos session decides allow or deny from the ticket and your rules, or asks you. Questions, paths outside the folder and tools you always want to approve are never decided for you."
    )
    expect(entries()).toEqual(['Bash', 'mcp__github__*'])
    expect(button('Remove Bash')).toBeTruthy()
    expect(screen.getByText('mcp__server__*')).toBeTruthy()
    expect(notes().value).toBe('npm test is routine.')
    expect(screen.getByText('20 / 4,000')).toBeTruthy()
    expect(button('Save').disabled).toBe(true)
    expect(button('Revert').disabled).toBe(true)
  })

  it('gives every control an accessible name', async () => {
    await mount()
    const controls = document.querySelectorAll('input, textarea, button')
    expect(controls.length).toBeGreaterThanOrEqual(15)
    for (const control of controls) {
      const name =
        control.getAttribute('aria-label') ??
        (control.id ? document.querySelector(`label[for="${control.id}"]`)?.textContent : null) ??
        control.closest('label')?.textContent ??
        control.textContent
      expect(name?.trim(), control.outerHTML).toBeTruthy()
    }
    expect(screen.getAllByRole('checkbox')).toHaveLength(7)
    expect(screen.getAllByRole('radio')).toHaveLength(2)
    expect(screen.getAllByRole('switch')).toHaveLength(1)
  })
})

describe('NotificationSettings browser_site event (DM-897 c4)', () => {
  it('shows "A site needs your approval" with the stored value and saves it in the full object', async () => {
    await mount()
    expect(box('A site needs your approval').checked).toBe(false)
    fireEvent.click(box('A site needs your approval'))
    fireEvent.click(button('Save'))
    await settle()
    expect(dm.settings.saved).toEqual([{ ...stored, events: { ...stored.events, browser_site: true } }])
    expect(box('A site needs your approval').checked).toBe(true)
  })
})

describe('NotificationSettings saving (DM-829 c1)', () => {
  it('saves the full object after toggling an event and takes main\'s answer as the new baseline', async () => {
    await mount()
    fireEvent.click(box('A question needs you'))
    expect(button('Save').disabled).toBe(false)
    expect(button('Revert').disabled).toBe(false)
    fireEvent.click(button('Save'))
    await settle()
    expect(dm.settings.saved).toEqual([{ ...stored, events: { ...stored.events, question: true } }])
    expect(box('A question needs you').checked).toBe(true)
    expect(button('Save').disabled).toBe(true)
    expect(button('Revert').disabled).toBe(true)
  })

  it('saves every edited field in one object', async () => {
    await mount()
    fireEvent.click(box('Play a sound'))
    fireEvent.click(radio("Don't notify"))
    fireEvent.click(toggle())
    fireEvent.click(button('Remove Bash'))
    addEntry(' Write ')
    fireEvent.change(notes(), { target: { value: 'Allow lint.' } })
    fireEvent.click(button('Save'))
    await settle()
    expect(dm.settings.saved).toEqual([
      {
        ...stored,
        sound: true,
        whenFocused: 'skip',
        arbitration: { enabled: false, alwaysAsk: ['mcp__github__*', 'Write'], autoHandleNotes: 'Allow lint.' }
      }
    ])
  })

  it('Revert restores the stored values', async () => {
    await mount()
    fireEvent.click(box('A run failed'))
    fireEvent.click(button('Revert'))
    expect(box('A run failed').checked).toBe(false)
    expect(button('Save').disabled).toBe(true)
  })
})

describe('NotificationSettings refusals (DM-829 c2)', () => {
  it('reverts the form and shows the notice when the person declines the native confirm', async () => {
    await mount()
    dm.settings.failures.push({ code: 'cancelled', message: 'The change was not confirmed.' })
    fireEvent.click(toggle())
    fireEvent.click(button('Remove Bash'))
    fireEvent.click(button('Save'))
    await settle()
    expect(dm.settings.saved).toHaveLength(1)
    expect(dm.settings.notifications).toEqual(stored)
    expect(toggle().checked).toBe(true)
    expect(entries()).toEqual(['Bash', 'mcp__github__*'])
    expect(screen.getByRole('status').textContent).toBe('Not changed: you did not confirm it.')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(button('Save').disabled).toBe(true)
    fireEvent.click(box('Play a sound'))
    expect(screen.queryByText('Not changed: you did not confirm it.')).toBeNull()
  })

  it('reports any other refusal as an error toast and keeps the edit', async () => {
    await mount()
    dm.settings.failures.push({ code: 'invalid_input', message: 'Settings refused.' })
    fireEvent.click(box('Play a sound'))
    fireEvent.click(button('Save'))
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('Settings refused.')
    expect(box('Play a sound').checked).toBe(true)
    expect(screen.queryByText('Not changed: you did not confirm it.')).toBeNull()
  })
})

describe('NotificationSettings inline validation (DM-829 c2)', () => {
  it('refuses a malformed entry inline and keeps the list unchanged', async () => {
    await mount()
    addEntry('rm -rf')
    const error = screen.getByRole('alert')
    expect(error.textContent).toBe('Use only letters, digits and _ . : * - (no spaces), at most 100 characters.')
    expect(entryInput().getAttribute('aria-invalid')).toBe('true')
    expect(entryInput().getAttribute('aria-describedby')).toContain(error.id)
    expect(entries()).toEqual(['Bash', 'mcp__github__*'])
    expect(button('Save').disabled).toBe(true)
  })

  it('refuses a case-insensitive duplicate inline', async () => {
    await mount()
    addEntry('BASH')
    expect(screen.getByRole('alert').textContent).toBe('BASH is already on the list.')
    expect(entries()).toEqual(['Bash', 'mcp__github__*'])
  })

  it('refuses the 51st entry inline', async () => {
    dm.settings.notifications.arbitration.alwaysAsk = Array.from({ length: 50 }, (_, index) => `tool_${index}`)
    await mount()
    addEntry('tool_50')
    expect(screen.getByRole('alert').textContent).toBe('The list holds at most 50 entries; remove one first.')
    expect(entries()).toHaveLength(50)
  })

  it('refuses notes over 4,000 characters inline and disables Save', async () => {
    await mount()
    fireEvent.change(notes(), { target: { value: 'n'.repeat(4001) } })
    expect(screen.getByText('4,001 / 4,000')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('The notes hold at most 4,000 characters; remove 1.')
    expect(notes().getAttribute('aria-invalid')).toBe('true')
    expect(button('Save').disabled).toBe(true)
    fireEvent.change(notes(), { target: { value: 'n'.repeat(4000) } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(button('Save').disabled).toBe(false)
  })

  it('loads the defaults when nothing was stored', async () => {
    dm.settings.notifications = structuredClone(DEFAULT_NOTIFICATION_SETTINGS)
    await mount()
    expect(screen.getAllByRole('checkbox').every((input) => (input as HTMLInputElement).checked)).toBe(true)
    expect(radio("Don't notify").checked).toBe(true)
    expect(screen.queryByRole('list', { name: 'Always-ask entries' })).toBeNull()
  })
})

describe('NotificationSettings always-ask error reset (DM-1018 c2)', () => {
  it('clears the always-ask refusal on Revert', async () => {
    await mount()
    fireEvent.click(box('Play a sound'))
    addEntry('rm -rf')
    expect(screen.getByRole('alert').textContent).toContain('Use only letters')
    fireEvent.click(button('Revert'))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(entryInput().getAttribute('aria-invalid')).toBe('false')
    expect(entryInput().value).toBe('')
  })

  it('clears the always-ask refusal on a successful save', async () => {
    await mount()
    fireEvent.click(box('Play a sound'))
    addEntry('BASH')
    expect(screen.getByRole('alert').textContent).toBe('BASH is already on the list.')
    fireEvent.click(button('Save'))
    await settle()
    expect(dm.settings.saved).toHaveLength(1)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(entryInput().getAttribute('aria-invalid')).toBe('false')
  })

  it('keeps the refusal when the save is refused with an error', async () => {
    await mount()
    dm.settings.failures.push({ code: 'invalid_input', message: 'Settings refused.' })
    fireEvent.click(box('Play a sound'))
    addEntry('BASH')
    fireEvent.click(button('Save'))
    await settle()
    expect(screen.getByText('BASH is already on the list.')).toBeTruthy()
  })
})

describe('NotificationSettings failed load (DM-1018 c3)', () => {
  it('shows the error with Retry instead of "Loading…" when the load rejects, and Retry loads the form', async () => {
    const load = dm.settings.getNotifications.bind(dm.settings)
    let failing = true
    dm.settings.getNotifications = () => (failing ? Promise.reject(new Error('IPC is down.')) : load())
    await mount()
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe('Could not load the notification settings. IPC is down.')
    failing = false
    fireEvent.click(button('Retry'))
    await settle()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(box('A question needs you').checked).toBe(false)
    expect(entries()).toEqual(['Bash', 'mcp__github__*'])
  })

  it('shows the refusal main answered with Retry', async () => {
    dm.settings.getNotifications = () =>
      Promise.resolve({ ok: false, error: { code: 'internal', message: 'Settings file unreadable.' } })
    await mount()
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe('Could not load the notification settings. Settings file unreadable.')
    expect(button('Retry').disabled).toBe(false)
  })
})
