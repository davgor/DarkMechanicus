import { useId, useState } from 'react'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import type { BoardImportView, StorageMode } from '../../../shared/domain/views'
import type { InitializeOptions } from '../app/shellActions'
import { useToasts } from '../app/toasts'
import { useBoardPreview } from '../app/useBoardPreview'
import { BoardPreview } from '../board/BoardPreview'
import { BoardRemoval } from '../board/BoardRemoval'
import { boardFound, newEpicCount } from '../board/boardImport'
import { Button } from '../components/Button'
import { classNames } from '../components/classNames'
import { Icon } from '../components/Icon'
import { Mascot } from '../components/Mascot'
import { McpSnippet } from '../components/McpSnippet'

interface OnboardingViewProps {
  folder: TrackedFolderView
  /** True while `initializeRepository` runs. */
  busy: boolean
  onInitialize(options: InitializeOptions): void
  onChooseDifferent(): void
}

type StepState = 'done' | 'active' | 'todo'

const STEPS: { label: string; state: StepState }[] = [
  { label: 'Choose folder', state: 'done' },
  { label: 'Initialize', state: 'active' },
  { label: 'Connect an agent', state: 'todo' }
]

function Stepper(): JSX.Element {
  return (
    <ol className="stepper" aria-label="Setup steps">
      {STEPS.map((step, index) => (
        <li
          key={step.label}
          className={classNames('step', `is-${step.state}`)}
          aria-current={step.state === 'active' ? 'step' : undefined}
        >
          <span className="step-dot">
            {step.state === 'done' ? <Icon name="check" size={12} strokeWidth={2} /> : index + 1}
          </span>
          <span>{step.label}</span>
        </li>
      ))}
    </ol>
  )
}

/** What Initialize writes into the repository, in the order it is explained. */
const CREATED: { path: string; note: string; nested: boolean; accent?: boolean }[] = [
  { path: '.darkmechanicus/', note: '', nested: false },
  { path: 'project.json', note: 'stable project ID, schema version', nested: true },
  { path: 'epics/ history/ profiles/', note: 'portable records, tracked by Git', nested: true },
  { path: 'local/', note: 'working database, ignored by Git', nested: true, accent: true }
]

function CreatedFiles(): JSX.Element {
  return (
    <div className="created-list">
      {CREATED.map((entry) => (
        <div key={entry.path} className="created-row">
          <span className={classNames('created-path mono', entry.nested && 'is-nested', entry.accent && 'is-accent')}>
            {entry.path}
          </span>
          <span className="created-note-text">{entry.note}</span>
        </div>
      ))}
    </div>
  )
}

/** What a database-only project creates instead: one database, outside the repository. */
function CreatedNothing({ name }: { name: string }): JSX.Element {
  return (
    <div className="created-list">
      <p className="created-note-text">
        Nothing is written into <strong>{name}</strong>: no <code>.darkmechanicus/</code>, no{' '}
        <code>.mcp.json</code>, no skills, nothing for Git to ignore. Epics, tickets, plan revisions,
        run history and comments all live in one database in the Dark Mechanicus home directory on this
        machine.
      </p>
      <p className="created-note-text">
        They stay on this machine: nothing travels with the repository, and a clone elsewhere sees none of it.
      </p>
    </div>
  )
}

const MODE_CHOICES = [
  {
    mode: 'repo' as const,
    label: 'In this repository',
    note: 'Plans and history are files under .darkmechanicus/, tracked by Git, so they travel with the code.'
  },
  {
    mode: 'db' as const,
    label: 'Database only',
    note: 'Nothing is written into the repository. Everything stays in one database on this machine — for a checkout whose history should not carry planning data.'
  }
]

interface StorageModeChoiceProps {
  mode: StorageMode
  disabled: boolean
  onChange(mode: StorageMode): void
}

