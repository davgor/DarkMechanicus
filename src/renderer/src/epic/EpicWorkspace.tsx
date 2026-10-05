import './tones.css'
import './epic.css'
import { useCallback, useMemo } from 'react'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import { isActiveRunState } from '../../../shared/domain/status'
import type { CheckpointView, PlanView, RunView } from '../../../shared/domain/views'
import { CheckpointScreen } from '../checkpoint/CheckpointScreen'
import { EpicOverview } from '../checkpoint/EpicOverview'
import { badgeResolver, buildGraphModel, type GraphInput } from '../graph/graphModel'
import { legendKindFor } from '../graph/legend'
import { PlanGraph } from '../graph/PlanGraph'
import { TicketEditor } from '../ticket/TicketEditor'
import { TicketPanel } from '../ticket/TicketPanel'
import { AttemptsStrip } from './AttemptsStrip'
import { useNow } from './clock'
import { deleteTicketFromPlan } from './deletion'
import { DraftBar } from './DraftBar'
import { Banner, ConfirmStrip, Notices, Toast } from './Feedback'
import { headerView } from './headerView'
import { listSections } from './listSections'
import { ListView } from './ListView'
import type { OrchestrationHost } from './orchestration'
import { RunBar } from './RunBar'
import { StartRunDialog } from './StartRunDialog'
import { useWorkspace, type WorkspaceHandle } from './useWorkspace'
import { ValidationPanel } from './ValidationPanel'
import { WorkspaceHeader } from './WorkspaceHeader'
import { graphInputFor, planFor, type OverviewData } from './workspaceState'

export interface EpicWorkspaceProps {
  folder: TrackedFolderView
  epicId: string
  /** Increments whenever events arrive that may affect this epic; reload on change. */
  refreshToken: number
  /** Call after any mutation so the shell refreshes sidebar counts. */
  onChanged(): void
  /** Connected agents, the folder's chats and the navigation Start run and the run bar use. */
  orchestration: OrchestrationHost
  onOpenEpic(epicId: string): void
  /** The epic was deleted: leave it (the shell shows the folder home). */
  onDeleted(): void
}

function GraphStage({ ws, input }: { ws: WorkspaceHandle; input: GraphInput }): JSX.Element {
  const { actions, dispatch } = ws
  const model = useMemo(() => buildGraphModel(input), [input])
  const select = useCallback((ticketId: string) => dispatch({ type: 'select_ticket', ticketId }), [dispatch])
  const connect = useCallback((from: string, to: string) => void actions.connect(from, to), [actions])
  const drop = useCallback((ticketId: string, top: number) => void actions.dropTicket(model, ticketId, top), [actions, model])
  const disconnect = useCallback((from: string, to: string) => void actions.disconnect(from, to), [actions])
  const addTicket = useCallback((sprintId: string) => void actions.addTicket(sprintId), [actions])
  const addAcceptance = useCallback((sprintId: string) => void actions.addAcceptance(sprintId), [actions])
  return (
    <PlanGraph
      key={input.mode}
      model={model}
      editable={input.mode === 'draft' && !input.plan.readOnly}
      legend={legendKindFor(input.mode, input.run !== null)}
      draftNumber={input.draftNumber}
      selectedTicketId={ws.state.selectedTicketId}
      onSelectTicket={select}
      onConnect={connect}
      onDropTicket={drop}
      onRemoveDependency={disconnect}
      onAddTicket={addTicket}
      onAddAcceptance={addAcceptance}
    />
  )
}

