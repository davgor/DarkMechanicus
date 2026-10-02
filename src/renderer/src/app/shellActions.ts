import type { CreateEpicInput } from '../../../shared/domain/api'
import type { ClaudeCodeConnectRequest, FolderPickResult, TrackedFolderView } from '../../../shared/desktop/api'
import type { WorkStatus } from '../../../shared/domain/status'
import type { EpicDetailView } from '../../../shared/domain/views'
import { runCommand } from '../api/dm'
import type { Selection } from './selection'
import { describeClaudeConnect, describeFlush, describeReconcile } from './shellMessages'
import type { ToastTone } from './toastState'

export type BusyKey = 'initialize' | 'flush' | 'reconcile'

/** Choices on the onboarding screen that shape what Initialize does. */
export interface InitializeOptions {
  /** Also write `.mcp.json` so Claude Code can connect. */
  writeMcpConfig: boolean
}

/** Onboarding connects Claude Code as a planner that may save, and never replaces an existing entry. */
const ONBOARDING_CONNECTION: ClaudeCodeConnectRequest = { role: 'planner', allowSave: true, replace: false }

/** Everything the actions need from the shell, so they can be exercised without React. */
interface ShellDeps {
  toasts: {
    push(tone: ToastTone, message: string): void
    reportError(error: unknown): void
  }
  folders: {
    pick(): Promise<FolderPickResult>
    untrack(path: string): Promise<void>
    reload(): Promise<void>
  }
  select(selection: Selection): void
  reveal(path: string, bucket: WorkStatus | null): void
  bucketOf(path: string, epicId: string): WorkStatus | null
  /** Refetch a folder's epic list and storage status. */
  refresh(path: string): void
  setBusy(key: BusyKey, value: boolean): void
  /** The folder Flush and Reconcile apply to. */
  selectedPath: string | null
}

export interface ShellActions {
  selectFolder(path: string): void
  selectEpic(path: string, epicId: string): void
  changed(path: string): void
  track(): Promise<void>
  untrack(path: string): Promise<void>
  initialize(folder: TrackedFolderView, options: InitializeOptions): Promise<void>
  flush(): Promise<void>
  reconcile(): Promise<void>
  /** Resolves with the new epic, or null after reporting why it could not be created. */
  createEpic(folder: TrackedFolderView, input: CreateEpicInput): Promise<EpicDetailView | null>
}

async function guarded<T>(deps: ShellDeps, work: () => Promise<T>): Promise<T | null> {
  try {
    return await work()
  } catch (error) {
    deps.toasts.reportError(error)
    return null
  }
}

/** Runs `work` while the busy flag is on, clearing it whatever happens. */
async function whileBusy(deps: ShellDeps, key: BusyKey, work: () => Promise<void>): Promise<void> {
  deps.setBusy(key, true)
  try {
    await work()
  } finally {
    deps.setBusy(key, false)
  }
}

type SelectionActions = Pick<ShellActions, 'selectFolder' | 'selectEpic' | 'changed'>

function selectionActions(deps: ShellDeps): SelectionActions {
  return {
    selectFolder: (path) => {
      deps.select({ folderPath: path, epicId: null })
      deps.reveal(path, null)
    },
    selectEpic: (path, epicId) => {
      deps.select({ folderPath: path, epicId })
      deps.reveal(path, deps.bucketOf(path, epicId))
    },
    changed: (path) => deps.refresh(path)
  }
}

function folderActions(deps: ShellDeps, selectFolder: (path: string) => void): Pick<ShellActions, 'track' | 'untrack'> {
  return {
    track: async () => {
      await guarded(deps, async () => {
        const { folder, added } = await deps.folders.pick()
        if (folder === null) return
        selectFolder(folder.path)
        if (!added) deps.toasts.push('info', `${folder.name} is already tracked.`)
      })
    },
    untrack: async (path) => {
      await guarded(deps, () => deps.folders.untrack(path))
    }
  }
}

/** Runs `work` for the selected folder, if any, reporting failures as toasts. */
async function onSelectedFolder(deps: ShellDeps, work: (path: string) => Promise<void>): Promise<void> {
  const path = deps.selectedPath
  if (path !== null) {
    await guarded(deps, () => work(path))
  }
}

function repositoryActions(deps: ShellDeps): Pick<ShellActions, 'initialize' | 'flush' | 'reconcile'> {
  return {
    initialize: (folder, options) =>
      whileBusy(deps, 'initialize', async () => {
        const initialized = await guarded(deps, async () => {
          await runCommand(folder.path, 'initializeRepository', {})
          await deps.folders.reload()
          deps.refresh(folder.path)
          deps.toasts.push('success', `Initialized ${folder.name}.`)
          return true
        })
        if (initialized === true && options.writeMcpConfig) {
          await guarded(deps, async () => {
            const notice = describeClaudeConnect(await window.dm.connectClaudeCode(folder.path, ONBOARDING_CONNECTION))
            deps.toasts.push(notice.tone, notice.message)
          })
        }
      }),
    flush: () =>
      onSelectedFolder(deps, (path) =>
        whileBusy(deps, 'flush', async () => {
          const notice = describeFlush(await runCommand(path, 'flushPortableState', undefined))
          deps.toasts.push(notice.tone, notice.message)
          deps.refresh(path)
        })
      ),
    reconcile: () =>
      onSelectedFolder(deps, (path) =>
        whileBusy(deps, 'reconcile', async () => {
          const notice = describeReconcile(await runCommand(path, 'reconcileRepository', undefined))
          deps.toasts.push(notice.tone, notice.message)
          deps.refresh(path)
        })
      )
  }
}

function epicActions(
  deps: ShellDeps,
  selectEpic: (path: string, epicId: string) => void
): Pick<ShellActions, 'createEpic'> {
  return {
    createEpic: (folder, input) =>
      guarded(deps, async () => {
        const epic = await runCommand(folder.path, 'createEpic', input)
        deps.refresh(folder.path)
        selectEpic(folder.path, epic.id)
        return epic
      })
  }
}

export function createShellActions(deps: ShellDeps): ShellActions {
  const selection = selectionActions(deps)
  return {
    ...selection,
    ...folderActions(deps, selection.selectFolder),
    ...repositoryActions(deps),
    ...epicActions(deps, selection.selectEpic)
  }
}
