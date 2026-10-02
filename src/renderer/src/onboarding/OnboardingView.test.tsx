// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm, MCP_JSON } from '../__mocks__/fakeDm'
import { boardImport, boardOpenEpic, boardRemoval, folderView } from '../__mocks__/fixtures'
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
    expect(calls.initialize).toEqual([{ writeMcpConfig: true, importBoard: false }])
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
    expect(calls.initialize).toEqual([{ writeMcpConfig: false, importBoard: false }])
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

const importBoard = (name = 'Import 1 open epic from board/ as a draft'): HTMLInputElement =>
  screen.getByRole('checkbox', { name }) as HTMLInputElement

describe('OnboardingView old-style board preview', () => {
  it('shows no board section or import option for a folder without a board', async () => {
    renderView()
    await settle()
    expect(dm.callsOf('previewBoardImport').map((call) => call.folder)).toEqual(['/home/u/code/new-service'])
    expect(screen.queryByRole('region', { name: 'Old-style board' })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: /^Import / })).toBeNull()
  })

  it('previews the board: open epics, done epics left in history, and skipped files', async () => {
    dm.responses.previewBoardImport = boardImport()
    renderView()
    await settle()
    const board = within(screen.getByRole('region', { name: 'Old-style board' }))
    expect(board.getByText('Cross-host validation and release')).toBeTruthy()
    expect(board.getByText('2 open tickets · 1 done on the board')).toBeTruthy()
    expect((board.getByRole('group', { name: 'Done epics' }) as HTMLDetailsElement).open).toBe(true)
    expect(board.getByText('left in Git history, not imported')).toBeTruthy()
    expect(board.getByText('Desktop experience mockups')).toBeTruthy()
    expect(board.getByText('board/backlog/notes.txt')).toBeTruthy()
    expect(board.getByText('is not a Markdown file')).toBeTruthy()
  })
})

describe('OnboardingView old-style board import option', () => {
  it('offers the import off by default, so importing takes an explicit choice', async () => {
    dm.responses.previewBoardImport = boardImport()
    const calls = renderView()
    await settle()
    expect(importBoard().checked).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Initialize folder' }))
    expect(calls.initialize).toEqual([{ writeMcpConfig: true, importBoard: false }])
  })

  it('imports after initializing when the person chooses it, and says what that does', async () => {
    dm.responses.previewBoardImport = boardImport({ open: [boardOpenEpic(), boardOpenEpic({ boardId: '021' })] })
    const calls = renderView()
    await settle()
    fireEvent.click(importBoard('Import 2 open epics from board/ as drafts'))
    fireEvent.click(screen.getByRole('button', { name: 'Initialize folder' }))
    expect(calls.initialize).toEqual([{ writeMcpConfig: true, importBoard: true }])
    expect(
      screen.getByText(/Each becomes a Backlog epic whose plan stays a draft until you review it and press Save/)
    ).toBeTruthy()
  })

  it('offers no import when every epic on the board is done', async () => {
    dm.responses.previewBoardImport = boardImport({ open: [] })
    const calls = renderView()
    await settle()
    expect(screen.getByRole('region', { name: 'Old-style board' })).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: /^Import / })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Initialize folder' }))
    expect(calls.initialize).toEqual([{ writeMcpConfig: true, importBoard: false }])
  })

  it('locks the import option while initializing', async () => {
    dm.responses.previewBoardImport = boardImport()
    renderView(true)
    await settle()
    expect(importBoard().disabled).toBe(true)
  })
})

describe('OnboardingView removal of the old workflow', () => {
  const offer = (): HTMLElement | null =>
    within(screen.getByRole('region', { name: 'Old-style board' })).queryByRole('region', {
      name: 'Remove the old board workflow'
    })

  it('offers no removal while the board has open epics to import', async () => {
    dm.responses.previewBoardImport = boardImport()
    renderView()
    await settle()
    expect(offer()).toBeNull()
    expect(screen.getByText(/Nothing in/).textContent).toContain('is moved, deleted or committed')
  })

  it('offers the removal for a board whose epics are all done, and says nothing goes without confirming', async () => {
    dm.responses.previewBoardImport = boardImport({ open: [] })
    dm.boardRemoval = boardRemoval()
    renderView()
    await settle()
    const removal = offer()
    expect(removal).not.toBeNull()
    expect(screen.getByText(/unless you confirm the removal below/)).toBeTruthy()
    fireEvent.click(within(removal as HTMLElement).getByRole('button', { name: 'Review files to remove' }))
    await settle()
    expect(within(removal as HTMLElement).getByRole('region', { name: 'Files to delete' })).toBeTruthy()
    expect(dm.boardRemovals).toEqual([])
  })
})
