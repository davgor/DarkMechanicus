/**
 * A cult's page (`docs/design/cults.md`, the chamber): the command bar across the top; the room on the left, with the
 * pending petitions as banners over its top edge, the member inspector anchored over it and the roster strip under it;
 * the comms pane on the right, about 40% wide, holding the Magos's interactive terminal, the Pipeline and watch-only
 * acolyte terminals; and the Past runs drawer. The room is DM-664's decorative chamber; every fact and control it hints
 * at is also here as text, so nothing depends on it, with reduced motion or without.
 */
import { useEffect, useMemo, useState } from 'react'
import type { CultRunDetail } from '../../../shared/cults/cultApi'
import type { CultView } from '../../../shared/cults/cult'
import type { Scheduler } from '../app/scheduler'
import type { TerminalKit } from '../agents/terminalView'
import { CultChamber, type ChamberMember } from './chamber/CultChamber'
import { MAGOS_ID, type ChamberEvent } from './chamber/chamberState'
import { CultCommandBar } from './CultCommandBar'
import { CultComms, type CommsTab } from './CultComms'
import { CouncilCoverage } from './CouncilCoverage'
import { MemberInspector, RosterStrip } from './CultRoster'
import { activeRunOf, rosterOf, type RosterMember } from './cultPageModel'
import { PastRunsDrawer } from './PastRunsDrawer'
import { PetitionBanners } from './PetitionBanners'
import { ShrinePanel } from './ShrinePanel'
import { useChamberLog, useCultEntry } from './useCultPage'
import { useCultPipeline } from './useCultPipeline'
import './cultPage.css'

interface CultPageProps {
  cultId: string
  /** The display name of the agent the members run on (OMP's). */
  agentName: string
  kit: TerminalKit
  scheduler: Scheduler
  /** The comms tab to open when the page shows a member's terminal asked for from elsewhere (the sidebar). */
  openMember?: { chatId: string } | null
  /** The Plan Forge's target plan was clicked. */
  onOpenEpic?(folder: string, epicId: string): void
}

export function CultPage({ cultId, ...props }: CultPageProps): JSX.Element {
  const { entry, reload } = useCultEntry(cultId)
  if (entry.status === 'loading') return <div className="main-loading" role="status" aria-busy="true">Loading cult…</div>
  if (entry.status === 'error') return <p className="cult-refusal cult-page-error" role="alert">{entry.message}</p>
  return <CultPageBody key={cultId} cult={entry.value.cult} runs={entry.value.runs} onStarted={reload} {...props} />
}

interface BodyProps extends Omit<CultPageProps, 'cultId'> {
  cult: CultView
  runs: readonly CultRunDetail[]
  /** A run was started: the cult's runs are loaded again. */
  onStarted(): void
}

/** The comms tab for an outside request: the Magos's, or a watch tab for an acolyte of the active run. */
function requestedTab(run: CultRunDetail | null, chatId: string | undefined): CommsTab {
  const member = run?.members.find((candidate) => candidate.chatId === chatId)
  return member?.role === 'acolyte' ? { kind: 'watch', chatId: member.chatId } : { kind: 'magos' }
}

