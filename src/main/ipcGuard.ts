/**
 * Sender verification for every IPC handler the main process registers. A call runs only when it
 * comes from the app's own page in the top-level frame: the packaged renderer's index.html (compared
 * by resolved file path) or, in development, the dev server's origin. Anything else (a subframe, a
 * page the window was navigated to, a frame that is already gone) is answered with the structured
 * `unauthorized` failure and the handler never runs. Free of Electron runtime imports so it can be
 * unit and mutation tested.
 */
import type { IpcMain } from 'electron'
import type { CommandResult } from '../shared/desktop/api'
import { isAppUrl } from './desktop/navigation'

/** What the guard reads from `event.senderFrame` (Electron's `WebFrameMain`). */
export interface SenderFrame {
  readonly url: string
  readonly parent: object | null
  readonly detached: boolean
  isDestroyed(): boolean
}

type IpcRegistrar = Pick<IpcMain, 'handle'>

interface IpcGuardOptions {
  /** The URL the main window loads (`resolveAppUrl`): dev server or packaged page. Null trusts nothing. */
  appUrl: string | null
  /** Told about every refused call and the sender frame's URL, so main can log it. */
  onRefused?: (channel: string, senderUrl: string) => void
}

const REFUSED_MESSAGE = 'Refused an IPC call that did not come from the Dark Mechanicus window.'

/** True only for a live, attached, top-level frame showing the app's own page. */
export function isTrustedSender(frame: SenderFrame | null | undefined, appUrl: string | null): boolean {
  if (!frame) {
    return false
  }
  try {
    return !frame.isDestroyed() && !frame.detached && frame.parent === null && isAppUrl(frame.url, appUrl)
  } catch {
    // A frame disposed mid-call throws when read; whatever it was, it is not the app page now.
    return false
  }
}

function describeSender(frame: SenderFrame | null): string {
  if (!frame) {
    return '(no frame)'
  }
  try {
    return frame.url
  } catch {
    return '(unreadable frame)'
  }
}

function refusal(): CommandResult<never> {
  return { ok: false, error: { code: 'unauthorized', message: REFUSED_MESSAGE } }
}

/**
 * Wraps `ipcMain` so that every handler registered through the result first checks the sender
 * frame. Register all IPC handlers through it; nothing else in the main process touches `ipcMain`.
 */
export function guardIpc(ipcMain: IpcRegistrar, options: IpcGuardOptions): IpcRegistrar {
  return {
    handle(channel, listener) {
      ipcMain.handle(channel, (event, ...args: unknown[]) => {
        if (isTrustedSender(event.senderFrame, options.appUrl)) {
          return listener(event, ...args)
        }
        options.onRefused?.(channel, describeSender(event.senderFrame))
        return refusal()
      })
    }
  }
}
