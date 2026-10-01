import type { StorageStatusView } from '../../../shared/domain/views'
import { plural } from '../app/plural'

type FooterTone = 'ok' | 'muted' | 'warn' | 'error'

interface FooterLine {
  text: string
  tone: FooterTone
  title?: string
}

/** Agent sessions are every registered session except the desktop's own. */
export function agentSessionCount(status: StorageStatusView | null): number {
  const byRole = status?.sessions.byRole ?? {}
  return Object.entries(byRole)
    .filter(([role]) => role !== 'desktop')
    .reduce((total, [, count]) => total + count, 0)
}

export function mcpFooterLine(status: StorageStatusView | null): FooterLine {
  const agents = agentSessionCount(status)
  if (agents === 0) {
    return { text: 'Waiting for an agent', tone: 'muted' }
  }
  return { text: `${plural(agents, 'agent session')} · stdio`, tone: 'ok' }
}

function exportedLine(uncommitted: number | null): FooterLine {
  if (uncommitted === null) {
    return { text: 'Exported', tone: 'muted' }
  }
  if (uncommitted === 0) {
    return { text: 'Exported · all committed', tone: 'ok' }
  }
  return { text: `Exported · ${plural(uncommitted, 'file')} uncommitted`, tone: 'muted' }
}

export function storageFooterLine(status: StorageStatusView | null): FooterLine {
  if (status === null || !status.initialized) {
    return { text: 'Not initialized', tone: 'muted' }
  }
  if (status.outbox.failed > 0) {
    return { text: 'Export failed', tone: 'error', title: status.outbox.lastError ?? undefined }
  }
  if (status.outbox.pending > 0) {
    return { text: 'Save pending', tone: 'warn' }
  }
  return exportedLine(status.uncommittedRecordFiles)
}

/** Text of the branch-changed warning, or null when the checkout still matches the records. */
export function branchWarning(status: StorageStatusView | null): string | null {
  if (status === null || !status.branch.changed) {
    return null
  }
  const recorded = status.branch.recorded ?? 'unknown'
  const current = status.branch.current ?? 'detached HEAD'
  return `Branch changed: ${recorded} → ${current}`
}