/** Where this folder's plans, tickets and history are kept. Fixed once the project has data. */
function StorageModeChoice({ mode, disabled, onChange }: StorageModeChoiceProps): JSX.Element {
  const name = useId()
  return (
    <div className="onboarding-modes" role="radiogroup" aria-label="Where plans and history are stored">
      {MODE_CHOICES.map((choice) => (
        <label key={choice.mode} className={classNames('onboarding-mode', mode === choice.mode && 'is-selected')}>
          <input
            type="radio"
            name={name}
            value={choice.mode}
            checked={mode === choice.mode}
            disabled={disabled}
            onChange={() => onChange(choice.mode)}
          />
          <span className="onboarding-mode-label">{choice.label}</span>
          <span className="onboarding-mode-note">{choice.note}</span>
        </label>
      ))}
    </div>
  )
}

interface McpJsonOptionProps {
  checked: boolean
  disabled: boolean
  onChange(checked: boolean): void
}

/** The opt-out for writing Claude Code's `.mcp.json` along with the repository records. */
function McpJsonOption({ checked, disabled, onChange }: McpJsonOptionProps): JSX.Element {
  const noteId = useId()
  return (
    <div className="onboarding-option">
      <label className="onboarding-option-label">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-describedby={noteId}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>
          Also write <code>.mcp.json</code> so Claude Code can connect
        </span>
      </label>
      <p id={noteId} className="onboarding-option-note">
        Adds a <code>darkmechanicus</code> server (orchestrator, may plan and run epics, may save plans) to{' '}
        <code>.mcp.json</code> at the repository root. The file contains this machine’s path to the Dark Mechanicus app; whether to commit it is up to you.
      </p>
    </div>
  )
}

interface BoardImportOptionProps {
  /** Open board epics the import would create. */
  count: number
  checked: boolean
  disabled: boolean
  onChange(checked: boolean): void
}

/** The opt-in for importing an old-style board's open epics right after initializing. */
function BoardImportOption({ count, checked, disabled, onChange }: BoardImportOptionProps): JSX.Element {
  const noteId = useId()
  const label =
    count === 1 ? 'Import 1 open epic from board/ as a draft' : `Import ${count} open epics from board/ as drafts`
  return (
    <div className="onboarding-option">
      <label className="onboarding-option-label">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-describedby={noteId}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{label}</span>
      </label>
      <p id={noteId} className="onboarding-option-note">
        Each becomes a Backlog epic whose plan stays a draft until you review it and press Save. The board is shown
        below; its files are only read, and importing again later never creates duplicates.
      </p>
    </div>
  )
}

interface BoardCardProps {
  folder: TrackedFolderView
  view: BoardImportView
  /** Nothing on the board is left to import, so its old workflow files may be removed. */
  removable: boolean
}

/**
 * The old-style board this folder still has: what an import would bring in and what it leaves alone.
 * A board with nothing to import can have its old workflow files removed right here.
 */
function BoardCard({ folder, view, removable }: BoardCardProps): JSX.Element {
  const [removed, setRemoved] = useState(false)
  return (
    <section className="card board-card onboarding-board" aria-label="Old-style board">
      <h2 className="card-title">Old-style board found</h2>
      {removed ? null : (
        <>
          <p className="note">
            This folder has a Markdown <code>board/</code>. Its open epics can come in as draft plans when you
            initialize; done epics stay in Git history.{' '}
            {removable ? (
              <>Nothing is deleted unless you confirm the removal below, and nothing is committed.</>
            ) : (
              <>
                Nothing in <code>board/</code> is moved, deleted or committed.
              </>
            )}
          </p>
          <BoardPreview view={view} doneExpanded />
        </>
      )}
      {removable ? <BoardRemoval folder={folder} onRemoved={() => setRemoved(true)} /> : null}
    </section>
  )
}