function useComms(run: CultRunDetail | null, openMember: CultPageProps['openMember']) {
  const [tab, setTab] = useState<CommsTab>(() => requestedTab(run, openMember?.chatId))
  const [watchedIds, setWatchedIds] = useState<string[]>(() => (tab.kind === 'watch' ? [tab.chatId] : []))
  useEffect(() => {
    if (openMember === undefined || openMember === null) return
    const next = requestedTab(run, openMember.chatId)
    setTab(next)
    if (next.kind === 'watch') setWatchedIds((ids) => (ids.includes(next.chatId) ? ids : [...ids, next.chatId]))
    // Only a new request moves the tab; snapshots of the same run do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openMember])
  const watch = (chatId: string): void => {
    setWatchedIds((ids) => (ids.includes(chatId) ? ids : [...ids, chatId]))
    setTab({ kind: 'watch', chatId })
  }
  const close = (chatId: string): void => {
    setWatchedIds((ids) => ids.filter((id) => id !== chatId))
    setTab((current) => (current.kind === 'watch' && current.chatId === chatId ? { kind: 'magos' } : current))
  }
  const watched = watchedIds.flatMap((id) => run?.members.filter((member) => member.chatId === id) ?? [])
  return { tab, setTab, watched, watch, close }
}

/** The chamber's members: every acolyte with its roster hue, in join order. */
function chamberMembers(roster: readonly RosterMember[]): ChamberMember[] {
  return roster.flatMap(({ member, hue }) => (hue === null ? [] : [{ id: member.chatId, name: member.displayName, hue }]))
}

/** The Plan Forge's target plan, named and linked; null for other archetypes. */
function TargetLink({ cult, onOpenEpic }: { cult: CultView; onOpenEpic?: CultPageProps['onOpenEpic'] }): JSX.Element | null {
  const { folderPath, targetEpicId } = cult
  if (targetEpicId === null || folderPath === null) return null
  return <button type="button" className="cult-target-link" onClick={() => onOpenEpic?.(folderPath, targetEpicId)}>{`Target plan: ${targetEpicId}`}</button>
}

interface StageProps {
  cult: CultView
  run: CultRunDetail
  roster: readonly RosterMember[]
  selected: string | null
  onSelect(id: string | null): void
  onWatch(member: RosterMember['member']): void
  scheduler: Scheduler
}

/** The active run's room with its petitions and inspector, the roster under it and, for a Plan Forge, its coverage. */
function RunStage({ cult, run, roster, selected, onSelect, onWatch, scheduler }: StageProps): JSX.Element {
  const inspected = roster.find((entry) => entry.member.chatId === selected) ?? null
  const magos = roster.find((entry) => entry.member.role === 'magos')
  const select = (id: string): void => onSelect(id === MAGOS_ID ? (magos?.member.chatId ?? null) : id)
  return (
    <>
      <div className="cult-room" data-active="true" data-selected-member={selected ?? undefined}>
        <RoomScene key={run.run.id} run={run} roster={roster} selectedMemberId={selected} onSelectMember={select} scheduler={scheduler} />
        <PetitionBanners run={run} petitioner={magos?.member.displayName ?? cult.magosName} />
        {inspected === null ? null : <MemberInspector run={run} entry={inspected} onClose={() => onSelect(null)} onWatch={() => onWatch(inspected.member)} />}
      </div>
      <RosterStrip run={run} roster={roster} selectedMemberId={selected} onSelectMember={onSelect} />
      {cult.archetype === 'plan_forge' ? <CouncilCoverage run={run} /> : null}
    </>
  )
}

const NO_MEMBERS: readonly ChamberMember[] = []
const NO_EVENTS: readonly ChamberEvent[] = []

/** No active run: the chamber's empty room with its lights off. */
function DarkRoom(): JSX.Element {
  return (
    <div className="cult-room" data-active="false">
      <div className="cult-room-empty" role="img" aria-label="Empty chamber: no active run">
        <CultChamber dark events={NO_EVENTS} seed={0} members={NO_MEMBERS} onSelectMember={() => undefined} />
      </div>
    </div>
  )
}

function CultPageBody({ cult, runs, agentName, kit, scheduler, openMember, onOpenEpic, onStarted }: BodyProps): JSX.Element {
  const run = activeRunOf(runs)
  const roster = useMemo(() => (run === null ? [] : rosterOf(run)), [run])
  const [selected, setSelected] = useState<string | null>(null)
  const [pastOpen, setPastOpen] = useState(false)
  const comms = useComms(run, openMember)
  const watch = (member: RosterMember['member']): void => (member.role === 'acolyte' ? comms.watch(member.chatId) : comms.setTab({ kind: 'magos' }))
  return (
    <div className="cult-page">
      <CultCommandBar cult={cult} run={run} onStarted={onStarted} pastOpen={pastOpen} onTogglePast={() => setPastOpen(!pastOpen)}
        target={<TargetLink cult={cult} onOpenEpic={onOpenEpic} />} />
      <div className="cult-page-main">
        <div className="cult-stage">
          {run === null ? <DarkRoom />
            : <RunStage cult={cult} run={run} roster={roster} selected={selected} onSelect={setSelected} onWatch={watch} scheduler={scheduler} />}
        </div>
        <CultComms run={run} watched={comms.watched} tab={comms.tab} onTab={comms.setTab} onCloseWatch={comms.close}
          agentName={agentName} kit={kit} scheduler={scheduler} />
      </div>
      {pastOpen ? <PastRunsDrawer runs={runs.filter((candidate) => candidate.run.state === 'ended')} onClose={() => setPastOpen(false)} /> : null}
    </div>
  )
}

interface RoomProps {
  run: CultRunDetail
  roster: readonly RosterMember[]
  selectedMemberId: string | null
  onSelectMember(id: string): void
  scheduler: Scheduler
}

/**
 * The live chamber for the active run (keyed by run): fed its snapshots and its pipeline (`chamberFeed`), from the run
 * as it is when the room opens. Its viewscreen shows the run's Shrine, live (compact, with Enlarge).
 */
function RoomScene({ run, roster, selectedMemberId, onSelectMember, scheduler }: RoomProps): JSX.Element {
  const members = useMemo(() => chamberMembers(roster), [roster])
  const memberChatIds = useMemo(() => run.members.map((member) => member.chatId), [run.members])
  const { state: pipeline } = useCultPipeline(run.run.id, { live: scheduler, memberChatIds })
  const seed = useMemo(() => [...run.run.id].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) | 0, 7), [run.run.id])
  const events = useChamberLog(run, pipeline.entries, seed)
  return <CultChamber events={events} seed={seed} members={members} selectedMemberId={selectedMemberId} onSelectMember={onSelectMember}
    viewscreen={<ShrinePanel runId={run.run.id} shrine={run.shrine} compact />} />
}
