import type { TrackedFolderView } from '../../../shared/desktop/api'
import { Button } from '../components/Button'
import { classNames } from '../components/classNames'
import { Icon } from '../components/Icon'
import { McpSnippet } from '../components/McpSnippet'

interface OnboardingViewProps {
  folder: TrackedFolderView
  /** True while `initializeRepository` runs. */
  busy: boolean
  onInitialize(): void
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

/** Shown for a tracked folder that has no `.darkmechanicus/` yet: explains and performs setup. */
export function OnboardingView({ folder, busy, onInitialize, onChooseDifferent }: OnboardingViewProps): JSX.Element {
  return (
    <div className="onboarding">
      <Stepper />
      <header className="onboarding-head">
        <h1 className="display">{folder.name} isn’t set up for Dark Mechanicus yet</h1>
        <p className="lede">
          Plans, tickets and run history will live inside this repository so they travel with it.
          Initializing only creates files; nothing is committed or pushed.
        </p>
      </header>
      <div className="onboarding-grid">
        <section className="card card-strong" aria-label="What initializing creates">
          <span className="eyebrow">
            <span>WILL BE CREATED IN</span> <span className="eyebrow-path">{folder.displayPath}</span>
          </span>
          <CreatedFiles />
          <p className="created-note">
            <Icon name="file" />
            <span>
              Adds <code>.darkmechanicus/.gitignore</code> so <code>local/</code> is never committed
            </span>
          </p>
          <div className="button-row">
            <Button variant="primary" busy={busy} onClick={onInitialize}>
              {busy ? 'Initializing…' : 'Initialize folder'}
            </Button>
            <Button onClick={onChooseDifferent}>Choose a different folder</Button>
          </div>
        </section>
        <section className="card card-dashed" aria-label="Connect an agent">
          <McpSnippet folderPath={folder.path} heading="NEXT · CONNECT AN AGENT OVER MCP" />
          <p className="note">The MCP server runs headless, so agents can plan with this window closed.</p>
        </section>
      </div>
    </div>
  )
}
