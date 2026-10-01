import { render } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import type { EpicWorkspaceProps } from '../epic/EpicWorkspace'
import type { EpicSummaryView, StorageStatusView } from '../../../shared/domain/views'
import { App } from '../App'
import { EventLog } from './eventLog'
import { FakeAutoUpdate } from './fakeAutoUpdate'
import { FakeDm } from './fakeDm'
import { EPIC_B, storageStatus } from './fixtures'
import { ManualScheduler } from './manualScheduler'

/** A whole fake desktop: window.dm, window.autoUpdate, a manual scheduler and per-folder data. */
export class AppHarness {
  /** Every props object the epic view was rendered with, oldest first. */
  readonly epicProps: EpicWorkspaceProps[] = []
  readonly dm = new FakeDm()
  readonly autoUpdate = new FakeAutoUpdate()
  readonly scheduler = new ManualScheduler()
  epics: Record<string, EpicSummaryView[]> = {}
  statuses: Record<string, StorageStatusView> = {}
  private readonly logs = new Map<string, EventLog>()

  constructor() {
    this.dm.handlers.listEpics = (_input, folder) => this.epics[folder] ?? []
    this.dm.handlers.getStorageStatus = (_input, folder) =>
      this.statuses[folder] ?? storageStatus({ repoRoot: folder })
    this.dm.handlers.listEvents = (input, folder) => this.log(folder).page(input as Parameters<EventLog['page']>[0])
    window.dm = this.dm
    window.autoUpdate = this.autoUpdate
  }

  log(path: string): EventLog {
    const existing = this.logs.get(path)
    if (existing) return existing
    const created = new EventLog()
    this.logs.set(path, created)
    return created
  }

  /** Stands in for the real epic view so shell tests only rely on the props contract. */
  private readonly epicView = (props: EpicWorkspaceProps): JSX.Element => {
    this.epicProps.push(props)
    return (
      <section aria-label="Epic stub">
        <p data-testid="epic-stub">{`${props.folder.name}|${props.epicId}|${props.refreshToken}`}</p>
        <button type="button" onClick={props.onChanged}>
          stub changed
        </button>
        <button type="button" onClick={() => props.onOpenEpic(EPIC_B)}>
          stub open other
        </button>
      </section>
    )
  }

  mount(): RenderResult {
    return render(<App scheduler={this.scheduler} EpicView={this.epicView} />)
  }
}
