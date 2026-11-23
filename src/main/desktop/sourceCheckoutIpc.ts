/**
 * The `sourceCheckout:*` channels (`window.dm.sourceCheckout`). A new folder becomes the checkout only through the
 * native dialog in main; the renderer may name only a folder that is already tracked, which the registry
 * canonicalizes, and anything else is refused with `unauthorized` before it is read. A picked folder is inspected in
 * full (the source files and its project record) before it is tracked, so choosing the wrong folder adds nothing to
 * the folder list; should it change between that check and tracking, the refusal names the folder it tracked.
 */
import type { IpcMain } from 'electron'
import { z } from 'zod'
import { DomainError } from '../../core/errors'
import { parseInput } from '../../core/schemas'
import type { SourceCheckoutChoice, SourceCheckoutView } from '../../shared/desktop/sourceCheckout'
import type { FolderRegistry } from './folderRegistry'
import type { SourceCheckouts } from './sourceCheckout'

/** Windows long-path maximum; bounds path strings from the renderer. */
const folderSchema = z.string().min(1).max(32_767)

interface SourceCheckoutHandlerDeps {
  checkouts: SourceCheckouts
  registry: Pick<FolderRegistry, 'resolve' | 'track'>
  /** The native folder dialog for choosing the checkout; null when the person cancels. */
  pickDirectory: (suggestedPath?: string) => Promise<string | null>
}

/** Arguments are `unknown` because they come straight from IPC. */
export interface SourceCheckoutHandlers {
  getSourceCheckout(): Promise<SourceCheckoutView>
  pickSourceCheckout(): Promise<SourceCheckoutChoice>
  associateSourceCheckout(folder: unknown): Promise<SourceCheckoutChoice>
  clearSourceCheckout(): Promise<SourceCheckoutView>
}

async function pick(deps: SourceCheckoutHandlerDeps): Promise<SourceCheckoutChoice> {
  const picked = await deps.pickDirectory(deps.checkouts.suggestedPath())
  if (picked === null) {
    return { outcome: 'cancelled' }
  }
  return deps.checkouts.associatePicked(picked, deps.registry.track)
}

function associate(deps: SourceCheckoutHandlerDeps, folder: unknown): SourceCheckoutChoice {
  const tracked = deps.registry.resolve(parseInput(folderSchema, folder, 'folder'))
  if (tracked === null) {
    throw new DomainError('unauthorized', 'That folder is not tracked by Dark Mechanicus. Choose the checkout with the folder dialog instead.')
  }
  return deps.checkouts.associate(tracked, false)
}

export function createSourceCheckoutHandlers(deps: SourceCheckoutHandlerDeps): SourceCheckoutHandlers {
  return {
    getSourceCheckout: async () => deps.checkouts.view(),
    pickSourceCheckout: () => pick(deps),
    associateSourceCheckout: async (folder) => associate(deps, folder),
    clearSourceCheckout: async () => deps.checkouts.clear()
  }
}

/** Each channel forwards only its payload arguments; `get`, `pick` and `clear` take none, whatever the renderer sends. */
export function registerSourceCheckoutIpc(ipcMain: Pick<IpcMain, 'handle'>, handlers: SourceCheckoutHandlers): void {
  ipcMain.handle('sourceCheckout:get', () => handlers.getSourceCheckout())
  ipcMain.handle('sourceCheckout:pick', () => handlers.pickSourceCheckout())
  ipcMain.handle('sourceCheckout:associate', (_event, folder: unknown) => handlers.associateSourceCheckout(folder))
  ipcMain.handle('sourceCheckout:clear', () => handlers.clearSourceCheckout())
}
