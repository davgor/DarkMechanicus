import './tones.css'
import './epic.css'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { folderIdentity } from '../app/folderList'
import { errorMessage } from '../api/dm'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import { isActiveRunState } from '../../../shared/domain/status'
import type { CheckpointView, PlanView, RunView } from '../../../shared/domain/views'
import type { EpicLanding } from '../app/landing'
import { browserScheduler, type Scheduler } from '../app/scheduler'
import { useRepositories } from '../app/useRepositories'
import { CheckpointScreen } from '../checkpoint/CheckpointScreen'
import { EpicOverview } from '../checkpoint/EpicOverview'
import type { CorrectionHost } from '../checkpoint/CorrectivePlanner'
import type { ReportScoreSource } from '../checkpoint/ReportScorecard'
import { badgeResolver, buildGraphModel, type GraphInput } from '../graph/graphModel'
import { legendKindFor } from '../graph/legend'
import { PlanGraph } from '../graph/PlanGraph'
import { TicketEditor } from '../ticket/TicketEditor'
import { TicketPanel } from '../ticket/TicketPanel'
import { AttemptsStrip } from './AttemptsStrip'
import { useNow } from './clock'
import { deleteTicketFromPlan } from './deletion'
import { DraftBar } from './DraftBar'
import { EpicScorecard } from './EpicScorecard'
import { Banner, ConfirmStrip, Notices, Toast } from './Feedback'
import { headerView } from './headerView'
import { TransferredPanel, TransferStrip } from './LinearTransfer'
import { listSections } from './listSections'
import { ListView } from './ListView'
import { OrchestratorMessages } from './OrchestratorMessages'
import type { OrchestrationHost } from './orchestration'
import { RunBar } from './RunBar'
import { failureOf } from './runner'
import { StartRunDialog } from './StartRunDialog'
import { TransferDialog } from './TransferDialog'
import { isOpenTransfer } from './transferView'
import { useLanding } from './useLanding'
import { useWorkspace, type WorkspaceHandle } from './useWorkspace'
import { ValidationPanel } from './ValidationPanel'
import { WorkspaceHeader } from './WorkspaceHeader'
import { loadOverview } from './workspaceLoad'
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
  /** Opens an epic of another tracked folder (a correction epic in the Dark Mechanicus checkout, or the epic that asked for one). */
  onOpenFolderEpic?(folderPath: string, epicId: string): void
  /** Another tracked folder's records changed from here (a correction epic created in it): its sidebar lists it again. */
  onFolderChanged?(folderPath: string): void
  /** The epic was deleted: leave it (the shell shows the folder home). */
  onDeleted(): void
  /** Timers for polling the run feed; the browser's unless a test brings its own. */
  scheduler?: Scheduler
  /** A request from another screen (a link in a chat, a Metrics dashboard row or gap) to open a ticket or the epic's Scorecard, taken once the epic has loaded. */
  landing?: EpicLanding | null
  /** The request was taken: the shell forgets it. */
  onLanded?(): void
}

function GraphStage({ ws, input }: { ws: WorkspaceHandle; input: GraphInput }): JSX.Element {
  const { actions, dispatch } = ws
  const model = useMemo(() => buildGraphModel(input), [input])
  const select = useCallback((ticketId: string) => dispatch({ type: 'select_ticket', ticketId }), [dispatch])
  const openActivity = useCallback(
    (ticketId: string, attemptId: string) => dispatch({ type: 'open_activity', ticketId, attemptId }),
    [dispatch]
  )
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
      onOpenActivity={openActivity}
    />
  )
}

/** Where report Scorecard tabs read: this folder, the workspace's timers, and a version that moves on every reload. */
function scoreSource(ws: WorkspaceHandle): ReportScoreSource {
  return { folderPath: ws.folder.path, scheduler: ws.scheduler, version: ws.state.loadedAt ?? 0 }
}

/**
 * What a report's Improvement tab plans corrective work with: previews and creations through the workspace (draft work
 * only), the plan's sprints to pick a later one, and the normal draft controls to review and Save it: this epic's draft
 * view, or another (follow-up) epic.
 */
