/**
 * The `browser_*` commands: an agent drives its GUI chat's in-app browser over the desktop's browser pipe
 * (`DM_BROWSER_PIPE`, `core.browserClient`). Each needs `browser.drive`, which only orchestrators and workers hold,
 * and the desktop app never sends them: it is the person's window onto the browser, not an agent driving it.
 * Failures carry the browser contract's fixed messages, never what the pipe sent.
 */
import { lstatSync, realpathSync, rmSync, type Stats } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { MAX_IMAGE_BYTES, resolveAllowedRootsForMachine } from '../attachments/intake'
import { requireCapability, type SessionContext } from '../authz'
import { COMMAND_SCHEMAS } from '../commandSchemas'
import { DomainError, fail } from '../errors'
import { stageAttachmentFile } from '../services/attachments'
import { BrowserControlError, type BrowserOperation, type BrowserReply } from '../../shared/browser/browserControl'
import type { CommandTable, WorkspaceCore } from './types'

type BrowserData = Extract<BrowserReply, { ok: true }>['data']

/** Checks the session and transport, sends the op, and answers with its data or the code's fixed message. */
async function send(core: WorkspaceCore, session: SessionContext, operation: BrowserOperation): Promise<BrowserData> {
  requireCapability(session, 'browser.drive')
  if (core.transport === 'desktop') {
    fail('unauthorized', 'The desktop app does not drive the agent browser; an agent session does, over its browser pipe.', {
      transport: core.transport
    })
  }
  const reply = await core.browserClient.request(operation)
  if (!reply.ok) throw new DomainError(reply.error.code, new BrowserControlError(reply.error.code).message)
  return reply.data
}

function unexpected(): never {
  throw new DomainError('internal_error', 'Unexpected desktop browser reply.')
}

/** The reply of navigate, click, type and press: only the tab (a status reply carries a tab too). */
function actionResult(data: BrowserData) {
  return 'tab' in data && !('enabled' in data) ? data : unexpected()
}

/** Where main writes the copy a screenshot leaves for its caller: one fresh directory per capture, under the temp folder. */
const SHOT_DIRECTORY = /^dm-browser-shot-[A-Za-z0-9_-]{1,32}$/

function refusedCopy(reason: string): never {
  throw new DomainError('invalid_request', `The browser screenshot copy was refused: ${reason}.`)
}

/**
 * The `dm-browser-shot-*` directory holding the screenshot copy, once it is shown to be a real directory directly
 * under the system temp folder. Anything else is refused before it is read or removed: a reply could name any path.
 */
function shotDirectory(path: string): string {
  if (!isAbsolute(path)) refusedCopy('not an absolute path')
  const file = resolve(path)
  const directory = dirname(file)
  if (!SHOT_DIRECTORY.test(basename(directory))) refusedCopy('not in a browser screenshot folder')
  let parent: string
  let temp: string
  try {
    parent = realpathSync.native(dirname(directory))
    temp = realpathSync.native(tmpdir())
  } catch {
    return refusedCopy('the temp folder cannot be resolved')
  }
  const same = process.platform === 'win32' ? parent.toLowerCase() === temp.toLowerCase() : parent === temp
  if (!same) refusedCopy('not under the system temp folder')
  let info: Stats
  try {
    info = lstatSync(directory)
  } catch {
    return refusedCopy('the folder does not exist')
  }
  // A junction or symbolic link would point the copy, and the removal, somewhere else.
  if (info.isSymbolicLink() || !info.isDirectory()) refusedCopy('the folder is a link or not a folder')
  return directory
}

/** A regular file (not a link) within the attachment size limit. */
function assertShotFile(file: string): void {
  let info: Stats
  try {
    info = lstatSync(file)
  } catch {
    return refusedCopy('the file does not exist')
  }
  if (info.isSymbolicLink() || !info.isFile()) refusedCopy('not a regular file')
  if (info.size > MAX_IMAGE_BYTES) refusedCopy('larger than the attachment limit')
}

export const browserCommands = {
  browserStatus: {
    schema: COMMAND_SCHEMAS.browserStatus,
    mutates: false,
    run: async (core, input) => {
      const data = await send(core, core.ctx().session, { op: 'browser_status', args: input })
      return 'enabled' in data ? data : unexpected()
    }
  },
  browserNavigate: {
    schema: COMMAND_SCHEMAS.browserNavigate,
    mutates: true,
    run: async (core, input) => actionResult(await send(core, core.ctx().session, { op: 'browser_navigate', args: input }))
  },
  browserClick: {
    schema: COMMAND_SCHEMAS.browserClick,
    mutates: true,
    run: async (core, input) => actionResult(await send(core, core.ctx().session, { op: 'browser_click', args: input }))
  },
  browserType: {
    schema: COMMAND_SCHEMAS.browserType,
    mutates: true,
    run: async (core, input) => actionResult(await send(core, core.ctx().session, { op: 'browser_type', args: input }))
  },
  browserPress: {
    schema: COMMAND_SCHEMAS.browserPress,
    mutates: true,
    run: async (core, input) => actionResult(await send(core, core.ctx().session, { op: 'browser_press', args: input }))
  },
  browserRead: {
    schema: COMMAND_SCHEMAS.browserRead,
    mutates: false,
    run: async (core, input) => {
      const data = await send(core, core.ctx().session, { op: 'browser_read', args: input })
      return 'untrusted' in data ? data : unexpected()
    }
  },
  browserScreenshot: {
    schema: COMMAND_SCHEMAS.browserScreenshot,
    mutates: true,
    run: async (core, input) => {
      const ctx = core.ctx()
      // Checked before the capture: a screenshot this session cannot stage would only leave a copy behind.
      requireCapability(ctx.session, 'browser.drive')
      requireCapability(ctx.session, 'attachment.write')
      const data = await send(core, ctx.session, { op: 'browser_screenshot', args: input })
      if (!('image' in data)) unexpected()
      const directory = shotDirectory(data.path)
      try {
        const file = resolve(data.path)
        assertShotFile(file)
        const roots = resolveAllowedRootsForMachine(core.repoRoot, await core.git.listWorktrees())
        // The agent's answer is the attachment; the copy's path never leaves this command.
        return stageAttachmentFile(ctx, { path: file, roots, label: input.label ?? 'Browser screenshot', purpose: 'evidence' })
      } finally {
        // Best effort: main sweeps copies nobody collected.
        try { rmSync(directory, { recursive: true, force: true }) } catch { /* swept by main */ }
      }
    }
  }
} satisfies Partial<CommandTable>
