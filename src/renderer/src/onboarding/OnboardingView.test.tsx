// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm, MCP_JSON } from '../__mocks__/fakeDm'
import { folderView } from '../__mocks__/fixtures'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import type { InitializeOptions } from '../app/shellActions'
import { ToastProvider } from '../app/toasts'
import { OnboardingView } from './OnboardingView'

let dm: FakeDm

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
})

afterEach(cleanup)

const folder = folderView({
  path: '/home/u/code/new-service',
  name: 'new-service',
  displayPath: '~/code/new-service',
  initialized: false
})

interface Calls {
  initialize: InitializeOptions[]
  different: number
}

function renderView(busy = false): Calls {
  const calls: Calls = { initialize: [], different: 0 }
  render(
    <ToastProvider scheduler={new ManualScheduler()}>
      <OnboardingView
        folder={folder}
        busy={busy}
        onInitialize={(options) => {
          calls.initialize.push(options)
        }}
        onChooseDifferent={() => {
          calls.different += 1
        }}
      />
    </ToastProvider>
  )
  return calls
}

describe('OnboardingView header', () => {
  it('shows the three setup steps with initialize as the current one', () => {
    renderView()
    const steps = within(screen.getByRole('list', { name: 'Setup steps' })).getAllByRole('listitem')
    expect(steps.map((step) => step.textContent)).toEqual(['Choose folder', '2Initialize', '3Connect an agent'])
    expect(steps.map((step) => step.getAttribute('aria-current'))).toEqual([null, 'step', null])
    expect(steps[0]?.className).toContain('is-done')
    expect(steps[0]?.querySelector('[data-icon="check"]')).not.toBeNull()
  })

  it('headlines the folder that is not set up yet', () => {
    renderView()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'new-service isn’t set up for Dark Mechanicus yet'
    )
  })

  it('shows the tech-priest with the setup heading, as a decorative image', () => {
    renderView()
    const head = screen.getByRole('heading', { level: 1 }).closest('.onboarding-head') as HTMLElement
    const image = head.querySelector('img')
    expect(image).toBeTruthy()
    expect(image?.getAttribute('alt')).toBe('')
    expect(image?.getAttribute('src')).toMatch(/brand-icon-128.*\.png$/)
    expect(image?.getAttribute('width')).toBe('96')
    expect(document.querySelectorAll('.onboarding img')).toHaveLength(1)
  })

  it('promises that initializing only creates files', () => {
    renderView()
    expect(
      screen.getByText(
        'Plans, tickets and run history will live inside this repository so they travel with it. Initializing only creates files; nothing is committed or pushed.'
      )
    ).toBeTruthy()
  })
})

describe('OnboardingView creation plan', () => {
  it('says where the files will be created', () => {
    renderView()
    expect(screen.getByText('WILL BE CREATED IN').parentElement?.textContent).toBe(
      'WILL BE CREATED IN ~/code/new-service'
    )
  })

  it('lists what gets created and how Git treats it', () => {
    renderView()
    const list = within(document.querySelector('.created-list') as HTMLElement)
    for (const text of [
      '.darkmechanicus/',
      'project.json',
      'stable project ID, schema version',
      'epics/ history/ profiles/',
      'portable records, tracked by Git',
      'local/',
      'working database, ignored by Git'
    ]) {
      expect(list.getByText(text)).toBeTruthy()
    }
  })

  it('notes the gitignore entry', () => {
    renderView()
    expect(document.querySelector('.created-note')?.textContent).toBe(
      'Adds .darkmechanicus/.gitignore so local/ is never committed'
    )
  })
})

const writeMcpJson = (): HTMLInputElement =>
  screen.getByRole('checkbox', { name: 'Also write .mcp.json so Claude Code can connect' }) as HTMLInputElement

describe('OnboardingView actions', () => {
  it('initializes on request', () => {
    const calls = renderView()
    fireEvent.click(screen.getByRole('button', { name: 'Initialize folder' }))
    expect(calls.initialize).toEqual([{ writeMcpConfig: true }])
  })

  it('offers a different folder', () => {
    const calls = renderView()
    fireEvent.click(screen.getByRole('button', { name: 'Choose a different folder' }))
    expect(calls.different).toBe(1)
  })

  it('shows progress and blocks a second press while initializing', () => {
    renderView(true)
    const button = screen.getByRole('button', { name: 'Initializing…' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(writeMcpJson().disabled).toBe(true)
  })
})

describe('OnboardingView Claude Code option', () => {
  it('offers to write .mcp.json as well, on by default', () => {
    renderView()
    expect(writeMcpJson().checked).toBe(true)
    expect(writeMcpJson().disabled).toBe(false)
  })

  it('explains what the file holds and that committing it is up to the person', () => {
    renderView()
    expect(document.querySelector('.onboarding-option-note')?.textContent).toBe(
      'Adds a darkmechanicus server (planner, may save plans) to .mcp.json at the repository root. The file contains this machine’s path to the Dark Mechanicus app; whether to commit it is up to you.'
    )
  })

  it('initializes without writing .mcp.json when the option is turned off', () => {
    const calls = renderView()
    fireEvent.click(writeMcpJson())
    fireEvent.click(screen.getByRole('button', { name: 'Initialize folder' }))
    expect(writeMcpJson().checked).toBe(false)
    expect(calls.initialize).toEqual([{ writeMcpConfig: false }])
  })
})

describe('OnboardingView MCP card', () => {
  it('shows the MCP config for the folder and the headless note', async () => {
    renderView()
    await settle()
    expect(dm.calls).toContain('getMcpConfig:/home/u/code/new-service')
    expect(screen.getByText('NEXT · CONNECT AN AGENT OVER MCP')).toBeTruthy()
    expect(screen.getByLabelText('MCP server configuration').textContent).toBe(MCP_JSON)
    expect(
      screen.getByText('The MCP server runs headless, so agents can plan with this window closed.')
    ).toBeTruthy()
  })

  it('copies the snippet', async () => {
    renderView()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await settle()
    expect(dm.copied).toEqual([MCP_JSON])
  })
})
