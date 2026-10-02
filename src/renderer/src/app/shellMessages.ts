import type { ClaudeCodeConnectResult } from '../../../shared/desktop/api'
import type { BoardImportView, FlushResultView, ReconcileResultView } from '../../../shared/domain/views'
import { plural } from './plural'
import type { ToastTone } from './toastState'

interface Notice {
  tone: ToastTone
  message: string
}

/** Turns a flush result into the toast shown after pressing Flush. */
export function describeFlush(result: FlushResultView): Notice {
  if (result.failed > 0) {
    const reason = result.errors[0]
    const detail = reason === undefined ? '' : `: ${reason}`
    return { tone: 'error', message: `Export failed for ${plural(result.failed, 'item')}${detail}` }
  }
  if (result.flushed === 0) {
    return { tone: 'info', message: 'Nothing pending to export.' }
  }
  return { tone: 'success', message: `Exported ${plural(result.flushed, 'pending change')}.` }
}

/** Summary sentences for the parts of a reconcile that need mentioning. */
function reconcileDetails(result: ReconcileResultView): string[] {
  const details: string[] = []
  if (result.imported.length > 0) {
    details.push(`${plural(result.imported.length, 'record')} imported.`)
  }
  const conflicts = result.conflicts.length + result.profileConflicts.length
  if (conflicts > 0) {
    details.push(`${plural(conflicts, 'conflict')} to resolve.`)
  }
  if (result.rejected.length > 0) {
    details.push(`${plural(result.rejected.length, 'file')} rejected.`)
  }
  if (result.pausedRuns.length > 0) {
    details.push(`${plural(result.pausedRuns.length, 'run')} paused.`)
  }
  return details
}

/** Turns a reconcile result into a toast; rejected repository files are surfaced as an error. */
export function describeReconcile(result: ReconcileResultView): Notice {
  const details = reconcileDetails(result)
  const message = ['Reconciled.', ...(details.length > 0 ? details : ['Already up to date.'])].join(' ')
  return { tone: result.rejected.length > 0 ? 'error' : 'info', message }
}

const CONNECT_NOTICES: Record<Exclude<ClaudeCodeConnectResult['outcome'], 'invalid'>, Notice> = {
  created: { tone: 'success', message: 'Created .mcp.json for Claude Code.' },
  added: { tone: 'success', message: 'Added the darkmechanicus server to .mcp.json.' },
  replaced: { tone: 'success', message: 'Replaced the darkmechanicus entry in .mcp.json.' },
  unchanged: { tone: 'info', message: '.mcp.json already connects Claude Code with these settings.' },
  conflict: {
    tone: 'info',
    message:
      '.mcp.json already has a different darkmechanicus entry, so it was left as it is. Replace it from the MCP card on the folder home.'
  }
}

/** Turns the outcome of writing `.mcp.json` into a toast; a file that could not be read is an error. */
export function describeClaudeConnect(result: ClaudeCodeConnectResult): Notice {
  return result.outcome === 'invalid' ? { tone: 'error', message: result.message } : CONNECT_NOTICES[result.outcome]
}

/** Turns an old-style board import into a toast: what it created, and that the drafts wait for Save. */
export function describeBoardImport(result: BoardImportView): Notice {
  const created = result.open.filter((epic) => epic.state === 'created').length
  const earlier = result.open.length - created
  if (created === 0) {
    const message =
      result.open.length === 0
        ? 'Nothing to import from board/: every epic on the board is done.'
        : 'Nothing new to import from board/: every open epic was imported before.'
    return { tone: 'info', message }
  }
  const drafts =
    created === 1
      ? 'Imported 1 epic from board/ as a draft. Review it and press Save.'
      : `Imported ${created} epics from board/ as drafts. Review them and press Save.`
  const skipped = earlier > 0 ? ` Skipped ${plural(earlier, 'epic')} imported before.` : ''
  return { tone: 'success', message: `${drafts}${skipped}` }
}