function CheckpointStage(props: { ws: WorkspaceHandle; checkpoint: CheckpointView; run: RunView }): JSX.Element {
  const { ws, checkpoint } = props
  return (
    <CheckpointScreen
      checkpoint={checkpoint}
      run={props.run}
      bundle={ws.data.saved?.bundle ?? null}
      draft={ws.data.draft}
      now={ws.now}
      busy={ws.state.busy}
      onApprove={(reportId) => void ws.actions.approve(reportId)}
      onApproveWithRedraft={(reportId, revision) => ws.actions.approveWithRedraft(reportId, revision)}
      onRetry={(ticketId) => void ws.actions.retry(ticketId)}
      onAutoContinue={(enabled) => void ws.actions.setAutoContinue(enabled)}
      onAddFollowUp={(item) => ws.actions.addFollowUp(item, checkpoint.sprintOrdinal)}
      onEditDraft={() => void ws.actions.editDraft()}
      onSelectTicket={(ticketId) => ws.dispatch({ type: 'select_ticket', ticketId })}
    />
  )
}

function OverviewStage(props: { ws: WorkspaceHandle; overview: OverviewData; run: RunView }): JSX.Element {
  const { ws } = props
  return (
    <EpicOverview
      epic={ws.data.epic}
      run={props.run}
      overview={props.overview}
      now={ws.now}
      onSelectTicket={(ticketId) => ws.dispatch({ type: 'select_ticket', ticketId })}
    />
  )
}

/** While open: the checkpoint review of an active run, or the overview of a completed one. */
function reviewStage(ws: WorkspaceHandle): JSX.Element | null {
  const { checkpoint, overview, run } = ws.data
  if (!ws.state.checkpointOpen || run === null) {
    return null
  }
  if (checkpoint !== null) {
    return <CheckpointStage ws={ws} checkpoint={checkpoint} run={run} />
  }
  return overview === null ? null : <OverviewStage ws={ws} overview={overview} run={run} />
}

function StageContent({ ws, input }: { ws: WorkspaceHandle; input: GraphInput | null }): JSX.Element {
  const review = reviewStage(ws)
  if (review !== null) {
    return review
  }
  if (input === null) {
    return <p className="ew-empty">This epic has no plan yet.</p>
  }
  if (ws.state.layout === 'list') {
    return <ListView sections={listSections(input)} selectedTicketId={ws.state.selectedTicketId} onSelect={(ticketId) => ws.dispatch({ type: 'select_ticket', ticketId })} />
  }
  return <GraphStage ws={ws} input={input} />
}

function Stage({ ws }: { ws: WorkspaceHandle }): JSX.Element {
  const { data, view, rejected } = ws.state
  const input = useMemo(() => graphInputFor({ ...ws.state, data, view, rejected }), [data, view, rejected])
  return (
    <div className="ew-stage">
      <Banner ws={ws} />
      <StageContent ws={ws} input={input} />
    </div>
  )
}

function DraftEditorPanel(props: { ws: WorkspaceHandle; plan: PlanView; ticketId: string }): JSX.Element {
  const { ws, plan, ticketId } = props
  const input = graphInputFor(ws.state)
  const badge = input === null ? { label: 'DRAFT', tone: 'neutral' as const, dashed: false } : badgeResolver(input)(ticketId)
  const close = (): void => ws.dispatch({ type: 'select_ticket', ticketId: null })
  return (
    <TicketEditor
      key={ticketId}
      runner={ws.runner}
      bundle={plan.bundle}
      ticketId={ticketId}
      badge={badge}
      busy={ws.state.busy}
      applyOps={ws.actions.applyOps}
      onClose={close}
      onRemoved={close}
    />
  )
}

function SidePanel({ ws }: { ws: WorkspaceHandle }): JSX.Element | null {
  const ticketId = ws.state.selectedTicketId
  const plan = planFor(ws.data, ws.state.view)
  if (ticketId === null || plan === null) {
    return null
  }
  if (ws.state.view === 'draft' && !plan.readOnly) {
    return <DraftEditorPanel ws={ws} plan={plan} ticketId={ticketId} />
  }
  const key = plan.bundle.tickets.find((item) => item.id === ticketId)?.key ?? ticketId
  return (
    <TicketPanel
      key={ticketId}
      runner={ws.runner}
      epicId={ws.epicId}
      ticketId={ticketId}
      plan={plan}
      reloadKey={ws.data}
      now={ws.now}
      canEdit={ws.data.epic.status !== 'completed'}
      onEditInDraft={() => void ws.actions.editDraft()}
      onClose={() => ws.dispatch({ type: 'select_ticket', ticketId: null })}
      onSelectTicket={(id) => ws.dispatch({ type: 'select_ticket', ticketId: id })}
      onReview={(input) => ws.actions.review(input)}
      onDelete={() => deleteTicketFromPlan(ws, ticketId, key)}
    />
  )
}

