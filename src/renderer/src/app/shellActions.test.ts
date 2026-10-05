// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import { boardImport, boardOpenEpic, chatRecord, EPIC_A, epicDetail, folderView } from '../__mocks__/fixtures'
import type { ChatRecord } from '../../../shared/agents/chat'
import type { CreateChatRequest } from '../../../shared/agents/chatApi'
import type { FolderPickResult } from '../../../shared/desktop/api'
import type { WorkStatus } from '../../../shared/domain/status'
import type { Selection } from './selection'
import { createShellActions } from './shellActions'
import type { BusyKey, ShellActions } from './shellActions'
import type { ToastTone } from './toastState'

const alpha = folderView({ path: '/a', name: 'alpha' })

/** Records every effect the actions ask of the shell. */
class Recorder {
  toasts: [ToastTone, string][] = []
  errors: string[] = []
  selections: Selection[] = []
  revealed: string[] = []
  refreshed: string[] = []
  busy: string[] = []
  reloads = 0
  untracked: string[] = []
  picked: FolderPickResult = { folder: null, added: false }
  pickError: string | null = null
  untrackError: string | null = null
  buckets: Record<string, WorkStatus> = {}
  agentsRevealed: string[] = []
  chatRequests: CreateChatRequest[] = []
  /** What creating a chat answers; null stands for a failure that was already reported. */
  createdChat: ChatRecord | null = chatRecord({ id: 'chat_new_1', folder: '/a' })

  actions(selectedPath: string | null = '/a'): ShellActions {
    return createShellActions({
      toasts: {
        push: (tone, message) => this.toasts.push([tone, message]),
        reportError: (error) => this.errors.push((error as Error).message)
      },
      folders: {
        pick: () => (this.pickError === null ? Promise.resolve(this.picked) : Promise.reject(new Error(this.pickError))),
        untrack: (path) => {
          this.untracked.push(path)
          return this.untrackError === null ? Promise.resolve() : Promise.reject(new Error(this.untrackError))
        },
        reload: () => {
          this.reloads += 1
          return Promise.resolve()
        }
      },
      select: (selection) => this.selections.push(selection),
      reveal: (path, bucket) => this.revealed.push(bucket === null ? path : `${path}:${bucket}`),
      bucketOf: (path, epicId) => this.buckets[`${path}:${epicId}`] ?? null,
      revealAgents: (path) => this.agentsRevealed.push(path),
      chats: {
        create: (request) => {
          this.chatRequests.push(request)
          return Promise.resolve(this.createdChat)
        }
      },
      refresh: (path) => this.refreshed.push(path),
      setBusy: (key: BusyKey, value: boolean) => this.busy.push(`${key}:${value}`),
      selectedPath
    })
  }
}

let recorder: Recorder
let dm: FakeDm

beforeEach(() => {
  recorder = new Recorder()
  dm = new FakeDm()
  window.dm = dm
})

describe('selection actions', () => {
  it('selects a folder without an epic and reveals it', () => {
    recorder.actions().selectFolder('/a')
    expect(recorder.selections).toEqual([{ folderPath: '/a', epicId: null }])
    expect(recorder.revealed).toEqual(['/a'])
  })

  it('selects an epic and reveals its bucket', () => {
    recorder.buckets['/a:ep_1'] = 'completed'
    recorder.actions().selectEpic('/a', 'ep_1')
    expect(recorder.selections).toEqual([{ folderPath: '/a', epicId: 'ep_1' }])
    expect(recorder.revealed).toEqual(['/a:completed'])
  })

  it('reveals only the folder when the epic is not listed yet', () => {
    recorder.actions().selectEpic('/a', 'ep_new')
    expect(recorder.revealed).toEqual(['/a'])
  })

  it('asks for a refresh after a change', () => {
    recorder.actions().changed('/a')
    expect(recorder.refreshed).toEqual(['/a'])
  })
})

describe('agents panes', () => {
  it('opens the add-agent pane over the selected folder, without an epic', () => {
    recorder.actions('/a').openAddAgent()
    expect(recorder.selections).toEqual([{ folderPath: '/a', epicId: null, agentPane: { kind: 'add' } }])
  })

  it('opens an agent page over the selected folder', () => {
    recorder.actions('/a').openAgent('codex')
    expect(recorder.selections).toEqual([
      { folderPath: '/a', epicId: null, agentPane: { kind: 'agent', agent: 'codex' } }
    ])
  })

  it('opens the panes with no folder selected too', () => {
    recorder.actions(null).openAddAgent()
    expect(recorder.selections).toEqual([{ folderPath: null, epicId: null, agentPane: { kind: 'add' } }])
  })

  it('leaves the panes when a folder or an epic is selected', () => {
    recorder.actions().selectFolder('/a')
    recorder.actions().selectEpic('/a', 'ep_1')
    expect(recorder.selections.every((selection) => selection.agentPane === undefined)).toBe(true)
  })
})

