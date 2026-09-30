/**
 * Wires the desktop bridge to Electron: the tracked-folder registry, one Workspace per folder,
 * native dialogs, clipboard, external links, and the `dm:*` IPC channels. All logic lives in the
 * pure modules beside this file; this one is composition only, so it has no unit tests of its own.
 */
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  shell,
  type OpenDialogOptions
} from 'electron'
import { join } from 'node:path'
import { openWorkspace, type Workspace } from '../../core/workspace'
import { logger } from '../logger'
import { createFolderRegistry } from './folderRegistry'
import { createDesktopHandlers, firstPickedDirectory } from './handlers'
import { registerDesktopIpc } from './ipc'
import { buildMcpConfig } from './mcpConfig'
import { installClaudeSkills, type SkillDefinition } from './skillInstall'
import { createWorkspacePool } from './workspacePool'

/** How often each open desktop session is marked alive. */
const HEARTBEAT_INTERVAL_MS = 15_000

const FOLDER_DIALOG: OpenDialogOptions = {
  title: 'Choose a repository folder',
  properties: ['openDirectory', 'createDirectory']
}

function pickDirectory(): Promise<string | null> {
  const parent = BrowserWindow.getFocusedWindow()
  const shown = parent
    ? dialog.showOpenDialog(parent, FOLDER_DIALOG)
    : dialog.showOpenDialog(FOLDER_DIALOG)
  return shown.then(firstPickedDirectory)
}

function openDesktopWorkspace(repoRoot: string): Workspace {
  return openWorkspace({
    repoRoot,
    role: 'desktop',
    label: 'Desktop',
    transport: 'desktop',
    pid: process.pid,
    serverInfo: { name: 'darkmechanicus-desktop', version: app.getVersion() }
  })
}

/** Registers the `dm:*` IPC handlers and the background heartbeat/shutdown for open workspaces. */
export function startDesktopBridge(skills: readonly SkillDefinition[]): void {
  const registry = createFolderRegistry({
    file: join(app.getPath('userData'), 'folders.json'),
    homeDir: app.getPath('home')
  })
  const pool = createWorkspacePool(openDesktopWorkspace, (path, error) => {
    logger.error(`Workspace error for ${path}:`, error)
  })
  const handlers = createDesktopHandlers({
    registry,
    pool,
    pickDirectory,
    writeClipboard: (text) => clipboard.writeText(text),
    openExternal: (url) => shell.openExternal(url),
    mcpConfig: (repoPath) =>
      buildMcpConfig({
        packaged: app.isPackaged,
        execPath: process.execPath,
        appPath: app.getAppPath(),
        repoPath
      }),
    installSkills: (repoPath) => ({ written: installClaudeSkills(repoPath, skills) })
  })
  registerDesktopIpc(ipcMain, handlers)
  setInterval(() => pool.heartbeatAll(), HEARTBEAT_INTERVAL_MS)
  app.on('before-quit', () => pool.closeAll())
}