function correctionHost(ws: WorkspaceHandle): CorrectionHost {
  const plan = ws.data.draft ?? ws.data.saved
  return {
    busy: ws.state.busy,
    sprints: (plan?.bundle.sprints ?? []).map((sprint) => ({ id: sprint.id, ordinal: sprint.ordinal, goal: sprint.goal })),
    draftRevision: ws.data.draft?.draftRevision ?? null,
    preview: ws.actions.previewCorrections,
    create: ws.actions.createCorrections,
    openDraft: (epicId) => (epicId === ws.epicId ? void ws.actions.editDraft() : ws.onOpenEpic(epicId)),
    openFolderEpic: ws.onOpenFolderEpic,
    folderChanged: ws.onFolderChanged,
    reload: ws.reload
  }
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
      scores={scoreSource(ws)}
      corrections={correctionHost(ws)}
      onSelectTicket={(ticketId) => ws.dispatch({ type: 'select_ticket', ticketId })}
    />
  )
}

function OverviewStage({ ws, run }: { ws: WorkspaceHandle; run: RunView }): JSX.Element {
  const { runner, epicId, data } = ws
  const [result, setResult] = useState<{ overview: OverviewData | null; error: string | null }>({ overview: null, error: null })
  useEffect(() => {
    let active = true
    void loadOverview(runner, epicId, run, data.saved).then(
      overview => { if (active) setResult({ overview, error: null }) },
      error => { if (active) setResult(previous => ({ ...previous, error: errorMessage(error) })) }
    )
    return () => { active = false }
  }, [runner, epicId, run, data.saved])
  const notice = result.error === null ? null : <p role="alert" className="ew-notice-error">{result.error}</p>
  if (result.overview === null) return notice ?? <p role="status" className="ew-muted">Loading epic report…</p>
  return <>{notice}
    <EpicOverview
      epic={ws.data.epic}
      run={run}
      overview={result.overview}
      now={ws.now}
      scores={scoreSource(ws)}
      corrections={correctionHost(ws)}
      onSelectTicket={(ticketId) => ws.dispatch({ type: 'select_ticket', ticketId })}
    />
  </>
}

/** While open: the checkpoint review of an active run, or the overview of a completed one. */
function reviewStage(ws: WorkspaceHandle): JSX.Element | null {
  const { checkpoint, run } = ws.data
  if (!ws.state.checkpointOpen || run === null) {
    return null
  }
  if (checkpoint !== null) {
    return <CheckpointStage ws={ws} checkpoint={checkpoint} run={run} />
  }
  return run.state === 'completed' ? <OverviewStage key={run.id} ws={ws} run={run} /> : null
}

/** The plan of the shown view: the graph or the list. */
function PlanContent({ ws, input }: { ws: WorkspaceHandle; input: GraphInput | null }): JSX.Element {
  const sections = useMemo(() => input === null || ws.state.layout !== 'list' ? [] : listSections(input), [input, ws.state.layout])
  if (input === null) return <p className="ew-empty">This epic has no plan yet.</p>
  if (ws.state.layout === 'list') {
    return (
      <ListView
        sections={sections}
        selectedTicketId={ws.state.selectedTicketId}
        onSelect={(ticketId) => ws.dispatch({ type: 'select_ticket', ticketId })}
        onOpenActivity={(ticketId, attemptId) => ws.dispatch({ type: 'open_activity', ticketId, attemptId })}
      />
    )
  }
  return <GraphStage ws={ws} input={input} />
}

/**
 * The epic's Scorecard, or the checkpoint review or overview, while open; otherwise the plan, under the Linear handoff
 * of an epic a transfer completed.
 */
function StageContent({ ws, input }: { ws: WorkspaceHandle; input: GraphInput | null }): JSX.Element {
  if (ws.state.scorecardOpen) {
    return <EpicScorecard ws={ws} />
  }
  const review = reviewStage(ws)
  if (review !== null) {
    return review
  }
  return (
    <>
      <TransferredPanel ws={ws} />
      <PlanContent ws={ws} input={input} />
    </>
  )
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
  const repositories = useRepositories(ws.folder.path, (error) => ws.dispatch({ type: 'banner', text: failureOf(error).message }))
  return (
    <TicketEditor
      key={ticketId}
      runner={ws.runner}
      folderKey={ws.folder.attachmentKey}
      workspaceIdentity={folderIdentity(ws.folder)}
      bundle={plan.bundle}
      repositories={repositories.status === 'ready' ? repositories.value : null}
      ticketId={ticketId}
      badge={badge}
      busy={ws.state.busy}
      epicId={ws.epicId}
      runId={ws.data.run?.id ?? null}
      runEnded={ws.data.run?.endedAt != null}
      draftRevision={plan.draftRevision}
      applyOps={ws.actions.applyOps}
      setBudget={(budget) => ws.actions.setTicketBudget(ticketId, budget)}
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
      folderPath={ws.folder.path}
      folderKey={ws.folder.attachmentKey}
      activity={ws.state.activity}
      scorecard={ws.state.ticketScorecard}
      scheduler={ws.scheduler}
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
      onOpenChat={ws.orchestration.onOpenChat}
      onDelete={() => deleteTicketFromPlan(ws, ticketId, key)}
    />
  )
}