describe('track', () => {
  it('selects a newly added folder', async () => {
    recorder.picked = { folder: alpha, added: true }
    await recorder.actions().track()
    expect(recorder.selections).toEqual([{ folderPath: '/a', epicId: null }])
    expect(recorder.toasts).toEqual([])
  })

  it('selects an already tracked folder and says so', async () => {
    recorder.picked = { folder: alpha, added: false }
    await recorder.actions().track()
    expect(recorder.selections).toEqual([{ folderPath: '/a', epicId: null }])
    expect(recorder.toasts).toEqual([['info', 'alpha is already tracked.']])
  })

  it('does nothing when the picker is canceled', async () => {
    await recorder.actions().track()
    expect(recorder.selections).toEqual([])
    expect(recorder.toasts).toEqual([])
  })

  it('reports a picker failure', async () => {
    recorder.pickError = 'dialog failed'
    await recorder.actions().track()
    expect(recorder.errors).toEqual(['dialog failed'])
    expect(recorder.selections).toEqual([])
  })
})

describe('untrack', () => {
  it('stops tracking the folder', async () => {
    await recorder.actions().untrack('/a')
    expect(recorder.untracked).toEqual(['/a'])
  })

  it('reports a failure', async () => {
    recorder.untrackError = 'registry locked'
    await recorder.actions().untrack('/a')
    expect(recorder.errors).toEqual(['registry locked'])
  })
})

const INIT_ONLY = { writeMcpConfig: false, importBoard: false }
const INIT_AND_CONNECT = { writeMcpConfig: true, importBoard: false }
const INIT_AND_IMPORT = { writeMcpConfig: false, importBoard: true }
const ONBOARDING_CONNECT = { role: 'orchestrator', allowSave: true, replace: false }
const IMPORTED = boardImport({ open: [boardOpenEpic({ state: 'created', epicId: EPIC_A })] })

describe('initialize', () => {
  it('initializes, reloads folders, refreshes and confirms', async () => {
    await recorder.actions().initialize(alpha, INIT_ONLY)
    expect(dm.callsOf('initializeRepository').map((call) => [call.folder, call.input])).toEqual([['/a', {}]])
    expect(recorder.reloads).toBe(1)
    expect(recorder.refreshed).toEqual(['/a'])
    expect(recorder.toasts).toEqual([['success', 'Initialized alpha.']])
    expect(dm.claudeConnects).toEqual([])
  })

  it('marks the initialization busy only while it runs', async () => {
    await recorder.actions().initialize(alpha, INIT_AND_CONNECT)
    expect(recorder.busy).toEqual(['initialize:true', 'initialize:false'])
  })

  it('reports a failure without reloading and clears busy', async () => {
    dm.failures.initializeRepository = { code: 'already_initialized', message: 'Already set up' }
    await recorder.actions().initialize(alpha, INIT_ONLY)
    expect(recorder.errors).toEqual(['Already set up'])
    expect(recorder.reloads).toBe(0)
    expect(recorder.busy).toEqual(['initialize:true', 'initialize:false'])
  })
})