function OnboardingHead({ name, mode }: { name: string; mode: StorageMode }): JSX.Element {
  return (
    <header className="onboarding-head">
      <Mascot size={96} />
      <h1 className="display">{name} isn’t set up for Dark Mechanicus yet</h1>
      <p className="lede">
        {mode === 'repo'
          ? 'Plans, tickets and run history will live inside this repository so they travel with it. Initializing only creates files; nothing is committed or pushed.'
          : 'Plans, tickets and run history will live in a database on this machine. The repository is left exactly as it is: no file is created in it, so there is nothing to commit or to explain to anyone else.'}
      </p>
    </header>
  )
}

interface SetupCardProps {
  folder: TrackedFolderView
  busy: boolean
  /** Open board epics an import would create; zero hides the option. */
  importable: number
  mode: StorageMode
  onModeChange(mode: StorageMode): void
  onInitialize(options: InitializeOptions): void
  onChooseDifferent(): void
}

/** What setting the folder up does, the choices it offers, and the button that does it. */
function SetupCard(props: SetupCardProps): JSX.Element {
  const { folder, busy, importable, mode, onModeChange } = props
  const [writeMcpConfig, setWriteMcpConfig] = useState(true)
  const [importBoard, setImportBoard] = useState(false)
  const inRepo = mode === 'repo'
  return (
    <section className="card card-strong" aria-label="What initializing creates">
      <span className="eyebrow">
        <span>{inRepo ? 'WILL BE CREATED IN' : 'NOTHING WILL BE CREATED IN'}</span>{' '}
        <span className="eyebrow-path">{folder.displayPath}</span>
      </span>
      <StorageModeChoice mode={mode} disabled={busy} onChange={onModeChange} />
      {inRepo ? <CreatedFiles /> : <CreatedNothing name={folder.name} />}
      {inRepo ? (
        <p className="created-note">
          <Icon name="file" />
          <span>
            Adds <code>.darkmechanicus/.gitignore</code> so <code>local/</code> is never committed
          </span>
        </p>
      ) : null}
      {/* A db project writes nothing into the repository, and `.mcp.json` would be a file in it. */}
      {inRepo ? <McpJsonOption checked={writeMcpConfig} disabled={busy} onChange={setWriteMcpConfig} /> : null}
      {importable > 0 ? (
        <BoardImportOption count={importable} checked={importBoard} disabled={busy} onChange={setImportBoard} />
      ) : null}
      <div className="button-row">
        <Button
          variant="primary"
          busy={busy}
          onClick={() =>
            props.onInitialize({
              mode,
              writeMcpConfig: inRepo && writeMcpConfig,
              importBoard: importable > 0 && importBoard
            })
          }
        >
          {busy ? 'Initializing…' : 'Initialize folder'}
        </Button>
        <Button onClick={props.onChooseDifferent}>Choose a different folder</Button>
      </div>
    </section>
  )
}

/** Shown for a tracked folder with no project yet: explains and performs setup. */
export function OnboardingView({ folder, busy, onInitialize, onChooseDifferent }: OnboardingViewProps): JSX.Element {
  const toasts = useToasts()
  const [mode, setMode] = useState<StorageMode>('repo')
  const preview = useBoardPreview(folder.path, 0, toasts.reportError)
  const board = preview.status === 'ready' && boardFound(preview.value) ? preview.value : null
  const importable = board === null ? 0 : newEpicCount(board)
  return (
    <div className="onboarding">
      <Stepper />
      <OnboardingHead name={folder.name} mode={mode} />
      <div className="onboarding-grid">
        <SetupCard
          folder={folder}
          busy={busy}
          importable={importable}
          mode={mode}
          onModeChange={setMode}
          onInitialize={onInitialize}
          onChooseDifferent={onChooseDifferent}
        />
        <section className="card card-dashed" aria-label="Connect an agent">
          <McpSnippet folderPath={folder.path} heading="NEXT · CONNECT AN AGENT OVER MCP" />
          <p className="note">The MCP server runs headless, so agents can plan with this window closed.</p>
        </section>
      </div>
      {board === null ? null : <BoardCard folder={folder} view={board} removable={importable === 0} />}
    </div>
  )
}
