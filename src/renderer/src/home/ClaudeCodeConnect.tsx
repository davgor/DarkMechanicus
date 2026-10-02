import { useId, useState } from 'react'
import { CLAUDE_CODE_ROLES, type ClaudeCodeRole, type TrackedFolderView } from '../../../shared/desktop/api'
import { describeClaudeConnect } from '../app/shellMessages'
import { useToasts } from '../app/toasts'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'

const ROLE_LABELS: Record<ClaudeCodeRole, string> = { planner: 'Planner', orchestrator: 'Orchestrator' }

interface ConnectSettings {
  role: ClaudeCodeRole
  allowSave: boolean
}

/** `.mcp.json` at the root of a folder, shown with the folder's own separator. */
function mcpJsonPath(displayPath: string): string {
  const separator = displayPath.includes('\\') ? '\\' : '/'
  return `${displayPath}${separator}.mcp.json`
}

interface ConnectFactsProps {
  target: string
  settings: ConnectSettings
  onChange(settings: ConnectSettings): void
}

/** What will be written: the file, and the role and save permission the person can change. */
function ConnectFacts({ target, settings, onChange }: ConnectFactsProps): JSX.Element {
  const roleId = useId()
  return (
    <dl className="kv connect-facts">
      <div className="kv-row">
        <dt>File</dt>
        <dd className="mono">{target}</dd>
      </div>
      <div className="kv-row">
        <dt>
          <label htmlFor={roleId}>Role</label>
        </dt>
        <dd>
          <select
            id={roleId}
            className="connect-select"
            value={settings.role}
            onChange={(event) => onChange({ ...settings, role: event.target.value as ClaudeCodeRole })}
          >
            {CLAUDE_CODE_ROLES.map((option) => (
              <option key={option} value={option}>
                {ROLE_LABELS[option]}
              </option>
            ))}
          </select>
        </dd>
      </div>
      <div className="kv-row">
        <dt>Save</dt>
        <dd>
          <label className="connect-check">
            <input
              type="checkbox"
              checked={settings.allowSave}
              onChange={(event) => onChange({ ...settings, allowSave: event.target.checked })}
            />
            <span>
              Let it save plans (<code>--allow-save</code>)
            </span>
          </label>
        </dd>
      </div>
    </dl>
  )
}

interface ReplaceConfirmProps {
  existing: string
  busy: boolean
  onReplace(): void
  onKeep(): void
}

/** Shown when `.mcp.json` already has a different `darkmechanicus` entry: replace it or keep it. */
function ReplaceConfirm({ existing, busy, onReplace, onKeep }: ReplaceConfirmProps): JSX.Element {
  return (
    <div className="connect-confirm">
      <p className="inline-warning">
        <Icon name="warning" />
        <span>.mcp.json already has a different darkmechanicus entry. Replace it?</span>
      </p>
      <pre className="code-block" tabIndex={0} aria-label="Current darkmechanicus entry">
        <code>{existing}</code>
      </pre>
      <div className="button-row">
        <Button variant="danger" busy={busy} onClick={onReplace}>
          Replace entry
        </Button>
        <Button disabled={busy} onClick={onKeep}>
          Keep current entry
        </Button>
      </div>
    </div>
  )
}

/** Writes the file and keeps the entry it would replace while the person decides. */
function useClaudeConnect(folder: TrackedFolderView, settings: ConnectSettings) {
  const toasts = useToasts()
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState<string | null>(null)

  const connect = async (replace: boolean): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.dm.connectClaudeCode(folder.path, { ...settings, replace })
      if (result.outcome === 'conflict') {
        setConflict(result.existing)
        return
      }
      setConflict(null)
      const notice = describeClaudeConnect(result)
      toasts.push(notice.tone, notice.message)
    } catch (error) {
      toasts.reportError(error)
    } finally {
      setBusy(false)
    }
  }

  return { busy, conflict, connect, keep: () => setConflict(null) }
}

/** Writes the `darkmechanicus` server into the folder's `.mcp.json` so Claude Code can connect. */
export function ClaudeCodeConnect({ folder }: { folder: TrackedFolderView }): JSX.Element {
  const [settings, setSettings] = useState<ConnectSettings>({ role: 'planner', allowSave: true })
  const { busy, conflict, connect, keep } = useClaudeConnect(folder, settings)
  return (
    <div className="connect">
      <h3 className="card-subtitle">Claude Code</h3>
      <p className="note">
        Writes the <code>darkmechanicus</code> server into <code>.mcp.json</code> at the repository root, so Claude Code
        sessions here connect to Dark Mechanicus. Other servers in the file are kept.
      </p>
      <ConnectFacts target={mcpJsonPath(folder.displayPath)} settings={settings} onChange={setSettings} />
      <p className="note">
        The file contains this machine’s path to the Dark Mechanicus app, so it only works as is on this machine.
        Whether to commit it is up to you; nothing is committed.
      </p>
      {conflict === null ? (
        <Button icon="plug" busy={busy} onClick={() => void connect(false)}>
          Connect Claude Code
        </Button>
      ) : (
        <ReplaceConfirm existing={conflict} busy={busy} onReplace={() => void connect(true)} onKeep={keep} />
      )}
    </div>
  )
}