describe('initialize with .mcp.json', () => {
  it('writes .mcp.json for Claude Code after initializing, and says so', async () => {
    await recorder.actions().initialize(alpha, INIT_AND_CONNECT)
    expect(dm.calls.filter((call) => call === 'connectClaudeCode')).toHaveLength(1)
    expect(dm.claudeConnects).toEqual([{ folder: '/a', request: ONBOARDING_CONNECT }])
    expect(recorder.reloads).toBe(1)
    expect(recorder.toasts).toEqual([
      ['success', 'Initialized alpha.'],
      ['success', 'Created .mcp.json for Claude Code.']
    ])
  })

  it('leaves a different existing entry alone and says where to replace it', async () => {
    dm.claudeOutcomes = [{ outcome: 'conflict', existing: '{}' }]
    await recorder.actions().initialize(alpha, INIT_AND_CONNECT)
    expect(dm.claudeConnects).toHaveLength(1)
    expect(recorder.toasts).toEqual([
      ['success', 'Initialized alpha.'],
      [
        'info',
        '.mcp.json already has a different darkmechanicus entry, so it was left as it is. Replace it from the MCP card on the folder home.'
      ]
    ])
  })

  it('does not write .mcp.json when initialization fails', async () => {
    dm.failures.initializeRepository = { code: 'unsafe_path', message: 'Cannot write here' }
    await recorder.actions().initialize(alpha, INIT_AND_CONNECT)
    expect(recorder.errors).toEqual(['Cannot write here'])
    expect(dm.claudeConnects).toEqual([])
  })

  it('reports a failed write without undoing the initialization', async () => {
    dm.rejects.connectClaudeCode = 'Refusing to write .mcp.json'
    await recorder.actions().initialize(alpha, INIT_AND_CONNECT)
    expect(recorder.errors).toEqual(['Refusing to write .mcp.json'])
    expect(recorder.toasts).toEqual([['success', 'Initialized alpha.']])
    expect(recorder.reloads).toBe(1)
    expect(recorder.busy).toEqual(['initialize:true', 'initialize:false'])
  })

  it('stays busy until .mcp.json is written', async () => {
    const busyDuringWrite: string[][] = []
    const original = dm.connectClaudeCode.bind(dm)
    dm.connectClaudeCode = (folder, request) => {
      busyDuringWrite.push([...recorder.busy])
      return original(folder, request)
    }
    await recorder.actions().initialize(alpha, INIT_AND_CONNECT)
    expect(busyDuringWrite).toEqual([['initialize:true']])
  })
})

describe('initialize with a board import', () => {
  it('imports the old board after initializing when asked, refreshes the folder and says what was created', async () => {
    dm.responses.importBoard = IMPORTED
    await recorder.actions().initialize(alpha, INIT_AND_IMPORT)
    expect(dm.commandCalls.map((call) => [call.name, call.folder, call.input])).toEqual([
      ['initializeRepository', '/a', {}],
      ['importBoard', '/a', {}]
    ])
    expect(recorder.refreshed).toEqual(['/a', '/a'])
    expect(recorder.toasts).toEqual([
      ['success', 'Initialized alpha.'],
      ['success', 'Imported 1 epic from board/ as a draft. Review it and press Save.']
    ])
    expect(recorder.busy).toEqual(['initialize:true', 'initialize:false'])
  })

  it('never imports unless asked', async () => {
    await recorder.actions().initialize(alpha, INIT_AND_CONNECT)
    expect(dm.callsOf('importBoard')).toEqual([])
  })

  it('writes .mcp.json first, then imports', async () => {
    dm.responses.importBoard = IMPORTED
    const order: string[] = []
    const connect = dm.connectClaudeCode.bind(dm)
    dm.connectClaudeCode = (folder, request) => {
      order.push(`connect:${dm.callsOf('importBoard').length}`)
      return connect(folder, request)
    }
    await recorder.actions().initialize(alpha, { writeMcpConfig: true, importBoard: true })
    expect(order).toEqual(['connect:0'])
    expect(dm.callsOf('importBoard')).toHaveLength(1)
  })

  it('does not import when initialization fails', async () => {
    dm.failures.initializeRepository = { code: 'unsafe_path', message: 'Cannot write here' }
    await recorder.actions().initialize(alpha, INIT_AND_IMPORT)
    expect(dm.callsOf('importBoard')).toEqual([])
  })

  it('reports a failed import without undoing the initialization', async () => {
    dm.failures.importBoard = { code: 'invalid_input', message: 'Bad board' }
    await recorder.actions().initialize(alpha, INIT_AND_IMPORT)
    expect(recorder.errors).toEqual(['Bad board'])
    expect(recorder.toasts).toEqual([['success', 'Initialized alpha.']])
    expect(recorder.reloads).toBe(1)
  })
})

describe('importBoard', () => {
  it('imports the folder board, refreshes its epics, says what was created and returns the result', async () => {
    dm.responses.importBoard = IMPORTED
    expect(await recorder.actions().importBoard(alpha)).toEqual(IMPORTED)
    expect(dm.callsOf('importBoard').map((call) => [call.folder, call.input])).toEqual([['/a', {}]])
    expect(recorder.refreshed).toEqual(['/a'])
    expect(recorder.toasts).toEqual([['success', 'Imported 1 epic from board/ as a draft. Review it and press Save.']])
  })

  it('reports a failure and resolves with null', async () => {
    dm.failures.importBoard = { code: 'not_initialized', message: 'Initialize first' }
    expect(await recorder.actions().importBoard(alpha)).toBeNull()
    expect(recorder.errors).toEqual(['Initialize first'])
    expect(recorder.refreshed).toEqual([])
  })
})

