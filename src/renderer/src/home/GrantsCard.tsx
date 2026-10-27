import { useCallback, useEffect, useId, useState } from 'react'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import type { GrantableRole, GrantView } from '../../../shared/domain/views'
import { useToasts } from '../app/toasts'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { formatShortDate } from '../sidebar/epicStatusLine'

interface GrantsCardProps {
  folder: TrackedFolderView
}

/** Roles a person may delegate, in the order they are usually wanted. */
const ROLES: { role: GrantableRole; label: string; note: string }[] = [
  { role: 'orchestrator', label: 'Orchestrator', note: 'Plans and runs epics: claims tickets, accepts and rejects work.' },
  { role: 'planner', label: 'Planner', note: 'Shapes epics and edits drafts; runs nothing.' },
  { role: 'worker', label: 'Worker', note: 'Does one claimed ticket and submits it.' },
  { role: 'reviewer', label: 'Reviewer', note: 'Reviews submitted attempts.' },
  { role: 'reader', label: 'Reader', note: 'Reads only. The same as presenting no grant at all.' }
]

const DURATIONS = [
  { minutes: 60, label: '1 hour' },
  { minutes: 8 * 60, label: '8 hours' },
  { minutes: 24 * 60, label: '1 day' },
  { minutes: 7 * 24 * 60, label: '7 days' }
]

/** The token, shown once. There is no way back to it: the database keeps only its hash. */
function IssuedToken({ token, onDone }: { token: string; onDone(): void }): JSX.Element {
  const toasts = useToasts()
  return (
    <div className="grant-token" role="group" aria-label="New grant token">
      <p className="inline-warning">
        <Icon name="warning" />
        <span>Copy this now — it is shown once and cannot be retrieved.</span>
      </p>
      <code className="grant-token-value mono">{token}</code>
      <div className="button-row">
        <Button
          icon="copy"
          onClick={() => {
            void window.dm.copyText(token)
            toasts.push('success', 'Token copied.')
          }}
        >
          Copy
        </Button>
        <Button onClick={onDone}>Done</Button>
      </div>
      <p className="note">
        Give it to the agent as <code>DM_SESSION_TOKEN</code>, or write it to a file and pass{' '}
        <code>--token-file</code>.
      </p>
    </div>
  )
}

interface IssueFormProps {
  busy: boolean
  onIssue(input: { role: GrantableRole; label: string; minutes: number; allowSave: boolean }): void
  onCancel(): void
}

function Field({ id, label, children }: { id: string; label: string; children: JSX.Element }): JSX.Element {
  return (
    <>
      <label htmlFor={id}>{label}</label>
      {children}
    </>
  )
}

