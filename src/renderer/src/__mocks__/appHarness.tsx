import { render } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import type { EpicWorkspaceProps } from '../epic/EpicWorkspace'
import type { RepoState } from '../../../shared/git/status'
import type { EpicSummaryView, StorageStatusView } from '../../../shared/domain/views'
import { App } from '../App'
import { EventLog } from './eventLog'
import { FakeAutoUpdate } from './fakeAutoUpdate'
import { FakeDm } from './fakeDm'
import { FakeGit } from './fakeGit'
import { EPIC_B, storageStatus } from './fixtures'
import { ManualScheduler } from './manualScheduler'

function cleanRepository(folder: string): RepoState {
  return {
    kind: 'repository',
    status: { root: folder, branch: { name: 'main', headOid: 'a'.repeat(40), upstream: null, ahead: 0, behind: 0 }, files: [], inProgress: null }
  }
}

/** A whole fake desktop: window.dm, window.autoUpdate, a manual scheduler and per-folder data. */
export class AppHarness {
  /** Every props object the epic view was rendered with, oldest first. */
  readonly epicProps: EpicWorkspaceProps[] = []
  readonly dm = new FakeDm()
  readonly git = new FakeGit()
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
    window.git = this.git
    // Shell tests are not about Git: a folder whose state no test set is a clean repository.
    const read = this.git.getState.bind(this.git)
    this.git.getState = async (folder) => {
      const result = await read(folder)
      return result.ok ? result : { ok: true, data: cleanRepository(folder) }
    }
  }

  /** Makes the folder page open on the Epics tab for these folders, as if the person had left them there. */
  rememberEpicsTab(...paths: string[]): void {
    window.localStorage.setItem('dm.folderTabs', JSON.stringify(Object.fromEntries(paths.map((path) => [path, 'epics']))))
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
        <button type="button" onClick={props.onDeleted}>
          stub deleted
        </button>
        <p data-testid="epic-landing">{JSON.stringify(props.landing ?? null)}</p>
        <button type="button" onClick={() => props.onLanded?.()}>
          stub landed
        </button>
        <button type="button" onClick={() => props.orchestration.onOpenChat('chat_a', 'th1')}>
          stub open thread
        </button>
      </section>
    )
  }

  mount(): RenderResult {
    return render(<App scheduler={this.scheduler} EpicView={this.epicView} />)
  }
}