/** The Start run dialog: Run with an agent, or Leave pending. The add-agent link closes it first; signing in does not. */
function StartRunHost({ ws }: { ws: WorkspaceHandle }): JSX.Element | null {
  const host = ws.orchestration
  // A pending or failed getProject must not block the dialog: it opens at once, and the branch field appears once the
  // project shows a folder of repositories. The server's queue_run refusal stays the guard meanwhile.
  const repositories = useRepositories(ws.state.startRunOpen ? ws.folder.path : null, () => undefined)
  if (!ws.state.startRunOpen) {
    return null
  }
  const close = (): void => ws.dispatch({ type: 'start_run_dialog', open: false })
  return (
    <StartRunDialog
      epicTitle={ws.data.epic.title}
      folderPath={ws.folder.path}
      agents={host.agents}
      statuses={host.statuses}
      multiRepo={repositories.status === 'ready' && repositories.value !== null}
      branchName={ws.data.epic.branch?.name ?? null}
      onSetBranch={(name) => ws.actions.setEpicBranch(name)}
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

/** The Transfer to Linear dialog, to authorize a transfer or to start an agent on the open one again. */
function TransferHost({ ws }: { ws: WorkspaceHandle }): JSX.Element | null {
  const host = ws.orchestration
  const mode = ws.state.transferDialog
  if (mode === null) {
    return null
  }
  const close = (): void => ws.dispatch({ type: 'transfer_dialog', mode: null })
  return (
    <TransferDialog
      epicTitle={ws.data.epic.title}
      mode={mode}
      agents={host.agents}
      statuses={host.statuses}
      busy={ws.state.busy}
      onTransferWithAgent={(choice) => void ws.actions.transferWithAgent(choice, mode)}
      onCopyPrompt={() => void ws.actions.copyTransferPrompt(mode)}
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
    hasActiveRun: run !== null && isActiveRunState(run.state),
    hasOpenTransfer: isOpenTransfer(ws.data.transfer?.status ?? null)
  })
  return (
    <section className="ew" aria-label="Epic workspace">
      <WorkspaceHeader ws={ws} header={header} />
      <Notices header={header} loadError={ws.state.loadError} />
      {draft ? <DraftBar ws={ws} /> : <RunBar ws={ws} />}
      <TransferStrip ws={ws} />
      <ConfirmStrip ws={ws} />
      <div className={ws.state.selectedTicketId === null ? 'ew-main' : 'ew-main has-panel'}>
        <Stage ws={ws} />
        <SidePanel ws={ws} />
      </div>
      {draft ? <ValidationPanel ws={ws} saveUnavailable={header.actions.saveUnavailable} /> : <AttemptsStrip ws={ws} />}
      <OrchestratorMessages ws={ws} />
      <Toast ws={ws} />
      <StartRunHost ws={ws} />
      <TransferHost ws={ws} />
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
    identity: folderIdentity(props.folder),
    epicId: props.epicId,
    refreshToken: props.refreshToken,
    onChanged: props.onChanged,
    onChatsChanged: props.orchestration.onChatsChanged,
    onOpenChat: props.orchestration.onOpenChat,
    agents: props.orchestration.agents
  })
  const now = useNow()
  const { state } = controller
  useLanding({ landing: props.landing, state, dispatch: controller.dispatch, onLanded: props.onLanded })
  if (state.data === null) {
    return <WorkspaceStatus error={state.loadError} onRetry={controller.reload} />
  }
  const ws: WorkspaceHandle = {
    state,
    data: state.data,
    dispatch: controller.dispatch,
    actions: controller.actions,
    runner: controller.runner,
    reload: controller.reload,
    now,
    scheduler: props.scheduler ?? browserScheduler,
    folder: props.folder,
    epicId: props.epicId,
    orchestration: props.orchestration,
    onOpenEpic: props.onOpenEpic,
    onOpenFolderEpic: props.onOpenFolderEpic ?? null,
    onFolderChanged: props.onFolderChanged ?? null,
    onDeleted: props.onDeleted
  }
  return <WorkspaceView ws={ws} />
}

/** The epic workspace: plan graph or list, run and draft bars, ticket panel, checkpoint review. */
export function EpicWorkspace(props: EpicWorkspaceProps): JSX.Element {
  return <WorkspaceBody key={JSON.stringify([folderIdentity(props.folder), props.epicId])} {...props} />
}