/** The Start run dialog: Run with an agent, or Leave pending. The add-agent link closes it first; signing in does not. */
function StartRunHost({ ws }: { ws: WorkspaceHandle }): JSX.Element | null {
  const host = ws.orchestration
  if (!ws.state.startRunOpen) {
    return null
  }
  const close = (): void => ws.dispatch({ type: 'start_run_dialog', open: false })
  return (
    <StartRunDialog
      epicTitle={ws.data.epic.title}
      agents={host.agents}
      statuses={host.statuses}
      busy={ws.state.busy}
      onLeavePending={() => void ws.actions.startRun()}
      onRunWithAgent={(choice) => void ws.actions.startRunWithAgent(choice)}
      onAddAgent={() => {
        close()
        host.onAddAgent()
      }}
      onAgentStatus={host.onAgentStatus}
      onClose={close}
    />
  )
}

function WorkspaceView({ ws }: { ws: WorkspaceHandle }): JSX.Element {
  const draft = ws.state.view === 'draft'
  const run = ws.data.run
  const header = headerView({
    folderName: ws.folder.name,
    epic: ws.data.epic,
    view: ws.state.view,
    hasActiveRun: run !== null && isActiveRunState(run.state)
  })
  return (
    <section className="ew" aria-label="Epic workspace">
      <WorkspaceHeader ws={ws} header={header} />
      <Notices header={header} loadError={ws.state.loadError} />
      {draft ? <DraftBar ws={ws} /> : <RunBar ws={ws} />}
      <ConfirmStrip ws={ws} />
      <div className={ws.state.selectedTicketId === null ? 'ew-main' : 'ew-main has-panel'}>
        <Stage ws={ws} />
        <SidePanel ws={ws} />
      </div>
      {draft ? <ValidationPanel ws={ws} /> : <AttemptsStrip ws={ws} />}
      <Toast ws={ws} />
      <StartRunHost ws={ws} />
    </section>
  )
}

function WorkspaceStatus(props: { error: string | null; onRetry(): void }): JSX.Element {
  return (
    <section className="ew ew-status" aria-label="Epic workspace">
      {props.error === null ? (
        <p className="ew-muted">Loading epic…</p>
      ) : (
        <div role="alert" className="ew-load-error">
          <p>{props.error}</p>
          <button type="button" className="btn" onClick={props.onRetry}>
            Retry
          </button>
        </div>
      )}
    </section>
  )
}

function WorkspaceBody(props: EpicWorkspaceProps): JSX.Element {
  const controller = useWorkspace({
    folderPath: props.folder.path,
    epicId: props.epicId,
    refreshToken: props.refreshToken,
    onChanged: props.onChanged,
    onChatsChanged: props.orchestration.onChatsChanged
  })
  const now = useNow()
  const { state } = controller
  if (state.data === null) {
    return <WorkspaceStatus error={state.loadError} onRetry={controller.reload} />
  }
  const ws: WorkspaceHandle = {
    state,
    data: state.data,
    dispatch: controller.dispatch,
    actions: controller.actions,
    runner: controller.runner,
    now,
    folder: props.folder,
    epicId: props.epicId,
    orchestration: props.orchestration,
    onOpenEpic: props.onOpenEpic,
    onDeleted: props.onDeleted
  }
  return <WorkspaceView ws={ws} />
}

/** The epic workspace: plan graph or list, run and draft bars, ticket panel, checkpoint review. */
export function EpicWorkspace(props: EpicWorkspaceProps): JSX.Element {
  return <WorkspaceBody key={`${props.folder.path}\n${props.epicId}`} {...props} />
}
