import { useCallback, useEffect, useId, useState } from 'react'
import type { SavePermissionRequestView } from '../../../shared/domain/savePermissions'
import { useToasts } from '../app/toasts'
import { Button } from '../components/Button'
import { formatShortDate } from '../sidebar/epicStatusLine'

function RequestRow({ request, busy, decide }: {
  request: SavePermissionRequestView
  busy: boolean
  decide(requestId: string, decision: 'approved' | 'denied', reason: string): Promise<void>
}): JSX.Element {
  const reasonId = useId()
  const [reason, setReason] = useState('')
  return <div className="grant-row">
    <div>
      <strong>{request.requesterLabel}</strong> · <span>{request.status}</span>
      <p>{request.reason}</p>
      <p className="note">Plan saving only in this folder · {request.grantId === null ? 'this MCP session' : 'this grant until expiry or revocation'}</p>
      <p className="muted">Requested {formatShortDate(request.requestedAt)}</p>
      <p className="muted"><code>{request.grantId ?? request.sessionId}</code></p>
      {request.status === 'pending' ? <>
        <label htmlFor={reasonId}>Decision reason</label>
        <input id={reasonId} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} />
        <div className="button-row">
          <Button disabled={busy || reason.trim() === ''} onClick={() => void decide(request.id, 'approved', reason.trim())}>Allow save</Button>
          <Button disabled={busy || reason.trim() === ''} onClick={() => void decide(request.id, 'denied', reason.trim())}>Deny</Button>
        </div>
      </> : <p className="note">{request.decisionReason} · {request.decidedAt === null ? '' : formatShortDate(request.decidedAt)} · Decided by {request.decidedBySessionId}</p>}
    </div>
  </div>
}

/** Human decisions use the same narrow, audited command as an authorized other orchestrator. */
export function SavePermissionRequests({ folder }: { folder: string }): JSX.Element {
  const toasts = useToasts()
  const [requests, setRequests] = useState<SavePermissionRequestView[]>([])
  const [busy, setBusy] = useState(false)
  const reload = useCallback(async () => {
    const result = await window.dm.command(folder, 'listSavePermissionRequests', undefined)
    if (result.ok) setRequests(result.data ?? [])
    else toasts.push('error', result.error.message)
  }, [folder, toasts])
  useEffect(() => { void reload() }, [reload])
  const decide = async (requestId: string, decision: 'approved' | 'denied', reason: string): Promise<void> => {
    setBusy(true)
    const result = await window.dm.command(folder, 'decideSavePermission', { requestId, decision, reason })
    setBusy(false)
    if (result.ok) {
      setRequests((current) => current.map((request) => request.id === requestId ? result.data : request))
      toasts.push('success', decision === 'approved' ? 'Allow save approved.' : 'Allow save denied.')
    } else toasts.push('error', result.error.message)
  }
  return <section aria-label="Allow save requests">
    <h3>Allow save requests</h3>
    <p className="note">Approval permits plan saving only. Checkpoints, retry grants and card approval stay with you.</p>
    <Button disabled={busy} onClick={() => void reload()}>Refresh requests</Button>
    {requests.length === 0 ? <p className="muted">No Allow save requests.</p> : requests.map((request) =>
      <RequestRow key={request.id} request={request} busy={busy} decide={decide} />)}
  </section>
}