describe('flush', () => {
  it('flushes the selected folder and reports the outcome', async () => {
    dm.responses.flushPortableState = { flushed: 2, failed: 0, errors: [] }
    await recorder.actions('/a').flush()
    expect(dm.callsOf('flushPortableState').map((call) => call.folder)).toEqual(['/a'])
    expect(recorder.toasts).toEqual([['success', 'Exported 2 pending changes.']])
    expect(recorder.refreshed).toEqual(['/a'])
    expect(recorder.busy).toEqual(['flush:true', 'flush:false'])
  })

  it('does nothing without a selected folder', async () => {
    await recorder.actions(null).flush()
    expect(dm.commandCalls).toEqual([])
    expect(recorder.busy).toEqual([])
  })

  it('reports a failure and clears busy', async () => {
    dm.failures.flushPortableState = { code: 'internal', message: 'flush broke' }
    await recorder.actions('/a').flush()
    expect(recorder.errors).toEqual(['flush broke'])
    expect(recorder.busy).toEqual(['flush:true', 'flush:false'])
    expect(recorder.refreshed).toEqual([])
  })
})

describe('reconcile', () => {
  const clean = { imported: ['x'], unchanged: [], conflicts: [], profileConflicts: [], rejected: [], branchChanged: false, pausedRuns: [] }

  it('reconciles the selected folder and reports the summary', async () => {
    dm.responses.reconcileRepository = clean
    await recorder.actions('/a').reconcile()
    expect(dm.callsOf('reconcileRepository').map((call) => call.folder)).toEqual(['/a'])
    expect(recorder.toasts).toEqual([['info', 'Reconciled. 1 record imported.']])
    expect(recorder.refreshed).toEqual(['/a'])
    expect(recorder.busy).toEqual(['reconcile:true', 'reconcile:false'])
  })

  it('does nothing without a selected folder', async () => {
    await recorder.actions(null).reconcile()
    expect(dm.commandCalls).toEqual([])
  })

  it('reports a failure', async () => {
    dm.failures.reconcileRepository = { code: 'branch_changed', message: 'Switch back first' }
    await recorder.actions('/a').reconcile()
    expect(recorder.errors).toEqual(['Switch back first'])
    expect(recorder.busy).toEqual(['reconcile:true', 'reconcile:false'])
  })
})

describe('createEpic', () => {
  it('creates the epic, refreshes, opens it and returns it', async () => {
    const created = epicDetail({ id: 'ep_new', title: 'Ship' })
    dm.responses.createEpic = created
    const result = await recorder.actions().createEpic(alpha, { title: 'Ship' })
    expect(result).toEqual(created)
    expect(dm.callsOf('createEpic').map((call) => [call.folder, call.input])).toEqual([['/a', { title: 'Ship' }]])
    expect(recorder.refreshed).toEqual(['/a'])
    expect(recorder.selections).toEqual([{ folderPath: '/a', epicId: 'ep_new' }])
  })

  it('reports a failure and returns null without opening anything', async () => {
    dm.failures.createEpic = { code: 'invalid_input', message: 'Title too long' }
    const result = await recorder.actions().createEpic(alpha, { title: 'x' })
    expect(result).toBeNull()
    expect(recorder.errors).toEqual(['Title too long'])
    expect(recorder.selections).toEqual([])
  })
})

describe('chat actions', () => {
  it('selects a chat of a folder, and reveals the folder\'s Agents block', () => {
    recorder.actions().selectChat('/a', 'chat_1')
    expect(recorder.selections).toEqual([{ folderPath: '/a', epicId: null, chatId: 'chat_1' }])
    expect(recorder.agentsRevealed).toEqual(['/a'])
  })

  it('creates a chat in the folder with exactly the choice made, then opens it', async () => {
    const choice = { agent: 'codex', model: 'gpt-5', role: 'reviewer', allowSave: false } as const
    const created = await recorder.actions().createChat(alpha, choice)
    expect(recorder.chatRequests).toEqual([{ folder: '/a', ...choice }])
    expect(created?.id).toBe('chat_new_1')
    expect(recorder.selections).toEqual([{ folderPath: '/a', epicId: null, chatId: 'chat_new_1' }])
    expect(recorder.agentsRevealed).toEqual(['/a'])
  })

  it('selects nothing new when the chat could not be created', async () => {
    recorder.createdChat = null
    const created = await recorder.actions().createChat(alpha, { agent: 'claude', model: null, role: 'planner', allowSave: true })
    expect(created).toBeNull()
    expect(recorder.selections).toEqual([])
  })
})