function IssueForm({ busy, onIssue, onCancel }: IssueFormProps): JSX.Element {
  const ids = { role: useId(), label: useId(), minutes: useId() }
  const [role, setRole] = useState<GrantableRole>('orchestrator')
  const [label, setLabel] = useState('dm CLI')
  const [minutes, setMinutes] = useState(8 * 60)
  const [allowSave, setAllowSave] = useState(false)
  const canSave = role === 'orchestrator' || role === 'planner'
  return (
    <div className="grant-form">
      <Field id={ids.role} label="Role">
        <select id={ids.role} value={role} disabled={busy} onChange={(event) => setRole(event.target.value as GrantableRole)}>
          {ROLES.map((option) => (
            <option key={option.role} value={option.role}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>
      <p className="note">{ROLES.find((option) => option.role === role)?.note}</p>
      <Field id={ids.label} label="Label">
        <input id={ids.label} value={label} disabled={busy} onChange={(event) => setLabel(event.target.value)} />
      </Field>
      <Field id={ids.minutes} label="Expires after">
        <select id={ids.minutes} value={minutes} disabled={busy} onChange={(event) => setMinutes(Number(event.target.value))}>
          {DURATIONS.map((option) => (
            <option key={option.minutes} value={option.minutes}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>
      {canSave ? (
        <label className="onboarding-option-label">
          <input type="checkbox" checked={allowSave} disabled={busy} onChange={(event) => setAllowSave(event.target.checked)} />
          <span>May save plans without you pressing Save</span>
        </label>
      ) : null}
      <div className="button-row">
        <Button
          variant="primary"
          busy={busy}
          onClick={() => onIssue({ role, label: label.trim() === '' ? 'dm CLI' : label.trim(), minutes, allowSave })}
        >
          Authorize
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  )
}

function GrantRow({ grant, onRevoke }: { grant: GrantView; onRevoke(id: string): void }): JSX.Element {
  const state = grant.revokedAt !== null ? 'Revoked' : grant.active ? 'Active' : 'Expired'
  return (
    <div className="grant-row">
      <span className="grant-row-label">{grant.label}</span>
      <span className="mono muted">{grant.role}</span>
      <span className={grant.active ? 'tone-ok' : 'muted'}>{state}</span>
      <span className="muted">{grant.active ? `until ${formatShortDate(grant.expiresAt)}` : ''}</span>
      {grant.active ? (
        <Button onClick={() => onRevoke(grant.id)}>Revoke</Button>
      ) : null}
    </div>
  )
}

/**
 * Roles this folder has delegated to agent sessions. A `dm` CLI reads without one and can do
 * nothing else until a person issues a grant here, so this card is where that authority comes from.
 */
interface GrantsState {
  grants: GrantView[] | null
  busy: boolean
  token: string | null
  setToken(token: string | null): void
  issue(input: { role: GrantableRole; label: string; minutes: number; allowSave: boolean }): Promise<void>
  revoke(grantId: string): Promise<void>
}

/** Reads the folder's grants and performs the two acts a person can take on them. */
function useGrants(folderPath: string): GrantsState {
  const toasts = useToasts()
  const [grants, setGrants] = useState<GrantView[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [token, setToken] = useState<string | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    const result = await window.dm.command(folderPath, 'listGrants', undefined)
    if (result.ok) {
      // A card that cannot read its grants must not take the folder view down with it.
      setGrants(result.data ?? [])
    } else {
      toasts.push('error', result.error.message)
    }
  }, [folderPath, toasts])

  useEffect(() => {
    void reload()
  }, [reload])

  return {
    grants,
    busy,
    token,
    setToken,
    issue: async (input) => {
      setBusy(true)
      const result = await window.dm.command(folderPath, 'issueGrant', input)
      setBusy(false)
      if (!result.ok) {
        toasts.push('error', result.error.message)
        return
      }
      setToken(result.data.token)
      await reload()
    },
    revoke: async (grantId) => {
      const result = await window.dm.command(folderPath, 'revokeGrant', { grantId })
      if (result.ok) {
        toasts.push('success', 'Grant revoked.')
        await reload()
      } else {
        toasts.push('error', result.error.message)
      }
    }
  }
}

/**
 * Roles this folder has delegated to agent sessions. A `dm` CLI reads without one and can do
 * nothing else until a person issues a grant here, so this card is where that authority comes from.
 */
export function GrantsCard({ folder }: GrantsCardProps): JSX.Element {
  const state = useGrants(folder.path)
  const [issuing, setIssuing] = useState(false)
  const active = (state.grants ?? []).filter((grant) => grant.active)
  return (
    <section className="card" aria-label="Agent access">
      <h2 className="card-title">Agent access</h2>
      <p className="note">
        A <code>dm</code> session reads and nothing more until you give it a role. A grant expires, can be
        revoked, and never carries anything reserved to you — approving a checkpoint and deleting an epic stay
        here.
      </p>
      {state.token !== null ? <IssuedToken token={state.token} onDone={() => state.setToken(null)} /> : null}
      {state.grants === null ? (
        <p className="muted">Loading grants…</p>
      ) : (
        <div className="grant-list">
          {state.grants.length === 0 ? <p className="muted">No grants yet.</p> : null}
          {state.grants.map((grant) => (
            <GrantRow key={grant.id} grant={grant} onRevoke={(id) => void state.revoke(id)} />
          ))}
        </div>
      )}
      {issuing ? (
        <IssueForm
          busy={state.busy}
          onIssue={(input) => {
            setIssuing(false)
            void state.issue(input)
          }}
          onCancel={() => setIssuing(false)}
        />
      ) : (
        <div className="button-row">
          <Button icon="plus" onClick={() => setIssuing(true)}>
            Authorize an agent
          </Button>
          {active.length > 0 ? <span className="muted">{active.length} active</span> : null}
        </div>
      )}
    </section>
  )
}
